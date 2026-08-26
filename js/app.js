/**
 * 五中校园论坛 - 前端主逻辑
 *
 * 路由（hash 路由，location.hash 变更触发 route()）：
 *   #home                首页 - 帖子列表（已登录/未登录都能看）
 *   #login               登录
 *   #register            注册
 *   #post                发新帖（需登录）
 *   #detail/:id          帖子详情 + 评论区 + 楼中楼 + 点赞/收藏
 *   #me                  个人中心（我的帖 / 我点赞 / 我收藏 三个 tab）
 *   #messages            私信（会话列表 + 对话窗 + 发起新对话）
 *   #announcements       公告历史（所有公告列表）
 *
 * 全局行为：
 *   - 页面加载时：调 /api/auth/me 静默刷新 token，过期即清登录态
 *   - 已登录用户：拉未读公告 → 逐条弹窗"已读/下一条"
 *   - 已登录用户：每 60 秒刷新一次未读消息数，顶栏显示红点
 */

import * as api from './api.js?v=20260826-debugauth';

// ==================== 工具函数 ====================
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const p = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return iso; }
}
const CATEGORY_LABEL = {
  general: '综合', study: '学习', club: '社团', life: '生活', meta: '站务'
};

// ==================== 顶栏 ====================
async function renderTopBar() {
  const loggedIn = api.isLoggedIn();
  const me = loggedIn ? api.getCurrentUser() : null;
  const nav = document.getElementById('topNav');
  if (!nav) return;

  let unreadMsg = 0;
  if (loggedIn) {
    try {
      const r = await api.messages.unreadCount();
      if (r.success) unreadMsg = r.data.count || 0;
    } catch {}
  }

  if (loggedIn && me) {
    const roleBadge = me.role === 'dev_admin'
      ? `<span style="color:#dc2626;background:#fee2e2;padding:1px 6px;border-radius:4px;font-size:11px;margin-right:4px">开发管理员</span>`
      : me.role === 'admin'
        ? `<span style="color:#b45309;background:#fef3c7;padding:1px 6px;border-radius:4px;font-size:11px;margin-right:4px">管理员</span>`
        : '';
    nav.innerHTML = `
      <button class="ghost" onclick="location.hash='home'">🏠 首页</button>
      <button class="ghost" onclick="location.hash='me'">👤 我的</button>
      <button class="ghost" onclick="location.hash='announcements'">📢 公告</button>
      <button class="ghost" onclick="location.hash='messages'">
        💬 私信${unreadMsg ? `<span class="unread-badge">${unreadMsg}</span>` : ''}
      </button>
      <span class="user-nickname">${roleBadge}${escapeHtml(me.nickname)}</span>
      <button class="secondary" onclick="doLogout()">退出</button>
    `;
  } else {
    nav.innerHTML = `
      <button class="ghost" onclick="location.hash='home'">🏠 首页</button>
      <button class="ghost" onclick="location.hash='announcements'">📢 公告</button>
      <button class="secondary" onclick="location.hash='register'">注册</button>
      <button class="secondary" onclick="location.hash='login'">登录</button>
    `;
  }
}

// ==================== 视图：帖子卡片（复用在首页列表/我的帖/我的赞/我的收藏） ====================
function postCard(p, opts = {}) {
  const author = p.authorNickname || `用户${p.authorUid}`;
  const time = formatTime(p.createdAt);
  const tags = (p.tags && p.tags.length)
    ? `<div style="margin-top:6px;color:#6b7280;font-size:12px">${p.tags.map(t => `#${escapeHtml(t)}`).join(' ')}</div>`
    : '';
  const stats = `👁 ${p.viewCount || 0}　👍 ${p.likeCount || 0}　💬 ${p.commentCount || 0}`;
  const clickable = opts.allowClick ? 'clickable' : '';
  const onclickAttr = opts.allowClick ? `onclick="location.hash='#detail/${p.id}'"` : '';
  const catLabel = CATEGORY_LABEL[p.category] || p.category;
  const pinBadge = p.isPinned
    ? `<span style="color:#f59e0b;background:#fef3c7;padding:1px 6px;border-radius:4px;font-size:11px;margin-right:6px">置顶</span>`
    : '';
  return `
    <div class="card ${clickable}" ${onclickAttr} data-post-id="${p.id}">
      <div class="meta">
        ${pinBadge}<span style="color:#2563eb;background:#dbeafe;padding:1px 6px;border-radius:4px;font-size:11px;margin-right:6px">${escapeHtml(catLabel)}</span>
        <span>${escapeHtml(author)}</span>
        <span>·</span>
        <span>${escapeHtml(time)}</span>
      </div>
      <h3>${escapeHtml(p.title)}</h3>
      <p style="white-space:pre-wrap">${escapeHtml((p.content || '').slice(0, 140))}${(p.content || '').length > 140 ? '…' : ''}</p>
      ${tags}
      <div class="meta" style="margin-top:8px">${stats}</div>
    </div>
  `;
}

