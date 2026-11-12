/* 登录 / 注册页 */
const refCode = (param('ref') || '').trim();          // 邀请码（来自分享链接）
let mode = (param('mode') === 'register' || refCode) ? 'register' : 'login';
function safeReturnPath(value) {
  try {
    const url = new URL(value || 'index.html', location.href);
    if (url.origin !== location.origin || !/^\/(?:index|detail|orders|profile|recharge|rules|showcase|winners|admin)(?:\.html)?$/.test(url.pathname)) {
      return 'index.html';
    }
    return url.pathname + url.search + url.hash;
  } catch (_) { return 'index.html'; }
}
const back = safeReturnPath(param('back'));

function render() {
  const box = document.getElementById('auth');
  const isReg = mode === 'register';
  box.innerHTML = `
    <div class="auth-card">
      <div class="auth-tabs">
        <span class="${!isReg ? 'on' : ''}" onclick="switchMode('login')">登录</span>
        <span class="${isReg ? 'on' : ''}" onclick="switchMode('register')">注册</span>
      </div>
      ${isReg ? `<input id="name" placeholder="昵称（可选）">` : ''}
      <input id="account" autocomplete="username" aria-label="账号" placeholder="${isReg ? '邮箱（短信注册暂未开通）' : '邮箱或已有手机号'}">
      <input id="password" type="password" autocomplete="${isReg ? 'new-password' : 'current-password'}" aria-label="密码" placeholder="${isReg ? '新密码至少8位' : '请输入密码'}">
      ${isReg ? `
      <div class="code-row">
        <input id="code" placeholder="验证码" maxlength="6" inputmode="numeric">
        <button type="button" id="sendCodeBtn" class="btn ghost" onclick="sendCode()">获取验证码</button>
      </div>
      <input id="invite" placeholder="邀请码（选填）" maxlength="6"
             value="${refCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}"
             style="text-transform:uppercase">` : ''}
      <button id="submitBtn" class="btn block" onclick="submit()">
        ${isReg ? '注册并登录' : '登录'}</button>
      <p class="auth-hint">${isReg
        ? '注册即同意夺宝规则。'
        : '还没有账号？点上方“注册”。'}</p>
    </div>`;
  if (isReg) {
    updateCodeButton();
    if (Date.now() < resendAt) cdTimer = setInterval(updateCodeButton, 1000);
  }
  box.querySelector('#password').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();submit();}});
}

function switchMode(m) {
  if (submitting || sendingCode) return;
  clearInterval(cdTimer);
  mode = m;
  render();
}

let cdTimer = null;
let sendingCode = false;
let resendAt = 0;
function updateCodeButton() {
  const btn = document.getElementById('sendCodeBtn');
  if (!btn) return;
  const left = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
  btn.disabled = sendingCode || left > 0;
  btn.textContent = sendingCode ? '正在发送…' : left ? `${left}s 后重发` : '获取验证码';
  if (!left) clearInterval(cdTimer);
}
async function sendCode() {
  if (sendingCode || Date.now() < resendAt) return;
  const account = document.getElementById('account').value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(account)) {
    toast('请输入正确的邮箱');
    return;
  }
  sendingCode = true;
  updateCodeButton();
  try {
    const r = await Store.sendCode(account);
    toast(r.msg);
    if (!r.ok) return;
    const input = document.getElementById('code');
    if (r.code && input) input.value = r.code;
    resendAt = Date.now() + 60000;
    clearInterval(cdTimer);
    cdTimer = setInterval(updateCodeButton, 1000);
  } catch (_) {
    toast('验证码发送失败，请稍后重试');
  } finally {
    sendingCode = false;
    updateCodeButton();
  }
}

let submitting = false;
async function submit() {
  if (submitting || sendingCode) return;
  submitting = true;
  const button = document.getElementById('submitBtn');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '正在连接，请稍候…';
  try {
  const account = document.getElementById('account').value;
  const password = document.getElementById('password').value;
  let r;
  if (mode === 'register') {
    const name = document.getElementById('name').value;
    const code = document.getElementById('code').value;
    const invite = document.getElementById('invite').value;
    r = await Store.register({ account, password, name, code, invite });
  } else {
    r = await Store.login(account, password);
  }
  toast(r.msg);
  if (r.ok) setTimeout(() => location.href = back, 500);
  } catch (_) {
    toast('连接失败，请稍后重试');
  } finally {
    submitting = false;
    button.disabled = false;
    button.textContent = label;
  }
}

// Render the form immediately even when the session endpoint is slow.
renderTopbar('home');
render();
Store.ready.then(() => renderTopbar('home'));
