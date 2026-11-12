/* js/admin.js — tabbed admin panel */
let editingId = null;
let allUsers = [];
let pkgList = [];

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function v(id) { return document.getElementById(id).value.trim(); }

// ========== Tab switching ==========
const loadedTabs=new Set(['overview']);
function initTabs() {
  document.querySelectorAll('.admin-tabs .tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.admin-tabs .tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      const key=btn.dataset.tab;
      if(!loadedTabs.has(key)){loadedTabs.add(key);if(key==='users')loadUsers();if(key==='showcase')loadShowcases();if(key==='wins')loadWins();if(key==='settings'){loadPkgs();loadSystemStatus();loadAudit();}}
    });
  });
}

// ========== Dashboard ==========
async function loadDashboard() {
  try {
    const r = await adminFetch('/api/admin/overview');
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
    const r = await adminFetch('/api/admin/recent-orders');
    const d = await r.json();
    const el = document.getElementById('recent-orders');
    if (!d.ok || !d.orders || !d.orders.length) { el.innerHTML = '<div class="empty">暂无订单</div>'; return; }

    let html = '<table class="orders-table"><tr><th>用户</th><th>商品</th><th>份数</th><th>充值金币</th><th>免费金币</th><th>时间</th></tr>';
    d.orders.forEach(o => {
      const t = new Date(Number(o.created_at)).toLocaleString('zh-CN');
      html += `<tr><td>${esc(o.account||'')}</td><td>${esc(o.product_name||'')}</td><td>${o.shares}</td><td>${o.paid_coins||0}</td><td>${o.free_coins||0}</td><td>${t}</td></tr>`;
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
      <td>${escapeHtml(p.img||'')} ${esc(p.name)}</td>
      <td>$${p.price}/份<br>总 ${p.totalShares} 份<br>${p.freeQuota > 0 ? `免费 ${p.freeQuota} 份` : '免费额度不限'}${!p.pricing?.referencePrice ? '<br><small>参考价未保存，请核对份数</small>' : ''}</td>
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
    .map(c => `<option value="${c.key}">${escapeHtml(c.icon)} ${escapeHtml(c.name)}（${c.prefix}）</option>`)
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
  document.getElementById('multiplier-row').style.display = 'block';
  document.getElementById('base-price').value = p?.pricing?.referencePrice || '';
  document.getElementById('f-multiplier').value = p?.pricing?.multiplier || 1.5;
  document.getElementById('f-per-share').value = p?.price || 1;
  document.getElementById('f-free-ratio').value = p?.pricing?.freeRatio ?? '';
  document.getElementById('free-ratio-note').textContent = '改比例自动算免费份数；改免费份数自动反算比例。0份表示不限。';
  if (p && p.pricing?.freeRatio == null) inferFreeRatio();
  document.getElementById('price-import-note').textContent = '总份数 = 参考价 × 倍数 ÷ 每份金额，按原规则四舍五入。';
  document.getElementById('multi-result').textContent = '';
  bindMultiplierAuto();
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
  document.getElementById('multiplier-row').style.display = 'block';
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
    pricing: {referencePrice: Number(v('base-price')) || null, multiplier: Number(v('f-multiplier')), freeRatio: v('f-free-ratio') === '' ? null : Number(v('f-free-ratio'))},
    gallery: v('f-gallery').split('\n').map(s => s.trim()).filter(Boolean),
    specs: v('f-specs').split('\n').map(line => {
      const i = line.indexOf('=');
      if (i < 0) return null;
      return { k: line.slice(0, i).trim(), v: line.slice(i + 1).trim() };
    }).filter(Boolean),
  };
  if (!input.name) { toast('请填写商品名称'); return; }
  if (input.pricing.freeRatio != null && (!syncFreeQuota() || Number(v('f-free')) < 1)) {
    toast('免费比例计算结果须至少1份；0在原规则中表示不限，不能作为0%保存'); return;
  }
  input.freeQuota = v('f-free');
  const r = await Store.upsertProduct(input);
  toast(r.msg);
  if (r.ok) { cancelEdit(); loadProducts(); loadDashboard(); }
}

function clearSourceLink() {
  const input = document.getElementById('f-source');
  input.value = '';
  input.focus();
}

async function importProduct() {
  const url = v('f-source');
  if (!url) { toast('请先粘贴商品链接'); return; }
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url);
    if (/^(www\.)?amazon\./i.test(parsed.hostname) &&
        !/\/(?:dp|gp\/product|gp\/aw\/d)\/[A-Z0-9]{10}(?:[/?#]|$)/i.test(parsed.pathname) &&
        !/^[A-Z0-9]{10}$/i.test(parsed.searchParams.get('asin') || '')) {
      toast('请先点开具体商品，再复制含 /dp/商品编号 的详情页链接；搜索或分类列表页不能导入单件商品。');
      return;
    }
  } catch (_) { toast('商品链接格式不正确，请复制完整的商品详情页地址'); return; }
  const btn = document.getElementById('amz-btn');
  const clearBtn = document.getElementById('clear-source-btn');
  clearBtn.disabled = true;
  btn.disabled = true; btn.textContent = '导入中…';
  try {
    const resp = await Store.importAmazon(url);
    if (!resp || !resp.ok) throw new Error((resp && resp.msg) || '导入失败');
    applyDraft(resp.draft, url);
    const msg = resp.draft.priceNote
      ? '已导入。' + resp.draft.priceNote
      : '已导入，请检查后保存';
    toast(msg);
  } catch (e) {
    toast(e.message || '导入失败');
  }
  finally { btn.disabled = false; clearBtn.disabled = false; btn.textContent = '自动导入'; }
}


function applyDraft(d, url) {
  if (d.name) document.getElementById('f-name').value = d.name;
  const descText = Array.isArray(d.bullets) && d.bullets.length
    ? d.bullets.map((b, i) => `${i+1}. ${b}`).join('\n') : (d.desc || '');
  if (descText) document.getElementById('f-desc').value = descText;
  const hasPrice = Number.isFinite(Number(d.refPrice)) && Number(d.refPrice) > 0;
  document.getElementById('f-price').value = 1;
  document.getElementById('base-price').value = hasPrice ? d.refPrice : '';
  document.getElementById('multiplier-row').style.display = 'block';
  document.getElementById('f-multiplier').value = '1.5';
  document.getElementById('f-per-share').value = '1';
  document.getElementById('price-import-note').textContent = hasPrice
    ? '已获取参考价，请核对商品售价。按原规则：参考价 × 1.5 ÷ 每份金额，四舍五入。'
    : (d.priceNote || '未获取到商品价格，请补填美元参考价以自动计算，或手动填写总份数。');
  bindMultiplierAuto();
  applyMultiplier();
  const urls = Array.isArray(d.gallery) ? d.gallery.map(g => g.url).filter(Boolean) : [];
  if (urls.length) document.getElementById('f-gallery').value = urls.join('\n');
  if (Array.isArray(d.specs) && d.specs.length)
    document.getElementById('f-specs').value = d.specs.map(r => `${r.k}=${r.v}`).join('\n');
  document.getElementById('f-source').value = d.sourceUrl || url;
}

function applyMultiplier() {
  const price = Number(document.getElementById('base-price').value);
  const mult = Number(document.getElementById('f-multiplier').value);
  const perShare = Number(document.getElementById('f-per-share').value);
  if (!(price > 0 && mult > 0 && Number.isInteger(perShare) && perShare >= 1)) {
    document.getElementById('f-total').value = '';
    document.getElementById('multi-result').textContent = '待填写有效参考价及每份金额';
    syncFreeQuota();
    return;
  }
  const result = Math.max(1, Math.round(Math.round(price * mult * 100) / (perShare * 100)));
  document.getElementById('f-total').value = result;
  document.getElementById('f-price').value = perShare;
  document.getElementById('multi-result').textContent = `= ${result} 份`;
  syncFreeQuota();
}

function syncFreeQuota() {
  const raw = v('f-free-ratio');
  if (raw === '') return true;
  const ratio = Number(raw), total = Number(v('f-total'));
  if (!(ratio > 0 && ratio <= 100 && Number.isInteger(total) && total > 0)) {
    document.getElementById('f-free').value = '';
    document.getElementById('free-ratio-note').textContent = '请填写有效总份数及大于0、不超过100的比例'; return false;
  }
  const count = Math.round(total * ratio / 100);
  document.getElementById('f-free').value = count || '';
  document.getElementById('free-ratio-note').textContent = count ? `${total}份 × ${ratio}% = ${count}免费份` : '计算不足1份，请调整比例；0表示不限，不能混用。';
  return count > 0;
}

function inferFreeRatio() {
  const quota=Number(v('f-free')),total=Number(v('f-total'));
  const input=document.getElementById('f-free-ratio'),note=document.getElementById('free-ratio-note');
  if(v('f-free')===''){input.value='';note.textContent='请填写免费份数或比例';return;}
  if(quota===0){input.value='';note.textContent='0份按原规则表示免费额度不限，不能反推为0%。';return;}
  if(!Number.isInteger(quota)||quota<0||!Number.isInteger(total)||total<1||quota>total){
    input.value='';note.textContent='请先填写有效总份数；免费份数不能超过总份数。';return;
  }
  const ratio=Number((quota/total*100).toFixed(6));
  input.value=String(ratio);
  note.textContent=`由已有份数反推：${quota} ÷ ${total} × 100% ≈ ${ratio}%。这是实际占比，不代表历史默认比例。`;
}

function bindMultiplierAuto() {
  const multEl = document.getElementById('f-multiplier');
  const perEl = document.getElementById('f-per-share');
  multEl.oninput = applyMultiplier;
  perEl.oninput = applyMultiplier;
  document.getElementById('base-price').oninput = applyMultiplier;
  document.getElementById('f-free-ratio').oninput = syncFreeQuota;
  document.getElementById('f-total').oninput = syncFreeQuota;
  document.getElementById('f-free').oninput = inferFreeRatio;
  document.getElementById('f-price').oninput = () => {
    if (document.getElementById('multiplier-row').style.display === 'none') return;
    perEl.value = document.getElementById('f-price').value;
    applyMultiplier();
  };
}

// ========== Users ==========
let userPage=1,userPages=1,userTotal=0,userSearchTimer=null,userLoadId=0;
async function loadUsers(page=userPage){
 const sequence=++userLoadId;userPage=page;
 const r=await adminFetch('/api/admin/users?page='+page+'&q='+encodeURIComponent(v('user-search')));const d=await r.json();
 if(sequence!==userLoadId)return;
 if(d.ok){allUsers=d.users;userTotal=d.total??d.users.length;userPages=d.pages||1;renderUsers(allUsers);}
}
function searchUsers(){clearTimeout(userSearchTimer);userSearchTimer=setTimeout(()=>loadUsers(1),300);}

function renderUsers(users) {
  document.getElementById('user-count').textContent = `共 ${userTotal} 人`;
  const el = document.getElementById('user-list');
  if (!users.length) { el.innerHTML = '<div class="empty">无匹配用户</div>'; return; }
  let html = '<table class="user-table"><tr><th>账号</th><th>昵称</th><th>角色</th><th>充值 / 免费金币</th><th>注册时间</th><th>操作</th></tr>';
  users.forEach(u => {
    const t = new Date(Number(u.created_at)).toLocaleDateString('zh-CN');
    const role = u.role === 'admin' ? '<span class="role-admin">管理员</span>' : '用户';
    html += `<tr>
      <td>${esc(u.account)}</td>
      <td>${esc(u.name||'—')}</td>
      <td>${role}</td>
      <td>${u.paid_balance||0} / ${u.free_balance||0}${u.disabled?' · 已停用':''}</td>
      <td>${t}</td>
      <td>
        <a href="#" onclick="renameUser('${u.id}');return false">改名</a> ·
        <a href="#" onclick="resetPwd('${u.id}');return false">重置密码</a> ·
        <a href="#" onclick="showFreeCoinDetail('${u.id}');return false">免费金币明细</a> ·
        <a href="#" onclick="delUser('${u.id}');return false" style="color:#c00">停用</a> · <a href="#" onclick="enableUser('${u.id}');return false">启用</a> · <a href="#" onclick="showLedger('${u.id}');return false">流水</a> · <a href="#" onclick="adjustBalance('${u.id}');return false">调整余额</a>
      </td>
    </tr>`;
  });
  el.innerHTML = html + '</table>'+`<div class="pagination"><button onclick="loadUsers(${userPage-1})" ${userPage<=1?'disabled':''}>上一页</button><span>${userPage}/${userPages}</span><button onclick="loadUsers(${userPage+1})" ${userPage>=userPages?'disabled':''}>下一页</button></div>`;
}

async function renameUser(uid) {
  const oldName = allUsers.find(u => u.id === uid)?.name || '';
  const name = prompt('输入新昵称：', oldName);
  if (name === null || !name.trim()) return;
  const r = await adminFetch('/api/admin/users/' + uid + '/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() })
  });
  const d = await r.json();
  toast(d.msg || (d.ok ? '已修改' : '修改失败'));
  if (d.ok) loadUsers();
}

async function resetPwd(uid) {
  const account = allUsers.find(u => u.id === uid)?.account || '';
  const input=await askFields('重置 '+account+' 的密码',[{key:'password',label:'新密码（至少8位）',type:'password'}]);
  if(!input)return;const pwd=input.password;
  if(pwd.length<8){toast('新密码至少8位');return;}
  const r = await adminFetch('/api/admin/users/' + uid + '/reset-pwd', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pwd.trim() })
  });
  const d = await r.json();
  toast(d.msg || (d.ok ? '密码已重置' : '重置失败'));
}

