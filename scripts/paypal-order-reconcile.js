const path = require('node:path');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');
const BASE = 'https://api-m.sandbox.paypal.com';
const orderId = process.argv[2];
async function main() {
 if (!/^[A-Za-z0-9-]{1,64}$/.test(orderId || '')) { console.error('Usage: node scripts/paypal-order-reconcile.js ORDER_ID [--authorize]'); process.exitCode = 1; return; }
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
 if (process.argv.includes('--authorize')) {
  const unit = data.purchase_units?.[0];
  if (data.intent !== 'AUTHORIZE' || data.status !== 'APPROVED' || data.purchase_units?.length !== 1 || unit.amount?.currency_code !== 'CAD' || unit.amount?.value !== '100.00' || unit.payments?.authorizations?.length || unit.payments?.captures?.length) {
   console.log('Authorization skipped: order is not eligible or already has a payment record.'); return;
  }
  const requestId = createHash('sha256').update('sandbox-recovery-authorize:' + orderId).digest('hex').slice(0, 32);
  const guardFile = path.join(ROOT, '.sandbox-runtime', orderId + '.json');
  fs.mkdirSync(path.dirname(guardFile), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(guardFile, JSON.stringify({ orderId, requestId, attempted: true }), { flag: 'wx', mode: 0o600 }); }
  catch { console.log('Authorization skipped: recovery has already been attempted.'); return; }
  const authorized = await fetch(`${BASE}/v2/checkout/orders/${orderId}/authorize`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', 'PayPal-Request-Id': requestId }, body: '{}' });
  const outcome = await authorized.json();
  const knownIssues = new Set(['ORDER_ALREADY_AUTHORIZED','ORDER_NOT_APPROVED','ORDER_EXPIRED','INSTRUMENT_DECLINED','PAYER_CANNOT_PAY','PAYEE_ACCOUNT_RESTRICTED','CURRENCY_NOT_SUPPORTED','AUTHORIZATION_ERROR','TRANSACTION_REFUSED','PERMISSION_DENIED','VALIDATION_ERROR','INTERNAL_SERVER_ERROR']);
  if (!authorized.ok) {
   console.log(JSON.stringify({ authorizationHttpStatus: authorized.status, issues: outcome.details?.map(d => knownIssues.has(d.issue) ? d.issue : 'OTHER_PAYPAL_ISSUE') || [] }));
   return;
  }
  const authorizationId = outcome.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;
  if (!/^[A-Z0-9]{1,64}$/.test(authorizationId || '')) throw new Error('Missing authorization');
  fs.writeFileSync(guardFile, JSON.stringify({ orderId, requestId, attempted: true, authorizationId }), { mode: 0o600 });
  const actual = await fetch(`${BASE}/v2/payments/authorizations/${authorizationId}`, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token}` } });
  if (!actual.ok) { console.log('Authorization status lookup HTTP:', actual.status); return; }
  const detail = await actual.json();
  console.log(JSON.stringify({ authorizationHttpStatus: authorized.status, authorizationId: detail.id, authorizationStatus: detail.status, amount: detail.amount }, null, 2));
 }
}
main().catch(() => { console.error('Diagnostic failed; raw error suppressed.'); process.exitCode = 1; });