// ==================== 视图：首页 ====================
async function renderHome(app) {
  const loggedIn = api.isLoggedIn();
  const me = loggedIn ? api.getCurrentUser() : null;
  if (!loggedIn || !me) {
    app.innerHTML = `
      <div class="card">
        <h3>欢迎来到五中校园论坛 👋</h3>
        <p>这是一个由五中学生维护的校园论坛。你可以：</p>
        <p>📌 还没有账号？<a href="#register">去注册（只要 8 位 UID + 密码）</a></p>
        <p>🔑 已有账号？<a href="#login">直接登录</a></p>
      </div>
      <div class="card">
        <h3>技术栈</h3>
        <p>✅ 前端：Vercel 托管的纯 HTML + 原生 JS</p>
        <p>✅ 后端：Cloudflare Worker + D1（零服务器成本）</p>
        <p>✅ 密码：PBKDF2-HMAC-SHA-256 哈希（Web Crypto 内置，不裸存）</p>
        <p>✅ 认证：JWT（HMAC-SHA-256，7 天有效期）</p>
      </div>
      <div class="card">
        <h3>最新帖子</h3>
        <div id="postList" class="empty">🔄 正在读取帖子...</div>
      </div>
    `;
  } else {
    app.innerHTML = `
      <div class="toolbar">
        <span id="postCount">读取中...</span>
        <button onclick="location.hash='post'">+ 发新帖</button>
      </div>
      <div id="postList" class="empty">🔄 正在读取帖子...</div>
    `;
  }

  const listEl = document.getElementById('postList');
  try {
    const res = await api.posts.list();
    if (!res.success) {
      listEl.outerHTML = `<div class="card">❌ 加载失败：${escapeHtml(res.message)}</div>`;
      return;
    }
    const data = res.data || [];
    const total = (res.pagination || {}).total || 0;
    const countEl = document.getElementById('postCount');
    if (countEl) countEl.textContent = `共 ${total} 条帖子`;
    if (data.length === 0) {
      listEl.outerHTML = `<div class="empty">还没有帖子，快来发第一条吧</div>`;
      return;
    }
    listEl.outerHTML = data.map(p => postCard(p, { allowClick: true })).join('');
  } catch (e) {
    listEl.outerHTML = `<div class="card">❌ 网络错误：${escapeHtml(e.message)}</div>`;
  }
}

// ==================== 视图：登录 / 注册 / 发帖 ====================
function renderLogin(app) {
  app.innerHTML = `
    <div class="card">
      <h3>登录</h3>
      <input id="uidInput" placeholder="用户UID（8位数字）" maxlength="8" inputmode="numeric">
      <input id="pwdInput" type="password" placeholder="密码（至少 6 位）" autocomplete="current-password">
      <button id="loginBtn" onclick="doLogin()">登录</button>
      <p class="hint">
        还没有账号？<a href="#register">去注册 →</a><br>
        密码采用 PBKDF2-HMAC-SHA-256 哈希存储，服务器无法看到明文。
      </p>
    </div>
  `;
  document.getElementById('pwdInput').addEventListener('keydown', e => e.key === 'Enter' && doLogin());
}