async function delUser(uid) {
  const account = allUsers.find(u => u.id === uid)?.account || '';
  if (!confirm(`确定停用用户 ${account}？账号将退出登录，交易记录保留，可重新启用。`)) return;
  const r = await adminFetch('/api/admin/users/' + uid, { method: 'DELETE' });
  const d = await r.json();
  toast(d.msg || (d.ok ? '已删除' : '删除失败'));
  if (d.ok) loadUsers();
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
  const result = await Store.saveConfig({
    grantRegister: Math.max(0, parseInt(v('r-register')) || 0),
    grantCheckin: Math.max(0, parseInt(v('r-checkin')) || 0),
    grantShowcase: Math.max(0, parseInt(v('r-showcase')) || 0),
    grantInvitee: Math.max(0, parseInt(v('r-invitee')) || 0),
    grantInviter: Math.max(0, parseInt(v('r-inviter')) || 0),
  });
  if(!result.ok){toast(result.msg||'保存失败');return;}
  toast('规则已保存');
}

// ========== Settings: Display Hours ==========
function loadDisplayHours() {
  const c = Store.getConfig();
  document.getElementById('r-recentBuysHours').value = c.recentBuysHours || 0;
  document.getElementById('r-winnersHours').value = c.winnersHours || 0;
  document.getElementById('r-showcaseHours').value = c.showcaseHours || 0;
}

