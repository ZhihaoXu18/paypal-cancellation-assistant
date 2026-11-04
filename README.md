# PayPal Cancellation Assistant

A merchant tool for reviewing cancellation requests when a PayPal payment has been authorized but not captured.

It reads the customer's message, checks whether the order reference matches the selected order, and helps the merchant review whether the authorization can be voided. The merchant makes the decision; AI does not approve cancellations or execute payments.

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

For integrations, add the variables from [`.env.example`](.env.example) to your local `.env`:

- `PAYPAL_SANDBOX_CLIENT_ID` and `PAYPAL_SANDBOX_CLIENT_SECRET`
- `OPENAI_API_KEY` and `OPENAI_MODEL`

Use PayPal Sandbox accounts. Keep credentials out of Git and restart the server after configuration changes. AI analysis uses the OpenAI API and may incur charges. Without configuration, only the static mock example is available.

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

This snapshot does not change selected PayPal orders, simulated local fulfillment, analysis, merchant approvals, or conditional-request blocking. `UNFULFILLED` alone cannot authorize cancellation or void. There is no transaction mapping between Shopify test-gateway orders and PayPal authorizations.

## Current scope

Built with Node.js, Express, vanilla JavaScript, OpenAI Responses API, and PayPal Sandbox.

This is a local demo. Cancellation and shipment states are simulated; Shopify provides a separate read-only snapshot, with no fulfillment writes, order-to-PayPal mapping, database, or production authentication. An order-number match does not verify customer identity. Capture and refund are not implemented. Voiding an authorization does not guarantee immediate release of funds by the buyer's bank.

## Tests

```sh
npm test
```

Tests mock external services and cover order-reference matching, stale analysis, session-bound reviews, checkout diagnostics, explicit merchant confirmation, and authorization/void duplicate guards. The latest local run on October 24, 2026 passed all 116 tests.

Manual Sandbox evidence and known issues are in [validation notes](docs/VALIDATION.md).

[ISC license](LICENSE)
