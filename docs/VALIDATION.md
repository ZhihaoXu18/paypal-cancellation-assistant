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

## Reproduction checklist — fresh checkout run pending

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

## Still to verify

- A fresh order → buyer approval → automatic frontend authorization request → authorization creation → AI review → cancellation → void run, with evidence at each boundary.
- Root cause of the earlier incomplete approval callback.
- Real fulfillment integration and customer authentication; current fulfillment remains simulated.

This documentation-only update did not rerun the automated suite or issue AI/PayPal requests.
