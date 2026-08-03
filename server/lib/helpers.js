/* 公共辅助：ID 生成、会话中间件、钱包与免费额度读写（async pg 版） */
import crypto from 'crypto';
import pool from '../db.js';

export const now = () => Date.now();

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
export { withTransaction as tx };

export const genId = (p = '') => p + crypto.randomBytes(9).toString('hex');
export const genToken = () => crypto.randomBytes(24).toString('hex');
export const genInvite = () =>
  Array.from({ length: 6 }, () =>
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join('');

const SESSION_TTL = 30 * 24 * 3600 * 1000;

export async function createSession(userId, client) {
  const q = client || pool;
  const token = genToken();
  const t = now();
  await q.query(
    `INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES ($1,$2,$3,$4)`,
    [token, userId, t, t + SESSION_TTL]);
  return token;
}

export async function userFromToken(token) {
  if (!token) return null;
  const { rows: sr } = await pool.query(`SELECT * FROM sessions WHERE token=$1`, [token]);
  const s = sr[0];
  if (!s || s.expires_at < now()) return null;
  const { rows: ur } = await pool.query(`SELECT * FROM users WHERE id=$1`, [s.user_id]);
  return ur[0] || null;
}

export async function attachUser(req, res, next) {
  req.user = await userFromToken(req.cookies?.lb_token);
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, msg: '请先登录' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, msg: '请先登录' });
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, msg: '无权限' });
  next();
}

export async function freeBalanceForProduct(userId, productId, client) {
  const q = client || pool;
  const { rows } = await q.query(
    `SELECT amount FROM free_grants WHERE user_id=$1 AND product_id=$2`, [userId, productId]);
  return rows[0] ? Number(rows[0].amount) : 0;
}

export async function totalCoins(userId, productId, client) {
  const q = client || pool;
  const { rows } = await q.query(`SELECT paid_balance FROM users WHERE id=$1`, [userId]);
  const paid = rows[0] ? Number(rows[0].paid_balance) : 0;
  const free = productId ? await freeBalanceForProduct(userId, productId, q) : 0;
  return { paid, free };
}

export async function walletTx(userId, kind, amount, ref, client) {
  const q = client || pool;
  const { rows } = await q.query(`SELECT paid_balance FROM users WHERE id=$1`, [userId]);
  const balance = (rows[0] ? Number(rows[0].paid_balance) : 0) + amount;
  if (balance < 0) throw Object.assign(new Error('余额不足'), { status: 400 });
  await q.query(`UPDATE users SET paid_balance=$1 WHERE id=$2`, [balance, userId]);
  await q.query(
    `INSERT INTO wallet_tx (id,user_id,kind,amount,balance,ref,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [genId('tx_'), userId, kind, amount, balance, ref || null, now()]);
  return balance;
}

export async function grantFree(userId, productId, amount, reason, client) {
  const q = client || pool;
  const cur = await freeBalanceForProduct(userId, productId, q);
  await q.query(
    `INSERT INTO free_grants (user_id,product_id,amount,reason,created_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT(user_id,product_id) DO UPDATE SET amount=free_grants.amount+EXCLUDED.amount`,
    [userId, productId, amount, reason || null, now()]);
  return cur + amount;
}

export async function getConfig(client) {
  const q = client || pool;
  const { rows } = await q.query(`SELECT k,v FROM config`);
  const c = {};
  for (const r of rows) c[r.k] = /^\d+$/.test(r.v) ? Number(r.v) : r.v;
  return c;
}
