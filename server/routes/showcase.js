/* 晒单 API：提交 / 查看 / 留言 / 管理员审核 */
import express from 'express';
import multer from 'multer';
import pool from '../db.js';
import { attachUser, requireAdmin, requireAuth, genId, withTransaction, walletTx } from '../lib/helpers.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (/^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime))$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('只支持图片或视频文件'));
  }
});

const router = express.Router();
router.use(attachUser);

// 公开：获取已审核通过的晒单
router.get('/approved', async (req, res, next) => {
  try {
    const { rows: cfgRows } = await pool.query(`SELECT v FROM config WHERE k='showcaseHours'`);
    const hours = cfgRows[0] ? Number(cfgRows[0].v) : 0;
    const timeFilter = hours > 0 ? `AND s.reviewed_at > ${Date.now() - hours * 3600000}` : '';
    const { rows } = await pool.query(
      `SELECT s.id, s.media_type, CASE WHEN s.media_url LIKE 'data:%' THEN '/api/showcase/media/' || s.id ELSE s.media_url END AS media_url, s.caption, s.created_at,
              u.name AS user_name, p.name AS product_name, p.emoji,
              COALESCE(COUNT(l.user_id), 0)::int AS likes
       FROM showcases s
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN products p ON p.id = s.product_id
       LEFT JOIN showcase_likes l ON l.showcase_id = s.id
       WHERE s.status = 'approved' AND s.deleted_at IS NULL ${timeFilter}
       GROUP BY s.id, u.name, p.name, p.emoji
       ORDER BY s.reviewed_at DESC LIMIT 10`);
    res.json({ ok: true, showcases: rows.map(s=>({...s,media_url:s.media_url?.startsWith('data:')?'/api/showcase/media/'+s.id:s.media_url})) });
  } catch (e) { next(e); }
});

// 用户：提交晒单
router.post('/submit', requireAuth, upload.single('media'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, msg: '请先登录' });
    const { productId, mediaType, caption } = req.body || {};
    const mediaUrl = req.file
      ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`
      : (req.body.mediaUrl || '');
    if (!productId || !mediaUrl) return res.status(400).json({ ok: false, msg: '缺少商品或媒体文件' });
    if (req.file && !req.file.mimetype.startsWith(mediaType+'/')) return res.status(400).json({ok:false,msg:'文件类型与选择的媒体类型不符'});
    if (!['image', 'video'].includes(mediaType)) return res.status(400).json({ ok: false, msg: '媒体类型无效' });

    if(!req.file && !/^https:\/\//i.test(mediaUrl)) return res.status(400).json({ok:false,msg:'请上传文件或使用HTTPS媒体链接'});
    const { rows: wins } = await pool.query(
      `SELECT 1 FROM draws WHERE product_id=$1 AND winner_user_id=$2`, [productId, req.user.id]);
    if (!wins.length) return res.status(403).json({ ok: false, msg: '只能为自己中奖的商品提交晒单，再接再厉，大奖等着你！' });

    const id = genId('sc_');
    await withTransaction(async client=>{
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
      const {rows:dup}=await client.query('SELECT 1 FROM showcases WHERE user_id=$1 AND product_id=$2 AND deleted_at IS NULL',[req.user.id,productId]);
      if(dup.length)throw Object.assign(new Error('该商品已晒单，请勿重复提交'),{status:400});
      await client.query(`INSERT INTO showcases (id,user_id,product_id,media_type,media_url,caption,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)`,
       [id,req.user.id,productId,mediaType,mediaUrl,String(caption||'').slice(0,1000),Date.now()]);
    });
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
       WHERE s.user_id = $1 AND s.deleted_at IS NULL ORDER BY s.created_at DESC`, [req.user.id]);
    res.json({ ok: true, showcases: rows.map(s=>({...s,media_url:s.media_url?.startsWith('data:')?'/api/showcase/media/'+s.id:s.media_url})) });
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
       WHERE s.status = 'pending' AND s.deleted_at IS NULL
       ORDER BY s.created_at DESC`);
    res.json({ ok: true, showcases: rows.map(s=>({...s,media_url:s.media_url?.startsWith('data:')?'/api/showcase/media/'+s.id:s.media_url})) });
  } catch (e) { next(e); }
});


router.get('/media/:id',async(req,res,next)=>{
 try{const {rows}=await pool.query(`SELECT media_url FROM showcases WHERE id=$1 AND deleted_at IS NULL AND (status='approved' OR user_id=$2 OR $3)`,[req.params.id,req.user?.id||null,req.user?.role==='admin']);
 if(!rows.length)return res.status(404).end();
 const m=rows[0].media_url.match(/^data:(image\/(?:jpeg|png|webp|gif)|video\/(?:mp4|webm|quicktime));base64,([A-Za-z0-9+/=]+)$/);
 if(!m)return res.status(404).end();
 res.set({'Content-Type':m[1],'X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=300'}).send(Buffer.from(m[2],'base64'));
 }catch(e){next(e)}
});

// 公开：单条晒单详情（放在 /mine /pending /approved 之后）
router.get('/:id', async (req, res, next) => {
  try {
    const userId = req.user ? req.user.id : null;
    const { rows } = await pool.query(
      `SELECT s.id, s.media_type, CASE WHEN s.media_url LIKE 'data:%' THEN '/api/showcase/media/' || s.id ELSE s.media_url END AS media_url, s.caption, s.created_at,
              u.name AS user_name, p.name AS product_name, p.emoji,
              COALESCE(COUNT(l.user_id), 0)::int AS likes,
              BOOL_OR(l.user_id = $2) AS liked
       FROM showcases s
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN products p ON p.id = s.product_id
       LEFT JOIN showcase_likes l ON l.showcase_id = s.id
       WHERE s.id = $1 AND s.status = 'approved' AND s.deleted_at IS NULL
       GROUP BY s.id, u.name, p.name, p.emoji`, [req.params.id, userId]);
    if (!rows.length) return res.status(404).json({ ok: false, msg: '晒单不存在' });
    const s = rows[0];
    s.liked = s.liked || false;
    res.json({ ok: true, showcase: s });
  } catch (e) { next(e); }
});

// 用户：点赞/取消点赞
router.post('/:id/like', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, msg: '请先登录' });
    const scId = req.params.id;
    const { rows: sc } = await pool.query(
      `SELECT 1 FROM showcases WHERE id=$1 AND status='approved' AND deleted_at IS NULL`, [scId]);
    if (!sc.length) return res.status(404).json({ ok: false, msg: '晒单不存在' });
    const { rows: exists } = await pool.query(
      `SELECT 1 FROM showcase_likes WHERE showcase_id=$1 AND user_id=$2`, [scId, req.user.id]);
    if (exists.length) {
      await pool.query(`DELETE FROM showcase_likes WHERE showcase_id=$1 AND user_id=$2`, [scId, req.user.id]);
    } else {
      await pool.query(`INSERT INTO showcase_likes (showcase_id, user_id, created_at) VALUES ($1,$2,$3)`,
        [scId, req.user.id, Date.now()]);
    }
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*)::int AS likes FROM showcase_likes WHERE showcase_id=$1`, [scId]);
    res.json({ ok: true, liked: !exists.length, likes: cnt[0].likes });
  } catch (e) { next(e); }
});

