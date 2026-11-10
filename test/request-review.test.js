const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createRequestAnalyzer } = require('../lib/request-analysis');
const { createApp } = require('../app');

function analyzer() {
  return createRequestAnalyzer({ configured: true, analyze: async message => ({
    intent: message.startsWith('Refund') ? 'refund_request' : message.startsWith('Status') ? 'status_question' : 'cancellation_request',
    orderReferences: [], reason: null, cancellationConditions: [], unmetConditionRequirements: [], supportingQuotes: [message], missingInformation: [], clarificationQuestions: [],
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
    for (const operation of ['cancel', 'void']) {
      const empty = await fetch(base + url + '/' + operation, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie } });
      assert.equal(empty.status, 409);
      assert.match((await empty.json()).error, /current matching cancellation review/);
    }
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

test('Expired reviews and reviews from a previous app instance cannot reach payment methods', async t => {
  let paymentCalls = 0;
  const forbidden = () => { paymentCalls++; throw new Error('Payment method must not run'); };
  const paypal = { cancel: forbidden, void: forbidden };
  const first = createApp(paypal, analyzer()).listen(0, '127.0.0.1');
  const restarted = createApp(paypal, analyzer()).listen(0, '127.0.0.1');
  try {
    await Promise.all([once(first, 'listening'), once(restarted, 'listening')]);
    const base = server => `http://127.0.0.1:${server.address().port}`;
    const config = await fetch(base(first) + '/api/analysis/config');
    const cookie = config.headers.get('set-cookie').split(';')[0];
    const message = 'Cancel ORDER-1.';
    const post = (server, path, body) => fetch(base(server) + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    const result = await post(first, '/api/analysis', { message, selectedOrderId: 'ORDER-1' });
    const { review } = await result.json();
    const body = { message, reviewId: review.reviewId, confirmed: true, orderId: 'ORDER-1', authorizationId: 'AUTH-1' };
    for (const operation of ['cancel', 'void']) {
      assert.equal((await post(restarted, `/api/paypal/orders/ORDER-1/${operation}`, body)).status, 409);
    }
    const future = Date.now() + 16 * 60 * 1000;
    t.mock.method(Date, 'now', () => future);
    for (const operation of ['cancel', 'void']) {
      assert.equal((await post(first, `/api/paypal/orders/ORDER-1/${operation}`, body)).status, 409);
    }
    assert.equal(paymentCalls, 0);
  } finally {
    t.mock.restoreAll();
    for (const server of [first, restarted]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
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

test('Merchant confirmation and forged eligibility cannot override conditional blocking for cancel or void', async () => {
  let calls = 0;
  const message = 'Please cancel order TEST-123 only if it has not shipped.\nIf it has already shipped, keep the order.';
  const conditionalAnalyzer = createRequestAnalyzer({ configured: true, analyze: async () => ({
    intent: 'cancellation_request', orderReferences: [], reason: null,
    cancellationConditions: [{ text: 'only if it has not shipped', quote: 'only if it has not shipped.' }],
    unmetConditionRequirements: [{ text: 'keep the order', quote: 'If it has already shipped, keep the order.' }],
    supportingQuotes: [message], missingInformation: [], clarificationQuestions: [],
  }) });
  const server = createApp({ cancel: () => { calls++; }, void: () => { calls++; } }, conditionalAnalyzer).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const config = await fetch(base + '/api/analysis/config');
    const cookie = config.headers.get('set-cookie').split(';')[0];
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const response = await post('/api/analysis', { message, selectedOrderId: 'TEST-123' });
    assert.equal(response.status, 200);
    const { review, analysis } = await response.json();
    assert.equal(analysis.reason, null);
    assert.equal(review.canReviewCancellation, false);
    for (const operation of ['cancel', 'void']) {
      const attempt = await post(`/api/paypal/orders/TEST-123/${operation}`, { confirmed: true, message, reviewId: review.reviewId, orderId: 'TEST-123', authorizationId: 'AUTH-1', canReviewCancellation: true });
      assert.equal(attempt.status, 409);
    }
    assert.equal(calls, 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Conditional findings require evidence and stay bound to the active review without opening payment gates', async () => {
  let paymentCalls = 0;
  const forbidden = () => { paymentCalls++; throw new Error('Payment operation reached'); };
  const server = createApp({ cancel: forbidden, void: forbidden }, analyzer()).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const config = await fetch(base + '/api/analysis/config');
    let cookie = config.headers.get('set-cookie').split(';')[0];
    let version;
    let id;
    const post = (path, body, session = cookie) => fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: session }, body: JSON.stringify(body),
    });
    const message = 'Cancel ORDER-1 if it has not shipped.';
    const analyze = async message => (await (await post('/api/analysis', { message, selectedOrderId: 'ORDER-1' })).json()).review;
    const path = '/api/analysis/condition-review';
    const review = await analyze(message);
    const body = { reviewId: review.reviewId, message, outcome: 'met', evidence: 'Warehouse confirmed no carrier handoff.' };
    assert.equal(review.canReviewCancellation, false);
    assert.equal((await post(path, body, '')).status, 409);
    assert.equal((await post(path, { ...body, message: message + ' Changed.' })).status, 409);
    assert.equal((await post(path, { ...body, evidence: ' ' })).status, 400);
    assert.equal((await post(path, { ...body, outcome: 'approved' })).status, 400);
    for (const outcome of ['unknown', 'not_met', 'met']) {
      const res = await post(path, { ...body, outcome, version });
      assert.equal(res.status, 200);
      const { finding, case: saved } = await res.json();
      if (!id) {
        id = saved.id;
        cookie += '; ' + res.headers.getSetCookie().find(value => value.startsWith('condition_cases=')).split(';')[0];
      }
      assert.equal(saved.id, id);
      version = saved.version;
      assert.equal(finding.outcome, outcome);
      assert.equal(finding.evidence, body.evidence);
      assert.ok(Number.isFinite(Date.parse(finding.recordedAt)));
      for (const operation of ['cancel', 'void']) {
        assert.equal((await post('/api/paypal/orders/ORDER-1/' + operation, { ...body, confirmed: true })).status, 409);
      }
    }
    const ordinaryMessage = 'Cancel ORDER-1.';
    const ordinary = await analyze(ordinaryMessage);
    assert.equal((await post(path, body)).status, 409);
    assert.equal((await post(path, { ...body, reviewId: ordinary.reviewId, message: ordinaryMessage })).status, 409);
    assert.equal(paymentCalls, 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Saved review survives restart, rejects another browser, and cannot authorize a payment', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { createConditionCases } = require('../lib/condition-cases');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'condition-cases-test-'));
  const servers = [];
  let paymentCalls = 0;
  const forbidden = () => { paymentCalls++; throw new Error('Payment operation reached'); };
  async function start() {
    const server = createApp({ cancel: forbidden, void: forbidden }, analyzer(), {}, createConditionCases(directory)).listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    return 'http://127.0.0.1:' + server.address().port;
  }
  const close = async server => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  const getCookie = (response, name) => response.headers.getSetCookie().find(value => value.startsWith(name + '=')).split(';')[0];
  const post = (url, body, cookie) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  try {
    let base = await start();
    const listPath = '/api/analysis/condition-cases';
    const empty = await fetch(base + listPath);
    const browser = getCookie(empty, 'condition_cases');
    const session = getCookie(empty, 'sandbox_session');
    const message = 'Cancel ORDER-1 if it has not shipped.';
    const { review } = await (await post(base + '/api/analysis', { message, selectedOrderId: 'ORDER-1' }, session)).json();
    const saved = await (await post(base + '/api/analysis/condition-review', {
      message, reviewId: review.reviewId, outcome: 'unknown', subject: 'Warehouse follow-up', evidence: 'Waiting for carrier confirmation.',
      conditionSummary: 'Cancel only if not shipped.', supportTicket: 'CS-1042',
    }, session + '; ' + browser)).json();
    await close(servers.shift());
    base = await start();
    const headers = { Cookie: browser };
    const { cases } = await (await fetch(base + listPath, { headers })).json();
    assert.equal(cases.length, 1);
    assert.equal(cases[0].outcome, 'unknown');
    const url = base + listPath + '/' + saved.case.id;
    const detail = await (await fetch(url, { headers })).json();
    assert.equal(detail.case.finding.evidence, 'Waiting for carrier confirmation.');
    assert.ok(!JSON.stringify(detail).includes(message));
    assert.equal(detail.case.conditionSummary, 'Cancel only if not shipped.');
    assert.equal(detail.case.supportTicket, 'CS-1042');
    assert.equal((await fetch(url)).status, 404);
    const update = { version: detail.case.version, outcome: 'met', evidence: 'Warehouse confirmed no handoff.' };
    assert.equal((await post(url, update, '')).status, 404);
    assert.equal((await post(url, { ...update, supportTicket: 'https://example.test' }, browser)).status, 400);
    const updated = await post(url, { ...update, supportTicket: 'CS-1043' }, browser);
    assert.equal(updated.status, 200);
    const updatedCase = (await updated.json()).case;
    assert.equal(updatedCase.finding.outcome, 'met');
    assert.equal(updatedCase.conditionSummary, 'Cancel only if not shipped.');
    assert.equal(updatedCase.supportTicket, 'CS-1043');
    assert.equal((await post(url, update, browser)).status, 409);
    for (const operation of ['cancel', 'void']) {
      const result = await post(base + '/api/paypal/orders/ORDER-1/' + operation, { confirmed: true, message, reviewId: saved.case.id }, browser);
      assert.equal(result.status, 409);
    }
    assert.equal(paymentCalls, 0);
  } finally {
    await Promise.all(servers.map(close));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
