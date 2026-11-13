const ORIGINS = ['https://luckybuy.onrender.com', 'https://api.luckybuy.vip'];
let healthy = { origin: '', until: 0 };
function transient(response) {
  return response.headers.get('cf-mitigated') === 'challenge' ||
    [502, 503, 504].includes(response.status) ||
    (response.status === 429 && !response.headers.get('content-type')?.includes('application/json'));
}
async function chooseWriteOrigin(origins) {
  if (healthy.until > Date.now() && origins.includes(healthy.origin)) return healthy.origin;
  for (const origin of origins) {
    try {
      const r = await fetch(new Request(origin + '/api/health', { signal: AbortSignal.timeout(8000) }));
      const data = r.ok && r.headers.get('content-type')?.includes('application/json') ? await r.json() : null;
      if (!data) await r.body?.cancel();
      if (data?.ok) { healthy = {origin, until: Date.now() + 15000}; return origin; }
    } catch {}
  }
  return null;
}
async function imageResponse(request, ctx) {
  if (request.method !== 'GET') return new Response('Method not allowed', {status:405});
  const input = new URL(request.url).searchParams.get('url');
  let target;
  try { target = new URL(input); } catch { return new Response('Invalid image', {status:400}); }
  if (target.protocol !== 'https:' || target.hostname !== 'm.media-amazon.com' || target.port || target.username || target.password || target.search || target.hash || !/^\/images\/I\/[^/]+\.(?:jpg|jpeg|png|webp)$/i.test(target.pathname)) return new Response('Invalid image', {status:400});
  const key = new Request(request.url);
  const cache = globalThis.caches?.default;
  const cached = await cache?.match(key);
  if (cached) return cached;
  try {
    const upstream = await fetch(new Request(target.href, { redirect:'manual', signal:AbortSignal.timeout(12000) }));
    const type = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !/^image\/(jpeg|png|webp)/.test(type) || Number(upstream.headers.get('content-length')) > 8 * 1024 * 1024) {
      await upstream.body?.cancel(); return new Response('Image unavailable', {status:502});
    }
    const response = new Response(upstream.body, {headers:{'Content-Type':type,'Cache-Control':'public, max-age=86400','X-Content-Type-Options':'nosniff'}});
    if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(key,response.clone()));
    return response;
  } catch { return new Response('Image unavailable', {status:502}); }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/media/amazon') return imageResponse(request, ctx);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
      const configured = new URL(env.API_ORIGIN || ORIGINS[0]).origin;
      let origins = ORIGINS.includes(configured) ? [...ORIGINS] : [configured];
      if (healthy.until > Date.now() && origins.includes(healthy.origin)) origins = [healthy.origin, ...origins.filter(o=>o!==healthy.origin)];
      const read = ['GET','HEAD'].includes(request.method);
      const replaySafe = read && !/^\/api\/wallet\/paypal-(?:return|cancel)/.test(url.pathname);
      const trace = crypto.randomUUID();
      const started = Date.now();
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.set('X-Forwarded-Host', url.host);
      headers.set('X-Forwarded-Proto', url.protocol.slice(0,-1));
      // Choose a healthy route before a write. The write itself is never replayed.
      if (!replaySafe && origins.length > 1) {
        const origin = await chooseWriteOrigin(origins);
        if (!origin) return Response.json({ok:false,code:'UPSTREAM_UNAVAILABLE',msg:'服务暂时无法连接，请稍后重试',requestId:trace},{status:503,headers:{'Cache-Control':'no-store'}});
        origins = [origin];
      }
      for (let i=0; i<origins.length; i++) {
        const origin = origins[i];
        const target = new URL(url.pathname+url.search,origin);
        try {
          const upstream = await fetch(new Request(target,{method:request.method,headers,body:read?undefined:request.body,redirect:'manual',duplex:'half',signal:AbortSignal.timeout(read?12000:60000)}));
          if (transient(upstream)) {
            healthy.until = 0;
            console.warn(JSON.stringify({event:'upstream_failure',requestId:trace,path:url.pathname,method:request.method,origin,status:upstream.status,ms:Date.now()-started}));
            await upstream.body?.cancel();
            if (replaySafe && i+1<origins.length) continue;
            return Response.json({ok:false,code:'UPSTREAM_UNAVAILABLE',msg:'服务连接暂时受阻，请稍后重试',requestId:trace},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'15'}});
          }
          if (upstream.ok && upstream.headers.get('content-type')?.includes('application/json')) healthy={origin,until:Date.now()+15000};
          const response = new Response(upstream.body,upstream);
          response.headers.set('X-Request-ID',trace);
          if (url.pathname.startsWith('/api/')) response.headers.set('Cache-Control','no-store');
          const location = response.headers.get('Location');
          if (location) {
            const destination = new URL(location,target);
            if (destination.origin===origin) response.headers.set('Location',url.origin+destination.pathname+destination.search+destination.hash);
          }
          if (Date.now()-started>3000) console.log(JSON.stringify({event:'upstream_slow',requestId:trace,path:url.pathname,method:request.method,ms:Date.now()-started}));
          return response;
        } catch {
          healthy.until=0;
          console.warn(JSON.stringify({event:'upstream_connection_failure',requestId:trace,path:url.pathname,method:request.method,origin,ms:Date.now()-started}));
          if (replaySafe && i+1<origins.length) continue;
          return Response.json({ok:false,code:'UPSTREAM_UNAVAILABLE',msg:'服务暂时无法连接，请稍后重试',requestId:trace},{status:502,headers:{'Cache-Control':'no-store'}});
        }
      }
    }
    return env.ASSETS.fetch(request);
  },
};
