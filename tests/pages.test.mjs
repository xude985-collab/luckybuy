import test from 'node:test';
import assert from 'node:assert/strict';
let worker;
test.beforeEach(async()=>{worker=(await import('../deploy/pages-worker.mjs?test='+crypto.randomUUID())).default;});

test('Pages proxy preserves POST payload and session cookie without caching user data', async t => {
  t.mock.method(globalThis, 'fetch', async request => {
    if(request.url.endsWith('/api/health')) return Response.json({ok:true});
    assert.equal(request.url, 'https://luckybuy.onrender.com/api/wallet/buy');
    assert.equal(request.headers.get('Cookie'), 'lb_token=test-session');
    assert.equal(request.headers.get('X-Forwarded-Host'), 'luckybuy.vip');
    assert.deepEqual(await request.json(), { shares: 1 });
    return Response.json({ ok: true });
  });
  const response = await worker.fetch(new Request('https://luckybuy.vip/api/wallet/buy', {
    method: 'POST', headers: { Cookie: 'lb_token=test-session' }, body: JSON.stringify({ shares: 1 }),
  }), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('Pages proxy keeps same-site redirects and delegates static assets', async t => {
  t.mock.method(globalThis, 'fetch', async request => request.url.endsWith('/api/health') ? Response.json({ok:true}) : Response.redirect('https://luckybuy.onrender.com/recharge.html?result=success', 302));
  const response = await worker.fetch(new Request('https://luckybuy.vip/api/wallet/paypal-return'), {});
  assert.equal(response.headers.get('Location'), 'https://luckybuy.vip/recharge.html?result=success');
  const asset = await worker.fetch(new Request('https://luckybuy.vip/index.html'), { ASSETS: { fetch: () => new Response('site') } });
  assert.equal(await asset.text(), 'site');
});

test('Pages proxy returns a controlled error when backend is unreachable', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const response = await worker.fetch(new Request('https://luckybuy.vip/api/health'), {});
  assert.equal(response.status, 502);
  assert.equal((await response.json()).ok, false);
});

test('Pages proxy reports upstream security challenge without replaying a write', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async request => {
    if(request.url.endsWith('/api/health')) return Response.json({ok:true});
    calls++;
    return new Response('<html>verification</html>', { status: 429,
      headers: { 'cf-mitigated': 'challenge', 'Content-Type': 'text/html' } });
  });
  const response = await worker.fetch(new Request('https://luckybuy.vip/api/auth/login', {
    method: 'POST', body: '{}',
  }), {});
  assert.equal(calls, 1);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).ok, false);
});

test('Pages replaces legacy API alias binding with direct same-service origin', async t => {
 t.mock.method(globalThis,'fetch',async request=>{assert.equal(request.url,'https://luckybuy.onrender.com/api/shop/catalog?page=1');return Response.json({ok:true,products:[]});});
 const response=await worker.fetch(new Request('https://luckybuy.vip/api/shop/catalog?page=1'),{API_ORIGIN:'https://api.luckybuy.vip'});
 assert.equal(response.status,200);
});

test('GET fails over on a challenge and remembers the working same-service origin',async t=>{
 const urls=[];
 t.mock.method(globalThis,'fetch',async request=>{urls.push(request.url);return request.url.startsWith('https://luckybuy.onrender.com')?new Response('challenge',{status:429,headers:{'cf-mitigated':'challenge'}}):Response.json({ok:true,products:[]});});
 for(let i=0;i<2;i++){const r=await worker.fetch(new Request('https://luckybuy.vip/api/shop/catalog'),{});assert.equal(r.status,200);assert.ok(r.headers.get('X-Request-ID'));}
 assert.equal(urls.length,3);assert.ok(urls[2].startsWith('https://api.luckybuy.vip'));
});

test('authorization errors and application rate limits never trigger failover',async t=>{
 let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({ok:false},{status:403});});
 assert.equal((await worker.fetch(new Request('https://luckybuy.vip/api/admin/users'),{})).status,403);
 assert.equal(calls,1);
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({ok:false},{status:429});});
 assert.equal((await worker.fetch(new Request('https://luckybuy.vip/api/shop/catalog'),{})).status,429);
 assert.equal(calls,2);
});

test('write preflight selects healthy origin and never replays an uncertain write',async t=>{
 const writes=[];
 t.mock.method(globalThis,'fetch',async request=>{
  if(request.url.endsWith('/api/health'))return request.url.startsWith('https://api.luckybuy.vip')?Response.json({ok:true}):new Response('challenge',{status:429,headers:{'cf-mitigated':'challenge'}});
  writes.push(request.url);assert.equal(await request.text(),'{"shares":1}');
  return new Response('unavailable',{status:502});
 });
 const r=await worker.fetch(new Request('https://luckybuy.vip/api/wallet/buy',{method:'POST',body:'{"shares":1}'}),{});
 assert.equal(r.status,503);assert.deepEqual(writes,['https://api.luckybuy.vip/api/wallet/buy']);
});

test('image cache accepts only fixed public image host and strips cookies',async t=>{
 const original=globalThis.caches;const entries=new Map();const pending=[];
 globalThis.caches={default:{match:async key=>entries.get(key.url)?.clone(),put:async(key,value)=>entries.set(key.url,value)}};
 t.after(()=>{if(original===undefined)delete globalThis.caches;else globalThis.caches=original});
 let calls=0;
 t.mock.method(globalThis,'fetch',async request=>{calls++;assert.equal(request.headers.get('cookie'),null);assert.equal(request.redirect,'manual');return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/jpeg','Set-Cookie':'private=x'}});});
 const ctx={waitUntil:p=>pending.push(p)};
 const path='https://luckybuy.vip/media/amazon?url='+encodeURIComponent('https://m.media-amazon.com/images/I/test._AC_SL600_.jpg');
 for(let i=0;i<2;i++){const r=await worker.fetch(new Request(path,{headers:{Cookie:'lb_token=private'}}),{},ctx);assert.equal(r.status,200);assert.equal(r.headers.get('set-cookie'),null);await r.arrayBuffer();await Promise.all(pending);}
 assert.equal(calls,1);
 const bad=await worker.fetch(new Request('https://luckybuy.vip/media/amazon?url='+encodeURIComponent('https://127.0.0.1/private.jpg')),{},ctx);
 assert.equal(bad.status,400);assert.equal(calls,1);
});
