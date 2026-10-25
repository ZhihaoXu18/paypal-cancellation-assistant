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

## Current scope

Built with Node.js, Express, vanilla JavaScript, OpenAI Responses API, and PayPal Sandbox.

This is a local demo. Cancellation and shipment states are simulated; there is no ecommerce integration, database, or production authentication. An order-number match does not verify customer identity. Capture and refund are not implemented. Voiding an authorization does not guarantee immediate release of funds by the buyer's bank.

## Tests

```sh
npm test
```

Tests mock external services and cover order-reference matching, stale analysis, session-bound reviews, checkout diagnostics, explicit merchant confirmation, and authorization/void duplicate guards. The latest local run on October 24, 2026 passed all 116 tests.

Manual Sandbox evidence and known issues are in [validation notes](docs/VALIDATION.md).

[ISC license](LICENSE)
