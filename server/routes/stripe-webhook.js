/*
 * Stripe Webhook：支付成功后给用户加币。
 * 必须用「原始 body」验签，因此在 app.js 里用 express.raw 单独挂载，
 * 且要在全局 express.json 之前。
 */
import crypto from 'crypto';
import db from '../db.js';
import { walletTx, tx } from '../lib/helpers.js';

// 验证 Stripe 签名（HMAC-SHA256，官方算法，避免装 SDK）
function verifySig(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map(kv => kv.split('=')));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const signed = crypto.createHmac('sha256', secret)
    .update(`${t}.${rawBody}`).digest('hex');
  // 时间安全比较
  const a = Buffer.from(signed), b = Buffer.from(v1);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export default function stripeWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const raw = req.body; // Buffer（express.raw）
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
    const rc = rid && db.prepare(`SELECT * FROM recharges WHERE id=?`).get(rid);
    // 幂等：只在 pending 时入账，防重复 webhook
    if (rc && rc.status === 'pending') {
      const total = rc.amount + (rc.bonus || 0);
      tx(() => {
        walletTx(rc.user_id, 'recharge', total, `Stripe 充值 $${rc.amount}${rc.bonus ? ' +赠送' + rc.bonus : ''}`);
        db.prepare(`UPDATE recharges SET status='paid',paid_at=? WHERE id=?`)
          .run(Date.now(), rid);
      });
    }
  }
  res.json({ received: true });
}
