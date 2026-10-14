async function checkHealth() {
  const indicator = document.getElementById('health');
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error('Health check failed');
    const health = await response.json();
    indicator.textContent = health.status === 'ok' ? 'Application status: Healthy' : 'Application status: Unhealthy';
  } catch {
    indicator.textContent = 'Application status: Connection failed. Check the local server.';
  }
}

checkHealth();

let sandboxOrderId;
let currentSandbox;
let merchantBusy = false;
const sandboxStatus = document.getElementById('sandbox-status');
const refreshButton = document.getElementById('refresh-sandbox');
const approvals = new Map();
document.getElementById('lookup-sandbox').addEventListener('click', async () => {
  if (merchantBusy) return;
  const id = document.getElementById('existing-order-id').value.trim();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) { sandboxStatus.textContent = 'Enter a valid Sandbox order ID.'; return; }
  try {
    displaySandbox(await sandboxRequest(`/api/paypal/orders/${encodeURIComponent(id)}`));
    sandboxStatus.textContent = 'Actual Sandbox status retrieved using read-only requests. No authorization was submitted.';
  } catch (error) { sandboxStatus.textContent = error.message; }
});
async function sandboxRequest(url, method = 'GET', body = {}) {
  const response = await fetch(url, { method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Sandbox request failed.');
  return data;
}
function displaySandbox(data) {
  sandboxOrderId = data.orderId;
  if (currentSandbox?.orderId !== data.orderId) document.getElementById('confirm-void').checked = false;
  currentSandbox = data;
  updateAnalysisSelection(data.orderId);
  updateMerchantControls();
  refreshButton.disabled = merchantBusy;
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
  if (merchantBusy) return;
  refreshButton.disabled = true;
  sandboxStatus.textContent = 'Retrieving actual Sandbox status…';
  try {
    const data = await sandboxRequest(`/api/paypal/orders/${encodeURIComponent(sandboxOrderId)}`);
    displaySandbox(data);
    sandboxStatus.textContent = 'Actual status retrieved from PayPal Sandbox. No payment was captured by this application.';
  } catch (error) { sandboxStatus.textContent = error.message; }
  finally { refreshButton.disabled = !sandboxOrderId; }
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
        if (approvals.has(data.orderID)) return approvals.get(data.orderID);
        const pending = (async () => {
          sandboxStatus.textContent = 'Buyer approved. Authorizing on the server; no capture will be performed…';
          try {
            const result = await sandboxRequest(`/api/paypal/orders/${encodeURIComponent(data.orderID)}/authorize`, 'POST');
            displaySandbox(result);
            sandboxStatus.textContent = result.authorizationStatus === 'CREATED'
              ? 'Payment authorized — not captured. Actual authorization status: CREATED.'
              : 'Actual authorization status retrieved from PayPal Sandbox. No capture was requested by this application.';
          } catch (error) {
            sandboxStatus.textContent = `${error.message} Authorization will not be retried automatically. Use Refresh actual authorization status to reconcile.`;
          }
        })();
        approvals.set(data.orderID, pending);
        return pending;
      },
      onCancel: () => {
        sandboxStatus.textContent = 'Buyer cancelled checkout. No authorization request was sent for this cancelled checkout. The merchant order was not marked cancelled.';
      },
      onError: () => {
        sandboxStatus.textContent = 'Sandbox checkout failed. If approval was already submitted, refresh actual status before taking further action. No automatic authorization retry.';
      },
    }).render('#paypal-buttons');
    sandboxStatus.textContent = 'Ready. Click PayPal and approve with your Sandbox Personal account.';
  } catch { sandboxStatus.textContent = 'Sandbox checkout is unavailable. Check backend configuration, network connectivity, and PayPal Sandbox availability.'; }
}
loadSandboxCheckout();

