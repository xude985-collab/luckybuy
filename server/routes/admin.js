/* 管理后台接口。全部要求 admin 角色。 */
import express from 'express';
import pool from '../db.js';
import { attachUser, requireAdmin, getConfig, genId, withTransaction } from '../lib/helpers.js';
import { fetchAmazon } from '../lib/amazon.js';
import { fetchSaleyee } from '../lib/saleyee.js';
import { fetchDoba } from '../lib/doba.js';

const router = express.Router();
router.use(attachUser);

async function nextSku(category, client) {
  const q = client || pool;
  const { rows: catRows } = await q.query(`SELECT prefix FROM categories WHERE key=$1`, [category]);
  const prefix = catRows[0] ? catRows[0].prefix : 'OT';
  await q.query(
    `INSERT INTO sku_seq (prefix,n) VALUES ($1,1) ON CONFLICT(prefix) DO UPDATE SET n=sku_seq.n+1`,
    [prefix]);
  const { rows: seqRows } = await q.query(`SELECT n FROM sku_seq WHERE prefix=$1`, [prefix]);
  return prefix + String(seqRows[0].n).padStart(4, '0');
}

const clampInt = (v, min, def) => Math.max(min, parseInt(v) || def);

// 后台概览
router.get('/overview', requireAdmin, async (req, res, next) => {
  try {
    const users = (await pool.query(`SELECT COUNT(*) c FROM users`)).rows[0].c;
    const products = (await pool.query(`SELECT COUNT(*) c FROM products`)).rows[0].c;
    const orders = (await pool.query(`SELECT COUNT(*) c FROM orders`)).rows[0].c;
    const revenue = (await pool.query(`SELECT COALESCE(SUM(paid_coins),0) s FROM orders`)).rows[0].s;
    const config = await getConfig();
    res.json({ ok: true, stats: { users: Number(users), products: Number(products), orders: Number(orders), revenue: Number(revenue) }, config });
  } catch (e) { next(e); }
});

// 最近订单（dashboard 用）
router.get('/recent-orders', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.shares, o.paid_coins, o.free_coins, o.created_at, u.account, p.name AS product_name
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN products p ON p.id = o.product_id
       ORDER BY o.created_at DESC LIMIT 20`);
    res.json({ ok: true, orders: rows });
  } catch (e) { next(e); }
});

// 送币规则读写
router.get('/config', requireAdmin, async (req, res, next) => {
  try { res.json({ ok: true, config: await getConfig() }); }
  catch (e) { next(e); }
});

router.post('/config', requireAdmin, async (req, res, next) => {
  try {
    const allowed = ['grantRegister', 'grantCheckin', 'grantShowcase', 'grantInvitee', 'grantInviter'];
    for (const k of allowed) {
      if (req.body[k] != null) {
        await pool.query(
          `INSERT INTO config (k,v) VALUES ($1,$2) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`,
          [k, String(Math.max(0, parseInt(req.body[k]) || 0))]);
      }
    }
    if (req.body.recharge_packages != null) {
      await pool.query(
        `INSERT INTO config (k,v) VALUES ($1,$2) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`,
        ['recharge_packages', JSON.stringify(req.body.recharge_packages)]);
    }
    if (req.body.doba_cookie != null) {
      await pool.query(
        `INSERT INTO config (k,v) VALUES ($1,$2) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`,
        ['doba_cookie', String(req.body.doba_cookie).trim()]);
    }
    res.json({ ok: true, config: await getConfig() });
  } catch (e) { next(e); }
});

// ---- 商品管理 ----
router.get('/products', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, COALESCE(s.total,0) AS sold FROM products p
       LEFT JOIN (SELECT product_id, SUM(shares) AS total FROM orders GROUP BY product_id) s
         ON s.product_id=p.id
       ORDER BY p.created_at DESC`);
    res.json({ ok: true, products: rows.map(p => ({ ...p, sold: Number(p.sold) })) });
  } catch (e) { next(e); }
});

