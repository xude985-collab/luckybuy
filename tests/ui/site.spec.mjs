import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const user = { id: 'u_test', name: '测试用户', account: 'test@example.com', role: 'admin', paid_balance: '100', free_balance: '10', invite_code: 'ABC123' };
const product = { id: 'p_test', sku: 'CL0001', name: '多设备测试商品', category: 'cleaning', pricePerShare: 1, totalShares: 100, sold: 10, status: 'active', gallery: [], emoji: '🎁' };
const order = { id: 'o_test', product_id: product.id, name: product.name, sku: product.sku, shares: 1, numbers: '[1]', paid_coins: 1, free_coins: 0, created_at: Date.now() };

async function mockAPI(page, options = {}) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api', '');
    const data = {
      '/auth/me': { user: options.guest ? null : user },
      '/wallet': { paidBalance: 100, freeBalance: 10, tx: [] },
      '/wallet/orders': { orders: [order] },
      '/wallet/checkin-status': { checkedIn: false, streak: 0 },
      '/wallet/packages': { methods:{stripe:true,paypal:true}, packages: [{ amount: 10, bonus: 1 }, { amount: 50, bonus: 5 }] },
      '/shop/catalog':{products:[options.product||product],total:1,pages:1},
      '/shop/products/p_test': {product:options.product||product},
      '/wallet/recharges':{recharges:[]},
      '/admin/audit':{records:[]},
      '/admin/system-status':{database:true,payments:{stripe:false,paypal:false},mail:false},
      '/shop/products': { products: [options.product || product] },
      '/shop/categories': { categories: [{ key: 'cleaning', name: '清洁家电', icon: '🧹', prefix: 'CL' }] },
      '/shop/config': { config: {} }, '/shop/winners': { winners: [] }, '/shop/recent-buys': { buys: [] },
      '/shop/my-wins': { wins: [] }, '/showcase/approved': { showcases: [] },
      '/showcase/mine': { showcases: [] }, '/showcase/pending': { showcases: [] },
      '/admin/overview': { stats: { users: 1, products: 1, orders: 1, revenue: 1 } },
      '/admin/recent-orders': { orders: [{ ...order, account: user.account, product_name: product.name }] },
      '/admin/users': { users: [user] }, '/admin/wins': { wins: [] },
    }[path] || {};
    await route.fulfill({ json: { ok: true, ...data } });
  });
}

for (const width of [320, 390, 768, 1024, 1440]) {
  test(`主要页面在 ${width}px 宽度可用`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await mockAPI(page);
    for (const path of ['index.html', 'detail.html?id=p_test', 'recharge.html', 'orders.html', 'profile.html', 'admin.html']) {
      await page.goto('/' + path);
      await expect(page.locator('#mob-nav')).toBeAttached();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width <= 1100) await expect(page.locator('#mob-nav')).toBeVisible();
      else await expect(page.locator('#topbar nav')).toBeVisible();
      if (path === 'recharge.html') {
        const input = page.locator('#custom-amt');
        await input.pressSequentially('123');
        await expect(input).toHaveValue('123');
        await expect(input).toBeFocused();
        await expect(page.locator('.recharge-btn')).toContainText('$123');
      }
      if (path === 'index.html' && width <= 900)
        expect(await page.locator('.home-layout .container').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(width - 24);
      if (path === 'profile.html') await expect(page.locator('#p-coins')).toHaveText('110');
      if (path === 'admin.html') {
        for (const tab of ['products', 'users', 'showcase', 'wins', 'settings']) {
          await page.locator(`[data-tab="${tab}"]`).click();
          await expect(page.locator(`#tab-${tab}`)).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
      }
      if (path === 'index.html' && [390, 768, 1440].includes(width))
        await page.screenshot({ path: `test-results/home-${width}.png`, fullPage: true });
    }
    expect(errors).toEqual([]);
  });
}

