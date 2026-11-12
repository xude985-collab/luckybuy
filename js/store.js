/* Store —— 后端 API 客户端 + 内存缓存门面
   设计：init() 异步拉全量数据填缓存；页面的同步 getter 读缓存，
   写操作调后端 API 后刷新对应缓存。页面渲染代码基本不用改，
   仅需把首屏渲染包进 Store.ready，写操作处加 await。 */
const Store = (() => {
  const API = '/api';

  // ---- 内存缓存 ----
  const cache = {
    user: null,          // 当前登录用户（camelCase）
    products: [],        // 商品列表（已归一化为页面形状）
    productMap: {},       // id -> product
    categories: [],
    orders: [],          // 当前用户订单（已归一化）
    winners: [],         // 跑马灯
    recentBuys: [],      // 实时抢购动态
    notifications: null,
    config: {},
    wallet: { paidBalance: 0, tx: [] },
  };

  // ---- HTTP ----
  const pendingGets = new Map();
  const errors = new Map();
  function recordError(path,msg){if(msg)errors.set(path,msg);else errors.delete(path);window.dispatchEvent(new Event('store-status'));}

  async function http(method, path, body, attempt = 0) {
    const retrySession = method === 'GET' && path === '/auth/me' && attempt < 2;
    const retry = async () => {
      clearTimeout(timer);
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      return http(method, path, body, attempt + 1);
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), method === 'GET' && path === '/auth/me' ? 12000 : 60000);
    const opt = { method, credentials: 'same-origin', headers: {}, signal: controller.signal };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    let resp, data;
    try {
      resp = await fetch(API + path, opt);
      if (retrySession && [502, 503, 504].includes(resp.status)) {
        await resp.body?.cancel();
        return retry();
      }
      const text = await resp.text();
      try { data = JSON.parse(text); } catch (_) {
        if(method==='GET')recordError(path,'服务暂时不可用，请稍后重试');
        return { ok: false, status:resp.status, uncertain:true, msg: resp.status === 429
          ? '服务请求受限，请稍等一分钟后重试'
          : resp.status >= 500 ? '服务暂时不可用，请稍后重试'
          : '服务器响应异常，请稍后重试' };
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        if(method==='GET')recordError(path,'服务器响应异常');
        return { ok: false, uncertain:true, msg: '服务器响应异常，请稍后重试' };
      }
    } catch (e) {
      if (retrySession) return retry();
      if(method==='GET')recordError(path,'连接暂时失败，请稍后重试');
      return { ok: false, uncertain:true, msg: controller.signal.aborted
        ? '请求超时，请刷新确认操作结果' : '网络异常，请稍后重试' };
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) data.ok = false;
    data.status=resp.status;data.uncertain=resp.status>=500||resp.status===429;
    if(method==='GET')recordError(path,data.ok?null:(data.msg||'加载失败'));
    if(resp.status===401){cache.user=null;}
    return data;
  }
  const get = (p) => {
    if (!pendingGets.has(p)) {
      pendingGets.set(p, http('GET', p).finally(() => pendingGets.delete(p)));
    }
    return pendingGets.get(p);
  };
  const post = (p, b) => http('POST', p, b);
  const put = (p, b) => http('PUT', p, b);
  const del = (p) => http('DELETE', p);

  // ---- 归一化：后端结构 → 页面已用的形状 ----
  // 后端 status: active/drawing/done ；前端页面用 active/drawing/revealed
  function normProduct(p, draw) {
    if (!p) return null;
    const status = p.status === 'done' ? 'revealed' : p.status;
    const out = {
      id: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      img: p.emoji || '🎁',
      price: p.pricePerShare,
      totalShares: p.totalShares,
      soldShares: p.sold || 0,
      freeQuota: p.freeQuota || 0,
      freeUsed: p.freeUsed || 0,
      desc: p.desc || '',
      gallery: p.gallery || [],
      specs: p.specs || [],
      sourceUrl: p.sourceUrl || '',
      pricing: p.pricing || {},
      period: p.sku ? ('编号 ' + p.sku) : '',
      status,
    };
    // 开奖信息
    const d = draw || p.draw || null;
    if (d) {
      out.drandRound = d.round;
      out.drawTime = d.drawTime || null;
      out.winNumber = d.win_number;
      out.winnerUserId = d.winner_user_id;
      out.winnerName = d.winner_name || null;
      out.hasAddress = !!d.win_address;
      if (d.randomness) {
        out.proof = { round: d.round, randomness: d.randomness, signature: d.signature };
      }
    }
    return out;
  }

  function indexProducts() {
    cache.productMap = {};
    for (const p of cache.products) cache.productMap[p.id] = p;
  }

  function normOrder(o) {
    // 后端订单行含 join 的商品/开奖字段
    const revealed = o.product_status === 'done';
    return {
      id: o.id,
      productId: o.product_id,
      productName: o.name,
      period: o.sku ? ('编号 ' + o.sku) : '',
      count: o.shares,
      cost: (o.free_coins || 0) + (o.paid_coins || 0),
      freeUsed: o.free_coins || 0,
      paidUsed: o.paid_coins || 0,
      numbers: parseNumbers(o.numbers),
      address: o.address ? safeParse(o.address) : null,
      time: new Date(Number(o.created_at)).toISOString(),
      winNumber: o.win_number,
    };
  }
  function parseNumbers(s) {
    if (Array.isArray(s)) return s;
    if (!s) return [];
    // 后端可能存 "1-5" 区间或 JSON 数组或逗号串
    const str = String(s).trim();
    if (str.startsWith('[')) { try { return JSON.parse(str); } catch { return []; } }
    if (str.includes('-') && !str.includes(',')) {
      const [a, b] = str.split('-').map(n => parseInt(n, 10));
      if (a && b && b >= a) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }
    }
    return str.split(',').map(n => parseInt(n, 10)).filter(n => !isNaN(n));
  }
  function safeParse(s) { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return s; } }

  // ---- 缓存刷新器 ----
  async function refreshMe() {
    const r = await get('/auth/me');
    if (!r.ok) return cache.user;
    cache.user = r.user ? mapUser(r.user) : null;
    if (cache.user) await refreshWallet();
    return cache.user;
  }
  function mapUser(u) {
    return {
      id: u.id,
      account: u.account,
      name: u.name,
      role: u.role,
      isAdmin: u.role === 'admin',
      inviteCode: u.invite_code,
      invites: Number(u.invites) || 0,
      inviteEarned: Number(u.invite_earned) || 0,
      paidCoins: Number(u.paid_balance) || 0,
      freeCoins: Number(u.free_balance) || 0,
    };
  }
  async function refreshWallet() {
    if (!cache.user) return;
    const r = await get('/wallet');
    if (r.ok) {
      cache.wallet = { paidBalance: r.paidBalance || 0, freeBalance: r.freeBalance || 0, tx: r.tx || [] };
      cache.user.paidCoins = r.paidBalance || 0;
      cache.user.freeCoins = r.freeBalance || 0;
    }
  }
  async function refreshNotifications() {
    if(!cache.user){cache.notifications=[];return;}
    const r=await get('/shop/notifications');
    if(r.ok&&Array.isArray(r.products))cache.notifications=r.products;
  }
  async function refreshProducts() {
    const r = await get('/shop/products');
    if (!r.ok || !Array.isArray(r.products)) return;
    cache.products = (r.products || []).map(p => normProduct(p));
    indexProducts();
  }
  async function catalog(page,limit,category='all',status='active'){
    const r=await get('/shop/catalog?page='+page+'&limit='+limit+'&category='+encodeURIComponent(category)+'&status='+status);
    if(r.ok){r.products=(r.products||[]).map(p=>normProduct(p));for(const p of r.products){cache.productMap[p.id]=p;const i=cache.products.findIndex(x=>x.id===p.id);if(i>=0)cache.products[i]=p;else cache.products.push(p);}}
    return r;
  }
  async function refreshProduct(id){
    const r=await get('/shop/products/'+encodeURIComponent(id));
    if(r.ok&&r.product){const item=normProduct(r.product);cache.productMap[id]=item;const i=cache.products.findIndex(p=>p.id===id);if(i>=0)cache.products[i]=item;else cache.products.push(item);}
    return r;
  }
  async function refreshCategories() {
    const r = await get('/shop/categories');
    if (!r.ok || !Array.isArray(r.categories)) return;
    cache.categories = (r.categories || []).map(c => ({
      key: c.key, name: c.name, prefix: c.prefix, icon: c.icon || '🏷️', sort: c.sort ?? 0,
    }));
  }
  async function refreshOrders() {
    if (!cache.user) { cache.orders = []; return; }
    const r = await get('/wallet/orders');
    if (!r.ok || !Array.isArray(r.orders)) return;
    cache.orders = (r.orders || []).map(normOrder);
  }
  async function refreshWinners() {
    const r = await get('/shop/winners');
    if (!r.ok || !Array.isArray(r.winners)) return;
    cache.winners = (r.winners || []).map(w => ({
      productName: w.name,
      winnerName: w.winner_name || '神秘用户',
      winNumber: w.win_number,
      price: w.price || '',
      showcase: null,
    }));
  }
  async function refreshRecentBuys() {
    const r = await get('/shop/recent-buys');
    if (!r.ok || !Array.isArray(r.buys)) return;
    cache.recentBuys = (r.buys || []).map(b => ({
      buyerName: b.buyer_name || '用户',
      productName: b.product_name,
      emoji: b.emoji || '🎁',
      shares: b.shares,
      time: b.created_at,
    }));
  }
  async function refreshConfig() {
    const r = await get('/shop/config').catch(() => ({}));
    if (r && r.config) cache.config = r.config;
  }

  // ============ 公共 API（页面调用面）============

  // ---- 会话/用户 ----
  function currentUser() { return cache.user; }
  function isLoggedIn() { return !!cache.user; }
  function totalCoins(u) { u = u || cache.user; return u ? (u.paidCoins || 0) + (u.freeCoins || 0) : 0; }
  function canCheckin() { return cache.user && !cache._checkedInToday; }

  async function refreshCheckinStatus() {
    if (!cache.user) return;
    const r = await get('/wallet/checkin-status');
    if (r.ok) {
      cache._checkedInToday = r.checkedIn;
      cache._checkinStreak = r.streak || 0;
    }
  }

  async function sendCode(account) {
    const r = await post('/auth/send-code', { account });
    if (r.ok && r.devCode) r.code = r.devCode; // 开发模式回显验证码
    return r;
  }
  async function register({ account, password, name, code, invite }) {
    const r = await post('/auth/register', { account, password, name, code, invite });
    if (r.ok) await refreshMe();
    return r;
  }
  async function login(account, password) {
    const r = await post('/auth/login', { account, password });
    if (r.ok) await refreshMe();
    return r;
  }
  async function logout() {
    await post('/auth/logout', {});
    cache.user = null;
    cache.orders = [];
    cache.wallet = { paidBalance: 0, tx: [] };
  }
  async function updateName(name) {
    const r = await post('/auth/update-name', { name });
    if (r.ok && cache.user) cache.user.name = r.name;
    return r;
  }
  async function recharge(amount, method) {
    const r = await post('/wallet/recharge', { amount, method: method || 'stripe' });
    if (r.ok && r.url) { location.href = r.url; return r; }
    if (r.ok) await refreshWallet();
    return r;
  }
  async function checkin() {
    const r = await post('/wallet/checkin', {});
    if (r.ok) {
      cache._checkedInToday = true;
      cache._checkinStreak = r.streak || 0;
      await refreshMe();
    }
    return r;
  }

  async function getPackages() {
    const r = await get('/wallet/packages');
    cache.paymentMethods=r.methods||{stripe:false,paypal:false};
    return r.ok ? r.packages : [];
  }
  const getRechargeHistory = () => get('/wallet/recharges');
  const refreshRecharge = id => post('/wallet/recharges/'+encodeURIComponent(id)+'/refresh',{});
  const getRechargeStatus = id => get('/wallet/recharges/' + encodeURIComponent(id));

  // ---- 商品/类别 ----
  function listProducts() { return cache.products; }
  function getProduct(id) { return cache.productMap[id] || null; }
  function listCategories() { return cache.categories; }
  function categoryOf(key) {
    return cache.categories.find(c => c.key === key) || { key, name: '其他', icon: '🏷️', prefix: 'OT' };
  }
  function productFreeUsed(id) { const p = cache.productMap[id]; return p ? (p.freeUsed || 0) : 0; }
  function winnersFeed() { return cache.winners; }
  function recentBuys() { return cache.recentBuys; }
  function getConfig() { return cache.config; }
  function myOrders() { return cache.orders; }

  // ---- 购买 ----
  async function buyShares(id, count, useFree) {
    const storageKey='lb-purchase-'+cache.user?.id;
    let pending;try{pending=JSON.parse(sessionStorage.getItem(storageKey)||'null')}catch{}
    const signature=JSON.stringify([id,count,useFree!==false]);
    if(pending && pending.signature!==signature){
      const check=await get('/wallet/purchases/'+pending.key);
      if(!check.ok||!check.order)return {ok:false,msg:'上一笔购买尚未确认，请用原商品和份数重试，或先查看参与记录'};
      sessionStorage.removeItem(storageKey);pending=null;
    }
    if(!pending){pending={key:crypto.randomUUID(),signature};sessionStorage.setItem(storageKey,JSON.stringify(pending));}
    const body = { productId: id, shares: count, requestKey:pending.key };
    if (useFree === false) body.useFree = false;
    const r = await post('/wallet/buy', body);
    if(r.ok||(!r.uncertain && r.status>=400))sessionStorage.removeItem(storageKey);
    if (!r.ok) {
      if (/余额不足/.test(r.msg || '')) r.needRecharge = true;
      return r;
    }
    await Promise.all([
      refreshProducts().catch(() => {}),
      refreshOrders().catch(() => {}),
      refreshWallet().catch(() => {}),
    ]);
    const order = cache.orders.find(o => o.id === r.orderId) || null;
    return {
      ok: true,
      msg: r.msg || '参与成功',
      order: order || { freeUsed: r.freeUsed || 0, paidUsed: r.paidUsed || 0 },
    };
  }

  // ---- 幸运儿填地址 ----
  async function saveAddress(productId, addr) {
    const r = await post('/wallet/address', {
      productId,
      name: addr.name, phone: addr.phone, address: addr.address,
      country: addr.country || '',
    });
    if (r.ok) await refreshOrders();
    return r;
  }

  // ---- 后台管理（需 admin 权限，后端 requireAdmin 兜底）----
  async function upsertProduct(input) {
    const body = {
      id: input.id || undefined,
      name: input.name,
      category: input.category,
      emoji: (input.img || '').trim() || undefined,
      pricePerShare: Number(input.price),
      totalShares: Number(input.totalShares),
      freeQuota: Number(input.freeQuota),
      pricing: input.pricing,
      desc: input.desc || '',
      gallery: normGallery(input.gallery),
      specs: input.specs || [],
      sourceUrl: input.sourceUrl || '',
    };
    if (!body.name) return { ok: false, msg: '请填写商品名称' };
    if (!body.category) return { ok: false, msg: '请选择类别' };
    if (!Number.isInteger(body.pricePerShare) || body.pricePerShare < 1 || !Number.isInteger(body.totalShares) || body.totalShares < 1)
      return {ok:false,msg:'请填写有效的每份金额及总份数（正整数），未获取价格时请补填后再保存'};
    const r = await post('/admin/products', body);
    if (r.ok) await refreshProducts();
    return { ok: r.ok, msg: r.msg || (r.ok ? '已保存' : '保存失败') };
  }
  // gallery 输入：字符串数组（每行一个 URL）→ [{type,url}]
  function normGallery(g) {
    if (!Array.isArray(g)) return [];
    return g.map(item => {
      if (item && typeof item === 'object' && item.url) return item;
      const url = String(item || '').trim();
      if (!url) return null;
      const type = /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url) ? 'video' : 'image';
      return { type, url };
    }).filter(Boolean);
  }
  async function removeProduct(id) {
    const r = await del('/admin/products/' + id);
    if (r.ok) await refreshProducts();
    return r;
  }
  async function saveConfig(patch) {
    const r = await post('/admin/config', patch);
    if (r.ok && r.config) cache.config = r.config;
    return { ok: r.ok, msg: r.ok ? '规则已保存' : (r.msg || '保存失败') };
  }
  async function addCategory({ name, prefix, icon }) {
    const r = await post('/admin/categories', { name, prefix, icon });
    if (r.ok) await refreshCategories();
    return r;
  }
  async function removeCategory(key) {
    const r = await del('/admin/categories/' + encodeURIComponent(key));
    if (r.ok) await refreshCategories();
    return r;
  }
  async function renameCategory(key, name, icon) {
    const r = await put('/admin/categories/' + encodeURIComponent(key), { name, icon });
    if (r.ok) await refreshCategories();
    return r;
  }
  async function reorderCategories(orderedKeys) {
    const r = await post('/admin/categories/reorder', { keys: orderedKeys });
    if (r.ok) await refreshCategories();
    return r;
  }
  async function importAmazon(url) {
    const r = await post('/admin/import-product', { url });
    return r;
  }

  // ---- 晒单 ----
  async function getApprovedShowcases() {
    const r = await get('/showcase/approved');
    return r.ok ? r.showcases : [];
  }
  async function submitShowcase({ productId, mediaType, mediaUrl, caption }) {
    return await post('/showcase/submit', { productId, mediaType, mediaUrl, caption });
  }
  async function getMyShowcases() {
    const r = await get('/showcase/mine');
    return r.ok ? r.showcases : [];
  }
  async function getPendingShowcases() {
    const r = await get('/showcase/pending');
    return r.ok ? r.showcases : [];
  }
  async function reviewShowcase(id, action) {
    return await post('/showcase/review/' + id, { action });
  }
  async function deleteShowcase(id) {
    return await del('/showcase/' + id);
  }
  async function getShowcase(id) {
    const r = await get('/showcase/' + id);
    return r.ok ? r.showcase : null;
  }
  async function toggleShowcaseLike(id) {
    return await post('/showcase/' + id + '/like', {});
  }

  // ---- 开奖验证 / 续开 ----
  async function verifyProof(pid) {
    const p = getProduct(pid);
    if (!p || !p.proof) return { ok: false, msg: '暂无幸运凭据' };
    // 用 published randomness 在前端独立复算，与后端 draws 记录比对
    try {
      const {verifyProofData}=await import('./proof.js');
      await verifyProofData(p.proof);
      const enc = new TextEncoder();
      const keyData = hexToBytes(p.proof.randomness);
      const key = await crypto.subtle.importKey('raw', keyData,
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const mac = await crypto.subtle.sign('HMAC', key, enc.encode(String(pid)));
      const bytes = new Uint8Array(mac);
      let n = 0n; for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(bytes[i]);
      const recomputed = Number(n % BigInt(p.totalShares)) + 1;
      return {
        ok: recomputed === p.winNumber,
        round: p.proof.round, recomputed, stored: p.winNumber,signatureVerified:true,
      };
    } catch (e) {
      return { ok: false, msg: '验证失败：' + (e.message || '随机源格式异常') };
    }
  }
  function hexToBytes(hex) {
    const clean = String(hex).replace(/[^0-9a-f]/gi, '');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }
  // 续开：让后端把到点的 drawing 商品结算（后端 /wallet/draw）
  async function resumeDraws() {
    if (!cache.user) return;
    const pending = cache.products.filter(p => p.status === 'drawing' &&
      (!p.drawTime || p.drawTime <= Date.now()));
    if (!pending.length) return;
    let changed = false;
    for (const p of pending) {
      const r = await post('/wallet/draw/' + p.id, {});
      if (r && r.ok && r.done) changed = true;
    }
    if (changed) { await refreshProducts(); await refreshWinners(); }
  }

  // ---- 初始化：拉取首屏所需的全部数据 ----
  let _ready = null;
  function init() {
    if (_ready) return _ready;
    _ready = (async () => {
      if(/\/login(?:\.html)?$/.test(location.pathname)){await refreshMe();return;}
      if(/\/detail(?:\.html)?$/.test(location.pathname)){await Promise.all([refreshCategories(),refreshProduct(new URLSearchParams(location.search).get('id')),refreshMe().then(refreshOrders)]);return;}
      await Promise.all([
        refreshCategories(),
        /^\/(?:index(?:\.html)?)?$/.test(location.pathname)?Promise.resolve():refreshProducts(),
        refreshWinners(),
        refreshRecentBuys(),
        refreshConfig(),
        refreshMe().then(() => Promise.all([refreshOrders(), refreshCheckinStatus()])),
      ]);
    })();
    return _ready;
  }

  return {
    init,
    get ready() { return _ready || init(); },
    // 会话/用户
    currentUser, isLoggedIn, totalCoins, canCheckin, refreshMe,
    sendCode, register, login, logout, updateName, recharge, checkin, getPackages, getRechargeStatus,
    // 商品/类别
    listProducts, getProduct, listCategories, categoryOf,
    productFreeUsed, winnersFeed, recentBuys, getConfig, myOrders,
    // 刷新
    refreshProducts, refreshRecentBuys, refreshWinners, refreshProduct, catalog, refreshNotifications,
    notificationProducts:()=>cache.notifications??cache.products,
    errors:()=>Array.from(errors.values()), request:http, paymentMethods:()=>cache.paymentMethods||{}, getRechargeHistory,refreshRecharge,
    // 购买/地址
    buyShares, saveAddress,
    // 后台
    upsertProduct, removeProduct, saveConfig,
    addCategory, removeCategory, renameCategory, reorderCategories, importAmazon,
    // 晒单
    getApprovedShowcases, submitShowcase, getMyShowcases,
    getPendingShowcases, reviewShowcase, deleteShowcase,
    getShowcase, toggleShowcaseLike,
    // 开奖
    verifyProof, resumeDraws,
    // 内部（调试用）
    _cache: cache,
  };
})();

window.Store = Store;

