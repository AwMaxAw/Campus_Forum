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

import * as api from './api.js?v=20260828-user-search';

// ==================== 工具函数 ====================
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

/** 把字面量 \n / \r\n 转为真正换行符（兼容历史脏数据） */
function normalizeNewlines(s) {
  return String(s == null ? '' : s).replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
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

/**
 * 图片压缩：使用 Canvas 将图片缩放到最大宽高 1280px，输出为 JPEG data URL。
 * 输入: File 对象
 * 输出: Promise<{ dataUrl, width, height, size, filename }>
 * - dataUrl: "data:image/jpeg;base64,..."
 * - width/height: 压缩后像素
 * - size: 压缩后字节数
 * 如果原图 ≤1280px 且 <1MB，直接返回原图（仅转为 JPEG 格式统一）
 */
function compressImage(file, maxDim = 1280, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = e => {
      img.onload = () => {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        let newW = w, newH = h;
        if (w > maxDim || h > maxDim) {
          if (w > h) { newW = maxDim; newH = Math.round(h * maxDim / w); }
          else { newH = maxDim; newW = Math.round(w * maxDim / h); }
        }
        const canvas = document.createElement('canvas');
        canvas.width = newW;
        canvas.height = newH;
        const ctx = canvas.getContext('2d');
        // 白底（处理 PNG 透明背景）
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, newW, newH);
        ctx.drawImage(img, 0, 0, newW, newH);
        canvas.toBlob(
          blob => {
            if (!blob) { reject(new Error('Canvas 导出失败')); return; }
            const reader2 = new FileReader();
            reader2.onload = e2 => {
              resolve({
                dataUrl: e2.target.result,
                width: newW,
                height: newH,
                size: blob.size,
                filename: file.name,
              });
            };
            reader2.readAsDataURL(blob);
          },
          'image/jpeg',
          quality
        );
      };
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
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
      <span class="nav-right-group">
        <span class="nav-user" title="我的主页" onclick="location.hash='me'">
          <span class="avatar-sm nav-avatar">${buildAvatarInner(me)}</span>
          <span class="user-nickname">${roleBadge}${escapeHtml(me.nickname)}</span>
        </span>
        <button class="secondary" onclick="doLogout()">退出</button>
      </span>
    `;
  } else {
    nav.innerHTML = `
      <span class="nav-right-group">
        <button class="secondary" onclick="location.hash='register'">注册</button>
        <button class="secondary" onclick="location.hash='login'">登录</button>
      </span>
    `;
  }
  renderDrawer(loggedIn, me, unreadMsg);
}

// ==================== 左侧抽屉 ====================
function renderDrawer(loggedIn, me, unreadMsg) {
  const drawerNav = document.getElementById('drawerNav');
  if (!drawerNav) return;
  const isAdmin = loggedIn && me && (me.role === 'admin' || me.role === 'dev_admin');
  const items = loggedIn
    ? [
        { label: '首页',     icon: '🏠', hash: 'home' },
        { label: '广场',     icon: '📢', hash: 'forum' },
        { label: '我的',     icon: '👤', hash: 'me' },
        { label: '公告',     icon: '📋', hash: 'announcements' },
        { label: '私信',     icon: '💬', hash: 'messages', badge: unreadMsg || 0 },
        { label: 'FAQ',      icon: '❓', hash: 'faq' },
        { label: '关于本站', icon: 'ℹ️', hash: 'about' },
        ...(isAdmin ? [{ label: '管理员面板', icon: '🛡', hash: 'admin', highlight: true }] : []),
      ]
    : [
        { label: '首页',     icon: '🏠', hash: 'home' },
        { label: '公告',     icon: '📋', hash: 'announcements' },
        { label: 'FAQ',      icon: '❓', hash: 'faq' },
        { label: '关于本站', icon: 'ℹ️', hash: 'about' },
      ];

  const cur = (location.hash || '').split('?')[0].slice(1) || 'home';
  drawerNav.innerHTML = items.map(it => {
    const active = cur === it.hash ? 'active' : '';
    const badge = it.badge ? `<span class="unread-badge">${it.badge}</span>` : '';
    const style = it.highlight ? 'style="color:#b45309"' : '';
    return `<a href="#${it.hash}" class="${active}" ${style} onclick="closeDrawer()">
      <span>${it.icon}</span>
      <span>${escapeHtml(it.label)}</span>
      ${badge}
    </a>`;
  }).join('');
}
function openDrawer() {
  const d = document.getElementById('sideDrawer');
  const o = document.getElementById('drawerOverlay');
  if (d) d.classList.add('open');
  if (o) o.classList.add('open');
}
function closeDrawer() {
  const d = document.getElementById('sideDrawer');
  const o = document.getElementById('drawerOverlay');
  if (d) d.classList.remove('open');
  if (o) o.classList.remove('open');
}
window.openDrawer = openDrawer;
window.closeDrawer = closeDrawer;

// ==================== 视图：帖子卡片（复用在首页列表/我的帖/我的赞/我的收藏） ====================
function postCard(p, opts = {}) {
  const author = p.authorNickname || `用户${p.authorUid}`;
  const time = formatTime(p.createdAt);
  // 作者公开资料（头像+昵称）：点头像或昵称进作者主页，stopPropagation 防触发卡片跳详情
  const authorUser = { uid: p.authorUid, nickname: p.authorNickname, avatarUrl: p.authorAvatarUrl, createdAt: p.createdAt, updatedAt: p.authorUpdatedAt };
  const authorHtml = `<span class="post-author" title="查看作者主页" onclick="event.stopPropagation();location.hash='#user/${escapeHtml(p.authorUid)}'"><span class="avatar-sm post-avatar">${buildAvatarInner(authorUser)}</span><span class="post-author-name">${escapeHtml(author)}</span></span>`;
  const tags = (Array.isArray(p.tags) && p.tags.length)
    ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">
         ${p.tags.map(t => `<span class="tag-chip" onclick="event.stopPropagation();setHomeFilter('tag',${escapeHtml(JSON.stringify(t))})" title="按标签「${escapeHtml(t)}」筛选">#${escapeHtml(t)}</span>`).join('')}
       </div>`
    : '';
  // 图片缩略图预览
  const imagesHtml = (Array.isArray(p.imageIds) && p.imageIds.length)
    ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px">
         ${p.imageIds.slice(0, 4).map(id => {
           const url = api.images.getUrl(id);
           return `<img src="${escapeHtml(url)}" alt="图片" style="width:80px;height:80px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb">`;
         }).join('')}
         ${p.imageIds.length > 4 ? `<span style="display:flex;align-items:center;justify-content:center;width:80px;height:80px;border-radius:6px;background:#f3f4f6;color:#6b7280;font-size:12px">+${p.imageIds.length - 4}</span>` : ''}
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
        ${pinBadge}${catBadge}${authorHtml}
        <span>·</span>
        <span>${escapeHtml(time)}</span>
      </div>
      <h3>${escapeHtml(p.title)}</h3>
      <p style="white-space:pre-wrap">${escapeHtml(normalizeNewlines((p.content || '').slice(0, 140)))}${(p.content || '').length > 140 ? '…' : ''}</p>
      ${imagesHtml}
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
// 多标签：tag 存为逗号分隔字符串（如 "高二,羽毛球"），这里统一解析成数组
function tagList(s) {
  return String(s == null ? '' : s).split(/[,，]/).map(t => t.trim().replace(/^#/, '')).filter(Boolean);
}
window.setHomeFilter = function setHomeFilter(key, value) {
  const f = getHomeFilters();
  if (key === 'sort') f.sortBy = value || 'latest';
  else if (key === 'category') f.category = value || '';
  else if (key === 'tag') {
    // value 为空串 = 清除全部标签；非空 = toggle（在/不在集合就移除/添加）
    if (!value) {
      f.tag = '';
    } else {
      const list = tagList(f.tag);
      const v = String(value).trim().replace(/^#/, '');
      const i = list.indexOf(v);
      if (i >= 0) list.splice(i, 1);
      else if (v) list.push(v);
      f.tag = list.join(',');
    }
  }
  else f[key] = value || '';
  location.hash = buildHomeHash(f);
  setTimeout(route, 0);
};
// 移除单个标签筛选（filterBadge 的 × 用）
window._removeHomeTag = function _removeHomeTag(value) {
  const f = getHomeFilters();
  const v = String(value || '').trim().replace(/^#/, '');
  f.tag = tagList(f.tag).filter(t => t !== v).join(',');
  location.hash = buildHomeHash(f);
  setTimeout(route, 0);
};
// 帖子 chip / 热门标签 chip 点击 = toggle 单个标签（多选）
window.clearHomeFilters = function clearHomeFilters() {
  location.hash = '#forum';
  setTimeout(route, 0);
};

// ==================== 用户搜索功能 ====================
window.runUserSearch = async function runUserSearch() {
  const input = document.getElementById('userSearchInput');
  const results = document.getElementById('userSearchResults');
  if (!input || !results) return;
  const q = (input.value || '').trim();
  if (!q) { results.innerHTML = ''; return; }

  results.innerHTML = '<span class="hint">🔄 搜索中...</span>';
  try {
    const r = await api.users.search(q);
    if (!r.success) { results.innerHTML = `<span class="hint">❌ ${escapeHtml(r.message)}</span>`; return; }
    const list = r.data || [];
    if (list.length === 0) {
      results.innerHTML = `<span class="hint">未找到匹配的用户</span>`;
      return;
    }
    results.innerHTML = `<div style="font-size:12px;color:#6b7280;margin-bottom:6px">找到 ${list.length} 个用户</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${list.map(u => renderUserSearchItem(u)).join('')}
      </div>`;
  } catch (e) {
    results.innerHTML = `<span class="hint">❌ 搜索失败：${escapeHtml(e.message)}</span>`;
  }
};

window.clearUserSearch = function clearUserSearch() {
  const input = document.getElementById('userSearchInput');
  const results = document.getElementById('userSearchResults');
  if (input) input.value = '';
  if (results) results.innerHTML = '';
};

function renderUserSearchItem(u) {
  const matchBadge = u.matchType === 'uid'
    ? `<span style="font-size:11px;color:#059669;background:#d1fae5;padding:0 5px;border-radius:4px;margin-left:4px">UID 匹配</span>`
    : `<span style="font-size:11px;color:#2563eb;background:#dbeafe;padding:0 5px;border-radius:4px;margin-left:4px">昵称匹配</span>`;
  return `<div onclick="location.hash='#user/${escapeHtml(u.uid)}'" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='#f9fafb'" onmouseout="this.style.background=''">
    <span class="avatar-sm" style="flex-shrink:0">${buildAvatarInner(u)}</span>
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:4px">
        <span style="font-weight:500;color:#1f2937">${escapeHtml(u.nickname)}</span>
        ${matchBadge}
        ${roleBadgeInline(u.role)}
      </div>
      <div style="font-size:12px;color:#6b7280">UID: ${escapeHtml(u.uid)} · 帖子 ${u.postCount || 0} · 注册 ${escapeHtml(formatTime(u.createdAt))}</div>
    </div>
    <span style="color:#6b7280;font-size:12px">→</span>
  </div>`;
}

/**
 * 用户主页「发私信」按钮：打开私信页面（如果已存在对话则直接进入）
 * 如果还没有对话，创建一条欢迎消息后跳转
 */
window.openQuickMessage = async function openQuickMessage(toUid, toNickname) {
  if (!api.isLoggedIn()) { alert('请先登录'); location.hash = 'login'; return; }
  if (!toUid) return;
  // 直接跳转到私信页面（私信系统已按对方 UID 聚合会话，首次进入会自动创建会话）
  location.hash = `messages?peer=${encodeURIComponent(toUid)}&name=${encodeURIComponent(toNickname || '')}`;
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

// ==================== 视图：关于本站（免责声明 / 法律风险规避）====================
function renderAbout(app) {
  app.innerHTML = `
    <div class="toolbar"><span style="font-size:16px;font-weight:600">ℹ️ 关于本站</span></div>

    <div class="card">
      <h3 style="margin-top:0">一、站点性质</h3>
      <p>本论坛（以下简称"本站"）由五中学生个人利用课余时间自发搭建与维护，属于<strong>非官方、非营利性</strong>的校园交流尝试。<strong>本站与广州市第五中学（以下简称"学校"）及其任何下属机构、社团、师生组织均无隶属、代理、合作或赞助关系</strong>，不代表学校立场，亦未获学校授权。站点名称中涉及"五中"字样仅为限定讨论圈层，不构成对学校名称权的主张。</p>
      <p>本站所有内容均由注册用户自行发布，<strong>本站及管理员仅提供信息存储与传输服务，不参与内容的编辑、采纳或背书</strong>。</p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">二、用户责任与行为规范</h3>
      <p>用户在注册及使用本站时，即视为<strong>已阅读、理解并同意</strong>本声明全部条款。用户须对自己的言论与发布行为承担<strong>全部法律责任</strong>，包括但不限于民事、行政及刑事责任。</p>
      <p>用户<strong>不得</strong>在本站发布、传播下列内容：</p>
      <ul>
        <li>违反宪法或法律、行政法规的；</li>
        <li>危害国家安全、泄露国家秘密、颠覆政权、破坏社会稳定的；</li>
        <li>煽动民族仇恨、民族歧视、破坏民族团结的；</li>
        <li>含有谣言、虚假信息、诈骗或教唆犯罪内容的；</li>
        <li>侮辱、诽谤他人，侵害他人名誉权、肖像权、隐私权等人格权的；</li>
        <li><strong>涉及他人真实姓名、学号、班级、电话、住址、身份证号等个人隐私信息的</strong>（无论是否本人同意，均不予允许）；</li>
        <li>含有淫秽、色情、暴力、恐怖或教唆未成年人不良行为的；</li>
        <li>侵犯他人知识产权、商业秘密或其他合法权益的；</li>
        <li>其他法律法规禁止或本站规则不允许的内容。</li>
      </ul>
      <p>用户发布上述内容的，<strong>由用户自行承担全部法律后果</strong>，本站不承担任何连带责任；本站有权在不通知的情况下删除违规内容、限制或封禁账号，并<strong>配合有权机关的调查与取证</strong>。</p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">三、内容免责</h3>
      <p>本站<strong>不对任何用户内容的真实性、准确性、完整性、合法性作出任何保证或承诺</strong>。用户不应据本站内容作出任何决定，因信赖本站内容而产生的任何损失，由用户自行承担。</p>
      <p>本站转载、存储的用户内容，<strong>不意味着本站赞同其观点或证实其描述</strong>。文责由发布者自负。</p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">四、侵权投诉与处理</h3>
      <p>若您认为本站任何内容侵犯您的合法权益（包括但不限于著作权、名誉权、隐私权等），请通过本站私信联系管理员，并提供：</p>
      <ul>
        <li>权利人的身份证明及联系方式；</li>
        <li>主张被侵权的内容链接或帖子标题；</li>
        <li>初步的权属证明及侵权说明。</li>
      </ul>
      <p>管理员将在合理时间内<strong>核实并删除涉嫌侵权的内容</strong>。本站在收到合格通知后，将依法依规采取必要措施，并<strong>不承担事先审查义务</strong>。</p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">五、服务变更与中断</h3>
      <p>本站基于第三方云服务（如 Cloudflare、Vercel/Netlify 等）运行，<strong>不保证服务持续可用、稳定或无故障</strong>。因服务器、网络、第三方平台、不可抗力等原因导致的服务中断、数据丢失或异常，本站<strong>不承担赔偿或恢复责任</strong>。</p>
      <p>本站有权<strong>随时修改、暂停或终止</strong>部分或全部服务，无需事先通知，且不承担任何责任。</p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">六、未成年人保护</h3>
      <p>本站面向中学生群体，用户<strong>大多为未成年人</strong>。请用户在监护人指导下使用，<strong>不得泄露本人或他人隐私</strong>，遇到不良信息或不当接触请立即告知监护人并联系管理员处理。本站将优先处置涉及未成年人的违规内容。</p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">七、知识产权</h3>
      <p>用户发布的内容，著作权归原作者所有。用户在本站发布内容，即视为<strong>授予本站免费的、非独占的、在全球范围内的存储、展示、传播及为维护站点必要而进行复制与改编的权利</strong>，但不改变著作权归属。</p>
      <p>本站页面的版式、代码、图标等设计元素，归本站开发者所有，未经许可不得复制或用于其他站点。</p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">八、免责声明的修改</h3>
      <p>本站有权<strong>随时修订本声明</strong>，修订后的声明自在本站公布之日起生效，用户继续使用本站即视为接受修订内容。请定期查阅本页。</p>
    </div>

    <div class="card" style="background:#fef3c7;border:1px solid #fde68a">
      <p style="margin:0;font-size:13px;color:#92400e"><strong>⚠️ 特别提示：</strong>继续访问或使用本站任何功能，即视为您已充分阅读、理解并自愿接受本声明全部条款，并自愿承担相应风险与责任。如您不同意，请立即停止使用并关闭本页。</p>
    </div>

    <div class="card" style="background:linear-gradient(135deg,#f0f9ff 0%,#faf5ff 100%);border:1px solid #e0e7ff">
      <h3 style="margin-top:0">🧑‍💻 关于开发者</h3>
      <p>本站由 <strong>Andrew</strong>（五中学生）独立开发与维护，属于个人课余项目。从前端到后端、从数据库到部署，全部由 Andrew 一人完成。</p>
      <p style="margin-top:10px">
        <a href="https://andrewawa.netlify.app" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-size:13px">
          🔗 访问开发者博客 →
        </a>
      </p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">🔗 友情链接</h3>
      <ul>
        <li><a href="https://andrewawa.netlify.app" target="_blank" rel="noopener">Andrew 的个人博客</a> — 开发者的技术分享与日常记录</li>
      </ul>
      <p style="color:#6b7280;font-size:12px">欢迎与本站交换友情链接，请通过私信联系管理员。</p>
    </div>

    <div style="text-align:center;padding:20px 10px;color:#9ca3af;font-size:12px">
      © 2026 五中校园论坛 · Made with ❤️ by Andrew · Powered by Cloudflare
    </div>
  `;
}

// ==================== 视图：常见问题与解答 FAQ ====================
function renderFaq(app) {
  const faqs = [
    { q: '这个论坛是学校官方的吗？', a: '不是。本站由五中学生 Andrew 利用课余时间独立开发与维护，属于非官方、非营利性的个人项目，与广州市第五中学无任何隶属或合作关系。' },
    { q: '怎么注册账号？', a: '打开注册页面，选择你所在的校区和学段，设置昵称和密码即可。UID 格式为：年份（2位）+ 校区（1=本部/2=金碧）+ 学段（1=初中/2=高中）+ 班级（2位）+ 学号（2位）。例如 26110101 = 26年入学 · 本部 · 初中 · 01班 · 01号。' },
    { q: '忘记密码了怎么办？', a: '目前本站暂不支持自助找回密码功能。请通过私信联系管理员，提供你的 UID 进行身份核实后，管理员可以帮你重置密码。' },
    { q: '我发的帖子为什么没了？', a: '可能的原因：① 帖子触发了敏感内容审核，被管理员隐藏或删除；② 你自己删除了；③ 网络问题导致发布失败但误以为成功。如果是被误删，可以私信管理员申请恢复。' },
    { q: '可以发广告或者推广自己的社团吗？', a: '社团招新、活动宣传这类和校园生活相关的内容是可以发的，建议发到「生活」或对应分区并加上合适的标签。但商业广告、外部产品推广、引流到其他平台是不允许的，管理员会直接删除。' },
    { q: '怎么删除自己发过的帖子或评论？', a: '打开帖子详情页，如果你是帖子作者，会看到「删除」按钮。评论也支持作者自己删除。如果你找不到删除按钮，可能是网络问题，请刷新页面试试。' },
    { q: '如何保护自己的隐私？', a: '请不要在帖子、评论或私信中公开自己或他人的真实姓名、身份证号、电话号码、家庭住址、具体班级学号等个人隐私信息。也不要把账号密码告诉任何人。遇到骚扰或隐私泄露，请立即联系管理员。' },
    { q: '管理员的权力有多大？', a: '管理员可以隐藏/删除违规帖子和评论、封禁违规账号、管理置顶帖。管理员不会查看你的私信内容（除非涉及违法或你主动举报）。管理员滥用权力的行为可以私信向开发者举报。' },
    { q: '论坛是怎么运行的？会突然关掉吗？', a: '本站托管在 Cloudflare 的免费服务上（Pages + Workers + D1），不保证永久在线。如果 Cloudflare 停服、开发者毕业或时间精力不足，论坛可能随时停掉。建议把重要内容备份到本地。' },
    { q: '我想给论坛提建议或帮忙，怎么联系？', a: '可以在站内私信管理员，或者通过「关于本站」页面里的友情链接访问开发者博客联系 Andrew。欢迎任何形式的反馈、建议和技术贡献！' },
  ];

  app.innerHTML = `
    <div class="toolbar"><span style="font-size:16px;font-weight:600">❓ 常见问题与解答</span></div>

    <div class="card" style="margin-bottom:16px;background:linear-gradient(135deg,#fef9c3 0%,#fef3c7 100%);border:1px solid #fde68a">
      <p style="margin:0;font-size:14px;color:#92400e">💡 这里整理了大家最常问的问题。如果你没有找到答案，可以私信管理员或在广场发帖询问。</p>
    </div>

    ${faqs.map((f, i) => `
      <div class="card" style="margin-bottom:8px;cursor:pointer" onclick="toggleFaq(${i})">
        <div style="display:flex;align-items:center;gap:8px;font-weight:600;color:#1f2937">
          <span style="color:#2563eb">Q${i + 1}.</span>
          <span>${escapeHtml(f.q)}</span>
          <span id="faqArrow${i}" style="margin-left:auto;color:#9ca3af;transition:transform 0.2s">▼</span>
        </div>
        <div id="faqAns${i}" style="display:none;margin-top:10px;padding:10px 12px;background:#f9fafb;border-radius:8px;font-size:14px;color:#374151;line-height:1.7">
          <strong style="color:#059669">A:</strong> ${escapeHtml(f.a)}
        </div>
      </div>
    `).join('')}

    <div class="card" style="margin-top:16px;text-align:center">
      <p style="margin:0;color:#6b7280">还有其他问题？欢迎 <a href="#messages" style="color:#2563eb">私信管理员</a> 或查看 <a href="#about" style="color:#2563eb">关于本站</a>。</p>
    </div>

    <script>
      function toggleFaq(i) {
        const ans = document.getElementById('faqAns' + i);
        const arrow = document.getElementById('faqArrow' + i);
        if (!ans || !arrow) return;
        if (ans.style.display === 'none') {
          ans.style.display = 'block';
          arrow.style.transform = 'rotate(180deg)';
        } else {
          ans.style.display = 'none';
          arrow.style.transform = 'rotate(0deg)';
        }
      }
    </script>
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
        <input id="stagInput" placeholder="按标签筛选（多个用逗号或 # 分隔，如：高二,羽毛球）" value="${escapeHtml(filters.tag)}" onkeydown="if(event.key==='Enter')homeRunSearch()">
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

    <!-- 搜索用户（独立卡片，紧凑） -->
    <div class="card search-panel" style="padding:12px 14px">
      <h3 style="margin:0 0 8px 0;font-size:14px">👤 搜索用户</h3>
      <div class="search-row" style="margin:0">
        <input id="userSearchInput" placeholder="输入 UID 或昵称关键字（如 20260101、五中、数学）" onkeydown="if(event.key==='Enter')runUserSearch()">
        <button onclick="runUserSearch()">🔎 搜用户</button>
        <button class="secondary" onclick="clearUserSearch()">🗑 清除</button>
      </div>
      <div id="userSearchResults" style="margin-top:10px"></div>
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
    const activeTags = new Set(tagList(filters.tag));
    box.innerHTML = `<div style="font-size:12px;color:#6b7280;margin-bottom:4px">🔥 最近 30 天热门标签（点击多选筛选，可叠加）：</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${tags.map(t =>
        `<span class="tag-chip ${activeTags.has(t.tag)?'active-tag':''}" onclick="setHomeFilter('tag',${escapeHtml(JSON.stringify(t.tag))})" title="该标签出现 ${t.count} 次，点击切换筛选">#${escapeHtml(t.tag)} <small style="opacity:.6">×${t.count}</small></span>`
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
      if (applied.tag) {
        for (const t of tagList(applied.tag)) {
          badges.push(`<span class="filter-badge">标签：<b>#${escapeHtml(t)}</b><button class="chip-close" onclick="window._removeHomeTag(${escapeHtml(JSON.stringify(t))})">×</button></span>`);
        }
      }
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
  // 多标签：把输入框文本按逗号/# 解析成集合再拼回（规范化，去重，去 # 前缀）
  f.tag = [...new Set(tagList(stag && stag.value || ''))].join(',');
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
    <div class="card" style="background:#eff6ff;border:1px solid #bfdbfe;margin-bottom:14px">
      <p style="margin:0;font-size:13px;color:#1e40af;line-height:1.6">
        📢 <strong>注册前必读：</strong>请先阅读
        <a href="#about" target="_blank" onclick="event.stopPropagation()" style="color:#2563eb">《关于本站》</a>
        中的<span style="color:#dc2626">隐私条款</span>、用户责任与行为规范、未成年人保护等全部声明。
      </p>
      <p style="margin:6px 0 0;font-size:12px;color:#6b7280">
        📌 UID 格式：<strong>26</strong>（年份）+ <strong>校区</strong>（1=五中本部 / 2=金碧校区）+ <strong>学段</strong>（1=初中 / 2=高中）+ <strong>班级</strong>（2位）+ <strong>学号</strong>（2位）= 共 8 位<br>
        例如：26110101 = 26届 · 五中本部 · 初中 · 01班 · 01号
      </p>
    </div>
    <div class="card">
      <h3>注册新账号</h3>

      <div style="margin-bottom:12px">
        <label style="font-size:13px;color:#424245;display:block;margin-bottom:6px">🏫 校区</label>
        <select id="campusSelect" style="width:100%;padding:8px 10px;border:1px solid #d2d2d7;border-radius:8px;font-size:14px;background:#fff">
          <option value="1">五中本部</option>
          <option value="2">金碧校区</option>
        </select>
      </div>

      <div style="margin-bottom:12px">
        <label style="font-size:13px;color:#424245;display:block;margin-bottom:6px">📚 学段</label>
        <select id="levelSelect" style="width:100%;padding:8px 10px;border:1px solid #d2d2d7;border-radius:8px;font-size:14px;background:#fff">
          <option value="1">初中</option>
          <option value="2">高中</option>
        </select>
      </div>

      <div style="display:flex;gap:10px;margin-bottom:12px">
        <div style="flex:1">
          <label style="font-size:13px;color:#424245;display:block;margin-bottom:6px">🏫 班级（2位）</label>
          <input id="classInput" placeholder="如 01" maxlength="2" inputmode="numeric" style="width:100%;padding:8px 10px;border:1px solid #d2d2d7;border-radius:8px;font-size:14px">
        </div>
        <div style="flex:1">
          <label style="font-size:13px;color:#424245;display:block;margin-bottom:6px">🔢 学号（2位）</label>
          <input id="stuNoInput" placeholder="如 01" maxlength="2" inputmode="numeric" style="width:100%;padding:8px 10px;border:1px solid #d2d2d7;border-radius:8px;font-size:14px">
        </div>
      </div>

      <div style="margin-bottom:12px;padding:8px 12px;background:#f3f4f6;border-radius:8px;font-family:monospace;font-size:16px;font-weight:600;color:#1d1d1f;text-align:center" id="uidPreview">
        UID：26110101
      </div>

      <input id="pwdInput" type="password" placeholder="密码（至少 6 位）" autocomplete="new-password">
      <input id="pwd2Input" type="password" placeholder="再次输入密码" autocomplete="new-password">
      <input id="nickInput" placeholder="昵称（1-20字，可选）" maxlength="20">
      <textarea id="bioInput" placeholder="个人简介（可选，200字内）" maxlength="200" style="min-height:60px"></textarea>
      <label style="display:flex;align-items:flex-start;gap:8px;margin:0 0 8px;font-size:13px;line-height:1.5;cursor:pointer">
        <input id="agreeInput" type="checkbox" style="margin-top:3px;width:auto;flex:0 0 auto">
        <span>我已阅读并同意 <a href="#about" target="_blank" onclick="event.stopPropagation()">《关于本站》</a> 中的全部声明（含隐私条款、站点性质、用户责任与行为规范、内容免责、侵权处理、未成年人保护、知识产权等）。</span>
      </label>
      <button id="regBtn" onclick="doRegister()">注册</button>
      <p class="hint">
        已经有账号？<a href="#login">直接登录 →</a><br>
        注册后 UID 不可修改，请确认填写正确。
      </p>
    </div>
  `;

  // UID 实时预览
  const campusSel = document.getElementById('campusSelect');
  const levelSel = document.getElementById('levelSelect');
  const classInp = document.getElementById('classInput');
  const stuInp = document.getElementById('stuNoInput');
  const preview = document.getElementById('uidPreview');
  function updatePreview() {
    const c = campusSel.value;
    const l = levelSel.value;
    const cl = (classInp.value || '').padStart(2, '0');
    const sn = (stuInp.value || '').padStart(2, '0');
    preview.textContent = `UID：26${c}${l}${cl}${sn}`;
  }
  campusSel.addEventListener('change', updatePreview);
  levelSel.addEventListener('change', updatePreview);
  classInp.addEventListener('input', updatePreview);
  stuInp.addEventListener('input', updatePreview);

  document.getElementById('pwd2Input').addEventListener('keydown', e => e.key === 'Enter' && doRegister());
}

// 发帖状态：标签数组 + 选中分区 key + 置顶 + 已上传图片
let draftPostTags = [];
let draftPostCategory = 'general';
let draftPostPinned = false;
let draftPostImages = [];  // [{ id, url, dataUrl, filename }]

function renderPost(app) {
  if (!api.isLoggedIn()) { location.hash = 'login'; return; }
  const me = api.getCurrentUser();
  const isAdmin = me && api.ADMIN_ROLES.has(String(me.role || ''));
  draftPostTags = [];
  draftPostCategory = 'general';
  draftPostPinned = false;
  draftPostImages = [];  // 重置图片

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

      <div style="margin-bottom:14px">
        <label style="font-size:13px;color:#424245;display:block;margin-bottom:6px">
          🖼 图片（可选，最多 9 张，单张不超过 5MB）
        </label>
        <div id="imagePreviewList" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px"></div>
        <label id="imageUploadBtn" style="display:inline-flex;align-items:center;gap:4px;padding:6px 14px;border:1px solid #d2d2d7;border-radius:8px;cursor:pointer;font-size:13px;color:#424245;background:#f9fafb">
          📷 选择图片
          <input id="imageFileInput" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple style="display:none">
        </label>
        <span id="imageUploadStatus" class="hint" style="margin-left:8px"></span>
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

  // --- 图片上传逻辑 ---
  const imageFileInput = document.getElementById('imageFileInput');
  const imagePreviewList = document.getElementById('imagePreviewList');
  const imageUploadStatus = document.getElementById('imageUploadStatus');

  function renderImagePreviews() {
    if (!imagePreviewList) return;
    if (draftPostImages.length === 0) {
      imagePreviewList.innerHTML = '';
      return;
    }
    imagePreviewList.innerHTML = draftPostImages.map((img, idx) => {
      const thumbUrl = img.url || img.dataUrl;
      return `<div style="position:relative;width:80px;height:80px;border-radius:8px;overflow:hidden;border:1px solid #d2d2d7">
        <img src="${escapeHtml(thumbUrl)}" style="width:100%;height:100%;object-fit:cover" alt="图片 ${idx + 1}">
        <button type="button" data-img-idx="${idx}" style="position:absolute;top:2px;right:2px;width:20px;height:20px;border:none;border-radius:50%;background:rgba(0,0,0,0.6);color:#fff;font-size:12px;cursor:pointer;line-height:1">×</button>
      </div>`;
    }).join('');
    // 绑定删除按钮
    imagePreviewList.querySelectorAll('[data-img-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-img-idx'), 10);
        draftPostImages.splice(idx, 1);
        renderImagePreviews();
      });
    });
  }

  if (imageFileInput) {
    imageFileInput.addEventListener('change', async () => {
      const files = imageFileInput.files;
      if (!files || files.length === 0) return;
      if (draftPostImages.length + files.length > 9) {
        imageUploadStatus.textContent = '最多 9 张图片，已自动截断';
      }
      const remaining = 9 - draftPostImages.length;
      const toUpload = Array.from(files).slice(0, remaining);
      imageUploadStatus.textContent = `正在上传 ${toUpload.length} 张图片...`;

      for (const file of toUpload) {
        try {
          // 压缩
          const compressed = await compressImage(file);
          // 上传到服务端
          const res = await api.images.upload(compressed.dataUrl, file.name);
          if (res.success) {
            draftPostImages.push({
              id: res.data.id,
              url: res.data.url,
              dataUrl: compressed.dataUrl,
              filename: res.data.filename || file.name,
            });
          } else {
            console.warn('图片上传失败:', res.message);
          }
        } catch (err) {
          console.warn('图片处理失败:', err.message);
        }
      }
      imageUploadStatus.textContent = draftPostImages.length > 0
        ? `✅ 已上传 ${draftPostImages.length} 张图片`
        : '';
      renderImagePreviews();
      imageFileInput.value = ''; // 允许重复选同一文件
    });
  }
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

  // 图片展示
  const imagesHtml = (Array.isArray(p.imageIds) && p.imageIds.length)
    ? `<div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:8px">
         ${p.imageIds.map(id => {
           const url = api.images.getUrl(id);
           return `<img src="${escapeHtml(url)}" alt="图片" onclick="window.open('${escapeHtml(url)}','_blank')" style="max-width:100%;max-height:400px;border-radius:8px;border:1px solid #e5e7eb;cursor:pointer" title="点击查看原图">`;
         }).join('')}
       </div>`
    : '';

  // 作者可点击进主页（头像+昵称）
  const detailAuthorUser = { uid: p.authorUid, nickname: p.authorNickname, avatarUrl: p.authorAvatarUrl, createdAt: p.createdAt, updatedAt: p.authorUpdatedAt };
  const detailAuthorHtml = `<span class="post-author" title="查看作者主页" onclick="location.hash='#user/${escapeHtml(p.authorUid)}'"><span class="avatar-sm post-avatar">${buildAvatarInner(detailAuthorUser)}</span><span class="post-author-name">${escapeHtml(p.authorNickname || `用户${p.authorUid}`)}</span></span>`;

  app.innerHTML = `
    <div style="margin-bottom:10px">
      <button class="ghost" onclick="location.hash='forum'">← 返回列表</button>
    </div>
    <div class="card detail-header">
      <div class="meta">
        ${pinBadge}${catBadge}${detailAuthorHtml}
        <span>·</span><span>${escapeHtml(formatTime(p.createdAt))}</span>
        <span>·</span><span>👁 ${p.viewCount} 浏览</span>
      </div>
      <h2>${escapeHtml(p.title)}</h2>
      <div class="detail-body">${escapeHtml(normalizeNewlines(p.content))}</div>
      ${imagesHtml}
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
// 生成头像内部 HTML：首字母占位 + 可选图片绝对覆盖（图片加载失败 onerror 自动隐藏 → 露出首字母）
// overrideSrc：上传完用本地 object URL 立即预览，绕过 KV 最终一致性延迟
function buildAvatarInner(user, overrideSrc) {
  const initials = ((user && (user.nickname || user.uid)) || '?').slice(0, 1).toUpperCase();
  const src = overrideSrc != null ? overrideSrc : api.getAvatarUrl(user);
  return `<span class="avatar-initials">${escapeHtml(initials)}</span>` +
    (src ? `<img class="avatar-img" src="${escapeHtml(src)}" alt="头像" onerror="this.style.display='none'">` : '');
}
// 上传完但 KV 还没全球同步时的本地预览 URL；renderMe 重新进入时清空（那时 KV 已同步）
let _pendingAvatarSrc = null;
// 用指定 src 刷新个人主页两处头像（顶部 header + 编辑预览），不动文本和输入框
function setAvatarPreviewsSrc(src) {
  const me = api.getCurrentUser();
  const html = buildAvatarInner(me, src);
  const h = document.getElementById('meHeaderAvatar'); if (h) h.innerHTML = html;
  const p = document.getElementById('editAvatarPreview'); if (p) p.innerHTML = html;
}
// 角色徽章（个人主页 header 用）
function roleBadgeInline(role) {
  if (role === 'dev_admin') return ' <span style="background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:4px;font-size:11px;margin-left:6px">开发管理员</span>';
  if (role === 'admin') return ' <span style="background:#fef3c7;color:#b45309;padding:1px 6px;border-radius:4px;font-size:11px;margin-left:6px">管理员</span>';
  return '';
}
// 资料变更后局部刷新：个人主页顶部 header（头像+昵称+简介）+ 编辑表单预览 + 顶栏昵称
// 不动 meContent 里的输入框，避免用户正在编辑的内容被清掉
function refreshMyProfileDisplay() {
  const me = api.getCurrentUser();
  if (!me) return;
  const header = document.getElementById('meProfileHeader');
  if (header) {
    header.innerHTML = `
      <div class="avatar-lg" id="meHeaderAvatar">${buildAvatarInner(me, _pendingAvatarSrc)}</div>
      <div style="flex:1">
        <div class="profile-name">${escapeHtml(me.nickname)}${roleBadgeInline(me.role)}</div>
        <div class="profile-uid">UID：${escapeHtml(me.uid)}　角色：${escapeHtml(me.role || 'member')}</div>
        ${me.bio ? `<div class="profile-bio">${escapeHtml(me.bio)}</div>` : ''}
      </div>
    `;
  }
  const preview = document.getElementById('editAvatarPreview');
  if (preview) preview.innerHTML = buildAvatarInner(me, _pendingAvatarSrc);
  if (typeof renderTopBar === 'function') renderTopBar();
}

async function renderMe(app) {
  if (!api.isLoggedIn()) { location.hash = 'login'; return; }
  _pendingAvatarSrc = null;   // 重新进入「我的」时 KV 早已同步，回退到正式取图 URL
  const me = api.getCurrentUser();

  app.innerHTML = `
    <div class="profile-header" id="meProfileHeader">
      <div class="avatar-lg" id="meHeaderAvatar">${buildAvatarInner(me)}</div>
      <div style="flex:1">
        <div class="profile-name">${escapeHtml(me.nickname)}${roleBadgeInline(me.role)}</div>
        <div class="profile-uid">UID：${escapeHtml(me.uid)}　角色：${escapeHtml(me.role || 'member')}</div>
        ${me.bio ? `<div class="profile-bio">${escapeHtml(me.bio)}</div>` : ''}
      </div>
    </div>
    <div class="toolbar">
      <div class="tab-bar">
        <button id="tabProfile" class="on" onclick="switchMeTab('profile')">✏️ 资料</button>
        <button id="tabMine" onclick="switchMeTab('mine')">📝 我发的帖</button>
        <button id="tabLikes" onclick="switchMeTab('likes')">♥ 点赞过</button>
        <button id="tabFavorites" onclick="switchMeTab('favorites')">★ 我的收藏</button>
        <button id="tabPassword" onclick="switchMeTab('password')">🔐 修改密码</button>
      </div>
      <button class="secondary" onclick="location.hash='post'">+ 发新帖</button>
    </div>
    <div id="meContent"><div class="empty">🔄 加载中...</div></div>
  `;
  window._currentMeTab = 'profile';
  loadMeTab('profile');
}

window.switchMeTab = function switchMeTab(tab) {
  // 5 个 tab：profile / mine / likes / favorites / password
  const tabIdMap = { profile: 'tabProfile', mine: 'tabMine', likes: 'tabLikes', favorites: 'tabFavorites', password: 'tabPassword' };
  Object.keys(tabIdMap).forEach(t => {
    const el = document.getElementById(tabIdMap[t]);
    if (el) el.classList.toggle('on', t === tab);
  });
  window._currentMeTab = tab;
  loadMeTab(tab);
};
async function loadMeTab(tab) {
  const host = document.getElementById('meContent');
  if (!host) return;

  // --- 编辑资料：头像（上传/外链）+ 昵称 + 简介 ---
  if (tab === 'profile') {
    const me = api.getCurrentUser() || {};
    host.innerHTML = `
      <div class="card">
        <h3 style="margin-top:0">✏️ 编辑个人资料</h3>
        <div class="profile-edit-row">
          <div class="avatar-lg" id="editAvatarPreview">${buildAvatarInner(me)}</div>
          <div class="profile-edit-avatar-actions">
            <label class="secondary" for="avatarFile">📷 从设备上传</label>
            <input id="avatarFile" type="file" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none" onchange="onAvatarFilePicked(this)">
            <button class="ghost" onclick="clearAvatar()">移除头像</button>
            <span class="hint">上传图片需 R2 已启用（≤2MB）；或下面填外链链接</span>
          </div>
        </div>
        <input id="avatarUrlInput" placeholder="或填图片外链链接 https://... （留空 = 不修改头像）">
        <label class="field-label" for="nicknameInput">昵称 <span class="hint">1-20 字</span></label>
        <input id="nicknameInput" value="${escapeHtml(me.nickname || '')}" maxlength="20">
        <label class="field-label" for="bioInput">自我简介 <span class="hint">最多 200 字</span></label>
        <textarea id="bioInput" rows="3" maxlength="200" placeholder="一句话介绍自己（选填）">${escapeHtml(me.bio || '')}</textarea>
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
          <button id="saveProfileBtn" onclick="doSaveProfile()">保存资料</button>
          <span class="hint" id="profileMsg"></span>
        </div>
      </div>
    `;
    return;
  }

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

// ==================== 个人资料：头像上传 / 移除 / 保存 ====================
window.onAvatarFilePicked = async function onAvatarFilePicked(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  const msg = document.getElementById('profileMsg');
  const setMsg = (t, color) => { if (msg) { msg.textContent = t; msg.style.color = color || ''; } };
  // 先用本地 object URL 立即预览，不等 KV 全球同步
  let localUrl = '';
  try { localUrl = URL.createObjectURL(file); } catch {}
  if (localUrl) setAvatarPreviewsSrc(localUrl);
  setMsg('上传中...', '');
  const r = await api.auth.uploadAvatar(file);
  if (r.success) {
    setMsg('✅ 头像已更新', '#059669');
    // 记住本地预览，后续保存资料/刷新不会用未同步的 KV URL 覆盖
    _pendingAvatarSrc = localUrl || null;
  } else {
    setMsg('❌ ' + (r.message || '上传失败'), '#dc2626');
    // 失败：回退到之前的正式头像（userCache 仍是旧值）
    _pendingAvatarSrc = null;
    refreshMyProfileDisplay();
    if (localUrl) { try { URL.revokeObjectURL(localUrl); } catch {} }
  }
  input.value = '';   // 允许重复选同一文件触发 onchange
};

window.clearAvatar = async function clearAvatar() {
  const msg = document.getElementById('profileMsg');
  const setMsg = (t, color) => { if (msg) { msg.textContent = t; msg.style.color = color || ''; } };
  if (!confirm('确定移除当前头像？将恢复为昵称首字母占位。')) return;
  setMsg('处理中...', '');
  const r = await api.auth.updateProfile({ avatarUrl: '' });   // 空串 = 清空头像
  if (r.success) {
    setMsg('✅ 已移除头像', '#059669');
    if (_pendingAvatarSrc) { try { URL.revokeObjectURL(_pendingAvatarSrc); } catch {} }
    _pendingAvatarSrc = null;
    refreshMyProfileDisplay();
  } else {
    setMsg('❌ ' + (r.message || '移除失败'), '#dc2626');
  }
};

window.doSaveProfile = async function doSaveProfile() {
  const btn = document.getElementById('saveProfileBtn');
  const msg = document.getElementById('profileMsg');
  if (!btn || !msg) return;
  const nickname = (document.getElementById('nicknameInput').value || '').trim();
  const bio = (document.getElementById('bioInput').value || '');
  const urlVal = (document.getElementById('avatarUrlInput').value || '').trim();
  if (!nickname) { msg.style.color = '#dc2626'; msg.textContent = '❌ 昵称不能为空'; return; }
  if (nickname.length > 20) { msg.style.color = '#dc2626'; msg.textContent = '❌ 昵称最多 20 字'; return; }
  if (bio.length > 200) { msg.style.color = '#dc2626'; msg.textContent = '❌ 简介最多 200 字'; return; }
  if (urlVal && !/^https?:\/\//i.test(urlVal)) { msg.style.color = '#dc2626'; msg.textContent = '❌ 头像链接必须是 http(s) 网址'; return; }

  btn.disabled = true; btn.textContent = '保存中...';
  msg.textContent = ''; msg.style.color = '';
  try {
    // 头像外链留空则不传 → 不会覆盖已上传的 KV 头像
    const body = { nickname, bio };
    if (urlVal) body.avatarUrl = urlVal;
    const r = await api.auth.updateProfile(body);
    if (r.success) {
      msg.style.color = '#059669';
      msg.textContent = '✅ 资料已保存';
      const urlInput = document.getElementById('avatarUrlInput');
      if (urlInput) urlInput.value = '';   // 已生效，清空避免重复保存又覆盖
      if (urlVal) {
        // 头像换成了外链 → 本地上传预览 blob 作废
        if (_pendingAvatarSrc) { try { URL.revokeObjectURL(_pendingAvatarSrc); } catch {} }
        _pendingAvatarSrc = null;
      }
      refreshMyProfileDisplay();
    } else {
      msg.style.color = '#dc2626';
      msg.textContent = '❌ ' + (r.message || '保存失败');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '保存资料'; }
  }
};

// ==================== 视图：私信（会话列表 + 对话窗） ====================
async function renderMessages(app, autoPeerUid, autoPeerName) {
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

  // 如果是从用户主页带参进来的，自动填充并打开对话
  if (autoPeerUid) {
    const newDmInput = document.getElementById('newDmUid');
    if (newDmInput) newDmInput.value = autoPeerUid;
    // 等会话列表加载完再打开
    setTimeout(() => {
      openConversation(autoPeerUid);
    }, 300);
  }

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

    <!-- 板块1：已注册账号（按 UID 分组） -->
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

    <!-- 板块3.5：带图片帖区（紧凑行布局，方便批量删除） -->
    <div class="card">
      <h3 style="margin-top:0">🖼 带图片帖区</h3>
      <p class="hint">所有包含图片的帖子一行一行紧密排列，点击可查看详情，右侧按钮可直接删除。</p>
      <div id="adminImagePosts">🔄 加载中...</div>
    </div>

    <!-- 板块4：其他帖子列表（非置顶，按时间倒序，点击可进详情） -->
    <div class="card">
      <h3 style="margin-top:0">📄 其他帖子</h3>
      <p class="hint">除置顶帖外的全部帖子，按发布时间倒序列出。点击标题可跳转详情页编辑/管理。</p>
      <div id="adminPosts">🔄 加载中...</div>
    </div>
  `;

  // --- 板块1：账号列表（含最后登录时间 / 状态 / 注销·封禁操作）---
  renderAdminUsers(document.getElementById('adminUsers'));

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

  // --- 板块3.5：带图片帖区（紧凑行布局）---
  (async () => {
    const host = document.getElementById('adminImagePosts');
    try {
      const r = await api.admin.postsWithImages();
      if (!r.success) { host.innerHTML = `❌ ${escapeHtml(r.message)}`; return; }
      const list = r.data || [];
      if (list.length === 0) { host.innerHTML = `<span class="hint">暂无带图片的帖子</span>`; return; }
      host.innerHTML = `<div style="font-size:12px;color:#6b7280;margin-bottom:8px">共 ${list.length} 条带图片帖子</div>
        ${list.map(p => {
          const author = p.authorNickname || `用户${p.authorUid}`;
          const firstImgUrl = p.firstImage ? api.images.getUrl(p.firstImage.id) : '';
          const tagHtml = (Array.isArray(p.tags) && p.tags.length)
            ? p.tags.slice(0, 3).map(t => `<span class="tag-chip" style="font-size:11px;padding:0 5px">#${escapeHtml(t)}</span>`).join('')
            : '';
          return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:4px">
            ${firstImgUrl ? `<img src="${escapeHtml(firstImgUrl)}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb;flex-shrink:0" alt="缩略图">` : `<div style="width:44px;height:44px;background:#f3f4f6;border-radius:6px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:18px">🖼</div>`}
            <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
              <div style="display:flex;align-items:center;gap:6px">
                ${categoryBadgeHtml(p.category)}
                <a href="#detail/${p.id}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#2563eb;text-decoration:none;font-size:14px;font-weight:500" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</a>
                ${p.imageCount > 1 ? `<span style="font-size:11px;color:#6b7280;background:#f3f4f6;padding:0 5px;border-radius:4px;flex-shrink:0">${p.imageCount}张</span>` : ''}
              </div>
              <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#6b7280;overflow:hidden">
                <span style="flex-shrink:0">${escapeHtml(author)}</span>
                <span style="flex-shrink:0">·</span>
                <span style="flex-shrink:0">${escapeHtml(formatTime(p.createdAt))}</span>
                <div style="display:flex;gap:3px;overflow:hidden">${tagHtml}</div>
              </div>
            </div>
            <button data-del-post="${p.id}" style="flex-shrink:0;padding:4px 10px;border:1px solid #fecaca;background:#fef2f2;color:#dc2626;border-radius:6px;font-size:12px;cursor:pointer" title="删除此帖（连带图片）">🗑 删除</button>
          </div>`;
        }).join('')}`;
      // 绑定删除按钮
      host.querySelectorAll('[data-del-post]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const postId = parseInt(btn.getAttribute('data-del-post'), 10);
          if (!confirm(`确定删除帖子 #${postId}？\n将连带删除该帖的全部图片、评论、点赞等数据，不可恢复！`)) return;
          btn.disabled = true; btn.textContent = '删除中...';
          try {
            const res = await api.admin.deletePost(postId);
            if (res.success) {
              btn.closest('[data-del-post]')?.parentElement?.remove();
              // 刷新计数
              const remaining = host.querySelectorAll('[data-del-post]').length;
              const countEl = host.querySelector('div[style*="margin-bottom:8px"]');
              if (countEl) countEl.textContent = remaining > 0 ? `共 ${remaining} 条带图片帖子` : '暂无带图片的帖子';
              if (remaining === 0) host.innerHTML = `<span class="hint">暂无带图片的帖子</span>`;
            } else {
              alert('删除失败：' + (res.message || '未知错误'));
              btn.disabled = false; btn.textContent = '🗑 删除';
            }
          } catch (e) {
            alert('删除出错：' + e.message);
            btn.disabled = false; btn.textContent = '🗑 删除';
          }
        });
      });
    } catch (e) { host.innerHTML = `❌ ${escapeHtml(e.message)}`; }
  })();

  // --- 板块4：其他帖子（非置顶，只读列表）---
  (async () => {
    const host = document.getElementById('adminPosts');
    try {
      const r = await api.admin.listPosts();
      if (!r.success) { host.innerHTML = `❌ ${escapeHtml(r.message)}`; return; }
      const list = r.data || [];
      if (list.length === 0) { host.innerHTML = `<span class="hint">暂无其他帖子</span>`; return; }
      host.innerHTML = `<div style="font-size:12px;color:#6b7280;margin-bottom:8px">共 ${list.length} 条非置顶帖</div>
        ${list.map(p => {
          const author = p.authorNickname || `用户${p.authorUid}`;
          const tagHtml = (Array.isArray(p.tags) && p.tags.length)
            ? p.tags.map(t => `<span class="tag-chip" style="font-size:11px;padding:1px 6px">#${escapeHtml(t)}</span>`).join('')
            : '';
          return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:6px">
            ${categoryBadgeHtml(p.category)}
            <a href="#detail/${p.id}" style="flex:1;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#2563eb;text-decoration:none" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</a>
            ${tagHtml ? `<div style="display:flex;flex-wrap:wrap;gap:4px;flex-basis:100%;margin-top:2px">${tagHtml}</div>` : ''}
            <span style="white-space:nowrap;color:#6b7280;font-size:12px;margin-left:auto">${escapeHtml(author)} · ${escapeHtml(formatTime(p.createdAt))}</span>
          </div>`;
        }).join('')}`;
    } catch (e) { host.innerHTML = `❌ ${escapeHtml(e.message)}`; }
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
        const p = byId.get(id) || { id, title: '(该帖已不存在)', category: '', authorUid: '', authorNickname: null, createdAt: '' };
        const isFirst = idx === 0;
        const isLast = idx === _adminPinOrder.length - 1;
        const author = p.authorNickname || (p.authorUid ? `用户${p.authorUid}` : '');
        return `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:6px;background:#fffbeb">
          <span style="font-weight:700;color:#b45309;min-width:24px;text-align:center">${idx + 1}</span>
          ${categoryBadgeHtml(p.category)}
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</span>
          <span style="white-space:nowrap;color:#6b7280;font-size:12px">${escapeHtml(author)}${p.createdAt ? ` · ${escapeHtml(formatTime(p.createdAt))}` : ''}</span>
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

// ==================== 管理员：账号列表渲染 + 封禁/注销二次确认 ====================
/**
 * 渲染管理员面板的账号列表板块（含最后登录时间、状态徽章、封禁/注销操作按钮）。
 * 拆成独立函数，便于封禁/注销成功后单独刷新本板块而不影响其他板块状态。
 */
async function renderAdminUsers(host) {
  if (!host) return;
  host.innerHTML = `🔄 加载中...`;
  try {
    const r = await api.admin.listUsers();
    if (!r.success) { host.innerHTML = `❌ ${escapeHtml(r.message)}`; return; }
    const users = r.data || [];
    if (users.length === 0) { host.innerHTML = `<span class="hint">暂无注册账号</span>`; return; }

    const me = api.getCurrentUser();
    const myUid = me && me.uid;
    const myRole = me && me.role;

    // 按 UID 分组：261* → 五中本部，262* → 金碧校区，其他 → 其他
    const isCampusA = u => /^261/.test(String(u.uid));   // 五中本部
    const isCampusB = u => /^262/.test(String(u.uid));   // 金碧校区
    const groupA = users.filter(isCampusA);
    const groupB = users.filter(isCampusB);
    const groupC = users.filter(u => !isCampusA(u) && !isCampusB(u));

    // 渲染单个分组表格的内部函数
    function groupTable(title, subtitle, list, color) {
      if (list.length === 0) return '';
      return `
        <div style="margin-bottom:18px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="display:inline-block;width:4px;height:18px;background:${color};border-radius:2px"></span>
            <span style="font-weight:600;font-size:14px">${escapeHtml(title)}</span>
            <span style="font-size:12px;color:#6b7280">· ${list.length} 个账号</span>
          </div>
          ${subtitle ? `<div style="font-size:12px;color:#9ca3af;margin-bottom:6px">${escapeHtml(subtitle)}</div>` : ''}
          <div style="overflow-x:auto">
            <table class="admin-table">
              <thead><tr>
                <th>UID</th><th>昵称</th><th>角色</th><th>帖子数</th>
                <th>注册时间</th><th>最后登录</th><th>状态</th><th>操作</th>
              </tr></thead>
              <tbody>
                ${list.map(u => buildUserRow(u, myUid, myRole)).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }

    host.innerHTML = `
      <div style="font-size:12px;color:#6b7280;margin-bottom:10px">共 ${users.length} 个账号 · 危险操作（封禁/注销）需二次确认</div>
      ${groupTable('五中本部', '26 届学生账号 · 五中本部', groupA, '#1e40af')}
      ${groupTable('金碧校区', '26 届学生账号 · 金碧校区', groupB, '#059669')}
      ${groupTable('其他', '非 26 开头的账号', groupC, '#6b7280')}
    `;

    // 事件委托
    host.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        const uid = btn.dataset.uid;
        const nick = btn.dataset.nick;
        const posts = btn.dataset.posts;
        if (act === 'ban')    confirmBan(uid, nick);
        if (act === 'unban')  confirmUnban(uid, nick);
        if (act === 'delete') confirmDelete(uid, nick, posts);
      });
    });
  } catch (e) {
    host.innerHTML = `❌ ${escapeHtml(e.message)}`;
  }
}

