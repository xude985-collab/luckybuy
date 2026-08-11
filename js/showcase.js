onReady(async () => {
  renderTopbar('');
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const wrap = document.getElementById('sc-content');
  if (!id) { wrap.innerHTML = '<div class="empty">参数错误</div>'; return; }

  const s = await Store.getShowcase(id);
  if (!s) { wrap.innerHTML = '<div class="empty">晒单不存在或已被删除</div>'; return; }

  const media = s.media_type === 'video'
    ? `<video src="${s.media_url}" controls playsinline></video>`
    : `<img src="${s.media_url}" alt="">`;

  const time = new Date(Number(s.created_at)).toLocaleString('zh-CN');

  wrap.innerHTML = `
    <div class="sc-media">${media}</div>
    <div class="sc-info">
      <div class="sc-product">
        <span class="emoji">${s.emoji || '🎁'}</span>
        <span class="name">${esc(s.product_name || '')}</span>
      </div>
      ${s.caption ? `<div class="sc-caption">${esc(s.caption)}</div>` : ''}
      <div class="sc-meta">👤 ${esc(s.user_name || '幸运用户')} · ${time}</div>
    </div>
    <div class="comments-section">
      <h3>💬 留言</h3>
      <div id="comment-list" class="comment-list"><div class="empty">加载中...</div></div>
      <div id="comment-form"></div>
    </div>`;

  loadComments(id);
  renderCommentForm(id);
});

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

async function loadComments(scId) {
  const list = document.getElementById('comment-list');
  const comments = await Store.getShowcaseComments(scId);
  if (!comments.length) {
    list.innerHTML = '<div class="empty">暂无留言，快来第一个留言吧~</div>';
    return;
  }
  list.innerHTML = comments.map(c => {
    const t = new Date(Number(c.created_at)).toLocaleString('zh-CN');
    return `<div class="comment-item">
      <span class="comment-user">👤 ${esc(c.user_name || '用户')}</span>
      <span class="comment-time">${t}</span>
      <div class="comment-text">${esc(c.content)}</div>
    </div>`;
  }).join('');
}

function renderCommentForm(scId) {
  const form = document.getElementById('comment-form');
  if (!Store.isLoggedIn()) {
    form.innerHTML = '<div style="text-align:center;color:var(--muted);font-size:14px"><a href="login.html" style="color:var(--brand)">登录</a> 后可以留言</div>';
    return;
  }
  form.innerHTML = `
    <div class="comment-form">
      <textarea id="comment-input" placeholder="说点什么..." maxlength="500"></textarea>
      <button class="btn" onclick="submitComment('${scId}')">发送</button>
    </div>`;
}

async function submitComment(scId) {
  const input = document.getElementById('comment-input');
  const content = input.value.trim();
  if (!content) return;
  input.disabled = true;
  const r = await Store.postShowcaseComment(scId, content);
  if (r.ok) {
    input.value = '';
    await loadComments(scId);
  } else {
    toast(r.msg || '发送失败');
  }
  input.disabled = false;
}
