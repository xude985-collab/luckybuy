import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
// A real PostgreSQL WASM engine in memory. Never read production credentials.
process.env.DOTENV_CONFIG_PATH='__test_no_env__';
process.env.DATABASE_URL='postgresql://invalid:invalid@127.0.0.1:1/unused';
process.env.LUCKYBUY_TEST_MODE='1';
process.env.ADMIN_PASSWORD='test-admin-password';
process.env.ADMIN_EMAIL='admin@test.invalid';
process.env.NODE_ENV='test';process.env.LOG_LEVEL='silent';
delete process.env.STRIPE_SECRET_KEY;delete process.env.PAYPAL_CLIENT_ID;
const db=new PGlite();
const {default:pool}=await import('../server/db.js');
let queue=Promise.resolve();
async function lock(){const prev=queue;let release;queue=new Promise(r=>release=r);await prev;return release;}
async function query(sql,args){if(args)return db.query(sql,args);return (await db.exec(sql)).at(-1)||{rows:[]};}
pool.connect=async()=>{const release=await lock();return {query,release}};
pool.query=async(sql,args)=>{const release=await lock();try{return await query(sql,args)}finally{release()}};
const {app}=await import('../server/app.js');
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const origin='http://127.0.0.1:'+server.address().port;
async function api(path,body,cookie='',method=body?'POST':'GET'){
 const r=await fetch(origin+'/api'+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie},body:body?JSON.stringify(body):undefined});
 const data=await r.json();return {status:r.status,data,cookie:r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};
}
let adminCookie,userCookie;
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await db.close();await pool.end();});
test('integrated money/account/fulfillment workflows on isolated PostgreSQL',async t=>{
 const login=await api('/auth/login',{account:'admin@test.invalid',password:'test-admin-password'});assert.equal(login.data.ok,true);adminCookie=login.cookie;
 const hash=(await pool.query("SELECT pass_hash FROM users WHERE id='u_admin'")).rows[0].pass_hash;
 await pool.query("INSERT INTO users(id,account,account_type,name,pass_hash,role,invite_code,paid_balance,free_balance,created_at) VALUES ('u_test','user@test.invalid','email','测试用户',$1,'user','TEST01',20,10,1)",[hash]);
 userCookie=(await api('/auth/login',{account:'user@test.invalid',password:'test-admin-password'})).cookie;
 let product;
 await t.test('create product and replay purchase exactly once',async()=>{
  const created=await api('/admin/products',{name:'隔离测试商品',category:'cleaning',pricePerShare:1,totalShares:10,freeQuota:3},adminCookie);assert.equal(created.data.ok,true);product=created.data.id;
  const body={productId:product,shares:2,useFree:true,requestKey:'test-purchase-request-001'};
  const [a,b]=await Promise.all([api('/wallet/buy',body,userCookie),api('/wallet/buy',body,userCookie)]);
  assert.equal(a.data.ok,true,JSON.stringify(a.data));assert.equal(b.data.orderId,a.data.orderId);assert.equal(Number((await pool.query('SELECT COUNT(*) AS n FROM orders')).rows[0].n),1);
  const balance=(await pool.query("SELECT paid_balance,free_balance FROM users WHERE id='u_test'")).rows[0];assert.equal(Number(balance.paid_balance),19);assert.equal(Number(balance.free_balance),9);
  assert.equal((await api('/wallet/buy',{...body,shares:3},userCookie)).status,409);
 });
 await t.test('reset refunds with ledger and preserves permanent receipt',async()=>{
  assert.equal((await api('/admin/reset-product/'+product,{confirmation:'RESET',reason:'隔离退款测试'},adminCookie)).data.ok,true);
  assert.equal(Number((await pool.query("SELECT paid_balance FROM users WHERE id='u_test'")).rows[0].paid_balance),20);
  const replay=await api('/wallet/buy',{productId:product,shares:2,useFree:true,requestKey:'test-purchase-request-001'},userCookie);assert.equal(replay.status,409);
  assert.equal(Number((await pool.query('SELECT COUNT(*) AS n FROM orders')).rows[0].n),0);
  assert(Number((await pool.query('SELECT COUNT(*) AS n FROM admin_audit')).rows[0].n)>0);
 });
 await t.test('balance changes validate and create ledger',async()=>{
  assert.equal((await api('/admin/fix-balance',{userId:'u_test',paidBalance:-1,reason:'测试原因'},adminCookie)).status,400);
  assert.equal((await api('/admin/fix-balance',{userId:'u_test',paidBalance:30,reason:'测试补偿'},adminCookie)).data.ok,true);
  assert.equal(Number((await pool.query("SELECT paid_balance FROM users WHERE id='u_test'")).rows[0].paid_balance),30);
 });
 await t.test('showcase reward remains claimed after delete and resubmit',async()=>{
  await pool.query("INSERT INTO draws(product_id,round,total_shares,locked_at,drawn_at,winner_user_id) VALUES ($1,42,10,1,2,'u_test')",[product]);
  async function submit(){const r=await api('/showcase/submit',{productId:product,mediaType:'image',mediaUrl:'https://example.com/photo.jpg',caption:'测试晒单'},userCookie);assert.equal(r.data.ok,true,JSON.stringify(r));return r.data.id;}
  const first=await submit();assert.equal((await api('/showcase/review/'+first,{action:'approve'},adminCookie)).data.ok,true);
  const before=Number((await pool.query("SELECT free_balance FROM users WHERE id='u_test'")).rows[0].free_balance);
  assert.equal((await api('/showcase/'+first,null,userCookie,'DELETE')).data.ok,true);
  const second=await submit();assert.equal((await api('/showcase/review/'+second,{action:'approve'},adminCookie)).data.ok,true);
  assert.equal(Number((await pool.query("SELECT free_balance FROM users WHERE id='u_test'")).rows[0].free_balance),before);
 });
 await t.test('shipping notes survive state change; shipped address is immutable',async()=>{
  assert.equal((await api('/wallet/address',{productId:product,name:'收件人',address:'测试地址'},userCookie)).data.ok,true);
  assert.equal((await api('/admin/wins/'+product+'/ship',{status:'shipped',note:'tracking-test'},adminCookie)).data.ok,true);
  assert.equal((await api('/admin/wins/'+product+'/ship',{status:'done'},adminCookie)).data.ok,true);
  assert.equal((await pool.query('SELECT ship_note FROM draws WHERE product_id=$1',[product])).rows[0].ship_note,'tracking-test');
  assert.equal((await api('/wallet/address',{productId:product,name:'收件人',address:'新地址'},userCookie)).status,400);
  assert.equal((await api('/admin/reset-product/'+product,{confirmation:'RESET',reason:'测试拒绝'},adminCookie)).status,400);
 });
 await t.test('unconfigured payment does not create a recharge',async()=>{
  assert.equal((await api('/wallet/recharge',{amount:10,method:'stripe'},userCookie)).status,503);
  assert.equal(Number((await pool.query('SELECT COUNT(*) AS n FROM recharges')).rows[0].n),0);
 });
 await t.test('invalid settings roll back as a unit',async()=>{
  const before=(await pool.query("SELECT v FROM config WHERE k='grantRegister'")).rows[0].v;
  assert.equal((await api('/admin/config',{grantRegister:123,recharge_packages:[{amount:1,bonus:-1}]},adminCookie)).status,400);
  assert.equal((await pool.query("SELECT v FROM config WHERE k='grantRegister'")).rows[0].v,before);
 });
 await t.test('full product settles once using a verified beacon',async()=>{
  const created=await api('/admin/products',{name:'开奖测试',category:'cleaning',pricePerShare:1,totalShares:3,freeQuota:0},adminCookie);
  const pid=created.data.id;
  const buy=await api('/wallet/buy',{productId:pid,shares:3,useFree:false,requestKey:'draw-test-purchase-001'},userCookie);assert.equal(buy.data.ok,true);
  await pool.query('UPDATE draws SET round=42 WHERE product_id=$1',[pid]);
  const realFetch=globalThis.fetch;
  const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/drand-quicknet-42.json',import.meta.url)));
  globalThis.fetch=async(url,...args)=>String(url).includes('/public/42')?Response.json(fixture):realFetch(url,...args);
  try{
    const {resolveDraw}=await import('../server/lib/resolveDraw.js');
    const [first,second]=await Promise.all([resolveDraw(pid),resolveDraw(pid)]);
    assert.equal(first.winner_user_id,'u_test');assert.equal(first.drawn_at,second.drawn_at);assert.equal(first.signature,fixture.signature);
    assert.equal((await pool.query('SELECT status FROM products WHERE id=$1',[pid])).rows[0].status,'done');
  }finally{globalThis.fetch=realFetch}
 });
 await t.test('reset password revokes sessions; disable preserves orders and can be reversed',async()=>{
  assert.equal((await api('/admin/users/u_test/reset-pwd',{password:'new-test-password'},adminCookie)).data.ok,true);
  assert.equal((await api('/wallet',null,userCookie)).status,401);
  userCookie=(await api('/auth/login',{account:'user@test.invalid',password:'new-test-password'})).cookie;
  assert.equal((await api('/admin/users/u_test',null,adminCookie,'DELETE')).data.ok,true);
  assert.equal((await api('/wallet',null,userCookie)).status,401);
  assert.equal((await pool.query("SELECT disabled FROM users WHERE id='u_test'")).rows[0].disabled,true);
  assert.equal((await api('/admin/users/u_test/enable',{},adminCookie)).data.ok,true);
  assert.equal((await api('/auth/login',{account:'user@test.invalid',password:'new-test-password'})).data.ok,true);
 });
 await t.test('search finds an old user beyond first page',async()=>{
  for(let i=0;i<105;i++)await pool.query("INSERT INTO users(id,account,account_type,name,pass_hash,role,invite_code,paid_balance,created_at) VALUES ($1,$2,'email','分页测试',$3,'user',$4,0,$5)",['page'+i,'page'+i+'@test.invalid',hash,'PAGE'+String(i).padStart(2,'0'),100+i]);
  const result=await api('/admin/users?q=user%40test.invalid&page=1',null,adminCookie);assert.equal(result.data.total,1);assert.equal(result.data.users[0].id,'u_test');
 });
});
test('drand verifies real signed fixture and rejects tampering',async()=>{
 const {verifyBeaconData}=await import('../server/lib/drand.js');const data=JSON.parse(fs.readFileSync(new URL('./fixtures/drand-quicknet-42.json',import.meta.url)));
 assert.equal((await verifyBeaconData(data,42)).round,42);
 await assert.rejects(verifyBeaconData({...data,randomness:'00'.repeat(32)},42));
 await assert.rejects(verifyBeaconData(data,43));
});
test('product import rejects disguised domains and unsafe redirects',async()=>{
 const {productUrl}=await import('../server/lib/productUrl.js');
 for(const value of ['https://evil.invalid/?doba.com/product/a/b','https://doba.com.evil.invalid/product/a/b','http://doba.com/product/a/b','https://user:password@doba.com/product/a/b','https://doba.com:444/product/a/b'])assert.throws(()=>productUrl(value));
 assert.equal(productUrl('https://www.doba.com/product/a/b').provider,'doba');
});
