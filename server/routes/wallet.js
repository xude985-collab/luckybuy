/* 钱包 / 购买 / 开奖 / 订单 */
import express from 'express';
import pool from '../db.js';
import {
  attachUser, requireAuth, totalCoins, walletTx,
  genId, withTransaction, now,
} from '../lib/helpers.js';
import { futureRound, roundTime } from '../lib/drand.js';

const router = express.Router();
router.use(attachUser);

// 我的钱包概览
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { paid, free } = await totalCoins(req.user.id);
    const { rows: txRows } = await pool.query(
      `SELECT kind,amount,balance,ref,created_at FROM wallet_tx WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]);
    res.json({ ok: true, paidBalance: paid, freeBalance: free, tx: txRows });
  } catch (e) { next(e); }
});

// 我的订单
router.get('/orders', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT o.*, p.name, p.emoji, p.total_shares, p.status AS product_status,
             d.win_number, d.winner_user_id, d.drawn_at
      FROM orders o JOIN products p ON p.id=o.product_id
      LEFT JOIN draws d ON d.product_id=o.product_id
      WHERE o.user_id=$1 ORDER BY o.created_at DESC`, [req.user.id]);
    res.json({ ok: true, orders: rows });
  } catch (e) { next(e); }
});

// 购买（夺宝）
router.post('/buy', requireAuth, async (req, res, next) => {
  try {
    const uid = req.user.id;
    const { productId } = req.body || {};
    const shares = Math.max(1, parseInt(req.body?.shares) || 0);
    const useFree = req.body?.useFree !== false;

    const { rows: pr } = await pool.query(`SELECT * FROM products WHERE id=$1`, [productId]);
    const p = pr[0];
    if (!p) return res.status(404).json({ ok: false, msg: '商品不存在' });
    if (p.status !== 'active') return res.status(400).json({ ok: false, msg: '该商品已停止参与' });

    const { rows: sr } = await pool.query(
      `SELECT COALESCE(SUM(shares),0) AS s FROM orders WHERE product_id=$1`, [productId]);
    const sold = Number(sr[0].s);
    const remain = p.total_shares - sold;
    if (shares > remain) return res.status(400).json({ ok: false, msg: `仅剩 ${remain} 份` });

    const cost = shares * Number(p.price_per_share);
    const pricePerShare = Number(p.price_per_share);

    const result = await withTransaction(async (client) => {
      const { rows: s2 } = await client.query(
        `SELECT COALESCE(SUM(shares),0) AS s FROM orders WHERE product_id=$1`, [productId]);
      const sold2 = Number(s2[0].s);
      if (shares > p.total_shares - sold2) throw Object.assign(new Error('手慢了，份数不足'), { status: 400 });

      // 免费金币逻辑：每个商品每人最多免费 1 份（事务内检查防并发）
      let freeUse = 0;
      if (useFree) {
        const { rows: used } = await client.query(
          `SELECT COALESCE(SUM(free_coins),0) AS f FROM orders WHERE user_id=$1 AND product_id=$2`,
          [uid, productId]);
        const alreadyUsedFree = Number(used[0].f) > 0;
        if (!alreadyUsedFree) {
          // 如果商品设了 free_quota，检查总额度是否用完
          let quotaOk = true;
          if (p.free_quota > 0) {
            const { rows: pf } = await client.query(`SELECT free_used FROM products WHERE id=$1`, [productId]);
            const productFreeLeft = Number(p.free_quota) - Number(pf[0]?.free_used || 0);
            if (productFreeLeft < pricePerShare) quotaOk = false;
          }
          if (quotaOk) {
            const { rows: ub } = await client.query(`SELECT free_balance FROM users WHERE id=$1`, [uid]);
            const userFreeBal = Number(ub[0]?.free_balance || 0);
            if (userFreeBal >= pricePerShare) {
              freeUse = pricePerShare;
            }
          }
        }
      }
      const paidUse = cost - freeUse;

      const { rows: ur } = await client.query(`SELECT paid_balance FROM users WHERE id=$1`, [uid]);
      const paidBal = Number(ur[0]?.paid_balance || 0);
      if (paidBal < paidUse) throw Object.assign(new Error(`余额不足，需 $${paidUse}，可先充值`), { status: 400, needRecharge: true });

      const numbers = Array.from({ length: shares }, (_, i) => sold2 + 1 + i);

      if (freeUse > 0) {
        await client.query(
          `UPDATE users SET free_balance=free_balance-$1 WHERE id=$2`, [freeUse, uid]);
        await client.query(
          `UPDATE products SET free_used=free_used+$1 WHERE id=$2`, [freeUse, productId]);
      }
      if (paidUse > 0) await walletTx(uid, 'spend', -paidUse, `购买 ${p.name} ${shares}份`, client);

      await client.query(
        `INSERT INTO orders (id,user_id,product_id,shares,numbers,paid_coins,free_coins,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [genId('o_'), uid, productId, shares, JSON.stringify(numbers), paidUse, freeUse, Date.now()]);

      const newSold = sold2 + shares;
      let locked = null;
      if (newSold >= p.total_shares) {
        const round = futureRound(Date.now(), 30);
        await client.query(
          `INSERT INTO draws (product_id,round,total_shares,locked_at) VALUES ($1,$2,$3,$4)`,
          [productId, round, p.total_shares, Date.now()]);
        await client.query(`UPDATE products SET status='drawing' WHERE id=$1`, [productId]);
        locked = { round, drawTime: roundTime(round) };
      }
      return { numbers, freeUse, paidUse, newSold, locked };
    });

    res.json({
      ok: true, msg: '参与成功',
      numbers: result.numbers, usedFree: result.freeUse, usedPaid: result.paidUse,
      sold: result.newSold, totalShares: p.total_shares,
      drawing: result.locked,
    });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, msg: e.message || '购买失败' });
  }
});

// 签到
router.post('/checkin', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayMs = todayStart.getTime();

    const { rows: already } = await pool.query(
      `SELECT id FROM checkins WHERE user_id=$1 AND created_at>=$2`, [uid, todayMs]);
    if (already.length > 0) return res.json({ ok: false, msg: '今天已签到' });

    const yesterdayMs = todayMs - 86400000;
    const { rows: yest } = await pool.query(
      `SELECT streak FROM checkins WHERE user_id=$1 AND created_at>=$2 AND created_at<$3 ORDER BY created_at DESC LIMIT 1`,
      [uid, yesterdayMs, todayMs]);
    const streak = (yest.length > 0 ? yest[0].streak : 0) + 1;

    const reward = Math.min(streak, 7) * 100;

    await pool.query(
      `INSERT INTO checkins (id, user_id, reward, streak, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [genId('ck_'), uid, reward, streak, Date.now()]);
    await pool.query(
      `UPDATE users SET free_balance=free_balance+$1 WHERE id=$2`, [reward, uid]);

    res.json({ ok: true, msg: `签到成功！连续${streak}天，获得${reward}免费金币`, streak, reward });
  } catch (e) {
    res.status(500).json({ ok: false, msg: '签到失败' });
  }
});

// 签到状态
router.get('/checkin-status', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayMs = todayStart.getTime();

    const { rows: today } = await pool.query(
      `SELECT id FROM checkins WHERE user_id=$1 AND created_at>=$2`, [uid, todayMs]);
    const checkedIn = today.length > 0;

    const { rows: last } = await pool.query(
      `SELECT streak, reward FROM checkins WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [uid]);
    const streak = last.length > 0 ? last[0].streak : 0;

    res.json({ ok: true, checkedIn, streak });
  } catch (e) {
    res.status(500).json({ ok: false, msg: '获取签到状态失败' });
  }
});

// 充值套餐
router.get('/packages', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT v FROM config WHERE k='recharge_packages'`);
    const packages = rows[0] ? JSON.parse(rows[0].v) : [
      { amount: 10, bonus: 0 }, { amount: 50, bonus: 5 },
      { amount: 100, bonus: 15 }, { amount: 200, bonus: 40 },
    ];
    res.json({ ok: true, packages });
  } catch (e) { next(e); }
});

// 充值
router.post('/recharge', requireAuth, async (req, res, next) => {
  try {
    const amount = Math.floor(Number(req.body?.amount) || 0);
    const method = req.body?.method || 'stripe';
    if (amount < 1) return res.status(400).json({ ok: false, msg: '充值金额至少 $1' });
    if (amount > 5000) return res.status(400).json({ ok: false, msg: '单次充值上限 $5000' });

    const { rows: pkgRows } = await pool.query(`SELECT v FROM config WHERE k='recharge_packages'`);
    const packages = pkgRows[0] ? JSON.parse(pkgRows[0].v) : [];
    const pkg = packages.find(p => p.amount === amount);
    const bonus = pkg ? (pkg.bonus || 0) : 0;

    const rid = genId('rc_');
    await pool.query(
      `INSERT INTO recharges (id,user_id,amount,bonus,method,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [rid, req.user.id, amount, bonus, method, 'pending', Date.now()]);

    const origin = req.headers.origin || `http://localhost:${process.env.PORT || 3000}`;
    const successUrl = `${origin}/recharge.html?result=success&id=${rid}`;
    const cancelUrl = `${origin}/recharge.html?result=cancel`;

    const hasStripe = !!process.env.STRIPE_SECRET_KEY;
    const hasPaypal = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET);

    if ((method === 'stripe' && !hasStripe) || (method === 'paypal' && !hasPaypal)) {
      if (!hasStripe && !hasPaypal) {
        const total = amount + bonus;
        await withTransaction(async (client) => {
          await walletTx(req.user.id, 'recharge', total, `模拟充值 $${amount}${bonus ? ' +赠送' + bonus : ''}`, client);
          await client.query(`UPDATE recharges SET status='paid',paid_at=$1 WHERE id=$2`, [Date.now(), rid]);
        });
        return res.json({ ok: true, simulated: true, msg: `已模拟到账 $${total}（含赠送 $${bonus}）`, rechargeId: rid });
      }
      return res.status(400).json({ ok: false, msg: `${method === 'stripe' ? 'Stripe' : 'PayPal'} 支付暂未开通` });
    }

    if (method === 'paypal') {
      const paypal = await import('../lib/paypal.js');
      const order = await paypal.createOrder(amount, rid, successUrl, cancelUrl);
      if (!order) return res.status(502).json({ ok: false, msg: 'PayPal 服务不可用' });
      await pool.query(`UPDATE recharges SET stripe_session=$1 WHERE id=$2`, [order.orderId, rid]);
      return res.json({ ok: true, url: order.approveUrl, rechargeId: rid });
    }

    // Stripe
    const key = process.env.STRIPE_SECRET_KEY;
    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('success_url', successUrl);
    form.set('cancel_url', cancelUrl);
    form.set('client_reference_id', rid);
    form.set('line_items[0][quantity]', '1');
    form.set('line_items[0][price_data][currency]', 'usd');
    form.set('line_items[0][price_data][unit_amount]', String(amount * 100));
    form.set('line_items[0][price_data][product_data][name]', `Lucky Buy 充值 ${amount} 金币`);
    form.set('metadata[rechargeId]', rid);
    form.set('metadata[userId]', req.user.id);

    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const s = await r.json();
    if (!r.ok) throw new Error(s.error?.message || 'Stripe 创建会话失败');
    await pool.query(`UPDATE recharges SET stripe_session=$1 WHERE id=$2`, [s.id, rid]);
    res.json({ ok: true, url: s.url, rechargeId: rid });
  } catch (e) {
    await pool.query(`UPDATE recharges SET status='failed' WHERE id=$1`, [req.body?._rid]).catch(() => {});
    res.status(502).json({ ok: false, msg: e.message });
  }
});

// PayPal 回调
router.get('/paypal-return', requireAuth, async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/recharge.html?result=cancel');

  const { rows: rcRows } = await pool.query(
    `SELECT * FROM recharges WHERE stripe_session=$1 AND method='paypal'`, [token]);
  const rc = rcRows[0];
  if (!rc || rc.status !== 'pending') return res.redirect('/recharge.html?result=success');

  try {
    const paypal = await import('../lib/paypal.js');
    const capture = await paypal.captureOrder(token);
    if (capture.status === 'COMPLETED') {
      const total = rc.amount + (rc.bonus || 0);
      await withTransaction(async (client) => {
        await walletTx(rc.user_id, 'recharge', total, `PayPal 充值 $${rc.amount}${rc.bonus ? ' +赠送' + rc.bonus : ''}`, client);
        await client.query(`UPDATE recharges SET status='paid',paid_at=$1 WHERE id=$2`, [Date.now(), rc.id]);
      });
    }
  } catch (e) {
    console.error('[paypal capture]', e.message);
  }
  res.redirect(`/recharge.html?result=success&id=${rc.id}`);
});

