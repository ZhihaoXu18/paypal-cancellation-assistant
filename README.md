# Payment Authorization Review Assistant

Help merchants identify cancelled orders whose PayPal authorizations remain active, for merchant review. This scaffold displays one clearly labelled **Mock data** order: CAD 100, **Order cancelled**, **Not shipped**, and **Payment authorized — not captured**.

Verify the order and payment status, then **Void authorization**. **Merchant approval required**. Voiding an authorization does not guarantee immediate release of funds by the buyer's bank. **Refund payment** applies to captured payments and is a future feature; this mock payment has not been captured.

The original example uses Mock data only. A separate CLI checks PayPal Sandbox OAuth connectivity. Sandbox authorization is available in a separate panel. Merchant-confirmed Sandbox void is available for eligible cancelled local orders. No capture, refund, or database is implemented. Customer-request AI analysis is isolated from payment actions and requires a separately configured provider.

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
4. Review the **Void authorization** recommendation and **Merchant approval required** notice. The Mock data panel has no payment action controls and does not execute the recommendation. The separate Sandbox panel supports explicitly confirmed void.
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

There are no capture or refund endpoints or actions. Sandbox void is available only through the separate merchant-confirmed workflow. Authorization may place a hold on Sandbox funds; it does not capture payment. No end-to-end Sandbox success is claimed until the buyer approval and subsequent authorization/status checks have completed.

### Failure handling and storage

Repeated approval callbacks share a pending authorization attempt. Each order has a stable server-generated `PayPal-Request-Id`. Once authorization has been attempted, a failed or uncertain result is never blindly reposted. Refresh checks the order for an existing authorization and then retrieves it directly. If no authorization is found, inspect the Sandbox account before creating another test order. Raw PayPal errors, tokens, credentials, and buyer details are not returned to the browser.

Order IDs, authorization IDs, attempt state, and browser ownership are held in server memory. Restarting the server loses this state; existing orders cannot be reauthorized through this app after a restart. Keep the server running during approval. This is a local development demo, without a database or production login. Merchant cancellation and void attempts are persisted locally as described below. A same-site HttpOnly session cookie scopes transactions to the browser session; cross-origin mutations and non-JSON requests are rejected.

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

Restarting the server loads these operator recovery records without allowing reauthorization. Status lookup is read-only; the explicit merchant workflow can cancel simulated local fulfillment and void an eligible authorization. Use **Load existing order status** with the known order ID to display the actual authorization. Recovered orders cannot be authorized through the browser. Recovery files contain transaction IDs and attempt metadata, not credentials or tokens, and are excluded from Git. This operator recovery lookup is local-demo functionality, not production access control.


## Merchant cancellation and Void authorization

Fulfillment is **simulated local data**: a new or recovered order starts Active and **Not shipped**, independently of PayPal order status. Only **Mark local order cancelled (simulated)** sets the local order to **Order cancelled**; no PayPal mutation is made by cancellation. A cancelled, unshipped order with an authorization in CREATED receives a **Void authorization** recommendation and supporting facts. Capture absence is verified at execution, not assumed from a browser label.

To confirm through the UI:

1. Open the Sandbox panel and use **Load existing order status** with your existing order ID. Do not create a replacement order.
2. Review the actual authorization ID and status, CAD 100.00 amount, and clearly labelled simulated fulfillment state.
3. Click **Mark local order cancelled (simulated)**. PayPal order status remains separate.
4. Review the recommendation and check the explicit merchant approval checkbox.
5. Click **Confirm and void Sandbox authorization** and accept the final confirmation dialog showing both IDs and CAD 100.00. **This final confirmation sends a real Sandbox void request if all backend checks pass.** Dismissing the dialog sends no request.
6. Success requires a subsequent independent PayPal GET confirming authorization status **VOIDED**. Bank funds availability may update later; immediate availability is not guaranteed.

