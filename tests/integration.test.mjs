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
 await t.test('reference price controls shares and five percent quota; missing import price is rejected',async()=>{
  const data={name:'价格联动测试',category:'cleaning',sourceUrl:'https://www.amazon.com/dp/B08KT2Z93D',pricePerShare:1,totalShares:1,freeQuota:0,pricing:{referencePrice:100,multiplier:1,freeRatio:100}};
  const created=await api('/admin/products',data,adminCookie);assert.equal(created.data.ok,true);
  let p=(await api('/shop/products/'+created.data.id)).data.product;
  assert.equal(p.totalShares,150);assert.equal(p.freeQuota,8);assert.deepEqual(p.pricing,{referencePrice:100,multiplier:1.5,freeRatio:5});
  assert.equal((await api('/admin/products',{...data,id:created.data.id,pricing:{referencePrice:66}},adminCookie)).data.ok,true);
  p=(await api('/shop/products/'+created.data.id)).data.product;assert.equal(p.totalShares,99);assert.equal(p.freeQuota,5);
  assert.equal((await api('/admin/products',{...data,pricing:{referencePrice:null}},adminCookie)).status,400);
  await api('/admin/products/'+created.data.id,null,adminCookie,'DELETE');
 });
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
  const enabledLogin=await api('/auth/login',{account:'user@test.invalid',password:'new-test-password'});
  assert.equal(enabledLogin.data.ok,true);userCookie=enabledLogin.cookie;
 });
 await t.test('search finds an old user beyond first page',async()=>{
  for(let i=0;i<105;i++)await pool.query("INSERT INTO users(id,account,account_type,name,pass_hash,role,invite_code,paid_balance,created_at) VALUES ($1,$2,'email','分页测试',$3,'user',$4,0,$5)",['page'+i,'page'+i+'@test.invalid',hash,'PAGE'+String(i).padStart(2,'0'),100+i]);
  const result=await api('/admin/users?q=user%40test.invalid&page=1',null,adminCookie);assert.equal(result.data.total,1);assert.equal(result.data.users[0].id,'u_test');
 });
 await t.test('legacy category creation rename order and deletion remain available',async()=>{
  const c=await api('/admin/categories',{name:'Recovery test',prefix:'RC',icon:'📦'},adminCookie);assert.equal(c.data.ok,true);
  assert.equal((await api('/admin/categories/'+c.data.key,{name:'Renamed',icon:'🎁'},adminCookie,'PUT')).data.ok,true);
  const cats=(await api('/shop/categories')).data.categories;
  const keys=[c.data.key,...cats.filter(x=>x.key!==c.data.key).map(x=>x.key)];
  assert.equal((await api('/admin/categories/reorder',{keys},adminCookie)).data.ok,true);
  assert.equal((await api('/shop/categories')).data.categories[0].name,'Renamed');
  assert.equal((await api('/admin/categories/'+c.data.key,null,adminCookie,'DELETE')).data.ok,true);
 });
 await t.test('restored free coin audit supports account and does not alter balance',async()=>{
  const before=(await api('/wallet',null,userCookie)).data.freeBalance;
  const detail=await api('/admin/free-coin-detail?account=user%40test.invalid',null,adminCookie);assert.equal(detail.data.ok,true);assert.equal(detail.data.user.id,'u_test');
  assert.equal(Number(detail.data.user.free_balance),Number(before));assert.ok(Array.isArray(detail.data.checkins));
  assert.equal((await api('/admin/free-coin-detail?userId=u_test',null,userCookie)).status,403);
 });
 await t.test('five free coins cover five distinct products, never twice per product; paid entries remain available',async()=>{
  await pool.query("INSERT INTO users(id,account,account_type,name,pass_hash,role,invite_code,paid_balance,free_balance,created_at) VALUES ('u_free','free@test.invalid','email','Free test',$1,'user','FREE01',20,5,1)",[hash]);
  const cookie=(await api('/auth/login',{account:'free@test.invalid',password:'test-admin-password'})).cookie;
  const ids=[];
  for(let i=0;i<5;i++){
   const pid=(await api('/admin/products',{name:'Free rule '+i,category:'cleaning',pricePerShare:1,totalShares:20,freeQuota:5},adminCookie)).data.id;ids.push(pid);
   const first=await api('/wallet/buy',{productId:pid,shares:1},cookie);assert.equal(first.data.usedFree,1);
   const again=await api('/wallet/buy',{productId:pid,shares:1},cookie);assert.equal(again.data.usedFree,0);assert.equal(again.data.usedPaid,1);
  }
  assert.equal((await api('/wallet',null,cookie)).data.freeBalance,0);
  const paid=await api('/wallet/buy',{productId:ids[0],shares:3,useFree:false},cookie);assert.equal(paid.data.usedPaid,3);assert.equal(paid.data.ok,true);
 });
 await t.test('invitation grants both sides once and reports actual invitation totals',async()=>{
  const cfg=(await api('/shop/config')).data.config;
  const before=(await api('/wallet',null,userCookie)).data.freeBalance;
  await pool.query('INSERT INTO email_codes(account,code,expires_at,sent_at) VALUES ($1,$2,$3,$4)',['invite@test.invalid','123456',Date.now()+60000,Date.now()]);
  const body={account:'invite@test.invalid',password:'test-password-123',code:'123456',invite:'TEST01'};
  const registered=await api('/auth/register',body);assert.equal(registered.data.ok,true,JSON.stringify(registered.data));
  assert.equal(Number(registered.data.user.free_balance),Number(cfg.grantInvitee));
  assert.equal((await api('/wallet',null,userCookie)).data.freeBalance,Number(before)+Number(cfg.grantInviter));
  assert.equal((await api('/auth/register',body)).data.ok,false);
  const me=(await api('/auth/me',null,userCookie)).data.user;assert.equal(Number(me.invites),1);assert.equal(Number(me.invite_earned),Number(cfg.grantInviter));
 });
 await t.test('user notifications include own off-page wins and disappear after address submission',async()=>{
  const p=(await api('/admin/products',{name:'Notification test',category:'cleaning',pricePerShare:1,totalShares:1},adminCookie)).data.id;
  await pool.query("UPDATE products SET status='done' WHERE id=$1",[p]);
  await pool.query("INSERT INTO draws(product_id,round,total_shares,locked_at,drawn_at,winner_user_id,win_number) VALUES ($1,42,1,1,2,'u_test',1)",[p]);
  assert.ok((await api('/shop/notifications',null,userCookie)).data.products.some(x=>x.id===p));
  assert.ok(!(await api('/shop/notifications',null,adminCookie)).data.products.some(x=>x.id===p));
  assert.equal((await api('/shop/notifications')).status,401);
  assert.equal((await api('/wallet/address',{productId:p,name:'测试',address:'测试地址'},userCookie)).data.ok,true);
  assert.ok(!(await api('/shop/notifications',null,userCookie)).data.products.some(x=>x.id===p));
  const fd=new FormData();fd.set('productId',p);fd.set('mediaType','video');fd.set('caption','超过旧5MB限额的恢复测试');fd.set('media',new Blob([new Uint8Array(6*1024*1024)],{type:'video/mp4'}),'test.mp4');
  const uploaded=await fetch(origin+'/api/showcase/submit',{method:'POST',headers:{Cookie:userCookie},body:fd});assert.equal((await uploaded.json()).ok,true);
 });
});
test('drand verifies real signed fixture and rejects tampering',async()=>{
 const {verifyBeaconData}=await import('../server/lib/drand.js');const data=JSON.parse(fs.readFileSync(new URL('./fixtures/drand-quicknet-42.json',import.meta.url)));
 assert.equal((await verifyBeaconData(data,42)).round,42);
 await assert.rejects(verifyBeaconData({...data,randomness:'00'.repeat(32)},42));
 await assert.rejects(verifyBeaconData(data,43));
});
test('product import rejects disguised domains and unsafe redirects',async()=>{
 const {fetchAmazon}=await import('../server/lib/amazon.js');
 await assert.rejects(fetchAmazon('https://www.amazon.com/s?i=specialty-aps'),e=>e.status===400&&e.message.includes('详情'));
 const {productUrl}=await import('../server/lib/productUrl.js');
 for(const value of ['https://evil.invalid/?doba.com/product/a/b','https://doba.com.evil.invalid/product/a/b','http://doba.com/product/a/b','https://user:password@doba.com/product/a/b','https://doba.com:444/product/a/b'])assert.throws(()=>productUrl(value));
 assert.equal(productUrl('https://www.doba.com/product/a/b').provider,'doba');
 assert.equal(productUrl('amazon.com/eos-Cashmere/dp/B08KT2Z93D?ref=test').url,'https://amazon.com/eos-Cashmere/dp/B08KT2Z93D?ref=test');
 assert.throws(()=>productUrl('amazon.com.evil.invalid/dp/B08KT2Z93D'));
});