// 构建单个用户表格行（两个分组共用，避免重复代码）
function buildUserRow(u, myUid, myRole) {
  const isMe = u.uid === myUid;
  const isDevAdmin = u.role === 'dev_admin';
  const isAdmin = u.role === 'admin' || isDevAdmin;
  const canBan    = !isMe && (!isAdmin || myRole === 'dev_admin');
  const canUnban  = !isMe && u.isBanned && (!isAdmin || myRole === 'dev_admin');
  const canDelete = !isMe && !isDevAdmin && (!isAdmin || myRole === 'dev_admin');

  const banBtn = u.isBanned
    ? (canUnban
        ? `<button class="btn-mini btn-success" data-act="unban" data-uid="${escapeHtml(u.uid)}" data-nick="${escapeHtml(u.nickname)}">解封</button>`
        : `<span class="hint" style="margin:0">—</span>`)
    : (canBan
        ? `<button class="btn-mini btn-danger" data-act="ban" data-uid="${escapeHtml(u.uid)}" data-nick="${escapeHtml(u.nickname)}">封禁</button>`
        : `<span class="hint" style="margin:0">—</span>`);
  const delBtn = canDelete
    ? `<button class="btn-mini btn-warning" data-act="delete" data-uid="${escapeHtml(u.uid)}" data-nick="${escapeHtml(u.nickname)}" data-posts="${u.postCount || 0}">注销</button>`
    : (isMe ? `<span class="hint" style="margin:0" title="不能注销自己">本人</span>` : `<span class="hint" style="margin:0" title="该账号受保护">—</span>`);

  const statusBadge = u.isBanned
    ? `<span class="status-badge status-banned">已封禁</span>`
    : `<span class="status-badge status-normal">正常</span>`;
  const lastLogin = u.lastLoginAt ? escapeHtml(formatTime(u.lastLoginAt)) : `<span class="hint" style="margin:0">从未登录</span>`;
  const roleText = isDevAdmin ? '开发管理员' : isAdmin ? '管理员' : '普通成员';
  const selfTag = isMe ? ` <span style="color:#0071e3;font-size:11px">（我）</span>` : '';

  return `<tr>
    <td>${escapeHtml(u.uid)}</td>
    <td>${escapeHtml(u.nickname)}${selfTag}</td>
    <td>${roleText}</td>
    <td>${u.postCount || 0}</td>
    <td>${escapeHtml(formatTime(u.createdAt))}</td>
    <td>${lastLogin}</td>
    <td>${statusBadge}</td>
    <td class="action-cell">${banBtn}${delBtn}</td>
  </tr>`;
}

