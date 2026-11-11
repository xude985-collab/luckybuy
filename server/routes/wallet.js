/* 钱包 / 购买 / 揭晓 / 订单 */
import express from 'express';
import pool from '../db.js';
import {
  attachUser, requireAuth, totalCoins, walletTx,
  genId, withTransaction, now, getConfig,
} from '../lib/helpers.js';
import { futureRound, roundTime } from '../lib/drand.js';
import { settleRecharge } from '../lib/recharges.js';

import {resolveDraw} from '../lib/resolveDraw.js';
import {paymentMethods} from '../lib/paymentStatus.js';
import {reconcilePayment} from '../lib/reconcilePayments.js';
import {bad} from '../lib/operations.js';
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
      SELECT o.*, p.name, p.sku, p.emoji, p.total_shares, p.status AS product_status,
             d.win_number, d.winner_user_id, d.drawn_at,
             CASE WHEN d.winner_user_id=o.user_id THEN d.win_address END AS address
      FROM orders o JOIN products p ON p.id=o.product_id
      LEFT JOIN draws d ON d.product_id=o.product_id
      WHERE o.user_id=$1 ORDER BY o.created_at DESC`, [req.user.id]);
    res.json({ ok: true, orders: rows });
  } catch (e) { next(e); }
});

router.get('/purchases/:key',requireAuth,async(req,res,next)=>{try{
 const {rows}=await pool.query('SELECT response FROM purchase_receipts WHERE user_id=$1 AND request_key=$2',[req.user.id,req.params.key]);
 res.json({ok:true,order:rows[0]?.response||null});
}catch(e){next(e)}});

// 购买（夺宝）
router.post('/buy', requireAuth, async (req, res, next) => {
  try {
    const uid = req.user.id;
    const { productId } = req.body || {};
    const shares = Number(req.body?.shares);
    if (!Number.isSafeInteger(shares) || shares < 1 || shares > 10000)
      return res.status(400).json({ ok: false, msg: '单次参与份数须为1~10000的整数' });
    const useFree = req.body?.useFree !== false;
    const requestKey=req.body?.requestKey;
    if(requestKey!==undefined && (typeof requestKey!=='string'||!/^[-A-Za-z0-9_]{16,80}$/.test(requestKey)))throw bad('购买请求编号无效');

    const result = await withTransaction(async (client) => {
      // 同一商品的号码分配串行执行；跨商品购买再锁用户，保护免费余额。
      const { rows: lockedProducts } = await client.query(`SELECT * FROM products WHERE id=$1 FOR UPDATE`, [productId]);
      const p = lockedProducts[0];
      if(!p)throw bad('商品不存在',404);
      await client.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [uid]);
      const activeUser=(await client.query('SELECT disabled FROM users WHERE id=$1',[uid])).rows[0];
      if(activeUser?.disabled)throw bad('账号已停用',403);
      if(requestKey){
        const old=(await client.query('SELECT * FROM purchase_receipts WHERE user_id=$1 AND request_key=$2',[uid,requestKey])).rows[0];
        if(old){
          if(old.response.cancelled)throw bad('原订单已退款，请重新发起购买',409);
          if(old.product_id!==productId||Number(old.shares)!==shares||old.use_free!==useFree)throw bad('请求编号已用于其他订单',409);
          return {...old.response,replayed:true};
        }
      }
      if(!Number.isSafeInteger(Number(p.price_per_share))||Number(p.price_per_share)<1)throw bad('商品价格无效，请联系管理员');
      if(p.status!=='active')throw bad('该商品已停止参与');

      const pricePerShare = Number(p.price_per_share);
      const cost = shares * pricePerShare;
      if (!Number.isSafeInteger(cost) || cost > 2147483647)
        throw Object.assign(new Error('单次购买金额超出上限'), { status: 400 });
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
            if (productFreeLeft < 1) quotaOk = false;
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
        await walletTx(uid,'grant',-freeUse,`免费参与 ${p.name} ${shares}份`,client);
        await client.query(
          `UPDATE products SET free_used=free_used+1 WHERE id=$1`, [productId]);
      }
      if (paidUse > 0) await walletTx(uid, 'spend', -paidUse, `购买 ${p.name} ${shares}份`, client);

      const orderId = genId('o_');
      await client.query(
        `INSERT INTO orders (id,user_id,product_id,shares,numbers,paid_coins,free_coins,created_at,request_key,use_free)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [orderId, uid, productId, shares, JSON.stringify(numbers), paidUse, freeUse, Date.now(), requestKey||null,useFree]);

      const newSold = sold2 + shares;
      let locked = null;
      if (newSold >= p.total_shares) {
        const cfg = await getConfig(client);
        const delayMin = Number(cfg.drawDelay) || 10;
        const round = futureRound(Date.now(), delayMin * 60);
        await client.query(
          `INSERT INTO draws (product_id,round,total_shares,locked_at) VALUES ($1,$2,$3,$4)`,
          [productId, round, p.total_shares, Date.now()]);
        await client.query(`UPDATE products SET status='drawing' WHERE id=$1`, [productId]);
        locked = { round, drawTime: roundTime(round) };
      }
      const result={ orderId, numbers, freeUse, paidUse, newSold, locked, totalShares: p.total_shares };
      if(requestKey)await client.query('INSERT INTO purchase_receipts (user_id,request_key,product_id,shares,use_free,response,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',[uid,requestKey,productId,shares,useFree,JSON.stringify(result),Date.now()]);
      return result;
    });

    res.json({
      ok: true, msg: '参与成功',
      numbers: result.numbers, usedFree: result.freeUse, usedPaid: result.paidUse,
      orderId: result.orderId, freeUsed: result.freeUse, paidUsed: result.paidUse,
      sold: result.newSold, totalShares: result.totalShares,
      drawing: result.locked, replayed:!!result.replayed,
    });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, msg: e.status&&e.status<500?e.message:'购买结果暂未确认，请使用原请求重试或查看参与记录' });
  }
});

