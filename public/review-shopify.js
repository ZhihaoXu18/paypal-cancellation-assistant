// Loaded on the merchant page only. Mock reviews do not query Shopify.
window.renderReviewShopify = function renderReviewShopify(panel, record) {
  const section = document.createElement('section');
  const title = document.createElement('h4');
  title.textContent = 'Shopify order on this review';
  const details = document.createElement('dl');
  const description = document.createElement('p');
  description.textContent = 'A saved lookup is a point-in-time snapshot. UNFULFILLED does not establish whether the carrier received the parcel. This does not link or authorize a PayPal action.';
  function renderSnapshot() {
    details.replaceChildren();
    const snapshot = record.shopifySnapshot;
    if (!snapshot) {
      const empty = document.createElement('p');
      empty.textContent = 'No Shopify order snapshot saved.';
      details.before(empty);
      return empty;
    }
    for (const [label, value] of [
      ['Order', snapshot.orderNumber], ['Shopify order ID', snapshot.orderId], ['Payment status', snapshot.paymentStatus],
      ['Fulfillment status', snapshot.fulfillmentStatus], ['Queried at (UTC)', snapshot.queriedAt], ['Source', snapshot.source],
    ]) {
      const term = document.createElement('dt');
      const entry = document.createElement('dd');
      term.textContent = label;
      entry.textContent = value;
      details.append(term, entry);
    }
  }
  const form = document.createElement('form');
  const orderLabel = document.createElement('label');
  orderLabel.textContent = 'Shopify order ID (GID)';
  const input = document.createElement('input');
  input.required = true;
  input.maxLength = 64;
  input.placeholder = 'gid://shopify/Order/…';
  input.value = record.shopifySnapshot?.orderId || '';
  orderLabel.append(input);
  const confirmLabel = document.createElement('label');
  const confirm = document.createElement('input');
  confirm.type = 'checkbox';
  confirm.required = true;
  confirmLabel.append(confirm, ' I verified this is the Shopify order for this review.');
  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = 'Query Shopify and save snapshot';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  form.append(orderLabel, confirmLabel, button, status);
  section.append(title, description, details, form);
  panel.append(section);
  let empty = renderSnapshot();
  input.addEventListener('input', () => { confirm.checked = false; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled || !confirm.checked) return;
    button.disabled = input.disabled = confirm.disabled = true;
    status.textContent = 'Looking up the Shopify order…';
    try {
      const response = await fetch(`/api/analysis/condition-cases/${encodeURIComponent(record.id)}/shopify-snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: input.value.trim(), confirmed: true, version: record.version }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Shopify lookup failed.');
      if (!result.shopifySnapshot || !Number.isInteger(result.version)) throw new Error('Shopify snapshot was not confirmed.');
      record.version = result.version;
      record.shopifySnapshot = result.shopifySnapshot;
      empty?.remove();
      empty = renderSnapshot();
      confirm.checked = false;
      status.textContent = 'Shopify snapshot saved on this review.';
    } catch (error) {
      status.textContent = error.message + (record.shopifySnapshot ? ' The previous snapshot is still shown.' : '');
    } finally {
      button.disabled = input.disabled = confirm.disabled = false;
    }
  });
};