/**
 * 通用二次确认弹窗（危险操作专用）。
 * @param {Object} opts
 * @param {string} opts.title       弹窗标题
 * @param {string} opts.message     正文（允许 HTML，调用方自行 escape）
 * @param {string} opts.confirmText 确认按钮文案
 * @param {string} [opts.cancelText] 取消按钮文案（默认"取消"）
 * @param {boolean} [opts.danger]    是否危险（红色按钮）
 * @param {string} [opts.requireText] 需要用户精确输入的文本（输入正确才解锁确认按钮，不可逆操作专用）
 * @returns {Promise<boolean>}     true=用户确认，false=取消
 */
function adminConfirm(opts) {
  return new Promise(resolve => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.style.zIndex = '120';
    const needInput = !!opts.requireText;
    mask.innerHTML = `
      <div class="modal" style="max-width:460px">
        <div class="modal-header">
          <span class="modal-title">${opts.danger ? '⚠️ ' : ''}${escapeHtml(opts.title || '确认操作')}</span>
        </div>
        <div class="modal-body" style="font-size:14px;line-height:1.7;white-space:normal">
          ${opts.message || ''}
          ${needInput ? `
            <div style="margin-top:12px;padding-top:10px;border-top:1px dashed #e5e7eb">
              <div style="font-size:12px;color:#6b7280;margin-bottom:6px">请输入 <b>${escapeHtml(opts.requireText)}</b> 以确认：</div>
              <input id="adminConfirmInput" type="text" autocomplete="off" style="width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:14px" />
            </div>` : ''}
        </div>
        <div class="modal-footer" style="justify-content:flex-end;gap:8px">
          <button class="secondary" id="adminConfirmCancel">${escapeHtml(opts.cancelText || '取消')}</button>
          <button id="adminConfirmOk" ${opts.danger ? 'class="danger"' : ''} ${needInput ? 'disabled' : ''}>${escapeHtml(opts.confirmText || '确认')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(mask);

    const okBtn = mask.querySelector('#adminConfirmOk');
    const cancelBtn = mask.querySelector('#adminConfirmCancel');
    let done = false;
    const close = (result) => {
      if (done) return;
      done = true;
      mask.remove();
      resolve(result);
    };
    cancelBtn.addEventListener('click', () => close(false));
    mask.addEventListener('click', e => { if (e.target === mask) close(false); });
    okBtn.addEventListener('click', () => close(true));

    if (needInput) {
      const input = mask.querySelector('#adminConfirmInput');
      const target = opts.requireText;
      const check = () => { okBtn.disabled = input.value.trim() !== target; };
      input.addEventListener('input', check);
      input.addEventListener('keydown', e => { if (e.key === 'Enter' && !okBtn.disabled) close(true); });
      setTimeout(() => input.focus(), 0);
    } else {
      okBtn.addEventListener('keydown', e => { if (e.key === 'Enter') close(true); });
      setTimeout(() => okBtn.focus(), 0);
    }
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(false); document.removeEventListener('keydown', esc); }
    });
  });
}

// ---- 封禁（危险：禁止登录）----
async function confirmBan(uid, nick) {
  const ok = await adminConfirm({
    title: '封禁账号',
    danger: true,
    confirmText: '确认封禁',
    message: `确定要封禁账号 <b>${escapeHtml(nick)}</b>（UID：${escapeHtml(uid)}）吗？<br/>
              封禁后该用户将<b>无法登录</b>，但已发布内容保留。<br/>
              你可随时在右侧点「解封」恢复登录。`,
  });
  if (!ok) return;
  const r = await api.admin.banUser(uid);
  if (r.success) {
    await renderAdminUsers(document.getElementById('adminUsers'));
  } else {
    alert(`封禁失败：${r.message || '未知错误'}`);
  }
}

// ---- 解封（恢复正常登录，非危险，但仍二次确认防误触）----
async function confirmUnban(uid, nick) {
  const ok = await adminConfirm({
    title: '解封账号',
    confirmText: '确认解封',
    message: `确定要解封账号 <b>${escapeHtml(nick)}</b>（UID：${escapeHtml(uid)}）吗？<br/>解封后该用户可正常登录。`,
  });
  if (!ok) return;
  const r = await api.admin.unbanUser(uid);
  if (r.success) {
    await renderAdminUsers(document.getElementById('adminUsers'));
  } else {
    alert(`解封失败：${r.message || '未知错误'}`);
  }
}

// ---- 注销（最危险：物理删除 + 级联，不可恢复，必须输入昵称解锁）----
async function confirmDelete(uid, nick, posts) {
  const ok = await adminConfirm({
    title: '永久注销账号',
    danger: true,
    confirmText: '确认永久注销',
    requireText: nick,
    message: `<b style="color:#dc2626">⚠ 此操作不可恢复！</b><br/>
              确定要永久注销账号 <b>${escapeHtml(nick)}</b>（UID：${escapeHtml(uid)}）吗？<br/>
              将<b>物理删除</b>该用户及其所有关联数据，包括：
              <ul style="margin:6px 0 0 18px;padding:0">
                <li>帖子 ${escapeHtml(String(posts || 0))} 篇</li>
                <li>全部评论、楼中楼回复</li>
                <li>所有私信记录</li>
                <li>点赞、收藏数据</li>
              </ul>
              为防止误操作，请在下方输入该账号昵称 <b>${escapeHtml(nick)}</b> 以解锁确认按钮。`,
  });
  if (!ok) return;
  const r = await api.admin.deleteUser(uid);
  if (r.success) {
    await renderAdminUsers(document.getElementById('adminUsers'));
  } else {
    alert(`注销失败：${r.message || '未知错误'}`);
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
      location.hash = 'forum';
    } else alert(r.message || '登录失败');
  } finally {
    btn.disabled = false; btn.textContent = '登录';
  }
};
window.doRegister = async function doRegister() {
  const campus = document.getElementById('campusSelect').value;
  const level = document.getElementById('levelSelect').value;
  const cls = (document.getElementById('classInput').value || '').trim();
  const stuNo = (document.getElementById('stuNoInput').value || '').trim();
  const uid = `26${campus}${level}${cls.padStart(2,'0')}${stuNo.padStart(2,'0')}`;
  const pwd = document.getElementById('pwdInput').value;
  const confirm = document.getElementById('pwd2Input').value;
  const nickname = (document.getElementById('nickInput').value || '').trim();
  const bio = (document.getElementById('bioInput').value || '').trim();
  if (!/^26[12][12]\d{4}$/.test(uid)) return alert('UID 格式无效，请检查班级和学号是否各为 2 位数字');
  if (pwd.length < 6) return alert('密码至少 6 位');
  if (pwd !== confirm) return alert('两次输入的密码不一致');
  if (!document.getElementById('agreeInput').checked) return alert('请先阅读并勾选同意《关于本站》中的声明后再注册');
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
  const imageIds = draftPostImages.map(img => img.id);
  const btn = document.getElementById('postBtn');
  btn.disabled = true; btn.textContent = '发布中...';
  try {
    const r = await api.posts.create(title, content, tags, category, draftPostPinned, imageIds);
    if (r.success) location.hash = 'forum';
    else alert(r.message || '发布失败');
  } finally {
    btn.disabled = false; btn.textContent = '发布';
  }
};

// ==================== 视图：用户公开主页（点头像/昵称进入） ====================
async function renderUserProfile(app, uid) {
  app.innerHTML = `<div class="empty">🔄 加载中...</div>`;
  let profile = null, postsRes = null;
  try {
    const [pr, pl] = await Promise.all([
      api.users.getProfile(uid),
      api.posts.list(1, 20, { author: uid }),
    ]);
    if (pr && pr.success) profile = pr.data;
    if (pl && pl.success) postsRes = pl;
  } catch {}

  if (!profile) {
    app.innerHTML = `<div class="card"><p>用户不存在或已注销。</p><button class="secondary" onclick="history.back()">← 返回</button></div>`;
    return;
  }
  const me = api.isLoggedIn() ? api.getCurrentUser() : null;
  const isMe = me && me.uid === profile.uid;
  const canMessage = !isMe && api.isLoggedIn();
  const messageBtn = canMessage
    ? `<button onclick="openQuickMessage('${escapeHtml(profile.uid)}','${escapeHtml(profile.nickname)}')" style="margin-top:8px">✉️ 发私信</button>`
    : '';
  const editBtn = isMe
    ? `<button class="secondary" onclick="location.hash='me'" style="margin-top:8px">✏️ 去编辑我的资料</button>`
    : '';
  const header = `
    <div class="profile-header" id="userProfileHeader">
      <div class="avatar-lg">${buildAvatarInner(profile)}</div>
      <div style="flex:1">
        <div class="profile-name">${escapeHtml(profile.nickname)}${roleBadgeInline(profile.role)}${isMe ? ' <span style="color:#6b7280;font-size:12px;margin-left:6px">（这是你自己）</span>' : ''}</div>
        <div class="profile-uid">UID：${escapeHtml(profile.uid)}　帖子数：${profile.postCount || 0}　注册于 ${escapeHtml(formatTime(profile.createdAt))}</div>
        ${profile.bio ? `<div class="profile-bio">${escapeHtml(profile.bio)}</div>` : '<div class="profile-bio" style="opacity:0.6">这个人还没有写简介</div>'}
        <div style="display:flex;gap:8px;flex-wrap:wrap">${editBtn}${messageBtn}</div>
      </div>
    </div>
  `;
  const list = (postsRes && Array.isArray(postsRes.data) && postsRes.data.length)
    ? postsRes.data.map(p => postCard(p, { allowClick: true })).join('')
    : `<div class="empty">该用户还没有发过帖子</div>`;
  app.innerHTML = `
    ${header}
    <div class="toolbar"><button class="secondary" onclick="history.back()">← 返回</button></div>
    <h3 style="margin:8px 0">${escapeHtml(profile.nickname)} 发布的帖子</h3>
    <div class="post-list">${list}</div>
  `;
}

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
  else if (path === 'user' && seg2) renderUserProfile(app, seg2);
  else if (path === 'messages') {
    // 解析查询参数：messages?peer=UID&name=昵称
    const qs = rest.join('?');
    const qp = new URLSearchParams(qs);
    const peerUid = qp.get('peer');
    const peerName = qp.get('name');
    renderMessages(app, peerUid, peerName);
  }
  else if (path === 'announcements') renderAnnouncements(app);
  else if (path === 'faq') renderFaq(app);
  else if (path === 'about') renderAbout(app);
  else if (path === 'admin') renderAdmin(app);
  else if (path === 'forum') renderForum(app);
  else renderCover(app);
}

window.addEventListener('hashchange', () => { route(); refreshDrawerActive(); });
window.addEventListener('load', async () => {
  // 静默刷新登录态
  if (api.getToken()) {
    try { await api.auth.me(); } catch {}
  }
  await renderTopBar();
  route();
  // 绑定汉堡按钮 + 遮罩点击
  const mt = document.getElementById('menuToggle');
  const dc = document.getElementById('drawerClose');
  const ov = document.getElementById('drawerOverlay');
  if (mt) mt.addEventListener('click', openDrawer);
  if (dc) dc.addEventListener('click', closeDrawer);
  if (ov) ov.addEventListener('click', closeDrawer);
  // 登录后拉未读公告弹窗（异步，不阻塞渲染）
  popupUnreadAnnouncements();
  // 每 60 秒刷新一次未读消息数（顶栏红点）
  setInterval(() => { if (api.isLoggedIn()) renderTopBar(); }, 60 * 1000);
});
function refreshDrawerActive() {
  const drawerNav = document.getElementById('drawerNav');
  if (!drawerNav) return;
  const cur = (location.hash || '').split('?')[0].slice(1) || 'home';
  drawerNav.querySelectorAll('a').forEach(a => {
    const href = (a.getAttribute('href') || '').replace(/^#/, '').split('?')[0];
    a.classList.toggle('active', href === cur);
  });
}
