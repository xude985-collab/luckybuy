import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const user = { id: 'u_test', name: '测试用户', account: 'test@example.com', role: 'admin', paid_balance: '100', free_balance: '10', invite_code: 'ABC123' };
const product = { id: 'p_test', sku: 'CL0001', name: '多设备测试商品', category: 'cleaning', pricePerShare: 1, totalShares: 100, sold: 10, status: 'active', gallery: [], emoji: '🎁' };
const order = { id: 'o_test', product_id: product.id, name: product.name, sku: product.sku, shares: 1, numbers: '[1]', paid_coins: 1, free_coins: 0, created_at: Date.now() };

async function mockAPI(page, options = {}) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api', '');
    const data = {
      '/auth/me': { user: options.guest ? null : (options.user || user) },
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
      '/shop/my-wins': { wins: options.wins || [] }, '/showcase/approved': { showcases: [] },
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
  expect(calls).toBe(2);
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

test('邀请链接从简短路径指向注册页并显示真实累计奖励', async ({ page }) => {
  await mockAPI(page);
  await page.route('**/api/auth/me', route => route.fulfill({json:{ok:true,user:{...user,invites:3,invite_earned:15}}}));
  await page.goto('/orders.html'); await page.evaluate(() => Store.ready);
  await page.evaluate(() => { history.replaceState(null,'','/orders'); render(); });
  await expect(page.locator('#inviteLink')).toHaveValue('http://127.0.0.1:43179/login?ref=ABC123');
  await expect(page.locator('.invite-stat')).toContainText('3');
  await expect(page.locator('.invite-stat')).toContainText('15');
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

test('首页详情显示总份数和免费额度，0表示没有免费名额',async({page})=>{
 await mockAPI(page,{product:{...product,freeQuota:0}});
 await page.goto('/index.html');await expect(page.locator('.progress-meta').first()).toContainText('总 100 份');
 await expect(page.locator('.card-free-quota').first()).toContainText('免费共 0 份');
 await page.goto('/detail.html?id=p_test');await expect(page.locator('.free-quota-tip')).toContainText('免费总额度 0');
 await mockAPI(page,{product:{...product,freeQuota:5,freeUsed:2}});
 await page.goto('/index.html');await expect(page.locator('.card-free-quota').first()).toContainText('免费共 5 份 · 剩 3 份');
 await page.goto('/detail.html?id=p_test');await expect(page.locator('.free-quota-tip')).toContainText('免费剩余 3 份');
});

test('导入价格固定1.5倍与5%免费名额，缺价禁止保存',async({page})=>{
 await mockAPI(page);await page.goto('/admin.html');await page.evaluate(()=>Store.ready);await page.locator('[data-tab="products"]').click();
 await page.evaluate(()=>applyDraft({name:'测试商品',refPrice:100},'https://www.amazon.com/dp/B08KT2Z93D'));
 await expect(page.locator('#f-total')).toHaveValue('150');await expect(page.locator('#f-free')).toHaveValue('8');await expect(page.locator('#f-free-ratio')).toHaveValue('5');
 await page.locator('#base-price').fill('66');await expect(page.locator('#f-total')).toHaveValue('99');await expect(page.locator('#f-free')).toHaveValue('5');
 await page.locator('#base-price').fill('200');await expect(page.locator('#f-total')).toHaveValue('300');await expect(page.locator('#f-free')).toHaveValue('15');
 await expect(page.locator('#f-free-ratio')).not.toBeEditable();
 await page.evaluate(()=>applyDraft({name:'缺价商品',refPrice:0},'https://www.amazon.com/dp/B08KT2Z93D'));
 await expect(page.locator('#base-price')).toHaveValue('');await expect(page.locator('#f-total')).toHaveValue('');
 let writes=0;await page.route('**/api/admin/products',r=>{writes++;return r.fulfill({json:{ok:true}})});
 await page.evaluate(()=>save());expect(writes).toBe(0);
});

test('未核实价格的商品不再显示一份或开放参与',async({page})=>{
 await mockAPI(page,{product:{...product,totalShares:1,pricingPending:true,freeQuota:0}});
 await page.goto('/index.html');await expect(page.locator('.card')).toContainText('价格待核实');await expect(page.locator('.card-buy-btn')).toHaveCount(0);
 await page.goto('/detail.html?id=p_test');await expect(page.locator('#detail')).toContainText('价格待核实');await expect(page.locator('#qty')).toHaveCount(0);
});

test('旧截图中的手机分页、抢购动态、晒单和快捷份数入口保留',async({page})=>{
 await mockAPI(page);await page.setViewportSize({width:390,height:900});
 await page.route('**/api/shop/catalog?**',r=>r.fulfill({json:{ok:true,products:[product],total:16,pages:2}}));
 await page.route('**/api/shop/recent-buys',r=>r.fulfill({json:{ok:true,buys:[{buyer_name:'旧图动态测试',product_name:product.name,shares:1,created_at:Date.now()}]}}));
 await page.route('**/api/showcase/approved',r=>r.fulfill({json:{ok:true,showcases:[{id:'sc-proof',caption:'晒单测试文字',product_name:product.name,user_name:'测试用户',media_type:'image',media_url:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'}]}}));
 await page.goto('/index.html');await expect(page.locator('#pagination')).toContainText('1 / 2');await expect(page.locator('#live-feed-list')).toContainText('旧图动态测试');await expect(page.locator('#showcase')).toContainText('晒单测试文字');
 await expect(page.locator('#grid')).toContainText('全包');await expect(page.locator('#grid')).toContainText(/5\s*份/);
 await page.locator('#pagination button').last().click();await expect(page.locator('#pagination')).toContainText('2 / 2');
});

test('旧图滚动幸运榜在手机电脑均显示，空记录不会伪造中奖者',async({page})=>{
 await mockAPI(page);await page.goto('/index.html');await expect(page.locator('#marquee')).toContainText('暂无可显示');
 await page.route('**/api/shop/winners',r=>r.fulfill({json:{ok:true,winners:[{winner_name:'真实记录示例',name:'商品测试',win_number:20,price:1}]}}));
 await page.reload();
 for(const width of [390,1440]){await page.setViewportSize({width,height:900});await expect(page.locator('#marquee')).toBeVisible();await expect(page.locator('#marquee .track')).toContainText('真实记录示例');await expect(page.locator('#marquee')).toContainText('20');expect(await page.locator('#marquee .track').evaluate(e=>getComputedStyle(e).animationName)).not.toBe('none');}
});

test('旧截图中的幸运区、中奖号码高亮、地址入口和凭据保留',async({page})=>{
 const proof=JSON.parse(fs.readFileSync(new URL('../fixtures/drand-quicknet-42.json',import.meta.url)));
 const won={...product,status:'done',sold:100,draw:{round:42,win_number:1,winner_user_id:user.id,winner_name:'测试幸运儿',randomness:proof.randomness,signature:proof.signature}};
 await mockAPI(page,{product:won});await page.route('**/api/shop/notifications',r=>r.fulfill({json:{ok:true,products:[]}}));
 await page.goto('/winners.html');await expect(page.locator('#winners-grid')).toContainText('测试幸运儿');await expect(page.locator('#winners-grid')).toContainText('查看详情');
 await page.goto('/detail.html?id=p_test');await expect(page.locator('.num-chip-win')).toContainText('1');await expect(page.locator('#detail')).toContainText('填写收货地址');await expect(page.locator('#detail')).toContainText('验证幸运结果');
 await page.goto('/profile.html');await expect(page.locator('#checkin-card')).toContainText('签到');await expect(page.locator('#p-coins')).toHaveText('110');await expect(page.locator('#p-orders')).toHaveText('1');
});

test('首页分页之外的中奖商品仍弹出领奖地址窗口',async({page})=>{
 await mockAPI(page);
 await page.route('**/api/shop/notifications',r=>r.fulfill({json:{ok:true,products:[{id:'outside-page',name:'未在首页加载的中奖商品',status:'revealed',winnerUserId:user.id,winNumber:9,hasAddress:false}]}}));
 await page.goto('/index.html');await expect(page.locator('.win-celebrate-mask')).toBeVisible();await expect(page.locator('.win-product')).toContainText('未在首页加载');
});

test('任意详情页显示另一个已参与商品的开奖通知',async({page})=>{
 await mockAPI(page);
 await page.route('**/api/shop/notifications',r=>r.fulfill({json:{ok:true,products:[{id:product.id,name:'等待揭晓商品',status:'drawing',drawTime:Date.now()+300000}]}}));
 await page.goto('/detail.html?id=another-product');await expect(page.locator('#draw-notify-bar')).toContainText('等待揭晓商品');
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

test('验证码发送防重复、请求期间切换安全且倒计时跨切换保留', async ({page}) => {
 await mockAPI(page,{guest:true});
 let release;
 const pending=new Promise(resolve=>release=resolve);
 let calls=0;
 await page.route('**/api/auth/send-code',async route=>{
  calls++; await pending;
  await route.fulfill({json:{ok:true,msg:'验证码已发送',devCode:'123456'}});
 });
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/login.html?mode=register');
 await page.locator('#account').fill('test@example.com');
 await page.locator('#sendCodeBtn').click();
 await expect(page.locator('#sendCodeBtn')).toBeDisabled();
 await page.locator('.auth-tabs span').first().click();
 await expect(page.locator('#code')).toBeVisible();
 release();
 await expect(page.locator('#code')).toHaveValue('123456');
 await expect(page.locator('#sendCodeBtn')).toContainText('后重发');
 await page.locator('.auth-tabs span').first().click();
 await page.locator('.auth-tabs span').last().click();
 await expect(page.locator('#sendCodeBtn')).toBeDisabled();
 expect(calls).toBe(1);expect(errors).toEqual([]);
});

test('登录状态接口挂起时仍立即展示表单，失败后显示具体错误', async ({page})=>{
 await mockAPI(page,{guest:true});
 let release;const pending=new Promise(resolve=>release=resolve);
 await page.route('**/api/auth/me',async route=>{
  await pending;await route.fulfill({status:503,json:{ok:false,msg:'服务暂时无法连接，请稍后重试'}});
 });
 await page.goto('/login.html');
 await expect(page.locator('#account')).toBeVisible();
 await expect(page.locator('#submitBtn')).toBeEnabled();
 release();
 await expect(page.locator('#service-notice')).toContainText('服务暂时无法连接');
});

test('登录状态临时失败自动恢复，登录写请求不重发', async({page})=>{
 await mockAPI(page,{guest:true});let reads=0,writes=0;
 await page.route('**/api/auth/me',async route=>{
  reads++;await route.fulfill(reads<3?{status:503,json:{ok:false,msg:'temporary'}}:{json:{ok:true,user:null}});
 });
 await page.route('**/api/auth/login',async route=>{writes++;await route.fulfill({status:503,json:{ok:false,msg:'暂时不可用'}})});
 await page.goto('/login.html');
 await expect.poll(()=>reads).toBe(3);
 await expect(page.locator('#service-notice')).toHaveCount(0);
 await page.locator('#account').fill('test@example.com');await page.locator('#password').fill('wrong-password');
 await page.locator('#submitBtn').click();
 await expect(page.locator('#submitBtn')).toBeEnabled();expect(writes).toBe(1);
});

test('管理员点金额测试到账，可以指定别人账号',async({page})=>{
 await mockAPI(page);let body;
 await page.route('**/api/admin/users?**',r=>r.fulfill({json:{ok:true,users:[user,{id:'friend',name:'朋友',account:'friend@example.com'},{id:'disabled',name:'停用',account:'disabled@example.com',disabled:true}],pages:1}}));
 await page.route('**/api/admin/test-recharge',async route=>{body=route.request().postDataJSON();await route.fulfill({json:{ok:true,msg:'已测试到账'}})});
 await page.goto('/recharge.html');
 await page.locator('#test-credit button').filter({hasText:'+100 金币'}).click();
 await expect(page.locator('#test-credit-result')).toHaveText('已测试到账');
 expect(body.account).toBe(user.account);expect(body.amount).toBe(100);
 await expect(page.locator('#test-credit button').first()).toBeEnabled();
 await expect(page.locator('#test-account option[value=friend]')).toHaveText('朋友（friend@example.com）');
 await expect(page.locator('#test-account option[value=disabled]')).toHaveCount(0);
 await page.locator('#test-account').selectOption('friend');
 await page.locator('#test-credit button').first().click();
 await expect(page.locator('#test-credit-result')).toHaveText('已测试到账');
 expect(body.account).toBe('friend@example.com');expect(body.userId).toBe('friend');expect(body.amount).toBe(10);
});

test('用户管理删除普通用户且不提供删除管理员入口',async({page})=>{
 await mockAPI(page);let removed=false;
 await page.route('**/api/admin/users?**',r=>r.fulfill({json:{ok:true,users:removed?[user]:[user,{...user,id:'ordinary',account:'ordinary@example.com',role:'user'}],total:removed?1:2,pages:1}}));
 await page.route('**/api/admin/users/ordinary/delete',r=>{expect(r.request().postDataJSON()).toEqual({confirmation:'DELETE'});removed=true;return r.fulfill({json:{ok:true,msg:'用户已删除，历史交易记录保留'}})});
 await page.goto('/admin.html');await page.locator('[data-tab="users"]').click();
 await expect(page.locator('#tab-users').getByRole('link',{name:'删除',exact:true})).toHaveCount(1);
 page.once('dialog',d=>d.accept());await page.locator('#tab-users').getByRole('link',{name:'删除',exact:true}).click();
 await expect(page.locator('#tab-users')).not.toContainText('ordinary@example.com');
});


test('普通用户所有页面均不显示后台入口，管理员和退出状态正确切换',async({page})=>{
 await mockAPI(page,{user:{...user,role:'user'}});
 await page.setViewportSize({width:1440,height:900});
 for(const path of ['index','detail?id=p_test','orders','profile','recharge','rules','showcase','winners','login']){
  await page.goto('/'+path.replace('?', '.html?')+(path.includes('?')?'':'.html'));
  await page.evaluate(()=>Store.ready);
  await expect(page.locator('#topbar a[href="admin.html"]')).toBeHidden();
  await expect(page.locator('#mob-nav a[href="admin.html"]')).toHaveCount(0);
  await expect(page.locator('#topbar a[href="admin.html"]')).toHaveClass(/nav-admin/);
  if(path==='profile') await expect(page.locator('#profile-admin-entry')).toBeHidden();
 }
 await page.goto('/profile.html');
 await page.evaluate(()=>Store.ready);
 for(const width of [390,768,1440]){
  await page.setViewportSize({width,height:900});
  await page.evaluate(()=>{Store._cache.user.isAdmin=true;renderTopbar('home');});
  await expect(page.locator('#mob-nav a')).toHaveCount(5);
  await expect(page.locator('#mob-nav a[href="admin.html"]')).toHaveCount(0);
  await expect(page.locator('#profile-admin-entry a')).toBeVisible();
  if(width>1100) await expect(page.locator('#topbar a[href="admin.html"]')).toBeVisible();
  await page.evaluate(()=>{Store._cache.user.isAdmin=false;renderTopbar('home');});
  await expect(page.locator('#topbar a[href="admin.html"]')).toBeHidden();
  await expect(page.locator('#mob-nav a[href="admin.html"]')).toHaveCount(0);
  await expect(page.locator('#profile-admin-entry')).toBeHidden();
 }
 await page.evaluate(()=>{Store._cache.user=null;renderTopbar('home');});
 await expect(page.locator('#topbar a[href="admin.html"]')).toBeHidden();
 await expect(page.locator('#profile-admin-entry')).toBeHidden();
});

test('手机管理员通过我的进入后台',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await mockAPI(page);
 await page.goto('/index.html');
 await expect(page.locator('#mob-nav a')).toHaveCount(5);
 await page.locator('#mob-nav a[href="profile.html"]').click();
 await page.locator('#profile-admin-entry a').click();
 await expect(page).toHaveURL(/admin\.html/);
 await expect(page.locator('[data-tab="products"]')).toBeVisible();
 await expect(page.locator('#mob-nav a')).toHaveCount(5);
});

test('导入价格保存前确认实际采购价和份数，取消不写入',async({page})=>{
 await mockAPI(page);await page.goto('/admin.html');await page.evaluate(()=>Store.ready);await page.locator('[data-tab="products"]').click();
 await page.evaluate(()=>applyDraft({name:'Roomba',refPrice:799.99},'https://www.amazon.com/dp/B0DPNKVFVW'));
 let saved=null;await page.route('**/api/admin/products',r=>{saved=r.request().postDataJSON();return r.fulfill({json:{ok:true,msg:'已保存'}})});
 page.once('dialog',d=>{expect(d.message()).toContain('1200');expect(d.message()).toContain('60');return d.dismiss()});
 await page.evaluate(()=>save());expect(saved).toBeNull();
 page.once('dialog',d=>d.accept());await page.evaluate(()=>save());
 expect(saved.pricing.priceConfirmed).toBe(true);expect(saved.totalShares).toBe(1200);expect(saved.freeQuota).toBe(60);
});

for (const width of [390, 768, 1440]) {
 test(`晒单仅向中奖者开放 ${width}px`, async ({page}) => {
  await page.setViewportSize({width,height:900});
  await mockAPI(page,{user:{...user,role:'user'}});
  await page.goto('/profile.html');
  await expect(page.locator('#sc-eligibility')).toContainText('大奖等着你');
  await expect(page.locator('#sc-form')).toBeHidden();
  let submissions=0;
  await page.route('**/api/showcase/submit',async route=>{submissions++;await route.fulfill({json:{ok:true}});});
  await page.evaluate(()=>submitSC());
  expect(submissions).toBe(0);
  await mockAPI(page,{wins:[{product_id:'p_test',product_name:'中奖商品',drawn_at:Date.now()}]});
  await page.reload();
  await expect(page.locator('#sc-form')).toBeVisible();
  await expect(page.locator('#sc-product option')).toHaveCount(2);
  expect(await page.locator('#sc-file').evaluate(el=>el.getBoundingClientRect().right<=innerWidth)).toBe(true);
  await page.route('**/api/shop/my-wins',route=>route.fulfill({status:503,json:{ok:false}}));
  await page.reload();
  await expect(page.locator('#sc-eligibility')).toContainText('加载失败');
  await expect(page.locator('#sc-form')).toBeHidden();
 });
}

test('电脑每页16件，翻页和分类重置正常',async({page})=>{
 await page.setViewportSize({width:1440,height:900});
 await mockAPI(page,{user:{...user,role:'user'}});
 await page.route('**/api/shop/catalog?**',async route=>{
  const u=new URL(route.request().url());expect(u.searchParams.get('limit')).toBe('16');
  const n=Number(u.searchParams.get('page'));const count=n===1?16:1;
  await route.fulfill({json:{ok:true,total:17,pages:2,products:Array.from({length:count},(_,i)=>({...product,id:'p_'+n+'_'+i,name:'商品 '+n+'-'+i}))}});
 });
 await page.goto('/index.html');
 await expect(page.locator('#grid .card')).toHaveCount(16);
 await expect(page.locator('#pagination')).toContainText('共 17 件 · 每页 16 件');
 await expect(page.locator('#topbar-wallet')).toContainText('金币：');
 await expect(page.locator('#recharge')).toHaveCount(1);
 await page.locator('#pagination button').last().click();
 await expect(page.locator('#grid .card')).toHaveCount(1);
 await expect(page.locator('#pagination')).toContainText('第 2 / 2 页');
 await expect(page.locator('#pagination button').last()).toBeDisabled();
 await page.locator('.cat-tab').nth(1).click();
 await expect(page.locator('#grid .card')).toHaveCount(16);
 await expect(page.locator('#pagination')).toContainText('第 1 / 2 页');
 await page.screenshot({path:'test-results/desktop-layout-16.png',fullPage:true});
});

for (const guest of [false, true]) {
 test(`手机首页重载在身份及商品请求等待期间保持商品占位（访客=${guest}）`, async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await mockAPI(page, {guest});
  let releaseSession, releaseCatalog;
  const sessionGate = new Promise(resolve => { releaseSession = resolve; });
  const catalogGate = new Promise(resolve => { releaseCatalog = resolve; });
  await page.route('**/api/auth/me', async route => { await sessionGate; await route.fallback(); });
  await page.route('**/api/shop/catalog?**', async route => { await catalogGate; await route.fallback(); });
  await page.goto('/index.html');
  await expect(page.locator('.catalog-loading')).toBeVisible();
  await expect(page.locator('.left-col')).toBeHidden();
  await expect(page.locator('#grid')).toHaveAttribute('aria-busy','true');
  const catalogRequest = page.waitForRequest('**/api/shop/catalog?**');
  releaseSession();
  await catalogRequest;
  await expect(page.locator('.catalog-loading')).toBeVisible();
  await expect(page.locator('.left-col')).toBeHidden();
  releaseCatalog();
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(page.locator('.left-col')).toBeVisible();
  await expect(page.locator('#grid')).toHaveAttribute('aria-busy','false');
  expect(await page.evaluate(() => document.querySelector('.left-col').getBoundingClientRect().top >= document.querySelector('#grid').getBoundingClientRect().bottom)).toBe(true);
 });
}

test('手机首页商品失败与空列表都能结束初始占位，失败可重试', async ({ page }) => {
 await page.setViewportSize({width:390,height:844});
 await mockAPI(page);
 await page.route('**/api/shop/catalog?**', route => route.fulfill({status:503,json:{ok:false}}));
 await page.goto('/index.html');
 await expect(page.locator('#grid')).toContainText('商品加载失败');
 await expect(page.locator('.catalog-loading')).toHaveCount(0);
 await expect(page.locator('.left-col')).toBeVisible();
 await page.unroute('**/api/shop/catalog?**');
 await page.locator('#grid button').click();
 await expect(page.locator('.card')).toHaveCount(1);
 await page.route('**/api/shop/catalog?**', route => route.fulfill({json:{ok:true,products:[],total:0,pages:1}}));
 await page.reload();
 await expect(page.locator('#grid')).toContainText('该类别下暂无商品');
 await expect(page.locator('.catalog-loading')).toHaveCount(0);
 await expect(page.locator('.left-col')).toBeVisible();
});

for (const width of [320, 768, 1440]) {
  test(`开奖倒计时仅提醒本人参与且倒计时结束仍保留 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockAPI(page, { product: { ...product, status: 'drawing', sold: 100, draw: { drawTime: Date.now() + 3500 } } });
    await page.goto('/index.html');
    const note = page.locator('.card-participation-note');
    await expect(note).toHaveText('您已参与本商品，敬请关注开奖结果');
    await expect(page.locator('.card-countdown-time')).toBeVisible();
    await expect(page.locator('.card-countdown')).toContainText('正在揭晓', { timeout: 7000 });
    await expect(note).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.route('**/api/wallet/orders', route => route.fulfill({ json: { ok: true, orders: [{ ...order, product_id: 'another_product' }] } }));
    await page.reload();
    await expect(page.locator('.card-countdown')).toBeVisible();
    await expect(note).toHaveCount(0);
    await page.route('**/api/auth/me', route => route.fulfill({ json: { ok: true, user: null } }));
    await page.reload();
    await expect(page.locator('.card-countdown')).toBeVisible();
    await expect(note).toHaveCount(0);
  });
}

for(const width of [390,1440]) {
 test(`后台直接访问在身份检查前隐藏，普通用户和访客被拒绝 ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});
  for(const guest of [false,true]){
   await mockAPI(page,{guest,user:{...user,role:'user'}});
   let release;
   const gate=new Promise(resolve=>release=resolve);
   await page.route('**/api/auth/me',async route=>{await gate;await route.fulfill({json:{ok:true,user:guest?null:{...user,role:'user'}}});});
   let adminRequests=0;
   await page.route('**/api/admin/**',route=>{adminRequests++;return route.fulfill({status:403,json:{ok:false}});});
   await page.goto('/admin.html',{waitUntil:'domcontentloaded'});
   await expect(page.locator('#admin-content')).toBeHidden();
   release();
   await expect(page.locator('body')).toContainText('此页面仅管理员可访问');
   await expect(page.locator('.admin-tabs')).toHaveCount(0);
   expect(adminRequests).toBe(0);
   await page.unrouteAll({behavior:'wait'});
  }
 });
}

test('商品读取临时失败自动恢复，首排封面使用小图且详情保留原图',async({page})=>{
 const picture='https://m.media-amazon.com/images/I/71Example._AC_SL1500_.jpg';
 const p={...product,gallery:[{type:'image',url:picture}]};
 await page.route('https://m.media-amazon.com/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'}));
 await mockAPI(page,{product:p});
 let reads=0;
 await page.route('**/api/shop/catalog?**',route=>++reads===1?route.fulfill({status:503,json:{ok:false}}):route.fulfill({json:{ok:true,products:[p],total:1,pages:1}}));
 await page.goto('/index.html');
 await expect(page.locator('.card .name')).toHaveText(product.name);
 expect(reads).toBe(2);
 await expect(page.locator('#service-notice')).toHaveCount(0);
 await expect(page.locator('.card img')).toHaveAttribute('src',picture.replace('SL1500','SL600'));
 await expect(page.locator('.card img')).toHaveAttribute('loading','eager');
 await page.locator('.card img').dispatchEvent('error');
 await expect(page.locator('.card img')).toHaveAttribute('src',picture);
 await page.goto('/detail.html?id=p_test');
 await expect(page.locator('#gmain')).toHaveAttribute('src',picture);
});
