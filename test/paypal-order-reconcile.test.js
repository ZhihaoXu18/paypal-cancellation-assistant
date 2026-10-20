const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const script = path.resolve(__dirname, '../scripts/paypal-order-reconcile.js');

test('Legacy CLI authorization flag is rejected before reading configuration or sending requests', () => {
  const child = spawnSync(process.execPath, ['-e', `
    process.loadEnvFile = () => { process.exit(98); };
    global.fetch = () => { process.exit(99); };
    process.argv = ['node', ${JSON.stringify(script)}, 'ORDER-1', '--authorize'];
    require(${JSON.stringify(script)});
  `], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /read-only; authorization is available only through the backend workflow/);
});

test('Read-only CLI retrieves existing payment records without a payment POST or raw customer data', () => {
  const child = spawnSync(process.execPath, ['-e', `
    process.loadEnvFile = () => {};
    process.env.PAYPAL_SANDBOX_CLIENT_ID = 'fake-client';
    process.env.PAYPAL_SANDBOX_CLIENT_SECRET = 'fake-secret';
    process.argv = ['node', ${JSON.stringify(script)}, 'ORDER-1'];
    global.fetch = async (url, options) => {
      if (url === 'https://api-m.sandbox.paypal.com/v1/oauth2/token' && options.method === 'POST') {
        return { ok: true, json: async () => ({ access_token: 'fake-private-token' }) };
      }
      if (url !== 'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-1' || options.method) process.exit(99);
      return { ok: true, status: 200, json: async () => ({ id: 'ORDER-1', intent: 'AUTHORIZE', status: 'COMPLETED',
        payer: { name: 'private-customer' }, purchase_units: [{ amount: { currency_code: 'CAD', value: '100.00' },
          payments: { authorizations: [{ id: 'AUTH-1', status: 'CREATED' }], captures: [] } }] }) };
    };
    require(${JSON.stringify(script)});
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.match(child.stdout, /AUTH-1/);
  assert.match(child.stdout, /"captureCount": 0/);
  assert.doesNotMatch(child.stdout + child.stderr, /fake-secret|fake-private-token|private-customer/);
});
