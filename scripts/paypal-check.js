const path = require('node:path');

const TOKEN_URL = 'https://api-m.sandbox.paypal.com/v1/oauth2/token';

async function checkConnection(env, request = fetch) {
  const clientId = env.PAYPAL_SANDBOX_CLIENT_ID || env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_SANDBOX_CLIENT_SECRET || env.PAYPAL_CLIENT_SECRET;
  if (!clientId?.trim() || !clientSecret?.trim()) {
    return { ok: false, message: 'Connection failed: Sandbox Client ID or Client Secret is missing.' };
  }

  try {
    const response = await request(TOKEN_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    // Never log remote response bodies, headers, credentials or tokens.
    if (!response.ok) {
      const hint = response.status === 401 ? 'Check the Sandbox credentials.' : 'Try again later or check the Sandbox service status.';
      return { ok: false, message: `Connection failed: PayPal Sandbox returned HTTP ${response.status}. ${hint}` };
    }
    const data = await response.json();
    if (typeof data.access_token !== 'string' || !data.access_token || data.token_type?.toLowerCase() !== 'bearer') {
      return { ok: false, message: 'Connection failed: Unexpected Sandbox OAuth response format.' };
    }
    return { ok: true, message: 'PayPal Sandbox connection successful.' };
  } catch (error) {
    // Use fixed messages, never error.message/stack (which may contain secrets).
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return { ok: false, message: 'Connection failed: Sandbox request timed out.' };
    }
    return { ok: false, message: 'Connection failed: Sandbox network, TLS, or response parsing error.' };
  }
}

async function main() {
  try {
    process.loadEnvFile(path.join(__dirname, '..', '.env'));
  } catch {
    console.error('Connection failed: Unable to load .env configuration from the project root.');
    process.exitCode = 1;
    return;
  }
  const result = await checkConnection(process.env);
  (result.ok ? console.log : console.error)(result.message);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(() => {
    console.error('Connection failed: Configuration or connection check error.');
    process.exitCode = 1;
  });
}

module.exports = { checkConnection };
