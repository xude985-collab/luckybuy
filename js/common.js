/* 公共逻辑：初始化、顶栏（含登录态）、toast、工具 */
// 数据层改为异步（后端 API）。页面首屏渲染须等 Store.ready。
// 用法：onReady(() => { renderTopbar(...); ...首屏渲染... })
function onReady(cb) {
  Store.ready.then(async () => {
    try {
      if (Store.resumeDraws) await Store.resumeDraws().catch(() => {});
    } catch (_) {}
    try { cb(); } catch (e) { console.error(e); }
    renderDrawNotification();
    checkUnclaimedWins();
  }).catch(e => { console.error(e); toast('加载失败，请刷新重试'); });
}

// 顶栏渲染。active: home | orders
function renderTopbar(active) {
  const el = document.getElementById('topbar');
  if (!el) return;
  const u = Store.currentUser();
  const isAdmin = u && u.isAdmin;

  // 更新导航激活状态
  const navLinks = el.querySelectorAll('nav a');
  navLinks.forEach(a => {
    const href = a.getAttribute('href');
    if (href === 'index.html') a.className = active === 'home' ? 'active' : '';
    else if (href === 'winners.html') a.className = active === 'winners' ? 'active' : '';
    else if (href === 'orders.html') a.className = active === 'orders' ? 'active' : '';
    else if (href === 'rules.html') a.className = active === 'rules' ? 'active' : '';
    else if (href === 'profile.html') {
      a.className = active === 'profile' ? 'active' : '';
      a.style.display = u ? '' : 'none';
    }
    else if (href === 'admin.html') {
      a.className = active === 'admin' ? 'active' : '';
      a.style.display = isAdmin ? '' : 'none';
    }
  });

  // 更新右侧登录态
  const walletEl = document.getElementById('topbar-wallet');
  const userEl = document.getElementById('topbar-user');
  const loginEl = document.getElementById('topbar-login');

  if (u) {
    if (walletEl) {
      walletEl.innerHTML = `充值：<b>${u.paidCoins||0}</b> 免费：<b>${u.freeCoins||0}</b>
        <span class="recharge-wrap">&nbsp;·&nbsp; <a href="#" id="recharge">充值</a></span>`;
      walletEl.style.display = '';
    }
    if (userEl) {
      userEl.innerHTML = `👤 ${u.name} &nbsp;·&nbsp; <a href="#" id="logout">退出</a>`;
      userEl.style.display = '';
    }
    if (loginEl) loginEl.style.display = 'none';
  } else {
    if (walletEl) walletEl.style.display = 'none';
    if (userEl) userEl.style.display = 'none';
    if (loginEl) loginEl.style.display = '';
  }

  // 绑定事件
  const rc = document.getElementById('recharge');
  if (rc) rc.onclick = (e) => { e.preventDefault(); openRecharge(active); };
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
  const isAdmin = u && u.isAdmin;
  nav.innerHTML = `
    <a href="index.html" class="${active === 'home' ? 'active' : ''}">
      <span class="nav-icon">🏠</span>首页</a>
    <a href="winners.html" class="${active === 'winners' ? 'active' : ''}">
      <span class="nav-icon">🏆</span>幸运区</a>
    <a href="orders.html" class="${active === 'orders' ? 'active' : ''}">
      <span class="nav-icon">📋</span>记录</a>
    <a href="${u ? 'profile.html' : 'login.html'}" class="${active === 'profile' ? 'active' : ''}">
      <span class="nav-icon">👤</span>${u ? '我的' : '登录'}</a>
    ${isAdmin ? `<a href="admin.html" class="${active === 'admin' ? 'active' : ''}">
      <span class="nav-icon">⚙️</span>后台</a>` : ''}`;
}

