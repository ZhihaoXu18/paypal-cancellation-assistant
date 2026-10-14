const { attachVoidWorkflow } = require('./void-workflow');
const { randomUUID } = require('node:crypto');
const BASE = 'https://api-m.sandbox.paypal.com';
const ID = /^[A-Za-z0-9-]{1,64}$/;

class SafeError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function createPayPal(env = process.env, request = fetch, recovered = [], persist = () => {}) {
  const clientId = env.PAYPAL_SANDBOX_CLIENT_ID || env.PAYPAL_CLIENT_ID;
  const secret = env.PAYPAL_SANDBOX_CLIENT_SECRET || env.PAYPAL_CLIENT_SECRET;
  const orders = new Map();
  // Recovery records contain IDs and attempt guards only, never credentials.
  for (const record of recovered) {
    if (typeof record.orderId === 'string' && ID.test(record.orderId) && record.attempted === true) {
      orders.set(record.orderId, { id: record.orderId, owner: null, attempted: true,
        authorizationId: typeof record.authorizationId === 'string' && ID.test(record.authorizationId) ? record.authorizationId : null,
        orderStatus: 'UNKNOWN', recovered: true,
        localOrderStatus: record.localOrderStatus || 'ACTIVE', shipmentStatus: record.shipmentStatus || 'NOT_SHIPPED',
        voidState: record.voidState || null, voidRequestId: record.voidRequestId || null, audit: record.audit || [] });
    }
  }
  function configured() {
    if (!clientId || !secret) throw new SafeError('Sandbox credentials are not configured.', 503);
  }
  async function api(route, body, requestId) {
    configured();
    try {
      const oauth = await request(`${BASE}/v1/oauth2/token`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      });
      if (!oauth.ok) throw new SafeError(`Sandbox authentication failed (HTTP ${oauth.status}).`);
      const token = await oauth.json();
      if (!token.access_token || token.token_type?.toLowerCase() !== 'bearer') throw new SafeError('Invalid Sandbox authentication response.');
      const headers = { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
      if (requestId) headers['PayPal-Request-Id'] = requestId;
      const response = await request(`${BASE}${route}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        signal: AbortSignal.timeout(15000), headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        const allowed = new Set(['ORDER_ALREADY_AUTHORIZED', 'ORDER_NOT_APPROVED', 'ORDER_EXPIRED', 'INSTRUMENT_DECLINED', 'PAYER_CANNOT_PAY', 'PAYEE_ACCOUNT_RESTRICTED', 'CURRENCY_NOT_SUPPORTED', 'AUTHORIZATION_ERROR', 'TRANSACTION_REFUSED', 'PERMISSION_DENIED', 'INTERNAL_SERVER_ERROR']);
        let issues = [];
        try { const errorBody = await response.json(); issues = (errorBody.details || []).map(detail => allowed.has(detail.issue) ? detail.issue : 'OTHER_PAYPAL_ISSUE'); } catch { /* Do not expose raw error content. */ }
        throw new SafeError(`Sandbox API request failed (HTTP ${response.status})${issues.length ? ': ' + [...new Set(issues)].join(', ') : ''}.`);
      }
      if (response.status === 204) return {};
      return await response.json();
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError('Sandbox request failed or timed out. The result may be unknown; refresh status before taking further action.');
    }
  }
  function find(id, owner) {
    const order = orders.get(id);
    if (!order || (!order.recovered && order.owner !== owner)) throw new SafeError('Sandbox order not found in this browser session.', 404);
    return order;
  }
  function view(order) {
    return { orderId: order.id, authorizationId: order.authorizationId || null,
      orderStatus: order.orderStatus, authorizationStatus: order.authorizationStatus || null,
      localOrderStatus: order.localOrderStatus || 'ACTIVE', shipmentStatus: order.shipmentStatus || 'NOT_SHIPPED',
      fulfillmentSimulated: true, voidState: order.voidState || null, paymentFacts: order.paymentFacts || null, audit: order.audit || [],
      authorizationAttempted: order.attempted, amount: '100.00', currency: 'CAD', environment: 'Sandbox' };
  }
  function rememberAuthorization(order, data) {
    const authorization = data.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (authorization) {
      if (typeof authorization.id !== 'string' || !ID.test(authorization.id)) throw new SafeError('Invalid Sandbox authorization response.');
      if (order.authorizationId && order.authorizationId !== authorization.id) throw new SafeError('Stored authorization does not match the current order.', 409);
      order.authorizationId = authorization.id;
      order.attempted = true;
    }
  }
  async function refresh(order) {
    const data = await api(`/v2/checkout/orders/${order.id}`);
    if (data.id !== order.id || data.intent !== 'AUTHORIZE') throw new SafeError('Unexpected Sandbox order response.');
    order.orderStatus = data.status;
    order.paymentFacts = null;
    rememberAuthorization(order, data);
    if (order.authorizationId) {
      const auth = await api(`/v2/payments/authorizations/${order.authorizationId}`);
      if (auth.id !== order.authorizationId || typeof auth.status !== 'string') throw new SafeError('Unexpected Sandbox authorization response.');
      order.authorizationStatus = auth.status;
      const units = data.purchase_units;
      const unit = units?.[0];
      const matches = amount => amount?.currency_code === 'CAD' && amount?.value === '100.00';
      const captures = unit?.payments?.captures;
      if (units?.length === 1 && matches(unit.amount) && matches(auth.amount) &&
          auth.supplementary_data?.related_ids?.order_id === order.id &&
          unit.payments?.authorizations?.length === 1 && unit.payments.authorizations[0].id === auth.id &&
          (captures === undefined || Array.isArray(captures))) {
        order.paymentFacts = { captureCount: captures?.length || 0, verifiedAt: new Date().toISOString(),
          amount: '100.00', currency: 'CAD', authorizationBelongsToOrder: true };
      }
    }
    return view(order);
  }
  function save(order) {
    try { persist({ orderId: order.id, authorizationId: order.authorizationId || null, attempted: order.attempted,
      localOrderStatus: order.localOrderStatus || 'ACTIVE', shipmentStatus: order.shipmentStatus || 'NOT_SHIPPED',
      voidState: order.voidState || null, voidRequestId: order.voidRequestId || null, audit: order.audit || [] }); }
    catch { throw new SafeError('Action blocked: unable to persist the local action record.', 503); }
  }
  const workflow = attachVoidWorkflow({ api, find, view, save, SafeError });
  return {
    cancel: workflow.cancel,
    void: workflow.void,
    config() { configured(); return { clientId, currency: 'CAD', intent: 'authorize', environment: 'Sandbox' }; },
    async create(owner) {
      const data = await api('/v2/checkout/orders', { intent: 'AUTHORIZE', purchase_units: [{ amount: { currency_code: 'CAD', value: '100.00' } }] }, randomUUID());
      if (typeof data.id !== 'string' || !ID.test(data.id) || data.intent !== 'AUTHORIZE') throw new SafeError('Unexpected Sandbox order creation response.');
      const order = { id: data.id, owner, orderStatus: data.status, attempted: false, requestId: randomUUID(), localOrderStatus: 'ACTIVE', shipmentStatus: 'NOT_SHIPPED' };
      orders.set(data.id, order);
      return view(order);
    },
    async authorize(id, owner) {
      const order = find(id, owner);
      if (order.recovered) throw new SafeError('Recovered orders are read-only. Refresh actual status; do not authorize again.', 409);
      if (order.pending) return order.pending;
      if (order.authorizationId) return refresh(order);
      if (order.attempted) throw new SafeError('Authorization was already attempted. Refresh status; automatic retries are disabled.', 409);
      // Lock before any network request. A failed or ambiguous attempt is never reposted.
      order.attempted = true;
      order.pending = (async () => {
        const data = await api(`/v2/checkout/orders/${order.id}/authorize`, {}, order.requestId);
        if (data.id !== order.id) throw new SafeError('Unexpected Sandbox authorization response.');
        order.orderStatus = data.status;
        rememberAuthorization(order, data);
        if (!order.authorizationId) throw new SafeError('No authorization ID returned. Refresh status; do not retry authorization.');
        return refresh(order);
      })();
      try { return await order.pending; } finally { order.pending = null; }
    },
    async status(id, owner) {
      const order = find(id, owner);
      if (order.pending) { try { await order.pending; } catch { /* Reconcile using read-only requests. */ } }
      await refresh(order);
      await workflow.inspect(order);
      return view(order);
    },
  };
}
module.exports = { createPayPal, SafeError };
