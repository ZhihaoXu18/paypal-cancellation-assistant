# PayPal Cancellation Assistant

A merchant tool for reviewing cancellation requests when a PayPal payment has been authorized but not captured.

It reads the customer's message, checks whether the order reference matches the selected order, and helps the merchant review whether the authorization can be voided. The merchant makes the decision; AI does not approve cancellations or execute payments.

## Start here for judges

### Quick demo — no credentials

With Node.js 20.12.2+, run `npm ci` and `npm run dev` from the project directory, then open <http://127.0.0.1:3000/mock-demo>. No `.env` is required.

1. Click **Load mock example** to load `Please cancel order 1001 only if it hasn't shipped yet.`
2. Choose **Unable to confirm**, enter a fictional note such as `Mock: waiting for warehouse confirmation.`, and click **Save mock finding**.
3. Click the saved review under **Reopen the same mock review**. Change the finding to **Condition met**, enter `Mock: warehouse confirmed no carrier handoff.`, and save.
4. Expand **Previous findings (1)** to see the earlier conclusion, note, and timestamp on the same review.

This path uses preset analysis and calls no external API. Findings cannot enable payment operations. Demo records survive page refreshes but are cleared when the server restarts.

### Verify the real integration

Test access required: an OpenAI API key with available quota and access to a model supporting the adapter's strict structured output; a PayPal Sandbox Business merchant app and a separate Sandbox Personal buyer account; and network access to both services. Put `OPENAI_API_KEY`, `OPENAI_MODEL`, `PAYPAL_SANDBOX_CLIENT_ID`, and `PAYPAL_SANDBOX_CLIENT_SECRET` in your private local `.env`. Do not commit credentials. Restart the server after configuration or code changes, refresh the browser, and open <http://127.0.0.1:3000/>. OpenAI analysis may incur charges; PayPal actions below are real Sandbox API operations.

1. Use **another eligible Sandbox order**, not an already-voided order from the validation notes. For a fresh checkout, click PayPal once to create the app's CAD 100.00 `AUTHORIZE` order and approve it with the test buyer. Keep the same browser session and server running; the approval callback requests authorization.
2. Click **Refresh actual authorization status**. Require an Authorization ID, status **CREATED**, CAD 100.00, and capture count **0**. If authorization is missing or its outcome is uncertain, inspect the sanitized callback diagnostics and reconcile using read-only refresh; do not blindly retry authorization.
3. Paste `Please cancel order <the displayed PayPal Order ID> because I placed it by mistake.` Replace the placeholder with that exact ID, then click **Analyze request**. Require validated `cancellation_request` analysis with exactly one matching reference and backend eligibility for merchant review. This invokes OpenAI; matching does not authenticate the customer or approve cancellation.
4. For the operator-controlled test order, independently verify authority, check the cancellation confirmation, and click **Confirm local cancellation (simulated)**. Require local **CANCELLED** and simulated shipment **NOT_SHIPPED**.
5. Separately check the void confirmation, click **Confirm and void Sandbox authorization**, and approve the dialog for the displayed order and authorization. The backend rechecks ownership, amount, captures, and authorization eligibility before sending the void.
6. Require **VOIDED_CONFIRMED_BY_GET** in action history, then use **Refresh actual authorization status** to confirm authorization **VOIDED**, capture count **0**, and void execution state **CONFIRMED**. If uncertain, stop further mutations and reconcile read-only.

