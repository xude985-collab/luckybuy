import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
// 本套测试只使用替身数据库；禁止加载部署配置。
process.env.DOTENV_CONFIG_PATH = '__test_no_env__';
process.env.DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:1/unused';
const { default: pool } = await import('../server/db.js');
const { walletTx, attachUser } = await import('../server/lib/helpers.js');
const { settleRecharge } = await import('../server/lib/recharges.js');
const { default: webhook, verifySig } = await import('../server/routes/stripe-webhook.js');
const { default: wallet } = await import('../server/routes/wallet.js');
const { default: shop } = await import('../server/routes/shop.js');
const { default: admin } = await import('../server/routes/admin.js');
const { default: showcase } = await import('../server/routes/showcase.js');

const response = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; },
  json(value) { this.body = value; return this; }, send(value) { this.body = value; return this; } });
const handler = (router, path, method = 'post') => router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
const next = error => { if (error) throw error; };

test('Stripe 验签接受轮换签名，拒绝过期、伪造和缺失签名', () => {
  const body = '{"test":true}', secret = 'test-secret', time = 1000;
  const signature = crypto.createHmac('sha256', secret).update(`${time}.${body}`).digest('hex');
  const header = `t=${time},v1=${'0'.repeat(64)},v1=${signature}`;
  assert.equal(verifySig(body, header, secret, time), true);
  assert.equal(verifySig(body, header, secret, time + 301), false);
  assert.equal(verifySig(body + ' ', header, secret, time), false);
  assert.equal(verifySig(body, undefined, secret, time), false);
  assert.equal(verifySig(body, header, '', time), false);
});

test('未配置 Stripe 签名密钥时拒绝回调', async t => {
  t.mock.method(pool, 'query', () => { throw new Error('不应查询数据库'); });
  const previous = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  t.after(() => { if (previous !== undefined) process.env.STRIPE_WEBHOOK_SECRET = previous; });
  const res = response(); await webhook({ body: Buffer.from('{}'), headers: {} }, res, next);
  assert.equal(res.statusCode, 503);
});

test('钱包使用原子加减，流水写入失败会回滚并释放连接', async t => {
  const statements = [];
  const client = { release: t.mock.fn(), async query(sql) {
    statements.push(sql);
    if (sql.startsWith('UPDATE users')) return { rows: [{ balance: '12' }] };
    if (sql.startsWith('INSERT INTO wallet_tx')) throw new Error('模拟流水失败');
    return { rows: [] };
  } };
  t.mock.method(pool, 'connect', async () => client);
  await assert.rejects(walletTx('u', 'recharge', 2, 'test'), /模拟流水失败/);
  assert.match(statements[1], /paid_balance=paid_balance\+\$1/);
  assert.match(statements[1], /paid_balance\+\$1>=0/);
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(client.release.mock.callCount(), 1);
});

test('余额不足不写流水', async () => {
  let calls = 0;
  await assert.rejects(walletTx('u', 'spend', -100, '', { query: async () => { calls++; return { rows: [] }; } }), /余额不足/);
  assert.equal(calls, 1);
});

test('充值重复回调只入账一次，赠送余额与充值同事务', async t => {
  let claimed = false, entries = 0;
  const client = { release() {}, async query(sql) {
    if (sql.startsWith('UPDATE recharges')) {
      assert.match(sql, /status='pending'/);
      if (claimed) return { rows: [] };
      claimed = true; return { rows: [{ user_id: 'u', amount: 10, bonus: 1 }] };
    }
    if (sql.startsWith('UPDATE users')) return { rows: [{ balance: 10 }] };
    if (sql.startsWith('INSERT INTO wallet_tx')) entries++;
    return { rows: [] };
  } };
  t.mock.method(pool, 'connect', async () => client);
  assert.equal(await settleRecharge('rc', 'stripe', 'session'), true);
  assert.equal(await settleRecharge('rc', 'stripe', 'session'), false);
  assert.equal(entries, 2);
});

test('公开配置不泄露 Cookie 或未来新增私密字段', async t => {
  t.mock.method(pool, 'query', async () => ({ rows: [
    { k: 'doba_cookie', v: 'secret' }, { k: 'future_secret', v: 'secret' }, { k: 'grantRegister', v: '10' },
  ] }));
  const res = response(); await handler(shop, '/config', 'get')({}, res, next);
  assert.deepEqual(res.body.config, { grantRegister: 10 });
});

test('认证数据库失败传递给错误中间件', async t => {
  t.mock.method(pool, 'query', async () => { throw new Error('db unavailable'); });
  let caught;
  await attachUser({ cookies: { lb_token: 'test' } }, {}, error => { caught = error; });
  assert.equal(caught.message, 'db unavailable');
});