async function saveDisplayHours() {
  const result = await Store.saveConfig({
    recentBuysHours: Math.max(0, parseInt(v('r-recentBuysHours')) || 0),
    winnersHours: Math.max(0, parseInt(v('r-winnersHours')) || 0),
    showcaseHours: Math.max(0, parseInt(v('r-showcaseHours')) || 0),
  });
  if(!result.ok){toast(result.msg||'保存失败');return;}
  toast('展示时间已保存');
}

// ========== Settings: Draw Delay ==========
function loadDrawDelay() {
  const c = Store.getConfig();
  document.getElementById('r-drawDelay').value = c.drawDelay || 10;
}

async function saveDrawDelay() {
  const val = Math.max(1, Math.min(60, parseInt(v('r-drawDelay')) || 10));
  const result = await Store.saveConfig({ drawDelay: val });
  if(!result.ok){toast(result.msg||'保存失败');return;}
  toast('开奖延迟已保存：' + val + ' 分钟');
}

// ========== Settings: Categories ==========
function renderCats() {
  const box = document.getElementById('cat-list');
  const cats = Store.listCategories();
  box.innerHTML = cats.map((c, i) => {
    const upBtn = i > 0 ? `<span class="edit" onclick="moveCat(${i},-1)">↑</span>` : `<span class="edit" style="visibility:hidden">↑</span>`;
    const downBtn = i < cats.length - 1 ? `<span class="edit" onclick="moveCat(${i},1)">↓</span>` : `<span class="edit" style="visibility:hidden">↓</span>`;
    return `<div class="cat-item"><span>${upBtn} ${downBtn} ${escapeHtml(c.icon)} ${escapeHtml(c.name)} <small style="color:#888">${c.prefix}</small></span><span><span class="edit" onclick="renameCat('${c.key}','${encodeURIComponent(c.name)}','${encodeURIComponent(c.icon)}')">重命名</span> <span class="del" onclick="delCat('${c.key}')">删除</span></span></div>`;
  }).join('');
}

