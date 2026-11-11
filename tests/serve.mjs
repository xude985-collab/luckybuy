// 只托管静态页面，浏览器测试中的 API 全部使用固定数据，不读取 .env 或连接业务数据库。
import express from '../server/node_modules/express/index.js';
import { mountStaticSite } from '../server/lib/staticSite.js';
import { fileURLToPath } from 'node:url';
const app = express();
mountStaticSite(app, fileURLToPath(new URL('../', import.meta.url)), '/nonexistent-uploads');
app.listen(43179, '127.0.0.1');
