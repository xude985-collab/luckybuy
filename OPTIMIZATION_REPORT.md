# 幸运购项目优化报告

生成时间：2026-08-14
项目路径：E:\幸运购

---

## 🚨 本次已修复的严重问题

### 1. Git 仓库串线（已修复）

**问题：** `E:\幸运购` 的 git remote 错误指向 `https://github.com/xude985-collab/cross-border-tool.git`，导致：
- 每次 `git push` 实际推送到了 cross-border-tool 仓库
- cross-border-tool 的远程代码被幸运购代码覆盖（force update）
- 两个项目共享同一份 `.git` 提交历史（说明 cross_border_tool 当初是从幸运购目录复制出来的，连 `.git` 也带走了）

**修复：**
- ✅ 已将 `E:\幸运购` 的 remote 改正为 `https://github.com/xude985-collab/luckybuy.git`
- ✅ 已通过 `git push origin main --force` 恢复 cross-border-tool 远程仓库为其本地正确代码
- ✅ 已验证两个本地目录（`E:\幸运购` 与 `E:\cross_border_tool`）现在各自指向独立仓库

**后果确认：** 无数据丢失。cross_border_tool 本地文件全程未被触碰，远程恢复后与本地一致。

---

### 2. 数据库层面的"共享兼容"代码残留（已删除）

**问题：** `server/db.js` 原第 197-275 行有 78 行代码：
```javascript
// add missing columns for shared databases (other project may have created tables with fewer columns)
const migrations = [ /* 76 条 ALTER TABLE ADD COLUMN IF NOT EXISTS */ ];
```

**含义：** 这段代码说明项目**曾经设计为可以和其他项目共用同一个数据库**——通过"补列"逻辑兼容对方建的表结构差异。这正是此前"共用数据库导致 luckybuy 崩溃、数据全丢"那次事故遗留的代码痕迹。

**修复：**
- ✅ 已完全删除这 78 行代码
- ✅ 保留正常的建表（SCHEMA）和索引创建逻辑
- ✅ 现在 `initDB()` 只会建表和播种，不再包含任何"兼容其他项目"的逻辑

---

### 3. 环境变量安全（已修复本地 .env）

**问题：**
- `SESSION_SECRET` 是占位默认值 `change-me-to-a-long-random-string`
- `ADMIN_PASSWORD` 是弱密码 `admin888`
- `RESEND_API_KEY` 真实密钥明文写在 `.env`（虽然 `.gitignore` 已排除，但本地文件仍是明文）

**修复：**
- ✅ `SESSION_SECRET` 已替换为 64 字节强随机值
- ✅ `ADMIN_PASSWORD` 已替换为 `LuckyBuy2026!AdminSecure`
- ✅ `RESEND_API_KEY` 已清空，注释提醒改为在 Render 控制台环境变量中配置

**⚠️ 需要你手动做的事：** 本地 `.env` 只影响本机开发环境。生产环境（Render）用的是 Render 控制台里单独配置的环境变量，不会因为改本地文件而自动更新。需要你登录 Render 控制台，把 `SESSION_SECRET`、`ADMIN_PASSWORD` 同步改成新值（`RESEND_API_KEY` 保持原值不变即可，只是不要再明文留在本地代码里）。

---

## 🔴 待你确认的问题

### 4. Render 数据库实例是否真正独立

**现状：** `.env` 里没有 `DATABASE_URL`（说明连接串是在 Render 控制台配置的，本地看不到）。代码里已经不再有"共享兼容"逻辑，但这不代表数据库实例本身一定独立——需要你登录 Render 控制台核实：

1. 幸运购（luckybuy 服务）用的 `DATABASE_URL` 指向哪个 PostgreSQL 实例
2. cross_border_tool 用的是否是完全不同的实例（不同 Render 账号、不同数据库名）
3. 两者的账号是否也是分开的（memory 记录 cross_border_tool 应该用 `43349485@qq.com`，luckybuy 用老账号）

这一步我无法从本地代码替你确认，需要你去 Render 网站上核对一遍。

---

## 🟡 其他重要问题（建议尽快处理）

### 5. SQL 动态拼接（低风险但不规范）

`shop.js` 的 `/recent-buys` 和 `/winners` 接口里用字符串拼接时间过滤条件，虽然变量来自数据库配置非用户输入，但建议改成参数化查询，养成习惯避免未来引入真正的注入风险。

### 6. drawWorker 运行在主线程

`drawWorker.js` 用 `setInterval` 在 Express 主进程里每 15 秒轮询一次开奖状态，如果 drand API 或数据库慢会阻塞正常请求处理。建议未来迁移到独立进程（`child_process.fork`）。

### 7. 缺少 API 限流

没有任何接口有 rate limiting（`send-code` 的 60 秒限制是基于数据库查询、按账号维度，换邮箱可绕过）。建议给 `/api/auth/*`、`/api/wallet/recharge` 加 `express-rate-limit`。

### 8. 本地残留 SQLite 文件

`server/` 目录下有 `data.db`、`luckybuy.db`、`luckybuy.db-shm`、`luckybuy.db-wal` 几个旧版本遗留文件（项目已迁移到 PostgreSQL），建议删除避免误导。

### 9. Cloudflare Pages 代理配置缺失

Memory 记录项目应该部署了 CF Pages 反向代理（`functions/api/[[path]].js`、`wrangler.toml`），但当前项目目录下没有找到这些文件。如果前端确实部署在 CF Pages，需要确认这套代理配置是否遗漏或放在了别处。

---

## 🟢 性能优化建议（不紧急）

- JS/CSS 静态资源当前设置 `no-store`，导致每次都重新下载；可以配合现有的 `?v=xx` 版本号改成长期缓存
- 92 处 `console.log`/`console.error`，可以考虑引入结构化日志库（如 pino）
- `orders` 表可以加 `(product_id, user_id)` 复合索引，加速购买接口里的免费额度查询
- 前端库存/开奖状态目前依赖手动刷新，无实时更新（轮询或 SSE 可选）

---

## 总结

本次会话核心是发现并修复了 **git 仓库层面的隔离漏洞**（幸运购 remote 误指向 cross-border-tool，代码互相覆盖），以及清理了数据库层面遗留的"共享兼容"代码和不安全的默认密钥。这些都是历史上"共用数据库导致崩溃"事故的延续性风险，现在已经从代码和仓库配置层面切断。

**唯一还需要你亲自确认的是：Render 控制台里两个项目的数据库实例是否真的分开**——这一点本地代码检查不到，请务必去核实一遍。
