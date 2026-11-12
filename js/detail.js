/* 商品详情：买份额（需登录）+ 幸运公示 + 幸运儿填地址 */
const id = param('id');

let _slotTimer = null;
function _clearSlot() { if (_slotTimer) { clearInterval(_slotTimer); _slotTimer = null; } }

function myNumbersHtml(winNumber) {
  const me = Store.currentUser();
  if (!me) return '';
  const orders = Store.myOrders().filter(o => String(o.productId) === String(id));
  if (!orders.length) return '';
  const allNums = orders.flatMap(o => o.numbers || []);
  if (!allNums.length) return '';
  const total = orders.reduce((s, o) => s + o.count, 0);
  return `
    <div class="my-numbers-box">
      <div class="my-numbers-title">🎫 我的号码（共 ${total} 份）</div>
      <div class="my-numbers-list">${allNums.map(n => {
        const isWin = winNumber != null && Number(n) === Number(winNumber);
        return `<span class="num-chip${isWin ? ' num-chip-win' : ''}">${n}${isWin ? ' 🏆' : ''}</span>`;
      }).join('')}</div>
    </div>`;
}

function render() {
  const p = Store.getProduct(id);
  const box = document.getElementById('detail');
  if (!p) { box.innerHTML = '<div class="empty">商品不存在</div>'; return; }

  const percent = pct(p);
  const remain = p.totalShares - p.soldShares;
  const done = p.status === 'revealed';
  const me = Store.currentUser();
  const iWon = done && me && p.winnerUserId === me.id;
  const iParticipated = me && Store.myOrders().some(o => String(o.productId) === String(id));

  const drawing = p.status === 'drawing';
  let action;
  if (drawing) {
    const _dtLeft = p.drawTime ? p.drawTime - Date.now() : 0;
    const _hasCountdown = _dtLeft > 0;
    action = `
      <div class="drawing-stage">
        <div class="drawing-header">🎲 ${_hasCountdown ? '开奖倒计时' : '正在揭晓幸运儿'}</div>
        ${_hasCountdown ? `<div class="draw-countdown" id="draw-countdown" data-draw-time="${p.drawTime}"></div>` : ''}
        <div class="drawing-reel-wrap">
          <div class="drawing-reel" id="slot-reel">—</div>
        </div>
        <div class="drawing-meta">drand 公链第 <b>${p.drandRound || '—'}</b> 轮随机信标${_hasCountdown ? '' : ' · 揭晓中'}</div>
      </div>
      ${myNumbersHtml()}`;
  } else if (done) {
    const winnerCard = iWon
      ? `<div class="draw-winner-card me">
          <div class="draw-winner-tag">🎉 恭喜！你是幸运儿</div>
          ${p.hasAddress
            ? `<div class="draw-winner-status">✅ 收货地址已提交，等待发货</div>`
            : `<button class="btn" onclick="fillAddress('${p.id}')">填写收货地址</button>`}
        </div>`
      : `<div class="draw-winner-card">
          <div class="draw-winner-label">🏆 本期幸运儿</div>
          <div class="draw-winner-name">${escapeHtml(p.winnerName || '幸运用户')}</div>
        </div>`;

    const myResult = iWon ? myNumbersHtml(p.winNumber)
      : iParticipated ? `
        <div class="my-draw-result">
          ${myNumbersHtml(p.winNumber)}
          <div class="draw-encourage">
            <div>😊 本期未中选，好运还在后面！</div>
            <div class="draw-encourage-sub">你的参与让抽奖更公平，继续夺宝，每次都有机会成为幸运儿！</div>
            <a href="index.html" class="btn ghost" style="margin-top:10px;display:inline-block;font-size:13px">看看其他商品 →</a>
          </div>
        </div>`
      : `<div class="draw-visit-hint">
          本期已圆满揭晓！想成为下一位幸运儿？参与还在进行的商品，人人都有机会！
          <div><a href="index.html" class="btn" style="margin-top:12px;display:inline-block;font-size:13px">去参与夺宝 →</a></div>
        </div>`;

    const proofBlock = p.proof ? `
      <div class="proof-box">
        <div class="proof-title">🔒 幸运凭据（可独立验证）</div>
        <div class="proof-row">随机源：drand 公共信标 · 第 <b>${p.proof.round}</b> 轮</div>
        <div class="proof-row">randomness：<code>${p.proof.randomness}</code></div>
        <div class="proof-row">公式：HMAC-SHA256(randomness, "${escapeHtml(p.id)}") 的前8字节按大端整数取值，对 ${p.totalShares} 取余后加1</div>
        <button class="btn ghost" style="margin-top:8px" onclick="verifyDraw('${p.id}')">验证幸运结果</button>
        <div id="verifyResult" class="proof-row" style="margin-top:6px"></div>
      </div>` : '';

    action = `
      <div class="draw-result-stage">
        <div class="draw-result-header">🎯 幸运结果</div>
        <div class="draw-result-number">
          <div class="draw-result-label">幸运号码</div>
          <div class="draw-result-num">${p.winNumber}</div>
        </div>
        ${winnerCard}
      </div>
      ${myResult}
      ${proofBlock}`;
  } else {
    let quotaTip = '';
    const quota = p.freeQuota || 0;
    {
      const poolUsed = Store.productFreeUsed(id);
      const poolLeft = Math.max(0, quota - poolUsed);
      const u = Store.currentUser();
      let mine = 0;
      if (u) {
        const myUsed = Store.myOrders()
          .filter(o => String(o.productId) === String(id))
          .reduce((s, o) => s + (o.freeUsed || 0), 0);
        mine = Math.min(poolLeft, Math.floor(u.freeCoins || 0), myUsed>0?0:1);
      }
      const alreadyUsed = u && Store.myOrders().some(
        o => String(o.productId) === String(id) && (o.freeUsed || 0) > 0
      );
      quotaTip = `<div class="free-quota-tip">
        <div>🪙 ${quota > 0 ? `免费总额度 <b>${quota}</b> 份 · 免费剩余 <b>${poolLeft}</b> 份` : '免费总额度 <b>0</b> · 免费剩余 <b>0</b>'}</div>
        <div>全场共享，先到先得；每人每商品仅限免费 <b>1</b> 份。</div>
        <div>${u ? `本次可免费参与 <b>${mine}</b> 份${alreadyUsed ? '（你已使用过本商品的免费资格）' : ''}；每人消耗 <b>1</b> 枚免费金币，其余用充值金币。` : '登录后显示本次可用免费份数。'}</div>
      </div>`;
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
      <button class="btn block" onclick="buy()">立即夺宝（$${p.price} / 份）</button>
      ${myNumbersHtml()}`;
  }

  box.innerHTML = `
    ${galleryHtml(p)}
    <div>
      <h1>${escapeHtml(p.name)}</h1>
      <div class="detail-sku">
        <span class="cat-chip">${escapeHtml(Store.categoryOf(p.category).icon)} ${escapeHtml(Store.categoryOf(p.category).name)}</span>
        <code class="sku">编号 ${escapeHtml(p.sku || '—')}</code>
      </div>
      <div class="period">${escapeHtml(p.period)} ·
        ${done ? '<span class="badge done">已揭晓</span>'
               : drawing ? '<span class="badge drawing">揭晓中</span>'
               : '<span class="badge">进行中</span>'}
        · 单价 <b>$${p.price}</b> / 份</div>
      <div class="stat-row">
        <div class="stat"><b>${p.pricingPending?'待定':p.totalShares}</b><span>总需份数</span></div>
        <div class="stat"><b>${p.soldShares}</b><span>已参与</span></div>
        <div class="stat"><b>${p.pricingPending?'待定':remain}</b><span>剩余</span></div>
      </div>
      <div class="progress"><i style="width:${percent}%"></i></div>
      <div class="progress-meta"><span>完成度 ${percent}%（满额后倒计时开奖）</span></div>
      ${p.pricingPending ? '<div class="free-quota-tip">商品价格待核实，暂未开放参与</div>' : action}
      <p class="desc">${escapeHtml(p.desc || '')}</p>
      ${specsHtml(p)}
    </div>
    ${longDetailHtml(p)}`;

  if (drawing) {
    _clearSlot();
    _slotTimer = setInterval(() => {
      const el = document.getElementById('slot-reel');
      if (!el) { _clearSlot(); return; }
      el.textContent = Math.floor(Math.random() * p.totalShares) + 1;
    }, 80);
    startDrawCountdown();
  } else {
    _clearSlot();
    _clearDrawCountdown();
  }
}

let _drawCountdownTimer = null;
function _clearDrawCountdown() { if (_drawCountdownTimer) { clearInterval(_drawCountdownTimer); _drawCountdownTimer = null; } }
function startDrawCountdown() {
  _clearDrawCountdown();
  const el = document.getElementById('draw-countdown');
  if (!el) return;
  const dt = Number(el.dataset.drawTime);
  function tick() {
    const left = dt - Date.now();
    if (left <= 0) {
      el.remove();
      const hdr = document.querySelector('.drawing-header');
      if (hdr) hdr.textContent = '🎲 正在揭晓幸运儿';
      _clearDrawCountdown();
      return;
    }
    const min = Math.floor(left / 60000);
    const sec = Math.floor((left % 60000) / 1000);
    el.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  tick();
  _drawCountdownTimer = setInterval(tick, 1000);
}

// 图册：主图 + 缩略图；无图时退化为原来的 emoji 大图
function galleryHtml(p) {
  const g = (p.gallery || []).filter(m => m.type === 'image' || m.type === 'video');
  if (!g.length) return `<div class="big-thumb">${escapeHtml(p.img || '🎁')}</div>`;
  const main = g[0];
  const mainHtml = main.type === 'video'
    ? `<video id="gmain" src="${escapeHtml(main.url)}" controls playsinline></video>`
    : `<img id="gmain" src="${escapeHtml(main.url)}" alt="${escapeHtml(p.name)}">`;
  const thumbs = g.map((m, i) => `
    <div class="g-thumb ${i === 0 ? 'active' : ''}" onclick="pickMedia(${i})">
      ${m.type === 'video' ? '<span class="g-play">▶</span>' : `<img src="${escapeHtml(m.url)}" alt="">`}
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
    ${s.map(r => `<tr><th>${escapeHtml(r.k)}</th><td>${escapeHtml(r.v)}</td></tr>`).join('')}
  </table>`;
}

// 长详情：图册里第 2 张起的图片竖排铺开（亚马逊详情长图风格）
function longDetailHtml(p) {
  const imgs = (p.gallery || []).filter(m => m.type === 'image').slice(1);
  if (!imgs.length) return '';
  return `<div class="long-detail">
    <h2 class="ld-title">商品详情</h2>
    ${imgs.map(m => `<img src="${escapeHtml(m.url)}" alt="${escapeHtml(p.name)} 详情图" loading="lazy">`).join('')}
  </div>`;
}

// 切换主图
function pickMedia(i) {
  const p = Store.getProduct(id);
  const g = (p.gallery || []).filter(m => m.type === 'image' || m.type === 'video');
  const m = g[i]; if (!m) return;
  const wrap = document.querySelector('.g-main');
  wrap.innerHTML = m.type === 'video'
    ? `<video id="gmain" src="${escapeHtml(m.url)}" controls autoplay playsinline></video>`
    : `<img id="gmain" src="${escapeHtml(m.url)}" alt="">`;
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

let buying=false;
async function buy() {
  if(buying)return;buying=true;
  try {
  if (!requireLogin()) return;
  const count = parseInt(document.getElementById('qty').value, 10) || 0;
  if (count < 1) { toast('请选择至少 1 份'); return; }

  const p = Store.getProduct(id);
  const u = Store.currentUser();
  const myUsedFree = Store.myOrders().filter(o => o.productId === id).reduce((s, o) => s + (o.freeUsed || 0), 0) > 0;
  const quota = p.freeQuota || 0;
  const poolLeft = Math.max(0, quota - (p.freeUsed || 0));
  const canUseFree = u.freeCoins >= 1 && poolLeft > 0 && !myUsedFree;

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
  } finally {buying=false;}
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

async function fillAddress(productId) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'coin-choice-mask';
    mask.innerHTML = `
      <div class="coin-choice-modal" style="max-width:380px">
        <div class="coin-choice-title">🎉 填写收货信息</div>
        <div style="margin:12px 0;font-size:13px;color:#666">请填写收货地址，我们将尽快安排发货</div>
        <div style="display:flex;flex-direction:column;gap:10px">
          <input id="addr-name" placeholder="收件人姓名" style="padding:10px;border:1px solid #ddd;border-radius:6px">
          <input id="addr-phone" placeholder="联系电话" style="padding:10px;border:1px solid #ddd;border-radius:6px">
          <input id="addr-country" placeholder="国家/地区（可选）" style="padding:10px;border:1px solid #ddd;border-radius:6px">
          <textarea id="addr-detail" placeholder="详细收货地址" rows="3" style="padding:10px;border:1px solid #ddd;border-radius:6px;resize:none"></textarea>
        </div>
        <div style="margin-top:14px;display:flex;gap:10px">
          <button class="btn" id="addr-submit" style="flex:1">提交</button>
          <button class="btn ghost" id="addr-cancel" style="flex:1">取消</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    mask.querySelector('#addr-cancel').onclick = () => { mask.remove(); resolve(); };
    mask.querySelector('#addr-submit').onclick = async () => {
      const name = mask.querySelector('#addr-name').value.trim();
      const phone = mask.querySelector('#addr-phone').value.trim();
      const address = mask.querySelector('#addr-detail').value.trim();
      const country = mask.querySelector('#addr-country').value.trim();
      if (!name || !address) { toast('请填写收件人和地址'); return; }
      const r = await Store.saveAddress(productId, { name, phone, address, country });
      toast(r.msg || (r.ok ? '已提交' : '提交失败'));
      if (!r.ok) return;
      mask.remove();
      if (r.ok) { await Store.refreshProduct(id); render(); }
      resolve();
    };
  });
}

