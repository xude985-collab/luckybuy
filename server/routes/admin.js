import {paymentMethods} from '../lib/paymentStatus.js';
/* 管理后台接口。全部要求 admin 角色。 */
import express from 'express';
import pool from '../db.js';
import { attachUser, requireAdmin, getConfig, genId, withTransaction, walletTx } from '../lib/helpers.js';
import { fetchAmazon } from '../lib/amazon.js';
import { fetchSaleyee } from '../lib/saleyee.js';
import { fetchDoba } from '../lib/doba.js';

import {productUrl} from '../lib/productUrl.js';
import {audit, bad, integer, resetSales} from '../lib/operations.js';

const router = express.Router();
router.use(attachUser);

// Manual test credit: admin only, additive and replay-safe.
router.post('/test-recharge', requireAdmin, async (req,res,next) => {
  try {
    const amount=integer(req.body.amount,'测试充值金额',1,5000);
    const account=String(req.body.account||req.user.account).trim().toLowerCase();
    const key=String(req.body.requestKey||'');
    if(!/^[a-f0-9-]{36}$/.test(key))throw bad('请求编号无效');
    const id='test_'+req.user.id+'_'+key;
    const result=await withTransaction(async c=>{
      const u=(await c.query('SELECT id,account,disabled FROM users WHERE account=$1 FOR UPDATE',[account])).rows[0];
      if(!u||u.disabled)throw bad('账号不存在或已停用');
      const old=(await c.query('SELECT user_id,amount FROM recharges WHERE id=$1',[id])).rows[0];
      if(old){if(old.user_id!==u.id||Number(old.amount)!==amount)throw bad('请求已用于其他充值',409);return {account:u.account};}
      await c.query("INSERT INTO recharges(id,user_id,amount,bonus,method,status,created_at,paid_at) VALUES($1,$2,$3,0,'admin-test','paid',$4,$4)",[id,u.id,amount,Date.now()]);
      await walletTx(u.id,'test-credit',amount,'管理员测试充值（未实际付款）',c);
      await audit(c,req.user.id,'test-recharge',u.id,{amount,rechargeId:id});
      return {account:u.account};
    });
    res.json({ok:true,msg:result.account+' 已测试到账 '+amount+' 金币',rechargeId:id});
  } catch(e){next(e);}
});

async function nextSku(category, client) {
  const q = client || pool;
  const { rows: catRows } = await q.query(`SELECT prefix FROM categories WHERE key=$1`, [category]);
  const prefix = catRows[0] ? catRows[0].prefix : 'OT';
  const { rows: seqRows } = await q.query(
    `INSERT INTO sku_seq (prefix,n) VALUES ($1,1) ON CONFLICT(prefix) DO UPDATE SET n=sku_seq.n+1 RETURNING n`,
    [prefix]);
  return prefix + String(seqRows[0].n).padStart(4, '0');
}

const clampInt = (v, min, def) => Math.max(min, parseInt(v) || def);

// 后台概览
router.get('/overview', requireAdmin, async (req, res, next) => {
  try {
    const users = (await pool.query(`SELECT COUNT(*) c FROM users WHERE deleted_at IS NULL`)).rows[0].c;
    const products = (await pool.query(`SELECT COUNT(*) c FROM products`)).rows[0].c;
    const orders = (await pool.query(`SELECT COUNT(*) c FROM orders`)).rows[0].c;
    const revenue = (await pool.query(`SELECT COALESCE(SUM(paid_coins),0) s FROM orders`)).rows[0].s;
    const config = await getConfig();
    res.json({ ok: true, stats: { users: Number(users), products: Number(products), orders: Number(orders), revenue: Number(revenue) }, config });
  } catch (e) { next(e); }
});

