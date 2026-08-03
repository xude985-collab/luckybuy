/* 商品详情：买份额（需登录）+ 开奖公示 + 中奖填地址 */
const id = param('id');

function render() {
  const p = Store.getProduct(id);
  const box = document.getElementById('detail');
  if (!p) { box.innerHTML = '<div class="empty">商品不存在</div>'; return; }

  const percent = pct(p);
  const remain = p.totalShares - p.soldShares;
  const done = p.status === 'revealed';
  const me = Store.currentUser();
  const iWon = done && me && p.winnerUserId === me.id;

  const drawing = p.status === 'drawing';
  let action;
  if (drawing) {
    action = `
      <div class="reveal-box">
        <div>🎲 已售罄，正在开奖…</div>
        <div style="font-size:13px;color:#8a5a00;margin-top:8px">
          开奖使用 drand 公共随机信标第 <b>${p.drandRound || '—'}</b> 轮（约 30 秒后产生，届时全网可验证）。
        </div>
      </div>`;
  } else if (done) {
    let winBlock = `<div>得主：${p.winnerName || '暂无幸运儿'}</div>`;
    if (iWon) {
      const order = Store.myOrders().find(o => o.id === p.winnerOrderId);
      const hasAddr = order && order.address;
      winBlock = `<div class="win-tag" style="font-size:18px">🎉 恭喜，你是本期幸运儿！</div>` +
        (hasAddr
          ? `<div style="margin-top:8px">收货地址已提交 ✓</div>`
          : `<button class="btn" style="margin-top:10px" onclick="fillAddress('${p.winnerOrderId}')">填写收货地址</button>`);
    }
    const proofBlock = p.proof ? `
      <div class="proof-box">
        <div class="proof-title">🔒 开奖凭据（可独立验证）</div>
        <div class="proof-row">随机源：drand 公共信标 · 第 <b>${p.proof.round}</b> 轮</div>
        <div class="proof-row">randomness：<code>${p.proof.randomness}</code></div>
        <div class="proof-row">公式：winNumber = int(HMAC-SHA256(randomness, "${p.period}")) mod ${p.totalShares} + 1</div>
        <button class="btn ghost" style="margin-top:8px" onclick="verifyDraw('${p.id}')">验证开奖结果</button>
        <div id="verifyResult" class="proof-row" style="margin-top:6px"></div>
      </div>` : '';
    action = `
      <div class="reveal-box">
        <div>本期幸运号码</div>
        <div class="num">${p.winNumber}</div>
        ${winBlock}
      </div>${proofBlock}`;
  } else {
    let quotaTip = '';
    const quota = p.freeQuota || 0;
    if (quota > 0) {
      const poolUsed = Store.productFreeUsed(id);
      const poolLeft = Math.max(0, quota - poolUsed);
      const u = Store.currentUser();
      let mine = 0;
      if (u) {
        const myUsed = Store.myOrders()
          .filter(o => o.productId === id)
          .reduce((s, o) => s + (o.freeUsed || 0), 0);
        mine = Math.min(poolLeft, u.freeCoins || 0, Math.max(0, 1 - myUsed));
      }
      quotaTip = `<div class="free-quota-tip">🪙 本商品免费金币总额度 <b>${quota}</b>（全场共享，先到先得，每人限用 1 个）· 剩余 <b>${poolLeft}</b>${u ? ` · 你本单最多可用 <b>${mine}</b> 免费金币` : ''}，其余用充值金币。</div>`;
    }
    action = quotaTip + `
      <div class="qty">
        <button onclick="stepQty(-1)">−</button>
        <input id="qty" type="number" value="1" min="1" max="${remain}">
        <button onclick="stepQty(1)">＋</button>
      </div>
      <div class="quick-pick">
        <span onclick="setQty(1)">1 份</span>
        <span onclick="setQty(5)">5 份</span>
        <span onclick="setQty(10)">10 份</span>
        <span onclick="setQty(${remain})">全包 (${remain})</span>
      </div>
      <button class="btn block" onclick="buy()">立即夺宝（$${p.price} / 份）</button>`;
  }

  box.innerHTML = `
    ${galleryHtml(p)}
    <div>
      <h1>${p.name}</h1>
      <div class="detail-sku">
        <span class="cat-chip">${Store.categoryOf(p.category).icon} ${Store.categoryOf(p.category).name}</span>
        <code class="sku">编号 ${p.sku || '—'}</code>
      </div>
      <div class="period">${p.period} ·
        ${done ? '<span class="badge done">已开奖</span>'
               : drawing ? '<span class="badge drawing">开奖中</span>'
               : '<span class="badge">进行中</span>'}
        · 单价 <b>$${p.price}</b> / 份</div>
      <div class="stat-row">
        <div class="stat"><b>${p.totalShares}</b><span>总需份数</span></div>
        <div class="stat"><b>${p.soldShares}</b><span>已参与</span></div>
        <div class="stat"><b>${remain}</b><span>剩余</span></div>
      </div>
      <div class="progress"><i style="width:${percent}%"></i></div>
      <div class="progress-meta"><span>完成度 ${percent}%（满额即开奖）</span></div>
      ${action}
      <p class="desc">${p.desc || ''}</p>
      ${specsHtml(p)}
    </div>
    ${longDetailHtml(p)}`;
}

