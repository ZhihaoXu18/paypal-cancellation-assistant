# Payment Authorization Review Assistant

Help merchants identify cancelled orders whose PayPal authorizations remain active, for merchant review. This scaffold displays one clearly labelled **Mock data** order: CAD 100, **Order cancelled**, **Not shipped**, and **Payment authorized — not captured**.

Verify the order and payment status, then **Void authorization**. **Merchant approval required**. Voiding an authorization does not guarantee immediate release of funds by the buyer's bank. **Refund payment** applies to captured payments and is a future feature; this mock payment has not been captured.

The page uses Mock data only. A separate CLI checks PayPal Sandbox OAuth connectivity. Sandbox authorization is available in a separate panel. No capture, refund, void, database, or AI is implemented.

## Requirements and installation

Use Node.js 20.12.2 or later and npm. Express 5 requires Node.js 18 or later; this project has been verified with Node.js 20.12.2.

Run in the project directory:

```sh
npm install
```

Use `npm ci` for reproducible installation from the lockfile. The mock page works without `.env`. Server startup and `paypal:check` load it on the backend without modifying it. Sandbox Checkout requires Sandbox credentials.

## Start and access

Development mode (automatically restarts when server files change):

```sh
npm run dev
```

Standard mode:

```sh
npm start
```

Run one mode at a time. Both listen only on `127.0.0.1:3000`. Open <http://127.0.0.1:3000> and press Ctrl+C to stop the server. Node.js 20.12.2 may display an experimental watch mode warning; startup still works.

Health endpoint: `GET http://127.0.0.1:3000/api/health`

```json
{"status":"ok","application":"paypal-cancellation-assistant"}
```

## Demo walkthrough

1. Start the server and open the local page.
2. Confirm the **Mock data** badge on order `DEMO-1001`.
3. Review CAD 100, **Order cancelled**, **Not shipped**, and **Payment authorized — not captured**. The mock authorization remains active.
4. Review the **Void authorization** recommendation and **Merchant approval required** notice. The page has no payment action controls and does not execute the recommendation.
5. Application status indicates local health endpoint connectivity, not PayPal connectivity.

## PayPal Sandbox connection check

Configure `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in the project root `.env` yourself. `PAYPAL_SANDBOX_CLIENT_ID` and `PAYPAL_SANDBOX_CLIENT_SECRET` are also supported and take precedence. Use Sandbox credentials; never add credentials to source code or Git. Configuration uses Node.js 20.12.2's built-in `process.loadEnvFile`, without additional dependencies.

```sh
npm run paypal:check
```

This command only sends an OAuth `client_credentials` request to `https://api-m.sandbox.paypal.com/v1/oauth2/token`, disables redirects, and times out after 15 seconds. Success prints “PayPal Sandbox connection successful.” Failure prints a fixed message and, when available, an HTTP status, with exit code 1. It never prints secrets, tokens, request headers, or raw errors. It does not persist tokens, create orders, or perform payments. Other configured API URLs cannot override the fixed Sandbox URL.

## Tests

```sh
npm test
```

Tests use Node.js's built-in test runner. The health test starts a local server on a random port, verifies HTTP status, JSON content type, and response body, then closes it. OAuth tests use mock credentials and responses to verify the fixed Sandbox endpoint, disabled redirects, token validation, and safe errors. They do not load `.env` or call PayPal.

## File structure

```text
app.js                     Express application, health endpoint, and static files
server.js                  Startup entry point with fixed local address and port
public/index.html          Mock data order and review recommendation
public/styles.css          Page styles
public/app.js              Frontend application health check
scripts/paypal-check.js    Backend Sandbox OAuth connection check
test/health.test.js        Health endpoint test
test/paypal-check.test.js  Mock OAuth connection check tests
package.json               Dependencies and startup/test/connection check commands
package-lock.json          Locked dependency versions
.gitignore                 Excludes node_modules, .env, .env.*, and .DS_Store
```

## Sandbox Checkout: authorize CAD 100.00