// 最近订单（dashboard 用）
router.get('/recent-orders', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.shares, o.paid_coins, o.free_coins, o.created_at, u.account, p.name AS product_name
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN products p ON p.id = o.product_id
       ORDER BY o.created_at DESC LIMIT 20`);
    res.json({ ok: true, orders: rows });
  } catch (e) { next(e); }
});

// 送币规则读写
router.get('/config', requireAdmin, async (req, res, next) => {
  try { res.json({ ok: true, config: await getConfig() }); }
  catch (e) { next(e); }
});

router.post('/config', requireAdmin, async (req, res, next) => {
  try {
    const allowed = ['grantRegister', 'grantCheckin', 'grantShowcase', 'grantInvitee', 'grantInviter',
                     'recentBuysHours', 'winnersHours', 'showcaseHours', 'drawDelay'];
    const entries=[];
    for(const k of allowed)if(req.body[k]!=null)entries.push([k,String(integer(req.body[k],k,k==='drawDelay'?1:0,k==='drawDelay'?60:100000))]);
    if(req.body.recharge_packages!=null){
      if(!Array.isArray(req.body.recharge_packages)||req.body.recharge_packages.length>30)throw bad('充值套餐格式无效');
      const seen=new Set();
      const pkgs=req.body.recharge_packages.map(p=>{const amount=integer(p.amount,'套餐金额',1,5000),bonus=integer(p.bonus??0,'赠送金币',0,100000);if(seen.has(amount))throw bad('套餐金额不能重复');seen.add(amount);return {amount,bonus}});
      entries.push(['recharge_packages',JSON.stringify(pkgs)]);
    }
    if(req.body.databaseExpiresAt!=null){const date=String(req.body.databaseExpiresAt);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date)))throw bad('请输入有效的数据库到期日期');entries.push(['databaseExpiresAt',date]);}
    if(req.body.doba_cookie!=null)entries.push(['doba_cookie',String(req.body.doba_cookie).trim()]);
    await withTransaction(async c=>{
      for(const [k,v] of entries)await c.query('INSERT INTO config (k,v) VALUES ($1,$2) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v',[k,v]);
      await audit(c,req.user.id,'config',null,{keys:entries.map(e=>e[0])});
    });
    res.json({ ok: true, config: await getConfig() });
  } catch (e) { next(e); }
});

// ---- 商品管理 ----
router.get('/products', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, COALESCE(s.total,0) AS sold FROM products p
       LEFT JOIN (SELECT product_id, SUM(shares) AS total FROM orders GROUP BY product_id) s
         ON s.product_id=p.id
       ORDER BY p.created_at DESC`);
    res.json({ ok: true, products: rows.map(p => ({ ...p, sold: Number(p.sold) })) });
  } catch (e) { next(e); }
});

router.post('/products', requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.category) return res.status(400).json({ ok: false, msg: '缺少名称或类别' });

    const referencePrice = b.pricing?.referencePrice;
    if (b.sourceUrl && !(Number.isFinite(referencePrice) && referencePrice > 0)) throw bad('未读取到商品美元价格，请补填参考价后再保存，不能按1份上架');
    if(referencePrice != null && (!Number.isFinite(referencePrice)||referencePrice<=0||referencePrice>666666))throw bad('参考价无效');
    const pricePerShare = 1;
    const totalShares = referencePrice != null ? Math.max(1, Math.round(referencePrice * 1.5)) : integer(b.totalShares,'总份数',1,1000000);
    const freeQuota = Math.round(totalShares * 0.05);
    const pricing = JSON.stringify({referencePrice:referencePrice??null,multiplier:1.5,freeRatio:5});
    const gallery = JSON.stringify(Array.isArray(b.gallery) ? b.gallery : []);
    const specs = JSON.stringify(Array.isArray(b.specs) ? b.specs : []);

    if (b.id) {
      await withTransaction(async client => {
        const { rows: cur } = await client.query(`SELECT * FROM products WHERE id=$1 FOR UPDATE`, [b.id]);
        if (!cur.length) throw Object.assign(new Error('商品不存在'), { status: 404 });
        const { rows: participated } = await client.query(`SELECT 1 FROM orders WHERE product_id=$1 LIMIT 1`, [b.id]);
        if ((cur[0].status !== 'active' || participated.length) &&
            (totalShares !== cur[0].total_shares || pricePerShare !== cur[0].price_per_share))
          throw Object.assign(new Error('已有参与记录的商品不能修改价格或总份数'), { status: 400 });
        await client.query(
          `UPDATE products SET name=$1,category=$2,emoji=$3,price_per_share=$4,total_shares=$5,
           free_quota=$6,"desc"=$7,gallery=$8,specs=$9,source_url=$10,pricing=COALESCE($12::jsonb,pricing) WHERE id=$11`,
          [b.name, b.category, b.emoji || '🎁', pricePerShare, totalShares,
           freeQuota, b.desc || '', gallery, specs, b.sourceUrl || '', b.id, pricing??null]);
      });
      return res.json({ ok: true, id: b.id, msg: '已更新' });
    }

    const id = genId('p_');
    const sku = await nextSku(b.category);
    await pool.query(
      `INSERT INTO products (id,sku,name,category,emoji,price_per_share,total_shares,free_quota,free_used,"desc",gallery,specs,source_url,status,created_at,pricing)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12,'active',$13,$14::jsonb)`,
      [id, sku, b.name, b.category, b.emoji || '🎁', pricePerShare, totalShares,
       freeQuota, b.desc || '', gallery, specs, b.sourceUrl || '', Date.now(), pricing??'{}']);
    res.json({ ok: true, id, sku, msg: '已上架' });
  } catch (e) { next(e); }
});

