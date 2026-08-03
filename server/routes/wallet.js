/* 钱包 / 购买 / 开奖 / 订单。核心逻辑在 Task #4、#5 充实。 */
import express from 'express';
import db from '../db.js';
import {
  attachUser, requireAuth, totalCoins, walletTx,
  freeBalanceForProduct, genId, tx,
} from '../lib/helpers.js';
import { futureRound, roundTime } from '../lib/drand.js';

const router = express.Router();
router.use(attachUser);

// 我的钱包概览
router.get('/', requireAuth, (req, res) => {
  const { paid } = totalCoins(req.user.id);
  const tx = db.prepare(`SELECT kind,amount,balance,ref,created_at
    FROM wallet_tx WHERE user_id=? ORDER BY created_at DESC LIMIT 50`).all(req.user.id);
  res.json({ ok: true, paidBalance: paid, tx });
});

// 我的订单
router.get('/orders', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT o.*, p.name, p.emoji, p.total_shares, p.status AS product_status,
           d.win_number, d.winner_user_id, d.drawn_at
    FROM orders o JOIN products p ON p.id=o.product_id
    LEFT JOIN draws d ON d.product_id=o.product_id
    WHERE o.user_id=? ORDER BY o.created_at DESC`).all(req.user.id);
  res.json({ ok: true, orders: rows });
});

// 购买（夺宝）
// body: { productId, shares, useFree(bool 是否尽量用免费币) }
router.post('/buy', requireAuth, (req, res) => {
  const uid = req.user.id;
  const { productId } = req.body || {};
  const shares = Math.max(1, parseInt(req.body?.shares) || 0);
  const useFree = req.body?.useFree !== false; // 默认尽量用免费币

  const p = db.prepare(`SELECT * FROM products WHERE id=?`).get(productId);
  if (!p) return res.status(404).json({ ok: false, msg: '商品不存在' });
  if (p.status !== 'active') return res.status(400).json({ ok: false, msg: '该商品已停止参与' });

  const sold = db.prepare(`SELECT COALESCE(SUM(shares),0) s FROM orders WHERE product_id=?`).get(productId).s;
  const remain = p.total_shares - sold;
  if (shares > remain) return res.status(400).json({ ok: false, msg: `仅剩 ${remain} 份` });

  const cost = shares * p.price_per_share; // 总花费（币）

  // 免费币可用量 = min(用户该商品免费余额, 商品剩余免费额度)
  const userFree = useFree ? freeBalanceForProduct(uid, productId) : 0;
  const productFreeLeft = p.free_quota - p.free_used;
  const freeUse = Math.max(0, Math.min(cost, userFree, productFreeLeft));
  const paidUse = cost - freeUse;

  const paidBal = db.prepare(`SELECT paid_balance FROM users WHERE id=?`).get(uid).paid_balance;
  if (paidBal < paidUse)
    return res.status(400).json({ ok: false, msg: `余额不足，需 $${paidUse}，可先充值` });

  try {
    const result = tx(() => {
      // 再查一次已售，防并发超卖
      const sold2 = db.prepare(`SELECT COALESCE(SUM(shares),0) s FROM orders WHERE product_id=?`).get(productId).s;
      if (shares > p.total_shares - sold2) throw Object.assign(new Error('手慢了，份数不足'), { status: 400 });

      // 分配连续号码 [sold2+1 .. sold2+shares]
      const numbers = Array.from({ length: shares }, (_, i) => sold2 + 1 + i);

      // 扣免费币
      if (freeUse > 0) {
        db.prepare(`UPDATE free_grants SET amount=amount-? WHERE user_id=? AND product_id=?`)
          .run(freeUse, uid, productId);
        db.prepare(`UPDATE products SET free_used=free_used+? WHERE id=?`).run(freeUse, productId);
      }
      // 扣充值币
      if (paidUse > 0) walletTx(uid, 'spend', -paidUse, `购买 ${p.name} ${shares}份`);

      db.prepare(`INSERT INTO orders
        (id,user_id,product_id,shares,numbers,paid_coins,free_coins,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        genId('o_'), uid, productId, shares, JSON.stringify(numbers), paidUse, freeUse, Date.now());

      // 满员 → 锁定未来轮次，进入开奖中
      const newSold = sold2 + shares;
      let locked = null;
      if (newSold >= p.total_shares) {
        const round = futureRound(Date.now(), 30); // 30 秒后那轮，当前不可预测
        db.prepare(`INSERT INTO draws (product_id,round,total_shares,locked_at)
          VALUES (?,?,?,?)`).run(productId, round, p.total_shares, Date.now());
        db.prepare(`UPDATE products SET status='drawing' WHERE id=?`).run(productId);
        locked = { round, drawTime: roundTime(round) };
      }
      return { numbers, freeUse, paidUse, newSold, locked };
    });

    res.json({
      ok: true, msg: '参与成功',
      numbers: result.numbers, usedFree: result.freeUse, usedPaid: result.paidUse,
      sold: result.newSold, totalShares: p.total_shares,
      drawing: result.locked, // 若满员，含 round 与预计开奖时间
    });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, msg: e.message || '购买失败' });
  }
});
// 充值套餐配置接口（前端读取）
router.get('/packages', (req, res) => {
  const raw = db.prepare(`SELECT v FROM config WHERE k='recharge_packages'`).get();
  const packages = raw ? JSON.parse(raw.v) : [
    { amount: 10, bonus: 0 },
    { amount: 50, bonus: 5 },
    { amount: 100, bonus: 15 },
    { amount: 200, bonus: 40 },
  ];
  res.json({ ok: true, packages });
});

