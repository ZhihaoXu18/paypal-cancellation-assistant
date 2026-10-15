# Request-to-order review: acceptance and verification

## Automated verification

Source commit inspected: b1bac4901adde8f92b4fc1606dbdbd6f6eca09d4
("Add backend request matching and guarded merchant review").

Run independently on October 14, 2026 (America/Toronto), using Node.js v24.19.0:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

Result: **101 tests, 101 passed, 0 failed, 0 skipped**.
Tests use mocked AI and PayPal responses and local HTTP servers. No real credentials,
paid model requests, or PayPal mutations were used in this verification.

## Acceptance criteria and evidence

| Criterion | Expected behavior | Automated evidence |
| --- | --- | --- |
| One exact matching reference and cancellation intent | Enables manual cancellation review; does not approve it | test/request-review.test.js; test/checkout-ui.test.js |
| Mismatched, missing, relative, multiple references, or no selected order | Blocks review; requires manual resolution | test/request-review.test.js |
| Refund request or status question with matching reference | Cannot execute cancellation or void | test/request-review.test.js; test/checkout-ui.test.js |
| Separate evidence sources | UI distinguishes customer claims, backend match, PayPal snapshot, simulated fulfillment | test/checkout-ui.test.js |
| Changed text or selected order | Clears review and both confirmations | test/checkout-ui.test.js |
| Late model response | Cannot overwrite current UI review; older server analysis is superseded | test/checkout-ui.test.js; test/request-review.test.js |
| Missing, forged, altered, cross-session or superseded review | Mutation routes reject with HTTP 409 before calling payment methods | test/request-review.test.js |
| Exact source evidence | Invented references and non-verbatim evidence rejected | test/request-analysis.test.js; test/openai-adapter.test.js |
| Existing payment safeguards | Reject shipped/captured/mismatched facts; prevent duplicate/concurrent void; reconcile uncertainty | test/void-workflow.test.js; test/paypal-orders.test.js |

The backend issues review IDs bound to the session, selected order and SHA-256 digest
of the unchanged message. Source inspection confirms a 15-minute expiry check and
in-memory storage only. Expiry and restart behavior have not received a dedicated
automated test in this run. Customer identity remains a merchant responsibility.

## Manual read-only acceptance (pending for this matching milestone)

Use an existing order that the local application can load. Do not create another
transaction just to test matching. Each Analyze click can incur an AI charge.

1. Load the existing order using **Load existing order status**. Inspect actual
   PayPal data and the separate simulated fulfillment labels.
2. Submit `Please cancel order <EXACT_SELECTED_ORDER_ID>.`
   Expect one matching reference and eligibility for manual review only.
3. Do not check cancellation/void approval or execute either action.
4. Edit the customer text. Expect review and confirmations to clear immediately.
5. Analyze a different explicit order reference. Expect a mismatch and blocked review.
6. Analyze `Cancel the second order.` Expect ambiguity/missing-reference resolution.
7. Analyze two references. Expect multiple-reference review; no automatic selection.
8. Analyze a refund-status question with the matching ID. Expect cancellation blocked.
9. An already-VOIDED authorization must remain disabled throughout.

Capture screenshots of the review result and disabled controls, with no credentials.
Do not treat the earlier AI-only smoke tests or earlier Sandbox void as live proof
that this newly integrated matching milestone has passed manual acceptance.

## Publication checks

- Root LICENSE contains ISC terms, matching package.json's existing license.
- README contains clone/install/test/start/configuration steps and limitations.
- Repository visibility must be checked separately in GitHub Settings.
- Before publication, inspect Git history as well as the latest tree for secrets.
  Ignore rules alone do not prove that no secrets were ever committed.
