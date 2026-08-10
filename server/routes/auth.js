/* 认证：验证码 / 注册 / 登录 / 会话 */
import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import pool from '../db.js';
import { sendCode as deliverCode } from '../lib/mailer.js';
import {
  now, genId, genInvite, createSession, attachUser, requireAuth,
  walletTx, getConfig, withTransaction,
} from '../lib/helpers.js';

const router = express.Router();
router.use(attachUser);

const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const isPhone = (s) => /^\+?\d{6,15}$/.test(s.replace(/[\s-]/g, ''));
function accountType(account) {
  if (isEmail(account)) return 'email';
  if (isPhone(account)) return 'phone';
  return null;
}

// 发送验证码
router.post('/send-code', async (req, res, next) => {
  try {
    const account = String(req.body.account || '').trim().toLowerCase();
    const type = accountType(account);
    if (!type) return res.json({ ok: false, msg: '请输入正确的邮箱或手机号' });

    const { rows: prev } = await pool.query(`SELECT sent_at FROM email_codes WHERE account=$1`, [account]);
    if (prev[0] && now() - Number(prev[0].sent_at) < 60000) {
      return res.json({ ok: false, msg: '发送太频繁，请稍后再试' });
    }
    const code = String(crypto.randomInt(100000, 1000000));
    await pool.query(
      `INSERT INTO email_codes (account,code,expires_at,sent_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT(account) DO UPDATE SET code=EXCLUDED.code, expires_at=EXCLUDED.expires_at, sent_at=EXCLUDED.sent_at`,
      [account, code, now() + 10 * 60 * 1000, now()]);

    const r = await deliverCode(account, type, code);

    if (!r.delivered) {
      await pool.query(`UPDATE email_codes SET sent_at=0 WHERE account=$1`, [account]);
    }

    res.json({
      ok: true, type, delivered: r.delivered,
      devCode: r.delivered ? undefined : code,
      msg: r.delivered ? '验证码已发送' : '验证码已生成（开发模式，见页面/日志）',
    });
  } catch (e) { next(e); }
});

async function verifyCode(account, code) {
  const { rows } = await pool.query(`SELECT * FROM email_codes WHERE account=$1`, [account]);
  const row = rows[0];
  if (!row) return false;
  if (Number(row.expires_at) < now()) return false;
  return row.code === String(code);
}

// 注册
router.post('/register', async (req, res, next) => {
  try {
    const account = String(req.body.account || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim();
    const code = String(req.body.code || '').trim();
    const invite = String(req.body.invite || '').trim().toUpperCase();

    const type = accountType(account);
    if (!type) return res.json({ ok: false, msg: '请输入正确的邮箱或手机号' });
    if (password.length < 4) return res.json({ ok: false, msg: '密码至少 4 位' });
    if (!(await verifyCode(account, code))) return res.json({ ok: false, msg: '验证码错误或已过期' });

    const { rows: dup } = await pool.query(`SELECT id FROM users WHERE account=$1`, [account]);
    if (dup.length) return res.json({ ok: false, msg: '该账号已注册，请直接登录' });

    let invitedBy = null;
    if (invite) {
      const { rows: inv } = await pool.query(`SELECT id FROM users WHERE invite_code=$1`, [invite]);
      if (inv.length) invitedBy = inv[0].id;
    }

    const cfg = await getConfig();
    const id = genId('u_');
    let myInvite;
    do { myInvite = genInvite(); }
    while ((await pool.query(`SELECT 1 FROM users WHERE invite_code=$1`, [myInvite])).rows.length);

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO users (id,account,account_type,name,pass_hash,role,invite_code,invited_by,paid_balance,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, account, type, name || account.split('@')[0],
         bcrypt.hashSync(password, 10), 'user', myInvite, invitedBy, 0, now()]);

      if (invitedBy) {
        if (cfg.grantInvitee > 0) await walletTx(id, 'grant', cfg.grantInvitee, '受邀奖励', client);
        if (cfg.grantInviter > 0) await walletTx(invitedBy, 'grant', cfg.grantInviter, '邀请好友奖励', client);
      } else {
        if (cfg.grantRegister > 0) await walletTx(id, 'grant', cfg.grantRegister, '注册赠送', client);
      }
      await client.query(`DELETE FROM email_codes WHERE account=$1`, [account]);
    });

    const token = await createSession(id);
    res.cookie('lb_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
    res.json({ ok: true, msg: '注册成功', user: await publicUser(id) });
  } catch (e) { next(e); }
});

// 登录
router.post('/login', async (req, res, next) => {
  try {
    const account = String(req.body.account || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const { rows } = await pool.query(`SELECT * FROM users WHERE account=$1`, [account]);
    const u = rows[0];
    if (!u || !bcrypt.compareSync(password, u.pass_hash)) {
      return res.json({ ok: false, msg: '账号或密码错误' });
    }
    const token = await createSession(u.id);
    res.cookie('lb_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
    res.json({ ok: true, msg: '登录成功', user: await publicUser(u.id) });
  } catch (e) { next(e); }
});

router.post('/logout', async (req, res) => {
  const token = req.cookies?.lb_token;
  if (token) await pool.query(`DELETE FROM sessions WHERE token=$1`, [token]);
  res.clearCookie('lb_token');
  res.json({ ok: true });
});

router.get('/me', async (req, res, next) => {
  try {
    if (!req.user) return res.json({ ok: true, user: null });
    res.json({ ok: true, user: await publicUser(req.user.id) });
  } catch (e) { next(e); }
});

// 修改昵称
router.post('/update-name', attachUser, requireAuth, async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name || name.length > 20) return res.status(400).json({ ok: false, msg: '昵称 1~20 字' });
    await pool.query(`UPDATE users SET name=$1 WHERE id=$2`, [name, req.user.id]);
    res.json({ ok: true, name });
  } catch (e) { next(e); }
});

async function publicUser(id) {
  const { rows } = await pool.query(
    `SELECT id,account,account_type,name,role,invite_code,paid_balance,
            COALESCE(free_balance,0) AS free_balance FROM users WHERE id=$1`, [id]);
  return rows[0] || null;
}

export default router;
