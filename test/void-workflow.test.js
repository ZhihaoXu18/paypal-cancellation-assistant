const test = require('node:test');
const assert = require('node:assert/strict');
const { createPayPal } = require('../lib/paypal');
const env = { PAYPAL_CLIENT_ID: 'mock-client', PAYPAL_CLIENT_SECRET: 'mock-secret' };
function fixture(options = {}) {
  const calls = [], records = [];
  let status = options.alreadyVoided ? 'VOIDED' : 'CREATED';
  let timeout = options.timeout;
  let failGet = false;
  const amount = { currency_code: 'CAD', value: '100.00' };
  const service = createPayPal(env, async (url, request) => {
    assert.equal(new URL(url).origin, 'https://api-m.sandbox.paypal.com');
    calls.push({ url, request });
    const json = data => ({ ok: true, status: 200, json: async () => data });
    if (url.endsWith('/oauth2/token')) return json({ access_token: 'mock-token', token_type: 'Bearer' });
    if (url.endsWith('/void')) {
      if (timeout) {
        timeout = false;
        if (options.timeoutVoided) status = 'VOIDED';
        if (options.failedReconcile) failGet = true;
        throw new Error('mock-secret mock-token');
      }
      if (!options.unconfirmed) status = 'VOIDED';
      return { ok: true, status: 204 };
    }
    if (failGet) { failGet = false; throw new Error('network unavailable'); }
    if (url.endsWith('/authorizations/AUTH-1')) return json({ id: 'AUTH-1', status,
      amount: options.amountMismatch ? { currency_code: 'USD', value: '100.00' } : amount,
      supplementary_data: options.missingFacts ? undefined : { related_ids: { order_id: options.ownerMismatch ? 'OTHER' : 'ORDER-1' } } });
    return json({ id: 'ORDER-1', intent: 'AUTHORIZE', status: 'COMPLETED', purchase_units: [{ amount,
      payments: { authorizations: [{ id: options.idMismatch ? 'OTHER-AUTH' : 'AUTH-1' }], ...(options.captured ? { captures: [{ id: 'CAPTURE-1' }] } : {}) } }] });
  }, [{ orderId: 'ORDER-1', authorizationId: 'AUTH-1', attempted: true, localOrderStatus: options.active ? 'ACTIVE' : 'CANCELLED', shipmentStatus: options.shipped ? 'SHIPPED' : 'NOT_SHIPPED', voidState: options.recoveredUncertain ? 'UNCERTAIN' : null, voidRequestId: options.recoveredUncertain ? 'stable-restored-request' : null }], record => {
    if (options.persistenceFailure) throw new Error('disk unavailable');
    records.push(structuredClone(record));
  });
  return { service, calls, records, confirm: { confirmed: true, orderId: 'ORDER-1', authorizationId: 'AUTH-1' } };
}
const posts = calls => calls.filter(call => call.url.endsWith('/void'));

