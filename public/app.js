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
const sandboxStatus = document.getElementById('sandbox-status');
const refreshButton = document.getElementById('refresh-sandbox');
const approvals = new Map();
document.getElementById('lookup-sandbox').addEventListener('click', async () => {
  const id = document.getElementById('existing-order-id').value.trim();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) { sandboxStatus.textContent = 'Enter a valid Sandbox order ID.'; return; }
  try {
    displaySandbox(await sandboxRequest(`/api/paypal/orders/${encodeURIComponent(id)}`));
    sandboxStatus.textContent = 'Actual Sandbox status retrieved using read-only requests. No authorization was submitted.';
  } catch (error) { sandboxStatus.textContent = error.message; }
});
async function sandboxRequest(url, method = 'GET') {
  const response = await fetch(url, { method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Sandbox request failed.');
  return data;
}
function displaySandbox(data) {
  sandboxOrderId = data.orderId;
  refreshButton.disabled = false;
  const details = document.getElementById('sandbox-details');
  details.replaceChildren();
  for (const [label, value] of [
    ['PayPal order ID', data.orderId], ['Order status (PayPal)', data.orderStatus],
    ['Amount', `${data.currency} ${data.amount}`], ['Authorization ID', data.authorizationId || 'Not available'],
    ['Authorization status (PayPal)', data.authorizationStatus || 'Not yet retrieved'],
  ]) {
    const row = document.createElement('div');
    const term = document.createElement('dt'); term.textContent = label;
    const description = document.createElement('dd'); description.textContent = value;
    row.append(term, description); details.append(row);
  }
}
refreshButton.addEventListener('click', async () => {
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
