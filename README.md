# PayPal Cancellation Assistant

A customer writes, **“Cancel my order only if it hasn’t shipped.”** The merchant has to honor that condition before deciding whether to void an uncaptured PayPal authorization. A store status of “unfulfilled” still leaves a key question open: has the warehouse already handed the parcel to the carrier?

**PayPal Cancellation Assistant** turns the message into a review the merchant can save, reopen, and hand off. AI extracts the order reference and the customer’s condition. The merchant records what was verified and can see how the conclusion changed. Conditional requests stay blocked from payment execution. For a separate eligible request, the merchant can explicitly approve a PayPal Sandbox void after the backend verifies the authorization and checks that no funds were captured.

## Start here for judges

### Quick demo — no credentials

Use **Node.js 20.12.2+**. Copy this block into a terminal:

```sh
# Requires Node.js 20.12.2+
git clone https://github.com/ZhihaoXu18/paypal-cancellation-assistant.git
cd paypal-cancellation-assistant
npm ci
npm run dev
```

Open **<http://127.0.0.1:3000/mock-demo>** directly. No `.env`, AI key, or payment account is required.

1. Click **Load mock example**. The fictional request is `Please cancel order 1001 only if it hasn't shipped yet.`
2. Choose **Unable to confirm**, enter `Mock: waiting for warehouse confirmation.`, and click **Save mock finding**.
3. Under **Reopen the same mock review**, click the record you just saved. Change it to **Condition met**, replace the note with `Mock: warehouse confirmed no carrier handoff.`, and save again.
4. Expand **Previous findings (1)** to see the old conclusion, original note, and timestamp on the same review.

Analysis is preset; notes are fictional evidence. **No external APIs or payment actions run in this demo.** It uses separate cookies and in-memory storage: page refreshes preserve demo records, but a server restart clears them. Existing real review files are untouched. This path demonstrates review and history, not the real integrations.

After updating code or configuration, stop the old server, restart `npm run dev`, and refresh the browser. Old server processes can retain old routes and save behavior.

### Verify the real integration

**[Follow the real OpenAI + PayPal Sandbox verification guide](docs/TESTING.md#real-openai-and-paypal-sandbox-verification).**

You need an OpenAI API key with available quota and access to a model supporting strict structured output, a PayPal Sandbox Business merchant app, a separate Sandbox Personal buyer account, and network access. OpenAI usage may incur charges. Credentials stay in a private local `.env`; never commit them.

The guide covers another eligible CAD 100.00 Sandbox order: buyer approval and authorization, read-only verification of **CREATED** with zero captures, an unconditional request containing the exact PayPal Order ID, separate merchant confirmations for simulated cancellation and void, then independent **VOIDED** confirmation. Sandbox API actions are real test-environment operations. Stop and reconcile read-only if results are uncertain; do not retry blindly.

## Scope and safeguards

Conditional requests cannot execute payment actions, even after a **Condition met** finding. Eligible Sandbox voids require explicit merchant approval and backend checks of the order, authorization, amount, and captures. An order-reference match is not customer authentication. Missing, ambiguous, multiple, or mismatched references require manual resolution; changing the request or selected order clears the review and confirmations.

Shopify snapshots are optional and read-only. They do not prove carrier handoff or link orders to PayPal transactions. Local cancellation and shipment facts are simulated. Capture and refund are not implemented. Voiding does not guarantee immediate bank release of funds.

## Tests and details

```sh
npm test
```

Latest verified local result: **183/183 passed**, November 9, 2026. Tests mock external services; this documentation edit did not rerun them.

See [testing, diagnostics, Shopify setup and both lookup paths, and review storage/history](docs/TESTING.md) for detailed reproduction steps. [Validation notes](docs/VALIDATION.md) preserve prior Sandbox evidence and known issues, with their original verification limits. This is a local Node.js/Express and vanilla JavaScript demo, without production authentication or account-based sharing.

[ISC license](LICENSE)