Before a void POST, the backend independently retrieves the current order and authorization. It requires local CANCELLED and NOT_SHIPPED, AUTHORIZE intent, exactly one purchase unit and one matching authorization, CAD 100.00 on both resources, matching related order ID, no capture records or related capture ID, and eligible authorization status. Missing/inconsistent facts, shipped orders, or captured payments stop execution. VOIDED returns an already-voided result without another POST.

Concurrent attempts are blocked. A stable request ID and UNCERTAIN guard are saved before sending a void. A timeout/API error is followed by read-only reconciliation and is not reported as success unless VOIDED is verified. An unconfirmed outcome blocks another POST until **Refresh actual authorization status** successfully rechecks facts. A still-CREATED authorization becomes RETRY_READY; a retry requires a new merchant confirmation and another fresh verification. There is no automatic retry.

Action time, order/authorization IDs, local simulated state, request ID, guard, and sanitized results are saved atomically in ignored `.sandbox-runtime/` JSON files. These records contain no credentials, tokens, headers, or buyer information. If the record cannot be saved, execution stops. On restart, pending UNCERTAIN guards remain blocked until read-only reconciliation. Normal checkout state is in memory until a merchant cancellation/void action persists its record. This remains a single-process local demo; it is not a production multi-worker payment service.

Additional endpoints:

- `POST /api/paypal/orders/:id/cancel`: cancel simulated local fulfillment only.
- `POST /api/paypal/orders/:id/void`: requires JSON `confirmed: true` plus matching `orderId` and `authorizationId`; executes the guarded workflow.

`lib/void-workflow.js` implements verification, confirmation, concurrency guards, reconciliation, and audit events. Mock tests cover eligible, shipped, captured, already-voided, mismatched/missing facts, explicit confirmation, duplicate/concurrent execution, persistence failure, and timeout outcomes. They do not execute a real Sandbox void. Capture and Refund payment remain unimplemented.

Newly created orders initialize the simulated local state explicitly to ACTIVE / NOT_SHIPPED. Repeating local cancellation is idempotent and does not add duplicate cancellation events. The supporting facts show the capture count from the latest verified order/authorization lookup, or clearly state that it is not yet verified. These snapshots are informational: void execution always retrieves and validates fresh facts again.

When the actual authorization status is VOIDED, the UI shows “Authorization already voided”, clears and disables the confirmation checkbox, and disables the execution button. Stale callbacks are blocked in the frontend; the backend independently verifies an already-voided authorization and sends no additional void POST.


## AI-assisted customer request analysis

No existing AI vendor integration was found in the source or dependencies. The implementation now uses a direct **OpenAI Responses API adapter** with strict JSON Schema Structured Outputs. Mocked providers are used only in tests. No paid live AI request has been run or verified. Missing configuration displays **AI not configured**; the application never substitutes mock analysis in the UI.

Use **Customer request** and **Analyze request** without requiring checkout or payment authorization. An optional selected order is context for review only, not automatically bound to the request. Switching orders clears the result; a stale in-flight result cannot be displayed for the new selection. The separate panel is labelled **AI analysis — Unverified customer claims**, independently of verified payment facts and simulated fulfillment.

Endpoints:

- `GET /api/analysis/config`: returns only a configured boolean, never credentials or model settings.
- `POST /api/analysis`: JSON `{ "selectedOrderId": "ORDER-1", "message": "Please cancel order ORDER-1." }` (message length 1–4000).

Validated output includes intent (`cancellation_request`, `refund_request`, `status_question`, `other`, `unclear`), explicitly quoted order references, a verbatim reason if stated, supporting quotes, missing information, clarification questions, and server-generated review flags. The model output must have the exact schema; unsupported fields, invented references, reasons without evidence, non-verbatim quotes, and malformed outputs are rejected. A conservative server extractor adds recognizable references omitted by the model. References it cannot recognize require clarification rather than guessing.