router.delete('/products/:id', requireAdmin, async (req, res, next) => {
  try {
    await withTransaction(async client => {
      await client.query(`SELECT id FROM products WHERE id=$1 FOR UPDATE`, [req.params.id]);
      const { rows } = await client.query(`SELECT 1 FROM orders WHERE product_id=$1 LIMIT 1`, [req.params.id]);
      if (rows.length) throw Object.assign(new Error('已有参与记录，不能删除'), { status: 400 });
      await client.query(`DELETE FROM products WHERE id=$1`, [req.params.id]);
    });
    res.json({ ok: true, msg: '已删除' });
  } catch (e) { next(e); }
});

router.post('/debug-doba', requireAdmin, (req,res)=>res.status(410).json({ok:false,msg:'调试接口已关闭，请使用商品导入'}));

// ---- 商品链接导入（赛盈 / 亚马逊） ----
router.post('/import-product', requireAdmin, async (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!url) return res.status(400).json({ ok: false, msg: '请填写商品链接' });

  try {
    const provider=productUrl(url).provider;
    let draft;
    if (provider==='saleyee') {
      draft = await fetchSaleyee(url);
    } else if (provider==='doba') {
      draft = await fetchDoba(url);
    } else if (provider==='amazon') {
      draft = await fetchAmazon(url);
    } else {
      return res.status(400).json({ ok: false, msg: '不支持的链接，目前支持赛盈(saleyee.com)、Doba 和亚马逊' });
    }
    res.json({ ok: true, draft });
  } catch (e) {
    res.status(e.status === 400 ? 400 : 502).json({ ok: false, msg: '导入失败：' + (e.message || '可稍后重试或手动录入') });
  }
});

// 兼容旧接口
router.post('/import-amazon', requireAdmin, async (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!/^https?:\/\/.*amazon\./i.test(url))
    return res.status(400).json({ ok: false, msg: '请填写有效的亚马逊商品链接' });
  try {
    const draft = await fetchAmazon(url);
    res.json({ ok: true, draft });
  } catch (e) {
    res.status(502).json({ ok: false, msg: '抓取失败：' + (e.message || '可稍后重试或手动录入') });
  }
});

// ---- 类别管理 ----
router.post('/categories', requireAdmin, async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim();
    const prefix = (req.body?.prefix || '').trim().toUpperCase();
    const icon = (req.body?.icon || '🏷️').trim() || '🏷️';
    if (!name) return res.status(400).json({ ok: false, msg: '请填写类别名称' });
    if (!/^[A-Z0-9]{2,4}$/.test(prefix)) return res.status(400).json({ ok: false, msg: '编号前缀须为 2~4 位字母或数字' });
    const { rows: dup } = await pool.query(`SELECT 1 FROM categories WHERE prefix=$1`, [prefix]);
    if (dup.length) return res.status(400).json({ ok: false, msg: `前缀 ${prefix} 已被占用` });

    let key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cat';
    while ((await pool.query(`SELECT 1 FROM categories WHERE key=$1`, [key])).rows.length) key += '-x';

    const { rows: maxRows } = await pool.query(`SELECT COALESCE(MAX(sort),0) AS m FROM categories`);
    const sort = Number(maxRows[0].m) + 1;
    await pool.query(`INSERT INTO categories (key,name,prefix,icon,sort) VALUES ($1,$2,$3,$4,$5)`,
      [key, name, prefix, icon, sort]);
    res.json({ ok: true, key, msg: '已添加类别' });
  } catch (e) { next(e); }
});