test('Eligible cancelled unshipped order is voided once and independently verified; audit excludes credentials', async () => {
  const { service, calls, records, confirm } = fixture();
  const result = await service.void('ORDER-1', 'owner', confirm);
  assert.equal(result.authorizationStatus, 'VOIDED');
  assert.equal(result.voidState, 'CONFIRMED');
  assert.equal(posts(calls).length, 1);
  assert.equal(posts(calls)[0].request.headers['PayPal-Request-Id'].length, 36);
  assert.ok(calls.slice(calls.indexOf(posts(calls)[0]) + 1).some(call => call.url.endsWith('/authorizations/AUTH-1')));
  assert.ok(records.some(r => r.voidState === 'UNCERTAIN'));
  assert.doesNotMatch(JSON.stringify(records), /mock-secret|mock-token|Authorization/);
  await service.void('ORDER-1', 'owner', confirm);
  assert.equal(posts(calls).length, 1);
});
for (const [name, options] of Object.entries({ shipped: { shipped: true }, captured: { captured: true }, 'amount mismatch': { amountMismatch: true }, 'ownership mismatch': { ownerMismatch: true }, 'authorization mismatch': { idMismatch: true }, 'missing facts': { missingFacts: true }, 'active local order': { active: true }, 'persistence failure': { persistenceFailure: true } })) {
  test(`Void stops for ${name} without sending a void request`, async () => {
    const { service, calls, confirm } = fixture(options);
    await assert.rejects(service.void('ORDER-1', 'owner', confirm));
    assert.equal(posts(calls).length, 0);
  });
}
test('Already voided authorization is reconciled without another POST', async () => {
  const { service, calls, confirm } = fixture({ alreadyVoided: true });
  const result = await service.void('ORDER-1', 'owner', confirm);
  assert.equal(result.voidState, 'CONFIRMED');
  await service.void('ORDER-1', 'owner', confirm);
  assert.equal(posts(calls).length, 0);
});
test('Explicit matching merchant confirmation is mandatory', async () => {
  const { service, calls, confirm } = fixture();
  await assert.rejects(service.void('ORDER-1', 'owner', { ...confirm, confirmed: false }), /confirmation/);
  await assert.rejects(service.void('ORDER-1', 'owner', { ...confirm, authorizationId: 'OTHER' }), /confirmation/);
  assert.equal(posts(calls).length, 0);
});
test('Concurrent execution is blocked', async () => {
  const { service, calls, confirm } = fixture();
  const first = service.void('ORDER-1', 'owner', confirm);
  await assert.rejects(service.void('ORDER-1', 'owner', confirm), /in progress/);
  await first;
  assert.equal(posts(calls).length, 1);
});
test('Timeout with independently verified VOIDED is confirmed without retry', async () => {
  const { service, calls, confirm } = fixture({ timeout: true, timeoutVoided: true });
  const result = await service.void('ORDER-1', 'owner', confirm);
  assert.equal(result.voidState, 'CONFIRMED');
  assert.equal(posts(calls).length, 1);
});
test('Timeout remains uncertain until read-only refresh; retry needs new confirmation and stable request ID', async () => {
  const { service, calls, confirm } = fixture({ timeout: true, failedReconcile: true });
  await assert.rejects(service.void('ORDER-1', 'owner', confirm), /not confirmed/);
  await assert.rejects(service.void('ORDER-1', 'owner', confirm), /uncertain/);
  assert.equal(posts(calls).length, 1);
  const status = await service.status('ORDER-1', 'owner');
  assert.equal(status.voidState, 'RETRY_READY');
  await service.void('ORDER-1', 'owner', confirm);
  assert.equal(posts(calls).length, 2);
  assert.equal(posts(calls)[0].request.headers['PayPal-Request-Id'], posts(calls)[1].request.headers['PayPal-Request-Id']);
});
test('Successful POST without confirmed VOIDED is not reported as success', async () => {
  const { service, confirm } = fixture({ unconfirmed: true });
  await assert.rejects(service.void('ORDER-1', 'owner', confirm), /not confirmed/);
});
test('Merchant cancellation updates only simulated local state', async () => {
  const { service, calls } = fixture({ active: true });
  const cancelled = service.cancel('ORDER-1', 'owner');
  assert.equal(cancelled.localOrderStatus, 'CANCELLED');
  assert.equal(cancelled.shipmentStatus, 'NOT_SHIPPED');
  assert.equal(calls.length, 0);
});


test('Persisted uncertain guard survives restart and requires read-only reconciliation', async () => {
  const { service, calls, confirm } = fixture({ recoveredUncertain: true });
  await assert.rejects(service.void('ORDER-1', 'owner', confirm), /uncertain/);
  assert.equal(posts(calls).length, 0);
  const reconciled = await service.status('ORDER-1', 'owner');
  assert.equal(reconciled.voidState, 'RETRY_READY');
  await service.void('ORDER-1', 'owner', confirm);
  assert.equal(posts(calls)[0].request.headers['PayPal-Request-Id'], 'stable-restored-request');
});
