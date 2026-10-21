const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

async function checkout(authorize) {
  const nodes = new Map(), logs = [], calls = [];
  let callbacks;
  const node = () => ({ value: '', checked: false, textContent: '', addEventListener() {}, replaceChildren() {}, append() {} });
  const state = { orderId: 'ORDER-1', orderStatus: 'APPROVED', authorizationId: null, localOrderStatus: 'ACTIVE', shipmentStatus: 'NOT_SHIPPED' };
  const context = vm.createContext({ URLSearchParams, encodeURIComponent,
    console: { info: value => logs.push(JSON.parse(JSON.stringify(value))) },
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node, head: { append(script) { script.onload(); } } },
    paypal: { FUNDING: { PAYPAL: 'paypal' }, Buttons(value) { callbacks = value; return { render: async () => {} }; } },
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method });
      if (url.endsWith('/authorize')) return authorize();
      return { ok: true, status: 200, json: async () => url === '/api/paypal/config' ? { clientId: 'fake-client' } : { status: 'ok' } };
    },
  });
  vm.runInContext(fs.readFileSync('public/app.js', 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext(`displaySandbox(${JSON.stringify(state)})`, context);
  return { callbacks, logs, calls, nodes, context, state };
}
const success = () => ({ ok: true, status: 200, json: async () => ({ orderId: 'ORDER-1', authorizationId: 'AUTH-1', authorizationStatus: 'CREATED', localOrderStatus: 'ACTIVE', shipmentStatus: 'NOT_SHIPPED' }) });
function sanitized(logs) {
  for (const log of logs) {
    assert.ok(Number.isFinite(Date.parse(log.time)));
    assert.ok(Object.keys(log).every(key => ['time', 'event', 'orderId', 'deduplicationHit', 'httpStatus', 'errorCategory'].includes(key)));
  }
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|fake-client|Authorization|Bearer|customer message/);
}

test('Approval diagnostics preserve event order and deduplicate without logging SDK data', async () => {
  let release;
  const ui = await checkout(() => new Promise(resolve => { release = () => resolve(success()); }));
  const data = { orderID: 'ORDER-1', token: 'PRIVATE-TOKEN', customer: 'PRIVATE customer message' };
  const first = ui.callbacks.onApprove(data);
  const repeated = ui.callbacks.onApprove(data);
  assert.equal(first, repeated);
  assert.deepEqual(ui.logs.map(log => log.event), ['onApprove_enter', 'approval_deduplication', 'authorization_post_sending', 'onApprove_enter', 'approval_deduplication']);
  assert.equal(ui.logs[1].deduplicationHit, false);
  assert.equal(ui.logs[4].deduplicationHit, true);
  const before = ui.calls.length;
  const snapshot = JSON.stringify(vm.runInContext('currentSandbox', ui.context));
  ui.callbacks.onCancel(data);
  assert.equal(JSON.stringify(vm.runInContext('currentSandbox', ui.context)), snapshot);
  assert.equal(ui.calls.length, before);
  const prompt = ui.nodes.get('sandbox-status').textContent;
  assert.match(prompt, /cancellation callback received/);
  assert.match(prompt, /read-only/);
  assert.doesNotMatch(prompt, /Buyer cancelled|No authorization request was sent/);
  release(); await first;
  assert.equal(ui.logs.at(-1).event, 'authorization_request_succeeded');
  assert.equal(ui.logs.at(-1).httpStatus, 200);
  await ui.callbacks.onApprove(data);
  assert.equal(ui.calls.filter(call => call.url.endsWith('/authorize')).length, 1);
  ui.callbacks.onError({ message: 'PRIVATE-ERROR', headers: { Authorization: 'Bearer PRIVATE' } });
  assert.equal(ui.logs.at(-1).errorCategory, 'SDK_ERROR');
  sanitized(ui.logs);
});

for (const [category, authorize, status] of [
  ['HTTP_ERROR', () => ({ ok: false, status: 409, json: async () => ({ error: 'PRIVATE-HTTP-ERROR' }) }), 409],
  ['NETWORK_ERROR', () => { throw new TypeError('PRIVATE-NETWORK-ERROR'); }, undefined],
  ['REQUEST_TIMEOUT', () => { const error = new Error('PRIVATE-TIMEOUT'); error.name = 'AbortError'; throw error; }, undefined],
  ['RESPONSE_UNREADABLE', () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('PRIVATE-RESPONSE'); } }), 200],
]) {
  test(`Authorization failure logs only allowlisted ${category} and status, without retry`, async () => {
    const ui = await checkout(authorize);
    await ui.callbacks.onApprove({ orderID: 'ORDER-1', error: 'PRIVATE-SDK-DATA' });
    const failure = ui.logs.at(-1);
    assert.equal(failure.event, 'authorization_request_failed');
    assert.equal(failure.errorCategory, category);
    assert.equal(failure.httpStatus, status);
    await ui.callbacks.onApprove({ orderID: 'ORDER-1' });
    assert.equal(ui.calls.filter(call => call.url.endsWith('/authorize')).length, 1);
    sanitized(ui.logs);
  });
}

test('Malformed approval IDs are omitted from diagnostics and cannot send authorization', async () => {
  const ui = await checkout(success);
  ui.callbacks.onCancel({ orderID: 'PRIVATE-TOKEN' });
  assert.equal(ui.logs.at(-1).orderId, undefined);
  for (const data of [undefined, { orderID: { secret: 'PRIVATE' } }, { orderID: 'PRIVATE / customer message' }]) ui.callbacks.onApprove(data);
  assert.equal(ui.calls.filter(call => call.url.endsWith('/authorize')).length, 0);
  assert.equal(ui.logs.at(-1).errorCategory, 'INVALID_ORDER_ID');
  sanitized(ui.logs);
});
