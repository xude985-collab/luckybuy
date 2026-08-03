/*
 * SQLite 数据库层（better-sqlite3，同步 API，适合单机后端）
 * 首次导入即建表并播种默认类别 / 配置 / 管理员。
 */
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'luckybuy.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  account       TEXT UNIQUE NOT NULL,      -- 邮箱或手机号
  account_type  TEXT NOT NULL,             -- 'email' | 'phone'
  name          TEXT,
  pass_hash     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user', -- 'user' | 'admin'
  invite_code   TEXT UNIQUE,               -- 本人的邀请码
  invited_by    TEXT,                      -- 邀请人 userId
  paid_balance  INTEGER NOT NULL DEFAULT 0, -- 充值/可提现金币（分为单位，1币=$1 这里用整币）
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS free_grants (
  user_id    TEXT NOT NULL,
  product_id TEXT NOT NULL,       -- 免费金币按商品发放；NULL 表示通用免费币
  amount     INTEGER NOT NULL,
  reason     TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_codes (
  account    TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  sent_at    INTEGER NOT NULL
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
  price_per_share INTEGER NOT NULL DEFAULT 1, -- 每份金额（美元）
  total_shares  INTEGER NOT NULL,             -- 总份数（=商品价值/每份）
  free_quota    INTEGER NOT NULL DEFAULT 0,   -- 本商品允许的免费金币总额度
  free_used     INTEGER NOT NULL DEFAULT 0,   -- 已用免费额度
  desc          TEXT,
  gallery       TEXT,   -- JSON: [{type,url}]
  specs         TEXT,   -- JSON: [{k,v}]
  source_url    TEXT,
  status        TEXT NOT NULL DEFAULT 'active', -- 'active' | 'drawing' | 'done'
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  shares      INTEGER NOT NULL,
  numbers     TEXT NOT NULL,   -- JSON: 分配到的夺宝号码数组
  paid_coins  INTEGER NOT NULL DEFAULT 0,
  free_coins  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_tx (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,   -- recharge|spend|grant|refund
  amount     INTEGER NOT NULL, -- 正=进账 负=出账
  balance    INTEGER NOT NULL, -- 事后余额
  ref        TEXT,             -- 关联订单/支付号
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS draws (
  product_id     TEXT PRIMARY KEY,
  round          INTEGER NOT NULL,   -- drand 轮次
  randomness     TEXT,               -- 开奖后回填
  signature      TEXT,
  win_number     INTEGER,
  winner_user_id TEXT,
  total_shares   INTEGER NOT NULL,
  locked_at      INTEGER NOT NULL,   -- 锁定时间
  drawn_at       INTEGER,            -- 开奖完成时间
  win_address    TEXT                -- 中奖人填写的收货地址(JSON)
);

CREATE TABLE IF NOT EXISTS config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recharges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,          -- 币数（=美元，1币=$1）
  bonus INTEGER NOT NULL DEFAULT 0, -- 赠送金额
  method TEXT NOT NULL DEFAULT 'stripe', -- stripe | paypal
  status TEXT NOT NULL,             -- pending / paid / failed
  stripe_session TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
`);

// ---- 播种默认数据（幂等） ----
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

const seedCat = db.prepare(
  `INSERT OR IGNORE INTO categories (key,name,prefix,icon,sort) VALUES (?,?,?,?,?)`);
DEFAULT_CATEGORIES.forEach((c, i) => seedCat.run(c.key, c.name, c.prefix, c.icon, i));

const seedCfg = db.prepare(`INSERT OR IGNORE INTO config (k,v) VALUES (?,?)`);
for (const [k, v] of Object.entries(DEFAULT_CONFIG)) seedCfg.run(k, String(v));

// 迁移：recharges 表新增列（幂等）
try { db.exec(`ALTER TABLE recharges ADD COLUMN bonus INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE recharges ADD COLUMN method TEXT NOT NULL DEFAULT 'stripe'`); } catch {}

// 默认充值套餐
db.prepare(`INSERT OR IGNORE INTO config (k,v) VALUES (?,?)`)
  .run('recharge_packages', JSON.stringify([
    { amount: 10, bonus: 0 },
    { amount: 50, bonus: 5 },
    { amount: 100, bonus: 15 },
    { amount: 200, bonus: 40 },
  ]));

// 首次创建管理员
function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL || 'admin@luckybuy.local';
  const pass = process.env.ADMIN_PASSWORD || 'admin888';
  const exists = db.prepare(`SELECT id FROM users WHERE account=?`).get(email);
  if (!exists) {
    const now = Date.now();
    db.prepare(`INSERT INTO users
      (id,account,account_type,name,pass_hash,role,invite_code,paid_balance,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      'u_admin', email, 'email', '管理员',
      bcrypt.hashSync(pass, 10), 'admin', 'ADMIN0', 0, now);
    console.log(`[db] 已创建管理员账号: ${email}`);
  }
}
ensureAdmin();

export default db;

// 直接 `node db.js` 时仅初始化
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  console.log('[db] 初始化完成:', DB_PATH);
  if (!fs.existsSync(path.join(__dirname, '.env'))) {
    console.log('[db] 提示: 尚未创建 .env，请复制 .env.example');
  }
}
