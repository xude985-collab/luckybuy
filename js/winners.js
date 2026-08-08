/* 幸运区：展示所有已揭晓商品 */

function winnerCardHtml(p) {
  const cover = (p.gallery && p.gallery.length && p.gallery[0].url)
    ? `<img src="${p.gallery[0].url}" alt="${p.name}" style="width:100%;height:100%;object-fit:contain;background:#fafafa">`
    : (p.img || '🎁');
  return `
    <div class="card winner-card" onclick="location.href='detail.html?id=${p.id}'">
      <div class="thumb">${cover}</div>
      <div class="body">
        <div class="sku-line"><code class="sku">${p.sku || ''}</code></div>
        <div class="name">${p.name}</div>
        <div class="winner-result">
          <div class="winner-number">🎯 幸运号 <b>${p.winNumber ?? '—'}</b></div>
          <div class="winner-name">🎉 幸运儿：<b>${p.winnerName || '暂无'}</b></div>
        </div>
        <button class="btn ghost" style="width:100%;margin-top:10px;font-size:13px">查看详情 & 验证</button>
      </div>
    </div>`;
}

function renderWinners() {
  const list = Store.listProducts().filter(p => p.status === 'revealed');
  const grid = document.getElementById('winners-grid');
  if (!list.length) {
    grid.innerHTML = '<div class="empty">暂无已揭晓商品，敬请期待！</div>';
    return;
  }
  grid.innerHTML = list.map(winnerCardHtml).join('');
}

onReady(() => {
  renderTopbar('winners');
  renderWinners();
});
