import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../deploy/pages-worker.mjs';

test('Pages proxy preserves POST payload and session cookie without caching user data', async t => {
  t.mock.method(globalThis, 'fetch', async request => {
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
  t.mock.method(globalThis, 'fetch', async () => Response.redirect('https://luckybuy.onrender.com/recharge.html?result=success', 302));
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
