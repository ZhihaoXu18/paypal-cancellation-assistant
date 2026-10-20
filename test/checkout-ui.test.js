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
  // Backend-issued matching cancellation review is required in addition to void confirmations.
  nodes.get('customer-request').value = 'Cancel ORDER-1.';
  vm.runInContext("requestReview = {message:'Cancel ORDER-1.', selectedOrderId:'ORDER-1', review:{canReviewCancellation:true,reviewId:'mock-review'}}; updateMerchantControls()", context);
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
  assert.deepEqual(JSON.parse(sent[0].options.body), { confirmed: true, orderId: 'ORDER-1', authorizationId: 'AUTH-1', reviewId: 'mock-review', message: 'Cancel ORDER-1.' });
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

function analysisUI({ configured = true, configFails = false, analysisFails = false, analyzeResponse } = {}) {
  const nodes = new Map(), calls = [];
  let callbacks;
  const node = () => ({ value: '', textContent: '', children: [], handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; }, replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); } });
  const context = vm.createContext({ URLSearchParams, encodeURIComponent,
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node, head: { append(script) { script.onload(); } } },
    paypal: { FUNDING: { PAYPAL: 'paypal' }, Buttons(options) { callbacks = options; return { render: async () => {} }; } },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/api/analysis/config' && configFails) throw new Error('offline');
      if (url === '/api/analysis' && analyzeResponse) return analyzeResponse(JSON.parse(options.body));
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

function matchingResponse(body, intent = 'cancellation_request') {
  return { ok: true, json: async () => ({ selectedOrderId: body.selectedOrderId,
    analysis: { intent, orderReferences: [{ reference: 'ORDER-1', quote: 'ORDER-1' }], reason: null,
      supportingQuotes: [body.message], reviewFlags: [], missingInformation: [], clarificationQuestions: [] },
    review: { status: body.selectedOrderId === 'ORDER-1' ? 'matched' : 'mismatched', canReviewCancellation: body.selectedOrderId === 'ORDER-1' && intent === 'cancellation_request', reviewId: 'mock-review' },
  }) };
}
function selectReviewOrder(ui, id = 'ORDER-1') {
  vm.runInContext(`displaySandbox({orderId:'${id}',orderStatus:'COMPLETED',currency:'CAD',amount:'100.00',authorizationId:'AUTH-1',authorizationStatus:'CREATED',localOrderStatus:'ACTIVE',shipmentStatus:'NOT_SHIPPED'})`, ui.context);
}
function visibleText(node) {
  return [node.textContent, ...(node.children || []).map(visibleText)].join(' ');
}
test('Refreshing the same selected order preserves review while updating its independent facts', async () => {
  const ui = analysisUI({ analyzeResponse: async body => matchingResponse(body) });
  await new Promise(resolve => setImmediate(resolve));
  selectReviewOrder(ui);
  ui.nodes.get('customer-request').value = 'Cancel ORDER-1.';
  await ui.nodes.get('analyze-request').handlers.click();
  const review = vm.runInContext('requestReview', ui.context);
  ui.nodes.get('confirm-cancellation').checked = true;
  vm.runInContext("displaySandbox({...currentSandbox, localOrderStatus:'CANCELLED'})", ui.context);
  assert.equal(vm.runInContext('requestReview', ui.context), review);
  assert.equal(ui.nodes.get('confirm-cancellation').checked, true);
  assert.match(visibleText(ui.nodes.get('request-review')), /Cancellation: CANCELLED/);
  assert.match(visibleText(ui.nodes.get('request-review')), /One literal reference matches/);
});
for (const edited of ['Refund ORDER-1.', '', 'x'.repeat(4001)]) {
  test(`Every customer edit immediately clears displayed analysis and confirmations (${edited.length} characters)`, async () => {
    const ui = analysisUI({ analyzeResponse: async body => matchingResponse(body) });
    await new Promise(resolve => setImmediate(resolve));
    selectReviewOrder(ui);
    vm.runInContext("currentSandbox.localOrderStatus='CANCELLED'", ui.context);
    const input = ui.nodes.get('customer-request');
    input.value = 'Cancel ORDER-1.';
    await ui.nodes.get('analyze-request').handlers.click();
    assert.match(visibleText(ui.nodes.get('request-analysis')), /cancellation_request/);
    assert.match(visibleText(ui.nodes.get('request-review')), /One literal reference matches/);
    ui.nodes.get('confirm-cancellation').checked = true;
    ui.nodes.get('confirm-void').checked = true;
    ui.nodes.get('confirm-void').handlers.change();
    assert.equal(ui.nodes.get('void-authorization').disabled, false);
    const calls = ui.calls.length;
    input.value = edited; input.handlers.input();
    assert.match(ui.nodes.get('analysis-status').textContent, /^No current analysis\./);
    assert.doesNotMatch(visibleText(ui.nodes.get('request-analysis')), /cancellation_request|Cancel ORDER-1/);
    assert.match(visibleText(ui.nodes.get('request-analysis')), /No current analysis/);
    assert.doesNotMatch(visibleText(ui.nodes.get('request-review')), /One literal reference matches|cancellation_request/);
    assert.match(visibleText(ui.nodes.get('request-review')), /Not evaluated/);
    for (const id of ['confirm-cancellation', 'confirm-void']) {
      assert.equal(ui.nodes.get(id).checked, false);
      assert.equal(ui.nodes.get(id).disabled, true);
    }
    for (const id of ['cancel-local-order', 'void-authorization']) assert.equal(ui.nodes.get(id).disabled, true);
    assert.equal(ui.calls.length, calls);
    assert.equal(vm.runInContext('currentSandbox.orderId', ui.context), 'ORDER-1');
    assert.match(visibleText(ui.nodes.get('request-review')), /Cancellation: CANCELLED/);
  });
}

for (const fails of [false, true]) {
  test(`Editing without reanalysis ignores stale ${fails ? 'failure' : 'success'} responses`, async () => {
    let release;
    const ui = analysisUI({ analyzeResponse: async body => {
      await new Promise(resolve => { release = resolve; });
      if (fails) throw new Error('Old analysis failed');
      return matchingResponse(body);
    } });
    await new Promise(resolve => setImmediate(resolve));
    selectReviewOrder(ui);
    const input = ui.nodes.get('customer-request');
    input.value = 'Cancel ORDER-1.';
    const pending = ui.nodes.get('analyze-request').handlers.click();
    input.value = 'Refund ORDER-1.'; input.handlers.input();
    const status = ui.nodes.get('analysis-status').textContent;
    release(); await pending;
    assert.match(status, /^No current analysis\./);
    assert.equal(ui.nodes.get('analysis-status').textContent, status);
    assert.equal(vm.runInContext('requestReview', ui.context), undefined);
    assert.doesNotMatch(visibleText(ui.nodes.get('request-analysis')), /cancellation_request/);
    assert.equal(ui.nodes.get('cancel-local-order').disabled, true);
    assert.equal(ui.nodes.get('void-authorization').disabled, true);
    assert.equal(ui.calls.filter(call => call.url === '/api/analysis').length, 1);
  });
}
test('Matching cancellation requires manual confirmation; panel separates all four evidence sources', async () => {
  const ui = analysisUI({ analyzeResponse: async body => matchingResponse(body) });
  await new Promise(resolve => setImmediate(resolve));
  selectReviewOrder(ui);
  const input = ui.nodes.get('customer-request');
  input.value = 'Cancel ORDER-1.'; input.handlers.input();
  await ui.nodes.get('analyze-request').handlers.click();
  assert.equal(ui.nodes.get('cancel-local-order').disabled, true);
  const labels = ui.nodes.get('request-review').children.filter(node => node.children.length === 0).map(node => node.textContent);
  assert.deepEqual(labels, ['Unverified customer intent and claims', 'Order-reference match result (backend)', 'Verified PayPal facts (last retrieved snapshot)', 'Simulated local cancellation and shipment facts']);
  const confirmation = ui.nodes.get('confirm-cancellation');
  assert.equal(confirmation.disabled, false);
  confirmation.checked = true; confirmation.handlers.change();
  assert.equal(ui.nodes.get('cancel-local-order').disabled, false);
  input.value = 'Refund ORDER-1.'; input.handlers.input();
  assert.equal(confirmation.checked, false);
  assert.equal(ui.nodes.get('cancel-local-order').disabled, true);
  await ui.nodes.get('cancel-local-order').handlers.click();
  assert.equal(ui.calls.filter(call => call.url.endsWith('/cancel')).length, 0);
  assert.equal(vm.runInContext('requestReview', ui.context), undefined);
});

test('Changing selected order clears review and both merchant confirmations', async () => {
  const ui = analysisUI({ analyzeResponse: async body => matchingResponse(body) });
  await new Promise(resolve => setImmediate(resolve));
  selectReviewOrder(ui);
  ui.nodes.get('customer-request').value = 'Cancel ORDER-1.';
  await ui.nodes.get('analyze-request').handlers.click();
  ui.nodes.get('confirm-cancellation').checked = true;
  ui.nodes.get('confirm-void').checked = true;
  selectReviewOrder(ui, 'ORDER-2');
  assert.equal(vm.runInContext('requestReview', ui.context), undefined);
  assert.equal(ui.nodes.get('confirm-cancellation').checked, false);
  assert.equal(ui.nodes.get('confirm-void').checked, false);
  assert.equal(ui.nodes.get('cancel-local-order').disabled, true);
});

for (const change of ['text', 'order']) {
  test(`Stale analysis ignored after ${change} changes, without clearing a newer review`, async () => {
    let release;
    let count = 0;
    const ui = analysisUI({ analyzeResponse: async body => {
      if (++count === 1) await new Promise(resolve => { release = resolve; });
      return matchingResponse(body);
    } });
    await new Promise(resolve => setImmediate(resolve));
    selectReviewOrder(ui);
    const input = ui.nodes.get('customer-request');
    input.value = 'Cancel ORDER-1.';
    const old = ui.nodes.get('analyze-request').handlers.click();
    assert.equal(input.disabled, false);
    if (change === 'text') { input.value = 'Cancel ORDER-1 please.'; input.handlers.input(); }
    else selectReviewOrder(ui, 'ORDER-2');
    // No request-to-order selection is performed by the response handler.
    assert.equal(vm.runInContext('requestReview', ui.context), undefined);
    await ui.nodes.get('analyze-request').handlers.click();
    const latest = vm.runInContext('requestReview', ui.context);
    release(); await old;
    assert.equal(vm.runInContext('requestReview', ui.context), latest);
    assert.equal(latest.message, input.value);
    assert.equal(latest.selectedOrderId, change === 'order' ? 'ORDER-2' : 'ORDER-1');
  });
}

for (const intent of ['refund_request', 'status_question']) {
  test(`${intent} remains outside cancellation and void controls despite matching reference`, async () => {
    const ui = analysisUI({ analyzeResponse: async body => matchingResponse(body, intent) });
    await new Promise(resolve => setImmediate(resolve));
    selectReviewOrder(ui);
    ui.nodes.get('customer-request').value = 'ORDER-1';
    await ui.nodes.get('analyze-request').handlers.click();
    ui.nodes.get('confirm-cancellation').checked = true;
    ui.nodes.get('confirm-void').checked = true;
    ui.nodes.get('confirm-cancellation').handlers.change();
    assert.equal(ui.nodes.get('cancel-local-order').disabled, true);
    assert.equal(ui.nodes.get('void-authorization').disabled, true);
    await ui.nodes.get('cancel-local-order').handlers.click();
    await ui.nodes.get('void-authorization').handlers.click();
    assert.equal(ui.calls.filter(call => /\/(cancel|void)$/.test(call.url)).length, 0);
  });
}

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