router.delete('/categories/:key', requireAdmin, async (req, res, next) => {
  try {
    const key = req.params.key;
    const { rows: used } = await pool.query(`SELECT COUNT(*) c FROM products WHERE category=$1`, [key]);
    if (Number(used[0].c) > 0) return res.status(400).json({ ok: false, msg: `该类别下有商品，请先下架后再删` });
    const { rows: total } = await pool.query(`SELECT COUNT(*) c FROM categories`);
    if (Number(total[0].c) <= 1) return res.status(400).json({ ok: false, msg: '至少保留一个类别' });
    await pool.query(`DELETE FROM categories WHERE key=$1`, [key]);
    res.json({ ok: true, msg: '已删除类别' });
  } catch (e) { next(e); }
});

router.put('/categories/:key', requireAdmin, async (req, res, next) => {
  try {
    const key = req.params.key;
    const name = (req.body?.name || '').trim();
    const icon = (req.body?.icon || '').trim();
    if (!name) return res.status(400).json({ ok: false, msg: '名称不能为空' });
    const sets = ['name=$1'];
    const vals = [name];
    if (icon) { sets.push(`icon=$${sets.length + 1}`); vals.push(icon); }
    vals.push(key);
    await pool.query(`UPDATE categories SET ${sets.join(',')} WHERE key=$${vals.length}`, vals);
    res.json({ ok: true, msg: '已更新类别' });
  } catch (e) { next(e); }
});

router.post('/categories/reorder', requireAdmin, async (req, res, next) => {
  try {
    const keys = req.body?.keys;
    if (!Array.isArray(keys) || !keys.length) return res.status(400).json({ ok: false, msg: '缺少排序数据' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < keys.length; i++) {
        await client.query(`UPDATE categories SET sort=$1 WHERE key=$2`, [i, keys[i]]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true, msg: '排序已保存' });
  } catch (e) { next(e); }
});

// Reset operations require an explicit reason; historical rows are retained in admin_audit.
for (const route of ['/reset-orders', '/reset-product/:productId']) {
  router.post(route, requireAdmin, async (req,res,next)=>{
    try { const count=await resetSales(req.user.id,req.params.productId,req.body?.confirmation,req.body?.reason);
      res.json({ok:true,msg:`已重置并退回${count}笔订单，原记录已归档`});
    } catch(e){next(e)}
  });
}
router.post('/fix-balance',requireAdmin,async(req,res,next)=>{
 try {
  const {userId,paidBalance,freeBalance,reason}=req.body||{};
  if(!userId||typeof reason!=='string'||reason.trim().length<3)throw bad('请选择用户并填写至少3字的调整原因');
  if(paidBalance===undefined&&freeBalance===undefined)throw bad('请指定调整后的余额');
  const paid=paidBalance===undefined?undefined:integer(paidBalance,'充值余额');
  const free=freeBalance===undefined?undefined:integer(freeBalance,'免费余额');
  await withTransaction(async c=>{
    const {rows}=await c.query('SELECT paid_balance,free_balance FROM users WHERE id=$1 FOR UPDATE',[userId]);
    if(!rows.length)throw bad('用户不存在',404);
    if(paid!==undefined)await walletTx(userId,'adjust',paid-Number(rows[0].paid_balance),`管理员调整：${reason}`,c);
    if(free!==undefined)await walletTx(userId,'grant',free-Number(rows[0].free_balance),`管理员调整免费金币：${reason}`,c);
    await audit(c,req.user.id,'balance',userId,{before:rows[0],paid,free,reason});
  });res.json({ok:true,msg:'余额已修正并记录流水'});
 }catch(e){next(e)}
});
router.post('/fix-product-free',requireAdmin,async(req,res,next)=>{
 try {
  const {productId,freeUsed,reason}=req.body||{};const amount=integer(freeUsed,'已用免费份数');
  if(typeof reason!=='string'||reason.trim().length<3)throw bad('请填写调整原因');
  await withTransaction(async c=>{
    const {rows}=await c.query('SELECT * FROM products WHERE id=$1 FOR UPDATE',[productId]);
    if(!rows.length)throw bad('商品不存在',404);
    const actual=Number((await c.query('SELECT COUNT(*) AS n FROM orders WHERE product_id=$1 AND free_coins>0',[productId])).rows[0].n);
    if(amount!==actual)throw bad('修正值必须与订单实际免费参与份数一致');
    await c.query('UPDATE products SET free_used=$1 WHERE id=$2',[amount,productId]);
    await audit(c,req.user.id,'product-free',productId,{before:rows[0].free_used,after:amount,reason});
  });res.json({ok:true,msg:'已按订单核对修正'});
 }catch(e){next(e)}
});

// ---- 用户管理 ----
// Recovered from historical commit 479be2d: read-only reward/check-in detail.
router.get('/free-coin-detail', requireAdmin, async(req,res,next)=>{
 try{
  const uid=String(req.query.userId||''),account=String(req.query.account||'').trim().toLowerCase();
  if(!uid&&!account)throw bad('请填写用户ID或邮箱');
  const {rows}=await pool.query(`SELECT id,name,account,free_balance,paid_balance FROM users WHERE ${uid?'id':'account'}=$1`,[uid||account]);
  if(!rows.length)throw bad('用户不存在',404);
  const id=rows[0].id;
  const walletGrants=(await pool.query("SELECT kind,amount,balance,ref,created_at FROM wallet_tx WHERE user_id=$1 AND kind IN ('grant','recharge','free-use','adjust-free') ORDER BY created_at DESC LIMIT 50",[id])).rows;
  const checkins=(await pool.query('SELECT streak,reward,created_at FROM checkins WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',[id])).rows;
  const freeGrants=(await pool.query('SELECT amount,reason,created_at FROM free_grants WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',[id])).rows;
  res.json({ok:true,user:rows[0],walletGrants,checkins,freeGrants});
 }catch(e){next(e)}
});

router.get('/users', requireAdmin, async (req, res, next) => {
  try {
    const page=Math.max(1,parseInt(req.query.page)||1), size=30;
    const search=String(req.query.q||'').slice(0,100);
    const filter="WHERE deleted_at IS NULL AND ($1='' OR strpos(lower(account),lower($1))>0 OR strpos(lower(name),lower($1))>0)";
    const total=Number((await pool.query(`SELECT COUNT(*) AS n FROM users ${filter}`,[search])).rows[0].n);
    const {rows}=await pool.query(`SELECT id,account,name,role,paid_balance,free_balance,disabled,created_at FROM users ${filter} ORDER BY created_at DESC,id LIMIT $2 OFFSET $3`,[search,size,(page-1)*size]);
    res.json({ok:true,users:rows,total,page,pages:Math.max(1,Math.ceil(total/size))});
  } catch (e) { next(e); }
});

router.post('/users/:id/rename', requireAdmin, async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, msg: '名称不能为空' });
    await pool.query(`UPDATE users SET name=$1 WHERE id=$2`, [name, req.params.id]);
    res.json({ ok: true, msg: '昵称已修改' });
  } catch (e) { next(e); }
});