test('Amazon USD price supports primary offer markup and structured offers, rejects unrelated prices',async()=>{
 const {extractUsdPrice}=await import('../server/lib/amazon.js');const url='https://www.amazon.com/dp/B08KT2Z93D';
 assert.equal(extractUsdPrice('<div id="corePriceDisplay_desktop_feature_div"><span class="a-price priceToPay"><span aria-hidden="true" class="a-offscreen">$1,200.50</span></span></div>',url),1200.5);
 assert.equal(extractUsdPrice('<div id="corePrice_feature_div"><span class="a-price"><span class="a-price-whole">200<span>.</span></span><span class="a-price-fraction">99</span></span></div>',url),200.99);
 assert.equal(extractUsdPrice('<script type="application/ld+json">{"@type":"Product","offers":{"price":"200","priceCurrency":"USD"}}</script>',url),200);
 assert.equal(extractUsdPrice('<span class="a-offscreen">$3.99</span><script>{"price":4.99}</script>',url),0);
 assert.equal(extractUsdPrice('<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">$200</span></span></div>',url.replace('.com','.ca')),0);
});

test('authentication failures count toward brute-force limit', async () => {
 const invalid = await api('/auth/register', {account:'rate@test.invalid',password:'test-password',code:'000000'});
 assert.equal(invalid.status,400);
 let blocked = false;
 for (let i=0;i<31;i++) {
  const result=await api('/auth/login',{account:'missing@test.invalid',password:'incorrect'});
  if(result.status===429){blocked=true;break;}
  assert.equal(result.status,401);
 }
 assert.equal(blocked,true,'Repeated failures must trigger the authentication limiter');
});

