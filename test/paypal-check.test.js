const test = require('node:test');
const assert = require('node:assert/strict');
const { checkConnection } = require('../scripts/paypal-check');

const env = { PAYPAL_CLIENT_ID: 'test-client', PAYPAL_CLIENT_SECRET: 'test-secret' };

test('OAuth check uses only the fixed Sandbox URL, disables redirects, and does not return tokens', async () => {
  const result = await checkConnection(env, async (url, options) => {
    assert.equal(url, 'https://api-m.sandbox.paypal.com/v1/oauth2/token');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body, 'grant_type=client_credentials');
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`);
    return { ok: true, json: async () => ({ access_token: 'sensitive-token', token_type: 'Bearer' }) };
  });
  assert.deepEqual(result, { ok: true, message: 'PayPal Sandbox connection successful.' });
});

test('Missing credentials prevent requests', async () => {
  const result = await checkConnection({}, () => assert.fail('No request should be sent'));
  assert.equal(result.ok, false);
});

test('Remote and network errors do not expose sensitive content', async () => {
  const remote = await checkConnection(env, async () => ({
    ok: false, status: 401,
    json: () => assert.fail('Error response bodies must not be read'),
  }));
  assert.equal(remote.ok, false);
  assert.match(remote.message, /HTTP 401/);
  const network = await checkConnection(env, async () => {
    throw new Error('test-secret sensitive-token Authorization');
  });
  assert.equal(network.ok, false);
  assert.doesNotMatch(JSON.stringify([remote, network]), /test-secret|sensitive-token|Authorization/);
});

test('A successful response without access_token is rejected', async () => {
  const result = await checkConnection(env, async () => ({ ok: true, json: async () => ({}) }));
  assert.equal(result.ok, false);
});
