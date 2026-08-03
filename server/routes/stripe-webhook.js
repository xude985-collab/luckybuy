/*
 * Stripe Webhook：支付成功后给用户加币。
 * 必须用「原始 body」验签，因此在 app.js 里用 express.raw 单独挂载。
 */
import crypto from 'crypto';
import pool from '../db.js';
import { walletTx, withTransaction } from '../lib/helpers.js';

function verifySig(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map(kv => kv.split('=')));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const signed = crypto.createHmac('sha256', secret)
    .update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(signed), b = Buffer.from(v1);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export default async function stripeWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const raw = req.body;
  const rawStr = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);

  if (secret) {
    if (!verifySig(rawStr, req.headers['stripe-signature'], secret))
      return res.status(400).send('signature verification failed');
  }

  let event;
  try { event = JSON.parse(rawStr); }
  catch { return res.status(400).send('invalid payload'); }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const rid = s.metadata?.rechargeId || s.client_reference_id;
    if (rid) {
      const { rows } = await pool.query(`SELECT * FROM recharges WHERE id=$1`, [rid]);
      const rc = rows[0];
      if (rc && rc.status === 'pending') {
        const total = rc.amount + (rc.bonus || 0);
        await withTransaction(async (client) => {
          await walletTx(rc.user_id, 'recharge', total,
            `Stripe 充值 $${rc.amount}${rc.bonus ? ' +赠送' + rc.bonus : ''}`, client);
          await client.query(`UPDATE recharges SET status='paid',paid_at=$1 WHERE id=$2`, [Date.now(), rid]);
        });
      }
    }
  }
  res.json({ received: true });
}
