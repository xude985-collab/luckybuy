/* 首页：幸运跑马灯 + 商品列表 + 晒单展示区 */

/* ---- 实时抢购动态（左侧从下往上滚动） ---- */
function renderLiveFeed() {
  const el = document.getElementById('live-feed-list');
  if (!el) return;
  const buys = Store.recentBuys();
  if (!buys.length) {
    el.innerHTML = '<div style="padding:16px;color:#888;font-size:13px">暂无抢购记录</div>';
    return;
  }
  const list = buys.slice(0, 20);
  const items = list.map(b => {
    const ago = timeAgo(b.time);
    return `<div class="live-feed-item">
      <span class="buyer">${b.buyerName}</span> 抢购了
      <span class="product">${b.emoji} ${b.productName}</span> × ${b.shares}份
      <div class="time">${ago}</div>
    </div>`;
  }).join('');
  if (list.length <= 3) {
    el.innerHTML = items;
  } else {
    el.innerHTML = `<div class="feed-track">${items}${items}</div>`;
  }
}

function timeAgo(ts) {
  if (!ts) return '';
  const t = Number(ts);
  if (!t) return '';
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  return Math.floor(diff / 86400) + '天前';
}

/* ---- 幸运榜跑马灯 ---- */
function renderMarquee() {
  const el = document.getElementById('marquee');
  const feed = Store.winnersFeed();
  if (!feed.length) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  const items = feed.concat(feed).map(w =>
    `<span class="item">🎉 <b>${w.winnerName}</b> 用 <b>$${w.price}</b> 夺得 <b>${w.productName}</b>（幸运号 ${w.winNumber}）</span>`
  ).join('');
  el.innerHTML = `<div class="label">🏆 幸运榜</div><div class="track">${items}</div>`;
}

/* ---- 商品网格 ---- */
function cardHtml(p) {
  const percent = pct(p);
  const remain = p.totalShares - p.soldShares;
  const done = p.status === 'revealed';
  const drawing = p.status === 'drawing';
  const badge = done ? '<span class="badge done">已揭晓</span>'
    : drawing ? '<span class="badge drawing">揭晓中</span>'
    : '<span class="badge">进行中</span>';
  // 封面:优先用真实商品图(gallery第一张),否则显示emoji
  const cover = (p.gallery && p.gallery.length && p.gallery[0].url)
    ? `<img src="${p.gallery[0].url}" alt="${p.name}" style="width:100%;height:100%;object-fit:cover">`
    : (p.img || '🎁');
  let buySection = '';
  if (!done && !drawing) {
    buySection = `
      <div class="card-buy-section" onclick="event.stopPropagation()">
        <div class="card-qty">
          <button onclick="cardStep('${p.id}',-1)">−</button>
          <input id="cqty-${p.id}" type="number" value="1" min="1" max="${remain}">
          <button onclick="cardStep('${p.id}',1)">＋</button>
        </div>
        <div class="card-quick-pick">
          <span onclick="cardSet('${p.id}',1)">1 份</span>
          <span onclick="cardSet('${p.id}',5)">5 份</span>
          <span onclick="cardSet('${p.id}',10)">10 份</span>
          <span onclick="cardSet('${p.id}',${remain})">全包 (${remain})</span>
        </div>
        <button class="card-buy-btn" id="cbtn-${p.id}" onclick="cardBuy('${p.id}')">立即夺宝 ($${p.price}/份)</button>
      </div>`;
  }
  return `
    <div class="card" onclick="location.href='detail.html?id=${p.id}'">
      <div class="thumb">${cover}</div>
      <div class="body">
        <div class="sku-line"><code class="sku">${p.sku || ''}</code></div>
        <div class="name">${p.name}</div>
        <div class="period">${p.period} · <b>$${p.price}</b>/份
          ${badge}</div>
        <div class="progress"><i style="width:${percent}%"></i></div>
        <div class="progress-meta">
          <span>已售 ${p.soldShares}/${p.totalShares}份</span>
          ${done ? `<span class="remain">幸运号 <b>${p.winNumber}</b></span>`
                 : `<span class="remain">剩 <b>${remain}</b> 份</span>`}
        </div>
        ${buySection}
      </div>
    </div>`;
}
let activeCat = 'all';
let currentPage = 1;
const PAGE_SIZE = window.innerWidth <= 600 ? 8 : 20;

function renderCatTabs() {
  const tabs = [{ key: 'all', name: '全部', icon: '🏷️' }].concat(Store.listCategories());
  document.getElementById('cat-tabs').innerHTML = tabs.map(c =>
    `<span class="cat-tab${c.key === activeCat ? ' active' : ''}" onclick="selectCat('${c.key}')">${c.icon} ${c.name}</span>`
  ).join('');
}

function selectCat(key) {
  activeCat = key;
  currentPage = 1;
  renderCatTabs();
  renderGrid();
}

