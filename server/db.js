/*
 * PostgreSQL 数据库层（pg.Pool，异步 API）
 * 首次连接即建表并播种默认类别 / 配置 / 管理员。
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';
import 'dotenv/config';
import logger from './lib/logger.js';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  logger.error({ err }, '数据库连接池后台异常');
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

CREATE TABLE IF NOT EXISTS showcase_likes (
  showcase_id  TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  PRIMARY KEY (showcase_id, user_id)
);

`;

const DEFAULT_CATEGORIES = [
  { key: 'cleaning',  name: '清洁和环境电器', prefix: 'CL', icon: '🧹' },
  { key: 'kitchen',   name: '智能厨房电器', prefix: 'KT', icon: '🍳' },
  { key: 'outdoor',   name: '庭院与户外工具', prefix: 'OD', icon: '🌿' },
  { key: 'personal',  name: '个护美容设备', prefix: 'PC', icon: '💆' },
  { key: 'fitness',   name: '运动健身器材', prefix: 'FT', icon: '🏋️' },
  { key: 'baby',      name: '高端母婴用品', prefix: 'BB', icon: '👶' },
  { key: 'pet',       name: '宠物智能用品', prefix: 'PT', icon: '🐾' },
];
const DEFAULT_CONFIG = {
  grantRegister: 10, grantCheckin: 2, grantShowcase: 20,
  grantInvitee: 5, grantInviter: 5,
};
const DEFAULT_PACKAGES = JSON.stringify([
  { amount: 10, bonus: 1 },
  { amount: 50, bonus: 5 },
  { amount: 100, bonus: 15 },
  { amount: 200, bonus: 40 },
]);

export async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA);

    // 增量迁移：后续新增的字段（基础 SCHEMA 里没有）
    const migrations = [
      `ALTER TABLE draws ADD COLUMN IF NOT EXISTS ship_status TEXT NOT NULL DEFAULT 'pending'`,
      `ALTER TABLE draws ADD COLUMN IF NOT EXISTS ship_note TEXT`,
    ];
    for (const sql of migrations) await client.query(sql).catch(() => {});

    // indexes (after columns guaranteed to exist)
    const indexes = [
      `CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_orders_product_id ON orders(product_id)`,
      `CREATE INDEX IF NOT EXISTS idx_draws_drawn_at ON draws(drawn_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_products_status ON products(status)`,
      `CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)`,
      `CREATE INDEX IF NOT EXISTS idx_showcases_status ON showcases(status)`,
      `CREATE INDEX IF NOT EXISTS idx_showcases_user_id ON showcases(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sc_likes_showcase ON showcase_likes(showcase_id)`,
      `CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_id ON wallet_tx(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_recharges_user_id ON recharges(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_checkins_user_id ON checkins(user_id, created_at DESC)`,
    ];
    for (const sql of indexes) await client.query(sql).catch(() => {});

    // seed categories only when table is empty
    const { rows: catRows } = await client.query(`SELECT COUNT(*)::int AS cnt FROM categories`);
    if (catRows[0].cnt === 0) {
      for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
        const c = DEFAULT_CATEGORIES[i];
        await client.query(
          `INSERT INTO categories (key,name,prefix,icon,sort) VALUES ($1,$2,$3,$4,$5)`,
          [c.key, c.name, c.prefix, c.icon, i]);
      }
    }

    // seed config
    for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
      await client.query(
        `INSERT INTO config (k,v) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [k, String(v)]);
    }
    await client.query(
      `INSERT INTO config (k,v) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      ['recharge_packages', DEFAULT_PACKAGES]);

    // migrate: ensure $10 package has bonus=1
    const { rows: pkgRow } = await client.query(`SELECT v FROM config WHERE k='recharge_packages'`);
    if (pkgRow[0]) {
      const pkgs = JSON.parse(pkgRow[0].v);
      const ten = pkgs.find(p => p.amount === 10);
      if (ten && !ten.bonus) {
        ten.bonus = 1;
        await client.query(`UPDATE config SET v=$1 WHERE k='recharge_packages'`, [JSON.stringify(pkgs)]);
      }
    }

    // seed admin (wrapped in try-catch — shared DB may have incompatible users table temporarily)
    try {
      const email = process.env.ADMIN_EMAIL || 'admin@luckybuy.local';
      const pass = process.env.ADMIN_PASSWORD || 'admin888';
      const { rows } = await client.query(`SELECT id FROM users WHERE account=$1`, [email]);
      if (rows.length === 0) {
        const now = Date.now();
        await client.query(
          `INSERT INTO users (id,account,account_type,name,pass_hash,role,invite_code,paid_balance,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          ['u_admin', email, 'email', '管理员', bcrypt.hashSync(pass, 10), 'admin', 'ADMIN0', 0, now]);
        logger.info({ email }, '已创建管理员账号');
      }
    } catch (e) {
      logger.warn({ err: e }, '管理员账号播种失败');
    }
  } finally {
    client.release();
  }
}

export default pool;

