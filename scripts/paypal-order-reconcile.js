// Read-only operator diagnostic. Authorization stays in the session-bound backend.
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const BASE = 'https://api-m.sandbox.paypal.com';
const orderId = process.argv[2];
async function main() {
 if (process.argv.length !== 3 || !/^[A-Za-z0-9-]{1,64}$/.test(orderId || '')) { console.error('Usage: node scripts/paypal-order-reconcile.js ORDER_ID (read-only; authorization is available only through the backend workflow)'); process.exitCode = 1; return; }
 process.loadEnvFile(path.join(ROOT, '.env'));
 const env = process.env;
 const id = env.PAYPAL_SANDBOX_CLIENT_ID || env.PAYPAL_CLIENT_ID;
 const secret = env.PAYPAL_SANDBOX_CLIENT_SECRET || env.PAYPAL_CLIENT_SECRET;
 const response = await fetch(`${BASE}/v1/oauth2/token`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
 if (!response.ok) throw new Error('OAuth failed');
 const token = (await response.json()).access_token;
 const result = await fetch(`${BASE}/v2/checkout/orders/${orderId}`, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token}` } });
 console.log('Order lookup HTTP status:', result.status);
 if (!result.ok) return;
 const data = await result.json();
 console.log(JSON.stringify({ orderId: data.id, intent: data.intent, status: data.status, purchaseUnits: data.purchase_units?.map(unit => ({ amount: unit.amount, authorizations: unit.payments?.authorizations?.map(a => ({ id: a.id, status: a.status, amount: a.amount })) || [], captureCount: unit.payments?.captures?.length || 0 })) }, null, 2));
}
main().catch(() => { console.error('Diagnostic failed; raw error suppressed.'); process.exitCode = 1; });
