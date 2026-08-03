/* 商品 / 类别 / 详情 / 中奖动态（公开只读接口） */
import express from 'express';
import pool from '../db.js';
import { attachUser } from '../lib/helpers.js';

const router = express.Router();
router.use(attachUser);

function safeJSON(s, d) { try { return s ? JSON.parse(s) : d; } catch { return d; } }

function formatProduct(p) {
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
    sold: Number(p.sold || 0),
  };
}

// 类别列表
router.get('/categories', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT key,name,prefix,icon FROM categories ORDER BY sort`);
    res.json({ ok: true, categories: rows });
  } catch (e) { next(e); }
});

// 商品列表
router.get('/products', async (req, res, next) => {
  try {
    const cat = req.query.category;
    let rows;
    if (cat) {
      const r = await pool.query(
        `SELECT p.*, COALESCE(s.total,0) AS sold FROM products p
         LEFT JOIN (SELECT product_id, SUM(shares) AS total FROM orders GROUP BY product_id) s
           ON s.product_id=p.id
         WHERE p.category=$1 ORDER BY p.created_at DESC`, [cat]);
      rows = r.rows;
    } else {
      const r = await pool.query(
        `SELECT p.*, COALESCE(s.total,0) AS sold FROM products p
         LEFT JOIN (SELECT product_id, SUM(shares) AS total FROM orders GROUP BY product_id) s
           ON s.product_id=p.id
         ORDER BY p.created_at DESC`);
      rows = r.rows;
    }
    res.json({ ok: true, products: rows.map(formatProduct) });
  } catch (e) { next(e); }
});

// 单个商品详情
router.get('/products/:id', async (req, res, next) => {
  try {
    const { rows: pr } = await pool.query(
      `SELECT p.*, COALESCE(s.total,0) AS sold FROM products p
       LEFT JOIN (SELECT product_id, SUM(shares) AS total FROM orders GROUP BY product_id) s
         ON s.product_id=p.id
       WHERE p.id=$1`, [req.params.id]);
    const p = pr[0];
    if (!p) return res.status(404).json({ ok: false, msg: '商品不存在' });
    const { rows: dr } = await pool.query(
      `SELECT round,randomness,signature,win_number,winner_user_id,drawn_at FROM draws WHERE product_id=$1`, [p.id]);
    res.json({ ok: true, product: formatProduct(p), draw: dr[0] || null });
  } catch (e) { next(e); }
});

// 最近购买动态
router.get('/recent-buys', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT o.shares, o.created_at, p.name AS product_name, p.emoji,
             u.name AS buyer_name
      FROM orders o
      JOIN products p ON p.id=o.product_id
      JOIN users u ON u.id=o.user_id
      ORDER BY o.created_at DESC LIMIT 30`);
    res.json({ ok: true, buys: rows });
  } catch (e) { next(e); }
});

// 公开配置
router.get('/config', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT k,v FROM config`);
    const config = {};
    for (const r of rows) {
      if (r.k === 'recharge_packages') config[r.k] = JSON.parse(r.v);
      else config[r.k] = /^\d+$/.test(r.v) ? Number(r.v) : r.v;
    }
    res.json({ ok: true, config });
  } catch (e) { next(e); }
});

// 最近中奖动态
router.get('/winners', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT d.product_id, d.win_number, d.drawn_at, p.name, p.emoji,
             p.price_per_share AS price,
             u.name AS winner_name
      FROM draws d
      JOIN products p ON p.id=d.product_id
      LEFT JOIN users u ON u.id=d.winner_user_id
      WHERE d.drawn_at IS NOT NULL
      ORDER BY d.drawn_at DESC LIMIT 20`);
    res.json({ ok: true, winners: rows });
  } catch (e) { next(e); }
});

export default router;
