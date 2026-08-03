/* 管理后台接口。全部要求 admin 角色。商品/类别/导入在 Task #3 充实。 */
import express from 'express';
import db from '../db.js';
import { attachUser, requireAdmin, getConfig, genId, tx } from '../lib/helpers.js';
import { fetchAmazon } from '../lib/amazon.js';

const router = express.Router();
router.use(attachUser);

// 按类别 prefix 生成自增 SKU，如 AP0001
function nextSku(category) {
  const cat = db.prepare(`SELECT prefix FROM categories WHERE key=?`).get(category);
  const prefix = cat ? cat.prefix : 'OT';
  db.prepare(`INSERT INTO sku_seq (prefix,n) VALUES (?,1)
    ON CONFLICT(prefix) DO UPDATE SET n=n+1`).run(prefix);
  const n = db.prepare(`SELECT n FROM sku_seq WHERE prefix=?`).get(prefix).n;
  return prefix + String(n).padStart(4, '0');
}

const clampInt = (v, min, def) => Math.max(min, parseInt(v) || def);

// 后台概览（登录门禁验证用）
router.get('/overview', requireAdmin, (req, res) => {
  const users = db.prepare(`SELECT COUNT(*) c FROM users`).get().c;
  const products = db.prepare(`SELECT COUNT(*) c FROM products`).get().c;
  const orders = db.prepare(`SELECT COUNT(*) c FROM orders`).get().c;
  const revenue = db.prepare(`SELECT COALESCE(SUM(paid_coins),0) s FROM orders`).get().s;
  res.json({ ok: true, stats: { users, products, orders, revenue }, config: getConfig() });
});

// 送币规则读写
router.get('/config', requireAdmin, (req, res) =>
  res.json({ ok: true, config: getConfig() }));

router.post('/config', requireAdmin, (req, res) => {
  const allowed = ['grantRegister', 'grantCheckin', 'grantShowcase', 'grantInvitee', 'grantInviter'];
  const up = db.prepare(`INSERT INTO config (k,v) VALUES (?,?)
    ON CONFLICT(k) DO UPDATE SET v=excluded.v`);
  for (const k of allowed) {
    if (req.body[k] != null) up.run(k, String(Math.max(0, parseInt(req.body[k]) || 0)));
  }
  if (req.body.recharge_packages != null) {
    up.run('recharge_packages', JSON.stringify(req.body.recharge_packages));
  }
  res.json({ ok: true, config: getConfig() });
});

// ---- 商品管理 ----

