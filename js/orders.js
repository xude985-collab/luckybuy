/* 我的记录：参与订单 + 幸运标记 + 填地址 */

function inviteCard(u) {
  const link = location.origin + location.pathname.replace(/orders\.html$/, 'login.html') + '?ref=' + u.inviteCode;
  const invites = u.invites || 0;
  const earned = (u.grants || []).filter(g => g.type === 'inviter').reduce((s, g) => s + g.coins, 0);
  return `
    <div class="invite-card">
      <div class="invite-bal">
        <span>充值金币 <b>${u.paidCoins || 0}</b></span>
        <span>免费金币 <b>${u.freeCoins || 0}</b></span>
      </div>
      <div class="invite-title">邀请好友，双方得金币</div>
      <div class="invite-code-row">
        <span class="invite-code">${u.inviteCode}</span>
        <button class="btn ghost" onclick="copyText('${u.inviteCode}')">复制邀请码</button>
      </div>
      <div class="invite-link-row">
        <input readonly value="${link}" id="inviteLink">
        <button class="btn" onclick="copyText(document.getElementById('inviteLink').value)">复制链接</button>
      </div>
      <div class="invite-stat">已成功邀请 <b>${invites}</b> 人 · 累计获得 <b>${earned}</b> 金币</div>
    </div>`;
}

function copyText(t) {
  if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast('已复制'), () => toast('复制失败，请手动复制'));
  else toast('请手动复制：' + t);
}

function render() {
  const box = document.getElementById('orders');
  if (!Store.isLoggedIn()) {
    box.innerHTML = '<div class="empty">请先 <a href="login.html" style="color:#ff5722">登录</a> 查看你的记录</div>';
    return;
  }
  const u = Store.currentUser();
  const card = inviteCard(u);
  const orders = Store.myOrders().slice().reverse();
  if (!orders.length) {
    box.innerHTML = card + '<div class="empty">还没有参与记录，去首页夺宝试试～</div>';
    return;
  }
  const rows = orders.map(o => {
    const p = Store.getProduct(o.productId);
    const revealed = p && p.status === 'revealed';
    const won = revealed && o.numbers.includes(p.winNumber);
    const nums = o.numbers.length > 10
      ? o.numbers.slice(0, 10).join(', ') + ` … 共 ${o.numbers.length} 个`
      : o.numbers.join(', ');
    let result = '进行中';
    if (revealed) {
      if (won) {
        result = o.address
          ? '<span class="win-tag">🎉 幸运中选 · 地址已提交</span>'
          : `<span class="win-tag">🎉 幸运中选</span> ` +
            `<button class="btn" style="padding:4px 12px;font-size:12px" onclick="fillAddress('${o.id}')">填地址</button>`;
      } else {
        result = '未中选';
      }
    }
    return `<tr>
      <td>${o.productName}<br><small style="color:#999">${o.period}</small></td>
      <td>${o.count} 份</td>
      <td>$${o.cost}</td>
      <td class="nums">${nums}</td>
      <td>${result}</td>
      <td><small>${o.time.slice(0, 16).replace('T', ' ')}</small></td>
    </tr>`;
  }).join('');
  box.innerHTML = card + `
    <table>
      <thead><tr>
        <th>商品</th><th>份数</th><th>花费</th><th>幸运号码</th><th>结果</th><th>时间</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function fillAddress(orderId) {
  const name = prompt('收件人姓名：'); if (!name) return;
  const phone = prompt('联系电话：'); if (!phone) return;
  const addr = prompt('详细收货地址：'); if (!addr) return;
  const r = await Store.saveAddress(orderId, { name, phone, addr });
  toast(r.msg);
  render();
}

onReady(() => { renderTopbar('orders'); render(); });