async function moveCat(index, dir) {
  const cats = Store.listCategories();
  const target = index + dir;
  if (target < 0 || target >= cats.length) return;
  const keys = cats.map(c => c.key);
  [keys[index], keys[target]] = [keys[target], keys[index]];
  const r = await Store.reorderCategories(keys);
  if (r.ok) { renderCats(); fillCategoryOptions(); }
  else toast(r.msg || '排序失败');
}

async function renameCat(key, oldName, oldIcon) {
  oldName = decodeURIComponent(oldName);
  oldIcon = decodeURIComponent(oldIcon);
  const name = prompt('新类目名称：', oldName);
  if (!name) return;
  const icon = prompt('图标（可留空不改）：', oldIcon) || oldIcon;
  const r = await Store.renameCategory(key, name, icon);
  toast(r.msg || (r.ok ? '已更新' : '更新失败'));
  if (r.ok) { renderCats(); fillCategoryOptions(); }
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
  box.innerHTML = pkgList.map((p, i) => `<div class="pkg-item"><span>$${p.amount} → 充值${p.amount}金币${p.bonus ? ' + 送'+p.bonus+'免费金币' : ''}</span><span class="pkg-actions"><span class="edit" onclick="editPkg(${i})">编辑</span><span class="del" onclick="removePkg(${i})">删除</span></span></div>`).join('');
}

