/*
 * Stripe Webhook：支付成功后给用户加币。
 * 必须用「原始 body」验签，因此在 app.js 里用 express.raw 单独挂载。
 */
import crypto from 'crypto';
import pool from '../db.js';
import { settleRecharge } from '../lib/recharges.js';

export function verifySig(rawBody, sigHeader, secret, nowSeconds = Date.now() / 1000) {
  if (!secret || typeof sigHeader !== 'string') return false;
  const parts = sigHeader.split(',').map(part => part.trim().split('='));
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  if (!/^\d+$/.test(timestamp || '') || Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  return parts.some(([key, value]) => key === 'v1' && /^[a-f0-9]{64}$/i.test(value || '') &&
    crypto.timingSafeEqual(expected, Buffer.from(value, 'hex')));
}

export default async function stripeWebhook(req, res, next) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const raw = req.body;
  const rawStr = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);

  if (!secret) return res.status(503).send('webhook not configured');
  if (!Buffer.isBuffer(raw)) return res.status(400).send('raw body required');
  if (!verifySig(rawStr, req.headers['stripe-signature'], secret))
    return res.status(400).send('signature verification failed');

  let event;
  try { event = JSON.parse(rawStr); }
  catch { return res.status(400).send('invalid payload'); }

  try {
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event?.type)) {
      const s = event.data?.object;
      if (!s || s.payment_status !== 'paid') return res.json({ received: true });
      const rid = s.metadata?.rechargeId || s.client_reference_id;
      if (rid) {
        const { rows } = await pool.query(`SELECT * FROM recharges WHERE id=$1`, [rid]);
        const rc = rows[0];
        if (rc && (rc.method !== 'stripe' || rc.stripe_session !== s.id || s.currency !== 'usd' ||
            s.amount_total !== Number(rc.amount) * 100)) return res.status(400).send('payment mismatch');
        if (rc) await settleRecharge(rc.id, 'stripe', s.id);
      }
    }
    res.json({ received: true });
  } catch (e) { next(e); }
}