async function verifyDraw(pid) {
  const box = document.getElementById('verifyResult');
  if (box) box.textContent = '验证中…';
  const r = await Store.verifyProof(pid);
  if (!box) return;
  if (!r.ok && r.msg) { box.textContent = r.msg; return; }
  box.innerHTML = r.ok
    ? `<span style="color:var(--ok)">✓ 信标签名验证通过，号码复算一致：用第 ${r.round} 轮随机数复算得号 ${r.recomputed}，与公示一致。</span>`
    : `<span style="color:#c62828">✗ 复算得 ${r.recomputed}，与公示号 ${r.stored} 不符！</span>`;
}

// 开奖中：自动轮询刷新，等 drand 那一轮产生后自动显示结果
let _pollTimer = null;
let _polling = false;
async function autoPoll() {
  clearTimeout(_pollTimer);
  _pollTimer = null;
  if (_polling || document.hidden) return;
  const p = Store.getProduct(id);
  if (p && p.status === 'drawing') {
    _polling = true;
    try {
      await Store.refreshProduct(id);
      render();
    } finally {
      _polling = false;
      if (!document.hidden && Store.getProduct(id)?.status === 'drawing')
        _pollTimer = setTimeout(autoPoll, 5000);
    }
  }
}
document.addEventListener('visibilitychange', autoPoll);

onReady(() => {
  renderTopbar('home');
  render();
  autoPoll();
});