router.post('/users/:id/reset-pwd', requireAdmin, async (req, res, next) => {
  try {
    const password = (req.body?.password || '').trim();
    if (password.length < 8 || Buffer.byteLength(password)>72) throw bad('新密码至少8位，最多72字节');
    const { default: bcrypt } = await import('bcryptjs');
    const hash = await bcrypt.hash(password, 10);
    await withTransaction(async c=>{
      const changed=await c.query('UPDATE users SET pass_hash=$1 WHERE id=$2 RETURNING id',[hash,req.params.id]);
      if(!changed.rows.length)throw bad('用户不存在',404);
      await c.query('DELETE FROM sessions WHERE user_id=$1',[req.params.id]);
      await audit(c,req.user.id,'reset-password',req.params.id,{});
    });
    res.json({ ok: true, msg: '密码已重置' });
  } catch (e) { next(e); }
});

// Remove the account from management while preserving historical transaction identity.
router.post('/users/:id/delete', requireAdmin, async(req,res,next)=>{
 try{
  if(req.body?.confirmation!=='DELETE')throw bad('请确认删除用户');
  await withTransaction(async c=>{
   const u=(await c.query('SELECT id,account,name,role,deleted_at FROM users WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
   if(!u)throw bad('用户不存在',404);
   if(u.id===req.user.id||u.role==='admin')throw bad('不能删除管理员账号');
   if(u.deleted_at)return;
   await c.query("UPDATE users SET disabled=true,deleted_at=$2,deleted_account=account,account='deleted:'||id WHERE id=$1",[u.id,Date.now()]);
   await c.query('DELETE FROM sessions WHERE user_id=$1',[u.id]);
   await audit(c,req.user.id,'delete-user',u.id,{account:u.account,name:u.name,retainedHistory:true});
  });
  res.json({ok:true,msg:'用户已删除，历史交易记录保留'});
 }catch(e){next(e)}
});

router.delete('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const uid = req.params.id;
    await withTransaction(async c=>{
      const {rows}=await c.query('SELECT role FROM users WHERE id=$1 FOR UPDATE',[uid]);
      if(!rows.length)throw bad('用户不存在',404);
      if(rows[0].role==='admin')throw bad('不能停用管理员');
      await c.query('UPDATE users SET disabled=true WHERE id=$1',[uid]);
      await c.query('DELETE FROM sessions WHERE user_id=$1',[uid]);
      await audit(c,req.user.id,'disable-user',uid,{});
    });
    res.json({ok:true,msg:'用户已停用，交易记录保留'});
  } catch (e) { next(e); }
});

