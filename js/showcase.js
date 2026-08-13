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
  const likedCls = s.liked ? ' liked' : '';

  wrap.innerHTML = `
    <div class="sc-media">${media}</div>
    <div class="sc-info">
      <div class="sc-product">
        <span class="emoji">${s.emoji || '🎁'}</span>
        <span class="name">${esc(s.product_name || '')}</span>
      </div>
      ${s.caption ? `<div class="sc-caption">${esc(s.caption)}</div>` : ''}
      <div class="sc-bottom">
        <div class="sc-meta">👤 ${esc(s.user_name || '幸运用户')} · ${time}</div>
        <button class="like-btn${likedCls}" id="like-btn" onclick="toggleLike('${id}')">
          <span class="like-icon">${s.liked ? '❤️' : '🤍'}</span>
          <span class="like-count" id="like-count">${s.likes || 0}</span>
        </button>
      </div>
    </div>`;
});

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

async function toggleLike(scId) {
  if (!Store.isLoggedIn()) { toast('请先登录'); return; }
  const btn = document.getElementById('like-btn');
  btn.disabled = true;
  const r = await Store.toggleShowcaseLike(scId);
  if (r.ok) {
    btn.classList.toggle('liked', r.liked);
    btn.querySelector('.like-icon').textContent = r.liked ? '❤️' : '🤍';
    document.getElementById('like-count').textContent = r.likes;
  } else {
    toast(r.msg || '操作失败');
  }
  btn.disabled = false;
}
