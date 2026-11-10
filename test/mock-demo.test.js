const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { createApp } = require('../app');
const { createMockAnalyzer, DEMO_MESSAGE } = require('../lib/mock-demo');

test('Mock demo saves, reopens and revises the same review without external providers or real storage', async t => {
  const forbidden = () => assert.fail('Real integration or saved-review store accessed');
  const server = createApp({ config: forbidden, create: forbidden, authorize: forbidden, cancel: forbidden, void: forbidden, status: forbidden },
    { configured: false, analyze: forbidden }, { order: forbidden }, { get: forbidden, list: forbidden, save: forbidden }).listen(0, '127.0.0.1');
  const originalFetch = global.fetch;
  t.mock.method(global, 'fetch', (url, options) => {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'External network forbidden');
    return originalFetch(url, options);
  });
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const jar = new Map();
    async function request(path, body) {
      const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Cookie: [...jar].map(([k,v]) => `${k}=${v}`).join('; '), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      for (const c of r.headers.getSetCookie()) { const [k,v] = c.split(';')[0].split('='); jar.set(k,v); }
      return r;
    }
    const page = await (await request('/mock-demo')).text();
    assert.match(page, /Mock demo/);
    assert.doesNotMatch(page, /shopify\.js|paypal\.com/);
    await request('/demo/api/analysis/condition-cases');
    const { review } = await (await request('/demo/api/analysis', { message: DEMO_MESSAGE })).json();
    assert.equal(review.canReviewCancellation, false);
    const first = await request('/demo/api/analysis/condition-review', { message: DEMO_MESSAGE, reviewId: review.reviewId, outcome: 'unknown', evidence: 'Mock: awaiting warehouse confirmation.' });
    assert.equal(first.status, 200);
    const saved = (await first.json()).case;
    const list = await (await request('/demo/api/analysis/condition-cases')).json();
    assert.equal(list.cases[0].id, saved.id);
    const detailPath = '/demo/api/analysis/condition-cases/' + saved.id;
    const reopened = (await (await request(detailPath)).json()).case;
    const updated = await request(detailPath, { version: reopened.version, outcome: 'met', evidence: 'Mock: warehouse confirmed no handoff.' });
    const revised = (await updated.json()).case;
    assert.equal(revised.id, saved.id);
    assert.equal(revised.finding.outcome, 'met');
    assert.deepEqual(revised.priorFindings, [saved.finding]);
    assert.equal((await request('/demo/api/analysis', { message: 'Cancel a real order.' })).status, 400);
    assert.equal(jar.has('condition_cases'), false);
    assert.equal(jar.has('sandbox_session'), false);
    assert.ok(jar.has('mock_condition_cases'));
    for (const path of ['/api/paypal/config', '/api/paypal/orders', '/api/paypal/orders/1001/authorize', '/api/paypal/orders/1001/cancel', '/api/paypal/orders/1001/void', '/api/paypal/orders/1001/capture', '/api/paypal/orders/1001/refund', '/api/shopify/order']) {
      assert.equal((await request('/demo' + path, { confirmed: true, reviewId: review.reviewId })).status, 403);
    }
    // A mock review cannot open real payment gates even if submitted outside the demo namespace.
    assert.equal((await request('/api/paypal/orders/1001/void', { confirmed: true, reviewId: review.reviewId, message: DEMO_MESSAGE })).status, 409);
  } finally { t.mock.restoreAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Mock frontend completes the same-review history flow using shared forms and demo-only requests', async () => {
  const nodes = new Map(), calls = [];
  function node(tag = '') {
    return { tag, value: '', children: [], handlers: {}, text: '',
      get textContent() { return this.text + this.children.map(c => c.textContent).join(' '); },
      set textContent(v) { this.text = v; },
      append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; this.text = ''; },
      addEventListener(event, callback) { this.handlers[event] = callback; }, setAttribute() {},
      contains(item) { return this === item || this.children.some(c => c.contains(item)); },
      click() { return this.handlers.click?.(); },
    };
  }
  const result = await createMockAnalyzer().analyze({ message: DEMO_MESSAGE });
  const first = { id: 'mock-case', version: 1, subject: 'Mock demo', finding: { outcome: 'unknown', evidence: 'Mock waiting note', recordedAt: '2026-11-09T00:00:00Z' }, priorFindings: [] };
  const second = { ...first, version: 2, finding: { outcome: 'met', evidence: 'Mock confirmation note', recordedAt: '2026-11-09T00:01:00Z' }, priorFindings: [first.finding] };
  let saved;
  const context = vm.createContext({ URLSearchParams, encodeURIComponent,
    document: { documentElement: { dataset: { mockDemo: 'true' } }, getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node, head: { append() { assert.fail('SDK loading forbidden'); } } },
    fetch: async (url, options = {}) => {
      calls.push(url); assert.ok(url.startsWith('/demo/api/'));
      let body;
      if (url.endsWith('/health')) body = { status: 'ok' };
      else if (url.endsWith('/analysis/config')) body = { configured: true };
      else if (url.endsWith('/analysis')) body = { ...result, review: { ...result.review, reviewId: 'mock-review' } };
      else if (options.method === 'POST') { saved = saved ? second : first; body = { case: saved, finding: saved.finding }; }
      else if (url.endsWith('/condition-cases')) body = { cases: saved ? [saved] : [] };
      else body = { case: saved };
      return { ok: true, json: async () => body };
    },
  });
  vm.runInContext(fs.readFileSync('public/app.js', 'utf8'), context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle(); await nodes.get('load-mock-example').click(); await settle();
  assert.equal(nodes.get('customer-request').value, DEMO_MESSAGE);
  const find = (root, predicate) => predicate(root) ? root : root.children.map(c => find(c, predicate)).find(Boolean);
  async function save(panel, outcome, evidence) {
    const form = find(panel, n => n.tag === 'form');
    find(form, n => n.tag === 'select').value = outcome;
    const label = find(form, n => n.tag === 'label' && n.text.startsWith('Evidence note'));
    label.children[0].value = evidence;
    await form.handlers.submit({ preventDefault() {} }); await settle();
  }
  await save(nodes.get('request-review'), 'unknown', 'Mock waiting note');
  await find(nodes.get('condition-cases-list'), n => n.tag === 'button').click();
  await save(nodes.get('condition-case-detail'), 'met', 'Mock confirmation note');
  const display = nodes.get('condition-case-detail').textContent;
  assert.match(display, /Condition met/);
  assert.match(display, /Previous findings \(1\)/);
  assert.match(display, /Unable to confirm.*Mock waiting note/);
  assert.ok(calls.every(url => !/paypal|shopify|openai/.test(url)));
});
