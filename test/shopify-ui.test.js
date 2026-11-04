const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const id = 'gid://shopify/Order/18973739417770';
function ui(fetchResponse) {
  const nodes = new Map(), calls = [];
  const node = () => ({ value: '', textContent: '', children: [], handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; }, replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); } });
  const context = vm.createContext({ URLSearchParams, Error, currentSandbox: { orderId: 'PAYPAL-1', shipmentStatus: 'NOT_SHIPPED' }, requestReview: { canReviewCancellation: false },
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node },
    fetch: async (...args) => { calls.push(args); return fetchResponse(...args); },
  });
  vm.runInContext(fs.readFileSync('public/shopify.js', 'utf8'), context);
  nodes.get('shopify-order-id').value = id;
  return { nodes, calls, context };
}
const visible = node => [node.textContent, ...node.children.map(visible)].join(' ');
test('Shopify UI queries only on click, renders minimal snapshot, and leaves PayPal selection and eligibility alone', async () => {
  const view = ui(async () => ({ ok: true, json: async () => ({ source: 'Shopify development store', orderId: id, orderNumber: '#1001', paymentStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED', queriedAt: '2026-11-03T12:00:00.000Z' }) }));
  assert.equal(view.calls.length, 0);
  await view.nodes.get('lookup-shopify').handlers.click();
  assert.equal(view.calls.length, 1);
  assert.equal(view.calls[0][0], '/api/shopify/order?' + new URLSearchParams({ id }));
  assert.match(visible(view.nodes.get('shopify-details')), /Shopify development store.*#1001.*PAID.*UNFULFILLED.*2026-11-03/);
  assert.match(view.nodes.get('shopify-status').textContent, /does not grant cancellation or void eligibility/);
  assert.equal(vm.runInContext('currentSandbox.orderId', view.context), 'PAYPAL-1');
  assert.equal(vm.runInContext('requestReview.canReviewCancellation', view.context), false);
  view.nodes.get('shopify-order-id').handlers.input();
  assert.equal(view.nodes.get('shopify-details').children.length, 0);
});
test('Shopify UI clears previous facts on errors and restores controls, never inferring unshipped', async () => {
  let fails = false;
  const view = ui(async () => ({ ok: !fails, json: async () => fails ? { error: 'Shopify access denied.' } : { orderId: id, fulfillmentStatus: 'UNFULFILLED' } }));
  await view.nodes.get('lookup-shopify').handlers.click();
  fails = true;
  await view.nodes.get('lookup-shopify').handlers.click();
  assert.equal(view.nodes.get('shopify-details').children.length, 0);
  assert.match(view.nodes.get('shopify-status').textContent, /access denied/);
  assert.equal(view.nodes.get('lookup-shopify').disabled, false);
  assert.equal(view.nodes.get('shopify-order-id').disabled, false);
  view.nodes.get('shopify-order-id').value = 'bad';
  await view.nodes.get('lookup-shopify').handlers.click();
  assert.equal(view.calls.length, 2);
  assert.match(view.nodes.get('shopify-status').textContent, /valid Shopify Order GID/);
});
test('Shopify UI suppresses duplicate clicks and stale lookup responses', async () => {
  let release;
  const view = ui(async () => { await new Promise(resolve => { release = resolve; }); return { ok: true, json: async () => ({ orderId: id }) }; });
  const pending = view.nodes.get('lookup-shopify').handlers.click();
  await view.nodes.get('lookup-shopify').handlers.click();
  assert.equal(view.calls.length, 1);
  view.nodes.get('shopify-order-id').value = 'gid://shopify/Order/2';
  view.nodes.get('shopify-order-id').handlers.input();
  release(); await pending;
  assert.equal(view.nodes.get('shopify-details').children.length, 0);
});
