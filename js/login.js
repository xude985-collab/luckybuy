/* 登录 / 注册页 */
const refCode = (param('ref') || '').trim();          // 邀请码（来自分享链接）
let mode = (param('mode') === 'register' || refCode) ? 'register' : 'login';
const back = param('back') || 'index.html';

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
      <input id="account" placeholder="邮箱 或 手机号">
      <input id="password" type="password" placeholder="密码（至少 4 位）">
      ${isReg ? `
      <div class="code-row">
        <input id="code" placeholder="验证码" maxlength="6" inputmode="numeric">
        <button type="button" id="sendCodeBtn" class="btn ghost" onclick="sendCode()">获取验证码</button>
      </div>
      <input id="invite" placeholder="邀请码（选填）" maxlength="6"
             value="${refCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}"
             style="text-transform:uppercase">` : ''}
      <button class="btn block" onclick="submit()">
        ${isReg ? '注册并登录' : '登录'}</button>
      <p class="auth-hint">${isReg
        ? '注册即同意夺宝规则。演示环境，密码仅存本地浏览器。'
        : '还没有账号？点上方“注册”。'}</p>
    </div>`;
}

function switchMode(m) { mode = m; render(); }

let cdTimer = null;
async function sendCode() {
  const account = document.getElementById('account').value;
  const r = await Store.sendCode(account);
  toast(r.msg);
  if (!r.ok) return;
  // 开发模式：后端回显验证码时自动填入（生产环境后端不返回 code）
  if (r.code) {
    document.getElementById('code').value = r.code;
    toast(`验证码：${r.code}（真实环境会发到你的${r.type === 'email' ? '邮箱' : '手机'}）`);
  }
  // 60 秒倒计时
  const btn = document.getElementById('sendCodeBtn');
  let left = 60;
  btn.disabled = true;
  clearInterval(cdTimer);
  cdTimer = setInterval(() => {
    btn.textContent = `${left}s 后重发`;
    if (left-- <= 0) { clearInterval(cdTimer); btn.disabled = false; btn.textContent = '获取验证码'; }
  }, 1000);
}

async function submit() {
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
}

onReady(() => { renderTopbar('home'); render(); });