// 中奖人填写收货地址
router.post('/address', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const { rows: dr } = await pool.query(`SELECT * FROM draws WHERE product_id=$1`, [b.productId]);
    const d = dr[0];
    if (!d || !d.winner_user_id) return res.status(400).json({ ok: false, msg: '尚未开奖' });
    if (d.winner_user_id !== req.user.id)
      return res.status(403).json({ ok: false, msg: '非中奖本人' });
    if (!b.name || !b.address || !b.country)
      return res.status(400).json({ ok: false, msg: '收件人、国家、地址为必填' });

    const addr = {
      name: b.name, phone: b.phone || '', country: b.country,
      state: b.state || '', city: b.city || '', address: b.address,
      zip: b.zip || '', filledAt: Date.now(),
    };
    await pool.query(`UPDATE draws SET win_address=$1 WHERE product_id=$2`,
      [JSON.stringify(addr), b.productId]);
    res.json({ ok: true, msg: '收货地址已提交，我们将尽快发货' });
  } catch (e) { next(e); }
});

// 触发开奖
router.post('/draw/:productId', requireAuth, async (req, res, next) => {
  try {
    const pid = req.params.productId;
    const { rows: dr } = await pool.query(`SELECT * FROM draws WHERE product_id=$1`, [pid]);
    const d = dr[0];
    if (!d) return res.status(404).json({ ok: false, msg: '该商品未进入开奖' });
    if (d.drawn_at) return res.json({ ok: true, done: true, draw: publicDraw(d) });

    const { getRound, computeWinner, roundTime: rt } = await import('../lib/drand.js');
    if (Date.now() < rt(d.round))
      return res.json({ ok: true, done: false, msg: '开奖轮次尚未产生，请稍候', drawTime: rt(d.round) });

    const rd = await getRound(d.round);
    if (!rd) return res.json({ ok: true, done: false, msg: '随机数生成中，请稍候' });

    const winNumber = computeWinner(rd.randomness, pid, d.total_shares);
    const { rows: allOrders } = await pool.query(
      `SELECT user_id, numbers FROM orders WHERE product_id=$1`, [pid]);
    const winner = allOrders.find(o => JSON.parse(o.numbers).includes(winNumber));

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE draws SET randomness=$1,signature=$2,win_number=$3,winner_user_id=$4,drawn_at=$5
         WHERE product_id=$6 AND drawn_at IS NULL`,
        [rd.randomness, rd.signature, winNumber, winner?.user_id || null, Date.now(), pid]);
      await client.query(`UPDATE products SET status='done' WHERE id=$1`, [pid]);
    });

    const { rows: fresh } = await pool.query(`SELECT * FROM draws WHERE product_id=$1`, [pid]);
    res.json({ ok: true, done: true, draw: publicDraw(fresh[0]) });
  } catch (e) { next(e); }
});

function publicDraw(d) {
  return {
    round: d.round, randomness: d.randomness, signature: d.signature,
    winNumber: d.win_number, winnerUserId: d.winner_user_id,
    totalShares: d.total_shares, drawnAt: d.drawn_at,
    chain: 'drand quicknet', chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  };
}

export default router;
