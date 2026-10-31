# Validation notes

## Latest checks

- 2026-10-19: **110/110 tests passed** after consolidating frontend state/rendering and removing the legacy CLI authorization path. All external calls were mocked. Dependency audit earlier that day: **0 known vulnerabilities**; dependencies unchanged.
- Coverage includes exact order matching, conflicting/missing references, source evidence, expired/session-bound reviews, stale responses, merchant confirmation, and payment eligibility/duplicate guards.
- Browser check: editing customer text clears analysis, matching, and confirmations. Independent order facts stay visible. After the wording fix, the status explicitly shows **No current analysis**.
- Sandbox checkout: one existing APPROVED order was authorized once after verifying no authorization/capture existed and the running backend's attempt guard was false. Independent GET requests confirmed authorization **CREATED**, CAD 100.00, and no captures. This does not establish full end-to-end matching/cancellation acceptance.

## Issues and fixes

| Area | Finding | Result |
| --- | --- | --- |
| Order-reference extraction | A correction's second reference was rejected without another `order` label. | Fixed; source-grounded references with the established prefix are recognized. Multiple references still require review. |
| Edit status wording | Old analysis cleared correctly, but the status said “AI analysis ready.” | Fixed and browser-verified. Five new regressions passed; suite reached 106/106. Served files matched disk; no cache cause was demonstrated. |
| Empty mutation request | With a valid review, a missing JSON body returned 500. | Fixed to reject safely with 409. Expiry/restart tests added; suite reached 107/107. |
| Sandbox approval callback | Buyer approval was recorded, but the running backend had not recorded an authorization attempt. | Controlled authorization succeeded. Why the original callback did not complete remains unresolved. |


## Manual Sandbox run — 2026-10-20 America/Toronto

Evidence source: operator-provided application output and action history in the guided session. These PayPal results were not independently queried by the documentation editor. The local running commit was not captured.

### Scope and identifiers

This run started by loading an existing authorization; it did not create a fresh order or demonstrate the original buyer-approval callback.

- PayPal order: `7YU618817T770264R`
- PayPal authorization: `1W790692U76974226`
- Amount: CAD 100.00
- Initial read-only lookup: order COMPLETED, authorization CREATED, capture count 0, local order ACTIVE, simulated shipment NOT_SHIPPED, void not attempted.
- Customer test message: "Please cancel order 7YU618817T770264R because I placed it by mistake."
- AI result: cancellation_request with the literal order reference and source evidence; no review flags.
- Backend match: one literal reference matched the manually selected order; eligible for manual cancellation review only.
- Payment snapshot shown during review: `2026-10-21T01:19:51.771Z`.

### Execution evidence

Timestamps below are UTC; they occurred on October 20 in America/Toronto.

| UTC timestamp | Action | Result |
| --- | --- | --- |
| 2026-10-21T01:28:05.936Z | MERCHANT_CANCEL_SIMULATED_ORDER | CANCELLED |
| 2026-10-21T01:28:44.311Z | MERCHANT_CONFIRMED_VOID | REQUEST_PREPARED |
| 2026-10-21T01:28:46.362Z | VOID_RESULT | VOIDED_CONFIRMED_BY_GET |

A subsequent operator-triggered **Refresh actual authorization status** returned:
- Order status: COMPLETED
- Authorization status: **VOIDED**
- Capture count (last verified): **0**
- Void execution state: **CONFIRMED**
- Local order: Order cancelled
- Simulated shipment: Not shipped

The subsequent refresh timestamp was not supplied. No capture or refund was performed in this documented workflow.

### What this verifies and does not verify

Verified from the supplied run output: existing authorization lookup → AI request analysis → backend literal matching → explicit merchant local cancellation → explicit merchant Sandbox void → independent GET confirmation → subsequent read-only refresh.

Local cancellation and shipment are simulated, not real warehouse evidence. Reference matching is not customer authentication. No production customer identity system or real fulfillment integration was tested. Bank funds availability was not verified. The original approval callback failure remains unresolved; this run does not establish its cause or fix.

## Reproduction checklist — fresh checkout

Use the setup instructions in README, configured Sandbox merchant credentials, a Sandbox Personal buyer account, and the configured AI provider. Never place secrets or raw authenticated network exports in this document.

