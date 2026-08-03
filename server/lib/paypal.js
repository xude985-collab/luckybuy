/* PayPal REST API — Create Order + Capture（无 SDK，纯 HTTPS 调用） */
import 'dotenv/config';

const MODE = process.env.PAYPAL_MODE || 'sandbox';
const BASE = MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

let _token = null;
let _tokenExp = 0;

async function getAccessToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_SECRET;
  if (!id || !secret) return null;

  const resp = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`PayPal auth: ${data.error_description || resp.status}`);
  _token = data.access_token;
  _tokenExp = Date.now() + (data.expires_in - 60) * 1000;
  return _token;
}

export async function createOrder(amountUSD, rechargeId, returnUrl, cancelUrl) {
  const token = await getAccessToken();
  if (!token) return null;

  const resp = await fetch(`${BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: rechargeId,
        amount: { currency_code: 'USD', value: String(amountUSD) },
        description: `Lucky Buy recharge $${amountUSD}`,
      }],
      application_context: {
        return_url: returnUrl,
        cancel_url: cancelUrl,
        brand_name: 'Lucky Buy',
        user_action: 'PAY_NOW',
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`PayPal create order: ${data.message || resp.status}`);
  const approveLink = data.links.find(l => l.rel === 'approve');
  return { orderId: data.id, approveUrl: approveLink?.href };
}

export async function captureOrder(orderId) {
  const token = await getAccessToken();
  if (!token) return null;

  const resp = await fetch(`${BASE}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`PayPal capture: ${data.message || resp.status}`);
  return data;
}

export function isConfigured() {
  return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET);
}