test('购买拒绝零、负数、小数和无效份数', async t => {
  t.mock.method(pool, 'connect', () => { throw new Error('不应连接数据库'); });
  for (const shares of [0, -1, 1.5, '2abc', null, undefined]) {
    const res = response(); await handler(wallet, '/buy')({ user: { id: 'u' }, body: { shares } }, res, next);
    assert.equal(res.statusCode, 400);
  }
});

test('购买在锁定商品和用户后才读取已售份数，并返回订单 ID', async t => {
  const sqls = [];
  const client = { release() {}, async query(sql) {
    sqls.push(sql);
    if (sql.includes('SELECT * FROM products')) return { rows: [{ id: 'p', name: 'test', status: 'active', total_shares: 10, price_per_share: 1 }] };
    if (sql.includes('SUM(shares)')) return { rows: [{ s: 0 }] };
    if (sql.includes('SELECT paid_balance')) return { rows: [{ paid_balance: 10 }] };
    if (sql.startsWith('UPDATE users')) return { rows: [{ balance: 9 }] };
    return { rows: [] };
  } };
  t.mock.method(pool, 'connect', async () => client);
  const res = response();
  await handler(wallet, '/buy')({ user: { id: 'u' }, body: { productId: 'p', shares: 1, useFree: false } }, res, next);
  assert.equal(res.body.ok, true);
  assert.match(res.body.orderId, /^o_/);
  assert.match(sqls[1], /products.*FOR UPDATE/);
  assert.match(sqls[2], /users.*FOR UPDATE/);
  assert.match(sqls[3], /SUM\(shares\)/);
  assert.equal(sqls.at(-1), 'COMMIT');
});

test('已经签到时不重复发放奖励', async t => {
  const sqls = [];
  t.mock.method(pool, 'connect', async () => ({ release() {}, async query(sql) {
    sqls.push(sql); return { rows: sql.includes('FROM checkins') ? [{ id: 'ck' }] : [] };
  } }));
  const res = response(); await handler(wallet, '/checkin')({ user: { id: 'u' } }, res, next);
  assert.equal(res.body.ok, false);
  assert.match(sqls[1], /FOR UPDATE/);
  assert.equal(sqls.some(sql => sql.startsWith('INSERT')), false);
});

test('Stripe 未支付会话和金额不匹配不能入账', async t => {
  const previous = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = 'test-signing-secret';
  t.after(() => { if (previous === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = previous; });
  t.mock.method(pool, 'connect', () => { throw new Error('不应入账'); });
  t.mock.method(pool, 'query', async () => ({ rows: [{ id: 'rc', method: 'stripe', stripe_session: 's', amount: 10 }] }));
  for (const [paymentStatus, expectedStatus] of [['unpaid', 200], ['paid', 400]]) {
    const raw = JSON.stringify({ type: 'checkout.session.completed', data: { object: {
      id: 's', payment_status: paymentStatus, currency: 'usd', amount_total: 1, client_reference_id: 'rc',
    } } });
    const time = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${time}.${raw}`).digest('hex');
    const res = response();
    await webhook({ body: Buffer.from(raw), headers: { 'stripe-signature': `t=${time},v1=${sig}` } }, res, next);
    assert.equal(res.statusCode, expectedStatus);
  }
});

test('已有参与订单的商品不能改价或改总份数', async t => {
  const sqls = [];
  t.mock.method(pool, 'connect', async () => ({ release() {}, async query(sql) {
    sqls.push(sql);
    if (sql.includes('FROM products')) return { rows: [{ status: 'active', total_shares: 10, price_per_share: 1 }] };
    if (sql.includes('FROM orders')) return { rows: [{ exists: 1 }] };
    return { rows: [] };
  } }));
  let error;
  await handler(admin, '/products')({ body: { id: 'p', name: 'test', category: 'cat', totalShares: 20, pricePerShare: 1 } }, response(), e => { error = e; });
  assert.equal(error.status, 400);
  assert.equal(sqls.at(-1), 'ROLLBACK');
  assert.equal(sqls.some(sql => sql.startsWith('UPDATE')), false);
});

test('晒单审核不能重复发奖励', async t => {
  let claimed = false, grants = 0;
  t.mock.method(pool, 'connect', async () => ({ release() {}, async query(sql) {
    if (sql.startsWith('UPDATE showcases')) {
      assert.match(sql, /status='pending'/);
      if (claimed) return { rows: [] };
      claimed = true; return { rows: [{ user_id: 'u' }] };
    }
    if (sql.includes('FROM config')) return { rows: [{ v: '20' }] };
    if (sql.startsWith('UPDATE users')) { grants++; return { rows: [{ balance: 20 }] }; }
    return { rows: [] };
  } }));
  const req = { params: { id: 'sc' }, body: { action: 'approve' } };
  const res = response(); await handler(showcase, '/review/:id')(req, res, next);
  assert.equal(res.body.ok, true);
  let error; await handler(showcase, '/review/:id')(req, response(), e => { error = e; });
  assert.equal(error.status, 400);
  assert.equal(grants, 1);
});
