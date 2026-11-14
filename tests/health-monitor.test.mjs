import test from 'node:test';
import assert from 'node:assert/strict';
import monitor, { runHealthCheck } from '../deploy/health-monitor.mjs';

test('scheduled check uses only anonymous reads and verifies the public catalog', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    urls.push(url);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(new Headers(options.headers).get('cookie'), null);
    assert.equal(new Headers(options.headers).get('authorization'), null);
    return Response.json({ ok: true });
  });
  assert.equal((await runHealthCheck()).ok, true);
  assert.deepEqual(urls, ['https://luckybuy.onrender.com/api/health',
    'https://luckybuy.vip/api/shop/catalog?page=1&limit=1']);
});

test('challenge response is recorded and the alternate same-service origin is checked', async t => {
  t.mock.method(globalThis, 'fetch', async url => url.includes('onrender.com')
    ? new Response('verification', { status: 429, headers: { 'cf-mitigated': 'challenge' } })
    : Response.json({ ok: true }));
  const report = await runHealthCheck();
  assert.equal(report.ok, true);
  assert.equal(report.results.length, 3);
  assert.equal(report.results[0].challenge, true);
  assert.equal(report.results[0].ok, false);
});

test('healthy process with broken public catalog fails the scheduled check', async t => {
  t.mock.method(globalThis, 'fetch', async url => url.endsWith('/api/health')
    ? Response.json({ ok: true }) : Response.json({ ok: false, requestId: 'failure-id' }, { status: 503 }));
  const report = await runHealthCheck();
  assert.equal(report.ok, false);
  assert.equal(report.results.at(-1).requestId, 'failure-id');
  await assert.rejects(monitor.scheduled(), /health check failed/);
});

test('connection failure is recorded and public requests cannot trigger checks', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('offline'); });
  assert.equal(monitor.fetch().status, 404);
  assert.equal(calls, 0);
  const report = await runHealthCheck();
  assert.equal(report.ok, false);
  assert.equal(calls, 3);
  assert.ok(report.results.every(r => r.error === 'connection_failed'));
});