// 后台商品列表（含草稿/开奖中/已结束，比前台全）
router.get('/products', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT * FROM products ORDER BY created_at DESC`).all();
  const withSold = rows.map(p => ({
    ...p,
    sold: db.prepare(`SELECT COALESCE(SUM(shares),0) s FROM orders WHERE product_id=?`).get(p.id).s,
  }));
  res.json({ ok: true, products: withSold });
});

// 新建 / 更新商品
router.post('/products', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.category) return res.status(400).json({ ok: false, msg: '缺少名称或类别' });

  const pricePerShare = clampInt(b.pricePerShare, 1, 1);
  const totalShares = clampInt(b.totalShares, 1, 1);
  const freeQuota = Math.min(clampInt(b.freeQuota, 0, 0), totalShares); // 免费额度不得超总份数
  const gallery = JSON.stringify(Array.isArray(b.gallery) ? b.gallery : []);
  const specs = JSON.stringify(Array.isArray(b.specs) ? b.specs : []);

  if (b.id) {
    // 更新（已开奖/开奖中的不允许改份数结构）
    const cur = db.prepare(`SELECT * FROM products WHERE id=?`).get(b.id);
    if (!cur) return res.status(404).json({ ok: false, msg: '商品不存在' });
    if (cur.status !== 'active' && (totalShares !== cur.total_shares || pricePerShare !== cur.price_per_share))
      return res.status(400).json({ ok: false, msg: '开奖中/已结束的商品不能改价格或份数' });
    db.prepare(`UPDATE products SET name=?,category=?,emoji=?,price_per_share=?,total_shares=?,
      free_quota=?,desc=?,gallery=?,specs=?,source_url=? WHERE id=?`).run(
      b.name, b.category, b.emoji || '🎁', pricePerShare, totalShares,
      freeQuota, b.desc || '', gallery, specs, b.sourceUrl || '', b.id);
    return res.json({ ok: true, id: b.id, msg: '已更新' });
  }

  // 新建
  const id = genId('p_');
  const sku = nextSku(b.category);
  db.prepare(`INSERT INTO products
    (id,sku,name,category,emoji,price_per_share,total_shares,free_quota,free_used,
     desc,gallery,specs,source_url,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,'active',?)`).run(
    id, sku, b.name, b.category, b.emoji || '🎁', pricePerShare, totalShares,
    freeQuota, b.desc || '', gallery, specs, b.sourceUrl || '', Date.now());
  res.json({ ok: true, id, sku, msg: '已上架' });
});

// 删除商品（有订单的禁止删，避免资金对不上）
router.delete('/products/:id', requireAdmin, (req, res) => {
  const cnt = db.prepare(`SELECT COUNT(*) c FROM orders WHERE product_id=?`).get(req.params.id).c;
  if (cnt > 0) return res.status(400).json({ ok: false, msg: '已有参与记录，不能删除，可下架' });
  db.prepare(`DELETE FROM products WHERE id=?`).run(req.params.id);
  res.json({ ok: true, msg: '已删除' });
});

// ---- 亚马逊导入 ----
// 传 { url }，后端抓取解析，返回可编辑的商品草稿（不直接入库，管理员确认后再 POST /products）
router.post('/import-amazon', requireAdmin, async (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!/^https?:\/\/.*amazon\./i.test(url))
    return res.status(400).json({ ok: false, msg: '请填写有效的亚马逊商品链接' });
  try {
    const draft = await fetchAmazon(url);
    res.json({ ok: true, draft });
  } catch (e) {
    res.status(502).json({ ok: false, msg: '抓取失败：' + (e.message || '亚马逊可能拦截了请求，可稍后重试或手动录入') });
  }
});

// ---- 类别管理 ----
router.post('/categories', requireAdmin, (req, res) => {
  const name = (req.body?.name || '').trim();
  const prefix = (req.body?.prefix || '').trim().toUpperCase();
  const icon = (req.body?.icon || '🏷️').trim() || '🏷️';
  if (!name) return res.status(400).json({ ok: false, msg: '请填写类别名称' });
  if (!/^[A-Z0-9]{2,4}$/.test(prefix)) return res.status(400).json({ ok: false, msg: '编号前缀须为 2~4 位字母或数字' });
  if (db.prepare(`SELECT 1 FROM categories WHERE prefix=?`).get(prefix))
    return res.status(400).json({ ok: false, msg: `前缀 ${prefix} 已被占用` });
  let key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cat';
  while (db.prepare(`SELECT 1 FROM categories WHERE key=?`).get(key)) key += '-x';
  const sort = (db.prepare(`SELECT COALESCE(MAX(sort),0) m FROM categories`).get().m) + 1;
  db.prepare(`INSERT INTO categories (key,name,prefix,icon,sort) VALUES (?,?,?,?,?)`)
    .run(key, name, prefix, icon, sort);
  res.json({ ok: true, key, msg: '已添加类别' });
});

router.delete('/categories/:key', requireAdmin, (req, res) => {
  const key = req.params.key;
  const used = db.prepare(`SELECT COUNT(*) c FROM products WHERE category=?`).get(key).c;
  if (used > 0) return res.status(400).json({ ok: false, msg: `该类别下有 ${used} 件商品，请先下架或改类后再删` });
  if (db.prepare(`SELECT COUNT(*) c FROM categories`).get().c <= 1)
    return res.status(400).json({ ok: false, msg: '至少保留一个类别' });
  db.prepare(`DELETE FROM categories WHERE key=?`).run(key);
  res.json({ ok: true, msg: '已删除类别' });
});

export default router;