function renderRegister(app) {
  app.innerHTML = `
    <div class="card">
      <h3>注册新账号</h3>
      <input id="uidInput" placeholder="UID（8位数字，一般是你的学号）" maxlength="8" inputmode="numeric">
      <input id="pwdInput" type="password" placeholder="密码（至少 6 位）" autocomplete="new-password">
      <input id="pwd2Input" type="password" placeholder="再次输入密码" autocomplete="new-password">
      <input id="nickInput" placeholder="昵称（1-20字，可选）" maxlength="20">
      <textarea id="bioInput" placeholder="个人简介（可选，200字内）" maxlength="200" style="min-height:60px"></textarea>
      <button id="regBtn" onclick="doRegister()">注册</button>
      <p class="hint">
        已经有账号？<a href="#login">直接登录 →</a><br>
        注册后 UID 不可修改，请确认填写正确。
      </p>
    </div>
  `;
  document.getElementById('pwd2Input').addEventListener('keydown', e => e.key === 'Enter' && doRegister());
}

function renderPost(app) {
  if (!api.isLoggedIn()) { location.hash = 'login'; return; }
  app.innerHTML = `
    <div class="card">
      <h3>发新帖</h3>
      <input id="titleInput" placeholder="标题（必填，100字内）" maxlength="100">
      <textarea id="contentInput" placeholder="说点什么...（必填，2000字内）" maxlength="2000"></textarea>
      <div style="margin-bottom:10px">
        <label for="catInput" style="font-size:13px;color:#424245">分区：</label>
        <select id="catInput" style="padding:6px 8px;border-radius:6px;border:1px solid #d2d2d7">
          <option value="general">综合</option>
          <option value="study">学习</option>
          <option value="club">社团</option>
          <option value="life">生活</option>
          <option value="meta">站务</option>
        </select>
      </div>
      <button id="postBtn" onclick="doPost()">发布</button>
      <button class="secondary" onclick="location.hash='home'">取消</button>
    </div>
  `;
}

// ==================== 视图：帖子详情 + 评论区 + 楼中楼 + 点赞/收藏 ====================
async function renderDetail(app, postId) {
  app.innerHTML = `<div class="card">🔄 正在加载帖子...</div>`;
  const postRes = await api.posts.byId(postId);
  if (!postRes.success) {
    app.innerHTML = `<div class="card">❌ 帖子加载失败：${escapeHtml(postRes.message)}</div>`;
    return;
  }
  const p = postRes.data;
  const me = api.isLoggedIn() ? api.getCurrentUser() : null;
  const catLabel = CATEGORY_LABEL[p.category] || p.category;

  app.innerHTML = `
    <div style="margin-bottom:10px">
      <button class="ghost" onclick="location.hash='home'">← 返回列表</button>
    </div>
    <div class="card detail-header">
      <div class="meta">
        <span style="color:#2563eb;background:#dbeafe;padding:1px 6px;border-radius:4px;font-size:11px;margin-right:6px">${escapeHtml(catLabel)}</span>
        <span>${escapeHtml(p.authorNickname || `用户${p.authorUid}`)}</span>
        <span>·</span><span>${escapeHtml(formatTime(p.createdAt))}</span>
        <span>·</span><span>👁 ${p.viewCount} 浏览</span>
      </div>
      <h2>${escapeHtml(p.title)}</h2>
      <div class="detail-body">${escapeHtml(p.content)}</div>
      <div class="action-bar">
        <button id="likeBtn" class="${p.isLiked ? 'active-like' : ''}">
          ${p.isLiked ? '♥ 已赞' : '♡ 点赞'} <span id="likeCount">${p.likeCount}</span>
        </button>
        <button id="favBtn" class="${p.isFavorited ? 'active-fav' : ''}">
          ${p.isFavorited ? '★ 已收藏' : '☆ 收藏'}
        </button>
        <button class="secondary" onclick="document.getElementById('commentInput').focus()">💬 评论 (${p.commentCount})</button>
        ${(me && (me.uid === p.authorUid || me.role === 'admin' || me.role === 'dev_admin'))
          ? `<button id="delPostBtn" class="danger">🗑 删除帖子</button>` : ''}
      </div>
    </div>

    <div class="card comments-section">
      <h3>评论 (${p.commentCount})</h3>
      ${me ? `
      <div class="comment-box">
        <textarea id="commentInput" placeholder="写下你的评论...（1000字内）" maxlength="1000"></textarea>
        <button id="submitCommentBtn">发表评论</button>
      </div>` : '<p class="hint">登录后才能评论哦～ <a href="#login">点此登录</a></p>'}
      <div id="commentList">🔄 加载评论中...</div>
    </div>
  `;

  // ---- 点赞按钮 ----
  const likeBtn = document.getElementById('likeBtn');
  likeBtn.addEventListener('click', async () => {
    likeBtn.disabled = true;
    const r = await api.likes.toggle(p.id);
    likeBtn.disabled = false;
    if (r.success) {
      const liked = r.data.liked;
      likeBtn.className = liked ? 'active-like' : '';
      likeBtn.firstChild.nodeValue = liked ? '♥ 已赞 ' : '♡ 点赞 ';
      document.getElementById('likeCount').textContent = r.data.likeCount;
    } else alert(r.message || '操作失败');
  });

  // ---- 收藏按钮 ----
  const favBtn = document.getElementById('favBtn');
  favBtn.addEventListener('click', async () => {
    favBtn.disabled = true;
    const r = await api.favorites.toggle(p.id);
    favBtn.disabled = false;
    if (r.success) {
      const fav = r.data.favorited;
      favBtn.className = fav ? 'active-fav' : '';
      favBtn.firstChild.nodeValue = fav ? '★ 已收藏' : '☆ 收藏';
    } else alert(r.message || '操作失败');
  });

  // ---- 删帖 ----
  const delPostBtn = document.getElementById('delPostBtn');
  if (delPostBtn) {
    delPostBtn.addEventListener('click', async () => {
      if (!confirm('确定要删除该帖子吗？将无法恢复。')) return;
      delPostBtn.disabled = true;
      const r = await api.posts.remove(p.id);
      if (r.success) { alert('已删除'); location.hash = 'home'; }
      else { delPostBtn.disabled = false; alert(r.message); }
    });
  }

  // ---- 提交评论 ----
  const submitCommentBtn = document.getElementById('submitCommentBtn');
  if (submitCommentBtn) {
    submitCommentBtn.addEventListener('click', () => submitComment(postId));
  }

  // ---- 拉评论 + 渲染楼中楼 ----
  loadAndRenderComments(postId);
}

