/**
 * 五中校园论坛 - 前端主逻辑
 *
 * 路由（hash 路由，location.hash 变更触发 route()）：
 *   #home                封面页（欢迎页 + 动画占位，未登录也能看）
 *   #forum               广场 - 帖子列表（需登录）
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

import * as api from './api.js?v=20260827-admin-panel';

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

// ==================== 分区元数据 ====================
const CATEGORIES = api.CATEGORIES || [
  { key: 'general', label: '综合', cssColor: '#6b7280' },
  { key: 'study',   label: '学习', cssColor: '#2563eb' },
  { key: 'club',    label: '社团', cssColor: '#9333ea' },
  { key: 'life',    label: '生活', cssColor: '#059669' },
  { key: 'meta',    label: '站务', cssColor: '#dc2626', adminOnly: true },
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));
const CATEGORY_COLOR = Object.fromEntries(CATEGORIES.map(c => [c.key, c.cssColor || '#6b7280']));
function categoryBadgeHtml(key, opts = {}) {
  const label = CATEGORY_LABEL[key] || key;
  const color = CATEGORY_COLOR[key] || '#6b7280';
  const light = toLightBg(color);
  const clickAttrs = opts.clickable
    ? `onclick="event.stopPropagation();setHomeFilter('category',${escapeHtml(JSON.stringify(key))})" title="按「${label}」分区筛选"`
    : '';
  const cursor = opts.clickable ? 'cursor:pointer;' : '';
  return `<span ${clickAttrs} style="${cursor}color:${color};background:${light};padding:1px 8px;border-radius:12px;font-size:12px;margin-right:6px;font-weight:500">${escapeHtml(label)}</span>`;
}
function toLightBg(hex) {
  // #RRGGBB → 250 左右浅色背景（和文字颜色同色相）
  const h = hex.replace('#', '');
  if (h.length !== 6) return '#f3f4f6';
  const r = Math.round((parseInt(h.slice(0, 2), 16) + 255 * 9) / 10);
  const g = Math.round((parseInt(h.slice(2, 4), 16) + 255 * 9) / 10);
  const b = Math.round((parseInt(h.slice(4, 6), 16) + 255 * 9) / 10);
  return `rgb(${r},${g},${b})`;
}

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
      <button class="ghost" onclick="location.hash='forum'">📢 广场</button>
      <button class="ghost" onclick="location.hash='me'">👤 我的</button>
      <button class="ghost" onclick="location.hash='announcements'">📋 公告</button>
      <button class="ghost" onclick="location.hash='messages'">
        💬 私信${unreadMsg ? `<span class="unread-badge">${unreadMsg}</span>` : ''}
      </button>
      ${(me.role === 'admin' || me.role === 'dev_admin')
        ? `<button class="ghost" onclick="location.hash='admin'" style="color:#b45309">🛡 管理员面板</button>` : ''}
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
  const tags = (Array.isArray(p.tags) && p.tags.length)
    ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">
         ${p.tags.map(t => `<span class="tag-chip" onclick="event.stopPropagation();setHomeFilter('tag',${escapeHtml(JSON.stringify(t))})" title="按标签「${escapeHtml(t)}」筛选">#${escapeHtml(t)}</span>`).join('')}
       </div>`
    : '';
  const stats = `👁 ${p.viewCount || 0}　👍 ${p.likeCount || 0}　💬 ${p.commentCount || 0}`;
  const clickable = opts.allowClick ? 'clickable' : '';
  const onclickAttr = opts.allowClick ? `onclick="location.hash='#detail/${p.id}'"` : '';
  const pinBadge = p.isPinned
    ? `<span style="color:#f59e0b;background:#fef3c7;padding:1px 6px;border-radius:4px;font-size:11px;margin-right:6px">置顶</span>`
    : '';
  const catBadge = categoryBadgeHtml(p.category, { clickable: opts.allowClick });
  return `
    <div class="card ${clickable}" ${onclickAttr} data-post-id="${p.id}">
      <div class="meta">
        ${pinBadge}${catBadge}<span>${escapeHtml(author)}</span>
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

// ==================== 广场页搜索/筛选 工具函数 ====================
// 把搜索筛选参数统一塞到 location.hash 的查询串部分（紧跟在 #forum 之后，用 ? 开头）
// 例：#forum?q=数学&tag=社团招新&from=2026-08-01&to=2026-08-31&sort=hot
function getHomeFilters() {
  const raw = (location.hash || '').slice(1);
  const [pathPart, queryPart] = raw.split('?');
  const qp = new URLSearchParams(queryPart || '');
  return {
    category: qp.get('cat') || '',
    q: qp.get('q') || '',
    tag: qp.get('tag') || '',
    dateFrom: qp.get('from') || '',
    dateTo: qp.get('to') || '',
    sortBy: qp.get('sort') || 'latest',
    __path: pathPart,
  };
}
function buildHomeHash(f) {
  const qp = new URLSearchParams();
  if (f.category) qp.set('cat', f.category);
  if (f.q) qp.set('q', f.q);
  if (f.tag) qp.set('tag', f.tag);
  if (f.dateFrom) qp.set('from', f.dateFrom);
  if (f.dateTo) qp.set('to', f.dateTo);
  if (f.sortBy && f.sortBy !== 'latest') qp.set('sort', f.sortBy);
  const qs = qp.toString();
  return '#forum' + (qs ? `?${qs}` : '');
}
window.setHomeFilter = function setHomeFilter(key, value) {
  const f = getHomeFilters();
  if (key === 'sort') f.sortBy = value || 'latest';
  else if (key === 'category') f.category = value || '';
  else f[key] = value || '';
  location.hash = buildHomeHash(f);
  setTimeout(route, 0);
};
// 帖子 chip 点一下是按 tag 搜；但如果首页没有任何查询条件且点了多个 tag chip，
// 这里只做"单选 tag"语义（一次只筛一个标签）。
window.clearHomeFilters = function clearHomeFilters() {
  location.hash = '#forum';
  setTimeout(route, 0);
};

// ==================== 视图：封面页（首页 #home，未登录也能看）====================
function renderCover(app) {
  const loggedIn = api.isLoggedIn();
  app.innerHTML = `
    <div class="cover-hero" style="text-align:center;padding:48px 20px 36px">
      <h1 style="font-size:28px;margin-bottom:12px">五中校园论坛</h1>
      <p style="font-size:15px;color:#6e6e73;margin-bottom:24px">属于五中人的交流空间</p>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
        ${loggedIn
          ? `<button onclick="location.hash='forum'" style="padding:10px 28px;font-size:15px">进入广场 →</button>`
          : `<button onclick="location.hash='login'" style="padding:10px 28px;font-size:15px">登录</button>
             <button class="secondary" onclick="location.hash='register'" style="padding:10px 28px;font-size:15px">注册</button>`
        }
      </div>
    </div>
    <!-- 动画占位区：后续放首页动画效果 -->
    <div id="coverAnimation" style="min-height:200px;display:flex;align-items:center;justify-content:center;color:#c4c4c8;font-size:14px">
      🎬 动画效果开发中…
    </div>
  `;
}

// ==================== 视图：广场（帖子列表 + 分区Tab + 搜索条 + 热门标签，需登录）====================
async function renderForum(app) {
  if (!api.isLoggedIn()) { location.hash = 'login'; return; }
  const filters = getHomeFilters();
  const loggedIn = api.isLoggedIn();
  const me = loggedIn ? api.getCurrentUser() : null;
  const isAdmin = me && api.ADMIN_ROLES.has(String(me.role || ''));

  const topBanner = `<div class="toolbar">
         <span id="postCount">读取中...</span>
         <button onclick="location.hash='post'">+ 发新帖</button>
       </div>`;

  // 分区 Tab（显示在搜索条顶部 / 左上）：按 CATEGORIES 顺序，meta 仅管理员会"看到它是管理员专属"的角标
  const tabItems = [{ key: '', label: '全部' }, ...CATEGORIES.filter(c => isAdmin || !c.adminOnly).map(c => ({ key: c.key, label: c.label, cssColor: c.cssColor, adminOnly: !!c.adminOnly }))];
  const tabBarHtml = `<div style="margin-bottom:10px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">
    ${tabItems.map(tab => {
      const active = (tab.key === '') ? !filters.category : (tab.key === filters.category);
      const color = tab.cssColor || '#2563eb';
      const style = active
        ? `background:${color};color:#fff;border-color:${color}`
        : `background:#fff;color:${tab.cssColor || '#333'};border-color:#d2d2d7`;
      const adminBadge = tab.adminOnly ? '<small style="margin-left:4px;opacity:.9">🔒管</small>' : '';
      return `<button onclick="setHomeFilter('category',${escapeHtml(JSON.stringify(tab.key))})"
          style="padding:4px 12px;border-radius:999px;border:1px solid;font-size:13px;cursor:pointer;transition:.15s;${style}">
          ${tab.label}${adminBadge}
        </button>`;
    }).join('')}
  </div>`;

  app.innerHTML = `
    ${topBanner}
    <!-- 搜索条（所有访客都看得到） -->
    <div class="card search-panel">
      <h3 style="margin-top:0;margin-bottom:12px;font-size:15px">🔍 搜索帖子</h3>
      <div class="search-row">
        <input id="sqInput" placeholder="关键字（搜标题/正文，如：数学、社团招新）" value="${escapeHtml(filters.q)}" onkeydown="if(event.key==='Enter')homeRunSearch()">
        <input id="stagInput" placeholder="按标签筛选（如：高二、羽毛球）" value="${escapeHtml(filters.tag)}" onkeydown="if(event.key==='Enter')homeRunSearch()">
      </div>
      <div class="search-row">
        <label style="font-size:12px;color:#6b7280;display:flex;align-items:center;gap:4px">
          从 <input type="date" id="sFrom" value="${escapeHtml(filters.dateFrom)}">
        </label>
        <label style="font-size:12px;color:#6b7280;display:flex;align-items:center;gap:4px">
          到 <input type="date" id="sTo" value="${escapeHtml(filters.dateTo)}">
        </label>
        <label style="font-size:12px;color:#6b7280;display:flex;align-items:center;gap:4px">
          排序
          <select id="sSort" style="padding:4px 6px;border-radius:6px;border:1px solid #d2d2d7">
            <option value="latest" ${filters.sortBy==='latest'?'selected':''}>最新</option>
            <option value="hot"    ${filters.sortBy==='hot'   ?'selected':''}>最热（点赞×3 + 评论×2 + 浏览）</option>
          </select>
        </label>
      </div>
      <div class="search-row" style="margin-top:6px">
        <button onclick="homeRunSearch()">🔎 搜索</button>
        <button class="secondary" onclick="clearHomeFilters()">🗑 清除条件</button>
        <span id="filterBadges" style="flex:1;display:flex;flex-wrap:wrap;gap:4px;align-items:center"></span>
      </div>
      ${tabBarHtml}
      <div id="popularTags">🔄 正在读取热门标签…</div>
    </div>

    <div class="card">
      <h3 id="listTitle" style="margin-top:0;margin-bottom:10px">最新帖子</h3>
      <div id="postList" class="empty">🔄 正在读取帖子...</div>
    </div>
  `;

  // --- 1) 读取热门标签 chip ---
  (async () => {
    const box = document.getElementById('popularTags');
    const resp = await api.posts.popularTags();
    if (!resp.success) { box.outerHTML = ''; return; }
    const tags = (resp.data && resp.data.tags) || [];
    if (tags.length === 0) { box.outerHTML = ''; return; }
    box.innerHTML = `<div style="font-size:12px;color:#6b7280;margin-bottom:4px">🔥 最近 30 天热门标签（点一下直接按该标签筛选）：</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${tags.map(t =>
        `<span class="tag-chip ${filters.tag===t.tag?'active-tag':''}" onclick="setHomeFilter('tag',${escapeHtml(JSON.stringify(t.tag))})" title="该标签出现 ${t.count} 次">#${escapeHtml(t.tag)} <small style="opacity:.6">×${t.count}</small></span>`
      ).join('')}</div>`;
  })().catch(() => { /* 热门标签读取失败不用影响主流程 */ });

  // --- 2) 读帖子列表（带筛选） ---
  const listEl = document.getElementById('postList');
  const listTitleEl = document.getElementById('listTitle');
  try {
    const postFilters = {
      category: filters.category || undefined,
      q: filters.q || undefined,
      tag: filters.tag || undefined,
      dateFrom: filters.dateFrom || undefined,
      dateTo: filters.dateTo || undefined,
      sortBy: filters.sortBy,
    };
    const res = await api.posts.list(1, 50, postFilters);
    if (!res.success) {
      listEl.outerHTML = `<div class="card">❌ 加载失败：${escapeHtml(res.message)}</div>`;
      return;
    }
    const data = res.data || [];
    const total = (res.pagination || {}).total || 0;
    const countEl = document.getElementById('postCount');
    if (countEl) countEl.textContent = `共 ${total} 条帖子`;

    // 列表标题：有筛选条件就显示"搜索结果 N 条"
    const applied = (res.appliedFilters || {});
    const hasFilter = applied.category || applied.q || applied.tag || applied.dateFrom || applied.dateTo;
    const catLabelForTitle = applied.category ? (CATEGORY_LABEL[applied.category] || applied.category) : null;
    const prefix = catLabelForTitle ? `「${catLabelForTitle}」` : '';
    if (listTitleEl) listTitleEl.textContent = hasFilter ? `${prefix}${prefix ? ' ' : ''}搜索结果（${total} 条）` : (applied.sortBy==='hot' ? '🔥 最热帖子' : '最新帖子');

    // 条件徽章（category / q / tag / 日期区间，点 × 清掉单个）
    const badgeBox = document.getElementById('filterBadges');
    if (badgeBox) {
      const badges = [];
      if (applied.category) badges.push(`<span class="filter-badge">分区：<b>${escapeHtml(CATEGORY_LABEL[applied.category] || applied.category)}</b><button class="chip-close" onclick="setHomeFilter('category','')">×</button></span>`);
      if (applied.q) badges.push(`<span class="filter-badge">关键字：<b>${escapeHtml(applied.q)}</b><button class="chip-close" onclick="setHomeFilter('q','')">×</button></span>`);
      if (applied.tag) badges.push(`<span class="filter-badge">标签：<b>#${escapeHtml(applied.tag)}</b><button class="chip-close" onclick="setHomeFilter('tag','')">×</button></span>`);
      if (applied.dateFrom) badges.push(`<span class="filter-badge">从 <b>${escapeHtml(applied.dateFrom)}</b><button class="chip-close" onclick="setHomeFilter('dateFrom','')">×</button></span>`);
      if (applied.dateTo) badges.push(`<span class="filter-badge">到 <b>${escapeHtml(applied.dateTo)}</b><button class="chip-close" onclick="setHomeFilter('dateTo','')">×</button></span>`);
      badgeBox.innerHTML = badges.join('');
    }

    if (data.length === 0) {
      listEl.outerHTML = `<div class="empty">${hasFilter ? '😶 没有匹配的帖子，试试 🔎 清除条件 重新搜索～' : '还没有帖子，快来发第一条吧'}</div>`;
      return;
    }
    listEl.outerHTML = data.map(p => postCard(p, { allowClick: true })).join('');
  } catch (e) {
    listEl.outerHTML = `<div class="card">❌ 网络错误：${escapeHtml(e.message)}</div>`;
  }
}
window.homeRunSearch = function homeRunSearch() {
  const sq = document.getElementById('sqInput');
  const stag = document.getElementById('stagInput');
  const sFrom = document.getElementById('sFrom');
  const sTo = document.getElementById('sTo');
  const sSort = document.getElementById('sSort');
  const f = getHomeFilters();
  f.q = (sq && sq.value || '').trim();
  f.tag = (stag && stag.value || '').trim().replace(/^#/, '');
  f.dateFrom = (sFrom && sFrom.value || '');
  f.dateTo = (sTo && sTo.value || '');
  f.sortBy = (sSort && sSort.value) || 'latest';
  location.hash = buildHomeHash(f);
  setTimeout(route, 0);
};

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

// 发帖状态：标签数组 + 选中分区 key + 置顶
let draftPostTags = [];
let draftPostCategory = 'general';
let draftPostPinned = false;

function renderPost(app) {
  if (!api.isLoggedIn()) { location.hash = 'login'; return; }
  const me = api.getCurrentUser();
  const isAdmin = me && api.ADMIN_ROLES.has(String(me.role || ''));
  draftPostTags = [];
  draftPostCategory = 'general';
  draftPostPinned = false;

  // 分区下拉选项：meta 仅管理员可见
  const visibleCategories = CATEGORIES.filter(c => isAdmin || !c.adminOnly);

  app.innerHTML = `
    <div class="card">
      <h3>发新帖</h3>

      <div style="margin-bottom:14px">
        <label for="categorySelect" style="font-size:13px;color:#424245;display:block;margin-bottom:8px">
          📂 分区（必选）
        </label>
        <select id="categorySelect" style="width:100%;padding:8px 10px;border:1px solid #d2d2d7;border-radius:8px;font-size:14px;background:#fff">
          ${visibleCategories.map(c => {
            const pad = c.adminOnly ? ' 🔒管' : '';
            return `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label)}${pad}　— ${escapeHtml(c.description || '')}</option>`;
          }).join('')}
        </select>
      </div>

      <input id="titleInput" placeholder="标题（必填，100字内）" maxlength="100">
      <textarea id="contentInput" placeholder="说点什么...（必填，2000字内）" maxlength="2000"></textarea>

      <div style="margin-bottom:14px">
        <label for="tagInput" style="font-size:13px;color:#424245;display:block;margin-bottom:6px">
          🏷 标签（最多 5 个，每个 ≤20 字，用 # 分隔）
        </label>
        <div id="tagChips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px"></div>
        <input id="tagInput"
               placeholder="用 # 分隔标签，例：#高二#数学#社团招新"
               maxlength="200"
               style="width:100%">
        <p class="hint" style="margin:2px 0 0 0">
          💡 输入 # 确认一个标签（最多 5 个，每个 ≤20 字）。分区用于大分类，标签用于细分话题。
        </p>
      </div>

      ${isAdmin ? `
      <div style="margin-bottom:14px;display:flex;align-items:center;gap:6px">
        <input type="checkbox" id="pinCheckbox" style="width:16px;height:16px;cursor:pointer">
        <label for="pinCheckbox" style="font-size:13px;color:#424245;cursor:pointer">📌 置顶此帖（管理员专属，置顶帖将显示在列表最前面）</label>
      </div>
      ` : ''}

      <button id="postBtn" onclick="doPost()">发布</button>
      <button class="secondary" onclick="location.hash='forum'">取消</button>
    </div>
  `;

  // --- 分区下拉逻辑 ---
  const catSelect = document.getElementById('categorySelect');
  catSelect.addEventListener('change', () => {
    draftPostCategory = catSelect.value;
  });

  // --- 置顶 checkbox（管理员）---
  const pinCheckbox = document.getElementById('pinCheckbox');
  if (pinCheckbox) {
    pinCheckbox.addEventListener('change', () => {
      draftPostPinned = pinCheckbox.checked;
    });
  }

  // --- 多标签 chip 逻辑 ---
  const tagInput = document.getElementById('tagInput');
  const chipsBox = document.getElementById('tagChips');
  function renderChips() {
    chipsBox.innerHTML = draftPostTags.map((t, i) =>
      `<span class="tag-chip input-chip">#${escapeHtml(t)}<button class="chip-close" data-idx="${i}" aria-label="删除该标签">×</button></span>`
    ).join('');
    chipsBox.querySelectorAll('.chip-close').forEach(btn => {
      btn.addEventListener('click', e => {
        const idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        draftPostTags.splice(idx, 1);
        renderChips();
      });
    });
  }
  // 标签以 # 为分隔符：用户自己打 # 开头，遇到 # 就分割成新标签
  function addTagFromInput() {
    const raw = (tagInput.value || '').trim();
    if (!raw) return false;
    // 按 # 分割，去掉首尾空格，过滤空串
    const items = raw.split(/#+/).map(s => s.trim()).filter(Boolean);
    if (items.length === 0) return false;
    for (const it of items) {
      const t = it.slice(0, 20);
      if (!draftPostTags.includes(t) && draftPostTags.length < 5 && !/["'\\<>{}]/.test(t)) draftPostTags.push(t);
    }
    tagInput.value = '';
    renderChips();
    return true;
  }
  // 遇到 # 号立即分割（用户每打一个 # 就把前面的文本收为标签）
  // 回车也确认（把当前输入框残留的最后一个标签收进来）
  tagInput.addEventListener('keydown', e => {
    if (e.key === '#' || e.key === 'Enter') {
      // # 号：先把 # 之前的文本提取为标签，再让 # 正常输入（方便用户继续打下一个标签）
      if (e.key === '#') {
        const beforeHash = tagInput.value;
        if (beforeHash) {
          // 立即把 # 之前的内容提取为标签
          const items = beforeHash.split(/#+/).map(s => s.trim()).filter(Boolean);
          for (const it of items) {
            const t = it.slice(0, 20);
            if (!draftPostTags.includes(t) && draftPostTags.length < 5 && !/["'\\<>{}]/.test(t)) draftPostTags.push(t);
          }
          tagInput.value = '';
          renderChips();
        }
        // 让 # 正常输入，不打断
      } else {
        // 回车：确认全部
        e.preventDefault();
        addTagFromInput();
      }
    } else if (e.key === 'Backspace' && tagInput.value === '' && draftPostTags.length > 0) {
      draftPostTags.pop();
      renderChips();
    }
  });
  // 失焦 / 粘贴也确认
  tagInput.addEventListener('blur', () => addTagFromInput());
  tagInput.addEventListener('paste', e => {
    setTimeout(addTagFromInput, 0);
  });
  renderChips();
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
  const pinBadge = p.isPinned
    ? `<span style="color:#f59e0b;background:#fef3c7;padding:1px 6px;border-radius:4px;font-size:11px;margin-right:6px">置顶</span>`
    : '';
  const catBadge = categoryBadgeHtml(p.category);
  const tagsHtml = (Array.isArray(p.tags) && p.tags.length)
    ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">
         ${p.tags.map(t => `<span class="tag-chip" onclick="location.hash='forum';setTimeout(()=>setHomeFilter('tag',${escapeHtml(JSON.stringify(t))}),0)" title="按标签「${escapeHtml(t)}」筛选">#${escapeHtml(t)}</span>`).join('')}
       </div>`
    : '';

  app.innerHTML = `
    <div style="margin-bottom:10px">
      <button class="ghost" onclick="location.hash='forum'">← 返回列表</button>
    </div>
    <div class="card detail-header">
      <div class="meta">
        ${pinBadge}${catBadge}<span>${escapeHtml(p.authorNickname || `用户${p.authorUid}`)}</span>
        <span>·</span><span>${escapeHtml(formatTime(p.createdAt))}</span>
        <span>·</span><span>👁 ${p.viewCount} 浏览</span>
      </div>
      <h2>${escapeHtml(p.title)}</h2>
      <div class="detail-body">${escapeHtml(p.content)}</div>
      ${tagsHtml}
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
        ${(me && (me.role === 'admin' || me.role === 'dev_admin'))
          ? `<button id="editPostBtn" class="secondary">✏️ 编辑帖子</button>` : ''}
      </div>
    </div>

    <!-- 管理员编辑帖子弹窗 -->
    <div id="editPanel" style="display:none;margin-top:12px"></div>

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
      if (r.success) { alert('已删除'); location.hash = 'forum'; }
      else { delPostBtn.disabled = false; alert(r.message); }
    });
  }

  // ---- 管理员编辑帖子 ----
  const editPostBtn = document.getElementById('editPostBtn');
  if (editPostBtn) {
    editPostBtn.addEventListener('click', () => {
      const panel = document.getElementById('editPanel');
      const isVisible = panel.style.display !== 'none';
      if (isVisible) { panel.style.display = 'none'; return; }

      // 初始化编辑表单，预填当前帖子内容
      const editTags = Array.isArray(p.tags) ? [...p.tags] : [];
      const editCats = CATEGORIES.filter(c => true); // 管理员可见全部分区
      panel.style.display = 'block';
      panel.innerHTML = `
        <div class="card" style="border:2px solid #2563eb">
          <h3>✏️ 管理员编辑帖子</h3>
          <p class="hint">编辑后保存，发帖时间保持不变，仅更新内容。</p>

          <label style="font-size:13px;color:#424245;display:block;margin-bottom:6px">📂 分区</label>
          <select id="editCategorySelect" style="width:100%;padding:8px 10px;border:1px solid #d2d2d7;border-radius:8px;font-size:14px;background:#fff;margin-bottom:14px">
            ${editCats.map(c => `<option value="${escapeHtml(c.key)}" ${c.key === p.category ? 'selected' : ''}>${escapeHtml(c.label)}${c.adminOnly?' 🔒管':''}　— ${escapeHtml(c.description||'')}</option>`).join('')}
          </select>

          <input id="editTitleInput" placeholder="标题" maxlength="100" style="margin-bottom:10px" value="${escapeHtml(p.title)}">
          <textarea id="editContentInput" placeholder="内容" maxlength="2000" style="margin-bottom:10px">${escapeHtml(p.content)}</textarea>

          <label style="font-size:13px;color:#424245;display:block;margin-bottom:6px">🏷 标签（用 # 分隔，最多 5 个）</label>
          <div id="editTagChips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px"></div>
          <input id="editTagInput" placeholder="用 # 分隔标签，例：#高二#数学" maxlength="200" style="width:100%;margin-bottom:10px">

          <div style="display:flex;align-items:center;gap:6px;margin-bottom:14px;padding:8px 10px;background:#fef3c7;border-radius:8px">
            <input type="checkbox" id="editPinCheckbox" style="width:16px;height:16px;cursor:pointer" ${p.isPinned ? 'checked' : ''}>
            <label for="editPinCheckbox" style="font-size:13px;color:#424245;cursor:pointer">📌 置顶此帖（管理员专属，置顶帖显示在列表最前面）</label>
          </div>

          <button id="saveEditBtn" onclick="window._doEditPost(${p.id}, ${!!p.isPinned})">保存修改</button>
          <button class="secondary" id="cancelEditBtn">取消</button>
        </div>
      `;

      // 标签 chip 逻辑（复用 # 分隔逻辑）
      const editTagInput = document.getElementById('editTagInput');
      const editChipsBox = document.getElementById('editTagChips');
      function renderEditChips() {
        editChipsBox.innerHTML = editTags.map((t, i) =>
          `<span class="tag-chip input-chip">#${escapeHtml(t)}<button class="chip-close" data-idx="${i}" aria-label="删除">×</button></span>`
        ).join('');
        editChipsBox.querySelectorAll('.chip-close').forEach(btn => {
          btn.addEventListener('click', e => {
            editTags.splice(parseInt(e.currentTarget.getAttribute('data-idx'), 10), 1);
            renderEditChips();
          });
        });
      }
      function addEditTagFromInput() {
        const raw = (editTagInput.value || '').trim();
        if (!raw) return;
        const items = raw.split(/#+/).map(s => s.trim()).filter(Boolean);
        for (const it of items) {
          const t = it.slice(0, 20);
          if (!editTags.includes(t) && editTags.length < 5 && !/["'\\<>{}]/.test(t)) editTags.push(t);
        }
        editTagInput.value = '';
        renderEditChips();
      }
      editTagInput.addEventListener('keydown', e => {
        if (e.key === '#' && editTagInput.value) {
          const items = editTagInput.value.split(/#+/).map(s => s.trim()).filter(Boolean);
          for (const it of items) {
            const t = it.slice(0, 20);
            if (!editTags.includes(t) && editTags.length < 5 && !/["'\\<>{}]/.test(t)) editTags.push(t);
          }
          editTagInput.value = '';
          renderEditChips();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          addEditTagFromInput();
        }
      });
      editTagInput.addEventListener('blur', () => addEditTagFromInput());
      renderEditChips();

      document.getElementById('cancelEditBtn').addEventListener('click', () => {
        panel.style.display = 'none';
        panel.innerHTML = '';
      });
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
    const canEdit = me && !deleted && (me.role === 'admin' || me.role === 'dev_admin');

    return `
      <div class="comment-item ${isReply ? 'reply' : ''}" data-comment-id="${c.id}">
        <div class="comment-header">
          <span><span class="comment-author">${headerAuthor}</span> · ${escapeHtml(formatTime(c.createdAt))}</span>
          ${canDelete ? `<button class="ghost danger-style" onclick="deleteComment(${c.id}, ${postId})" style="color:#ff3b30;background:none">删除</button>` : ''}
          ${canEdit ? `<button class="ghost" onclick="toggleEditComment(${c.id})" style="color:#2563eb;background:none">编辑</button>` : ''}
        </div>
        ${replyRef}
        <div id="comment-content-${c.id}">${contentHtml}</div>
        ${canEdit ? `
          <div class="edit-comment-box" id="edit-comment-${c.id}" style="display:none;margin-top:6px">
            <textarea placeholder="编辑评论..." maxlength="1000" style="width:100%;min-height:60px;margin-bottom:6px">${escapeHtml(c.content || '')}</textarea>
            <button onclick="saveEditComment(${c.id}, ${postId}, this)" style="padding:4px 12px;font-size:13px">保存</button>
            <button class="secondary" onclick="document.getElementById('edit-comment-${c.id}').style.display='none'" style="padding:4px 12px;font-size:13px">取消</button>
          </div>
        ` : ''}
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
window.toggleEditComment = function toggleEditComment(commentId) {
  const box = document.getElementById('edit-comment-' + commentId);
  if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
};
window.saveEditComment = async function saveEditComment(commentId, postId, btnEl) {
  const wrap = btnEl.closest('.edit-comment-box');
  const ta = wrap.querySelector('textarea');
  const content = (ta.value || '').trim();
  if (!content) return alert('评论内容不能为空');
  btnEl.disabled = true; btnEl.textContent = '保存中...';
  try {
    const r = await api.comments.update(commentId, content);
    if (r.success) {
      // 更新评论内容显示（不重新拉全部）
      const contentDiv = document.getElementById('comment-content-' + commentId);
      if (contentDiv) contentDiv.innerHTML = `<div class="comment-content">${escapeHtml(content)}</div>`;
      wrap.style.display = 'none';
    } else {
      alert(r.message || '编辑失败');
    }
  } finally {
    btnEl.disabled = false; btnEl.textContent = '保存';
  }
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
        <button id="tabFavorites" onclick="switchMeTab('favorites')">★ 我的收藏</button>
        <button id="tabPassword" onclick="switchMeTab('password')">🔐 修改密码</button>
      </div>
      <button class="secondary" onclick="location.hash='post'">+ 发新帖</button>
    </div>
    <div id="meContent"><div class="empty">🔄 加载中...</div></div>
  `;
  window._currentMeTab = 'mine';
  loadMeTab('mine');
}

window.switchMeTab = function switchMeTab(tab) {
  // 4 个 tab：mine / likes / favorites / password
  const tabIdMap = { mine: 'tabMine', likes: 'tabLikes', favorites: 'tabFavorites', password: 'tabPassword' };
  Object.keys(tabIdMap).forEach(t => {
    document.getElementById(tabIdMap[t]).classList.toggle('on', t === tab);
  });
  window._currentMeTab = tab;
  loadMeTab(tab);
};
async function loadMeTab(tab) {
  const host = document.getElementById('meContent');
  if (!host) return;

  // --- 修改密码：独立表单 ---
  if (tab === 'password') {
    host.innerHTML = `
      <div class="card">
        <h3 style="margin-top:0">🔐 修改登录密码</h3>
        <p class="hint" style="margin-top:-4px">
          修改成功后会立即退出登录，需要用 <b>新密码</b> 重新登录（强制保证 localStorage 中的 token 不会"偷偷"继续用旧密码对应的身份）。
        </p>
        <input type="password" id="oldPwdInput" placeholder="当前旧密码（必填）" autocomplete="current-password">
        <input type="password" id="newPwdInput" placeholder="新密码（6 位以上）" autocomplete="new-password">
        <input type="password" id="confirmPwdInput" placeholder="再次输入新密码（必须一致）" autocomplete="new-password">
        <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
          <button id="changePwdBtn" onclick="doChangePwd()">确认修改密码</button>
          <span class="hint">💡 建议：字母 + 数字组合，至少 8 位，不要跟其他网站共用密码</span>
        </div>
        <p id="pwdMsg" class="hint" style="margin-top:10px"></p>
      </div>
    `;
    document.getElementById('confirmPwdInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') doChangePwd();
    });
    return;
  }

  // --- 其它 3 个 tab：帖子列表 ---
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
window.doChangePwd = async function doChangePwd() {
  const btn = document.getElementById('changePwdBtn');
  const msg = document.getElementById('pwdMsg');
  const oldPw = document.getElementById('oldPwdInput').value;
  const newPw = document.getElementById('newPwdInput').value;
  const confirmPw = document.getElementById('confirmPwdInput').value;
  if (!btn || !msg) return;
  btn.disabled = true; btn.textContent = '提交中...';
  msg.textContent = '';
  msg.style.color = '';
  try {
    const r = await api.auth.changePwd({ oldPassword: oldPw, newPassword: newPw, confirmPassword: confirmPw });
    if (r.success) {
      msg.style.color = '#059669';
      msg.textContent = '✅ 修改成功！为了安全，1 秒后会自动退出登录，请用新密码重新登录～';
      setTimeout(() => {
        api.auth.logout();
        renderTopBar();
        location.hash = 'login';
      }, 1100);
    } else {
      msg.style.color = '#dc2626';
      msg.textContent = '❌ ' + (r.message || '修改失败');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '确认修改密码'; }
  }
};

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

// ==================== 视图：管理员面板 ====================
// 置顶帖顺序调整的本地状态
let _adminPinPosts = [];   // 后端返回的置顶帖完整数据
let _adminPinOrder = [];   // 当前顺序：帖子 id 数组（操作后可能偏离服务端顺序，点保存才落库）

async function renderAdmin(app) {
  const me = api.getCurrentUser();
  if (!api.isLoggedIn() || (me && me.role !== 'admin' && me.role !== 'dev_admin')) {
    app.innerHTML = `<div class="card">⛔ 仅管理员可访问该面板。<br><a href="#login">去登录</a> 或 <a href="#forum">返回广场</a></div>`;
    return;
  }

  app.innerHTML = `
    <div class="toolbar"><span style="font-size:16px;font-weight:600;color:#b45309">🛡 管理员面板</span></div>

    <!-- 板块1：已注册账号 -->
    <div class="card">
      <h3 style="margin-top:0">👤 已注册账号</h3>
      <div id="adminUsers">🔄 加载中...</div>
    </div>

    <!-- 板块2：分区与标签 -->
    <div class="card">
      <h3 style="margin-top:0">📂 分区与标签</h3>
      <div style="font-size:12px;color:#6b7280;margin-bottom:6px">分区（系统枚举，meta 仅管理员可发帖）：</div>
      <div id="adminCats"></div>
      <div style="font-size:12px;color:#6b7280;margin:12px 0 6px">全量标签（按出现次数降序）：</div>
      <div id="adminTags">🔄 加载标签中...</div>
    </div>

    <!-- 板块3：置顶帖顺序调整 -->
    <div class="card">
      <h3 style="margin-top:0">📌 置顶帖顺序调整</h3>
      <p class="hint">多个置顶帖按下方顺序排列，越靠前越优先显示在列表顶部。用 ↑↓ 调整顺序后点「保存顺序」生效。</p>
      <div id="adminPinned">🔄 加载中...</div>
    </div>
  `;

  // --- 板块1：账号列表 ---
  (async () => {
    const host = document.getElementById('adminUsers');
    try {
      const r = await api.admin.listUsers();
      if (!r.success) { host.innerHTML = `❌ ${escapeHtml(r.message)}`; return; }
      const users = r.data || [];
      if (users.length === 0) { host.innerHTML = `<span class="hint">暂无注册账号</span>`; return; }
      host.innerHTML = `
        <div style="font-size:12px;color:#6b7280;margin-bottom:8px">共 ${users.length} 个账号</div>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="text-align:left;color:#6b7280;border-bottom:1px solid #e5e7eb">
              <th style="padding:6px 8px">UID</th>
              <th style="padding:6px 8px">昵称</th>
              <th style="padding:6px 8px">角色</th>
              <th style="padding:6px 8px">帖子数</th>
              <th style="padding:6px 8px">注册时间</th>
            </tr></thead>
            <tbody>
              ${users.map(u => `<tr style="border-bottom:1px solid #f3f4f6">
                <td style="padding:6px 8px">${escapeHtml(u.uid)}</td>
                <td style="padding:6px 8px">${escapeHtml(u.nickname)}</td>
                <td style="padding:6px 8px">${u.role === 'dev_admin' ? '开发管理员' : u.role === 'admin' ? '管理员' : '普通成员'}</td>
                <td style="padding:6px 8px">${u.postCount}</td>
                <td style="padding:6px 8px">${escapeHtml(formatTime(u.createdAt))}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      `;
    } catch (e) { host.innerHTML = `❌ ${escapeHtml(e.message)}`; }
  })();

  // --- 板块2：分区（静态枚举）+ 标签（异步全量）---
  const catsHost = document.getElementById('adminCats');
  catsHost.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px">
    ${CATEGORIES.map(c => `<span style="color:${c.cssColor};background:${toLightBg(c.cssColor)};padding:2px 10px;border-radius:12px;font-size:12px" title="${escapeHtml(c.description||'')}">${escapeHtml(c.label)}${c.adminOnly?' 🔒':''}</span>`).join('')}
  </div>`;
  (async () => {
    const host = document.getElementById('adminTags');
    try {
      const r = await api.admin.allTags();
      if (!r.success) { host.innerHTML = `❌ ${escapeHtml(r.message)}`; return; }
      const tags = r.data || [];
      if (tags.length === 0) { host.innerHTML = `<span class="hint">暂无标签</span>`; return; }
      host.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px">
        ${tags.map(t => `<span class="tag-chip">#${escapeHtml(t.tag)} <small style="opacity:.6">×${t.count}</small></span>`).join('')}
      </div>`;
    } catch (e) { host.innerHTML = `❌ ${escapeHtml(e.message)}`; }
  })();

  // --- 板块3：置顶帖顺序 ---
  (async () => {
    try {
      const r = await api.admin.pinnedPosts();
      if (!r.success) { document.getElementById('adminPinned').innerHTML = `❌ ${escapeHtml(r.message)}`; return; }
      _adminPinPosts = r.data || [];
      _adminPinOrder = _adminPinPosts.map(p => p.id);
      renderAdminPinList();
    } catch (e) { document.getElementById('adminPinned').innerHTML = `❌ ${escapeHtml(e.message)}`; }
  })();
}

function renderAdminPinList() {
  const host = document.getElementById('adminPinned');
  if (!host) return;
  if (_adminPinOrder.length === 0) {
    host.innerHTML = `<div class="hint">目前没有置顶帖。可在帖子详情页用「编辑帖子」面板里的置顶开关来置顶。</div>`;
    return;
  }
  const byId = new Map(_adminPinPosts.map(p => [p.id, p]));
  host.innerHTML = `
    <div id="adminPinRows">
      ${_adminPinOrder.map((id, idx) => {
        const p = byId.get(id) || { id, title: '(该帖已不存在)', category: '' };
        const isFirst = idx === 0;
        const isLast = idx === _adminPinOrder.length - 1;
        return `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:6px;background:#fffbeb">
          <span style="font-weight:700;color:#b45309;min-width:24px;text-align:center">${idx + 1}</span>
          ${categoryBadgeHtml(p.category)}
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</span>
          <button class="ghost" ${isFirst ? 'disabled' : ''} onclick="window._adminPinMove(${id},-1)" style="padding:2px 10px">↑</button>
          <button class="ghost" ${isLast ? 'disabled' : ''} onclick="window._adminPinMove(${id},1)" style="padding:2px 10px">↓</button>
        </div>`;
      }).join('')}
    </div>
    <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
      <button onclick="window._adminPinSave()">💾 保存顺序</button>
      <button class="secondary" onclick="window._adminPinReset()">↩ 重置</button>
      <span id="adminPinMsg" style="font-size:13px"></span>
    </div>
  `;
}

window._adminPinMove = function _adminPinMove(id, dir) {
  const idx = _adminPinOrder.indexOf(id);
  if (idx < 0) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= _adminPinOrder.length) return;
  [_adminPinOrder[idx], _adminPinOrder[newIdx]] = [_adminPinOrder[newIdx], _adminPinOrder[idx]];
  renderAdminPinList();
};
window._adminPinReset = async function _adminPinReset() {
  const r = await api.admin.pinnedPosts();
  if (r.success) {
    _adminPinPosts = r.data || [];
    _adminPinOrder = _adminPinPosts.map(p => p.id);
    renderAdminPinList();
    const m = document.getElementById('adminPinMsg'); if (m) { m.textContent = '已重置为服务端顺序'; m.style.color = '#6b7280'; }
  }
};
window._adminPinSave = async function _adminPinSave() {
  const msg = document.getElementById('adminPinMsg');
  if (msg) { msg.textContent = '保存中...'; msg.style.color = '#6b7280'; }
  try {
    const r = await api.admin.updatePinOrder(_adminPinOrder);
    if (r.success) {
      // 保存后重新拉取确认（后端会按 pin_order 重排）
      const rr = await api.admin.pinnedPosts();
      if (rr.success) {
        _adminPinPosts = rr.data || [];
        _adminPinOrder = _adminPinPosts.map(p => p.id);
      }
      renderAdminPinList();
      const m = document.getElementById('adminPinMsg');
      if (m) { m.textContent = '✅ 顺序已保存'; m.style.color = '#059669'; }
    } else {
      const m = document.getElementById('adminPinMsg');
      if (m) { m.textContent = `❌ ${r.message || '保存失败'}`; m.style.color = '#dc2626'; }
    }
  } catch (e) {
    const m = document.getElementById('adminPinMsg');
    if (m) { m.textContent = `❌ ${e.message}`; m.style.color = '#dc2626'; }
  }
};

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
      location.hash = 'forum';
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
      location.hash = 'forum';
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
// ==================== 管理员编辑帖子保存 ====================
window._doEditPost = async function doEditPost(postId, originalPinned = false) {
  const title = document.getElementById('editTitleInput').value.trim();
  const content = document.getElementById('editContentInput').value.trim();
  const category = document.getElementById('editCategorySelect').value;
  // 收集标签 chip（DOM 里的 textContent）
  const tagChips = document.querySelectorAll('#editTagChips .tag-chip');
  const tags = [];
  tagChips.forEach(chip => {
    let t = chip.textContent.replace(/^#/, '').replace(/×$/, '').trim();
    if (t) tags.push(t);
  });
  // 也尝试从输入框吸收残留
  const tagInput = document.getElementById('editTagInput');
  if (tagInput && tagInput.value) {
    const items = tagInput.value.split(/#+/).map(s => s.trim()).filter(Boolean);
    for (const it of items) {
      const t = it.slice(0, 20);
      if (!tags.includes(t) && tags.length < 5) tags.push(t);
    }
  }
  if (!title || !content) return alert('标题和内容不能为空');

  // 置顶开关（管理员专属）：和原始状态对比，变化才调 pin 接口
  const pinCheckbox = document.getElementById('editPinCheckbox');
  const newPinned = pinCheckbox ? !!pinCheckbox.checked : !!originalPinned;
  const pinChanged = newPinned !== !!originalPinned;

  const btn = document.getElementById('saveEditBtn');
  btn.disabled = true; btn.textContent = '保存中...';
  try {
    const r = await api.posts.update(postId, { title, content, tags, category });
    if (!r.success) { alert(r.message || '编辑失败'); return; }

    // 内容保存成功后，若置顶状态变化，再调置顶接口
    let pinMsg = '';
    if (pinChanged) {
      const pr = await api.posts.setPin(postId, newPinned);
      if (!pr.success) {
        pinMsg = `（但置顶操作失败：${pr.message || '未知错误'}）`;
      }
    }

    alert(`✅ 编辑成功！${pinMsg}`);
    // 重新渲染详情页
    renderDetail(document.getElementById('app'), postId);
  } finally {
    btn.disabled = false; btn.textContent = '保存修改';
  }
};

window.doPost = async function doPost() {
  const title = document.getElementById('titleInput').value.trim();
  const content = document.getElementById('contentInput').value.trim();
  // 输入框可能没失焦/没按回车，最后一次尝试把输入框里残留的文本当标签吸收
  const tagInput = document.getElementById('tagInput');
  if (tagInput) {
    try {
      const raw = (tagInput.value || '').trim();
      const items = raw.split(/#+/).map(s => s.trim()).filter(Boolean);
      for (const it of items) {
        const t = it.slice(0, 20);
        if (!draftPostTags.includes(t) && draftPostTags.length < 5 && !/["'\\<>{}]/.test(t)) draftPostTags.push(t);
      }
    } catch {}
  }
  if (!title || !content) return alert('标题和内容不能为空');
  const tags = [...draftPostTags]; // 拷贝一份，防止发布中用户还在改 chip
  const category = String(draftPostCategory || 'general');
  const btn = document.getElementById('postBtn');
  btn.disabled = true; btn.textContent = '发布中...';
  try {
    const r = await api.posts.create(title, content, tags, category, draftPostPinned);
    if (r.success) location.hash = 'forum';
    else alert(r.message || '发布失败');
  } finally {
    btn.disabled = false; btn.textContent = '发布';
  }
};

// ==================== 路由入口 ====================
function route() {
  const raw = (location.hash || '').slice(1);
  // 先剥掉查询串（#forum?cat=study → forum?cat=study → forum），否则带筛选的 hash 会被当成未知路径落到封面页
  const [pathPart, ...rest] = raw.split('?');
  const [seg1, seg2] = pathPart.split('/');
  const path = seg1 || 'home';
  const app = document.getElementById('app');

  if (path === 'login') renderLogin(app);
  else if (path === 'register') renderRegister(app);
  else if (path === 'post') renderPost(app);
  else if (path === 'detail' && seg2) renderDetail(app, parseInt(seg2, 10));
  else if (path === 'me') renderMe(app);
  else if (path === 'messages') renderMessages(app);
  else if (path === 'announcements') renderAnnouncements(app);
  else if (path === 'admin') renderAdmin(app);
  else if (path === 'forum') renderForum(app);
  else renderCover(app);
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