// 图册：主图 + 缩略图；无图时退化为原来的 emoji 大图
function galleryHtml(p) {
  const g = (p.gallery || []).filter(m => m.type === 'image' || m.type === 'video');
  if (!g.length) return `<div class="big-thumb">${p.img || '🎁'}</div>`;
  const main = g[0];
  const mainHtml = main.type === 'video'
    ? `<video id="gmain" src="${main.url}" controls playsinline></video>`
    : `<img id="gmain" src="${main.url}" alt="${p.name}">`;
  const thumbs = g.map((m, i) => `
    <div class="g-thumb ${i === 0 ? 'active' : ''}" onclick="pickMedia(${i})">
      ${m.type === 'video' ? '<span class="g-play">▶</span>' : `<img src="${m.url}" alt="">`}
    </div>`).join('');
  return `<div class="gallery">
    <div class="g-main">${mainHtml}</div>
    <div class="g-thumbs">${thumbs}</div>
  </div>`;
}

// 规格参数表
function specsHtml(p) {
  const s = (p.specs || []).filter(r => r.k || r.v);
  if (!s.length) return '';
  return `<table class="spec-table">
    ${s.map(r => `<tr><th>${r.k}</th><td>${r.v}</td></tr>`).join('')}
  </table>`;
}

// 长详情：图册里第 2 张起的图片竖排铺开（亚马逊详情长图风格）
function longDetailHtml(p) {
  const imgs = (p.gallery || []).filter(m => m.type === 'image').slice(1);
  if (!imgs.length) return '';
  return `<div class="long-detail">
    <h2 class="ld-title">商品详情</h2>
    ${imgs.map(m => `<img src="${m.url}" alt="${p.name} 详情图" loading="lazy">`).join('')}
  </div>`;
}

// 切换主图
function pickMedia(i) {
  const p = Store.getProduct(id);
  const g = (p.gallery || []).filter(m => m.type === 'image' || m.type === 'video');
  const m = g[i]; if (!m) return;
  const wrap = document.querySelector('.g-main');
  wrap.innerHTML = m.type === 'video'
    ? `<video id="gmain" src="${m.url}" controls autoplay playsinline></video>`
    : `<img id="gmain" src="${m.url}" alt="">`;
  document.querySelectorAll('.g-thumb').forEach((el, idx) =>
    el.classList.toggle('active', idx === i));
}

function stepQty(d) {
  const el = document.getElementById('qty');
  const p = Store.getProduct(id);
  const max = p.totalShares - p.soldShares;
  let v = (parseInt(el.value, 10) || 1) + d;
  el.value = Math.max(1, Math.min(max, v));
}
function setQty(v) { const el = document.getElementById('qty'); if (el) el.value = v; }

async function buy() {
  if (!requireLogin()) return;
  const count = parseInt(document.getElementById('qty').value, 10) || 0;
  if (count < 1) { toast('请选择至少 1 份'); return; }

  const p = Store.getProduct(id);
  const u = Store.currentUser();
  const poolLeft = Math.max(0, (p.freeQuota || 0) - (p.freeUsed || 0));
  const myUsedFree = Store.myOrders().filter(o => o.productId === id).reduce((s, o) => s + (o.freeUsed || 0), 0) > 0;
  const canUseFree = u.freeCoins > 0 && poolLeft > 0 && !myUsedFree;

  let useFree = false;
  if (canUseFree) {
    useFree = await showCoinChoice(u, p);
    if (useFree === null) return;
  }

  const btn = document.querySelector('.btn.block');
  if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
  try {
    const r = await Store.buyShares(id, count, useFree);
    if (r.needRecharge) { toast(r.msg); setTimeout(() => openRecharge('home'), 700); render(); return; }
    if (r.ok) {
      const o = r.order;
      let extra = '';
      if (o && o.freeUsed > 0) extra = `（免费 ${o.freeUsed} + 充值 ${o.paidUsed}）`;
      toast(r.msg + extra);
      await Store.refreshMe();
      renderTopbar('home'); render(); autoPoll();
    } else { toast(r.msg || '购买失败'); render(); }
  } catch (e) {
    toast('网络异常，请重试');
    render();
  }
}

function showCoinChoice(u, p) {
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

async function fillAddress(orderId) {
  const name = prompt('收件人姓名：'); if (!name) return;
  const phone = prompt('联系电话：'); if (!phone) return;
  const addr = prompt('详细收货地址：'); if (!addr) return;
  const r = await Store.saveAddress(orderId, { name, phone, addr });
  toast(r.msg);
  render();
}

async function verifyDraw(pid) {
  const box = document.getElementById('verifyResult');
  if (box) box.textContent = '验证中…';
  const r = await Store.verifyProof(pid);
  if (!box) return;
  if (!r.ok && r.msg) { box.textContent = r.msg; return; }
  box.innerHTML = r.ok
    ? `<span style="color:var(--ok)">✓ 验证通过：用第 ${r.round} 轮随机数复算得号 ${r.recomputed}，与公示一致。</span>`
    : `<span style="color:#c62828">✗ 复算得 ${r.recomputed}，与公示号 ${r.stored} 不符！</span>`;
}

// 开奖中：自动轮询刷新，等 drand 那一轮产生后自动显示结果
let _pollTimer = null;
function autoPoll() {
  const p = Store.getProduct(id);
  if (p && p.status === 'drawing') {
    if (Store.resumeDraws) Store.resumeDraws();
    _pollTimer = setTimeout(() => { render(); autoPoll(); }, 3000);
  } else if (_pollTimer) {
    clearTimeout(_pollTimer); _pollTimer = null;
  }
}

onReady(() => {
  renderTopbar('home');
  render();
  autoPoll();
});
