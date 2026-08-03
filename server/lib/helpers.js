/* 公共辅助：ID 生成、会话中间件、钱包与免费额度读写 */
import crypto from 'crypto';
import db from '../db.js';

export const now = () => Date.now();

// node:sqlite 无 db.transaction()，用手动 BEGIN/COMMIT 包一层
export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
export const genId = (p = '') => p + crypto.randomBytes(9).toString('hex');
export const genToken = () => crypto.randomBytes(24).toString('hex');
export const genInvite = () =>
  Array.from({ length: 6 }, () =>
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join('');

const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 天

export function createSession(userId) {
  const token = genToken();
  const t = now();
  db.prepare(`INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)`)
    .run(token, userId, t, t + SESSION_TTL);
  return token;
}

export function userFromToken(token) {
  if (!token) return null;
  const s = db.prepare(`SELECT * FROM sessions WHERE token=?`).get(token);
  if (!s || s.expires_at < now()) return null;
  return db.prepare(`SELECT * FROM users WHERE id=?`).get(s.user_id) || null;
}

// 登录态中间件：把 req.user 填上（未登录则 null）
export function attachUser(req, res, next) {
  req.user = userFromToken(req.cookies?.lb_token);
  next();
}

// 要求已登录
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, msg: '请先登录' });
  next();
}

// 要求管理员
export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, msg: '请先登录' });
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, msg: '无权限' });
  next();
}

// ---- 钱包 ----
// 用户在某商品可用的免费额度（未超过每商品发放）
export function freeBalanceForProduct(userId, productId) {
  const row = db.prepare(
    `SELECT amount FROM free_grants WHERE user_id=? AND product_id=?`).get(userId, productId);
  return row ? row.amount : 0;
}

export function totalCoins(userId, productId) {
  const u = db.prepare(`SELECT paid_balance FROM users WHERE id=?`).get(userId);
  const free = productId ? freeBalanceForProduct(userId, productId) : 0;
  return { paid: u?.paid_balance || 0, free };
}

// 记一笔钱包流水并更新余额（仅充值币）
export function walletTx(userId, kind, amount, ref) {
  const u = db.prepare(`SELECT paid_balance FROM users WHERE id=?`).get(userId);
  const balance = (u?.paid_balance || 0) + amount;
  if (balance < 0) throw Object.assign(new Error('余额不足'), { status: 400 });
  db.prepare(`UPDATE users SET paid_balance=? WHERE id=?`).run(balance, userId);
  db.prepare(`INSERT INTO wallet_tx (id,user_id,kind,amount,balance,ref,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(genId('tx_'), userId, kind, amount, balance, ref || null, now());
  return balance;
}

// 发放某商品的免费金币（受商品 free_quota 限制在调用处校验）
export function grantFree(userId, productId, amount, reason) {
  const cur = freeBalanceForProduct(userId, productId);
  db.prepare(`INSERT INTO free_grants (user_id,product_id,amount,reason,created_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(user_id,product_id) DO UPDATE SET amount=amount+excluded.amount`)
    .run(userId, productId, amount, reason || null, now());
  return cur + amount;
}

export function getConfig() {
  const rows = db.prepare(`SELECT k,v FROM config`).all();
  const c = {};
  for (const r of rows) c[r.k] = /^\d+$/.test(r.v) ? Number(r.v) : r.v;
  return c;
}