router.post('/products', requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.category) return res.status(400).json({ ok: false, msg: '缺少名称或类别' });

    const pricePerShare = clampInt(b.pricePerShare, 1, 1);
    const totalShares = clampInt(b.totalShares, 1, 1);
    const freeQuota = Math.min(clampInt(b.freeQuota, 0, 0), totalShares);
    const gallery = JSON.stringify(Array.isArray(b.gallery) ? b.gallery : []);
    const specs = JSON.stringify(Array.isArray(b.specs) ? b.specs : []);

    if (b.id) {
      const { rows: cur } = await pool.query(`SELECT * FROM products WHERE id=$1`, [b.id]);
      if (!cur.length) return res.status(404).json({ ok: false, msg: '商品不存在' });
      if (cur[0].status !== 'active' && (totalShares !== cur[0].total_shares || pricePerShare !== cur[0].price_per_share))
        return res.status(400).json({ ok: false, msg: '揭晓中/已结束的商品不能改价格或份数' });
      await pool.query(
        `UPDATE products SET name=$1,category=$2,emoji=$3,price_per_share=$4,total_shares=$5,
         free_quota=$6,"desc"=$7,gallery=$8,specs=$9,source_url=$10 WHERE id=$11`,
        [b.name, b.category, b.emoji || '🎁', pricePerShare, totalShares,
         freeQuota, b.desc || '', gallery, specs, b.sourceUrl || '', b.id]);
      return res.json({ ok: true, id: b.id, msg: '已更新' });
    }

    const id = genId('p_');
    const sku = await nextSku(b.category);
    await pool.query(
      `INSERT INTO products (id,sku,name,category,emoji,price_per_share,total_shares,free_quota,free_used,"desc",gallery,specs,source_url,status,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12,'active',$13)`,
      [id, sku, b.name, b.category, b.emoji || '🎁', pricePerShare, totalShares,
       freeQuota, b.desc || '', gallery, specs, b.sourceUrl || '', Date.now()]);
    res.json({ ok: true, id, sku, msg: '已上架' });
  } catch (e) { next(e); }
});