async function loadAndRenderComments(postId) {
  const container = document.getElementById('commentList');
  if (!container) return;
  const res = await api.comments.byPost(postId);
  if (!res.success) { container.innerHTML = `<div class="card">❌ 评论加载失败：${escapeHtml(res.message)}</div>`; return; }
  const all = res.data || [];
  if (all.length === 0) { container.innerHTML = `<div class="empty" style="padding:20px">还没有评论，快来抢沙发～</div>`; return; }

  // 建立索引
  const byId = new Map(all.map(c => [c.id, c]));
  // 计算父子关系
  const childrenOf = new Map();
  const rootComments = [];
  for (const c of all) {
    if (c.replyToId && byId.has(c.replyToId)) {
      if (!childrenOf.has(c.replyToId)) childrenOf.set(c.replyToId, []);
      childrenOf.get(c.replyToId).push(c);
    } else {
      rootComments.push(c);
    }
  }

  const me = api.isLoggedIn() ? api.getCurrentUser() : null;

  function renderComment(c, isReply) {
    const deleted = c.isHidden;
    const contentHtml = deleted
      ? `<div class="comment-content deleted">（该评论已被删除）</div>`
      : `<div class="comment-content">${escapeHtml(c.content || '')}</div>`;
    const replyRef = (isReply && c.replyToId && byId.has(c.replyToId))
      ? `<div class="reply-ref">回复 <b>@${escapeHtml(c.replyToAuthorNickname || '已删除用户')}</b>：</div>`
      : '';
    const headerAuthor = deleted ? `已删除用户` : escapeHtml(c.authorNickname || `用户${c.authorUid}`);
    const canReply = me && !deleted;
    const canDelete = me && !deleted && (me.uid === c.authorUid || me.role === 'admin' || me.role === 'dev_admin');

    return `
      <div class="comment-item ${isReply ? 'reply' : ''}" data-comment-id="${c.id}">
        <div class="comment-header">
          <span><span class="comment-author">${headerAuthor}</span> · ${escapeHtml(formatTime(c.createdAt))}</span>
          ${canDelete ? `<button class="ghost danger-style" onclick="deleteComment(${c.id}, ${postId})" style="color:#ff3b30;background:none">删除</button>` : ''}
        </div>
        ${replyRef}
        ${contentHtml}
        ${canReply ? `
          <div class="comment-actions">
            <button class="ghost" onclick="toggleReplyInput(${c.id})">↩ 回复</button>
          </div>
          <div class="reply-input" id="reply-${c.id}">
            <textarea placeholder="回复 @${escapeHtml(c.authorNickname || 'TA')}..." maxlength="1000"></textarea>
            <button onclick="submitReply(${postId}, ${c.id}, this)">发送</button>
          </div>
        ` : ''}
        ${(childrenOf.get(c.id) || []).map(child => renderComment(child, true)).join('')}
      </div>
    `;
  }

  container.innerHTML = rootComments.map(c => renderComment(c, false)).join('');
}

