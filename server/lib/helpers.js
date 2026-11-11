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
  const { rows } = await pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token=$1 AND s.expires_at>$2 AND u.disabled=false`, [token, now()]);
  return rows[0] || null;
}

export async function attachUser(req, res, next) {
  try {
    req.user = await userFromToken(req.cookies?.lb_token);
    next();
  } catch (e) { next(e); }
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
  const { rows } = await q.query(`SELECT paid_balance, free_balance FROM users WHERE id=$1`, [userId]);
  const paid = rows[0] ? Number(rows[0].paid_balance) : 0;
  const free = rows[0] ? Number(rows[0].free_balance) : 0;
  return { paid, free };
}

export async function walletTx(userId, kind, amount, ref, client) {
  if (!Number.isSafeInteger(amount)) throw Object.assign(new Error('金币数量无效'), { status: 400 });
  if (!client) return withTransaction(c => walletTx(userId, kind, amount, ref, c));
  const column = kind === 'grant' ? 'free_balance' : 'paid_balance';
  // 原子加减并检查余额；余额与流水必须在同一事务提交。
  const { rows } = await client.query(
    `UPDATE users SET ${column}=${column}+$1
     WHERE id=$2 AND ${column}+$1>=0 RETURNING ${column} AS balance`, [amount, userId]);
  if (!rows.length) throw Object.assign(new Error(kind === 'grant' ? '免费金币不足或用户不存在' : '余额不足或用户不存在'), { status: 400 });
  const balance = Number(rows[0].balance);
  await client.query(
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