// 充值：1 币 = $1。body { amount, method: 'stripe'|'paypal' }
router.post('/recharge', requireAuth, async (req, res) => {
  const amount = Math.floor(Number(req.body?.amount) || 0);
  const method = req.body?.method || 'stripe';
  if (amount < 1) return res.status(400).json({ ok: false, msg: '充值金额至少 $1' });
  if (amount > 5000) return res.status(400).json({ ok: false, msg: '单次充值上限 $5000' });

  // 计算套餐 bonus
  const rawPkg = db.prepare(`SELECT v FROM config WHERE k='recharge_packages'`).get();
  const packages = rawPkg ? JSON.parse(rawPkg.v) : [];
  const pkg = packages.find(p => p.amount === amount);
  const bonus = pkg ? (pkg.bonus || 0) : 0;

  const rid = genId('rc_');
  db.prepare(`INSERT INTO recharges (id,user_id,amount,bonus,method,status,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(rid, req.user.id, amount, bonus, method, 'pending', Date.now());

  const origin = req.headers.origin || `http://localhost:${process.env.PORT || 3000}`;
  const successUrl = `${origin}/recharge.html?result=success&id=${rid}`;
  const cancelUrl = `${origin}/recharge.html?result=cancel`;

  // 无任何支付密钥：模拟直接到账（仅本地开发）
  const hasStripe = !!process.env.STRIPE_SECRET_KEY;
  const hasPaypal = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET);

  if ((method === 'stripe' && !hasStripe) || (method === 'paypal' && !hasPaypal)) {
    if (!hasStripe && !hasPaypal) {
      const total = amount + bonus;
      tx(() => {
        walletTx(req.user.id, 'recharge', total, `模拟充值 $${amount}${bonus ? ' +赠送' + bonus : ''}`);
        db.prepare(`UPDATE recharges SET status='paid',paid_at=? WHERE id=?`).run(Date.now(), rid);
      });
      return res.json({ ok: true, simulated: true, msg: `已模拟到账 $${total}（含赠送 $${bonus}）`, rechargeId: rid });
    }
    return res.status(400).json({ ok: false, msg: `${method === 'stripe' ? 'Stripe' : 'PayPal'} 支付暂未开通` });
  }

  try {
    if (method === 'paypal') {
      const paypal = await import('../lib/paypal.js');
      const order = await paypal.createOrder(amount, rid, successUrl, cancelUrl);
      if (!order) return res.status(502).json({ ok: false, msg: 'PayPal 服务不可用' });
      db.prepare(`UPDATE recharges SET stripe_session=? WHERE id=?`).run(order.orderId, rid);
      return res.json({ ok: true, url: order.approveUrl, rechargeId: rid });
    }

    // Stripe Checkout Session
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
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const s = await r.json();
    if (!r.ok) throw new Error(s.error?.message || 'Stripe 创建会话失败');
    db.prepare(`UPDATE recharges SET stripe_session=? WHERE id=?`).run(s.id, rid);
    res.json({ ok: true, url: s.url, rechargeId: rid });
  } catch (e) {
    db.prepare(`UPDATE recharges SET status='failed' WHERE id=?`).run(rid);
    res.status(502).json({ ok: false, msg: e.message });
  }
});

