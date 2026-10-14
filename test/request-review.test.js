const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createRequestAnalyzer } = require('../lib/request-analysis');
const { createApp } = require('../app');

function analyzer() {
  return createRequestAnalyzer({ configured: true, analyze: async message => ({
    intent: message.startsWith('Refund') ? 'refund_request' : message.startsWith('Status') ? 'status_question' : 'cancellation_request',
    orderReferences: [], reason: null, supportingQuotes: [message], missingInformation: [], clarificationQuestions: [],
  }) });
}
for (const [message, selectedOrderId, status, eligible] of [
  ['Cancel ORDER-1.', 'ORDER-1', 'matched', true],
  ['Cancel ORDER-2.', 'ORDER-1', 'mismatched', false],
  ['Cancel please.', 'ORDER-1', 'missing_reference', false],
  ['Cancel ORDER-1 and ORDER-2.', 'ORDER-1', 'multiple_references', false],
  ['Cancel ORDER-1. Actually cancel the second order.', 'ORDER-1', 'ambiguous_reference', false],
  ['Cancel ORDER-1.', undefined, 'no_selected_order', false],
  ['Refund ORDER-1.', 'ORDER-1', 'matched', false],
  ['Status ORDER-1.', 'ORDER-1', 'matched', false],
]) {
  test(`Backend review: ${status}, cancellation eligible=${eligible}, intent=${message.split(' ')[0]}`, async () => {
    const result = await analyzer().analyze({ message, selectedOrderId });
    assert.equal(result.review.status, status);
    assert.equal(result.review.canReviewCancellation, eligible);
    assert.equal(result.review.requiresManualResolution, status !== 'matched');
    assert.equal(result.review.customerAuthenticated, false);
    assert.equal(result.review.cancellationApproved, false);
  });
}

test('HTTP cancellation and void reject missing, changed, forged, cross-session and superseded reviews', async () => {
  const calls = [];
  const paypal = { config: () => ({}), cancel: (...args) => { calls.push(['cancel', ...args]); return { ok: true }; },
    void: (...args) => { calls.push(['void', ...args]); return { ok: true }; } };
  const server = createApp(paypal, analyzer()).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const config = await fetch(`${base}/api/analysis/config`);
    const cookie = config.headers.get('set-cookie').split(';')[0];
    const post = (url, body, session = cookie) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: session }, body: JSON.stringify(body) });
    const analyze = async message => (await (await post('/api/analysis', { message, selectedOrderId: 'ORDER-1' })).json());
    const url = '/api/paypal/orders/ORDER-1';
    assert.equal((await post(url + '/cancel', { confirmed: true })).status, 409);
    for (const message of ['Refund ORDER-1.', 'Status ORDER-1.', 'Cancel ORDER-2.', 'Cancel please.', 'Cancel ORDER-1 and ORDER-2.', 'Cancel ORDER-1 and the second order.']) {
      const { review } = await analyze(message);
      for (const operation of ['cancel', 'void']) assert.equal((await post(url + '/' + operation, { message, reviewId: review.reviewId, confirmed: true })).status, 409);
    }
    const message = 'Cancel ORDER-1.';
    const { review } = await analyze(message);
    const body = { message, reviewId: review.reviewId, confirmed: true, orderId: 'ORDER-1', authorizationId: 'AUTH-1' };
    for (const altered of [{ ...body, message: 'Cancel ORDER-1 now.' }, { ...body, confirmed: false }, { ...body, reviewId: 'fabricated' }]) {
      assert.equal((await post(url + '/cancel', altered)).status, 409);
    }
    assert.equal((await post('/api/paypal/orders/ORDER-2/cancel', body)).status, 409);
    assert.equal((await post(url + '/cancel', body, '')).status, 409);
    assert.equal(calls.length, 0);
    assert.equal((await post(url + '/cancel', body)).status, 200);
    assert.equal((await post(url + '/void', body)).status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1][3].authorizationId, 'AUTH-1');
    await analyze('Refund ORDER-1.');
    assert.equal((await post(url + '/void', body)).status, 409);
    assert.equal(calls.length, 2);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Out-of-order analysis completion cannot restore an older server review', async () => {
  let release;
  const real = analyzer();
  const deferred = { configured: true, analyze: async body => {
    if (body.message === 'Cancel ORDER-1.') await new Promise(resolve => { release = resolve; });
    return real.analyze(body);
  } };
  let paymentCalls = 0;
  const server = createApp({ cancel: () => { paymentCalls++; } }, deferred).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const config = await fetch(base + '/api/analysis/config');
    const cookie = config.headers.get('set-cookie').split(';')[0];
    const post = body => fetch(base + '/api/analysis', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    const old = post({ message: 'Cancel ORDER-1.', selectedOrderId: 'ORDER-1' });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const latest = await post({ message: 'Refund ORDER-1.', selectedOrderId: 'ORDER-1' });
    assert.equal((await latest.json()).review.canReviewCancellation, false);
    release();
    assert.equal((await old).status, 409);
    assert.equal(paymentCalls, 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