test('admin test credits self and others once, rejects ordinary users and invalid amounts',async()=>{
 const body={amount:100,account:'user@test.invalid',requestKey:'11111111-1111-4111-8111-111111111111'};
 assert.equal((await api('/admin/test-recharge',body,userCookie)).status,403);
 assert.equal((await api('/admin/test-recharge',body)).status,401);
 assert.equal((await api('/admin/test-recharge',{...body,amount:-1},adminCookie)).status,400);
 const before=Number((await pool.query("SELECT paid_balance FROM users WHERE id='u_test'")).rows[0].paid_balance);
 const results=await Promise.all([api('/admin/test-recharge',body,adminCookie),api('/admin/test-recharge',body,adminCookie)]);
 assert(results.every(r=>r.data.ok));
 assert.equal(Number((await pool.query("SELECT paid_balance FROM users WHERE id='u_test'")).rows[0].paid_balance),before+100);
 assert.equal((await api('/admin/test-recharge',{...body,amount:101},adminCookie)).status,409);
 assert.equal((await api('/admin/test-recharge',{amount:10,requestKey:'22222222-2222-4222-8222-222222222222'},adminCookie)).data.ok,true);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM admin_audit WHERE action='test-recharge'")).rows[0].n,2);
});


test('150 shares permit only eight free coins total and one per person, then sell out and draw',async()=>{
 const created=await api('/admin/products',{name:'150份额度测试',category:'cleaning',pricing:{referencePrice:100}},adminCookie);
 assert.equal(created.data.ok,true);const id=created.data.id;
 const {createSession}=await import('../server/lib/helpers.js');const cookies=[];
 for(let i=0;i<9;i++){
  await pool.query("INSERT INTO users(id,account,account_type,name,pass_hash,role,invite_code,paid_balance,free_balance,created_at) VALUES($1,$2,'email','quota','unused','user',$3,500,10,1)",['quota'+i,'quota'+i+'@test.invalid','QUOTA'+i]);
  cookies.push('lb_token='+await createSession('quota'+i));
 }
 const results=await Promise.all(cookies.map(cookie=>api('/wallet/buy',{productId:id,shares:1},cookie)));
 assert.equal(results.filter(r=>r.data.usedFree===1).length,8);assert.equal(results.filter(r=>r.data.usedPaid===1).length,1);
 const repeat=await api('/wallet/buy',{productId:id,shares:1},cookies[0]);assert.equal(repeat.data.usedFree,0);assert.equal(repeat.data.usedPaid,1);
 const finish=await api('/wallet/buy',{productId:id,shares:140,useFree:false},cookies[0]);assert.equal(finish.data.ok,true);
 const p=(await api('/shop/products/'+id)).data.product;assert.equal(p.status,'drawing');assert.equal(p.sold,150);assert.equal(p.freeUsed,8);
 assert.equal((await api('/wallet/buy',{productId:id,shares:1},cookies[1])).status,400);
});