// 评论/回复辅助（全局可用，onclick 内联调用）
window.submitComment = async function submitComment(postId) {
  const el = document.getElementById('commentInput');
  const content = (el.value || '').trim();
  if (!content) return alert('评论内容不能为空');
  const btn = document.getElementById('submitCommentBtn');
  btn.disabled = true; btn.textContent = '发送中...';
  const r = await api.comments.create({ postId, content });
  btn.disabled = false; btn.textContent = '发表评论';
  if (r.success) { el.value = ''; loadAndRenderComments(postId); }
  else alert(r.message || '评论失败');
};
window.toggleReplyInput = function toggleReplyInput(commentId) {
  const box = document.getElementById('reply-' + commentId);
  if (box) box.classList.toggle('open');
};
window.submitReply = async function submitReply(postId, replyToId, btnEl) {
  const wrap = btnEl.closest('.reply-input');
  const ta = wrap.querySelector('textarea');
  const content = (ta.value || '').trim();
  if (!content) return alert('回复内容不能为空');
  btnEl.disabled = true;
  const r = await api.comments.create({ postId, content, replyToId });
  btnEl.disabled = false;
  if (r.success) { ta.value = ''; loadAndRenderComments(postId); }
  else alert(r.message || '回复失败');
};
window.deleteComment = async function deleteComment(commentId, postId) {
  if (!confirm('确定删除这条评论吗？')) return;
  const r = await api.comments.remove(commentId);
  if (r.success) loadAndRenderComments(postId);
  else alert(r.message || '删除失败');
};

// ==================== 视图：个人中心（我的帖 / 我点赞 / 我收藏） ====================
async function renderMe(app) {
  if (!api.isLoggedIn()) { location.hash = 'login'; return; }
  const me = api.getCurrentUser();

  const initials = (me.nickname || me.uid).slice(0, 1).toUpperCase();
  app.innerHTML = `
    <div class="profile-header">
      <div class="avatar-lg">${escapeHtml(initials)}</div>
      <div style="flex:1">
        <div class="profile-name">${escapeHtml(me.nickname)}${me.role === 'dev_admin' ? ' <span style="background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:4px;font-size:11px;margin-left:6px">开发管理员</span>' : ''}${me.role === 'admin' ? ' <span style="background:#fef3c7;color:#b45309;padding:1px 6px;border-radius:4px;font-size:11px;margin-left:6px">管理员</span>' : ''}</div>
        <div class="profile-uid">UID：${escapeHtml(me.uid)}　角色：${escapeHtml(me.role || 'member')}</div>
        ${me.bio ? `<div class="profile-bio">${escapeHtml(me.bio)}</div>` : ''}
      </div>
    </div>
    <div class="toolbar">
      <div class="tab-bar">
        <button id="tabMine" class="on" onclick="switchMeTab('mine')">📝 我发的帖</button>
        <button id="tabLikes" onclick="switchMeTab('likes')">♥ 点赞过</button>
        <button id="tabFav" onclick="switchMeTab('favorites')">★ 我的收藏</button>
      </div>
      <button class="secondary" onclick="location.hash='post'">+ 发新帖</button>
    </div>
    <div id="meContent"><div class="empty">🔄 加载中...</div></div>
  `;
  window._currentMeTab = 'mine';
  loadMeTab('mine');
}

