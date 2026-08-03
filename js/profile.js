/* 个人中心 */
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

async function loadProfile() {
  const u = Store.currentUser();
  if (!u) { location.href = 'index.html'; return; }
  document.getElementById('p-coins').textContent = (u.paidBalance || 0) + (u.freeBalance || 0);

  // 中奖记录
  try {
    const resp = await fetch('/api/shop/my-wins', { credentials: 'same-origin' });
    const data = await resp.json();
    const wins = data.ok ? data.wins : [];
    document.getElementById('p-wins').textContent = wins.length;
    const el = document.getElementById('win-list');
    if (!wins.length) { el.innerHTML = '<div class="empty">暂无中奖记录</div>'; }
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
  const mediaUrl = document.getElementById('sc-url').value.trim();
  const caption = document.getElementById('sc-caption').value.trim();
  if (!productId) { toast('请选择中奖商品'); return; }
  if (!mediaUrl) { toast('请填写图片或视频链接'); return; }

  const r = await Store.submitShowcase({ productId, mediaType, mediaUrl, caption });
  toast(r.msg || (r.ok ? '提交成功' : '提交失败'));
  if (r.ok) {
    document.getElementById('sc-url').value = '';
    document.getElementById('sc-caption').value = '';
    loadMyShowcases();
  }
}

onReady(() => {
  renderTopbar('profile');
  loadProfile();
});
