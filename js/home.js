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
  const badge = done ? '<span class="badge done">已开奖</span>'
    : drawing ? '<span class="badge drawing">开奖中</span>'
    : '<span class="badge">进行中</span>';
  // 封面:优先用真实商品图(gallery第一张),否则显示emoji
  const cover = (p.gallery && p.gallery.length && p.gallery[0].url)
    ? `<img src="${p.gallery[0].url}" alt="${p.name}" style="width:100%;height:100%;object-fit:contain;background:#fafafa">`
    : (p.img || '🎁');
  const buyBtn = (!done && !drawing)
    ? `<button class="card-buy-btn" onclick="event.stopPropagation(); location.href='detail.html?id=${p.id}'">立即夺宝 ($${p.price}/份)</button>`
    : '';
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
          <span>已售 ${percent === 0 && p.soldShares > 0 ? p.soldShares + '份' : percent + '%'}</span>
          ${done ? `<span class="remain">幸运号 <b>${p.winNumber}</b></span>`
                 : `<span class="remain">剩 <b>${remain}</b> 份</span>`}
        </div>
        ${buyBtn}
      </div>
    </div>`;
}
let activeCat = 'all';

function renderCatTabs() {
  const tabs = [{ key: 'all', name: '全部', icon: '🏷️' }].concat(Store.listCategories());
  document.getElementById('cat-tabs').innerHTML = tabs.map(c =>
    `<span class="cat-tab${c.key === activeCat ? ' active' : ''}" onclick="selectCat('${c.key}')">${c.icon} ${c.name}</span>`
  ).join('');
}

function selectCat(key) {
  activeCat = key;
  renderCatTabs();
  renderGrid();
}

function renderGrid() {
  let list = Store.listProducts();
  if (activeCat !== 'all') list = list.filter(p => (p.category || 'other') === activeCat);
  const grid = document.getElementById('grid');
  grid.innerHTML = list.length
    ? list.map(cardHtml).join('')
    : '<div class="empty">该类别下暂无商品。</div>';
}

/* ---- 晒单展示区 ---- */
async function renderShowcase() {
  const wrap = document.getElementById('showcase');
  const items = await Store.getApprovedShowcases();
  if (!items.length) {
    wrap.innerHTML = `
      <div class="page-title">🎬 幸运晒单</div>
      <div class="empty">开奖后，幸运儿的收货照片和视频会展示在这里。</div>`;
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

onReady(async () => {
  renderTopbar('home');
  await Store.ready;
  renderMarquee();
  renderLiveFeed();
  renderCatTabs();
  renderGrid();
  renderShowcase();
});
