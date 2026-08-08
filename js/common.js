/* 公共逻辑：初始化、顶栏（含登录态）、toast、工具 */
// 数据层改为异步（后端 API）。页面首屏渲染须等 Store.ready。
// 用法：onReady(() => { renderTopbar(...); ...首屏渲染... })
function onReady(cb) {
  Store.ready.then(async () => {
    try {
      if (Store.resumeDraws) await Store.resumeDraws().catch(() => {});
    } catch (_) {}
    try { cb(); } catch (e) { console.error(e); }
  }).catch(e => { console.error(e); toast('加载失败，请刷新重试'); });
}

// 顶栏渲染。active: home | orders
function renderTopbar(active) {
  const el = document.getElementById('topbar');
  if (!el) return;
  const u = Store.currentUser();

  const right = u ? `
    <div class="wallet">
      充值金币：<b>${u.paidCoins||0}</b> 免费金币：<b>${u.freeCoins||0}</b>
      &nbsp;·&nbsp; <a href="#" id="recharge">充值</a>
      ${Store.canCheckin() ? '&nbsp;·&nbsp; <a href="#" id="checkin">签到领币</a>' : ''}
    </div>
    <div class="wallet">👤 ${u.name}
      &nbsp;·&nbsp; <a href="#" id="logout">退出</a></div>`
    : `<a href="login.html" class="wallet">登录 / 注册</a>`;

  const isAdmin = u && u.isAdmin;
  el.innerHTML = `
    <div class="logo">Lucky&nbsp;Buy <small>幸运购</small></div>
    <nav>
      <a href="index.html" class="${active === 'home' ? 'active' : ''}">全部商品</a>
      <a href="orders.html" class="${active === 'orders' ? 'active' : ''}">我的记录</a>
      ${u ? `<a href="profile.html" class="${active === 'profile' ? 'active' : ''}">个人中心</a>` : ''}
      ${isAdmin ? `<a href="admin.html" class="${active === 'admin' ? 'active' : ''}">后台</a>` : ''}
    </nav>
    <div class="spacer"></div>
    ${right}`;

  const rc = document.getElementById('recharge');
  if (rc) rc.onclick = (e) => { e.preventDefault(); openRecharge(active); };
  const ci = document.getElementById('checkin');
  if (ci) ci.onclick = async (e) => {
    e.preventDefault();
    const r = await Store.checkin(); toast(r.msg); renderTopbar(active);
  };
  const lo = document.getElementById('logout');
  if (lo) lo.onclick = async (e) => {
    e.preventDefault(); await Store.logout(); toast('已退出'); location.href = 'index.html';
  };

  renderMobNav(active, u);
}

// 充值弹窗：填了 Stripe 测试密钥会跳转 Checkout，否则模拟到账
async function openRecharge(active) {
  location.href = 'recharge.html';
}

// 需要登录才能继续；未登录跳转登录页并记住来源
function requireLogin() {
  if (Store.isLoggedIn()) return true;
  toast('请先登录');
  const back = encodeURIComponent(location.pathname.split('/').pop() + location.search);
  setTimeout(() => location.href = 'login.html?back=' + back, 600);
  return false;
}

// 轻提示
let toastTimer;
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast'; t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

function pct(prod) { return Math.min(100, Math.round(prod.soldShares / prod.totalShares * 100)); }
function param(name) { return new URLSearchParams(location.search).get(name); }

function renderMobNav(active, u) {
  let nav = document.getElementById('mob-nav');
  if (!nav) {
    nav = document.createElement('nav');
    nav.id = 'mob-nav';
    nav.className = 'mob-nav';
    document.body.appendChild(nav);
  }
  nav.innerHTML = `
    <a href="index.html" class="${active === 'home' ? 'active' : ''}">
      <span class="nav-icon">🏠</span>首页</a>
    <a href="orders.html" class="${active === 'orders' ? 'active' : ''}">
      <span class="nav-icon">📋</span>记录</a>
    <a href="${u ? 'profile.html' : 'login.html'}" class="${active === 'profile' ? 'active' : ''}">
      <span class="nav-icon">👤</span>${u ? '我的' : '登录'}</a>`;
}