The separate **Sandbox transaction** panel uses PayPal Checkout, not Mock data. The backend fixes the order amount at CAD 100.00 and intent at `AUTHORIZE`. The JavaScript SDK uses `currency=CAD` and `intent=authorize`; it receives only the public Client ID. Secret and OAuth access tokens remain on the backend and are never logged.

1. Configure Sandbox credentials in your existing root `.env`, then start with `npm run dev` or `npm start`. Startup loads configuration without printing it.
2. Open <http://127.0.0.1:3000> and locate the Sandbox transaction panel, separate from the cancelled Mock data order.
3. Click PayPal. The server creates a CAD 100.00 order. **At this point you must sign in with your Sandbox Personal buyer account and approve checkout yourself.** Do not use a live account or the merchant Sandbox Business account.
4. After buyer approval, the backend authorizes the order and retrieves actual authorization status. Check the displayed PayPal order ID, authorization ID, and authorization status. An order status of `COMPLETED` does not mean a payment was captured; authorization status is displayed separately.
5. Use **Refresh actual authorization status** for read-only reconciliation. Buyer cancellation does not cancel the merchant order. Creating an order also does not mark it cancelled.

This milestone contains no capture, refund, or void endpoints or actions. Authorization may place a hold on Sandbox funds; it does not capture payment. No end-to-end Sandbox success is claimed until the buyer approval and subsequent authorization/status checks have completed.

### Failure handling and storage

Repeated approval callbacks share a pending authorization attempt. Each order has a stable server-generated `PayPal-Request-Id`. Once authorization has been attempted, a failed or uncertain result is never blindly reposted. Refresh checks the order for an existing authorization and then retrieves it directly. If no authorization is found, inspect the Sandbox account before creating another test order. Raw PayPal errors, tokens, credentials, and buyer details are not returned to the browser.

Order IDs, authorization IDs, attempt state, and browser ownership are held in server memory. Restarting the server loses this state; existing orders cannot be reauthorized through this app after a restart. Keep the server running during approval. This is a local development demo, without a database, production login, or durable reconciliation. A same-site HttpOnly session cookie scopes transactions to the browser session; cross-origin mutations and non-JSON requests are rejected.

Endpoints:

- `GET /api/paypal/config`: public Client ID and fixed SDK settings.
- `POST /api/paypal/orders`: create the fixed Sandbox order; browser amounts are ignored.
- `POST /api/paypal/orders/:id/authorize`: authorize a known session-owned order once.
- `GET /api/paypal/orders/:id`: retrieve actual order and authorization status.

`lib/paypal.js` implements Sandbox requests and memory storage. `test/paypal-orders.test.js` mocks OAuth and PayPal API responses to check fixed amounts, authorization deduplication, failure reconciliation, actual status retrieval, session ownership, safe errors, and the absence of capture/refund/void calls. Tests never load `.env` or call PayPal.

## Diagnose an existing approved order

The frontend sends buyer approval to the backend authorize endpoint; server logs record receipt and only sanitized errors. API error details are reduced to allowlisted PayPal issue codes. Refresh is read-only and does not retry authorization.

For an operator-controlled reconciliation of a known Sandbox order:

```sh
node scripts/paypal-order-reconcile.js ORDER_ID
```

This loads backend configuration without printing credentials and queries actual order details. If there is no authorization or capture, and the order is APPROVED with AUTHORIZE intent and exactly CAD 100.00, an operator may explicitly run:

```sh
node scripts/paypal-order-reconcile.js ORDER_ID --authorize
```

The command rechecks eligibility immediately before a single authorization attempt, uses a stable request ID, and writes an exclusive attempt guard under ignored `.sandbox-runtime/`. It never blindly retries an existing attempt, creates replacement orders, or captures payments. Raw errors are suppressed. Successful authorization IDs are stored before querying actual authorization status. If a request outcome is uncertain, run the read-only command only.

Restarting the server loads these operator recovery records as read-only. Use **Load existing order status** with the known order ID to display the actual authorization. Recovered orders cannot be authorized through the browser. Recovery files contain transaction IDs and attempt metadata, not credentials or tokens, and are excluded from Git. This operator recovery lookup is local-demo functionality, not production access control.