test('刷新失败保留缓存，并合并并发读取', async ({ page }) => {
  await mockAPI(page); await page.goto('/index.html');
  await expect(page.locator('.card .name')).toHaveText(product.name);
  let calls = 0;
  await page.route('**/api/shop/products', async route => {
    calls++; await new Promise(resolve => setTimeout(resolve, 50));
    await route.fulfill({ status: 503, json: { ok: false } });
  });
  await page.evaluate(() => Promise.all([Store.refreshProducts(), Store.refreshProducts()]));
  expect(calls).toBe(1);
  expect(await page.evaluate(() => Store.listProducts().length)).toBe(1);
});

test('手机触控输入、横竖屏切换和底部导航', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await mockAPI(page); await page.goto('http://127.0.0.1:43179/recharge.html');
  await expect(page.locator('#custom-amt')).toBeVisible();
  await page.locator('#custom-amt').tap();
  await page.locator('#custom-amt').pressSequentially('123');
  await expect(page.locator('#custom-amt')).toBeFocused();
  expect(await page.locator('#custom-amt').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('#custom-amt')).toHaveValue('123');
  await expect(page.locator('#mob-nav')).toBeVisible();
  expect(await page.locator('.recharge-btn').evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await context.close();
});

test('昵称和商品名称按文本渲染，登录跳转限制在站内', async ({ page }) => {
  await mockAPI(page, { product: { ...product, name: '<img src=x onerror="window.injected=true">' } });
  await page.goto('/index.html');
  await expect(page.locator('.card .name')).toHaveText('<img src=x onerror="window.injected=true">');
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await page.goto('/login.html');
  expect(await page.evaluate(() => safeReturnPath('javascript:alert(1)'))).toBe('index.html');
  expect(await page.evaluate(() => safeReturnPath('//evil.example/path'))).toBe('index.html');
  expect(await page.evaluate(() => safeReturnPath('detail.html?id=p_test'))).toBe('/detail.html?id=p_test');
});

test('订单地址提交使用商品 ID 和正确字段', async ({ page }) => {
  await mockAPI(page); await page.goto('/orders.html'); await page.evaluate(() => Store.ready);
  const dialogs = ['张三', '12345678', '测试地址'];
  page.on('dialog', dialog => dialog.accept(dialogs.shift()));
  const request = page.waitForRequest('**/api/wallet/address');
  await page.evaluate(() => fillAddress('o_test'));
  expect((await request).postDataJSON()).toMatchObject({ productId: 'p_test', name: '张三', address: '测试地址' });
});

test('成功返回参数不能伪造到账结果', async ({ page }) => {
  await mockAPI(page);
  await page.route('**/api/wallet/recharges/**', route => route.fulfill({ json: { ok: true, recharge: { status: 'failed' } } }));
  await page.goto('/recharge.html?result=success&id=rc_test');
  await expect(page.locator('#payment-status-title')).toHaveText('充值未完成');
});

test('访客通过只读轮询看到开奖结果', async ({ page }) => {
  await mockAPI(page, { guest: true, product: { ...product, status: 'drawing' } });
  let reads = 0;
  await page.route('**/api/shop/products/p_test', route => route.fulfill({ json: { ok: true, product: { ...product,
    status: ++reads === 1 ? 'drawing' : 'done', draw: { win_number: 1, winner_name: '幸运用户' } } } }));
  await page.goto('/detail.html?id=p_test');
  await expect(page.locator('.draw-result-number')).toBeVisible();
});

test('后台规则保存失败显示实际错误而不是成功', async ({ page }) => {
  await mockAPI(page);await page.goto('/admin.html');
  await page.locator('[data-tab="settings"]').click();
  await page.route('**/api/admin/config',route=>route.fulfill({status:503,json:{ok:false,msg:'测试保存失败'}}));
  await page.evaluate(()=>saveRules());
  await expect(page.locator('#toast')).toHaveText('测试保存失败');
});

