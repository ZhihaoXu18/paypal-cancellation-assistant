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

test('Customer analysis uses only its analysis endpoint and never triggers a PayPal mutation', async () => {
  const nodes = new Map(), calls = [];
  const node = () => ({ value: '', textContent: '', handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; }, replaceChildren() {}, append() {} });
  const context = vm.createContext({ URLSearchParams, encodeURIComponent,
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node, head: { append(script) { script.onload(); } } },
    paypal: { FUNDING: { PAYPAL: 'paypal' }, Buttons() { return { render: async () => {} }; } },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      const data = url === '/api/analysis/config' ? { configured: true } : url === '/api/paypal/config' ? { clientId: 'mock-client' } : url === '/api/analysis' ? { analysis: { intent: 'unclear', orderReferences: [], reason: null, supportingQuotes: ['Cancel the second order.'], reviewFlags: ['missing_order_reference', 'ambiguous_order_reference'], missingInformation: ['Order ID'], clarificationQuestions: ['Which exact order ID?'] } } : { status: 'ok' };
      return { ok: true, json: async () => data };
    },
  });
  vm.runInContext(fs.readFileSync('public/app.js', 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext("displaySandbox({orderId:'ORDER-1', authorizationStatus:'VOIDED', localOrderStatus:'CANCELLED', shipmentStatus:'NOT_SHIPPED', voidState:'CONFIRMED'})", context);
  nodes.get('customer-request').value = 'Cancel the second order.';
  await nodes.get('analyze-request').handlers.click();
  const posts = calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/analysis');
  assert.equal(JSON.parse(posts[0].options.body).selectedOrderId, 'ORDER-1');
  assert.match(nodes.get('analysis-status').textContent, /Unverified customer claims/);
  assert.equal(nodes.get('confirm-void').disabled, true);
  assert.equal(nodes.get('void-authorization').disabled, true);
  assert.equal(vm.runInContext('currentSandbox.localOrderStatus', context), 'CANCELLED');
});

function analysisUI({ configured = true, configFails = false, analysisFails = false } = {}) {
  const nodes = new Map(), calls = [];
  let callbacks;
  const node = () => ({ value: '', textContent: '', handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; }, replaceChildren() {}, append() {} });
  const context = vm.createContext({ URLSearchParams, encodeURIComponent,
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node, head: { append(script) { script.onload(); } } },
    paypal: { FUNDING: { PAYPAL: 'paypal' }, Buttons(options) { callbacks = options; return { render: async () => {} }; } },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/api/analysis/config' && configFails) throw new Error('offline');
      const failed = url === '/api/analysis' && analysisFails;
      const data = url === '/api/analysis/config' ? { configured } : url === '/api/paypal/config' ? { clientId: 'mock-client' } : failed ? { error: 'AI unavailable. No action was taken.' } : url === '/api/analysis' ? { analysis: { intent: 'unclear', orderReferences: [], reason: null, supportingQuotes: ['Cancel my order.'], reviewFlags: [], missingInformation: [], clarificationQuestions: [] } } : { status: 'ok' };
      return { ok: !failed, json: async () => data };
    },
  });
  vm.runInContext(fs.readFileSync('public/app.js', 'utf8'), context);
  return { nodes, calls, context, checkoutError: () => callbacks.onError() };
}

test('Analysis accepts valid text without checkout and after CREATED checkout failure, with no payment mutations', async () => {
  const ui = analysisUI();
  await new Promise(resolve => setImmediate(resolve));
  const button = ui.nodes.get('analyze-request'), input = ui.nodes.get('customer-request');
  assert.equal(button.disabled, true);
  assert.match(ui.nodes.get('analysis-status').textContent, /Enter a customer request/);
  input.value = '   '; input.handlers.input();
  await button.handlers.click();
  assert.equal(ui.calls.filter(c => c.url === '/api/analysis').length, 0);
  input.value = 'Cancel my order.'; input.handlers.input();
  assert.equal(button.disabled, false);
  await button.handlers.click();
  assert.equal(JSON.parse(ui.calls.find(c => c.url === '/api/analysis').options.body).selectedOrderId, undefined);
  vm.runInContext("displaySandbox({orderId:'6NH53431XU495094E', orderStatus:'CREATED', authorizationId:null, authorizationStatus:null, localOrderStatus:'ACTIVE', shipmentStatus:'NOT_SHIPPED'})", ui.context);
  ui.checkoutError();
  assert.equal(input.value, 'Cancel my order.');
  assert.equal(input.disabled, false);
  assert.equal(button.disabled, false);
  await button.handlers.click();
  const posts = ui.calls.filter(c => c.options.method === 'POST');
  assert.deepEqual(posts.map(c => c.url), ['/api/analysis', '/api/analysis']);
  assert.equal(JSON.parse(posts[1].options.body).selectedOrderId, '6NH53431XU495094E');
  assert.equal(ui.nodes.get('void-authorization').disabled, true);
  input.value = 'x'.repeat(4001); input.handlers.input();
  assert.equal(button.disabled, true);
  assert.match(ui.nodes.get('analysis-status').textContent, /1–4000/);
});

test('Analysis explains missing or failed configuration and restores controls after a provider failure', async () => {
  for (const options of [{ configured: false }, { configFails: true }, { analysisFails: true }]) {
    const ui = analysisUI(options);
    await new Promise(resolve => setImmediate(resolve));
    const input = ui.nodes.get('customer-request'), button = ui.nodes.get('analyze-request');
    input.value = 'Cancel my order.'; input.handlers.input();
    if (options.analysisFails) {
      await button.handlers.click();
      assert.equal(button.disabled, false);
      assert.equal(input.disabled, false);
      assert.match(ui.nodes.get('analysis-status').textContent, /AI unavailable/);
    } else {
      assert.equal(button.disabled, true);
      assert.match(ui.nodes.get('analysis-status').textContent, options.configFails ? /configuration unavailable/ : /AI not configured/);
      await button.handlers.click();
      assert.equal(ui.calls.filter(c => c.options.method === 'POST').length, 0);
    }
  }
});
