# Validation notes

## Latest checks

- 2026-10-16: **107/107 tests passed** using mocked AI/PayPal responses and local HTTP servers. `npm audit --omit=dev`: **0 known vulnerabilities**.
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

## Still to verify

Full manual acceptance of customer message → matching → merchant cancellation review remains pending. Automated coverage and successful Sandbox authorization alone do not prove the entire flow works end to end.