The [recorded Sandbox run](docs/VALIDATION.md#fresh-order-sandbox-e2e-run--2026-10-20-americatoronto) documents a prior operator-reported success, not a guarantee for a new run. Conditional requests remain blocked from execution even after a **Condition met** finding. Shopify access is optional for this path: its read-only snapshots neither trigger void nor establish shipment or a Shopify-to-PayPal transaction link. Local cancellation and shipment facts remain simulated; capture and refund are unavailable.

## How it works

1. Load a Sandbox order and its payment status.
2. Paste the customer's request. AI extracts intent and quoted order references.
3. The backend checks the references against the selected order. Missing, ambiguous, or conflicting references require clarification.
4. The merchant reviews the customer claims, PayPal facts, and local order state separately.
5. After explicit approval, the backend rechecks payment eligibility before voiding the authorization.

Changing the message or selected order clears the review and confirmations. Refreshing the same order preserves the review while updating payment facts. If an authorization or void result is uncertain, refresh actual status before considering another action.

## Run locally

Requires Node.js 20.12.2+.

```sh
git clone https://github.com/ZhihaoXu18/paypal-cancellation-assistant.git
cd paypal-cancellation-assistant
npm ci
npm run dev
```

Open <http://127.0.0.1:3000>.

### Mock demo (no `.env` required)

Start with `npm ci` and `npm run dev`, then open <http://127.0.0.1:3000/mock-demo> directly, or choose **Open Mock demo** on the home page.

1. Click **Load mock example**. The fixed fictional request is `Please cancel order 1001 only if it hasn't shipped yet.` Analysis is predefined, not generated by AI.
2. Choose **Unable to confirm**, enter a fictional evidence note such as `Mock: waiting for warehouse confirmation.`, then click **Save mock finding**.
3. Under **Reopen the same mock review**, click that saved review.
4. Choose **Condition met**, replace the note with `Mock: warehouse confirmed no carrier handoff.`, and save again.
5. Expand **Previous findings (1)** to see **Unable to confirm**, its original note, and timestamp.

The demo reuses the normal review forms, validation, save/reopen routes and finding history. It uses separate cookies and in-memory storage: page refreshes preserve the demo reviews, but a server restart clears them. It never reads or writes existing saved review files, calls AI/Shopify/PayPal, or enables payment operations. Notes are fictional evidence, not verified shipment facts.

**After updating code, stop the old server, restart `npm run dev`, and refresh the browser.** An already-running backend may otherwise keep the old save behavior. Restarting clears mock reviews; real saved reviews remain in their existing local files.

### Real integrations

For integrations, add the variables from [`.env.example`](.env.example) to your local `.env`:

- `PAYPAL_SANDBOX_CLIENT_ID` and `PAYPAL_SANDBOX_CLIENT_SECRET`
- `OPENAI_API_KEY` and `OPENAI_MODEL`

Use PayPal Sandbox accounts. Keep credentials out of Git and restart the server after configuration changes. The normal integration page can make real API requests and AI analysis may incur charges. The separate Mock demo works without credentials and never falls back to a real integration.

## Sandbox diagnostics

Check the configured merchant credentials and Sandbox connection:

```sh
npm run paypal:check
```

For a read-only lookup of an existing order:

```sh
node scripts/paypal-order-reconcile.js ORDER_ID
```

Both commands read the project-root `.env`. The lookup does not submit an authorization, capture, or void. Browser console diagnostics also report checkout callbacks, duplicate approvals, and authorization request outcomes without logging credentials or raw SDK payloads.

## Shopify development-store lookup (read-only)

Add `SHOPIFY_SHOP` (the full `your-store.myshopify.com` domain), `SHOPIFY_CLIENT_ID`, and `SHOPIFY_CLIENT_SECRET` to the existing local `.env`, then restart the server. Never put credential values in `.env.example`.

This integration uses Shopify's [client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant) for a Dev Dashboard app installed on a development store in the **same Shopify organization**. Grant `read_orders` in the app configuration and approve/install the app version. Older orders may require approved `read_all_orders` access; a missing or inaccessible order is an error, not an unfulfilled order. Apps for other merchants require a different authentication flow.

The page's separate Shopify panel starts with test order `gid://shopify/Order/18973739417770`. It sends no request on page load. After explicitly approving a real read-only lookup, click **Query Shopify order (read-only)**. The backend uses GraphQL Admin API `2026-10` and requests only `id`, `name`, `displayFinancialStatus`, and `displayFulfillmentStatus`; it returns those fields with the server query time and source label. Configure only a development store: the source label describes the configured environment and is not an independent verification of the store's plan.

Tokens are kept in server memory, reused until shortly before expiry, and never returned to the browser or persisted. Authentication, permission, unknown-status, API, and timeout errors do not infer a shipment state. No Shopify mutation is implemented.

An HTTP 200 GraphQL response can still contain `errors`. The adapter rejects partial data and reports fixed diagnostics: `GRAPHQL_ERRORS`, `ORDER_NULL`, `FIELD_MISSING`, `UNSUPPORTED_STATUS`, or `ORDER_ID_MISMATCH` (with fixed schema field names). `PROTECTED_DATA_ACCESS_DENIED` means the app must resolve its [protected-data access configuration](https://shopify.dev/docs/apps/launch/protected-customer-data) for the order resource; `read_orders` alone does not establish that this access is available. No customer name, email, address, or additional customer field is requested to diagnose this error. Unknown states remain blocked.

This snapshot does not change selected PayPal orders, simulated local fulfillment, analysis, merchant approvals, or conditional-request blocking. `UNFULFILLED` alone cannot authorize cancellation or void. There is no transaction mapping between Shopify test-gateway orders and PayPal authorizations.

## Current scope

Built with Node.js, Express, vanilla JavaScript, OpenAI Responses API, and PayPal Sandbox.

This is a local demo. Cancellation and shipment states are simulated; Shopify provides a separate read-only snapshot, with no fulfillment writes, order-to-PayPal mapping, database, or production authentication. An order-number match does not verify customer identity. Capture and refund are not implemented. Voiding an authorization does not guarantee immediate release of funds by the buyer's bank.

## Tests

```sh
npm test
```

Tests mock external services and cover order-reference matching, stale analysis, session-bound reviews, checkout diagnostics, explicit merchant confirmation, authorization/void duplicate guards, and the isolated Mock demo save/reopen/history flow. The latest local run on November 9, 2026 passed **183/183 tests**.

Manual Sandbox evidence and known issues are in [validation notes](docs/VALIDATION.md).

[ISC license](LICENSE)

### Recording a conditional cancellation finding

Analyze a conditional cancellation request to open the merchant finding form. Compare the original request with independent evidence, then save whether the condition was met, was not met, or could not be confirmed. Include a brief evidence note without customer or payment details. For shipment questions, verify handoff with the warehouse or carrier; a Shopify `UNFULFILLED` snapshot does not establish whether handoff took place.

The saved review stores the optional merchant label, condition summary and support ticket ID, latest finding, evidence note, and timestamp in the local ignored `.condition-cases/` directory. The original customer request is not stored. Reopen a saved review in the same browser after a refresh or server restart; clearing cookies loses access. This is a local, single-browser workflow, without account-based sharing. The review shows up to 25 previous findings with evidence and timestamps; editing only the context does not create a finding revision. Earlier findings overwritten before this feature cannot be recovered. A saved review does not link Shopify to PayPal or enable cancellation or void.

### Shopify evidence on a saved review

On the merchant page, reopen a saved conditional review. In **Shopify order on this review**, enter the verified Shopify order GID (for the development test order, `gid://shopify/Order/18973739417770`), check the confirmation box, then choose **Query Shopify and save snapshot**. This requires the configured Shopify development-store credentials and performs a read-only lookup. Reopen the review to see the last saved order, payment status, fulfillment status, and query time. A failed lookup leaves the previous snapshot intact. The snapshot does not change the merchant finding, verify carrier handoff, or link the order to a PayPal transaction. This control is for the merchant page; the mock demo remains offline.
