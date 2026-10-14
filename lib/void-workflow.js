const { randomUUID } = require('node:crypto');

function attachVoidWorkflow({ api, find, view, save, SafeError }) {
  function record(order, action, result) {
    order.audit ||= [];
    order.audit.push({ time: new Date().toISOString(), action, result, orderId: order.id, authorizationId: order.authorizationId || null });
    save(order);
  }
  function localEligible(order) {
    if (order.localOrderStatus !== 'CANCELLED' || order.shipmentStatus !== 'NOT_SHIPPED') {
      throw new SafeError('Void blocked: local order must be cancelled and not shipped.', 409);
    }
  }
  async function facts(order) {
    if (!order.authorizationId) throw new SafeError('Void blocked: authorization ID is missing.', 409);
    const remote = await api(`/v2/checkout/orders/${order.id}`);
    const units = remote.purchase_units;
    if (remote.id !== order.id || remote.intent !== 'AUTHORIZE' || !['APPROVED', 'COMPLETED'].includes(remote.status) || !Array.isArray(units) || units.length !== 1) throw new SafeError('Void blocked: order facts are missing or inconsistent.', 409);
    const unit = units[0];
    const matches = amount => amount?.currency_code === 'CAD' && amount?.value === '100.00';
    if (!matches(unit.amount)) throw new SafeError('Void blocked: order amount or currency mismatch.', 409);
    const authorizations = unit.payments?.authorizations;
    if (!Array.isArray(authorizations) || authorizations.length !== 1 || authorizations[0].id !== order.authorizationId) throw new SafeError('Void blocked: authorization does not match this order.', 409);
    if (unit.payments.captures !== undefined && !Array.isArray(unit.payments.captures)) throw new SafeError('Void blocked: capture facts are inconsistent.', 409);
    const authorization = await api(`/v2/payments/authorizations/${order.authorizationId}`);
    if (authorization.id !== order.authorizationId || authorization.supplementary_data?.related_ids?.order_id !== order.id || !matches(authorization.amount)) throw new SafeError('Void blocked: authorization ownership or amount is missing or inconsistent.', 409);
    if (!['CREATED', 'VOIDED'].includes(authorization.status) || (unit.payments.captures?.length || 0) > 0 || authorization.supplementary_data?.related_ids?.capture_id) throw new SafeError('Void blocked: captures exist or authorization is not eligible.', 409);
    order.orderStatus = remote.status;
    order.authorizationStatus = authorization.status;
    order.paymentFacts = { captureCount: 0, verifiedAt: new Date().toISOString(), amount: '100.00', currency: 'CAD', authorizationBelongsToOrder: true };
    return authorization.status;
  }
  return {
    cancel(id, owner) {
      const order = find(id, owner);
      if (order.voidPending || order.pending) throw new SafeError('An operation is in progress.', 409);
      if (order.shipmentStatus !== 'NOT_SHIPPED') throw new SafeError('Cancellation blocked: shipment state must be Not shipped.', 409);
      if (order.localOrderStatus === 'CANCELLED') return view(order);
      order.localOrderStatus = 'CANCELLED';
      record(order, 'MERCHANT_CANCEL_SIMULATED_ORDER', 'CANCELLED');
      return view(order);
    },
    async inspect(order) {
      if (!order.voidState || order.voidPending) return;
      const status = await facts(order);
      if (status === 'VOIDED') {
        order.voidState = 'CONFIRMED';
        record(order, 'VOID_STATUS_RECONCILIATION', 'VOIDED');
      } else if (order.voidState === 'UNCERTAIN') {
        localEligible(order);
        order.voidState = 'RETRY_READY';
        record(order, 'VOID_STATUS_RECONCILIATION', 'CREATED_RETRY_REQUIRES_CONFIRMATION');
      }
    },
    async void(id, owner, confirmation) {
      const order = find(id, owner);
      if (confirmation?.confirmed !== true || confirmation.orderId !== order.id || confirmation.authorizationId !== order.authorizationId) throw new SafeError('Explicit merchant confirmation for this order and authorization is required.', 400);
      if (order.voidPending) throw new SafeError('Void is already in progress. Refresh status after it completes.', 409);
      if (order.pending) throw new SafeError('Authorization is in progress.', 409);
      if (order.voidState === 'UNCERTAIN') throw new SafeError('Void outcome is uncertain. Refresh actual status before confirming a retry.', 409);
      localEligible(order);
      order.voidPending = true;
      try {
        const status = await facts(order);
        if (status === 'VOIDED') {
          order.voidState = 'CONFIRMED';
          record(order, 'VOID_SKIPPED', 'ALREADY_VOIDED');
          return { ...view(order), message: 'Authorization is already VOIDED. No void request was sent.' };
        }
        order.voidRequestId ||= randomUUID();
        // Persist an uncertain guard before sending a potentially consequential request.
        order.voidState = 'UNCERTAIN';
        record(order, 'MERCHANT_CONFIRMED_VOID', 'REQUEST_PREPARED');
        try {
          await api(`/v2/payments/authorizations/${order.authorizationId}/void`, {}, order.voidRequestId);
        } catch {
          record(order, 'VOID_REQUEST', 'ERROR_OR_TIMEOUT');
          // An API error is not proof of failure. Independently reconcile below.
        }
        try {
          const actual = await facts(order);
          if (actual === 'VOIDED') {
            order.voidState = 'CONFIRMED';
            record(order, 'VOID_RESULT', 'VOIDED_CONFIRMED_BY_GET');
            return { ...view(order), message: 'Void confirmed by PayPal. Bank funds availability may update later.' };
          }
        } catch {
          record(order, 'VOID_STATUS_QUERY', 'FAILED_OR_INCONSISTENT');
        }
        order.voidState = 'UNCERTAIN';
        record(order, 'VOID_RESULT', 'UNCONFIRMED');
        throw new SafeError('Void is not confirmed. Refresh actual status before considering another explicitly confirmed attempt.', 409);
      } catch (error) {
        if (!order.voidState) record(order, 'VOID_BLOCKED', 'MISSING_OR_INCONSISTENT_FACTS');
        throw error;
      } finally { order.voidPending = false; }
    },
  };
}
module.exports = { attachVoidWorkflow };
