/* 充值页：套餐选择 + 自定义金额 + 支付方式 */
let packages = [];
let selectedAmount = 0;
let selectedBonus = 0;
let selectedMethod = 'stripe';

function renderResult() {
  const result = param('result');
  if (!result) return false;
  const app = document.getElementById('recharge-app');
  if (result === 'success') {
    app.innerHTML = `
      <div class="recharge-result success">
        <div class="result-icon">✅</div>
        <h2>充值成功</h2>
        <p>金币已到账，快去夺宝吧！</p>
        <a href="index.html" class="btn">去夺宝</a>
        <a href="recharge.html" class="btn ghost" style="margin-left:12px">继续充值</a>
      </div>`;
  } else {
    app.innerHTML = `
      <div class="recharge-result cancel">
        <div class="result-icon">❌</div>
        <h2>支付已取消</h2>
        <p>未完成支付，金币未到账。</p>
        <a href="recharge.html" class="btn">重新充值</a>
      </div>`;
  }
  return true;
}

function render() {
  if (renderResult()) return;
  if (!requireLogin()) return;

  const u = Store.currentUser();
  const app = document.getElementById('recharge-app');

  const pkgCards = packages.map(p => {
    const active = selectedAmount === p.amount ? 'active' : '';
    const bonusTag = p.bonus > 0 ? `<span class="pkg-bonus">送 $${p.bonus}</span>` : '';
    return `<div class="pkg-card ${active}" onclick="selectPkg(${p.amount}, ${p.bonus})">
      <div class="pkg-amount">$${p.amount}</div>
      ${bonusTag}
    </div>`;
  }).join('');

  app.innerHTML = `
    <div class="recharge-balance">
      当前余额：<b>$${Store.totalCoins(u)}</b>
    </div>

    <div class="recharge-section">
      <h3>选择套餐</h3>
      <div class="pkg-grid">${pkgCards}</div>
    </div>

    <div class="recharge-section">
      <h3>自定义金额</h3>
      <div class="custom-amount">
        <span class="dollar">$</span>
        <input id="custom-amt" type="number" min="1" max="5000" placeholder="输入金额（1~5000）"
          oninput="onCustomInput(this.value)">
      </div>
    </div>

    <div class="recharge-section">
      <h3>支付方式</h3>
      <div class="pay-methods">
        <div class="pay-method ${selectedMethod === 'stripe' ? 'active' : ''}" onclick="selectMethod('stripe')">
          <span class="pay-icon">💳</span>
          <span>信用卡 / 借记卡</span>
          <span class="pay-via">via Stripe</span>
        </div>
        <div class="pay-method ${selectedMethod === 'paypal' ? 'active' : ''}" onclick="selectMethod('paypal')">
          <span class="pay-icon">🅿️</span>
          <span>PayPal</span>
          <span class="pay-via">PayPal Checkout</span>
        </div>
      </div>
    </div>

    <div class="recharge-summary">
      ${selectedAmount > 0
        ? `<span>充值 <b>$${selectedAmount}</b> 到账充值金币${selectedBonus > 0 ? `，另赠 <b>$${selectedBonus}</b> 免费金币` : ''}</span>`
        : '<span style="color:var(--muted)">请选择套餐或输入金额</span>'}
    </div>

    <button class="btn block recharge-btn" onclick="doPay()" ${selectedAmount < 1 ? 'disabled' : ''}>
      立即支付 ${selectedAmount > 0 ? '$' + selectedAmount : ''}
    </button>`;
}

function selectPkg(amount, bonus) {
  selectedAmount = amount;
  selectedBonus = bonus;
  render();
}

function onCustomInput(val) {
  const n = Math.floor(Number(val) || 0);
  if (n >= 1) {
    selectedAmount = n;
    const pkg = packages.find(p => p.amount === n);
    selectedBonus = pkg ? (pkg.bonus || 0) : 0;
  } else {
    selectedAmount = 0;
    selectedBonus = 0;
  }
  render();
}

function selectMethod(m) {
  selectedMethod = m;
  render();
}

async function doPay() {
  if (selectedAmount < 1) { toast('请选择金额'); return; }
  const btn = document.querySelector('.recharge-btn');
  if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
  const r = await Store.recharge(selectedAmount, selectedMethod);
  if (r.ok && r.simulated) {
    toast(r.msg);
    setTimeout(() => location.href = 'recharge.html?result=success', 500);
    return;
  }
  if (!r.ok) { toast(r.msg || '支付失败'); render(); }
}

onReady(async () => {
  renderTopbar('home');
  if (param('result')) { render(); return; }
  packages = await Store.getPackages();
  if (packages.length && !selectedAmount) {
    selectedAmount = packages[0].amount;
    selectedBonus = packages[0].bonus || 0;
  }
  render();
});
