/* 个人中心 */
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

async function loadProfile() {
  const u = Store.currentUser();
  if (!u) { location.href = 'index.html'; return; }

  // 用户信息头
  const wrap = document.querySelector('.profile-wrap');
  const header = document.createElement('div');
  header.className = 'profile-card profile-header';
  header.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <div class="profile-avatar">👤</div>
      <div style="flex:1;min-width:0">
        <div class="profile-name">${esc(u.name || '用户')}</div>
        <div class="profile-account">${esc(u.account || '')}</div>
      </div>
      <button class="btn ghost" id="profile-logout" style="flex:none">退出登录</button>
    </div>`;
  wrap.insertBefore(header, wrap.firstChild);
  document.getElementById('profile-logout').onclick = async () => {
    await Store.logout(); toast('已退出'); location.href = 'index.html';
  };

  document.getElementById('p-coins').textContent = (u.paidBalance || 0) + (u.freeBalance || 0);

  // 幸运记录
  try {
    const resp = await fetch('/api/shop/my-wins', { credentials: 'same-origin' });
    const data = await resp.json();
    const wins = data.ok ? data.wins : [];
    document.getElementById('p-wins').textContent = wins.length;
    const el = document.getElementById('win-list');
    if (!wins.length) { el.innerHTML = '<div class="empty">暂无幸运记录</div>'; }
    else {
      el.innerHTML = wins.map(w => {
        const t = new Date(Number(w.drawn_at)).toLocaleDateString('zh-CN');
        return `<div class="win-item">
          <span class="emoji">${w.emoji || '🎁'}</span>
          <div class="info"><div class="name">${esc(w.product_name)}</div><div class="date">${t}</div></div>
        </div>`;
      }).join('');
      // 填充晒单下拉
      const sel = document.getElementById('sc-product');
      wins.forEach(w => {
        const opt = document.createElement('option');
        opt.value = w.product_id;
        opt.textContent = `${w.emoji || '🎁'} ${w.product_name}`;
        sel.appendChild(opt);
      });
    }
  } catch (e) { console.error(e); }

  // 参与次数
  try {
    const resp = await fetch('/api/wallet/orders', { credentials: 'same-origin' });
    const data = await resp.json();
    document.getElementById('p-orders').textContent = data.ok ? data.orders.length : 0;
  } catch (e) {}

  // 我的晒单
  loadMyShowcases();
}

async function loadMyShowcases() {
  const list = await Store.getMyShowcases();
  const el = document.getElementById('my-showcases');
  if (!list.length) { el.innerHTML = '<div class="empty">暂无晒单</div>'; return; }
  el.innerHTML = list.map(s => {
    const media = s.media_type === 'video'
      ? `<video src="${s.media_url}" style="width:80px;height:60px;object-fit:cover;border-radius:8px"></video>`
      : `<img src="${s.media_url}" style="width:80px;height:60px;object-fit:cover;border-radius:8px">`;
    const statusMap = { pending: '审核中', approved: '已通过', rejected: '已拒绝' };
    return `<div class="sc-item">
      ${media}
      <div style="flex:1">
        <div style="font-weight:600">${s.emoji || '🎁'} ${esc(s.product_name || '')}</div>
        <div style="font-size:12px;color:#888;margin-top:4px">${esc(s.caption || '')}</div>
      </div>
      <span class="sc-status ${s.status}">${statusMap[s.status] || s.status}</span>
    </div>`;
  }).join('');
}

async function submitSC() {
  const productId = document.getElementById('sc-product').value;
  const mediaType = document.getElementById('sc-type').value;
  const fileInput = document.getElementById('sc-file');
  const caption = document.getElementById('sc-caption').value.trim();
  if (!productId) { toast('请选择幸运商品'); return; }
  if (!fileInput.files.length) { toast('请选择图片或视频文件'); return; }

  const file = fileInput.files[0];
  if (file.size > 50 * 1024 * 1024) { toast('文件不能超过50MB'); return; }

  const fd = new FormData();
  fd.append('media', file);
  fd.append('productId', productId);
  fd.append('mediaType', mediaType);
  fd.append('caption', caption);

  try {
    const resp = await fetch('/api/showcase/submit', { method: 'POST', body: fd, credentials: 'include' });
    const r = await resp.json();
    toast(r.msg || (r.ok ? '提交成功' : '提交失败'));
    if (r.ok) {
      fileInput.value = '';
      document.getElementById('sc-preview').innerHTML = '';
      document.getElementById('sc-caption').value = '';
      loadMyShowcases();
    }
  } catch (e) { toast('网络错误'); }
}

function previewSCFile(input) {
  const preview = document.getElementById('sc-preview');
  preview.innerHTML = '';
  if (!input.files.length) return;
  const file = input.files[0];
  if (file.type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    preview.appendChild(img);
  } else if (file.type.startsWith('video/')) {
    const vid = document.createElement('video');
    vid.src = URL.createObjectURL(file);
    vid.controls = true;
    vid.muted = true;
    preview.appendChild(vid);
  }
}

async function initCheckinCard() {
  const card = document.getElementById('checkin-card');
  const btn = document.getElementById('checkin-btn');
  const info = document.getElementById('checkin-info');
  if (!Store.canCheckin()) {
    btn.disabled = true;
    btn.textContent = '今日已签到 ✓';
    btn.style.background = '#4caf50';
    info.textContent = '明天再来，连续签到奖励更多哦！';
  }
}

async function doCheckin() {
  const btn = document.getElementById('checkin-btn');
  btn.disabled = true; btn.textContent = '签到中…';
  const r = await Store.checkin();
  toast(r.msg);
  if (r.ok) {
    btn.textContent = '今日已签到 ✓';
    btn.style.background = '#4caf50';
    document.getElementById('checkin-info').textContent = '明天再来，连续签到奖励更多哦！';
    await Store.refreshMe();
    renderTopbar('profile');
  } else {
    btn.disabled = false; btn.textContent = '签到领币';
  }
}

onReady(() => {
  renderTopbar('profile');
  loadProfile();
  initCheckinCard();
});