An explicitly labelled reference such as `order TEST-123` establishes the alphabetic prefix for other literal identifiers in the same message, including `Actually, cancel TEST-456 instead.` Both retain source evidence and remain flagged for merchant review; the correction never silently chooses an order. Unrelated numbers, dates, other SKU prefixes, and fabricated references are not accepted. Validation failures expose only fixed rule and field names, never the failing value. HTTP 429 diagnostics expose only allowlisted `error.type` and `error.code` values, without raw provider messages or automatic retries.

The selected order ID is not sent to the provider. Missing references, relative references such as “the second order”, multiple references, or references conflicting with the selection are flagged for merchant review. Customer text is separated from application instructions, treated as untrusted input, and supplied with no tools. Prompt-injection detection is advisory, not a guarantee of correct classification: all AI/customer claims remain unverified and require human review. Crucially, the analysis module has no PayPal client, no state-store access, and no capability to approve cancellation or execute payments. Refund requests are classified only; Refund payment is not implemented.

### Configure OpenAI locally

The gateway requirement has been removed. The backend uses Node.js built-in fetch against the fixed endpoint `https://api.openai.com/v1/responses`; no gateway service or additional package is required.

1. Open your existing root `.env` yourself and add the two entries below. Preserve existing PayPal credentials; do not replace `.env` with the example template.
2. Set `OPENAI_API_KEY` to your OpenAI API project credential and choose a model supported by your project that supports Responses and Structured Outputs. `gpt-4.1-mini` is a documented supported example. There is no hidden model default: missing key or model displays **AI not configured**.
3. Restart `npm run dev` or `npm start` to load the configuration. Changing `.env` alone does not guarantee a running server reloads credentials.
4. Load your existing Sandbox order. Once you are ready to incur an API charge, enter customer text and click **Analyze request**. Loading the page/configuration does not send an OpenAI request.

```dotenv
OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-4.1-mini
```

`.env.example` contains placeholders only; the actual `.env` remains ignored and must never be committed. Do not paste credentials into customer text. Previous `AI_PROVIDER`, `AI_API_URL`, `AI_API_KEY`, and `AI_MODEL` gateway settings are no longer used. Model support does not guarantee account access, available balance, or rate-limit capacity; API errors are sanitized and no automatic retry is sent.

The request uses `text.format` with `type: json_schema`, `strict: true`, all fields required, and `additionalProperties: false` on every object. The schema preserves intent, references, nullable reason evidence, supporting quotes, missing information, and clarification questions. After receiving completed JSON, independent application validation still checks all supporting quotes are exact substrings and order references/reasons have literal evidence. A schema-conforming invented claim is rejected.

Only the customer message is supplied as user input, alongside fixed application instructions and the schema. No selected-order context, PayPal credentials/tokens, payment or fulfillment facts, or buyer account details are included. No tools are configured. Customer text itself is sent as entered, so include only the text needed for analysis. `store: false` disables Responses application-state storage; it is not a promise that all provider-side logging or retention is disabled. See OpenAI's data controls for provider policy.

Refusals, incomplete responses (including token limits or content filtering), failed responses, malformed/missing output, network failures, 20-second timeouts, and API errors are rejected with fixed English messages. Raw errors, refusal text, credentials, and model output are not logged. No partial result or mock fallback is shown as live analysis, and no automatic paid retries occur. Analysis remains read-only and has no PayPal client or order-state mutation capability.

`lib/analysis-provider.js` defines the OpenAI request and strict schema. `lib/request-analysis.js` preserves the application-level evidence validation and review flags. Tests use fake keys and injected mocked API responses, never `.env` or paid requests. The adapter tests verify refusals/incomplete/error handling, credential isolation, model configuration, exact evidence, and no fallback/retry; existing PayPal and read-only analysis tests remain in the suite.

Official documentation checked for this implementation:

- [Structured Outputs in the Responses API](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)
- [GPT-4.1 mini model support](https://developers.openai.com/api/docs/models/gpt-4.1-mini)
- [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)
