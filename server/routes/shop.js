/* 商品 / 类别 / 详情 / 幸运动态（公开只读接口） */
import express from 'express';
import pool from '../db.js';
import { attachUser } from '../lib/helpers.js';

const router = express.Router();
router.use(attachUser);

function safeJSON(s, d) { try { return s ? JSON.parse(s) : d; } catch { return d; } }

function formatProduct(p) {
  if (!p) return null;
  const out = {
    id: p.id, sku: p.sku, name: p.name, category: p.category, emoji: p.emoji,
    pricePerShare: p.price_per_share, totalShares: p.total_shares,
    freeQuota: p.free_quota, freeUsed: Number(p.free_used || 0),
    desc: p.desc || '',
    gallery: safeJSON(p.gallery, []),
    specs: safeJSON(p.specs, []),
    sourceUrl: p.source_url || '',
    status: p.status, createdAt: p.created_at,
    sold: Number(p.sold || 0),
  };
  if (p.draw_round != null) {
    out.draw = {
      round: p.draw_round,
      win_number: p.win_number,
      winner_user_id: p.winner_user_id,
      winner_name: p.winner_name || null,
      randomness: p.randomness,
      signature: p.signature,
      win_address: p.win_address ? true : false,
    };
  }
  return out;
}

// 类别列表
router.get('/categories', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT key,name,prefix,icon,sort FROM categories ORDER BY sort`);
    res.json({ ok: true, categories: rows });
  } catch (e) { next(e); }
});

// 商品列表
router.get('/products', async (req, res, next) => {
  try {
    const cat = req.query.category;
    let rows;
    const base = `SELECT p.*, COALESCE(s.total,0) AS sold,
         d.round AS draw_round, d.win_number, d.winner_user_id, d.randomness, d.signature, d.win_address,
         wu.name AS winner_name
       FROM products p
       LEFT JOIN (SELECT product_id, SUM(shares) AS total FROM orders GROUP BY product_id) s
         ON s.product_id=p.id
       LEFT JOIN draws d ON d.product_id=p.id
       LEFT JOIN users wu ON wu.id=d.winner_user_id`;
    if (cat) {
      const r = await pool.query(base + ` WHERE p.category=$1 ORDER BY p.created_at DESC`, [cat]);
      rows = r.rows;
    } else {
      const r = await pool.query(base + ` ORDER BY p.created_at DESC`);
      rows = r.rows;
    }
    res.json({ ok: true, products: rows.map(formatProduct) });
  } catch (e) { next(e); }
});

// 单个商品详情
router.get('/products/:id', async (req, res, next) => {
  try {
    const { rows: pr } = await pool.query(
      `SELECT p.*, COALESCE(s.total,0) AS sold,
              d.round AS draw_round, d.win_number, d.winner_user_id, d.randomness, d.signature, d.win_address,
              wu.name AS winner_name
       FROM products p
       LEFT JOIN (SELECT product_id, SUM(shares) AS total FROM orders GROUP BY product_id) s
         ON s.product_id=p.id
       LEFT JOIN draws d ON d.product_id=p.id
       LEFT JOIN users wu ON wu.id=d.winner_user_id
       WHERE p.id=$1`, [req.params.id]);
    const p = pr[0];
    if (!p) return res.status(404).json({ ok: false, msg: '商品不存在' });
    const product = formatProduct(p);
    res.json({ ok: true, product, draw: product.draw || null });
  } catch (e) { next(e); }
});

// 最近购买动态
router.get('/recent-buys', async (req, res, next) => {
  try {
    const { rows: cfgRows } = await pool.query(`SELECT v FROM config WHERE k='recentBuysHours'`);
    const hours = cfgRows[0] ? Number(cfgRows[0].v) : 0;
    const timeFilter = hours > 0 ? `WHERE o.created_at > ${Date.now() - hours * 3600000}` : '';
    const { rows } = await pool.query(`
      SELECT o.shares, o.created_at, p.name AS product_name, p.emoji,
             u.name AS buyer_name
      FROM orders o
      JOIN products p ON p.id=o.product_id
      JOIN users u ON u.id=o.user_id
      ${timeFilter}
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
    const { rows: cfgRows } = await pool.query(`SELECT v FROM config WHERE k='winnersHours'`);
    const hours = cfgRows[0] ? Number(cfgRows[0].v) : 0;
    const timeFilter = hours > 0 ? `AND d.drawn_at > ${Date.now() - hours * 3600000}` : '';
    const { rows } = await pool.query(`
      SELECT d.product_id, d.win_number, d.drawn_at, p.name, p.emoji,
             p.price_per_share AS price,
             u.name AS winner_name
      FROM draws d
      JOIN products p ON p.id=d.product_id
      LEFT JOIN users u ON u.id=d.winner_user_id
      WHERE d.drawn_at IS NOT NULL ${timeFilter}
      ORDER BY d.drawn_at DESC LIMIT 20`);
    res.json({ ok: true, winners: rows });
  } catch (e) { next(e); }
});

// 当前用户的中奖记录
router.get('/my-wins', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, msg: '请先登录' });
    const { rows } = await pool.query(`
      SELECT d.product_id, d.win_number, d.drawn_at, p.name AS product_name, p.emoji
      FROM draws d
      JOIN products p ON p.id = d.product_id
      WHERE d.winner_user_id = $1
      ORDER BY d.drawn_at DESC`, [req.user.id]);
    res.json({ ok: true, wins: rows });
  } catch (e) { next(e); }
});

export default router;
