/* 认证：验证码 / 注册 / 登录 / 会话 */
import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import db from '../db.js';
import { sendCode as deliverCode } from '../lib/mailer.js';
import {
  now, genId, genInvite, createSession, attachUser, requireAuth,
  walletTx, grantFree, getConfig, tx,
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

    // 60 秒频控
    const prev = db.prepare(`SELECT sent_at FROM email_codes WHERE account=?`).get(account);
    if (prev && now() - prev.sent_at < 60000) {
      return res.json({ ok: false, msg: '发送太频繁，请稍后再试' });
    }
    const code = String(crypto.randomInt(100000, 1000000));
    db.prepare(`INSERT INTO email_codes (account,code,expires_at,sent_at)
      VALUES (?,?,?,?)
      ON CONFLICT(account) DO UPDATE SET code=excluded.code,
        expires_at=excluded.expires_at, sent_at=excluded.sent_at`)
      .run(account, code, now() + 10 * 60 * 1000, now());

    const r = await deliverCode(account, type, code);

    // 发送失败时清掉冷却时间，让用户可以立即重试（避免"点一下没反应，再点说频繁"）
    if (!r.delivered) {
      db.prepare(`UPDATE email_codes SET sent_at=0 WHERE account=?`).run(account);
    }

    res.json({
      ok: true,
      type,
      delivered: r.delivered,
      // 未真实投递时把验证码回给前端，方便开发自测；配好 SMTP 后 delivered=true 不再回传
      devCode: r.delivered ? undefined : code,
      msg: r.delivered ? '验证码已发送' : '验证码已生成（开发模式，见页面/日志）',
    });
  } catch (e) { next(e); }
});

function verifyCode(account, code) {
  const row = db.prepare(`SELECT * FROM email_codes WHERE account=?`).get(account);
  if (!row) return false;
  if (row.expires_at < now()) return false;
  return row.code === String(code);
}

// 注册
router.post('/register', (req, res, next) => {
  try {
    const account = String(req.body.account || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim();
    const code = String(req.body.code || '').trim();
    const invite = String(req.body.invite || '').trim().toUpperCase();

    const type = accountType(account);
    if (!type) return res.json({ ok: false, msg: '请输入正确的邮箱或手机号' });
    if (password.length < 4) return res.json({ ok: false, msg: '密码至少 4 位' });
    if (!verifyCode(account, code)) return res.json({ ok: false, msg: '验证码错误或已过期' });

    const dup = db.prepare(`SELECT id FROM users WHERE account=?`).get(account);
    if (dup) return res.json({ ok: false, msg: '该账号已注册，请直接登录' });

    // 邀请人
    let invitedBy = null;
    if (invite) {
      const inviter = db.prepare(`SELECT id FROM users WHERE invite_code=?`).get(invite);
      if (inviter) invitedBy = inviter.id;
    }

    const cfg = getConfig();
    const id = genId('u_');
    let myInvite;
    do { myInvite = genInvite(); }
    while (db.prepare(`SELECT 1 FROM users WHERE invite_code=?`).get(myInvite));

    tx(() => {
      db.prepare(`INSERT INTO users
        (id,account,account_type,name,pass_hash,role,invite_code,invited_by,paid_balance,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        id, account, type, name || account.split('@')[0],
        bcrypt.hashSync(password, 10), 'user', myInvite, invitedBy, 0, now());

      // 注册赠币入充值余额（通用可用，非商品限定）
      if (cfg.grantRegister > 0) walletTx(id, 'grant', cfg.grantRegister, '注册赠送');
      // 邀请奖励
      if (invitedBy) {
        if (cfg.grantInvitee > 0) walletTx(id, 'grant', cfg.grantInvitee, '受邀奖励');
        if (cfg.grantInviter > 0) walletTx(invitedBy, 'grant', cfg.grantInviter, '邀请好友奖励');
      }
      db.prepare(`DELETE FROM email_codes WHERE account=?`).run(account);
    });

    const token = createSession(id);
    res.cookie('lb_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
    res.json({ ok: true, msg: '注册成功', user: publicUser(id) });
  } catch (e) { next(e); }
});

// 登录
router.post('/login', (req, res, next) => {
  try {
    const account = String(req.body.account || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const u = db.prepare(`SELECT * FROM users WHERE account=?`).get(account);
    if (!u || !bcrypt.compareSync(password, u.pass_hash)) {
      return res.json({ ok: false, msg: '账号或密码错误' });
    }
    const token = createSession(u.id);
    res.cookie('lb_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
    res.json({ ok: true, msg: '登录成功', user: publicUser(u.id) });
  } catch (e) { next(e); }
});

router.post('/logout', (req, res) => {
  const token = req.cookies?.lb_token;
  if (token) db.prepare(`DELETE FROM sessions WHERE token=?`).run(token);
  res.clearCookie('lb_token');
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.json({ ok: true, user: null });
  res.json({ ok: true, user: publicUser(req.user.id) });
});

function publicUser(id) {
  const u = db.prepare(`SELECT id,account,account_type,name,role,invite_code,paid_balance
    FROM users WHERE id=?`).get(id);
  return u;
}

export default router;