router.delete('/products/:id', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*) c FROM orders WHERE product_id=$1`, [req.params.id]);
    if (Number(rows[0].c) > 0) return res.status(400).json({ ok: false, msg: '已有参与记录，不能删除' });
    await pool.query(`DELETE FROM products WHERE id=$1`, [req.params.id]);
    res.json({ ok: true, msg: '已删除' });
  } catch (e) { next(e); }
});

// ---- 调试：dump Doba productDetail 原始 JSON（部署后删除） ----
router.post('/debug-doba', requireAdmin, async (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!url) return res.status(400).json({ ok: false, msg: '请填写 Doba 链接' });
  try {
    const { parseDobaUrl } = await import('../lib/doba.js');
    const parsed = parseDobaUrl(url);
    if (!parsed) return res.status(400).json({ ok: false, msg: '无效 Doba 链接' });

    const { rows } = await pool.query(`SELECT v FROM config WHERE k='doba_cookie'`);
    const cookie = rows[0]?.v || '';

    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Cookie': cookie },
      signal: AbortSignal.timeout(15000),
    });
    const html = await resp.text();
    const m = html.match(/__NEXT_DATA__[^>]*>([\s\S]*?)<\/script/);
    if (!m) return res.status(502).json({ ok: false, msg: '未找到 __NEXT_DATA__' });
    const data = JSON.parse(m[1]);
    const pd = data?.props?.pageProps?.productDetail;
    if (!pd) return res.status(502).json({ ok: false, msg: 'productDetail 为空', raw: data?.props?.pageProps });

    // 返回所有含 price/sale/discount 的字段
    const priceFields = {};
    for (const [k, v] of Object.entries(pd)) {
      if (/price|sale|discount|cost|profit|promotion|flash/i.test(k)) {
        priceFields[k] = v;
      }
    }
    // 也看 selectedSku
    const skuFields = {};
    if (pd.selectedSku) {
      for (const [k, v] of Object.entries(pd.selectedSku)) {
        if (/price|sale|discount|cost|profit|promotion|flash/i.test(k)) {
          skuFields[k] = v;
        }
      }
    }

    res.json({ ok: true, priceFields, skuFields, allTopKeys: Object.keys(pd) });
  } catch (e) {
    res.status(502).json({ ok: false, msg: e.message });
  }
});

// ---- 商品链接导入（赛盈 / 亚马逊） ----
router.post('/import-product', requireAdmin, async (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!url) return res.status(400).json({ ok: false, msg: '请填写商品链接' });

  try {
    let draft;
    if (/saleyee\.com/i.test(url)) {
      draft = await fetchSaleyee(url);
    } else if (/doba\.com/i.test(url)) {
      draft = await fetchDoba(url);
    } else if (/amazon\./i.test(url)) {
      draft = await fetchAmazon(url);
    } else {
      return res.status(400).json({ ok: false, msg: '不支持的链接，目前支持赛盈(saleyee.com)、Doba 和亚马逊' });
    }
    res.json({ ok: true, draft });
  } catch (e) {
    res.status(502).json({ ok: false, msg: '导入失败：' + (e.message || '可稍后重试或手动录入') });
  }
});

// 兼容旧接口
router.post('/import-amazon', requireAdmin, async (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!/^https?:\/\/.*amazon\./i.test(url))
    return res.status(400).json({ ok: false, msg: '请填写有效的亚马逊商品链接' });
  try {
    const draft = await fetchAmazon(url);
    res.json({ ok: true, draft });
  } catch (e) {
    res.status(502).json({ ok: false, msg: '抓取失败：' + (e.message || '可稍后重试或手动录入') });
  }
});

// ---- 类别管理 ----
router.post('/categories', requireAdmin, async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim();
    const prefix = (req.body?.prefix || '').trim().toUpperCase();
    const icon = (req.body?.icon || '🏷️').trim() || '🏷️';
    if (!name) return res.status(400).json({ ok: false, msg: '请填写类别名称' });
    if (!/^[A-Z0-9]{2,4}$/.test(prefix)) return res.status(400).json({ ok: false, msg: '编号前缀须为 2~4 位字母或数字' });
    const { rows: dup } = await pool.query(`SELECT 1 FROM categories WHERE prefix=$1`, [prefix]);
    if (dup.length) return res.status(400).json({ ok: false, msg: `前缀 ${prefix} 已被占用` });

    let key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cat';
    while ((await pool.query(`SELECT 1 FROM categories WHERE key=$1`, [key])).rows.length) key += '-x';

    const { rows: maxRows } = await pool.query(`SELECT COALESCE(MAX(sort),0) AS m FROM categories`);
    const sort = Number(maxRows[0].m) + 1;
    await pool.query(`INSERT INTO categories (key,name,prefix,icon,sort) VALUES ($1,$2,$3,$4,$5)`,
      [key, name, prefix, icon, sort]);
    res.json({ ok: true, key, msg: '已添加类别' });
  } catch (e) { next(e); }
});

router.delete('/categories/:key', requireAdmin, async (req, res, next) => {
  try {
    const key = req.params.key;
    const { rows: used } = await pool.query(`SELECT COUNT(*) c FROM products WHERE category=$1`, [key]);
    if (Number(used[0].c) > 0) return res.status(400).json({ ok: false, msg: `该类别下有商品，请先下架后再删` });
    const { rows: total } = await pool.query(`SELECT COUNT(*) c FROM categories`);
    if (Number(total[0].c) <= 1) return res.status(400).json({ ok: false, msg: '至少保留一个类别' });
    await pool.query(`DELETE FROM categories WHERE key=$1`, [key]);
    res.json({ ok: true, msg: '已删除类别' });
  } catch (e) { next(e); }
});

router.put('/categories/:key', requireAdmin, async (req, res, next) => {
  try {
    const key = req.params.key;
    const name = (req.body?.name || '').trim();
    const icon = (req.body?.icon || '').trim();
    if (!name) return res.status(400).json({ ok: false, msg: '名称不能为空' });
    const sets = ['name=$1'];
    const vals = [name];
    if (icon) { sets.push(`icon=$${sets.length + 1}`); vals.push(icon); }
    vals.push(key);
    await pool.query(`UPDATE categories SET ${sets.join(',')} WHERE key=$${vals.length}`, vals);
    res.json({ ok: true, msg: '已更新类别' });
  } catch (e) { next(e); }
});

router.post('/categories/reorder', requireAdmin, async (req, res, next) => {
  try {
    const keys = req.body?.keys;
    if (!Array.isArray(keys) || !keys.length) return res.status(400).json({ ok: false, msg: '缺少排序数据' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < keys.length; i++) {
        await client.query(`UPDATE categories SET sort=$1 WHERE key=$2`, [i, keys[i]]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true, msg: '排序已保存' });
  } catch (e) { next(e); }
});

// ---- 重置所有购买数据 ----
router.post('/reset-orders', requireAdmin, async (req, res, next) => {
  try {
    await withTransaction(async (client) => {
      // 把用户花掉的免费金币加回去
      await client.query(
        `UPDATE users SET free_balance = free_balance + COALESCE((
          SELECT SUM(free_coins) FROM orders WHERE orders.user_id = users.id
        ), 0)`);
      // 把用户花掉的充值金币加回去
      await client.query(
        `UPDATE users SET paid_balance = paid_balance + COALESCE((
          SELECT SUM(paid_coins) FROM orders WHERE orders.user_id = users.id
        ), 0)`);
      // 清订单
      await client.query(`DELETE FROM orders`);
      // 清开奖记录
      await client.query(`DELETE FROM draws`);
      // 重置商品状态
      await client.query(`UPDATE products SET free_used=0, status='active'`);
      // 清除消费类的钱包流水
      await client.query(`DELETE FROM wallet_tx WHERE kind='spend'`);
    });
    res.json({ ok: true, msg: '已重置所有购买数据，金币已退回' });
  } catch (e) { next(e); }
});

// 手动修正用户余额
router.post('/fix-balance', requireAdmin, async (req, res, next) => {
  try {
    const { userId, paidBalance, freeBalance } = req.body || {};
    if (!userId) return res.status(400).json({ ok: false, msg: '缺少 userId' });
    const sets = [];
    const vals = [];
    let i = 1;
    if (paidBalance !== undefined) { sets.push(`paid_balance=$${i++}`); vals.push(Number(paidBalance)); }
    if (freeBalance !== undefined) { sets.push(`free_balance=$${i++}`); vals.push(Number(freeBalance)); }
    if (!sets.length) return res.status(400).json({ ok: false, msg: '需指定 paidBalance 或 freeBalance' });
    vals.push(userId);
    await pool.query(`UPDATE users SET ${sets.join(',')} WHERE id=$${i}`, vals);
    res.json({ ok: true, msg: '余额已修正' });
  } catch (e) { next(e); }
});

// 重置单个商品的销售记录
router.post('/reset-product/:productId', requireAdmin, async (req, res, next) => {
  try {
    const { productId } = req.params;
    await withTransaction(async (client) => {
      // 获取该商品的所有订单，退回金币
      const { rows: orders } = await client.query(
        `SELECT user_id, free_coins, paid_coins FROM orders WHERE product_id=$1`, [productId]);

      for (const o of orders) {
        if (o.free_coins > 0) {
          await client.query(
            `UPDATE users SET free_balance = free_balance + $1 WHERE id = $2`,
            [o.free_coins, o.user_id]);
        }
        if (o.paid_coins > 0) {
          await client.query(
            `UPDATE users SET paid_balance = paid_balance + $1 WHERE id = $2`,
            [o.paid_coins, o.user_id]);
        }
      }

      // 删除该商品的订单
      await client.query(`DELETE FROM orders WHERE product_id=$1`, [productId]);
      // 删除该商品的开奖记录
      await client.query(`DELETE FROM draws WHERE product_id=$1`, [productId]);
      // 重置商品状态和免费金币使用记录
      await client.query(
        `UPDATE products SET free_used=0, status='active' WHERE id=$1`, [productId]);
      // 清除该商品相关的消费流水
      await client.query(
        `DELETE FROM wallet_tx WHERE kind='spend' AND ref LIKE '%' || (SELECT name FROM products WHERE id=$1) || '%'`,
        [productId]);
    });
    res.json({ ok: true, msg: '商品销售记录已重置，金币已退回' });
  } catch (e) { next(e); }
});

// 手动修正商品 free_used
router.post('/fix-product-free', requireAdmin, async (req, res, next) => {
  try {
    const { productId, freeUsed } = req.body || {};
    if (!productId) return res.status(400).json({ ok: false, msg: '缺少 productId' });
    if (freeUsed === undefined) return res.status(400).json({ ok: false, msg: '缺少 freeUsed' });
    await pool.query(`UPDATE products SET free_used=$1 WHERE id=$2`, [Number(freeUsed), productId]);
    res.json({ ok: true, msg: 'free_used 已修正' });
  } catch (e) { next(e); }
});

// ---- 用户管理 ----
router.get('/users', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id,account,name,role,paid_balance,created_at FROM users ORDER BY created_at DESC LIMIT 100`);
    res.json({ ok: true, users: rows });
  } catch (e) { next(e); }
});

