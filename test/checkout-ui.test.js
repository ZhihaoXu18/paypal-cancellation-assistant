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
  await new Promise(resolve => setImmediate(resolve));
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

test('Void UI sends no request until checkbox and final merchant confirmation; request binds both IDs', async () => {
  const nodes = new Map();
  const calls = [];
  let allowConfirm = false;
  let confirmationPrompt;
  const node = () => ({ textContent: '', checked: false, value: '', handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; }, replaceChildren() {}, append() {} });
  const context = vm.createContext({ URLSearchParams, encodeURIComponent,
    window: { confirm(prompt) { confirmationPrompt = prompt; return allowConfirm; } },
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node, head: { append(script) { script.onload(); } } },
    paypal: { FUNDING: { PAYPAL: 'paypal' }, Buttons() { return { render: async () => {} }; } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => url.endsWith('/config') ? { clientId: 'mock-client' } : url.endsWith('/api/health') ? { status: 'ok' } : { orderId: 'ORDER-1', authorizationId: 'AUTH-1', authorizationStatus: 'VOIDED', localOrderStatus: 'CANCELLED', shipmentStatus: 'NOT_SHIPPED', voidState: 'CONFIRMED', message: 'Void confirmed.' } };
    },
  });
  vm.runInContext(fs.readFileSync('public/app.js', 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext("displaySandbox({orderId:'ORDER-1', authorizationId:'AUTH-1', localOrderStatus:'CANCELLED', shipmentStatus:'NOT_SHIPPED', authorizationStatus:'CREATED'})", context);
  const button = nodes.get('void-authorization');
  assert.equal(button.disabled, true);
  await button.handlers.click();
  nodes.get('confirm-void').checked = true;
  nodes.get('confirm-void').handlers.change();
  assert.equal(button.disabled, false);
  await button.handlers.click();
  assert.equal(calls.filter(c => c.url.endsWith('/void')).length, 0);
  allowConfirm = true;
  await button.handlers.click();
  const sent = calls.filter(c => c.url.endsWith('/void'));
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].options.body), { confirmed: true, orderId: 'ORDER-1', authorizationId: 'AUTH-1' });
  assert.match(confirmationPrompt, /ORDER-1/);
  assert.match(confirmationPrompt, /AUTH-1/);
  assert.equal(nodes.get('confirm-void').checked, false);
  assert.equal(button.disabled, true);
  assert.equal(nodes.get('confirm-void').disabled, true);
  assert.match(nodes.get('void-recommendation').textContent, /Authorization already voided/);
  // Even a stale callback or programmatically checked box cannot send another request.
  nodes.get('confirm-void').checked = true;
  await button.handlers.click();
  assert.equal(calls.filter(c => c.url.endsWith('/void')).length, 1);
});
