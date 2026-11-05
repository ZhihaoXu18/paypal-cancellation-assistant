// Server-side, read-only Shopify development-store adapter. No payment linkage.
const API_VERSION = '2026-10';
const ORDER_ID = /^gid:\/\/shopify\/Order\/[1-9][0-9]{0,24}$/;
const QUERY = `query OrderSnapshot($id: ID!) {
  order(id: $id) { id name displayFinancialStatus displayFulfillmentStatus }
}`;
const FINANCIAL = new Set(['AUTHORIZED', 'EXPIRED', 'PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED', 'PENDING', 'REFUNDED', 'VOIDED']);
const FULFILLMENT = new Set(['FULFILLED', 'FULFILLMENT_NOT_REQUIRED', 'IN_PROGRESS', 'ON_HOLD', 'OPEN', 'PARTIALLY_FULFILLED', 'PENDING_FULFILLMENT', 'REQUEST_DECLINED', 'RESTOCKED', 'SCHEDULED', 'UNFULFILLED']);
class ShopifyError extends Error {
  constructor(message, status = 502, category, field, errorType) {
    super(message); this.status = status;
    // Callers supply fixed categories and schema field names, never remote values.
    this.category = category; this.field = field; this.errorType = errorType;
  }
}
function createShopify(env = process.env, request = fetch) {
  const shop = typeof env.SHOPIFY_SHOP === 'string' ? env.SHOPIFY_SHOP.trim().toLowerCase() : '';
  const clientId = typeof env.SHOPIFY_CLIENT_ID === 'string' ? env.SHOPIFY_CLIENT_ID.trim() : '';
  const secret = typeof env.SHOPIFY_CLIENT_SECRET === 'string' ? env.SHOPIFY_CLIENT_SECRET.trim() : '';
  let cachedToken;
  let tokenPending;
  function configured() {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(shop) || !clientId || !secret) {
      throw new ShopifyError('Shopify is not configured. Set a valid myshopify.com domain, Client ID and Client secret on the server.', 503);
    }
  }
  async function checkedRequest(path, options) {
    const response = await request(`https://${shop}${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      if (response.status === 401) { cachedToken = undefined; throw new ShopifyError('Shopify authentication failed. Check app installation, organization and credentials.', 401); }
      if (response.status === 403) throw new ShopifyError('Shopify access denied. Check the installed app and read_orders permission.', 403);
      throw new ShopifyError(`Shopify request failed (HTTP ${Number.isInteger(response.status) ? response.status : 'unknown'}). No order state is assumed.`);
    }
    return response.json();
  }
  async function accessToken() {
    if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
    if (!tokenPending) {
      tokenPending = (async () => {
        const data = await checkedRequest('/admin/oauth/access_token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret }).toString(),
        });
        if (typeof data.access_token !== 'string' || !data.access_token.trim() || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new ShopifyError('Shopify returned an invalid authentication response.');
        if (typeof data.scope !== 'string' || !data.scope.split(/[,\s]+/).includes('read_orders')) throw new ShopifyError('Shopify read_orders permission is required.', 403);
        cachedToken = { value: data.access_token, expiresAt: Date.now() + Math.max(0, data.expires_in - 60) * 1000 };
        return cachedToken.value;
      })();
    }
    try { return await tokenPending; } finally { tokenPending = undefined; }
  }
  return {
    async order(id) {
      if (typeof id !== 'string' || !ORDER_ID.test(id)) throw new ShopifyError('Enter a valid Shopify Order GID.', 400);
      configured();
      try {
        const token = await accessToken();
        const result = await checkedRequest(`/admin/api/${API_VERSION}/graphql.json`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
          body: JSON.stringify({ query: QUERY, variables: { id } }),
        });
        // Partial data is not accepted alongside GraphQL errors; never reflect raw messages.
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ShopifyError('Shopify returned an invalid order response.', 502, 'FIELD_MISSING', 'order');
        if (result.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length)) {
          const denied = Array.isArray(result.errors) && result.errors.filter(error => error?.extensions?.code === 'ACCESS_DENIED');
          if (denied && denied.length) {
            const protectedData = denied.some(error => typeof error.message === 'string' && /not approved to access|protected customer data|protected customer information/i.test(error.message));
            throw new ShopifyError(protectedData
              ? 'Shopify GraphQL access denied. Check protected-data access configuration for order in the app dashboard. No order state is assumed.'
              : 'Shopify access denied. Check read_orders permission and order access.',
            403, 'GRAPHQL_ERRORS', 'order', protectedData ? 'PROTECTED_DATA_ACCESS_DENIED' : 'ACCESS_DENIED');
          }
          throw new ShopifyError('Shopify GraphQL query failed. No order state is assumed.', 502, 'GRAPHQL_ERRORS');
        }
        if (!result.data || !Object.hasOwn(result.data, 'order')) throw new ShopifyError('Shopify returned an invalid order response.', 502, 'FIELD_MISSING', 'order');
        const order = result.data.order;
        if (order === null) throw new ShopifyError('Shopify order was not found or is not accessible. Check the ID, permissions and order age.', 404, 'ORDER_NULL', 'order');
        if (!order || typeof order !== 'object' || Array.isArray(order)) throw new ShopifyError('Shopify returned an invalid order response.', 502, 'FIELD_MISSING', 'order');
        for (const field of ['id', 'name', 'displayFinancialStatus', 'displayFulfillmentStatus']) {
          if (order[field] === undefined || order[field] === null || order[field] === '') throw new ShopifyError('Shopify returned missing order fields. No shipment state is assumed.', 502, 'FIELD_MISSING', field);
          if (typeof order[field] !== 'string' || !order[field].trim()) throw new ShopifyError('Shopify returned an invalid order field format.', 502, 'INVALID_FIELD_FORMAT', field);
        }
        if (order.id !== id) throw new ShopifyError('Shopify returned an inconsistent order ID.', 502, 'ORDER_ID_MISMATCH', 'id');
        if (order.name.length > 100) throw new ShopifyError('Shopify returned an invalid order field format.', 502, 'INVALID_FIELD_FORMAT', 'name');
        for (const [field, allowed] of [['displayFinancialStatus', FINANCIAL], ['displayFulfillmentStatus', FULFILLMENT]]) {
          if (!allowed.has(order[field])) throw new ShopifyError('Shopify returned an unknown order status. No shipment state is assumed.', 502, 'UNSUPPORTED_STATUS', field);
        }
        return { orderId: order.id, orderNumber: order.name, paymentStatus: order.displayFinancialStatus,
          fulfillmentStatus: order.displayFulfillmentStatus, queriedAt: new Date().toISOString(), source: 'Shopify development store',
          readOnly: true, linkedToPayPal: false };
      } catch (error) {
        if (error instanceof ShopifyError) throw error;
        throw new ShopifyError('Shopify request timed out, failed or returned unreadable data. No order state is assumed.');
      }
    },
  };
}
module.exports = { createShopify, ShopifyError };