// PayPal 回调：用户支付后跳回带 token & PayerID，后端 capture
router.get('/paypal-return', requireAuth, async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/recharge.html?result=cancel');

  const rc = db.prepare(`SELECT * FROM recharges WHERE stripe_session=? AND method='paypal'`).get(token);
  if (!rc || rc.status !== 'pending') return res.redirect('/recharge.html?result=success');

  try {
    const paypal = await import('../lib/paypal.js');
    const capture = await paypal.captureOrder(token);
    if (capture.status === 'COMPLETED') {
      const total = rc.amount + (rc.bonus || 0);
      tx(() => {
        walletTx(rc.user_id, 'recharge', total, `PayPal 充值 $${rc.amount}${rc.bonus ? ' +赠送' + rc.bonus : ''}`);
        db.prepare(`UPDATE recharges SET status='paid',paid_at=? WHERE id=?`).run(Date.now(), rc.id);
      });
    }
  } catch (e) {
    console.error('[paypal capture]', e.message);
  }
  res.redirect(`/recharge.html?result=success&id=${rc.id}`);
});
// 中奖人填写收货地址
// body: { productId, name, phone, country, state, city, address, zip }
router.post('/address', requireAuth, (req, res) => {
  const b = req.body || {};
  const d = db.prepare(`SELECT * FROM draws WHERE product_id=?`).get(b.productId);
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
  db.prepare(`UPDATE draws SET win_address=? WHERE product_id=?`)
    .run(JSON.stringify(addr), b.productId);
  res.json({ ok: true, msg: '收货地址已提交，我们将尽快发货' });
});

// 触发开奖：满员锁定后，到点由此拉取 drand 随机数算出中奖号并回填凭据。
// 幂等：已开过直接返回结果。可由前端轮询调用，也可由定时任务调用。
router.post('/draw/:productId', requireAuth, async (req, res) => {
  const pid = req.params.productId;
  const d = db.prepare(`SELECT * FROM draws WHERE product_id=?`).get(pid);
  if (!d) return res.status(404).json({ ok: false, msg: '该商品未进入开奖' });
  if (d.drawn_at) {
    return res.json({ ok: true, done: true, draw: publicDraw(d) });
  }

  const { getRound, computeWinner, roundTime } = await import('../lib/drand.js');
  if (Date.now() < roundTime(d.round))
    return res.json({ ok: true, done: false, msg: '开奖轮次尚未产生，请稍候', drawTime: roundTime(d.round) });

  const rd = await getRound(d.round);
  if (!rd) return res.json({ ok: true, done: false, msg: '随机数生成中，请稍候' });

  const winNumber = computeWinner(rd.randomness, pid, d.total_shares);
  // 找持有该号码的订单 → 中奖用户
  const winner = db.prepare(`SELECT user_id, numbers FROM orders WHERE product_id=?`).all(pid)
    .find(o => JSON.parse(o.numbers).includes(winNumber));

  try {
    tx(() => {
      db.prepare(`UPDATE draws SET randomness=?,signature=?,win_number=?,winner_user_id=?,drawn_at=?
        WHERE product_id=? AND drawn_at IS NULL`).run(
        rd.randomness, rd.signature, winNumber, winner?.user_id || null, Date.now(), pid);
      db.prepare(`UPDATE products SET status='done' WHERE id=?`).run(pid);
    });
  } catch (e) {
    return res.status(500).json({ ok: false, msg: '开奖写入失败：' + e.message });
  }
  const fresh = db.prepare(`SELECT * FROM draws WHERE product_id=?`).get(pid);
  res.json({ ok: true, done: true, draw: publicDraw(fresh) });
});

// 对外暴露的开奖凭据（可审计：任何人可用 round+randomness 复算 win_number）
function publicDraw(d) {
  return {
    round: d.round, randomness: d.randomness, signature: d.signature,
    winNumber: d.win_number, winnerUserId: d.winner_user_id,
    totalShares: d.total_shares, drawnAt: d.drawn_at,
    chain: 'drand quicknet', chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  };
}

export default router;