function editPkg(i) {
  const p = pkgList[i];
  const newBonus = prompt('修改赠送免费金币数量（当前：' + (p.bonus||0) + '）', p.bonus||0);
  if (newBonus === null) return;
  const val = parseInt(newBonus);
  if (isNaN(val) || val < 0) { toast('请输入有效数字'); return; }
  pkgList[i].bonus = val;
  renderPkgs();
}

function addPkg() {
  const pay = parseInt(v('pkg-pay')) || 0;
  const bonus = parseInt(v('pkg-bonus')) || 0;
  if (pay < 1) { toast('请填写有效的充值金额'); return; }
  if (pkgList.some(p => p.amount === pay)) { toast('该金额已存在'); return; }
  pkgList.push({ amount: pay, bonus });
  pkgList.sort((a, b) => a.amount - b.amount);
  document.getElementById('pkg-pay').value = '';
  document.getElementById('pkg-bonus').value = '0';
  renderPkgs();
}

function removePkg(i) { pkgList.splice(i, 1); renderPkgs(); }

async function savePkgs() {
  const result = await Store.saveConfig({ recharge_packages: pkgList });
  if(!result.ok){toast(result.msg||'保存失败');return;}
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
        ? `<video src="${escapeHtml(s.media_url)}" style="max-width:200px;max-height:150px;border-radius:8px" controls></video>`
        : `<img src="${escapeHtml(s.media_url)}" style="max-width:200px;max-height:150px;border-radius:8px;object-fit:cover">`;
      const t = new Date(Number(s.created_at)).toLocaleString('zh-CN');
      return `<div style="display:flex;gap:16px;align-items:center;padding:16px;background:#f8f9fa;border-radius:12px;margin-bottom:12px">
        ${media}
        <div style="flex:1">
          <div style="font-weight:600">${escapeHtml(s.emoji||'🎁')} ${esc(s.product_name||'')}</div>
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

// ========== 中奖订单管理 ==========
async function loadWins() {
  const el = document.getElementById('wins-list');
  try {
    const r = await adminFetch('/api/admin/wins');
    const d = await r.json();
    if (!d.ok || !d.wins || !d.wins.length) { el.innerHTML = '<div class="empty">暂无中奖记录</div>'; return; }
    let html = '<table class="orders-table"><tr><th>商品</th><th>中奖号</th><th>中奖用户</th><th>地址</th><th>状态</th><th>备注</th><th>操作</th></tr>';
    d.wins.forEach(w => {
      const addr = w.win_address ? (() => { try { const a = JSON.parse(w.win_address); return `${escapeHtml(a.name)} ${escapeHtml(a.phone)}<br>${escapeHtml(a.address)}`; } catch { return escapeHtml(w.win_address); } })() : '<span style="color:#c00">未填写</span>';
      const statusMap = { pending: '待发货', shipped: '已发货', done: '已完成' };
      const statusCls = { pending: 'color:#e65100', shipped: 'color:#1565c0', done: 'color:#2e7d32' };
      const st = w.ship_status || 'pending';
      html += `<tr>
        <td>${esc(w.sku||'')} ${esc(w.product_name||'')}</td>
        <td><b>${w.win_number}</b></td>
        <td>${esc(w.winner_account||'')} (${esc(w.winner_name||'')})</td>
        <td style="font-size:12px">${addr}</td>
        <td style="${statusCls[st]||''};font-weight:600">${statusMap[st]||st}</td>
        <td style="font-size:12px">${esc(w.ship_note||'')}</td>
        <td>
          <select onchange="updateShip('${w.product_id}',this.value)" style="font-size:12px">
            <option value="pending" ${st==='pending'?'selected':''}>待发货</option>
            <option value="shipped" ${st==='shipped'?'selected':''}>已发货</option>
            <option value="done" ${st==='done'?'selected':''}>已完成</option>
          </select>
          <a href="#" onclick="editShipNote('${w.product_id}');return false" style="font-size:12px;margin-left:4px">备注</a>
        </td>
      </tr>`;
    });
    el.innerHTML = html + '</table>';
  } catch (e) { el.innerHTML = '<div class="empty">加载失败</div>'; }
}

async function updateShip(productId, status) {
  const r = await adminFetch('/api/admin/wins/' + productId + '/ship', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  const d = await r.json();
  toast(d.msg || (d.ok ? '已更新' : '更新失败'));
  loadWins();
}

async function editShipNote(productId) {
  const note = prompt('输入备注（如快递单号）：');
  if (note === null) return;
  const el = document.querySelector(`select[onchange*="${productId}"]`);
  const status = el ? el.value : 'pending';
  const r = await adminFetch('/api/admin/wins/' + productId + '/ship', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, note })
  });
  const d = await r.json();
  toast(d.msg || (d.ok ? '已更新' : '更新失败'));
  if (d.ok) loadWins();
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
  // Users are loaded when their tab opens.


  // Settings
  loadRules();
  loadDisplayHours();
  loadDrawDelay();
  renderCats();
});



async function adminFetch(url,options={}){
 try {const r=await fetch(url,{...options,signal:AbortSignal.timeout(60000)});const data=await r.json();if(!r.ok||!data.ok)toast(data.msg||'操作失败');return {json:async()=>data};}
 catch(e){toast('服务连接失败，请稍后重试；未确认前请勿重复提交');return {json:async()=>({ok:false,msg:'连接失败'})};}
}
async function enableUser(id){const r=await adminFetch('/api/admin/users/'+id+'/enable',{method:'POST'});const d=await r.json();toast(d.msg);if(d.ok)loadUsers();}
async function showLedger(id,page=1){
 const r=await adminFetch('/api/admin/users/'+id+'/ledger?page='+page);const d=await r.json();if(!d.ok)return;
 let box=document.getElementById('ledger-view');if(!box){box=document.createElement('div');box.id='ledger-view';document.getElementById('user-list').after(box);}
 box.innerHTML='<h3>用户资金流水</h3>'+d.records.map(t=>`<p>${esc(new Date(Number(t.created_at)).toLocaleString())} · ${esc(t.kind)} · ${esc(t.amount)} · 余额 ${esc(t.balance)} · ${esc(t.ref||'')}</p>`).join('')+`<button class="btn ghost" onclick="showLedger('${id}',${Math.max(1,page-1)})" ${page<=1?'disabled':''}>上一页</button> <button class="btn ghost" onclick="showLedger('${id}',${page+1})" ${d.records.length<50?'disabled':''}>下一页</button>`;
}
async function showFreeCoinDetail(id){
 const r=await adminFetch('/api/admin/free-coin-detail?userId='+encodeURIComponent(id));const d=await r.json();if(!d.ok)return;
 let box=document.getElementById('ledger-view');if(!box){box=document.createElement('div');box.id='ledger-view';document.getElementById('user-list').after(box);}
 const date=n=>esc(new Date(Number(n)).toLocaleString());
 box.innerHTML=`<h3>免费金币明细 · ${esc(d.user.account)}</h3><p>免费余额 ${esc(d.user.free_balance)} · 充值余额 ${esc(d.user.paid_balance)}</p>`+
  '<h4>最近20次签到</h4>'+(d.checkins.map(c=>`<p>${date(c.created_at)} · 连续${esc(c.streak)}天 · 奖励${esc(c.reward)}金币</p>`).join('')||'<p>暂无签到记录</p>')+
  '<h4>最近50条奖励与免费金币流水</h4>'+(d.walletGrants.map(c=>`<p>${date(c.created_at)} · ${esc(c.kind)} · ${esc(c.amount)} · ${esc(c.ref||'')}</p>`).join('')||'<p>暂无记录</p>')+
  '<h4>旧版赠送记录（最近20条）</h4>'+(d.freeGrants.map(c=>`<p>${date(c.created_at)} · ${esc(c.amount)} · ${esc(c.reason||'')}</p>`).join('')||'<p>暂无旧版记录</p>');
 box.scrollIntoView({behavior:'smooth',block:'start'});
}
async function loadSystemStatus(){
 const box=document.getElementById('system-status');if(!box)return;
 const r=await adminFetch('/api/admin/system-status');const d=await r.json();if(!d.ok){box.textContent='服务状态暂时无法读取';return;}
 if(d.databaseExpiresAt){document.getElementById('database-expiry').value=d.databaseExpiresAt;const notice=document.getElementById('database-expiry-notice');notice.textContent=`数据库到期日：${d.databaseExpiresAt}，剩余约 ${Math.max(0,d.daysRemaining)} 天。请在到期前续费或迁移；本机每日备份保存在项目的“本地恢复资料”。`;notice.style.color=d.daysRemaining<=7?'#b71c1c':'#663c00';}
 box.textContent=`数据库：${d.database?'正常':'不可用'}；信用卡支付：${d.payments?.stripe?'已配置':'未开通'}；PayPal：${d.payments?.paypal?'已配置':'未开通'}；邮件：${d.mail?'已配置，需实际收件验收':'未配置'}；短信注册：未开通。签到按北京时间零点刷新。`;
}

function askFields(title,fields){return new Promise(resolve=>{
 const mask=document.createElement('div');mask.className='coin-choice-mask';
 const form=document.createElement('form');form.className='coin-choice-modal';form.setAttribute('role','dialog');form.setAttribute('aria-modal','true');form.setAttribute('aria-label',title);
 const h=document.createElement('h3');h.textContent=title;form.append(h);
 const inputs={};for(const f of fields){const label=document.createElement('label');label.style.cssText='display:block;margin:12px 0;text-align:left';label.textContent=f.label;const input=document.createElement('input');input.type=f.type||'text';input.value=f.value??'';input.required=true;input.style.cssText='display:block;width:100%;margin-top:6px;padding:10px;box-sizing:border-box';if(f.type==='password')input.autocomplete='new-password';label.append(input);form.append(label);inputs[f.key]=input;}
 const ok=document.createElement('button');ok.className='btn';ok.type='submit';ok.textContent='确认';const cancel=document.createElement('button');cancel.type='button';cancel.className='btn ghost';cancel.textContent='取消';cancel.style.marginLeft='12px';form.append(ok,cancel);mask.append(form);document.body.append(mask);
 const previous=document.activeElement;const close=value=>{mask.remove();previous?.focus();resolve(value)};
 cancel.onclick=()=>close(null);form.onsubmit=e=>{e.preventDefault();close(Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.value])))};
 form.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();close(null)}if(e.key==='Tab'){const all=[...Object.values(inputs),ok,cancel],i=all.indexOf(document.activeElement);if(e.shiftKey&&i===0){e.preventDefault();cancel.focus()}else if(!e.shiftKey&&i===all.length-1){e.preventDefault();all[0].focus()}}};Object.values(inputs)[0].focus();
})}
async function adjustBalance(id){
 const user=allUsers.find(u=>u.id===id);if(!user)return;
 const values=await askFields('调整余额（会记录资金流水）',[{key:'paidBalance',label:'调整后充值金币',type:'number',value:user.paid_balance},{key:'freeBalance',label:'调整后免费金币',type:'number',value:user.free_balance||0},{key:'reason',label:'调整原因（至少3字）'}]);if(!values)return;
 const r=await adminFetch('/api/admin/fix-balance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...values,userId:id})});const d=await r.json();toast(d.msg);if(d.ok){loadUsers();showLedger(id);}
}
async function loadAudit(page=1){
 const r=await adminFetch('/api/admin/audit?page='+page);const d=await r.json();if(!d.ok)return;
 const box=document.getElementById('audit-list');box.innerHTML=d.records.map(a=>`<p>${esc(new Date(Number(a.created_at)).toLocaleString())} · ${esc(a.action)} · ${esc(a.target_id||'系统配置')}</p>`).join('')||'暂无操作记录';
}

async function saveDatabaseExpiry(){const r=await Store.saveConfig({databaseExpiresAt:document.getElementById('database-expiry').value});toast(r.msg);if(r.ok)loadSystemStatus();}