test('Amazon current main offer excludes per-ounce and per-piece unit prices',async()=>{
 const {extractUsdPrice}=await import('../server/lib/amazon.js');const url='https://www.amazon.com/dp/B08KT2Z93D';
 const html='<span class="aok-offscreen apex-pricetopay-accessibility-label">$8.47 with 23 percent savings</span><span class="apex-priceperunit-accessibility-label">$0.53 per fluid ounce</span>';
 assert.equal(extractUsdPrice(html,url),8.47);
 assert.equal(extractUsdPrice('<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen"></span><span class="a-price-whole">8<span>.</span></span><span class="a-price-fraction">47</span></span><span class="a-price a-text-price"><span class="a-offscreen">$0.53</span></span></div>',url),8.47);
});

test('Amazon import falls back to rendered HTML when static page omits the price',async t=>{
 const {fetchAmazon}=await import('../server/lib/amazon.js');
 const basic='<span id="productTitle">Test B08SY7TLT9</span><meta property="og:image" content="https://example.com/product.jpg">'+' '.repeat(6000);
 let fallback=0;
 t.mock.method(globalThis,'fetch',async url=>{
  if(String(url).startsWith('https://r.jina.ai/')){fallback++;return new Response(basic+'<span class="apex-pricetopay-accessibility-label">$399.99</span>');}
  return new Response(basic);
 });
 const d=await fetchAmazon('https://www.amazon.com/dp/B08SY7TLT9');assert.equal(d.refPrice,399.99);assert.equal(fallback,1);
});

test('delete user hides account, revokes sessions, preserves history and cannot be re-enabled',async()=>{
 const id='u_test',body={confirmation:'DELETE'};
 assert.equal((await api('/admin/users/'+id+'/delete',body,userCookie)).status,403);
 assert.equal((await api('/admin/users/'+id+'/delete',{},adminCookie)).status,400);
 assert.equal((await api('/admin/users/u_admin/delete',body,adminCookie)).status,400);
 const before=Number((await pool.query('SELECT count(*) AS n FROM orders WHERE user_id=$1',[id])).rows[0].n);
 assert.equal((await api('/admin/users/'+id+'/delete',body,adminCookie)).data.ok,true);
 assert.equal((await api('/wallet',null,userCookie)).status,401);
 assert.equal((await api('/admin/users?q=user%40test.invalid',null,adminCookie)).data.total,0);
 assert.equal((await api('/admin/users/'+id+'/enable',{},adminCookie)).status,404);
 assert.equal(Number((await pool.query('SELECT count(*) AS n FROM orders WHERE user_id=$1',[id])).rows[0].n),before);
 assert.equal((await api('/admin/users/'+id+'/delete',body,adminCookie)).data.ok,true);
 assert.equal(Number((await pool.query("SELECT count(*) AS n FROM admin_audit WHERE action='delete-user' AND target_id=$1",[id])).rows[0].n),1);
});