function updateMerchantControls() {
  const data = currentSandbox;
  const panel = document.getElementById('merchant-workflow');
  panel.hidden = !data;
  if (!data) return;
  refreshButton.disabled = merchantBusy;
  document.getElementById('lookup-sandbox').disabled = merchantBusy;
  const alreadyVoided = data.authorizationStatus === 'VOIDED';
  const confirmation = document.getElementById('confirm-void');
  confirmation.disabled = merchantBusy || alreadyVoided || data.voidState === 'CONFIRMED';
  if (alreadyVoided || data.voidState === 'CONFIRMED') confirmation.checked = false;
  const eligible = data.localOrderStatus === 'CANCELLED' && data.shipmentStatus === 'NOT_SHIPPED' && data.authorizationStatus === 'CREATED';
  document.getElementById('cancel-local-order').disabled = merchantBusy || data.localOrderStatus === 'CANCELLED';
  document.getElementById('void-recommendation').textContent = data.authorizationStatus === 'VOIDED'
    ? 'Authorization already voided. Bank funds availability may update later.'
    : eligible
      ? `Recommendation: Void authorization. Supporting facts: local Order cancelled; simulated Not shipped; PayPal authorization CREATED for CAD 100.00. ${data.paymentFacts ? `Last verified capture count: ${data.paymentFacts.captureCount}.` : 'Capture count has not yet been verified.'} Backend must verify ownership, amount, and no captures again before execution. Merchant approval required.`
      : 'Void is blocked until the local order is cancelled, not shipped, and the authorization is eligible.';
  document.getElementById('void-authorization').disabled = merchantBusy || !eligible || data.voidState === 'UNCERTAIN' || data.voidState === 'CONFIRMED' || !document.getElementById('confirm-void').checked;
  const history = document.getElementById('action-history');
  history.replaceChildren();
  for (const event of data.audit || []) {
    const item = document.createElement('li'); item.textContent = `${event.time}: ${event.action} — ${event.result}`; history.append(item);
  }
}
document.getElementById('confirm-void').addEventListener('change', updateMerchantControls);
document.getElementById('cancel-local-order').addEventListener('click', async () => {
  if (!currentSandbox || merchantBusy) return;
  const id = currentSandbox.orderId;
  merchantBusy = true; updateMerchantControls();
  try {
    displaySandbox(await sandboxRequest(`/api/paypal/orders/${encodeURIComponent(id)}/cancel`, 'POST'));
    document.getElementById('confirm-void').checked = false;
    sandboxStatus.textContent = 'Local order marked cancelled (simulated). PayPal order status was not changed. No void was executed.';
  } catch (error) { sandboxStatus.textContent = error.message; }
  finally { merchantBusy = false; updateMerchantControls(); }
});
document.getElementById('void-authorization').addEventListener('click', async () => {
  const data = currentSandbox;
  if (!data || merchantBusy || data.authorizationStatus === 'VOIDED' || data.voidState === 'CONFIRMED' || document.getElementById('void-authorization').disabled || !document.getElementById('confirm-void').checked) return;
  if (!window.confirm(`Void Sandbox authorization ${data.authorizationId} for order ${data.orderId}, CAD 100.00? This is a real Sandbox API action. Bank funds availability may update later.`)) return;
  merchantBusy = true; updateMerchantControls();
  document.getElementById('confirm-void').checked = false;
  sandboxStatus.textContent = 'Verifying current facts and requesting Sandbox void…';
  try {
    const result = await sandboxRequest(`/api/paypal/orders/${encodeURIComponent(data.orderId)}/void`, 'POST', { confirmed: true, orderId: data.orderId, authorizationId: data.authorizationId });
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
  document.getElementById('customer-request').disabled = analysisBusy;
  if (showStatus) document.getElementById('analysis-status').textContent = reason || 'AI analysis ready. Customer claims remain unverified.';
}
document.getElementById('customer-request').addEventListener('input', () => updateAnalysisControls());
let analysisGeneration = 0;
let analysisOrderId;
function updateAnalysisSelection(id) {
  if (analysisOrderId !== id) {
    analysisGeneration++;
    document.getElementById('request-analysis').replaceChildren();
    analysisBusy = false;
  }
  analysisOrderId = id;
  document.getElementById('analysis-order').textContent = `Selected order: ${id}. This association does not establish which order the customer means.`;
  updateAnalysisControls();
}
async function loadAnalysisConfig() {
  try {
    const response = await fetch('/api/analysis/config');
    if (!response.ok) throw new Error('Configuration unavailable');
    const config = await response.json(); aiConfigured = config.configured === true;
    analysisConfigState = 'ready';
  } catch { aiConfigured = false; analysisConfigState = 'failed'; }
  updateAnalysisControls();
}
document.getElementById('analyze-request').addEventListener('click', async () => {
  if (analysisUnavailableReason()) { updateAnalysisControls(); return; }
  const selectedOrderId = currentSandbox?.orderId;
  const generation = ++analysisGeneration;
  const status = document.getElementById('analysis-status');
  analysisBusy = true;
  updateAnalysisControls(false);
  document.getElementById('request-analysis').replaceChildren();
  status.textContent = 'Analyzing untrusted customer content… No order action is being taken.';
  try {
    const result = await sandboxRequest('/api/analysis', 'POST', { selectedOrderId, message: document.getElementById('customer-request').value });
    if (generation !== analysisGeneration || currentSandbox?.orderId !== selectedOrderId) return;
    const analysis = result.analysis;
    const box = document.getElementById('request-analysis');
    for (const [label, values] of [
      ['Intent (unverified)', [analysis.intent]],
      ['Explicit order references', analysis.orderReferences.map(item => `${item.reference} — quote: ${item.quote}`)],
      ['Stated reason (unverified)', [analysis.reason?.text || 'Not stated']],
      ['Supporting quotes', analysis.supportingQuotes], ['Review flags', analysis.reviewFlags],
      ['Missing information', analysis.missingInformation], ['Clarification questions', analysis.clarificationQuestions],
    ]) {
      const title = document.createElement('h4'); title.textContent = label; box.append(title);
      const list = document.createElement('ul');
      for (const value of values.length ? values : ['None reported']) { const item = document.createElement('li'); item.textContent = value; list.append(item); }
      box.append(list);
    }
    status.textContent = 'AI analysis complete. Unverified customer claims; merchant review required. No order or payment state changed.';
  } catch (error) {
    if (generation === analysisGeneration) status.textContent = error.message;
  } finally { if (generation === analysisGeneration) { analysisBusy = false; updateAnalysisControls(false); } }
});
loadAnalysisConfig();
