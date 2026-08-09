/* 晒单 API：提交 / 查看 / 管理员审核 */
import express from 'express';
import multer from 'multer';
import pool from '../db.js';
import { attachUser, requireAdmin, genId } from '../lib/helpers.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('只支持图片或视频文件'));
  }
});

const router = express.Router();
router.use(attachUser);

// 公开：获取已审核通过的晒单
router.get('/approved', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.media_type, s.media_url, s.caption, s.created_at,
              u.name AS user_name, p.name AS product_name, p.emoji
       FROM showcases s
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN products p ON p.id = s.product_id
       WHERE s.status = 'approved'
       ORDER BY s.reviewed_at DESC LIMIT 30`);
    res.json({ ok: true, showcases: rows });
  } catch (e) { next(e); }
});

// 用户：提交晒单
router.post('/submit', upload.single('media'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, msg: '请先登录' });
    const { productId, mediaType, caption } = req.body || {};
    const mediaUrl = req.file
      ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`
      : (req.body.mediaUrl || '');
    if (!productId || !mediaUrl) return res.status(400).json({ ok: false, msg: '缺少商品或媒体文件' });
    if (!['image', 'video'].includes(mediaType)) return res.status(400).json({ ok: false, msg: '媒体类型无效' });

    const { rows: wins } = await pool.query(
      `SELECT 1 FROM draws WHERE product_id=$1 AND winner_user_id=$2`, [productId, req.user.id]);
    if (!wins.length) return res.status(403).json({ ok: false, msg: '只有幸运儿才能晒单' });

    const { rows: dup } = await pool.query(
      `SELECT 1 FROM showcases WHERE user_id=$1 AND product_id=$2`, [req.user.id, productId]);
    if (dup.length) return res.status(400).json({ ok: false, msg: '该商品已晒单，请勿重复提交' });

    const id = genId('sc_');
    await pool.query(
      `INSERT INTO showcases (id, user_id, product_id, media_type, media_url, caption, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)`,
      [id, req.user.id, productId, mediaType, mediaUrl, caption || '', Date.now()]);
    res.json({ ok: true, id, msg: '晒单已提交，等待审核' });
  } catch (e) { next(e); }
});

// 用户：我的晒单
router.get('/mine', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, msg: '请先登录' });
    const { rows } = await pool.query(
      `SELECT s.*, p.name AS product_name, p.emoji
       FROM showcases s LEFT JOIN products p ON p.id = s.product_id
       WHERE s.user_id = $1 ORDER BY s.created_at DESC`, [req.user.id]);
    res.json({ ok: true, showcases: rows });
  } catch (e) { next(e); }
});

// 用户：删除自己的晒单
router.delete('/:id', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, msg: '请先登录' });
    const { rows } = await pool.query(`SELECT * FROM showcases WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, msg: '晒单不存在' });
    if (rows[0].user_id !== req.user.id) return res.status(403).json({ ok: false, msg: '无权删除' });
    await pool.query(`DELETE FROM showcases WHERE id=$1`, [req.params.id]);
    res.json({ ok: true, msg: '已删除' });
  } catch (e) { next(e); }
});

// 管理员：待审核列表
router.get('/pending', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, u.account, u.name AS user_name, p.name AS product_name, p.emoji
       FROM showcases s
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN products p ON p.id = s.product_id
       WHERE s.status = 'pending'
       ORDER BY s.created_at DESC`);
    res.json({ ok: true, showcases: rows });
  } catch (e) { next(e); }
});

// 管理员：审核（通过/拒绝）
router.post('/review/:id', requireAdmin, async (req, res, next) => {
  try {
    const { action } = req.body || {};
    if (!['approve', 'reject'].includes(action))
      return res.status(400).json({ ok: false, msg: '无效操作' });

    const { rows } = await pool.query(`SELECT * FROM showcases WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, msg: '晒单不存在' });
    const sc = rows[0];
    if (sc.status !== 'pending') return res.status(400).json({ ok: false, msg: '该晒单已审核' });

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await pool.query(`UPDATE showcases SET status=$1, reviewed_at=$2 WHERE id=$3`,
      [newStatus, Date.now(), req.params.id]);

    if (action === 'approve') {
      const { rows: cfgRows } = await pool.query(`SELECT v FROM config WHERE k='grantShowcase'`);
      const grant = cfgRows[0] ? Number(cfgRows[0].v) : 0;
      if (grant > 0) {
        await pool.query(`UPDATE users SET free_balance = free_balance + $1 WHERE id = $2`,
          [grant, sc.user_id]);
      }
    }
    res.json({ ok: true, msg: action === 'approve' ? '已通过' : '已拒绝' });
  } catch (e) { next(e); }
});

export default router;
