/* 商品 / 类别 / 详情 / 幸运动态（公开只读接口） */
import express from 'express';
import pool from '../db.js';
import { attachUser } from '../lib/helpers.js';
import { roundTime } from '../lib/drand.js';

const router = express.Router();

function safeJSON(s, d) { try { return s ? JSON.parse(s) : d; } catch { return d; } }

function formatProduct(p) {
  if (!p) return null;
  const out = {
    id: p.id, sku: p.sku, name: p.name, category: p.category, emoji: p.emoji,
    pricePerShare: p.price_per_share, totalShares: p.total_shares,
    freeQuota: Math.round(Number(p.total_shares)*0.05),
    pricingPending: !!p.source_url && Number(p.total_shares)===1 && !Number(p.pricing?.referencePrice), freeUsed: Number(p.free_used || 0),
    desc: p.desc || '',
    gallery: safeJSON(p.gallery, []),
    specs: safeJSON(p.specs, []),
    sourceUrl: p.source_url || '',
    pricing: p.pricing || {},
    status: p.status, createdAt: p.created_at,
    sold: Number(p.sold || 0),
  };
  if (p.draw_round != null) {
    out.draw = {
      round: p.draw_round,
      drawTime: roundTime(p.draw_round),
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
    const cutoff = hours > 0 ? Date.now() - hours * 3600000 : 0;
    const { rows } = await pool.query(`
      SELECT o.shares, o.created_at, p.name AS product_name, p.emoji,
             u.name AS buyer_name
      FROM orders o
      JOIN products p ON p.id=o.product_id
      JOIN users u ON u.id=o.user_id
      WHERE o.created_at > $1
      ORDER BY o.created_at DESC LIMIT 30`, [cutoff]);
    res.json({ ok: true, buys: rows });
  } catch (e) { next(e); }
});

// 公开配置
router.get('/config', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT k,v FROM config`);
    const config = {};
    const publicKeys = new Set(['grantRegister', 'grantCheckin', 'grantShowcase', 'grantInvitee',
      'grantInviter', 'recentBuysHours', 'winnersHours', 'showcaseHours', 'drawDelay', 'recharge_packages']);
    for (const r of rows) {
      if (!publicKeys.has(r.k)) continue;
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
    const cutoff = hours > 0 ? Date.now() - hours * 3600000 : 0;
    const { rows } = await pool.query(`
      SELECT d.product_id, d.win_number, d.drawn_at, p.name, p.emoji,
             p.price_per_share AS price,
             u.name AS winner_name
      FROM draws d
      JOIN products p ON p.id=d.product_id
      LEFT JOIN users u ON u.id=d.winner_user_id
      WHERE d.drawn_at IS NOT NULL AND d.drawn_at > $1
      ORDER BY d.drawn_at DESC LIMIT 20`, [cutoff]);
    res.json({ ok: true, winners: rows });
  } catch (e) { next(e); }
});

// 当前用户的中奖记录
router.get('/notifications', attachUser, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ok:false,msg:'请先登录'});
    const {rows}=await pool.query(`SELECT p.id,p.name,p.emoji,p.status,d.round,d.win_number,d.winner_user_id,d.win_address
      FROM products p JOIN draws d ON d.product_id=p.id
      WHERE (p.status='drawing' AND EXISTS (SELECT 1 FROM orders o WHERE o.product_id=p.id AND o.user_id=$1))
         OR (p.status='done' AND d.winner_user_id=$1 AND d.win_address IS NULL)
      ORDER BY d.locked_at DESC LIMIT 50`,[req.user.id]);
    res.json({ok:true,products:rows.map(p=>({id:p.id,name:p.name,img:p.emoji,status:p.status==='done'?'revealed':p.status,
      drawTime:p.round?roundTime(Number(p.round)):null,winNumber:p.win_number,winnerUserId:p.winner_user_id,hasAddress:!!p.win_address}))});
  } catch(e){next(e)}
});

router.get('/my-wins', attachUser, async (req, res, next) => {
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

router.get('/catalog',async(req,res,next)=>{try{
 const page=Math.max(1,parseInt(req.query.page)||1),limit=Math.min(50,Math.max(1,parseInt(req.query.limit)||20)),cat=String(req.query.category||'all');
 const status=req.query.status==='done'?'done':'active';
 const where="WHERE ($1='all' OR p.category=$1) AND (($2='done' AND p.status='done') OR ($2='active' AND p.status IN ('active','drawing')))";
 const total=Number((await pool.query(`SELECT COUNT(*) AS n FROM products p ${where}`,[cat,status])).rows[0].n);
 const {rows}=await pool.query(`SELECT p.*,COALESCE(s.total,0) AS sold,d.round AS draw_round,d.win_number,d.winner_user_id,d.randomness,d.signature,d.win_address,u.name AS winner_name FROM products p LEFT JOIN (SELECT product_id,SUM(shares) AS total FROM orders GROUP BY product_id) s ON s.product_id=p.id LEFT JOIN draws d ON d.product_id=p.id LEFT JOIN users u ON u.id=d.winner_user_id ${where} ORDER BY COALESCE(s.total,0)::numeric/GREATEST(p.total_shares,1) DESC,p.created_at DESC,p.id LIMIT $3 OFFSET $4`,[cat,status,limit,(page-1)*limit]);
 const products=rows.map(p=>{const f=formatProduct(p);return {...f,gallery:f.gallery.slice(0,1),desc:'',specs:[]}});
 res.json({ok:true,products,total,page,pages:Math.max(1,Math.ceil(total/limit))});
}catch(e){next(e)}});