// 签到
router.post('/checkin', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const todayMs = Math.floor((Date.now()+8*3600000)/86400000)*86400000-8*3600000;

    const result = await withTransaction(async (client) => {
      await client.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [uid]);
      const { rows: already } = await client.query(
        `SELECT id FROM checkins WHERE user_id=$1 AND created_at>=$2`, [uid, todayMs]);
      if (already.length) return null;
      const { rows: yest } = await client.query(
        `SELECT streak FROM checkins WHERE user_id=$1 AND created_at>=$2 AND created_at<$3 ORDER BY created_at DESC LIMIT 1`,
        [uid, todayMs - 86400000, todayMs]);
      const streak = (yest.length ? yest[0].streak : 0) + 1;
      const cfg = await getConfig(client);
      const reward = Math.min(streak, 7) * Number(cfg.grantCheckin ?? 2);
      await client.query(
        `INSERT INTO checkins (id,user_id,reward,streak,created_at) VALUES ($1,$2,$3,$4,$5)`,
        [genId('ck_'), uid, reward, streak, Date.now()]);
      await walletTx(uid, 'grant', reward, '每日签到', client);
      return { streak, reward };
    });
    if (!result) return res.json({ ok: false, msg: '今天已签到' });
    const { streak, reward } = result;

    res.json({ ok: true, msg: `签到成功！连续${streak}天，获得${reward}免费金币`, streak, reward });
  } catch (e) {
    res.status(500).json({ ok: false, msg: '签到失败' });
  }
});

// 签到状态
router.get('/checkin-status', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const todayMs = Math.floor((Date.now()+8*3600000)/86400000)*86400000-8*3600000;

    const { rows: today } = await pool.query(
      `SELECT id FROM checkins WHERE user_id=$1 AND created_at>=$2`, [uid, todayMs]);
    const checkedIn = today.length > 0;

    const { rows: last } = await pool.query(
      `SELECT streak, reward, created_at FROM checkins WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [uid]);
    const streak = last.length > 0 && Number(last[0].created_at)>=todayMs-86400000 ? last[0].streak : 0;

    res.json({ ok: true, checkedIn, streak, timeZone:'Asia/Shanghai',nextCheckinAt:todayMs+86400000 });
  } catch (e) {
    res.status(500).json({ ok: false, msg: '获取签到状态失败' });
  }
});

// 充值套餐
router.get('/packages', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT v FROM config WHERE k='recharge_packages'`);
    const packages = rows[0] ? JSON.parse(rows[0].v) : [
      { amount: 10, bonus: 1 }, { amount: 50, bonus: 5 },
      { amount: 100, bonus: 15 }, { amount: 200, bonus: 40 },
    ];
    res.json({ ok: true, packages, methods:paymentMethods() });
  } catch (e) { next(e); }
});

