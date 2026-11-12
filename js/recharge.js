/* 充值页：套餐选择 + 自定义金额 + 支付方式 */
let packages = [];
let selectedAmount = 0;
let selectedBonus = 0;
let selectedMethod = 'stripe';
let paying=false;
let testCreditAccount = '';
let testCreditUserId = '';
let testUsersPromise = null;
let methods={stripe:false,paypal:false};

function renderResult() {
  const result = param('result');
  if (!result) return false;
  const app = document.getElementById('recharge-app');
  if (result === 'success' || result === 'pending') {
    app.innerHTML = `
      <div class="recharge-result success">
        <div class="result-icon">✅</div>
        <h2 id="payment-status-title">正在确认到账状态</h2>
        <p id="payment-status-message">请稍候，以服务器确认结果为准。</p>
        <a href="index.html" class="btn">去夺宝</a>
        <a href="recharge.html" class="btn ghost" style="margin-left:12px">继续充值</a>
      </div>`;
    confirmRecharge();
  } else if (result === 'pending') {
    app.innerHTML = '<div class="recharge-result"><h2>支付仍在确认中</h2><p>请检查支付平台的扣款记录，确认前请勿重复支付。</p><a href="profile.html" class="btn">查看余额</a></div>';
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

async function confirmRecharge() {
  const id = param('id');
  const title = document.getElementById('payment-status-title');
  const message = document.getElementById('payment-status-message');
  if (!id) {
    title.textContent = '暂无法确认充值记录';
    message.textContent = '请前往个人中心查看余额。';
    return;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = attempt===0 ? await Store.refreshRecharge(id) : await Store.getRechargeStatus(id);
    if (!r.ok) { title.textContent = '查询失败'; message.textContent = r.msg || '请刷新重试'; return; }
    if (r.recharge.status === 'paid') {
      title.textContent = '充值成功'; message.textContent = '金币已到账。';
      await Store.refreshMe(); renderTopbar('home'); return;
    }
    if (r.recharge.status === 'failed') {
      title.textContent = '充值未完成'; message.textContent = '如已扣款，请联系管理员核对。'; return;
    }
    if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 2000));
  }
  title.textContent = '支付仍在确认中'; message.textContent = '到账可能稍有延迟，请稍后刷新确认，勿重复支付。';
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

    ${u.isAdmin ? `<div class="recharge-section" id="test-credit">
      <h3>测试充值（无需付款）</h3>
      <label for="test-account">充值给</label>
      <select id="test-account" aria-label="测试充值用户" style="display:block;width:100%;max-width:100%;min-height:44px;margin-top:8px" onchange="testCreditAccount=this.selectedOptions[0].dataset.account;testCreditUserId=this.value">
        <option value="${escapeHtml(u.id)}" data-account="${escapeHtml(u.account)}">自己 · ${escapeHtml(u.name)}（${escapeHtml(u.account)}）</option>
      </select><small id="test-user-status" role="status">正在读取其他用户…</small>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        ${[10,100,1000,5000].map(n=>`<button class="btn ghost" onclick="testCredit(${n})">+${n} 金币</button>`).join('')}
      </div><p id="test-credit-result" role="status"></p>
    </div>` : ''}
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
      <p>${!methods.stripe&&!methods.paypal?'支付服务暂未开通，请稍后再来；您的余额不受影响。':''}</p><div class="pay-methods">
        <div class="pay-method ${selectedMethod === 'stripe' ? 'active' : ''}" role="button" aria-disabled="${!methods.stripe}" onclick="selectMethod('stripe')">
          <span class="pay-icon">💳</span>
          <span>信用卡 / 借记卡${methods.stripe?'':'（未开通）'}</span>
          <span class="pay-via">via Stripe</span>
        </div>
        <div class="pay-method ${selectedMethod === 'paypal' ? 'active' : ''}" role="button" aria-disabled="${!methods.paypal}" onclick="selectMethod('paypal')">
          <span class="pay-icon">🅿️</span>
          <span>PayPal${methods.paypal?'':'（未开通）'}</span>
          <span class="pay-via">PayPal Checkout</span>
        </div>
      </div>
    </div>

    <div class="recharge-summary">
      ${selectedAmount > 0
        ? `<span>充值 <b>$${selectedAmount}</b> 到账充值金币${selectedBonus > 0 ? `，另赠 <b>$${selectedBonus}</b> 免费金币` : ''}</span>`
        : '<span style="color:var(--muted)">请选择套餐或输入金额</span>'}
    </div>

    <button class="btn block recharge-btn" onclick="doPay()" ${selectedAmount < 1 || !methods[selectedMethod] || paying ? 'disabled' : ''}>
      立即支付 ${selectedAmount > 0 ? '$' + selectedAmount : ''}
    </button><section style="margin-top:24px"><h3>充值记录</h3><div id="recharge-history">读取中…</div></section>`;
  loadRechargeHistory();
  if(u.isAdmin)loadTestCreditUsers();
}

function selectPkg(amount, bonus) {
  if(paying)return;
  selectedAmount = amount;
  selectedBonus = bonus;
  render();
}

function onCustomInput(val) {
  const n = Number(val);
  if (Number.isSafeInteger(n) && n >= 1 && n<=5000) {
    selectedAmount = n;
    const pkg = packages.find(p => p.amount === n);
    selectedBonus = pkg ? (pkg.bonus || 0) : 0;
  } else {
    selectedAmount = 0;
    selectedBonus = 0;
  }
  updateSummary();
}

function selectMethod(m) {
  if(paying)return;
  if(!methods[m]){toast('此支付方式暂未开通');return;}
  selectedMethod = m;
  render();
}

function updateSummary() {
  document.querySelectorAll('.pkg-card').forEach((card, i) => card.classList.toggle('active', packages[i].amount === selectedAmount));
  const summary = document.querySelector('.recharge-summary');
  if (summary) summary.textContent = selectedAmount > 0
    ? `充值 $${selectedAmount}，赠送 ${selectedBonus} 免费金币` : '请选择套餐或输入金额';
  const btn = document.querySelector('.recharge-btn');
  if (btn) {
    btn.disabled = paying || !methods[selectedMethod] || selectedAmount < 1 || selectedAmount > 5000;
    btn.textContent = `立即支付 ${selectedAmount > 0 ? '$' + selectedAmount : ''}`;
  }
}

async function doPay() {
  if(paying)return;
  if(!methods[selectedMethod]){toast('此支付方式暂未开通');return;}
  if (selectedAmount < 1) { toast('请选择金额'); return; }
  paying=true;
  const btn = document.querySelector('.recharge-btn');
  if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
  const r = await Store.recharge(selectedAmount, selectedMethod);
  if (r.ok && r.simulated) {
    toast(r.msg);
    setTimeout(() => location.href = 'recharge.html?result=success&id=' + encodeURIComponent(r.rechargeId), 500);
    return;
  }
  if (!r.ok) { paying=false;toast(r.msg || '支付失败'); render(); }
}

onReady(async () => {
  renderTopbar('home');
  if (param('result')) { render(); return; }
  packages = await Store.getPackages();
  methods=Store.paymentMethods();
  selectedMethod=methods.stripe?'stripe':methods.paypal?'paypal':'';
  if (packages.length && !selectedAmount) {
    selectedAmount = packages[0].amount;
    selectedBonus = packages[0].bonus || 0;
  }
  render();
});

async function loadRechargeHistory(){
 const box=document.getElementById('recharge-history');if(!box)return;
 const r=await Store.getRechargeHistory();if(!r.ok){box.textContent=r.msg||'读取失败';return;}
 const names={pending:'等待确认',paid:'已到账',failed:'未完成'};
 box.innerHTML=(r.recharges||[]).map(rc=>`<p>${escapeHtml(new Date(Number(rc.created_at)).toLocaleString())} · ${rc.method==='admin-test'?'测试充值（未付款） · ':''}$${rc.amount} · ${names[rc.status]||escapeHtml(rc.status)} ${rc.status==='pending'?`<a href="recharge.html?result=pending&id=${encodeURIComponent(rc.id)}">查询到账</a>`:''}</p>`).join('')||'暂无充值记录';
}

let testCrediting=false;
async function testCredit(amount){
 if(testCrediting)return;
 const select=document.getElementById('test-account');
 const account=select.selectedOptions[0].dataset.account;
 const userId=select.value;
 const storageKey='lb-test-credit-'+Store.currentUser().id;
 let pending;
 try { pending=JSON.parse(sessionStorage.getItem(storageKey)||'null'); } catch {}
 if(pending && (pending.account!==account||pending.amount!==amount||(pending.userId&&pending.userId!==userId))){
   toast('上次到账结果待确认，请用原账号和金额再点一次');return;
 }
 pending=pending||{account,userId,amount,requestKey:crypto.randomUUID()};
 sessionStorage.setItem(storageKey,JSON.stringify(pending));
 testCrediting=true;
 select.disabled=true;
 const buttons=document.querySelectorAll('#test-credit button');buttons.forEach(b=>b.disabled=true);
 const result=document.getElementById('test-credit-result');result.textContent='正在到账…';
 try{
  const r=await Store.request('POST','/admin/test-recharge',pending);
  if(r.ok||!r.uncertain)sessionStorage.removeItem(storageKey);
  result.textContent=r.msg||'请点击原金额重试确认';toast(result.textContent);
  if(r.ok){await Store.refreshMe();renderTopbar('home');document.querySelector('.recharge-balance b').textContent='$'+Store.totalCoins(Store.currentUser());await loadRechargeHistory();}
 }finally{testCrediting=false;select.disabled=false;buttons.forEach(b=>b.disabled=false);}
}

async function loadTestCreditUsers(){
 const select=document.getElementById('test-account'),status=document.getElementById('test-user-status');
 if(!select)return;
 if(!testUsersPromise)testUsersPromise=(async()=>{
  const users=[];let page=1,pages=1;
  do{const r=await Store.request('GET','/admin/users?page='+page);if(!r.ok)throw new Error(r.msg||'用户列表读取失败');users.push(...(r.users||[]));pages=r.pages||1;page++;}while(page<=pages);
  return users;
 })().catch(e=>{testUsersPromise=null;throw e;});
 try{
  const users=await testUsersPromise;if(!select.isConnected)return;
  for(const u of users){if(u.disabled||u.id===Store.currentUser().id)continue;const option=new Option(`${u.name||'未设置昵称'}（${u.account}）`,u.id);option.dataset.account=u.account;select.add(option);}
  if(testCreditUserId&&[...select.options].some(o=>o.value===testCreditUserId))select.value=testCreditUserId;
  status.textContent='选择用户后，点击下方金额即可到账。';
 }catch(e){if(status.isConnected)status.textContent=e.message+'，请刷新重试；仍可给自己充值。';}
}