1. Record the running commit and start time. Keep the server running throughout checkout.
2. Before checkout, open browser developer tools. Enable Preserve log in Network and Console; filter Network to Fetch/XHR. Observe only sanitized method/path/status/error information.
3. Click the PayPal button once to create a new CAD 100.00 Sandbox order. Record the new Order ID and approve with the Sandbox Personal buyer.
4. After approval, inspect the app's authorization request: `POST /api/paypal/orders/<orderId>/authorize`. Record whether it appeared, its HTTP status, and the displayed application result. An absent browser request is different from a backend rejection or an upstream PayPal failure.
5. Use read-only status refresh to confirm the new Authorization ID, authorization CREATED, amount CAD 100.00, and capture count 0. Do not blindly resubmit authorization after an error or timeout. Reconcile first.
6. Analyze "Please cancel order <newOrderId> because I placed it by mistake." Confirm one literal matching reference and manual-review eligibility.
7. For the operator-controlled test buyer and order, explicitly approve local simulated cancellation. Confirm local CANCELLED while treating shipment data as simulated.
8. Separately approve Sandbox void for the displayed authorization and accept its confirmation dialog once. If the outcome is uncertain, stop mutation attempts and reconcile with read-only queries.
9. Require VOIDED_CONFIRMED_BY_GET in action history; refresh actual status and record VOIDED, capture count 0, and CONFIRMED.
10. Append the actual new IDs, timestamps, sanitized callback/request observations, and final results. Do not mark this fresh-order checklist passed until those observations exist.

If checkout stalls, preserve the new Order ID and report the last observed boundary: buyer approval, frontend callback status, browser authorization request, backend reception/validation, or upstream call/result. A later successful run alone does not explain the earlier failure.

## Fresh-order Sandbox E2E run — 2026-10-20 America/Toronto

**Result: the fresh-order happy path passed in the operator's local environment**, based on application output, sanitized browser diagnostics, and action history supplied during the guided run. The documentation editor did not independently call PayPal. Exact local revision and initial order-creation timestamp were not supplied.

### Diagnostics and preceding unsuccessful attempt

Earlier order `3PA11474RK403143L` showed a cancellation callback message after the popup closed automatically, while a read-only refresh returned APPROVED without an authorization ID. The operator reported no `authorize` request in the preserved browser Network record. Callback root cause remains unknown.

The operator then reported local diagnostic changes: callback-entry events, deduplication outcomes, authorization-request events, and safe cancellation wording that requests read-only reconciliation instead of asserting buyer cancellation or absence of authorization. Six regression tests were added; **116/116 tests passed**, with syntax and patch checks passing (operator report, not rerun by the documentation editor). The three changed files were `public/app.js`, `test/checkout-diagnostics.test.js`, and `test/checkout-ui.test.js`; the operator reported no commit or push. A later successful run does not prove the diagnostic changes fixed the earlier fault.

### New order and authorization evidence

- Order ID: `6G61143682239935K`
- Authorization ID: `54G35585498219717`
- Amount: CAD 100.00
- New checkout was followed by automatic authorization through the frontend callback; no manual supplemental authorization was used in this run.

| UTC timestamp | Browser event | Result |
| --- | --- | --- |
| 2026-10-21T02:19:21.475Z | onApprove_enter | Order 6G61143682239935K |
| 2026-10-21T02:19:21.476Z | approval_deduplication | deduplicationHit: false |
| 2026-10-21T02:19:21.476Z | authorization_post_sending | Order 6G61143682239935K |
| 2026-10-21T02:19:24.898Z | authorization_request_succeeded | HTTP 200 |

A subsequent read-only refresh showed order COMPLETED, authorization CREATED, CAD 100.00, capture count 0, local ACTIVE, simulated NOT_SHIPPED, and void not attempted. The payment snapshot displayed during review was `2026-10-21T02:20:04.022Z`. HTTP 200 alone was not used as authorization evidence.

### AI review and merchant execution

Test message: "Please cancel order 6G61143682239935K because I placed it by mistake."

AI returned cancellation_request, the exact reference with quote "order 6G61143682239935K", and the stated reason. No review flags, missing information, or clarification questions were reported. Backend matching confirmed one literal reference matched the selected order and allowed manual cancellation review only.

| UTC timestamp | Action | Result |
| --- | --- | --- |
| 2026-10-21T02:24:35.229Z | MERCHANT_CANCEL_SIMULATED_ORDER | CANCELLED |
| 2026-10-21T02:25:17.565Z | MERCHANT_CONFIRMED_VOID | REQUEST_PREPARED |
| 2026-10-21T02:25:20.198Z | VOID_RESULT | VOIDED_CONFIRMED_BY_GET |

A further operator-triggered read-only refresh confirmed:

| Field | Final value |
| --- | --- |
| PayPal order | 6G61143682239935K |
| PayPal order status | COMPLETED |
| Authorization | 54G35585498219717 |
| Authorization status | **VOIDED** |
| Amount | CAD 100.00 |
| Capture count (last verified) | **0** |
| Void execution state | **CONFIRMED** |
| Local order state (simulated) | Order cancelled |
| Shipment state (simulated) | Not shipped |