window.switchMeTab = function switchMeTab(tab) {
  ['mine', 'likes', 'favorites'].forEach(t => {
    document.getElementById('tab' + (t === 'mine' ? 'Mine' : t[0].toUpperCase() + t.slice(1)))
      .classList.toggle('on', t === tab);
  });
  window._currentMeTab = tab;
  loadMeTab(tab);
};
async function loadMeTab(tab) {
  const host = document.getElementById('meContent');
  if (!host) return;
  host.innerHTML = `<div class="empty">🔄 加载中...</div>`;
  try {
    let res;
    if (tab === 'mine') res = await api.posts.mine();
    else if (tab === 'likes') res = await api.likes.mine();
    else res = await api.favorites.mine();

    if (!res.success) {
      host.innerHTML = `<div class="card">❌ 加载失败：${escapeHtml(res.message)}</div>`;
      return;
    }
    const data = res.data || [];
    if (data.length === 0) {
      const labels = { mine: '你还没发过帖子，去首页点「发新帖」开始吧！', likes: '还没给任何帖子点过赞～', favorites: '还没收藏过任何帖子～' };
      host.innerHTML = `<div class="empty">${labels[tab] || '暂无'}</div>`;
      return;
    }
    host.innerHTML = data.map(p => postCard(p, { allowClick: true })).join('');
  } catch (e) {
    host.innerHTML = `<div class="card">❌ 网络错误：${escapeHtml(e.message)}</div>`;
  }
}