router.post('/users/:id/rename', requireAdmin, async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, msg: '名称不能为空' });
    await pool.query(`UPDATE users SET name=$1 WHERE id=$2`, [name, req.params.id]);
    res.json({ ok: true, msg: '昵称已修改' });
  } catch (e) { next(e); }
});

router.post('/users/:id/reset-pwd', requireAdmin, async (req, res, next) => {
  try {
    const password = (req.body?.password || '').trim();
    if (!password || password.length < 4) return res.status(400).json({ ok: false, msg: '密码至少4位' });
    const { default: bcrypt } = await import('bcryptjs');
    const hash = bcrypt.hashSync(password, 10);
    await pool.query(`UPDATE users SET pass_hash=$1 WHERE id=$2`, [hash, req.params.id]);
    res.json({ ok: true, msg: '密码已重置' });
  } catch (e) { next(e); }
});

router.delete('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const uid = req.params.id;
    const { rows } = await pool.query(`SELECT role FROM users WHERE id=$1`, [uid]);
    if (rows[0]?.role === 'admin') return res.status(400).json({ ok: false, msg: '不能删除管理员' });
    await pool.query(`DELETE FROM users WHERE id=$1`, [uid]);
    res.json({ ok: true, msg: '用户已删除' });
  } catch (e) { next(e); }
});

// ---- 中奖订单管理 ----
router.get('/wins', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.product_id, d.win_number, d.winner_user_id, d.win_address,
              d.drawn_at, d.ship_status, d.ship_note,
              p.name AS product_name, p.sku,
              u.account AS winner_account, u.name AS winner_name
       FROM draws d
       LEFT JOIN products p ON p.id = d.product_id
       LEFT JOIN users u ON u.id = d.winner_user_id
       WHERE d.winner_user_id IS NOT NULL
       ORDER BY d.drawn_at DESC`);
    res.json({ ok: true, wins: rows });
  } catch (e) { next(e); }
});

router.post('/wins/:productId/ship', requireAdmin, async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { status, note } = req.body || {};
    const validStatus = ['pending', 'shipped', 'done'];
    if (!validStatus.includes(status)) return res.status(400).json({ ok: false, msg: '无效状态' });
    await pool.query(
      `UPDATE draws SET ship_status=$1, ship_note=$2 WHERE product_id=$3`,
      [status, note || null, productId]);
    res.json({ ok: true, msg: '已更新' });
  } catch (e) { next(e); }
});

export default router;