// 充值
router.post('/recharge', requireAuth, async (req, res, next) => {
  let rid;
  try {
    const amount = Number(req.body?.amount);
    if(!Number.isSafeInteger(amount))throw bad('充值金额必须为整数');
    const method = req.body?.method || 'stripe';
    if (!['stripe', 'paypal'].includes(method)) return res.status(400).json({ ok: false, msg: '不支持的支付方式' });
    if (amount < 1) return res.status(400).json({ ok: false, msg: '充值金额至少 $1' });
    if (amount > 5000) return res.status(400).json({ ok: false, msg: '单次充值上限 $5000' });

    const { rows: pkgRows } = await pool.query(`SELECT v FROM config WHERE k='recharge_packages'`);
    const packages = pkgRows[0] ? JSON.parse(pkgRows[0].v) : [];
    const pkg = packages.find(p => p.amount === amount);
    const bonus = pkg ? (pkg.bonus || 0) : 0;

    const methods=paymentMethods();
    const demo=process.env.NODE_ENV!=='production'&&process.env.ALLOW_DEMO_PAYMENTS==='true'&&!methods.stripe&&!methods.paypal;
    if(!methods[method]&&!demo)return res.status(503).json({ok:false,msg:'此支付方式暂未开通，请稍后再试'});
    rid = genId('rc_');
    await pool.query(
      `INSERT INTO recharges (id,user_id,amount,bonus,method,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [rid, req.user.id, amount, bonus, method, 'pending', Date.now()]);

    const origin = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
    const successUrl = `${origin}/recharge.html?result=success&id=${rid}`;
    const cancelUrl = `${origin}/recharge.html?result=cancel`;

    const hasStripe = !!process.env.STRIPE_SECRET_KEY;
    const hasPaypal = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET);

    if ((method === 'stripe' && !hasStripe) || (method === 'paypal' && !hasPaypal)) {
      if (!hasStripe && !hasPaypal && process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEMO_PAYMENTS === 'true') {
        await withTransaction(async (client) => {
          await walletTx(req.user.id, 'recharge', amount, `模拟充值 $${amount}`, client);
          if (bonus > 0) await walletTx(req.user.id, 'grant', bonus, `充值赠送 $${bonus}`, client);
          await client.query(`UPDATE recharges SET status='paid',paid_at=$1 WHERE id=$2`, [Date.now(), rid]);
        });
        const total = amount + bonus;
        return res.json({ ok: true, simulated: true, msg: `已模拟到账 $${total}（含赠送 $${bonus}）`, rechargeId: rid });
      }
      return res.status(400).json({ ok: false, msg: `${method === 'stripe' ? 'Stripe' : 'PayPal'} 支付暂未开通` });
    }

    if (method === 'paypal') {
      const paypal = await import('../lib/paypal.js');
      const order = await paypal.createOrder(amount, rid, `${origin}/api/wallet/paypal-return`, cancelUrl);
      if (!order?.approveUrl) throw new Error('PayPal 服务不可用');
      await pool.query(`UPDATE recharges SET stripe_session=$1 WHERE id=$2`, [order.orderId, rid]);
      return res.json({ ok: true, url: order.approveUrl, rechargeId: rid });
    }

    // Stripe
    const key = process.env.STRIPE_SECRET_KEY;
    if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error('Stripe 支付回调尚未配置');
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
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': rid },
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    const s = await r.json();
    if (!r.ok) throw new Error(s.error?.message || 'Stripe 创建会话失败');
    await pool.query(`UPDATE recharges SET stripe_session=$1 WHERE id=$2`, [s.id, rid]);
    res.json({ ok: true, url: s.url, rechargeId: rid });
  } catch (e) {
    if (rid) await pool.query(`UPDATE recharges SET status='failed' WHERE id=$1 AND status='pending'`, [rid]).catch(() => {});
    res.status(e.status||502).json({ok:false,msg:e.status&&e.status<500?e.message:'支付服务暂时不可用，请稍后查询充值记录'});
  }
});

// PayPal 回调
router.get('/paypal-return', requireAuth, async (req, res, next) => {
  try {
    const { token } = req.query;
    if (typeof token !== 'string' || !/^[A-Za-z0-9]+$/.test(token)) return res.redirect('/recharge.html?result=cancel');
    const { rows } = await pool.query(
      `SELECT * FROM recharges WHERE stripe_session=$1 AND method='paypal' AND user_id=$2`, [token, req.user.id]);
    const rc = rows[0];
    if (!rc) return res.status(404).json({ ok: false, msg: '充值记录不存在' });
    if (rc.status === 'paid') return res.redirect(`/recharge.html?result=success&id=${rc.id}`);
    if (rc.status !== 'pending') return res.redirect('/recharge.html?result=cancel');
    try {
      await reconcilePayment(rc);
      const state=(await pool.query('SELECT status FROM recharges WHERE id=$1',[rc.id])).rows[0]?.status;
      if(state!=='paid')return res.redirect(`/recharge.html?result=pending&id=${rc.id}`);
    } catch (e) {
      console.error('[paypal capture]', e.message);
      return res.redirect(`/recharge.html?result=pending&id=${rc.id}`);
    }
    res.redirect(`/recharge.html?result=success&id=${rc.id}`);
  } catch (e) { next(e); }
});

router.get('/recharges/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id,amount,bonus,status FROM recharges WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ ok: false, msg: '充值记录不存在' });
    res.json({ ok: true, recharge: rows[0] });
  } catch (e) { next(e); }
});

// 中奖人填写收货地址
router.post('/address', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const { rows: dr } = await pool.query(`SELECT * FROM draws WHERE product_id=$1`, [b.productId]);
    const d = dr[0];
    if (!d || !d.winner_user_id) return res.status(400).json({ ok: false, msg: '尚未揭晓' });
    if (d.winner_user_id !== req.user.id)
      return res.status(403).json({ ok: false, msg: '非幸运儿本人' });
    if (!b.name || !b.address)
      return res.status(400).json({ ok: false, msg: '收件人和地址为必填' });

    const addr = {
      name: b.name, phone: b.phone || '', country: b.country,
      state: b.state || '', city: b.city || '', address: b.address,
      zip: b.zip || '', filledAt: Date.now(),
    };
    const changed=await pool.query(`UPDATE draws SET win_address=$1 WHERE product_id=$2 AND winner_user_id=$3 AND ship_status='pending' RETURNING product_id`,
      [JSON.stringify(addr), b.productId,req.user.id]);
    if(!changed.rows.length)throw bad('订单已发货或状态已变化，请联系管理员修改地址');
    res.json({ ok: true, msg: '收货地址已提交，我们将尽快发货' });
  } catch (e) { next(e); }
});

// 触发开奖
router.post('/draw/:productId', requireAuth, async (req, res, next) => {
  try {
    const pid = req.params.productId;
    const { rows: dr } = await pool.query(`SELECT * FROM draws WHERE product_id=$1`, [pid]);
    const d = dr[0];
    if (!d) return res.status(404).json({ ok: false, msg: '该商品未进入揭晓' });
    if (d.drawn_at) return res.json({ ok: true, done: true, draw: publicDraw(d) });

    const fresh=await resolveDraw(pid);
    res.json({ok:true,done:!!fresh?.drawn_at,draw:fresh?publicDraw(fresh):null,drawTime:fresh?roundTime(fresh.round):null});
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

router.get('/recharges',requireAuth,async(req,res,next)=>{try{const page=Math.max(1,parseInt(req.query.page)||1);const {rows}=await pool.query('SELECT id,amount,bonus,method,status,created_at,paid_at FROM recharges WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30 OFFSET $2',[req.user.id,(page-1)*30]);res.json({ok:true,recharges:rows,page})}catch(e){next(e)}});
router.post('/recharges/:id/refresh',requireAuth,async(req,res,next)=>{try{const rc=(await pool.query('SELECT * FROM recharges WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id])).rows[0];if(!rc)throw bad('充值记录不存在',404);await reconcilePayment(rc);const fresh=(await pool.query('SELECT id,amount,bonus,status FROM recharges WHERE id=$1',[rc.id])).rows[0];res.json({ok:true,recharge:fresh})}catch(e){next(e)}});
