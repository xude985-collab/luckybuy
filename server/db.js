/*
 * PostgreSQL 数据库层（pg.Pool，异步 API）
 * 首次连接即建表并播种默认类别 / 配置 / 管理员。
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  account       TEXT UNIQUE NOT NULL,
  account_type  TEXT NOT NULL,
  name          TEXT,
  pass_hash     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  invite_code   TEXT UNIQUE,
  invited_by    TEXT,
  paid_balance  BIGINT NOT NULL DEFAULT 0,
  free_balance  BIGINT NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS free_grants (
  user_id    TEXT NOT NULL,
  product_id TEXT NOT NULL,
  amount     BIGINT NOT NULL,
  reason     TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS checkins (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  reward     BIGINT NOT NULL,
  streak     INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_codes (
  account    TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  sent_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  key    TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  prefix TEXT UNIQUE NOT NULL,
  icon   TEXT,
  sort   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sku_seq (
  prefix TEXT PRIMARY KEY,
  n      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY,
  sku           TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,
  emoji         TEXT,
  price_per_share INTEGER NOT NULL DEFAULT 1,
  total_shares  INTEGER NOT NULL,
  free_quota    INTEGER NOT NULL DEFAULT 0,
  free_used     INTEGER NOT NULL DEFAULT 0,
  "desc"        TEXT,
  gallery       TEXT,
  specs         TEXT,
  source_url    TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  shares      INTEGER NOT NULL,
  numbers     TEXT NOT NULL,
  paid_coins  INTEGER NOT NULL DEFAULT 0,
  free_coins  INTEGER NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_tx (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  amount     BIGINT NOT NULL,
  balance    BIGINT NOT NULL,
  ref        TEXT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS draws (
  product_id     TEXT PRIMARY KEY,
  round          INTEGER NOT NULL,
  randomness     TEXT,
  signature      TEXT,
  win_number     INTEGER,
  winner_user_id TEXT,
  total_shares   INTEGER NOT NULL,
  locked_at      BIGINT NOT NULL,
  drawn_at       BIGINT,
  win_address    TEXT
);

CREATE TABLE IF NOT EXISTS config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recharges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  bonus INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'stripe',
  status TEXT NOT NULL,
  stripe_session TEXT,
  created_at BIGINT NOT NULL,
  paid_at BIGINT
);

CREATE TABLE IF NOT EXISTS showcases (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  media_type  TEXT NOT NULL DEFAULT 'image',
  media_url   TEXT NOT NULL,
  caption     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  reviewed_at BIGINT,
  created_at  BIGINT NOT NULL
);
`;

const DEFAULT_CATEGORIES = [
  { key: 'appliance', name: '家用电器', prefix: 'AP', icon: '🔌' },
  { key: 'beauty',    name: '美妆护肤', prefix: 'BT', icon: '💄' },
  { key: 'digital',   name: '3C 数码', prefix: '3C', icon: '📱' },
  { key: 'home',      name: '家居生活', prefix: 'HM', icon: '🛋️' },
  { key: 'baby',      name: '母婴亲子', prefix: 'BB', icon: '🍼' },
  { key: 'food',      name: '食品酒饮', prefix: 'FD', icon: '🍫' },
  { key: 'other',     name: '其他',     prefix: 'OT', icon: '🎁' },
];
const DEFAULT_CONFIG = {
  grantRegister: 10, grantCheckin: 2, grantShowcase: 20,
  grantInvitee: 5, grantInviter: 5,
};
const DEFAULT_PACKAGES = JSON.stringify([
  { amount: 10, bonus: 0 },
  { amount: 50, bonus: 5 },
  { amount: 100, bonus: 15 },
  { amount: 200, bonus: 40 },
]);

export async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA);

    // add missing columns for existing databases
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS free_balance BIGINT NOT NULL DEFAULT 0`).catch(() => {});
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS free_used INTEGER NOT NULL DEFAULT 0`).catch(() => {});
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS free_quota INTEGER NOT NULL DEFAULT 0`).catch(() => {});

    // seed categories
    for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
      const c = DEFAULT_CATEGORIES[i];
      await client.query(
        `INSERT INTO categories (key,name,prefix,icon,sort) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [c.key, c.name, c.prefix, c.icon, i]);
    }

    // seed config
    for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
      await client.query(
        `INSERT INTO config (k,v) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [k, String(v)]);
    }
    await client.query(
      `INSERT INTO config (k,v) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      ['recharge_packages', DEFAULT_PACKAGES]);

    // seed admin
    const email = process.env.ADMIN_EMAIL || 'admin@luckybuy.local';
    const pass = process.env.ADMIN_PASSWORD || 'admin888';
    const { rows } = await client.query(`SELECT id FROM users WHERE account=$1`, [email]);
    if (rows.length === 0) {
      const now = Date.now();
      await client.query(
        `INSERT INTO users (id,account,account_type,name,pass_hash,role,invite_code,paid_balance,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        ['u_admin', email, 'email', '管理员', bcrypt.hashSync(pass, 10), 'admin', 'ADMIN0', 0, now]);
      console.log(`[db] 已创建管理员账号: ${email}`);
    }
  } finally {
    client.release();
  }
}

export default pool;