function renderGrid() {
  let list = Store.listProducts().filter(p => p.status !== 'revealed');
  if (activeCat !== 'all') list = list.filter(p => (p.category || 'other') === activeCat);
  list.sort((a, b) => (b.soldShares / b.totalShares) - (a.soldShares / a.totalShares));
  const grid = document.getElementById('grid');
  const total = list.length;
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = list.slice(start, start + PAGE_SIZE);

  if (!total) {
    grid.innerHTML = '<div class="empty">该类别下暂无商品。</div>';
    removePagination();
    return;
  }
  grid.innerHTML = pageItems.map(cardHtml).join('');
  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  let pg = document.getElementById('pagination');
  if (totalPages <= 1) { removePagination(); return; }
  if (!pg) {
    pg = document.createElement('div');
    pg.id = 'pagination';
    pg.className = 'pagination';
    document.getElementById('grid').after(pg);
  }
  pg.innerHTML = `
    <button onclick="goPage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="page-info">${currentPage} / ${totalPages}</span>
    <button onclick="goPage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''}>下一页</button>`;
}
function removePagination() {
  const pg = document.getElementById('pagination');
  if (pg) pg.remove();
}
function goPage(n) {
  currentPage = n;
  renderGrid();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---- 晒单展示区 ---- */
async function renderShowcase() {
  const wrap = document.getElementById('showcase');
  const items = await Store.getApprovedShowcases();
  if (!items.length) {
    wrap.innerHTML = `
      <div class="page-title">🎬 幸运晒单</div>
      <div class="empty">揭晓后，幸运儿的收货照片和视频会展示在这里。</div>`;
    return;
  }
  const cards = items.map(s => {
    const media = s.media_type === 'video'
      ? `<video class="media" src="${s.media_url}" controls muted></video>`
      : `<div class="media"><img src="${s.media_url}" alt="" style="width:100%;height:100%;object-fit:cover"></div>`;
    return `<div class="showcase-item">${media}
      <div class="cap">${esc(s.caption || s.product_name || '')}</div>
      <div class="meta">${s.emoji||'🎁'} ${esc(s.product_name||'')} · ${esc(s.user_name||'幸运用户')}</div>
    </div>`;
  }).join('');
  wrap.innerHTML = `
    <div class="page-title">🎬 幸运晒单</div>
    <div class="showcase-grid">${cards}</div>`;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function renderAll() {
  renderMarquee();
  renderLiveFeed();
  renderCatTabs();
  renderGrid();
}

/* ---- 首页快速购买 ---- */
function cardStep(pid, d) {
  const el = document.getElementById('cqty-' + pid);
  if (!el) return;
  const p = Store.getProduct(pid);
  const max = p ? p.totalShares - p.soldShares : 999;
  el.value = Math.max(1, Math.min(max, (parseInt(el.value) || 1) + d));
}
function cardSet(pid, v) {
  const el = document.getElementById('cqty-' + pid);
  if (el) el.value = v;
}
async function cardBuy(pid) {
  if (!requireLogin()) return;
  const el = document.getElementById('cqty-' + pid);
  const count = parseInt(el?.value) || 1;
  if (count < 1) { toast('请选择至少 1 份'); return; }

  const p = Store.getProduct(pid);
  const u = Store.currentUser();
  const myUsedFree = Store.myOrders().filter(o => o.productId === pid).reduce((s, o) => s + (o.freeUsed || 0), 0) > 0;
  const quota = p.freeQuota || 0;
  const poolLeft = quota > 0 ? Math.max(0, quota - (p.freeUsed || 0)) : Infinity;
  const canUseFree = u.freeCoins > 0 && poolLeft > 0 && !myUsedFree;

  let useFree = false;
  if (canUseFree) {
    useFree = await showCardCoinChoice(u, p);
    if (useFree === null) return;
  }

  const btn = document.getElementById('cbtn-' + pid);
  if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
  try {
    const r = await Store.buyShares(pid, count, useFree);
    if (r.needRecharge) { toast(r.msg); setTimeout(() => openRecharge('home'), 700); return; }
    if (r.ok) {
      const o = r.order;
      let extra = '';
      if (o && o.freeUsed > 0) extra = `（免费 ${o.freeUsed} + 充值 ${o.paidUsed}）`;
      toast((r.msg || '购买成功') + extra);
      await Store.refreshMe();
      renderTopbar('home');
      renderGrid();
    } else { toast(r.msg || '购买失败'); }
  } catch (e) { toast('网络异常，请重试'); }
  finally {
    if (btn) { btn.disabled = false; const pp = Store.getProduct(pid); btn.textContent = `立即夺宝 ($${pp?.price||1}/份)`; }
  }
}

function showCardCoinChoice(u, p) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'coin-choice-mask';
    mask.innerHTML = `
      <div class="coin-choice-modal">
        <div class="coin-choice-title">选择支付方式</div>
        <div class="coin-choice-info">充值金币：<b>${u.paidCoins||0}</b> · 免费金币：<b>${u.freeCoins||0}</b></div>
        <div class="coin-choice-tip">每人每商品限用 1 次免费金币</div>
        <div class="coin-choice-btns">
          <button class="btn coin-choice-free">使用免费金币</button>
          <button class="btn ghost coin-choice-paid">使用充值金币</button>
        </div>
        <a href="#" class="coin-choice-cancel">取消</a>
      </div>`;
    document.body.appendChild(mask);
    mask.querySelector('.coin-choice-free').onclick = () => { mask.remove(); resolve(true); };
    mask.querySelector('.coin-choice-paid').onclick = () => { mask.remove(); resolve(false); };
    mask.querySelector('.coin-choice-cancel').onclick = (e) => { e.preventDefault(); mask.remove(); resolve(null); };
  });
}

onReady(async () => {
  renderTopbar('home');
  await Store.ready;
  renderAll();
  renderShowcase();
});

// 页面恢复可见时刷新商品数据（解决从详情页返回时数据过期问题）
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    Promise.all([Store.refreshProducts(), Store.refreshRecentBuys()]).then(() => {
      renderAll();
    }).catch(() => {});
  }
});