function renderDrawNotification() {
  const old = document.getElementById('draw-notify-bar');
  if (old) old.remove();
  const me = Store.currentUser();
  if (!me) return;
  const myPids = new Set(Store.myOrders().map(o => o.productId));
  const hits = Store.listProducts().filter(p => p.status === 'drawing' && myPids.has(p.id));
  if (!hits.length) return;
  const p = hits[0];
  let timeText = '正在开奖';
  if (p.drawTime && p.drawTime > Date.now()) {
    const min = Math.ceil((p.drawTime - Date.now()) / 60000);
    timeText = `将在 ${min} 分钟后开奖`;
  }
  const bar = document.createElement('div');
  bar.id = 'draw-notify-bar';
  bar.className = 'draw-notify-bar';
  bar.innerHTML = `<span>🔔 你参与的 <b>${p.name}</b> ${timeText}</span><a href="detail.html?id=${p.id}">去看看 →</a>`;
  const topbar = document.getElementById('topbar');
  if (topbar) topbar.after(bar);
  else document.body.prepend(bar);
}

function checkUnclaimedWins() {
  const me = Store.currentUser();
  if (!me) return;
  const unclaimed = Store.listProducts().filter(
    p => p.status === 'revealed' && p.winnerUserId === me.id && !p.hasAddress
      && !localStorage.getItem('win_dismiss_' + p.id)
  );
  if (!unclaimed.length) return;
  const p = unclaimed[0];
  showWinCelebration(p);
}

function spawnParticles(container) {
  const emojis = ['💰','🪙','💵','🌸','🎉','💎','🧧'];
  for (let i = 0; i < 25; i++) {
    const el = document.createElement('span');
    el.className = 'win-particle';
    el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    el.style.left = Math.random() * 100 + '%';
    el.style.animationDelay = (Math.random() * 2) + 's';
    el.style.animationDuration = (2.5 + Math.random() * 2) + 's';
    el.style.fontSize = (16 + Math.random() * 14) + 'px';
    container.appendChild(el);
  }
}

function showWinCelebration(p) {
  const mask = document.createElement('div');
  mask.className = 'win-celebrate-mask';
  mask.innerHTML = `
    <div class="win-celebrate">
      <div class="win-confetti"></div>
      <div class="win-trophy">🏆</div>
      <div class="win-title">恭喜成为幸运儿！</div>
      <div class="win-product">${p.img || '🎁'} ${p.name}</div>
      <div class="win-lucky">幸运号码 <b>${p.winNumber}</b></div>
      <div class="win-msg">请填写收货信息，我们将尽快安排发货</div>
      <div class="win-form">
        <input id="wf-name" placeholder="收件人姓名">
        <input id="wf-phone" placeholder="联系电话">
        <input id="wf-country" placeholder="国家/地区（可选）">
        <textarea id="wf-address" placeholder="详细收货地址" rows="2"></textarea>
      </div>
      <button class="btn" id="wf-submit" style="width:100%;margin-top:12px">提交收货地址</button>
      <div class="win-later-row">
        <label class="win-dismiss-label"><input type="checkbox" id="wf-dismiss"> 不再提醒此商品</label>
        <a href="#" class="win-later" id="wf-later">稍后填写</a>
      </div>
    </div>`;
  document.body.appendChild(mask);
  spawnParticles(mask);
  setTimeout(() => mask.classList.add('show'), 50);

  mask.querySelector('#wf-later').onclick = (e) => {
    e.preventDefault();
    if (mask.querySelector('#wf-dismiss').checked) {
      localStorage.setItem('win_dismiss_' + p.id, '1');
    }
    mask.remove();
  };
  mask.querySelector('#wf-submit').onclick = async () => {
    const name = mask.querySelector('#wf-name').value.trim();
    const phone = mask.querySelector('#wf-phone').value.trim();
    const address = mask.querySelector('#wf-address').value.trim();
    const country = mask.querySelector('#wf-country').value.trim();
    if (!name || !address) { toast('请填写收件人和地址'); return; }
    const btn = mask.querySelector('#wf-submit');
    btn.disabled = true; btn.textContent = '提交中…';
    const r = await Store.saveAddress(p.id, { name, phone, address, country });
    if (r.ok) {
      toast('收货地址已提交 ✓');
      mask.remove();
      await Store.refreshProducts();
    } else {
      toast(r.msg || '提交失败');
      btn.disabled = false; btn.textContent = '提交收货地址';
    }
  };
}
