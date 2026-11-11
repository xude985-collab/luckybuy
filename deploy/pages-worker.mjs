// Keep API and uploaded media on the existing Render origin; Pages serves only public assets.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
      const origin = new URL(env.API_ORIGIN || 'https://api.luckybuy.vip');
      const target = new URL(url.pathname + url.search, origin);
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.set('X-Forwarded-Host', url.host);
      headers.set('X-Forwarded-Proto', url.protocol.slice(0, -1));
      try {
        const upstream = await fetch(new Request(target, { method: request.method, headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
          redirect: 'manual', duplex: 'half', signal: AbortSignal.timeout(60000) }));
        if (url.pathname.startsWith('/api/') && upstream.headers.get('cf-mitigated') === 'challenge') {
          await upstream.body?.cancel();
          return Response.json({ ok: false, msg: '登录服务暂时被安全验证拦截，请稍后重试' },
            { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } });
        }
        const response = new Response(upstream.body, upstream);
        if (url.pathname.startsWith('/api/')) response.headers.set('Cache-Control', 'no-store');
        const location = response.headers.get('Location');
        if (location) {
          const destination = new URL(location, target);
          if (destination.origin === origin.origin)
            response.headers.set('Location', url.origin + destination.pathname + destination.search + destination.hash);
        }
        return response;
      } catch {
        return Response.json({ ok: false, msg: '服务暂时无法连接，请稍后重试' }, { status: 502 });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
