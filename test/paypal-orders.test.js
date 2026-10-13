const test = require('node:test');
const assert = require('node:assert/strict');
const { createPayPal } = require('../lib/paypal');
const env = { PAYPAL_CLIENT_ID: 'mock-client', PAYPAL_CLIENT_SECRET: 'mock-secret' };
function mock(failAuthorize = false, failFirstStatus = false) {
  const calls = [];
  let authorized = false;
  let statusFailed = false;
  const request = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api-m.sandbox.paypal.com');
    assert.equal(options.redirect, 'error');
    calls.push({ url, options });
    const json = data => ({ ok: true, json: async () => data });
    if (url.endsWith('/oauth2/token')) return json({ access_token: 'mock-token', token_type: 'Bearer' });
    if (url.endsWith('/authorize')) {
      authorized = true;
      if (failAuthorize) throw new Error('mock-secret mock-token');
      return json({ id: 'ORDER-1', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: 'AUTH-1' }] } }] });
    }
    if (url.endsWith('/authorizations/AUTH-1')) {
      if (failFirstStatus && !statusFailed) { statusFailed = true; return { ok: false, status: 503 }; }
      return json({ id: 'AUTH-1', status: 'CREATED' });
    }
    if (options.method === 'POST') return json({ id: 'ORDER-1', intent: 'AUTHORIZE', status: 'CREATED' });
    return json({ id: 'ORDER-1', intent: 'AUTHORIZE', status: authorized ? 'COMPLETED' : 'CREATED', purchase_units: [{ payments: { authorizations: authorized ? [{ id: 'AUTH-1' }] : [] } }] });
  };
  return { calls, service: createPayPal(env, request) };
}

test('Server fixes AUTHORIZE intent and CAD 100.00 and exposes only the public Client ID', async () => {
  const { service, calls } = mock();
  const created = await service.create('owner');
  assert.equal(created.orderStatus, 'CREATED');
  assert.equal(created.authorizationId, null);
  const post = calls.find(call => call.url.endsWith('/checkout/orders'));
  assert.deepEqual(JSON.parse(post.options.body), { intent: 'AUTHORIZE', purchase_units: [{ amount: { currency_code: 'CAD', value: '100.00' } }] });
  assert.ok(post.options.headers['PayPal-Request-Id']);
  assert.deepEqual(service.config(), { clientId: 'mock-client', currency: 'CAD', intent: 'authorize', environment: 'Sandbox' });
  assert.doesNotMatch(JSON.stringify(created), /mock-secret|mock-token/);
});

test('Concurrent and repeated approvals post authorization once and retrieve actual authorization status', async () => {
  const { service, calls } = mock();
  await service.create('owner');
  const results = await Promise.all([service.authorize('ORDER-1', 'owner'), service.authorize('ORDER-1', 'owner')]);
  assert.equal(results[0].authorizationId, 'AUTH-1');
  assert.equal(results[0].authorizationStatus, 'CREATED');
  await service.authorize('ORDER-1', 'owner');
  assert.equal(calls.filter(call => call.url.endsWith('/authorize')).length, 1);
  assert.ok(calls.some(call => call.url.endsWith('/authorizations/AUTH-1')));
  assert.ok(calls.every(call => !/\/(capture|refund|void)(?:\/|$)/.test(call.url)));
});

test('Ambiguous authorization failure is sanitized, cannot be reposted, and can be reconciled read-only', async () => {
  const { service, calls } = mock(true);
  await service.create('owner');
  await assert.rejects(service.authorize('ORDER-1', 'owner'), error => !/mock-secret|mock-token/.test(error.message));
  await assert.rejects(service.authorize('ORDER-1', 'owner'), /automatic retries are disabled/);
  const actual = await service.status('ORDER-1', 'owner');
  assert.equal(actual.authorizationId, 'AUTH-1');
  assert.equal(actual.authorizationStatus, 'CREATED');
  assert.equal(calls.filter(call => call.url.endsWith('/authorize')).length, 1);
});

test('Status retrieval failure preserves authorization ID and refresh never reauthorizes', async () => {
  const { service, calls } = mock(false, true);
  await service.create('owner');
  await assert.rejects(service.authorize('ORDER-1', 'owner'), /HTTP 503/);
  const status = await service.status('ORDER-1', 'owner');
  assert.equal(status.authorizationId, 'AUTH-1');
  assert.equal(status.authorizationStatus, 'CREATED');
  assert.equal(calls.filter(call => call.url.endsWith('/authorize')).length, 1);
});

test('Unknown orders and other browser sessions cannot authorize or retrieve orders', async () => {
  const { service, calls } = mock();
  await service.create('owner');
  const count = calls.length;
  await assert.rejects(service.authorize('ORDER-1', 'other'), /not found/);
  await assert.rejects(service.status('unknown', 'owner'), /not found/);
  assert.equal(calls.length, count);
});

test('HTTP routes ignore browser amounts and require JSON and an allowed origin', async () => {
  const { once } = require('node:events');
  const { createApp } = require('../app');
  const { service, calls } = mock();
  const server = createApp(service).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/paypal`;
    const config = await fetch(`${base}/config`);
    const cookie = config.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`${base}/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ amount: '1.00', currency: 'USD', intent: 'CAPTURE' }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).amount, '100.00');
    const denied = await fetch(`${base}/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: '{}' });
    assert.equal(denied.status, 403);
    const form = await fetch(`${base}/orders`, { method: 'POST', body: 'amount=1' });
    assert.equal(form.status, 415);
    const other = await fetch(`${base}/orders/ORDER-1/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(other.status, 404);
    assert.equal(calls.filter(call => call.url.endsWith('/authorize')).length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Recovered authorization records permit read-only lookup but block further authorization', async () => {
  const { calls, service: unused } = mock();
  const service = createPayPal(env, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'mock-token', token_type: 'Bearer' }) };
    if (url.endsWith('/authorizations/AUTH-1')) return { ok: true, json: async () => ({ id: 'AUTH-1', status: 'CREATED' }) };
    return { ok: true, json: async () => ({ id: 'ORDER-1', intent: 'AUTHORIZE', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: 'AUTH-1' }] } }] }) };
  }, [{ orderId: 'ORDER-1', authorizationId: 'AUTH-1', attempted: true }]);
  await assert.rejects(service.authorize('ORDER-1', 'owner'), /read-only/);
  const result = await service.status('ORDER-1', 'owner');
  assert.equal(result.authorizationStatus, 'CREATED');
  assert.ok(calls.every(call => !call.url.endsWith('/authorize')));
});

test('API errors expose only allowlisted issue codes, never raw PayPal details', async () => {
  const service = createPayPal(env, async url => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'mock-token', token_type: 'Bearer' }) };
    return { ok: false, status: 422, json: async () => ({ message: 'mock-secret', details: [{ issue: 'ORDER_NOT_APPROVED', description: 'mock-token' }, { issue: 'mock-secret' }] }) };
  });
  await assert.rejects(service.create('owner'), error => /ORDER_NOT_APPROVED/.test(error.message) && !/mock-secret|mock-token/.test(error.message));
});
