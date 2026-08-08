/* js/admin.js — tabbed admin panel */
let editingId = null;
let allUsers = [];
let pkgList = [];

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function v(id) { return document.getElementById(id).value.trim(); }

// ========== Tab switching ==========
function initTabs() {
  document.querySelectorAll('.admin-tabs .tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.admin-tabs .tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });
}

// ========== Dashboard ==========
async function loadDashboard() {
  try {
    const r = await fetch('/api/admin/overview');
    const d = await r.json();
    if (!d.ok) return;
    document.getElementById('stat-users').textContent = d.stats.users;
    document.getElementById('stat-products').textContent = d.stats.products;
    document.getElementById('stat-orders').textContent = d.stats.orders;
    document.getElementById('stat-revenue').textContent = d.stats.revenue;
    loadRecentOrders();
  } catch (e) { console.error(e); }
}

async function loadRecentOrders() {
  try {
    const r = await fetch('/api/admin/recent-orders');
    const d = await r.json();
    const el = document.getElementById('recent-orders');
    if (!d.ok || !d.orders || !d.orders.length) { el.innerHTML = '<div class="empty">暂无订单</div>'; return; }
    let html = '<table class="orders-table"><tr><th>用户</th><th>商品</th><th>份数</th><th>金币</th><th>时间</th></tr>';
    d.orders.forEach(o => {
      const t = new Date(Number(o.created_at)).toLocaleString('zh-CN');
      html += `<tr><td>${esc(o.account||'')}</td><td>${esc(o.product_name||'')}</td><td>${o.shares}</td><td>${o.paid_coins}</td><td>${t}</td></tr>`;
    });
    el.innerHTML = html + '</table>';
  } catch (e) {
    document.getElementById('recent-orders').innerHTML = '<div class="empty">加载失败</div>';
  }
}

// ========== Products ==========
async function loadProducts() {
  const list = Store.listProducts();
  renderProductList(list);
}

function renderProductList(list) {
  const el = document.getElementById('admin-list');
  if (!list.length) { el.innerHTML = '<div class="empty">暂无商品，请在左侧添加</div>'; return; }
  let html = '<table class="orders-table"><tr><th>SKU</th><th>商品</th><th>单价</th><th>进度</th><th>状态</th><th>操作</th></tr>';
  list.forEach(p => {
    const sold = p.soldShares || 0;
    const pct = p.totalShares ? Math.round(sold / p.totalShares * 100) : 0;
    const state = p.status === 'revealed' ? '已揭晓' : p.status === 'drawing' ? '揭晓中' : '进行中';
    html += `<tr>
      <td>${esc(p.sku||'—')}</td>
      <td>${p.img||''} ${esc(p.name)}</td>
      <td>$${p.price}×${p.totalShares}</td>
      <td>${sold}/${p.totalShares} (${pct}%)</td>
      <td>${state}</td>
      <td><a href="#" onclick="editProd('${p.id}');return false">编辑</a> · <a href="#" onclick="delProd('${p.id}');return false" style="color:#c00">删除</a></td>
    </tr>`;
  });
  el.innerHTML = html + '</table>';
}

function fillCategoryOptions() {
  const sel = document.getElementById('f-category');
  sel.innerHTML = Store.listCategories()
    .map(c => `<option value="${c.key}">${c.icon} ${c.name}（${c.prefix}）</option>`)
    .join('');
}

function fieldsFrom(p) {
  const sel = document.getElementById('f-category');
  const skuBox = document.getElementById('sku-readonly');
  if (p) {
    sel.value = p.category || 'other';
    sel.disabled = true;
    document.getElementById('sku-value').textContent = p.sku || '—';
    skuBox.style.display = 'block';
  } else {
    sel.disabled = false;
    skuBox.style.display = 'none';
  }
  document.getElementById('f-name').value = p ? p.name : '';
  document.getElementById('f-price').value = p ? p.price : '';
  document.getElementById('f-total').value = p ? p.totalShares : '';
  document.getElementById('f-free').value = p ? (p.freeQuota || 0) : '0';
  document.getElementById('f-img').value = p ? (p.img || '') : '';
  document.getElementById('f-period').value = p ? p.period : '第 001 期';
  document.getElementById('f-desc').value = p ? (p.desc || '') : '';
  document.getElementById('f-source').value = p ? (p.sourceUrl || '') : '';
  document.getElementById('f-gallery').value = p && p.gallery ? p.gallery.map(m => typeof m === 'string' ? m : m.url).join('\n') : '';
  document.getElementById('f-specs').value = p && p.specs ? p.specs.map(r => `${r.k}=${r.v}`).join('\n') : '';
  document.getElementById('form-title').textContent = p ? '编辑商品' : '上架新商品';
  document.getElementById('cancel-edit').style.display = p ? 'inline-block' : 'none';
}

function editProd(id) {
  editingId = id;
  fieldsFrom(Store.getProduct(id));
  document.querySelector('[data-tab="products"]').click();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function cancelEdit() {
  editingId = null;
  fieldsFrom(null);
  document.getElementById('multiplier-row').style.display = 'none';
}

async function delProd(id) {
  if (!confirm('确定下架该商品？已产生的订单不受影响。')) return;
  const r = await Store.removeProduct(id);
  toast((r && r.msg) || '已下架');
  if (editingId === id) cancelEdit();
  loadProducts();
}

async function save() {
  const input = {
    id: editingId,
    category: v('f-category'),
    name: v('f-name'),
    price: v('f-price'),
    totalShares: v('f-total'),
    freeQuota: v('f-free'),
    img: v('f-img'),
    period: v('f-period'),
    desc: v('f-desc'),
    sourceUrl: v('f-source'),
    gallery: v('f-gallery').split('\n').map(s => s.trim()).filter(Boolean),
    specs: v('f-specs').split('\n').map(line => {
      const i = line.indexOf('=');
      if (i < 0) return null;
      return { k: line.slice(0, i).trim(), v: line.slice(i + 1).trim() };
    }).filter(Boolean),
  };
  if (!input.name) { toast('请填写商品名称'); return; }
  const r = await Store.upsertProduct(input);
  toast(r.msg);
  if (r.ok) { cancelEdit(); loadProducts(); loadDashboard(); }
}

async function importProduct() {
  const url = v('f-source');
  if (!url) { toast('请先粘贴商品链接'); return; }
  const btn = document.getElementById('amz-btn');
  btn.disabled = true; btn.textContent = '导入中…';
  try {
    const resp = await Store.importAmazon(url);
    if (!resp || !resp.ok) throw new Error((resp && resp.msg) || '导入失败');
    const d = resp.draft;
    if (d.name) document.getElementById('f-name').value = d.name;
    const descText = Array.isArray(d.bullets) && d.bullets.length
      ? d.bullets.map((b, i) => `${i+1}. ${b}`).join('\n') : (d.desc || '');
    if (descText) document.getElementById('f-desc').value = descText;
    if (d.refPrice && d.refPrice > 0) {
      document.getElementById('f-price').value = 1;
      document.getElementById('base-price').textContent = d.refPrice;
      document.getElementById('multiplier-row').style.display = 'block';
      document.getElementById('f-multiplier').value = '1.5';
      document.getElementById('f-per-share').value = '1';
      const result = Math.round(d.refPrice * 1.5 / 1);
      document.getElementById('f-total').value = result;
      document.getElementById('multi-result').textContent = `= ${result} 份`;
    }
    const urls = Array.isArray(d.gallery) ? d.gallery.map(g => g.url).filter(Boolean) : [];
    if (urls.length) document.getElementById('f-gallery').value = urls.join('\n');
    if (Array.isArray(d.specs) && d.specs.length)
      document.getElementById('f-specs').value = d.specs.map(r => `${r.k}=${r.v}`).join('\n');
    document.getElementById('f-source').value = d.sourceUrl || url;
    toast('已导入，请检查后保存');
  } catch (e) { toast(e.message || '导入失败'); }
  finally { btn.disabled = false; btn.textContent = '自动导入'; }
}

function applyMultiplier() {
  const price = parseFloat(document.getElementById('base-price').textContent) || 0;
  const mult = parseFloat(document.getElementById('f-multiplier').value) || 1;
  const perShare = parseFloat(document.getElementById('f-per-share').value) || 1;
  const result = Math.round(price * mult / perShare);
  document.getElementById('f-total').value = result;
  document.getElementById('f-price').value = perShare;
  document.getElementById('multi-result').textContent = `= ${result} 份`;
}

// ========== Users ==========
async function loadUsers() {
  try {
    const r = await fetch('/api/admin/users');
    const d = await r.json();
    if (d.ok) { allUsers = d.users; renderUsers(allUsers); }
  } catch (e) { console.error(e); }
}

function searchUsers() {
  const q = v('user-search').toLowerCase();
  const filtered = q ? allUsers.filter(u => (u.account||'').toLowerCase().includes(q) || (u.name||'').toLowerCase().includes(q)) : allUsers;
  renderUsers(filtered);
}

function renderUsers(users) {
  document.getElementById('user-count').textContent = `共 ${users.length} 人`;
  const el = document.getElementById('user-list');
  if (!users.length) { el.innerHTML = '<div class="empty">无匹配用户</div>'; return; }
  let html = '<table class="user-table"><tr><th>账号</th><th>昵称</th><th>角色</th><th>余额(金币)</th><th>注册时间</th></tr>';
  users.forEach(u => {
    const t = new Date(Number(u.created_at)).toLocaleDateString('zh-CN');
    const role = u.role === 'admin' ? '<span class="role-admin">管理员</span>' : '用户';
    html += `<tr><td>${esc(u.account)}</td><td>${esc(u.name||'—')}</td><td>${role}</td><td>${u.paid_balance||0}</td><td>${t}</td></tr>`;
  });
  el.innerHTML = html + '</table>';
}

// ========== Settings: Rules ==========
function loadRules() {
  const c = Store.getConfig();
  document.getElementById('r-register').value = c.grantRegister || 0;
  document.getElementById('r-checkin').value = c.grantCheckin || 0;
  document.getElementById('r-showcase').value = c.grantShowcase || 0;
  document.getElementById('r-invitee').value = c.grantInvitee || 0;
  document.getElementById('r-inviter').value = c.grantInviter || 0;
}

async function saveRules() {
  await Store.saveConfig({
    grantRegister: Math.max(0, parseInt(v('r-register')) || 0),
    grantCheckin: Math.max(0, parseInt(v('r-checkin')) || 0),
    grantShowcase: Math.max(0, parseInt(v('r-showcase')) || 0),
    grantInvitee: Math.max(0, parseInt(v('r-invitee')) || 0),
    grantInviter: Math.max(0, parseInt(v('r-inviter')) || 0),
  });
  toast('规则已保存');
}

// ========== Settings: Categories ==========
function renderCats() {
  const box = document.getElementById('cat-list');
  const cats = Store.listCategories();
  box.innerHTML = cats.map(c => {
    return `<div class="cat-item"><span>${c.icon} ${c.name} <small style="color:#888">${c.prefix}</small></span><span class="del" onclick="delCat('${c.key}')">删除</span></div>`;
  }).join('');
}

async function addCat() {
  const name = v('cat-name');
  const prefix = v('cat-prefix');
  const icon = v('cat-icon') || '🏷️';
  if (!name || !prefix) { toast('请填写名称和前缀'); return; }
  const r = await Store.addCategory({ name, prefix, icon });
  toast(r.msg || (r.ok ? '已添加' : '添加失败'));
  if (r.ok) {
    document.getElementById('cat-name').value = '';
    document.getElementById('cat-prefix').value = '';
    document.getElementById('cat-icon').value = '🏷️';
    renderCats(); fillCategoryOptions();
  }
}

async function delCat(key) {
  if (!confirm('确定删除该类别？')) return;
  const r = await Store.removeCategory(key);
  toast(r.msg);
  if (r.ok) { renderCats(); fillCategoryOptions(); }
}

// ========== Settings: Recharge Packages ==========
async function loadPkgs() {
  pkgList = await Store.getPackages();
  renderPkgs();
}

function renderPkgs() {
  const box = document.getElementById('pkg-list');
  if (!pkgList.length) { box.innerHTML = '<div class="empty">暂无套餐</div>'; return; }
  box.innerHTML = pkgList.map((p, i) => `<div class="pkg-item"><span>$${p.amount} → ${p.amount + (p.bonus||0)} 金币${p.bonus ? ' (送'+p.bonus+')' : ''}</span><span class="del" onclick="removePkg(${i})">删除</span></div>`).join('');
}

function addPkg() {
  const pay = parseInt(v('pkg-pay')) || 0;
  const coins = parseInt(v('pkg-coins')) || 0;
  if (pay < 1 || coins < 1) { toast('请填写有效的付款金额和到账金币'); return; }
  if (pkgList.some(p => p.amount === pay)) { toast('该金额已存在'); return; }
  const bonus = coins > pay ? coins - pay : 0;
  pkgList.push({ amount: pay, bonus });
  pkgList.sort((a, b) => a.amount - b.amount);
  document.getElementById('pkg-pay').value = '';
  document.getElementById('pkg-coins').value = '';
  renderPkgs();
}

function removePkg(i) { pkgList.splice(i, 1); renderPkgs(); }

async function savePkgs() {
  await Store.saveConfig({ recharge_packages: pkgList });
  toast('套餐已保存');
}

// ========== Showcase Review ==========
async function loadShowcases() {
  const el = document.getElementById('showcase-pending');
  try {
    const list = await Store.getPendingShowcases();
    if (!list.length) { el.innerHTML = '<div class="empty">暂无待审核晒单</div>'; return; }
    el.innerHTML = list.map(s => {
      const media = s.media_type === 'video'
        ? `<video src="${s.media_url}" style="max-width:200px;max-height:150px;border-radius:8px" controls></video>`
        : `<img src="${s.media_url}" style="max-width:200px;max-height:150px;border-radius:8px;object-fit:cover">`;
      const t = new Date(Number(s.created_at)).toLocaleString('zh-CN');
      return `<div style="display:flex;gap:16px;align-items:center;padding:16px;background:#f8f9fa;border-radius:12px;margin-bottom:12px">
        ${media}
        <div style="flex:1">
          <div style="font-weight:600">${s.emoji||'🎁'} ${esc(s.product_name||'')}</div>
          <div style="font-size:13px;color:#888;margin-top:4px">用户: ${esc(s.account||'')} (${esc(s.user_name||'')})</div>
          <div style="font-size:13px;color:#888">${esc(s.caption||'')}</div>
          <div style="font-size:12px;color:#aaa;margin-top:4px">${t}</div>
        </div>
        <div style="display:flex;gap:8px;flex:none">
          <button class="btn sm" onclick="reviewSC('${s.id}','approve')">通过</button>
          <button class="btn ghost sm" onclick="reviewSC('${s.id}','reject')" style="color:#c00;border-color:#c00">拒绝</button>
        </div>
      </div>`;
    }).join('');
  } catch (e) { el.innerHTML = '<div class="empty">加载失败</div>'; }
}

async function reviewSC(id, action) {
  const r = await Store.reviewShowcase(id, action);
  toast(r.msg || (r.ok ? '操作成功' : '操作失败'));
  if (r.ok) loadShowcases();
}

// ========== Saleyee Cookie ==========
async function loadSyCookie() {
  try {
    const r = await fetch('/api/admin/saleyee-cookie');
    const d = await r.json();
    const el = document.getElementById('sy-cookie-status');
    if (d.ok && d.hasCookie) {
      el.innerHTML = `<span style="color:var(--ok)">✓ 已配置</span> <small style="color:#888">${d.preview}</small>`;
    } else {
      el.innerHTML = '<span style="color:#c00">未配置Cookie，导入赛盈商品前请先设置</span>';
    }
  } catch (e) {}
}

async function saveSyCookie() {
  const cookie = document.getElementById('sy-cookie').value.trim();
  if (!cookie) { toast('请粘贴Cookie内容'); return; }
  try {
    const r = await fetch('/api/admin/saleyee-cookie', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie }),
    });
    const d = await r.json();
    toast(d.msg || (d.ok ? '保存成功' : '保存失败'));
    if (d.ok) {
      document.getElementById('sy-cookie').value = '';
      loadSyCookie();
    }
  } catch (e) { toast('保存失败'); }
}

// ========== Init ==========
onReady(() => {
  const u = Store.currentUser();
  if (!u || !u.isAdmin) {
    document.body.innerHTML =
      '<div class="empty" style="padding:80px 20px;text-align:center">' +
      '⛔ 此页面仅管理员可访问。<br><br>' +
      '<a href="login.html?back=admin.html" style="color:#ff5722">用管理员账号登录</a> 或 ' +
      '<a href="index.html" style="color:#ff5722">返回首页</a></div>';
    return;
  }
  renderTopbar('admin');
  initTabs();
  // Dashboard
  loadDashboard();
  // Products
  fillCategoryOptions();
  fieldsFrom(null);
  loadProducts();
  // Users
  loadUsers();
  // Showcase
  loadShowcases();
  // Settings
  loadRules();
  renderCats();
  loadPkgs();
  loadSyCookie();
});


