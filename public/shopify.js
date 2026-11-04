// Deliberately separate from PayPal selection, request reviews and merchant controls.
const shopifyInput = document.getElementById('shopify-order-id');
const shopifyButton = document.getElementById('lookup-shopify');
const shopifyStatus = document.getElementById('shopify-status');
const shopifyDetails = document.getElementById('shopify-details');
shopifyInput.addEventListener('input', () => {
  shopifyDetails.replaceChildren();
  shopifyStatus.textContent = 'Order ID changed. Query again to retrieve its Shopify snapshot.';
});
shopifyButton.addEventListener('click', async () => {
  if (shopifyButton.disabled) return;
  const id = shopifyInput.value.trim();
  shopifyDetails.replaceChildren();
  if (!/^gid:\/\/shopify\/Order\/[1-9][0-9]{0,24}$/.test(id)) {
    shopifyStatus.textContent = 'Enter a valid Shopify Order GID.';
    return;
  }
  shopifyButton.disabled = true;
  shopifyInput.disabled = true;
  shopifyStatus.textContent = 'Querying Shopify development store (read-only)…';
  try {
    const response = await fetch(`/api/shopify/order?${new URLSearchParams({ id })}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Shopify lookup failed. No order state is assumed.');
    if (shopifyInput.value.trim() !== id) return;
    for (const [label, value] of [
      ['Source', data.source], ['Shopify order GID', data.orderId], ['Order number', data.orderNumber],
      ['Payment status (Shopify)', data.paymentStatus], ['Fulfillment status (Shopify)', data.fulfillmentStatus], ['Queried at (UTC)', data.queriedAt],
    ]) {
      const row = document.createElement('div');
      const term = document.createElement('dt'); term.textContent = label;
      const description = document.createElement('dd'); description.textContent = value;
      row.append(term, description); shopifyDetails.append(row);
    }
    shopifyStatus.textContent = 'Shopify snapshot retrieved. No cancellation or payment action was taken. This does not grant cancellation or void eligibility.';
  } catch (error) {
    if (shopifyInput.value.trim() === id) shopifyStatus.textContent = error instanceof Error ? error.message : 'Shopify lookup failed. No order state is assumed.';
  } finally { shopifyButton.disabled = false; shopifyInput.disabled = false; }
});
