// Anonymous, read-only checks for Lucky Buy only. Never replay transactions.
const ORIGINS = ['https://luckybuy.onrender.com', 'https://api.luckybuy.vip'];
async function check(url, timeout) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeout),
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    });
    const challenge = response.headers.get('cf-mitigated') === 'challenge';
    let data;
    if (response.headers.get('content-type')?.includes('application/json')) {
      data = await response.json();
    } else {
      await response.body?.cancel();
    }
    return { url, ok: response.ok && data?.ok === true && !challenge,
      status: response.status, challenge, ms: Date.now() - started,
      requestId: response.headers.get('x-request-id') || data?.requestId || null,
      ray: response.headers.get('cf-ray'), commit: data?.commit || null };
  } catch (error) {
    return { url, ok: false, status: 0, ms: Date.now() - started,
      error: error.name === 'TimeoutError' ? 'timeout' : 'connection_failed' };
  }
}

export async function runHealthCheck() {
  const results = [];
  // A cold start can exceed 50 seconds. Allow it to finish outside a customer's
  // page request. A successful check every five minutes also prevents idle sleep.
  for (const origin of ORIGINS) {
    const result = await check(origin + '/api/health', 90000);
    results.push(result);
    if (result.ok) break;
  }
  // Verify the actual customer-facing proxy and database-backed catalog as well.
  const catalog = await check('https://luckybuy.vip/api/shop/catalog?page=1&limit=1', 60000);
  results.push(catalog);
  const ok = results.some(r => r.url.endsWith('/api/health') && r.ok) && catalog.ok;
  const report = { event: 'luckybuy_health_check', time: new Date().toISOString(), ok, results };
  (ok ? console.log : console.error)(JSON.stringify(report));
  return report;
}

export default {
  async scheduled() {
    const report = await runHealthCheck();
    if (!report.ok) throw new Error('Lucky Buy health check failed; see structured results');
  },
  // No public endpoint that can be used to trigger extra origin traffic.
  fetch() { return new Response('Not found', { status: 404 }); },
};
