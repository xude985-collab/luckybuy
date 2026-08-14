/*
 * Lucky Buy 后端主应用
 *   - 托管前端静态站点（上级目录）
 *   - /api/* 提供接口
 *   - 管理后台需 admin 角色
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';

import logger from './lib/logger.js';
import { initDB } from './db.js';
import { startDrawWorker } from './lib/drawWorker.js';
import authRoutes from './routes/auth.js';
import shopRoutes from './routes/shop.js';
import walletRoutes from './routes/wallet.js';
import adminRoutes from './routes/admin.js';
import showcaseRoutes from './routes/showcase.js';
import stripeWebhook from './routes/stripe-webhook.js';

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'unhandledRejection');
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(__dirname, '..'); // 前端根目录
const PORT = process.env.PORT || 3000;

// 初始化数据库（建表 + 播种），带重试
async function boot() {
  const MAX_RETRIES = 5;
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      await initDB();
      logger.info('数据库连接成功');
      return;
    } catch (err) {
      logger.error({ err, attempt: i, maxRetries: MAX_RETRIES }, '数据库连接失败');
      if (i === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, i * 2000));
    }
  }
}
await boot();

const app = express();
// Stripe webhook 需原始 body 验签，必须在 express.json 之前
app.post('/api/wallet/stripe-webhook', express.raw({ type: 'application/json' }), stripeWebhook);

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser(process.env.SESSION_SECRET || 'dev-secret'));

// API 限流：通用限制（所有 API 接口）
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 分钟
  max: 60, // 最多 60 个请求
  message: { ok: false, msg: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 严格限流：敏感操作（发验证码、充值等）
const strictLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 分钟
  max: 3, // 最多 3 个请求
  message: { ok: false, msg: '操作过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// API 路由
app.use('/api/', apiLimiter); // 所有 API 接口通用限流
app.use('/api/auth/send-code', strictLimiter); // 发送验证码严格限流
app.use('/api/wallet/recharge', strictLimiter); // 充值严格限流
app.use('/api/auth', authRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/showcase', showcaseRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// 静态前端（放在 API 之后，避免拦截 /api）
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use((req, res, next) => {
  if (/\.(js|css)$/i.test(req.path)) {
    res.set('Cache-Control', 'no-store, must-revalidate');
  }
  next();
});
app.use(express.static(SITE_DIR, { extensions: ['html'], maxAge: 0, etag: false }));

// 统一错误处理
app.use((err, req, res, next) => {
  logger.error({ err, path: req.path, method: req.method }, '请求处理错误');
  res.status(err.status || 500).json({ ok: false, msg: err.message || '服务器错误' });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Lucky Buy 后端已启动');
  startDrawWorker();
});
