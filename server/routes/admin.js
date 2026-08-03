/* 管理后台接口。全部要求 admin 角色。 */
import express from 'express';
import pool from '../db.js';
import { attachUser, requireAdmin, getConfig, genId, withTransaction } from '../lib/helpers.js';
import { fetchAmazon } from '../lib/amazon.js';

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
        return res.status(400).json({ ok: false, msg: '开奖中/已结束的商品不能改价格或份数' });
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

// ---- 亚马逊导入 ----
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

// ---- 用户管理 ----
router.get('/users', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id,account,name,role,paid_balance,created_at FROM users ORDER BY created_at DESC LIMIT 100`);
    res.json({ ok: true, users: rows });
  } catch (e) { next(e); }
});

export default router;