// ---- 中奖订单管理 ----
router.get('/wins', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.product_id, d.win_number, d.winner_user_id, d.win_address,
              d.drawn_at, d.ship_status, d.ship_note,
              p.name AS product_name, p.sku,
              u.account AS winner_account, u.name AS winner_name
       FROM draws d
       LEFT JOIN products p ON p.id = d.product_id
       LEFT JOIN users u ON u.id = d.winner_user_id
       WHERE d.winner_user_id IS NOT NULL
       ORDER BY d.drawn_at DESC`);
    res.json({ ok: true, wins: rows });
  } catch (e) { next(e); }
});

router.post('/wins/:productId/ship', requireAdmin, async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { status, note } = req.body || {};
    const validStatus = ['pending', 'shipped', 'done'];
    if (!validStatus.includes(status)) return res.status(400).json({ ok: false, msg: '无效状态' });
    const changed = await pool.query(
      `UPDATE draws SET ship_status=$1, ship_note=CASE WHEN $4 THEN $2 ELSE ship_note END
       WHERE product_id=$3 AND winner_user_id IS NOT NULL AND ($1='pending' OR win_address IS NOT NULL) RETURNING product_id`,
      [status, note == null ? null : String(note).slice(0,1000), productId, note !== undefined]);
    if(!changed.rows.length)throw bad('中奖订单不存在或尚未填写收货地址');
    res.json({ ok: true, msg: '已更新' });
  } catch (e) { next(e); }
});

export default router;

router.post('/users/:id/enable',requireAdmin,async(req,res,next)=>{try{await withTransaction(async c=>{const r=await c.query('UPDATE users SET disabled=false WHERE id=$1 AND deleted_at IS NULL RETURNING id',[req.params.id]);if(!r.rows.length)throw bad('用户不存在',404);await audit(c,req.user.id,'enable-user',req.params.id,{})});res.json({ok:true,msg:'用户已启用'})}catch(e){next(e)}});
router.get('/audit',requireAdmin,async(req,res,next)=>{try{const page=Math.max(1,parseInt(req.query.page)||1);const {rows}=await pool.query('SELECT id,actor_id,action,target_id,created_at FROM admin_audit ORDER BY created_at DESC LIMIT 50 OFFSET $1',[(page-1)*50]);res.json({ok:true,records:rows,page})}catch(e){next(e)}});
router.get('/users/:id/ledger',requireAdmin,async(req,res,next)=>{try{const page=Math.max(1,parseInt(req.query.page)||1);const {rows}=await pool.query('SELECT * FROM wallet_tx WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50 OFFSET $2',[req.params.id,(page-1)*50]);res.json({ok:true,records:rows,page})}catch(e){next(e)}});

router.get('/system-status',requireAdmin,async(req,res,next)=>{try{await pool.query('SELECT 1');const config=await getConfig();res.json({ok:true,database:true,databaseExpiresAt:config.databaseExpiresAt||null,daysRemaining:config.databaseExpiresAt?Math.ceil((Date.parse(config.databaseExpiresAt)-Date.now())/86400000):null,payments:paymentMethods(),mail:!!(process.env.RESEND_API_KEY||process.env.SMTP_HOST),sms:false})}catch(e){next(e)}});