// 用户：删除自己的晒单
router.delete('/:id', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, msg: '请先登录' });
    const { rows } = await pool.query(`SELECT * FROM showcases WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, msg: '晒单不存在' });
    if (rows[0].user_id !== req.user.id) return res.status(403).json({ ok: false, msg: '无权删除' });
    await pool.query(`UPDATE showcases SET deleted_at=$2 WHERE id=$1`, [req.params.id,Date.now()]);
    res.json({ ok: true, msg: '已删除' });
  } catch (e) { next(e); }
});

// 管理员：审核（通过/拒绝）
router.post('/review/:id', requireAdmin, async (req, res, next) => {
  try {
    const { action } = req.body || {};
    if (!['approve', 'reject'].includes(action))
      return res.status(400).json({ ok: false, msg: '无效操作' });

    await withTransaction(async client => {
      const { rows } = await client.query(
        `UPDATE showcases SET status=$1,reviewed_at=$2 WHERE id=$3 AND status='pending' AND deleted_at IS NULL RETURNING *`,
        [action === 'approve' ? 'approved' : 'rejected', Date.now(), req.params.id]);
      if (!rows.length) throw Object.assign(new Error('晒单不存在或已审核'), { status: 400 });
      if (action === 'approve') {
        const { rows: config } = await client.query(`SELECT v FROM config WHERE k='grantShowcase'`);
        const grant = Number(config[0]?.v || 0);
        const claim=await client.query('INSERT INTO showcase_rewards (user_id,product_id,created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id',[rows[0].user_id,rows[0].product_id,Date.now()]);
        if (grant > 0 && claim.rows.length) await walletTx(rows[0].user_id, 'grant', grant, '晒单奖励', client);
      }
    });
    res.json({ ok: true, msg: action === 'approve' ? '已通过' : '已拒绝' });
  } catch (e) { next(e); }
});

export default router;
