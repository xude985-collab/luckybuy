/* 商品 / 类别 / 详情 / 中奖动态（公开只读接口 + 需登录的购买/开奖在 wallet.js） */
import express from 'express';
import db from '../db.js';
import { attachUser } from '../lib/helpers.js';

const router = express.Router();
router.use(attachUser);

function parseProduct(p) {
  if (!p) return null;
  return {
    id: p.id, sku: p.sku, name: p.name, category: p.category, emoji: p.emoji,
    pricePerShare: p.price_per_share, totalShares: p.total_shares,
    freeQuota: p.free_quota, freeUsed: p.free_used,
    desc: p.desc || '',
    gallery: safeJSON(p.gallery, []),
    specs: safeJSON(p.specs, []),
    sourceUrl: p.source_url || '',
    status: p.status, createdAt: p.created_at,
    // 已售份数
    sold: db.prepare(`SELECT COALESCE(SUM(shares),0) s FROM orders WHERE product_id=?`)
      .get(p.id).s,
  };
}
function safeJSON(s, d) { try { return s ? JSON.parse(s) : d; } catch { return d; } }

// 类别列表
router.get('/categories', (req, res) => {
  const rows = db.prepare(`SELECT key,name,prefix,icon FROM categories ORDER BY sort,rowid`).all();
  res.json({ ok: true, categories: rows });
});

// 商品列表（可按 category 过滤）
router.get('/products', (req, res) => {
  const cat = req.query.category;
  const rows = cat
    ? db.prepare(`SELECT * FROM products WHERE category=? ORDER BY created_at DESC`).all(cat)
    : db.prepare(`SELECT * FROM products ORDER BY created_at DESC`).all();
  res.json({ ok: true, products: rows.map(parseProduct) });
});

// 单个商品详情
router.get('/products/:id', (req, res) => {
  const p = db.prepare(`SELECT * FROM products WHERE id=?`).get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, msg: '商品不存在' });
  const draw = db.prepare(`SELECT round,randomness,signature,win_number,winner_user_id,drawn_at
    FROM draws WHERE product_id=?`).get(p.id);
  res.json({ ok: true, product: parseProduct(p), draw: draw || null });
});

// 最近购买动态（实时抢购）
router.get('/recent-buys', (req, res) => {
  const rows = db.prepare(`
    SELECT o.shares, o.created_at, p.name AS product_name, p.emoji,
           u.name AS buyer_name
    FROM orders o
    JOIN products p ON p.id=o.product_id
    JOIN users u ON u.id=o.user_id
    ORDER BY o.created_at DESC LIMIT 30`).all();
  res.json({ ok: true, buys: rows });
});

// 公开配置（套餐、规则等前端需要的）
router.get('/config', (req, res) => {
  const rows = db.prepare(`SELECT k,v FROM config`).all();
  const config = {};
  for (const r of rows) {
    if (r.k === 'recharge_packages') config[r.k] = JSON.parse(r.v);
    else config[r.k] = /^\d+$/.test(r.v) ? Number(r.v) : r.v;
  }
  res.json({ ok: true, config });
});

// 最近中奖动态（跑马灯）
router.get('/winners', (req, res) => {
  const rows = db.prepare(`
    SELECT d.product_id, d.win_number, d.drawn_at, p.name, p.emoji,
           p.price_per_share AS price,
           u.name AS winner_name
    FROM draws d
    JOIN products p ON p.id=d.product_id
    LEFT JOIN users u ON u.id=d.winner_user_id
    WHERE d.drawn_at IS NOT NULL
    ORDER BY d.drawn_at DESC LIMIT 20`).all();
  res.json({ ok: true, winners: rows });
});

export default router;