test('导入价格按1.5倍联动总份数与免费比例，缺价不沿用旧份数',async({page})=>{
 await mockAPI(page);await page.goto('/admin.html');await page.evaluate(()=>Store.ready);
 await page.locator('[data-tab="products"]').click();
 await page.evaluate(()=>applyDraft({name:'价格测试',refPrice:200},'https://www.amazon.com/dp/B08KT2Z93D'));
 await expect(page.locator('#f-total')).toHaveValue('300');
 await page.locator('#f-free-ratio').fill('10');await expect(page.locator('#f-free')).toHaveValue('30');
 await page.locator('#f-price').fill('2');await expect(page.locator('#f-total')).toHaveValue('150');await expect(page.locator('#f-free')).toHaveValue('15');
 await page.locator('#f-multiplier').fill('1');await expect(page.locator('#f-total')).toHaveValue('100');await expect(page.locator('#f-free')).toHaveValue('10');
 await page.evaluate(()=>applyDraft({name:'缺价商品',refPrice:0},'https://www.amazon.com/dp/B08KT2Z93D'));
 await expect(page.locator('#base-price')).toHaveValue('');await expect(page.locator('#f-total')).toHaveValue('');
 await expect(page.locator('#price-import-note')).toContainText('未获取');
 await page.locator('#base-price').fill('200');await expect(page.locator('#f-total')).toHaveValue('300');await expect(page.locator('#f-free')).toHaveValue('30');
 await page.locator('#f-free').fill('12');await expect(page.locator('#f-free-ratio')).toHaveValue('');
});
test('未开通支付时按钮禁用且不创建充值',async({page})=>{
  await mockAPI(page);await page.route('**/api/wallet/packages',route=>route.fulfill({json:{ok:true,packages:[{amount:10,bonus:1}],methods:{stripe:false,paypal:false}}}));
  let writes=0;await page.route('**/api/wallet/recharge',route=>{writes++;return route.fulfill({json:{ok:false}})});
  await page.goto('/recharge.html');await expect(page.locator('.recharge-btn')).toBeDisabled();
  await page.evaluate(()=>doPay());expect(writes).toBe(0);
});
test('商品读取失败明确显示重试入口',async({page})=>{
  await mockAPI(page);await page.route('**/api/shop/catalog?**',route=>route.fulfill({status:503,json:{ok:false,msg:'服务暂不可用'}}));
  await page.goto('/index.html');await expect(page.locator('#grid')).toContainText('商品加载失败');await expect(page.locator('#grid button')).toHaveText('重试');
});
test('搜索用户提交到服务端而不是仅搜索当前页',async({page})=>{
  await mockAPI(page);await page.goto('/admin.html');await page.locator('[data-tab="users"]').click();
  const request=page.waitForRequest(r=>r.url().includes('/api/admin/users?')&&new URL(r.url()).searchParams.get('q')==='old-user');
  await page.locator('#user-search').fill('old-user');await request;
});
test('购买超时后的重试复用请求编号',async({page})=>{
  await mockAPI(page);await page.goto('/detail.html?id=p_test');await page.evaluate(()=>Store.ready);
  const bodies=[];await page.route('**/api/wallet/buy',route=>{bodies.push(route.request().postDataJSON());return route.fulfill({status:503,json:{ok:false,msg:'连接中断'}})});
  await page.evaluate(()=>Store.buyShares('p_test',1,false));await page.evaluate(()=>Store.buyShares('p_test',1,false));
  expect(bodies).toHaveLength(2);expect(bodies[0].requestKey).toBe(bodies[1].requestKey);
});
test('浏览器独立验证真实drand签名并拒绝篡改',async({page})=>{
  await mockAPI(page);await page.goto('/index.html');
  const fixture=JSON.parse(fs.readFileSync(new URL('../fixtures/drand-quicknet-42.json',import.meta.url)));
  const result=await page.evaluate(async data=>{
    const {verifyProofData}=await import('/js/proof.js');
    const valid=await verifyProofData(data);let rejected=false;
    try{await verifyProofData({...data,signature:'00'.repeat(48)})}catch{rejected=true}
    return {round:valid.round,rejected};
  },fixture);
  expect(result).toEqual({round:42,rejected:true});
});
