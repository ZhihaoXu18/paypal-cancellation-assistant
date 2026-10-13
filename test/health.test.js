const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const app = require('../app');

test('GET /api/health 返回 HTTP 200 和健康状态', async () => {
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), {
      status: 'ok',
      application: 'paypal-cancellation-assistant',
    });
  } finally {
    if (server.listening) await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});