// ==================== 视图：私信（会话列表 + 对话窗） ====================
async function renderMessages(app) {
  if (!api.isLoggedIn()) { location.hash = 'login'; return; }
  app.innerHTML = `
    <div class="messages-layout">
      <div class="conv-list">
        <div class="new-dm-row">
          <input id="newDmUid" placeholder="输入对方 8 位 UID 发起对话" maxlength="8" inputmode="numeric">
          <button class="ghost" onclick="startNewConversation()">开始</button>
        </div>
        <div id="convList">🔄 读取会话...</div>
      </div>
      <div class="msg-pane" id="msgPane">
        <h3 id="msgTitle">请选择会话开始聊天</h3>
        <div class="msg-list" id="msgList"><div style="color:#86868b;text-align:center;padding:40px">👈 在左边选择一个会话，或发起新对话</div></div>
        <div class="msg-input" id="msgInputWrap" style="display:none">
          <textarea id="msgInput" placeholder="按 Enter 发送，Shift+Enter 换行" onkeydown="msgBoxKeyDown(event)"></textarea>
          <button onclick="sendCurrentMsg()">发送</button>
        </div>
      </div>
    </div>
  `;

  // 拉会话列表
  try {
    const r = await api.messages.conversations();
    const host = document.getElementById('convList');
    if (!r.success) { host.innerHTML = `<div style="padding:12px;color:#ff3b30">❌ ${escapeHtml(r.message)}</div>`; return; }
    const list = r.data || [];
    if (list.length === 0) {
      host.innerHTML = `<div class="empty" style="padding:30px">还没有任何对话<br>在上方输入对方 UID 即可发起</div>`;
      return;
    }
    host.innerHTML = list.map(c => {
      const last = c.lastMessage ? c.lastMessage.content : '（暂无消息）';
      const badge = c.unreadCount ? `<span class="unread-badge">${c.unreadCount}</span>` : '';
      return `<div class="conv-item" onclick="openConversation('${escapeHtml(c.otherUid)}')" data-uid="${escapeHtml(c.otherUid)}">
        <div style="min-width:0;flex:1">
          <div class="conv-name">${escapeHtml(c.otherNickname)} ${badge}</div>
          <div class="conv-preview">${escapeHtml(last.slice(0, 24))}</div>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    document.getElementById('convList').innerHTML = `<div style="padding:12px;color:#ff3b30">❌ ${escapeHtml(e.message)}</div>`;
  }
}

window.startNewConversation = function startNewConversation() {
  const uid = (document.getElementById('newDmUid').value || '').trim();
  if (!/^\d{8}$/.test(uid)) { alert('请输入 8 位数字 UID'); return; }
  if (api.isLoggedIn() && uid === api.getCurrentUser().uid) { alert('不能和自己对话'); return; }
  openConversation(uid);
};
function highlightConvItem(otherUid) {
  document.querySelectorAll('.conv-item').forEach(it => {
    it.classList.toggle('on', it.dataset.uid === otherUid);
  });
}
window.openConversation = async function openConversation(otherUid) {
  window._currentConvOther = otherUid;
  highlightConvItem(otherUid);
  const titleEl = document.getElementById('msgTitle');
  titleEl.textContent = `与 ${otherUid} 的对话`;
  document.getElementById('msgInputWrap').style.display = 'flex';
  const listEl = document.getElementById('msgList');
  listEl.innerHTML = `<div style="color:#86868b;text-align:center;padding:40px">🔄 加载聊天记录...</div>`;
  const r = await api.messages.withUser(otherUid);
  if (!r.success) { listEl.innerHTML = `<div style="padding:20px;color:#ff3b30">❌ ${escapeHtml(r.message)}</div>`; return; }
  const me = api.isLoggedIn() ? api.getCurrentUser() : null;
  const list = r.data || [];
  if (list.length === 0) {
    listEl.innerHTML = `<div style="color:#86868b;text-align:center;padding:40px">还没有任何消息，发第一条吧！</div>`;
    return;
  }
  listEl.innerHTML = list.map(m => {
    const mine = m.fromUid === me.uid;
    return `<div class="msg-bubble ${mine ? 'mine' : 'theirs'}">
      ${escapeHtml(m.content)}
      <div class="msg-meta">${escapeHtml(formatTime(m.createdAt))}${mine && m.isRead ? ' · 已读' : ''}</div>
    </div>`;
  }).join('');
  listEl.scrollTop = listEl.scrollHeight;
};
window.msgBoxKeyDown = function msgBoxKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrentMsg(); }
};
window.sendCurrentMsg = async function sendCurrentMsg() {
  const other = window._currentConvOther;
  if (!other) return;
  const ta = document.getElementById('msgInput');
  const content = (ta.value || '').trim();
  if (!content) return;
  ta.value = '';
  const r = await api.messages.send(other, content);
  if (!r.success) { alert(r.message); return; }
  // 重新拉对话（或直接 append）
  openConversation(other);
};

// ==================== 视图：公告历史（公开，无需登录） ====================
async function renderAnnouncements(app) {
  app.innerHTML = `
    <div class="toolbar">
      <span style="font-size:16px;font-weight:600">📢 全站公告</span>
    </div>
    <div id="annList"><div class="empty">🔄 加载中...</div></div>
  `;
  try {
    const r = await api.announcements.list(1, 50);
    const host = document.getElementById('annList');
    if (!r.success) { host.innerHTML = `<div class="card">❌ ${escapeHtml(r.message)}</div>`; return; }
    const list = r.data || [];
    if (list.length === 0) {
      host.innerHTML = `<div class="empty">暂时没有公告</div>`;
      return;
    }
    host.innerHTML = list.map(a => `
      <div class="card">
        <div class="meta">
          ${a.isPinned ? '<span style="color:#f59e0b;background:#fef3c7;padding:1px 6px;border-radius:4px;font-size:11px;margin-right:6px">置顶</span>' : ''}
          <span>by ${escapeHtml(a.authorNickname || '管理员')}</span>
          <span>·</span>
          <span>${escapeHtml(formatTime(a.createdAt))}</span>
        </div>
        <h3>${escapeHtml(a.title)}</h3>
        <p style="white-space:pre-wrap">${escapeHtml(a.content)}</p>
      </div>
    `).join('');
  } catch (e) {
    document.getElementById('annList').innerHTML = `<div class="card">❌ ${escapeHtml(e.message)}</div>`;
  }
}

// ==================== 登录后：未读公告逐条弹窗 ====================
async function popupUnreadAnnouncements() {
  if (!api.isLoggedIn()) return;
  let list;
  try {
    const r = await api.announcements.unread();
    if (!r.success) return;
    list = r.data || [];
  } catch { return; }
  if (list.length === 0) return;

  // 逐条展示，用户点"知道了"再下一条
  let idx = 0;
  const container = document.createElement('div');
  document.body.appendChild(container);

  function show(i) {
    const a = list[i];
    if (!a) { container.remove(); return; }
    container.innerHTML = `
      <div class="modal-mask">
        <div class="modal">
          <div class="modal-header">
            <span class="modal-title">
              📢 ${escapeHtml(a.title)}
              ${a.isPinned ? '<span class="badge-pin">置顶</span>' : ''}
            </span>
            <span style="font-size:12px;color:#86868b">${escapeHtml(formatTime(a.createdAt))}　${i + 1}/${list.length}</span>
          </div>
          <div class="modal-body">${escapeHtml(a.content)}</div>
          <div class="modal-footer">
            <span>by ${escapeHtml(a.authorNickname || '管理员')}</span>
            <button id="annCloseBtn">知道了</button>
          </div>
        </div>
      </div>
    `;
    const btn = document.getElementById('annCloseBtn');
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = '处理中...';
      await api.announcements.markRead(a.id);
      show(i + 1);
    });
  }
  show(idx);
}

// ==================== 事件处理：登录/注册/发帖 ====================
window.doLogin = async function doLogin() {
  const uid = document.getElementById('uidInput').value.trim();
  const password = document.getElementById('pwdInput').value;
  if (!/^\d{8}$/.test(uid)) return alert('请输入 8 位数字 UID');
  if (!password) return alert('请输入密码');
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = '登录中...';
  try {
    const r = await api.auth.login(uid, password);
    if (r.success) {
      await renderTopBar();
      location.hash = 'home';
    } else alert(r.message || '登录失败');
  } finally {
    btn.disabled = false; btn.textContent = '登录';
  }
};
window.doRegister = async function doRegister() {
  const uid = document.getElementById('uidInput').value.trim();
  const pwd = document.getElementById('pwdInput').value;
  const confirm = document.getElementById('pwd2Input').value;
  const nickname = (document.getElementById('nickInput').value || '').trim();
  const bio = (document.getElementById('bioInput').value || '').trim();
  if (!/^\d{8}$/.test(uid)) return alert('请输入 8 位数字 UID');
  if (pwd.length < 6) return alert('密码至少 6 位');
  if (pwd !== confirm) return alert('两次输入的密码不一致');
  const payload = { uid, password: pwd };
  if (nickname) payload.nickname = nickname;
  if (bio) payload.bio = bio;
  const btn = document.getElementById('regBtn');
  btn.disabled = true; btn.textContent = '注册中...';
  try {
    const r = await api.auth.register(payload);
    if (!r.success) { alert(r.message); return; }
    // 自动登录
    const lr = await api.auth.login(uid, pwd);
    if (lr.success) {
      await renderTopBar();
      alert('注册成功！已自动登录');
      location.hash = 'home';
    } else {
      alert('注册成功，请手动登录：' + (lr.message || ''));
      location.hash = 'login';
    }
  } finally {
    btn.disabled = false; btn.textContent = '注册';
  }
};
window.doLogout = function doLogout() {
  api.auth.logout();
  renderTopBar();
  location.hash = 'home';
};
window.doPost = async function doPost() {
  const title = document.getElementById('titleInput').value.trim();
  const content = document.getElementById('contentInput').value.trim();
  const category = document.getElementById('catInput').value;
  if (!title || !content) return alert('标题和内容不能为空');
  const btn = document.getElementById('postBtn');
  btn.disabled = true; btn.textContent = '发布中...';
  try {
    const r = await api.posts.create(title, content, category);
    if (r.success) location.hash = 'home';
    else alert(r.message || '发布失败');
  } finally {
    btn.disabled = false; btn.textContent = '发布';
  }
};

// ==================== 路由入口 ====================
function route() {
  const raw = (location.hash || '').slice(1);
  const [seg1, seg2] = raw.split('/');
  const path = seg1 || 'home';
  const app = document.getElementById('app');

  if (path === 'login') renderLogin(app);
  else if (path === 'register') renderRegister(app);
  else if (path === 'post') renderPost(app);
  else if (path === 'detail' && seg2) renderDetail(app, parseInt(seg2, 10));
  else if (path === 'me') renderMe(app);
  else if (path === 'messages') renderMessages(app);
  else if (path === 'announcements') renderAnnouncements(app);
  else renderHome(app);
}

window.addEventListener('hashchange', route);
window.addEventListener('load', async () => {
  // 静默刷新登录态
  if (api.getToken()) {
    try { await api.auth.me(); } catch {}
  }
  await renderTopBar();
  route();
  // 登录后拉未读公告弹窗（异步，不阻塞渲染）
  popupUnreadAnnouncements();
  // 每 60 秒刷新一次未读消息数（顶栏红点）
  setInterval(() => { if (api.isLoggedIn()) renderTopBar(); }, 60 * 1000);
});