Final refresh timestamp was not supplied. All listed UTC events occurred on October 20 in America/Toronto.

### Acceptance boundaries

This run covers fresh checkout → buyer approval callback → automatic authorization request → read-only authorization confirmation → AI analysis → backend matching → merchant-approved simulated cancellation → merchant-approved Sandbox void → independent GET confirmation → final read-only refresh.

It establishes one successful local Sandbox happy path, not general checkout reliability or resolution of the preceding callback fault. Local cancellation and fulfillment remain simulated. Customer authority was a test-operator assertion, not a production authentication integration. No capture, refund, real warehouse cancellation, or bank-funds release timing was validated.

## Still to verify

- Commit and preserve the locally tested checkout diagnostics code, then record the exact running revision for reproducibility. The operator reported these changes were uncommitted; this documentation commit does not include them.
- Root cause of the earlier incomplete approval callback.
- Real fulfillment integration and customer authentication; current fulfillment remains simulated.

This documentation-only update did not rerun the automated suite or issue AI/PayPal requests.

## Conditional cancellation and order-reference coverage — 2026-10-31 America/Toronto

This entry records the conditional-request fix already committed as `b3348d2`, the subsequent `ordered` extraction fix, and the verification below. Earlier entries describe their own historical runs; this entry does not repeat those payment operations.

### Conditional cancellation

The original analysis placed "only if it has not shipped" in the stated reason instead of preserving the customer's prerequisite and alternative instruction separately. The analysis schema, prompt, strict validator, and display now separate:

- Cancellation reason, or null when no reason is stated.
- Cancellation conditions, each with literal text and a verbatim source quote.
- Requirements when conditions are not met, each with literal text and a verbatim source quote.

For "Please cancel order TEST-123 only if it has not shipped. If it has already shipped, keep the order.", the expected reason is null, the condition is "only if it has not shipped", and the alternative requirement is to keep the order if already shipped. Evidence must be present verbatim in the original message; invented evidence and unsupported schema fields are rejected.

Conditional requests are available for human inspection only. Backend review eligibility blocks both cancellation and void, even with merchant confirmation. A conservative conditional-language check also blocks recognized conditional phrasing when the model omits condition fields; it does not evaluate whether conditions are satisfied.

### Order-reference extraction

The reported input was "I ordered TEST-123 by mistake. Please cancel it unless it has already shipped; in that case, leave it alone." It produced `validation.rule=explicit_reference, field=orderReferences.reference`, whereas changing the opening to "I placed order TEST-123 by mistake." allowed analysis to succeed.

Before changing code, local mocked-model and independent extraction checks reproduced the difference: the extractor recognized the `order` label but not the verb `ordered`. The minimal fix recognizes a complete alphabetic-prefix identifier after `ordered`, retaining literal source evidence. Bare quantities, numbers, dates, SKU-labelled products, partial identifiers, and fabricated references remain excluded in regression tests. Model-provided references still undergo the existing strict validation.

The user reports that the original `ordered TEST-123` sentence also succeeded in the page retest after the fix, with output matching expectations.

### Evidence sources and limits

- The page retest output supplied/reported by the user came from actual AI calls. This is user-provided evidence; the documentation editor did not independently repeat those calls. The precise running revision and page-retest timestamps were not supplied.
- Automated tests use mocked AI and PayPal responses. The previous reported result was 138/138 passing; the complete suite was rerun for this update using `npm test`: **138 tests passed, 0 failed, 0 skipped** on October 31, 2026 (America/Toronto).
- Page blocking text alone does not prove the backend cannot be bypassed. Separate local HTTP regression tests submit merchant confirmation and forged eligibility for a conditional request, require HTTP 409 for both cancel and void, and verify zero calls to the mocked payment methods. This is automated regression evidence, not a production security audit.
- Shipment status remains local simulated data. Customer statements about shipment are unverified claims. No condition is automatically evaluated for satisfaction.
- Existing PayPal guards, merchant approval requirements, and stale-analysis invalidation remain covered by the full suite. No PayPal operation was performed in this round, and no new real AI or PayPal request was sent while preparing this update.
- Coverage remains conservative and does not establish support for every natural-language expression or guarantee error-free model extraction.

### Change review

The reviewed changes for this update are limited to the extractor, its regression tests, and this validation record. `git diff --check` passed. No `.env`, credentials, local transaction records, or customer logs are included in the change set; the examples above use synthetic identifiers.
