const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createShopify } = require('../lib/shopify');
const { createApp } = require('../app');
const id = 'gid://shopify/Order/18973739417770';
const env = { SHOPIFY_SHOP: 'test-shop.myshopify.com', SHOPIFY_CLIENT_ID: 'mock-client', SHOPIFY_CLIENT_SECRET: 'mock-secret' };
const token = { access_token: 'mock-token', expires_in: 86399, scope: 'read_orders' };
const order = { id, name: '#1001', displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED' };
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
function fixture({ oauth = token, data = { data: { order } }, oauthStatus = 200, status = 200 } = {}) {
  const calls = [];
  const service = createShopify(env, async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/access_token') ? response(oauth, oauthStatus) : response(data, status);
  });
  return { service, calls };
}
test('Shopify uses client credentials and a pinned read-only GraphQL query; result is explicitly allowlisted', async () => {
  const { service, calls } = fixture({ data: { data: { order: { ...order, email: 'private-email', customer: { name: 'private-name' } } } } });
  const snapshot = await service.order(id);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://test-shop.myshopify.com/admin/oauth/access_token');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].options.body)), { grant_type: 'client_credentials', client_id: 'mock-client', client_secret: 'mock-secret' });
  assert.equal(calls[1].url, 'https://test-shop.myshopify.com/admin/api/2026-10/graphql.json');
  assert.equal(calls[1].options.headers['X-Shopify-Access-Token'], 'mock-token');
  const query = JSON.parse(calls[1].options.body);
  assert.deepEqual(query.variables, { id });
  assert.match(query.query, /^query OrderSnapshot/);
  assert.doesNotMatch(query.query, /mutation|customer|email|address|transactions/i);
  for (const call of calls) { assert.equal(call.options.method, 'POST'); assert.equal(call.options.redirect, 'error'); assert.ok(call.options.signal); }
  const { queriedAt, ...fields } = snapshot;
  assert.equal(new Date(queriedAt).toISOString(), queriedAt);
  assert.deepEqual(fields, { orderId: id, orderNumber: '#1001', paymentStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED', source: 'Shopify development store', readOnly: true, linkedToPayPal: false });
  assert.doesNotMatch(JSON.stringify(snapshot), /mock-secret|mock-token|private-/);
});
test('Token is shared by concurrent lookups and refreshed after expiry', async t => {
  const { service, calls } = fixture();
  await Promise.all([service.order(id), service.order(id)]);
  assert.equal(calls.filter(call => call.url.endsWith('/access_token')).length, 1);
  const later = Date.now() + 86400 * 1000;
  t.mock.method(Date, 'now', () => later);
  await service.order(id);
  assert.equal(calls.filter(call => call.url.endsWith('/access_token')).length, 2);
});
test('Invalid configuration and invalid GIDs cannot send network requests', async () => {
  for (const config of [{}, { ...env, SHOPIFY_SHOP: 'https://test-shop.myshopify.com' }, { ...env, SHOPIFY_SHOP: 'test-shop.myshopify.com.evil.test' }, { ...env, SHOPIFY_CLIENT_SECRET: '' }]) {
    await assert.rejects(createShopify(config, () => assert.fail('No network')).order(id), /not configured/);
  }
  const service = createShopify(env, () => assert.fail('No network'));
  for (const invalid of [undefined, ['x'], '18973739417770', 'gid://shopify/Customer/123', `${id}/x`]) await assert.rejects(service.order(invalid), /valid Shopify Order GID/);
});
for (const [name, options, expected] of [
  ['OAuth denied', { oauthStatus: 401 }, /authentication failed/],
  ['HTTP permission error', { status: 403 }, /access denied/],
  ['API server error', { status: 500 }, /HTTP 500/],
  ['rate limit', { status: 429 }, /HTTP 429/],
  ['missing token', { oauth: { ...token, access_token: '' } }, /invalid authentication/],
  ['invalid expiry', { oauth: { ...token, expires_in: 'forever' } }, /invalid authentication/],
  ['missing scope', { oauth: { ...token, scope: 'read_products' } }, /read_orders/],
  ['GraphQL permission error with partial data', { data: { data: { order }, errors: [{ message: 'private-raw', extensions: { code: 'ACCESS_DENIED' } }] } }, /access denied/],
  ['GraphQL error with partial data', { data: { data: { order }, errors: [{ message: 'private-raw' }] } }, /GraphQL query failed/],
  ['missing order', { data: { data: { order: null } } }, /not found or is not accessible/],
  ['malformed response', { data: {} }, /invalid order response/],
  ['mismatched ID', { data: { data: { order: { ...order, id: 'gid://shopify/Order/2' } } } }, /inconsistent/],
  ['unknown fulfillment', { data: { data: { order: { ...order, displayFulfillmentStatus: 'UNKNOWN' } } } }, /unknown/],
  ['missing fulfillment', { data: { data: { order: { ...order, displayFulfillmentStatus: null } } } }, /missing/],
  ['unknown payment', { data: { data: { order: { ...order, displayFinancialStatus: 'UNKNOWN' } } } }, /unknown/],
]) {
  test(`Shopify rejects ${name} without assuming shipment status or exposing raw errors`, async () => {
    const { service, calls } = fixture(options);
    await assert.rejects(service.order(id), error => expected.test(error.message) && !/private-raw|mock-secret|mock-token/.test(error.message));
    assert.ok(calls.length <= 2); // No automatic request retries.
  });
}
for (const name of ['TimeoutError', 'SyntaxError', 'TypeError']) {
  test(`Shopify sanitizes ${name} without raw credentials`, async () => {
    const service = createShopify(env, async () => { const error = new Error('mock-secret private-raw'); error.name = name; throw error; });
    await assert.rejects(service.order(id), error => /timed out, failed or returned unreadable/.test(error.message) && !/mock-secret|private-raw/.test(error.message));
  });
}
test('Expired/rejected token is discarded without an automatic retry', async () => {
  let oauth = 0, queries = 0;
  const service = createShopify(env, async url => {
    if (url.endsWith('/access_token')) { oauth++; return response(token); }
    queries++;
    return queries === 1 ? response({}, 401) : response({ data: { order } });
  });
  await assert.rejects(service.order(id), /authentication failed/);
  assert.equal(queries, 1);
  await service.order(id);
  assert.equal(oauth, 2);
});
test('Shopify GET route exposes snapshots only, blocks bad origins, and cannot approve a conditional PayPal review', async () => {
  const { createRequestAnalyzer } = require('../lib/request-analysis');
  let forbiddenCalls = 0;
  const forbidden = () => { forbiddenCalls++; throw new Error('No PayPal operation'); };
  const analyzer = createRequestAnalyzer({ configured: true, analyze: async message => ({ intent: 'cancellation_request', orderReferences: [], reason: null, cancellationConditions: [], unmetConditionRequirements: [], supportingQuotes: [message], missingInformation: [], clarificationQuestions: [] }) });
  const { service } = fixture();
  const server = createApp({ cancel: forbidden, void: forbidden }, analyzer, service).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const path = '/api/shopify/order?' + new URLSearchParams({ id });
    const snapshot = await fetch(base + path);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.headers.get('cache-control'), 'no-store');
    assert.equal((await snapshot.json()).linkedToPayPal, false);
    assert.equal((await fetch(base + path, { headers: { Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await fetch(base + '/api/shopify/order?id=bad')).status, 400);
    assert.equal((await fetch(base + path, { method: 'POST' })).status, 404);
    const config = await fetch(base + '/api/analysis/config');
    const cookie = config.headers.get('set-cookie').split(';')[0];
    const post = (url, body) => fetch(base + url, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const message = 'Cancel order ORDER-1 only if it has not shipped.';
    const analysis = await post('/api/analysis', { message, selectedOrderId: 'ORDER-1' });
    const { review } = await analysis.json();
    assert.equal(review.canReviewCancellation, false);
    await fetch(base + path, { headers: { Cookie: cookie } });
    for (const operation of ['cancel', 'void']) {
      const attempt = await post(`/api/paypal/orders/ORDER-1/${operation}`, { reviewId: review.reviewId, confirmed: true, message, orderId: 'ORDER-1', authorizationId: 'AUTH-1', fulfillmentStatus: 'UNFULFILLED' });
      assert.equal(attempt.status, 409);
    }
    assert.equal(forbiddenCalls, 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Fulfilled and partially fulfilled snapshots retain exact Shopify statuses without shipment inference', async () => {
  for (const status of ['FULFILLED', 'PARTIALLY_FULFILLED', 'ON_HOLD']) {
    const { service } = fixture({ data: { data: { order: { ...order, displayFulfillmentStatus: status } } } });
    const snapshot = await service.order(id);
    assert.equal(snapshot.fulfillmentStatus, status);
    assert.equal(snapshot.shipmentStatus, undefined);
    assert.equal(snapshot.canReviewCancellation, undefined);
  }
});

for (const [name, data, category, field, errorType] of [
  ['protected order access', { data: { order: null }, errors: [{ message: 'This app is not approved to access the Order object. private-customer mock-secret', extensions: { code: 'ACCESS_DENIED' }, path: ['order'] }] }, 'GRAPHQL_ERRORS', 'order', 'PROTECTED_DATA_ACCESS_DENIED'],
  ['ordinary permission error', { data: { order }, errors: [{ message: 'private-customer', extensions: { code: 'ACCESS_DENIED' } }] }, 'GRAPHQL_ERRORS', 'order', 'ACCESS_DENIED'],
  ['GraphQL partial data', { data: { order }, errors: [{ message: 'private-customer', extensions: { code: 'PRIVATE-CODE' } }] }, 'GRAPHQL_ERRORS', undefined, undefined],
  ['null order', { data: { order: null } }, 'ORDER_NULL', 'order', undefined],
  ['missing order', { data: {} }, 'FIELD_MISSING', 'order', undefined],
  ['missing status', { data: { order: { ...order, displayFulfillmentStatus: null } } }, 'FIELD_MISSING', 'displayFulfillmentStatus', undefined],
  ['unsupported fulfillment', { data: { order: { ...order, displayFulfillmentStatus: 'PRIVATE-UNKNOWN-STATUS' } } }, 'UNSUPPORTED_STATUS', 'displayFulfillmentStatus', undefined],
  ['unsupported payment', { data: { order: { ...order, displayFinancialStatus: 'PRIVATE-UNKNOWN-STATUS' } } }, 'UNSUPPORTED_STATUS', 'displayFinancialStatus', undefined],
  ['wrong order ID', { data: { order: { ...order, id: 'gid://shopify/Order/2' } } }, 'ORDER_ID_MISMATCH', 'id', undefined],
  ['invalid order type', { data: { order: [] } }, 'FIELD_MISSING', 'order', undefined],
  ['invalid status type', { data: { order: { ...order, displayFinancialStatus: {} } } }, 'INVALID_FIELD_FORMAT', 'displayFinancialStatus', undefined],
  ['null response', null, 'FIELD_MISSING', 'order', undefined],
]) {
  test(`Safe diagnostics distinguish ${name} without accepting failed data`, async () => {
    const { service, calls } = fixture({ data });
    await assert.rejects(service.order(id), error => {
      assert.equal(error.category, category);
      assert.equal(error.field, field);
      assert.equal(error.errorType, errorType);
      assert.doesNotMatch(JSON.stringify(error), /private-customer|mock-secret|PRIVATE-CODE|PRIVATE-UNKNOWN-STATUS/);
      assert.doesNotMatch(error.message, /private-customer|mock-secret|PRIVATE-CODE|PRIVATE-UNKNOWN-STATUS/);
      return true;
    });
    assert.equal(calls.length, 2);
  });
}
test('HTTP route returns fixed protected-access diagnostics rather than raw GraphQL response', async () => {
  const { service } = fixture({ data: { data: { order }, errors: [{ message: 'This app is not approved to access the Order object. private-customer', extensions: { code: 'ACCESS_DENIED' } }] } });
  const server = createApp({}, {}, service).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api/shopify/order?${new URLSearchParams({ id })}`);
    assert.equal(result.status, 403);
    const body = await result.json();
    assert.equal(body.category, 'GRAPHQL_ERRORS');
    assert.equal(body.field, 'order');
    assert.equal(body.errorType, 'PROTECTED_DATA_ACCESS_DENIED');
    assert.doesNotMatch(JSON.stringify(body), /private-customer|mock-token|mock-secret|#1001/);
    assert.equal(body.fulfillmentStatus, undefined);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
