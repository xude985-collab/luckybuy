/* 后台管理：上架 / 编辑 / 下架商品 —— 仅管理员可见，后端同样校验 is_admin */
let editingId = null;

function renderList() {
  const box = document.getElementById('admin-list');
  const list = Store.listProducts();
  if (!list.length) { box.innerHTML = '<div class="empty">还没有商品，先在右侧添加。</div>'; return; }
  const rows = list.map(p => {
    const done = p.status === 'revealed';
    const drawing = p.status === 'drawing';
    const state = done ? '已开奖 (号 ' + p.winNumber + ')' : drawing ? '开奖中' : '进行中';
    const cat = Store.categoryOf(p.category);
    return `<tr>
      <td><code class="sku">${p.sku || '—'}</code></td>
      <td>${p.img} ${p.name}</td>
      <td>${cat.name}</td>
      <td>$${p.price}</td>
      <td>${p.soldShares}/${p.totalShares}</td>
      <td>🪙 ${Store.productFreeUsed(p.id)}/${p.freeQuota || 0}</td>
      <td>${state}</td>
      <td>
        <button class="btn ghost" style="padding:4px 10px;font-size:12px" onclick="editProd('${p.id}')">编辑</button>
        <button class="btn ghost" style="padding:4px 10px;font-size:12px" onclick="delProd('${p.id}')">下架</button>
      </td>
    </tr>`;
  }).join('');
  box.innerHTML = `<table>
    <thead><tr><th>编号</th><th>商品</th><th>类别</th><th>单价</th><th>进度</th><th>免费额度</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
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
    // 编辑：类别与编号不可改，下拉锁定并展示已生成编号
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
  document.getElementById('f-gallery').value =
    p && p.gallery ? p.gallery.map(m => m.url).join('\n') : '';
  document.getElementById('f-specs').value =
    p && p.specs ? p.specs.map(r => `${r.k}=${r.v}`).join('\n') : '';
  document.getElementById('form-title').textContent = p ? '编辑商品' : '上架新商品';
  document.getElementById('cancel-edit').style.display = p ? 'inline-block' : 'none';
}

function editProd(id) {
  editingId = id;
  fieldsFrom(Store.getProduct(id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function cancelEdit() { editingId = null; fieldsFrom(null); }

async function delProd(id) {
  if (!confirm('确定下架该商品？已产生的订单不受影响。')) return;
  const r = await Store.removeProduct(id);
  toast((r && r.msg) || '已下架');
  if (editingId === id) cancelEdit();
  renderList();
}

async function save() {
  const input = {
    id: editingId,
    category: document.getElementById('f-category').value,
    name: document.getElementById('f-name').value,
    price: document.getElementById('f-price').value,
    totalShares: document.getElementById('f-total').value,
    freeQuota: document.getElementById('f-free').value,
    img: document.getElementById('f-img').value.trim(),
    period: document.getElementById('f-period').value.trim(),
    desc: document.getElementById('f-desc').value.trim(),
    sourceUrl: document.getElementById('f-source').value.trim(),
    gallery: parseLines(document.getElementById('f-gallery').value),
    specs: parseSpecLines(document.getElementById('f-specs').value),
  };
  const r = await Store.upsertProduct(input);
  toast(r.msg);
  if (r.ok) { editingId = null; fieldsFrom(null); renderList(); }
}

// 文本框每行一个 URL → gallery 数组
function parseLines(text) {
  return (text || '').split('\n').map(s => s.trim()).filter(Boolean);
}
// 文本框每行 键=值 → specs 数组
function parseSpecLines(text) {
  return (text || '').split('\n').map(line => {
    const i = line.indexOf('=');
    if (i < 0) return null;
    return { k: line.slice(0, i).trim(), v: line.slice(i + 1).trim() };
  }).filter(r => r && (r.k || r.v));
}

// 从亚马逊链接自动导入（需后端服务；未开启时提示手动填写）
async function importFromAmazon() {
  const url = document.getElementById('f-source').value.trim();
  if (!url) { toast('请先粘贴亚马逊商品链接'); return; }
  const btn = document.getElementById('amz-btn');
  btn.disabled = true; btn.textContent = '导入中…';
  try {
    const resp = await Store.importAmazon(url);
    if (!resp || !resp.ok) throw new Error((resp && resp.msg) || '导入失败');
    const d = resp.draft; // 后端返回 {ok, draft:{name,desc,gallery:[{type,url}],bullets,refPrice,...}}
    if (d.name) document.getElementById('f-name').value = d.name;
    // 描述优先用 bullets,fallback desc
    const descText = Array.isArray(d.bullets) && d.bullets.length
      ? d.bullets.map((b,i)=>`${i+1}. ${b}`).join('\n')
      : (d.desc || '');
    if (descText) document.getElementById('f-desc').value = descText;
    if (d.refPrice && d.refPrice > 0) document.getElementById('f-price').value = d.refPrice;
    // gallery 是 [{type,url}],取 url
    const urls = Array.isArray(d.gallery) ? d.gallery.map(g=>g.url).filter(Boolean) : [];
    if (urls.length) document.getElementById('f-gallery').value = urls.join('\n');
    if (Array.isArray(d.specs) && d.specs.length)
      document.getElementById('f-specs').value = d.specs.map(r => `${r.k}=${r.v}`).join('\n');
    // sourceUrl 自动填回原链接
    document.getElementById('f-source').value = d.sourceUrl || url;
    toast('✓ 已导入，请选择分类、价格后保存');
  } catch (e) {
    toast('自动导入需后端服务，暂未开启，请手动填写');
  } finally {
    btn.disabled = false; btn.textContent = '自动导入';
  }
}

function loadRules() {
  const c = Store.getConfig();
  document.getElementById('r-register').value = c.grantRegister;
  document.getElementById('r-checkin').value = c.grantCheckin;
  document.getElementById('r-showcase').value = c.grantShowcase;
}
async function saveRules() {
  await Store.saveConfig({
    grantRegister: Math.max(0, parseInt(document.getElementById('r-register').value, 10) || 0),
    grantCheckin: Math.max(0, parseInt(document.getElementById('r-checkin').value, 10) || 0),
    grantShowcase: Math.max(0, parseInt(document.getElementById('r-showcase').value, 10) || 0),
  });
  toast('规则已保存');
}

/* ---- 类别管理 ---- */
function renderCats() {
  const box = document.getElementById('cat-list');
  const cats = Store.listCategories();
  const counts = {};
  Store.listProducts().forEach(p => { const k = p.category || 'other'; counts[k] = (counts[k] || 0) + 1; });
  box.innerHTML = cats.map(c => {
    const n = counts[c.key] || 0;
    const lock = n > 0;
    return `<div class="cat-chip">
      <span>${c.icon} ${c.name} <em>${c.prefix}</em>${n ? ` · ${n}件` : ''}</span>
      <button title="${lock ? '有商品占用，不能删除' : '删除'}" ${lock ? 'disabled' : ''}
        onclick="delCat('${c.key}')">✕</button>
    </div>`;
  }).join('');
}
async function addCat() {
  const r = await Store.addCategory({
    name: document.getElementById('c-name').value,
    prefix: document.getElementById('c-prefix').value,
    icon: document.getElementById('c-icon').value,
  });
  toast(r.msg);
  if (r.ok) {
    ['c-name', 'c-prefix', 'c-icon'].forEach(id => document.getElementById(id).value = '');
    renderCats();
    fillCategoryOptions();
  }
}
async function delCat(key) {
  const r = await Store.removeCategory(key);
  toast(r.msg);
  if (r.ok) { renderCats(); fillCategoryOptions(); }
}

/* ---- 充值套餐管理 ---- */
let pkgList = [];

async function loadPkgs() {
  pkgList = await Store.getPackages();
  renderPkgs();
}

function renderPkgs() {
  const box = document.getElementById('pkg-list');
  if (!pkgList.length) { box.innerHTML = '<div style="color:var(--muted);font-size:13px">暂无套餐</div>'; return; }
  box.innerHTML = pkgList.map((p, i) => `
    <div class="cat-chip">
      <span>$${p.amount}${p.bonus > 0 ? ` <em>送${p.bonus}</em>` : ''}</span>
      <button onclick="removePkg(${i})">✕</button>
    </div>`).join('');
}

function addPkg() {
  const amount = parseInt(document.getElementById('pkg-amount').value) || 0;
  const bonus = parseInt(document.getElementById('pkg-bonus').value) || 0;
  if (amount < 1) { toast('请填写有效金额'); return; }
  if (pkgList.some(p => p.amount === amount)) { toast('该金额已存在'); return; }
  pkgList.push({ amount, bonus });
  pkgList.sort((a, b) => a.amount - b.amount);
  document.getElementById('pkg-amount').value = '';
  document.getElementById('pkg-bonus').value = '';
  renderPkgs();
}

function removePkg(i) {
  pkgList.splice(i, 1);
  renderPkgs();
}

async function savePkgs() {
  const r = await Store.saveConfig({ recharge_packages: pkgList });
  toast(r.msg || '套餐已保存');
}

onReady(() => {
  // 权限守卫：非管理员不得进入后台
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
  fillCategoryOptions();
  fieldsFrom(null);
  renderList();
  loadRules();
  renderCats();
  loadPkgs();
});
