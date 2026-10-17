# Request-to-order review: acceptance and verification

## Maintenance verification — 2026-10-16

- Full mocked suite: `npm test` — **107 passed, 0 failed**.
- `npm audit --omit=dev` reported **0 known vulnerabilities**; no dependency versions were changed.
- Fixed an empty-body edge case: when a valid review exists, cancellation/void requests without a JSON body now receive the safe HTTP 409 review rejection instead of a generic HTTP 500. Neither case permits execution without confirmation.
- Added regression assertions for both empty-body mutation routes and a test proving expired reviews and reviews from a previous app instance cannot reach payment methods. This supplements the earlier expiry/restart source inspection below.
- Existing matching, explicit merchant confirmation, source validation, and PayPal checks remain intact. No live AI requests or PayPal operations were performed.
- Local configuration and transaction records remain ignored and are excluded from this maintenance commit.

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

## Manual read-only acceptance checklist (full matching scenarios pending)

The customer-text edit and status wording were manually verified as recorded below; the full matching checklist remains pending.

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

## Customer-text edit invalidation — 2026-10-14

### Verified browser findings

Manual inspection of the existing Chrome tab at `http://127.0.0.1:3000/` reproduced the misleading status without clicking **Analyze request**. Editing customer text displayed **AI analysis ready. Customer claims remain unverified.** The old AI analysis had actually been cleared, the match result was **Not evaluated**, and both merchant confirmations and cancellation/void controls were disabled. The content that remained visible was the separate PayPal snapshot, simulated local facts, and action history; these are independent of customer text.

Read-only retrieval of the running server's HTML and JavaScript confirmed byte-for-byte equality with the files on disk. No stale served files or browser-cache cause was demonstrated. The verified defect was misleading status wording, not retained old analysis.

### Fix and manual verification

- Empty or invalidated analysis now explicitly displays **No current analysis.** in the analysis area and status, with the applicable input/configuration guidance.
- Every customer-text edit clears previous AI claims and the request-to-order match, unchecks both confirmations, and disables cancellation and void. Independent order facts remain visible.
- Existing generation checks continue to ignore stale in-flight success and failure responses.
- After refreshing the actual browser page, entering customer text without analyzing showed **No current analysis. Click Analyze request to analyze the current text.**, an empty-analysis placeholder, and **Not evaluated** for the match. No live analysis or payment action was triggered.

### Automated verification

Five added mocked frontend regressions cover edits to normal, empty, and over-length text, plus stale success and failure responses arriving after an edit without reanalysis. They verify visible analysis/review invalidation, confirmation reset, disabled actions, and absence of extra requests. All five failed against the previous wording and passed after the fix.

Full suite: `npm test` — **106 tests passed, 0 failed**. Local HTTP tests used loopback listeners and mocked external providers. `git diff --check` passed.

Backend review validation and all existing PayPal safeguards were unchanged. No live AI requests or PayPal operations were performed during this validation. Local `.env` and transaction recovery records were preserved and remain excluded from Git. This record contains no customer request logs, raw model output, credentials, or local transaction identifiers.
