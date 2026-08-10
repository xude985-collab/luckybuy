/*
 * Lucky Buy 后端主应用
 *   - 托管前端静态站点（上级目录）
 *   - /api/* 提供接口
 *   - 管理后台需 admin 角色
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';

import { initDB } from './db.js';
import { startDrawWorker } from './lib/drawWorker.js';
import authRoutes from './routes/auth.js';
import shopRoutes from './routes/shop.js';
import walletRoutes from './routes/wallet.js';
import adminRoutes from './routes/admin.js';
import showcaseRoutes from './routes/showcase.js';
import stripeWebhook from './routes/stripe-webhook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(__dirname, '..'); // 前端根目录
const PORT = process.env.PORT || 3000;

// 初始化数据库（建表 + 播种），带重试
async function boot() {
  const MAX_RETRIES = 5;
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      await initDB();
      console.log('[db] 连接成功');
      return;
    } catch (err) {
      console.error(`[db] 第 ${i}/${MAX_RETRIES} 次连接失败:`, err.message);
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

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/showcase', showcaseRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// 静态前端（放在 API 之后，避免拦截 /api）
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(SITE_DIR, { extensions: ['html'], maxAge: 0, etag: false }));

// 统一错误处理
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ ok: false, msg: err.message || '服务器错误' });
});

app.listen(PORT, () => {
  console.log(`\n  Lucky Buy 后端已启动`);
  console.log(`  → http://localhost:${PORT}\n`);
  startDrawWorker();
});
