const mockDemo = document.documentElement?.dataset.mockDemo === 'true';
const apiPath = path => mockDemo ? '/demo' + path : path;
async function checkHealth() {
  const indicator = document.getElementById('health');
  try {
    const response = await fetch(apiPath('/api/health'));
    if (!response.ok) throw new Error('Health check failed');
    const health = await response.json();
    indicator.textContent = health.status === 'ok' ? 'Application status: Healthy' : 'Application status: Unhealthy';
  } catch {
    indicator.textContent = 'Application status: Connection failed. Check the local server.';
  }
}

checkHealth();

let currentSandbox;
let merchantBusy = false;
let requestReview;
function currentCancellationReview() {
  return !!requestReview && requestReview.message === document.getElementById('customer-request').value &&
    requestReview.selectedOrderId === currentSandbox?.orderId && requestReview.review.canReviewCancellation === true;
}
const sandboxStatus = document.getElementById('sandbox-status');
const refreshButton = document.getElementById('refresh-sandbox');
const approvals = new Map();
function checkoutDiagnostic(event, orderId, details = {}) {
  const record = { time: new Date().toISOString(), event };
  // Only retain IDs belonging to the displayed order; never spread SDK data/errors.
  if (typeof orderId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(orderId) && orderId === currentSandbox?.orderId) record.orderId = orderId;
  if (typeof details.deduplicationHit === 'boolean') record.deduplicationHit = details.deduplicationHit;
  if (Number.isInteger(details.httpStatus) && details.httpStatus >= 100 && details.httpStatus <= 599) record.httpStatus = details.httpStatus;
  if (['HTTP_ERROR', 'NETWORK_ERROR', 'REQUEST_TIMEOUT', 'RESPONSE_UNREADABLE', 'INVALID_ORDER_ID', 'SDK_ERROR', 'UNKNOWN_ERROR'].includes(details.errorCategory)) record.errorCategory = details.errorCategory;
  try { console.info(record); } catch { /* Diagnostics must not affect checkout. */ }
}
document.getElementById('lookup-sandbox').addEventListener('click', async () => {
  if (merchantBusy) return;
  const id = document.getElementById('existing-order-id').value.trim();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) { sandboxStatus.textContent = 'Enter a valid Sandbox order ID.'; return; }
  try {
    displaySandbox(await sandboxRequest(`/api/paypal/orders/${encodeURIComponent(id)}`));
    sandboxStatus.textContent = 'Actual Sandbox status retrieved using read-only requests. No authorization was submitted.';
  } catch (error) { sandboxStatus.textContent = error.message; }
});
async function sandboxRequest(url, method = 'GET', body = {}, onResponse) {
  const response = await fetch(apiPath(url), { method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (onResponse) onResponse(response.status);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Sandbox request failed.');
  return data;
}
function displaySandbox(data) {
  const orderChanged = currentSandbox?.orderId !== data.orderId;
  currentSandbox = data;
  if (orderChanged) invalidateRequestReview();
  else { updateMerchantControls(); renderRequestReview(); }
  document.getElementById('analysis-order').textContent = `Selected order: ${data.orderId}. This association does not establish which order the customer means.`;
  updateAnalysisControls();
  const details = document.getElementById('sandbox-details');
  details.replaceChildren();
  for (const [label, value] of [
    ['PayPal order ID', data.orderId], ['Order status (PayPal)', data.orderStatus],
    ['Amount', `${data.currency} ${data.amount}`], ['Authorization ID', data.authorizationId || 'Not available'],
    ['Authorization status (PayPal)', data.authorizationStatus || 'Not yet retrieved'],
    ['Local order state (simulated)', data.localOrderStatus === 'CANCELLED' ? 'Order cancelled' : 'Active'],
    ['Shipment state (simulated)', data.shipmentStatus === 'NOT_SHIPPED' ? 'Not shipped' : 'Unknown or shipped'],
    ['Capture count (last verified)', data.paymentFacts ? String(data.paymentFacts.captureCount) : 'Not yet verified for void'],
    ['Void execution state', data.voidState || 'Not attempted'],
  ]) {
    const row = document.createElement('div');
    const term = document.createElement('dt'); term.textContent = label;
    const description = document.createElement('dd'); description.textContent = value;
    row.append(term, description); details.append(row);
  }
}
refreshButton.addEventListener('click', async () => {
  if (merchantBusy || !currentSandbox) return;
  refreshButton.disabled = true;
  sandboxStatus.textContent = 'Retrieving actual Sandbox status…';
  try {
    const data = await sandboxRequest(`/api/paypal/orders/${encodeURIComponent(currentSandbox.orderId)}`);
    displaySandbox(data);
    sandboxStatus.textContent = 'Actual status retrieved from PayPal Sandbox. No payment was captured by this application.';
  } catch (error) { sandboxStatus.textContent = error.message; }
  finally { refreshButton.disabled = merchantBusy || !currentSandbox; }
});
async function loadSandboxCheckout() {
  try {
    const config = await sandboxRequest('/api/paypal/config');
    const sdk = document.createElement('script');
    sdk.src = `https://www.paypal.com/sdk/js?${new URLSearchParams({ 'client-id': config.clientId, currency: 'CAD', intent: 'authorize', components: 'buttons', 'enable-funding': 'paypal' })}`;
    await new Promise((resolve, reject) => {
      sdk.onload = resolve; sdk.onerror = () => reject(new Error('Unable to load the PayPal Checkout SDK.'));
      document.head.append(sdk);
    });
    await paypal.Buttons({
      fundingSource: paypal.FUNDING.PAYPAL,
      createOrder: async () => {
        if (merchantBusy) throw new Error('A merchant operation is in progress.');
        sandboxStatus.textContent = 'Creating a CAD 100.00 Sandbox order…';
        const data = await sandboxRequest('/api/paypal/orders', 'POST');
        displaySandbox(data);
        sandboxStatus.textContent = 'Order created. Approve using your Sandbox Personal account.';
        return data.orderId;
      },
      onApprove: (data) => {
        const orderId = data?.orderID;
        checkoutDiagnostic('onApprove_enter', orderId);
        const deduplicationHit = approvals.has(orderId);
        checkoutDiagnostic('approval_deduplication', orderId, { deduplicationHit });
        if (deduplicationHit) return approvals.get(orderId);
        if (typeof orderId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(orderId)) {
          checkoutDiagnostic('authorization_request_failed', undefined, { errorCategory: 'INVALID_ORDER_ID' });
          sandboxStatus.textContent = 'Checkout approval callback has no valid order ID. Refresh actual status; no authorization was submitted by this callback.';
          return;
        }
        const pending = (async () => {
          let httpStatus;
          let requestSucceeded = false;
          sandboxStatus.textContent = 'Buyer approved. Authorizing on the server; no capture will be performed…';
          try {
            checkoutDiagnostic('authorization_post_sending', orderId);
            const result = await sandboxRequest(`/api/paypal/orders/${encodeURIComponent(orderId)}/authorize`, 'POST', {}, status => { httpStatus = status; });
            requestSucceeded = true;
            checkoutDiagnostic('authorization_request_succeeded', orderId, { httpStatus });
            displaySandbox(result);
            sandboxStatus.textContent = result.authorizationStatus === 'CREATED'
              ? 'Payment authorized — not captured. Actual authorization status: CREATED.'
              : 'Actual authorization status retrieved from PayPal Sandbox. No capture was requested by this application.';
          } catch (error) {
            if (!requestSucceeded) {
              const errorCategory = httpStatus >= 400 ? 'HTTP_ERROR'
                : error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'REQUEST_TIMEOUT'
                : error?.name === 'SyntaxError' ? 'RESPONSE_UNREADABLE'
                : error?.name === 'TypeError' ? 'NETWORK_ERROR' : 'UNKNOWN_ERROR';
              checkoutDiagnostic('authorization_request_failed', orderId, { httpStatus, errorCategory });
            }
            sandboxStatus.textContent = `${error.message} Authorization will not be retried automatically. Use Refresh actual authorization status to reconcile.`;
          }
        })();
        approvals.set(orderId, pending);
        return pending;
      },
      onCancel: (data) => {
        checkoutDiagnostic('onCancel_enter', data?.orderID || currentSandbox?.orderId);
        sandboxStatus.textContent = 'Checkout cancellation callback received. Use Refresh actual authorization status (read-only) to confirm the actual order and authorization state.';
      },
      onError: () => {
        checkoutDiagnostic('onError_enter', currentSandbox?.orderId, { errorCategory: 'SDK_ERROR' });
        sandboxStatus.textContent = 'Sandbox checkout failed. If approval was already submitted, refresh actual status before taking further action. No automatic authorization retry.';
      },
    }).render('#paypal-buttons');
    sandboxStatus.textContent = 'Ready. Click PayPal and approve with your Sandbox Personal account.';
  } catch { sandboxStatus.textContent = 'Sandbox checkout is unavailable. Check backend configuration, network connectivity, and PayPal Sandbox availability.'; }
}
if (!mockDemo) loadSandboxCheckout();

function updateMerchantControls() {
  const data = currentSandbox;
  const panel = document.getElementById('merchant-workflow');
  panel.hidden = !data;
  if (!data) return;
  updateAnalysisControls(false);
  refreshButton.disabled = merchantBusy;
  document.getElementById('lookup-sandbox').disabled = merchantBusy;
  const alreadyVoided = data.authorizationStatus === 'VOIDED';
  const confirmation = document.getElementById('confirm-void');
  confirmation.disabled = merchantBusy || !currentCancellationReview() || alreadyVoided || data.voidState === 'CONFIRMED';
  if (alreadyVoided || data.voidState === 'CONFIRMED') confirmation.checked = false;
  const eligible = data.localOrderStatus === 'CANCELLED' && data.shipmentStatus === 'NOT_SHIPPED' && data.authorizationStatus === 'CREATED';
  document.getElementById('confirm-cancellation').disabled = merchantBusy || !currentCancellationReview();
  document.getElementById('cancel-local-order').disabled = merchantBusy || data.localOrderStatus === 'CANCELLED' || !currentCancellationReview() || !document.getElementById('confirm-cancellation').checked;
  document.getElementById('void-recommendation').textContent = data.authorizationStatus === 'VOIDED'
    ? 'Authorization already voided. Bank funds availability may update later.'
    : !currentCancellationReview()
      ? requestReview?.review?.blockingReason || 'Cancellation and void review blocked: analyze a cancellation request with exactly one reference matching the selected order. Resolve references manually. Matching is not customer authentication or merchant approval.'
    : eligible
      ? `Recommendation: Void authorization. Supporting facts: local Order cancelled; simulated Not shipped; PayPal authorization CREATED for CAD 100.00. ${data.paymentFacts ? `Last verified capture count: ${data.paymentFacts.captureCount}.` : 'Capture count has not yet been verified.'} Backend must verify ownership, amount, and no captures again before execution. Merchant approval required.`
      : 'Void is blocked until the local order is cancelled, not shipped, and the authorization is eligible.';
  document.getElementById('void-authorization').disabled = merchantBusy || !currentCancellationReview() || !eligible || data.voidState === 'UNCERTAIN' || data.voidState === 'CONFIRMED' || !document.getElementById('confirm-void').checked;
  const history = document.getElementById('action-history');
  history.replaceChildren();
  for (const event of data.audit || []) {
    const item = document.createElement('li'); item.textContent = `${event.time}: ${event.action} — ${event.result}`; history.append(item);
  }
}
function clearMerchantConfirmations() {
  for (const id of ['confirm-cancellation', 'confirm-void']) {
    document.getElementById(id).checked = false;
  }
}
document.getElementById('confirm-void').addEventListener('change', updateMerchantControls);
document.getElementById('confirm-cancellation').addEventListener('change', updateMerchantControls);
document.getElementById('cancel-local-order').addEventListener('click', async () => {
  if (!currentSandbox || merchantBusy || !currentCancellationReview() || !document.getElementById('confirm-cancellation').checked || document.getElementById('cancel-local-order').disabled) return;
  const id = currentSandbox.orderId;
  const review = requestReview;
  merchantBusy = true; updateMerchantControls();
  try {
    displaySandbox(await sandboxRequest(`/api/paypal/orders/${encodeURIComponent(id)}/cancel`, 'POST', { reviewId: review.review.reviewId, message: review.message, confirmed: true }));
    clearMerchantConfirmations();
    sandboxStatus.textContent = 'Local order marked cancelled (simulated). PayPal order status was not changed. No void was executed.';
  } catch (error) { sandboxStatus.textContent = error.message; }
  finally { merchantBusy = false; updateMerchantControls(); }
});
document.getElementById('void-authorization').addEventListener('click', async () => {
  const data = currentSandbox;
  if (!data || merchantBusy || !currentCancellationReview() || data.authorizationStatus === 'VOIDED' || data.voidState === 'CONFIRMED' || document.getElementById('void-authorization').disabled || !document.getElementById('confirm-void').checked) return;
  if (!window.confirm(`Void Sandbox authorization ${data.authorizationId} for order ${data.orderId}, CAD 100.00? This is a real Sandbox API action. Bank funds availability may update later.`)) return;
  merchantBusy = true; updateMerchantControls();
  document.getElementById('confirm-void').checked = false;
  sandboxStatus.textContent = 'Verifying current facts and requesting Sandbox void…';
  try {
    const result = await sandboxRequest(`/api/paypal/orders/${encodeURIComponent(data.orderId)}/void`, 'POST', { confirmed: true, orderId: data.orderId, authorizationId: data.authorizationId, reviewId: requestReview.review.reviewId, message: requestReview.message });
    displaySandbox(result);
    sandboxStatus.textContent = result.message;
  } catch (error) {
    sandboxStatus.textContent = `${error.message} No success is assumed. Refresh actual authorization status before any further confirmation.`;
    // Block another click even if the error prevented the updated record reaching the browser.
    currentSandbox.voidState = 'UNCERTAIN';
  } finally { merchantBusy = false; updateMerchantControls(); }
});

let aiConfigured = false;
let analysisConfigState = 'loading';
let analysisBusy = false;
function analysisUnavailableReason() {
  if (merchantBusy) return 'A merchant operation is in progress. Please wait.';
  if (analysisConfigState === 'loading') return 'Checking AI configuration…';
  if (analysisConfigState === 'failed') return 'AI configuration unavailable. Reload the page to retry.';
  if (!aiConfigured) return 'AI not configured. Configure the server AI provider and restart the server.';
  if (analysisBusy) return 'Analysis is in progress. Please wait.';
  const message = document.getElementById('customer-request').value || '';
  if (!message.trim()) return 'Enter a customer request to enable analysis.';
  if (message.length > 4000) return 'Customer request must be 1–4000 characters.';
  return '';
}
function updateAnalysisControls(showStatus = true) {
  const reason = analysisUnavailableReason();
  const button = document.getElementById('analyze-request');
  button.disabled = !!reason;
  button.title = reason;
  document.getElementById('customer-request').disabled = merchantBusy;
  if (showStatus) document.getElementById('analysis-status').textContent = requestReview
    ? reason || (mockDemo ? 'Mock analysis loaded. No AI request was sent.' : 'AI analysis complete. Unverified customer claims; merchant review required.')
    : `No current analysis. ${reason || 'Click Analyze request to analyze the current text.'}`;
}
document.getElementById('customer-request').addEventListener('input', () => { invalidateRequestReview(); updateAnalysisControls(); });
let analysisGeneration = 0;
function invalidateRequestReview() {
  analysisGeneration++;
  requestReview = undefined;
  analysisBusy = false;
  const empty = document.createElement('p'); empty.textContent = 'No current analysis.';
  document.getElementById('request-analysis').replaceChildren();
  document.getElementById('request-analysis').append(empty);
  clearMerchantConfirmations();
  renderRequestReview();
  updateMerchantControls();
}
function renderRequestReview() {
  const panel = document.getElementById('request-review');
  panel.replaceChildren();
  const data = currentSandbox;
  const analysis = requestReview?.analysis;
  const match = requestReview?.review;
  const statusText = {
    matched: 'One literal reference matches the selected order.',
    mismatched: 'The reference differs from the selected order. Resolve manually and analyze again.',
    missing_reference: 'No explicit order reference. Obtain the exact order ID and analyze again.',
    ambiguous_reference: 'Relative order reference is ambiguous. Obtain an explicit ID and analyze again.',
    multiple_references: 'Multiple references, including corrections, require manual resolution. No order was selected automatically.',
    no_selected_order: 'Select and load an order manually, then analyze again.',
  };
  appendListSections(panel, [
    ['Unverified customer intent and claims', analysis ? [analysis.intent, analysis.reason?.text || 'No stated reason', ...analysis.orderReferences.map(item => `${item.reference} — quote: ${item.quote}`)] : ['No current analysis. Analyze the current customer text.']],
    ['Order-reference match result (backend)', [statusText[match?.status] || 'Not evaluated.', ...(match?.blockingReason ? [match.blockingReason] : []), 'A match is not customer authentication or approval to cancel.', match?.canReviewCancellation ? 'Eligible for manual merchant cancellation review only.' : 'Cancellation review blocked. Refunds and status questions cannot execute cancellation.']],
    ['Verified PayPal facts (last retrieved snapshot)', data ? [`Order: ${data.orderId}`, `Order status: ${data.orderStatus || 'Not retrieved'}`, `Authorization: ${data.authorizationId || 'Not retrieved'}`, `Authorization status: ${data.authorizationStatus || 'Not retrieved'}`, `Amount: ${data.currency || 'Unknown'} ${data.amount || 'Unknown'}`, `Capture count: ${data.paymentFacts?.captureCount ?? 'Not verified'}`, `Verified at: ${data.paymentFacts?.verifiedAt || 'No void-eligibility verification yet'}`] : ['No selected order facts. Load an order using read-only lookup.']],
    ['Simulated local cancellation and shipment facts', data ? [`Cancellation: ${data.localOrderStatus || 'Unknown'}`, `Shipment: ${data.shipmentStatus || 'Unknown'} (simulated local data; customer claims are not verified shipment facts)`] : ['No local order selected.']],
  ]);
  if (analysis?.intent === 'cancellation_request' && match?.blockingReason && match.reviewId) {
    renderConditionFinding(panel, requestReview);
  }
}
function renderConditionFinding(panel, review, reopened = false) {
  const record = reopened ? review : review.savedCase;
  const finding = record?.finding;
  const outcomes = {
    unknown: ['Unable to confirm', 'Keep pending. Obtain independent evidence before deciding.'],
    not_met: ['Condition not met', 'Close this review without cancelling under the customer’s condition.'],
    met: ['Condition met', 'Ready for further manual review. Verify order identity and authority separately.'],
  };
  appendListSections(panel, [
    ...(reopened ? [[record.subject, [mockDemo ? 'Refer to the fixed fictional request above. Demo findings are not real evidence.' : 'Use the original request in your support system when checking the customer’s condition.']]] : [
    ['Original customer request', [review.message]],
    ['What to verify', [
      ...(review.analysis.cancellationConditions || []).map(item => item.quote),
      'Review every condition in the original request. For shipping, confirm carrier handoff with the warehouse or carrier. Shopify UNFULFILLED alone is not proof of no handoff.',
      'A Shopify lookup is separate from this request and does not link a PayPal transaction.',
    ]],
    ]),
    ...(record ? [['Review context', [
      record.conditionSummary ? `Condition to verify: ${record.conditionSummary}` : 'No condition summary recorded.',
      record.supportTicket ? `Support ticket: ${record.supportTicket}` : 'No support ticket recorded.',
    ]]] : []),
    ['Merchant finding', finding
      ? [outcomes[finding.outcome][0], finding.evidence, `Recorded at (UTC): ${finding.recordedAt}`, outcomes[finding.outcome][1]]
      : ['Pending verification. No merchant finding has been recorded.']],
  ]);
  if (record) {
    const history = record.priorFindings || [];
    const details = document.createElement('details');
    const heading = document.createElement('summary');
    heading.textContent = `Previous findings (${history.length})`;
    details.append(heading);
    if (history.length) {
      const list = document.createElement('ul');
      for (const entry of history) {
        const item = document.createElement('li');
        item.textContent = `${entry.recordedAt} — ${outcomes[entry.outcome][0]} — ${entry.evidence}`;
        list.append(item);
      }
      details.append(list);
    } else {
      const empty = document.createElement('p');
      empty.textContent = 'No earlier findings recorded. Changes made before this feature cannot be recovered.';
      details.append(empty);
    }
    panel.append(details);
  }
  const form = document.createElement('form');
  const choice = document.createElement('select');
  choice.required = true;
  for (const [value, label] of [['', 'Choose a finding'], ...Object.entries(outcomes).map(([key, [name]]) => [key, name])]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; choice.append(option);
  }
  const note = document.createElement('textarea');
  note.required = true; note.maxLength = 500; note.rows = 2;
  const addLabel = (label, input) => {
    const wrapper = document.createElement('label'); wrapper.textContent = label; wrapper.append(input); form.append(wrapper);
  };
  const subject = document.createElement('input');
  subject.type = 'text'; subject.maxLength = 120; subject.value = record?.subject || (mockDemo ? 'Mock demo — Order 1001' : '');
  if (!record) addLabel('Review label (optional; no customer details)', subject);
  if (finding) { choice.value = finding.outcome; note.value = finding.evidence; }
  const summary = document.createElement('textarea');
  summary.rows = 2; summary.maxLength = 240; summary.value = record?.conditionSummary || '';
  summary.placeholder = 'e.g. Cancel only if the order has not shipped';
  const ticket = document.createElement('input');
  ticket.type = 'text'; ticket.maxLength = 64; ticket.value = record?.supportTicket || '';
  ticket.placeholder = 'e.g. CS-1042';
  addLabel('Condition to verify (optional; summarize without customer details)', summary);
  addLabel('Support ticket ID (optional; ID only)', ticket);
  addLabel('Verification result', choice);
  addLabel('Evidence note (avoid customer or payment details)', note);
  const button = document.createElement('button'); button.type = 'submit'; button.textContent = mockDemo ? 'Save mock finding' : 'Save review finding';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  status.textContent = mockDemo ? 'Mock reviews stay in memory until server restart. No finding can enable payment operations.' : 'Saved reviews stay available in this browser. A finding does not enable cancellation or void.';
  form.append(button, status);
  panel.append(form);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled || (!reopened && requestReview !== review)) return;
    button.disabled = true;
    const payload = { outcome: choice.value, evidence: note.value, version: record?.version,
      conditionSummary: summary.value, supportTicket: ticket.value };
    try {
      const result = reopened
        ? await sandboxRequest(`/api/analysis/condition-cases/${encodeURIComponent(record.id)}`, 'POST', payload)
        : await sandboxRequest('/api/analysis/condition-review', 'POST', {
          ...payload, reviewId: review.review.reviewId, message: review.message, ...(!record ? { subject: subject.value } : {}),
        });
      if (reopened && panel.contains(form)) {
        panel.replaceChildren();
        renderConditionFinding(panel, result.case, true);
      } else if (!reopened && requestReview === review) {
        review.savedCase = result.case;
        renderRequestReview();
      }
      void loadConditionCases();
    } catch (error) {
      status.textContent = error.message;
    } finally { button.disabled = false; }
  });
}
let caseListGeneration = 0;
let caseDetailGeneration = 0;
async function loadConditionCases() {
  const list = document.getElementById('condition-cases-list');
  if (!list) return;
  const status = document.getElementById('condition-cases-status');
  const detail = document.getElementById('condition-case-detail');
  const generation = ++caseListGeneration;
  try {
    const result = await sandboxRequest('/api/analysis/condition-cases');
    if (generation !== caseListGeneration) return;
    list.replaceChildren();
    status.textContent = result.cases.length ? '' : 'No saved conditional reviews in this browser.';
    for (const record of result.cases) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      const label = { unknown: 'Pending verification', met: 'Condition met', not_met: 'Condition not met' }[record.outcome];
      button.type = 'button'; button.textContent = `${record.subject} — ${label} — ${record.recordedAt}`;
      button.addEventListener('click', async () => {
        const opening = ++caseDetailGeneration;
        detail.replaceChildren();
        status.textContent = 'Opening review…';
        try {
          const result = await sandboxRequest(`/api/analysis/condition-cases/${encodeURIComponent(record.id)}`);
          if (opening !== caseDetailGeneration) return;
          renderConditionFinding(detail, result.case, true);
          status.textContent = '';
        } catch (error) { if (opening === caseDetailGeneration) status.textContent = error.message; }
      });
      item.append(button); list.append(item);
    }
  } catch (error) { if (generation === caseListGeneration) status.textContent = error.message; }
}
document.getElementById('refresh-condition-cases')?.addEventListener('click', loadConditionCases);
function appendListSections(panel, sections) {
  for (const [label, values] of sections) {
    const title = document.createElement('h4'); title.textContent = label; panel.append(title);
    const list = document.createElement('ul');
    for (const value of values.length ? values : ['None reported']) { const item = document.createElement('li'); item.textContent = value; list.append(item); }
    panel.append(list);
  }
}
async function loadAnalysisConfig() {
  try {
    const config = await sandboxRequest('/api/analysis/config');
    aiConfigured = config.configured === true;
    analysisConfigState = 'ready';
  } catch { aiConfigured = false; analysisConfigState = 'failed'; }
  updateAnalysisControls();
}
document.getElementById('analyze-request').addEventListener('click', async () => {
  if (analysisUnavailableReason()) { updateAnalysisControls(); return; }
  const selectedOrderId = currentSandbox?.orderId;
  const message = document.getElementById('customer-request').value;
  invalidateRequestReview();
  const generation = ++analysisGeneration;
  const status = document.getElementById('analysis-status');
  analysisBusy = true;
  updateAnalysisControls(false);
  document.getElementById('request-analysis').replaceChildren();
  status.textContent = mockDemo ? 'Loading fixed mock analysis… No external requests.' : 'Analyzing untrusted customer content… No order action is being taken.';
  try {
    const result = await sandboxRequest('/api/analysis', 'POST', { selectedOrderId, message });
    if (generation !== analysisGeneration || currentSandbox?.orderId !== selectedOrderId || document.getElementById('customer-request').value !== message) return;
    const analysis = result.analysis;
    requestReview = { selectedOrderId, message, analysis, review: result.review || { canReviewCancellation: false } };
    renderRequestReview();
    updateMerchantControls();
    appendListSections(document.getElementById('request-analysis'), [
      ['Intent (unverified)', [analysis.intent]],
      ['Explicit order references', analysis.orderReferences.map(item => `${item.reference} — quote: ${item.quote}`)],
      ['Stated reason (unverified)', [analysis.reason?.text || 'Not stated']],
      ['Cancellation conditions (unverified)', (analysis.cancellationConditions || []).map(item => `${item.text} — quote: ${item.quote}`)],
      ['Requirements when conditions are not met (unverified)', (analysis.unmetConditionRequirements || []).map(item => `${item.text} — quote: ${item.quote}`)],
      ['Execution restriction', [requestReview.review.blockingReason || 'No conditional-request restriction reported.', ...(analysis.conditionalRequest && !analysis.cancellationConditions?.length ? ['Conditional language detected, but no condition was extracted. Inspect the original customer message; execution remains blocked.'] : [])]],
      ['Supporting quotes', analysis.supportingQuotes], ['Review flags', analysis.reviewFlags],
      ['Missing information', analysis.missingInformation], ['Clarification questions', analysis.clarificationQuestions],
    ]);
    status.textContent = mockDemo ? 'Mock analysis loaded. No AI, Shopify, or PayPal request was sent.' : 'AI analysis complete. Unverified customer claims; merchant review required. No order or payment state changed.';
  } catch (error) {
    if (generation === analysisGeneration) status.textContent = error.message;
  } finally { if (generation === analysisGeneration) { analysisBusy = false; updateAnalysisControls(false); } }
});
invalidateRequestReview();
document.getElementById('load-mock-example')?.addEventListener('click', async () => {
  if (!mockDemo) return;
  const input = document.getElementById('customer-request');
  input.value = "Please cancel order 1001 only if it hasn't shipped yet.";
  invalidateRequestReview();
  await loadAnalysisConfig();
  document.getElementById('analyze-request').click();
});
loadAnalysisConfig().then(loadConditionCases);
