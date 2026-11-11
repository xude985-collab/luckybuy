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
import crypto from 'node:crypto';
import {startPaymentWorker} from './lib/reconcilePayments.js';
import pool, { initDB } from './db.js';
import { startDrawWorker } from './lib/drawWorker.js';
import authRoutes from './routes/auth.js';
import shopRoutes from './routes/shop.js';
import walletRoutes from './routes/wallet.js';
import adminRoutes from './routes/admin.js';
import showcaseRoutes from './routes/showcase.js';
import stripeWebhook from './routes/stripe-webhook.js';
import { mountStaticSite } from './lib/staticSite.js';

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
// Render terminates HTTPS and forwards requests through its edge proxy.
app.set('trust proxy', 1);
// Stripe webhook 需原始 body 验签，必须在 express.json 之前
app.post('/api/wallet/stripe-webhook', express.raw({ type: 'application/json' }), stripeWebhook);

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser(process.env.SESSION_SECRET || 'dev-secret'));

// API 限流：通用限制（所有 API 接口）
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 分钟
  max: 300, // 多页面加载与公开轮询共享额度
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
app.use('/api/auth/send-code', strictLimiter);
app.use(['/api/auth/login','/api/auth/register'],rateLimit({windowMs:600000,max:30,skipSuccessfulRequests:true,standardHeaders:true,legacyHeaders:false,message:{ok:false,msg:'尝试次数过多，请10分钟后重试'}})); // 发送验证码严格限流
app.use('/api/wallet/recharge', strictLimiter); // 充值严格限流
app.use('/api/auth', authRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/showcase', showcaseRoutes);

app.get('/api/ready', async (req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true})}catch{res.status(503).json({ok:false,msg:'数据库暂不可用'})}});
app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now(),release:'20261111-full',commit:process.env.RENDER_GIT_COMMIT||null }));

// 仅公开前端页面、资源和上传文件。
mountStaticSite(app, SITE_DIR, path.join(__dirname, 'uploads'));

// 统一错误处理
app.use((err, req, res, next) => {
  const id=crypto.randomUUID();
  const status=err.code==='LIMIT_FILE_SIZE'?413:(err.status||500);
  logger.error({errorId:id,err},'请求失败编号');
  res.status(status).json({ok:false,msg:status===413?'上传文件不能超过5MB':status<500?err.message:'服务暂时不可用，请稍后重试',errorId:id});
});

export {app};
if(process.env.LUCKYBUY_TEST_MODE!=='1')app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Lucky Buy 后端已启动');
  startDrawWorker();
  startPaymentWorker();
});
