const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('Checkout SDK uses CAD authorize, cancellation sends no authorization, and repeated approvals are deduplicated', async () => {
  let callbacks;
  let sdkUrl;
  let authorizeCalls = 0;
  const nodes = new Map();
  const node = () => ({ textContent: '', addEventListener() {}, replaceChildren() {}, append() {} });
  const context = vm.createContext({
    URLSearchParams, encodeURIComponent,
    document: {
      getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
      createElement: node,
      head: { append(script) { sdkUrl = script.src; script.onload(); } },
    },
    paypal: { FUNDING: { PAYPAL: 'paypal' }, Buttons(options) { callbacks = options; return { render: async () => {} }; } },
    fetch: async (url) => {
      const data = url.endsWith('/config') ? { clientId: 'mock-client' } : url.endsWith('/api/health') ? { status: 'ok' } : { orderId: 'ORDER-1', orderStatus: 'CREATED', currency: 'CAD', amount: '100.00', authorizationId: url.endsWith('/authorize') ? 'AUTH-1' : null, authorizationStatus: url.endsWith('/authorize') ? 'CREATED' : null };
      if (url.endsWith('/authorize')) authorizeCalls++;
      return { ok: true, json: async () => data };
    },
  });
  await vm.runInContext(fs.readFileSync('public/app.js', 'utf8'), context);
  assert.equal(new URL(sdkUrl).searchParams.get('currency'), 'CAD');
  assert.equal(new URL(sdkUrl).searchParams.get('intent'), 'authorize');
  await callbacks.createOrder();
  callbacks.onCancel();
  assert.equal(authorizeCalls, 0);
  assert.match(nodes.get('sandbox-status').textContent, /Buyer cancelled/);
  await Promise.all([callbacks.onApprove({ orderID: 'ORDER-1' }), callbacks.onApprove({ orderID: 'ORDER-1' })]);
  await callbacks.onApprove({ orderID: 'ORDER-1' });
  assert.equal(authorizeCalls, 1);
  assert.match(nodes.get('sandbox-status').textContent, /Payment authorized — not captured/);
});
