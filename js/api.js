/**
 * API 封装层（所有对 Worker 的调用都收口在这里，将来换后端只改这里）
 *
 * 所有接口返回统一结构：{ success: boolean, message?: string, data?: any, ...extra }
 * 401（token 过期）会自动清空本地登录态。
 */

/**
 * 前端 API 封装（纯 fetch，零第三方依赖）
 *
 * 部署兼容性：
 *   - API_BASE 固定指向 Cloudflare Worker 生产地址，所以不管前端部署在
 *     Vercel / Netlify / Cloudflare Pages / 自定义域名 / GitHub Pages 都能直接连后端。
 *   - 如需本地开发连本地 Worker，可在 index.html 里 <script> window.__CAMPUS_FORUM_API_BASE__ = 'http://localhost:8787' </script>
 *     覆盖下面的默认值（会被读取，见 const API_BASE = ...）。
 */

const DEFAULT_API_BASE = 'https://campus-forum.max-li-ggm.workers.dev';
const API_BASE = (typeof window !== 'undefined' && window.__CAMPUS_FORUM_API_BASE__)
  ? window.__CAMPUS_FORUM_API_BASE__.replace(/\/$/, '')
  : DEFAULT_API_BASE;

// 分区枚举（category key 存库 / label 展示 / adminOnly 控制是否仅管理员可见+可选/可筛选）
// 这个枚举必须与 worker/src/routes/posts.js 的 ALLOWED_CATEGORIES_KEYS 保持一致。
export const ADMIN_ROLES = new Set(['admin', 'dev_admin']);
export const CATEGORIES = [
  { key: 'general', label: '综合', cssColor: '#6b7280', description: '没明确归属的日常讨论' },
  { key: 'study',   label: '学习', cssColor: '#2563eb', description: '学习交流、作业、题目、考试经验' },
  { key: 'club',    label: '社团', cssColor: '#9333ea', description: '社团招新、活动通知、兴趣同好' },
  { key: 'life',    label: '生活', cssColor: '#059669', description: '校园生活、失物招领、吐槽、日常分享' },
  { key: 'meta',    label: '站务', cssColor: '#dc2626', description: '管理员发布的论坛公告 / 使用须知（仅管理员可发帖到此分区）', adminOnly: true },
];
export function categoryMeta(key) {
  return CATEGORIES.find(c => c.key === key) || { key: key || 'unknown', label: (key || '未知'), cssColor: '#6b7280', description: '' };
}
export function isCategoryAdminOnly(key) {
  return !!categoryMeta(key).adminOnly;
}

const TOKEN_KEY = 'campus_forum_token';
const USER_KEY = 'campus_forum_user';

let tokenCache = null;
let userCache = null;
try {
  tokenCache = localStorage.getItem(TOKEN_KEY) || null;
} catch (e) { console.warn('[auth] 读取 TOKEN_KEY 失败（可能隐私模式）：', e); }
try {
  userCache = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
} catch (e) { console.warn('[auth] 读取 USER_KEY 失败：', e); userCache = null; }

// ============== 登录态一致性修复 ==============
// 场景：用户之前（阶段3旧代码）登录过，或者某次 clearAuth 只清了一个，导致 userCache/tokenCache 不同步。
// 不一致就强制当成未登录，避免"头像显示登录了但功能全不能用"的假象。
function syncLoginState() {
  if (userCache && !tokenCache) {
    // 有用户资料缓存但没 token → 登录态不完整，清掉
    userCache = null;
    try { localStorage.removeItem(USER_KEY); } catch {}
  }
  if (tokenCache && !userCache) {
    // 有 token 但没用户资料 → token 也一起清掉（避免不一致）
    tokenCache = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
  }
}
syncLoginState();

export function getToken() { return tokenCache; }
export function getCurrentUser() { return userCache; }
export function isLoggedIn() { return !!(tokenCache && userCache); }
export function clearAuth() {
  tokenCache = null;
  userCache = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch (e) {
    console.warn('[auth] clearAuth localStorage 清理失败：', e);
  }
}
function setAuth(token, user) {
  tokenCache = token;
  userCache = user;
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    // 双保险：写完立刻读回来核对，避免无痕模式 / 隐私策略下写入假成功
    const verifyT = localStorage.getItem(TOKEN_KEY);
    const verifyU = localStorage.getItem(USER_KEY);
    if (verifyT !== token || !verifyU) {
      console.warn('[auth] ⚠️ localStorage 写入失败（可能隐私模式限制）。内存登录态已设，但刷新页面会丢登录。请允许站点存储数据 / 改用普通窗口。');
    } else {
      console.log('[auth] ✅ 登录态已写入 localStorage，刷新后仍有效。');
    }
  } catch (e) {
    console.warn('[auth] localStorage 写入失败：', e, '\n（可能是浏览器隐私模式禁止了存储——改用普通窗口即可。）');
    alert('⚠️ 浏览器禁止了本地存储。请改为在普通窗口（不是无痕/隐私模式）打开本网站，或允许本站点使用 Cookie/本地存储，否则刷新页面会丢失登录态。');
  }
}

async function request(path, { method = 'GET', body, needsAuth = true, raw = false } = {}) {
  const headers = {};
  if (!raw) headers['Content-Type'] = 'application/json';
  if (needsAuth && tokenCache) headers.Authorization = 'Bearer ' + tokenCache;
  const init = { method, headers };
  if (body !== undefined) init.body = raw ? body : JSON.stringify(body);

  const url = API_BASE + path;
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    // 常见根因：
    //   - 浏览器插件/杀毒软件拦截 workers.dev 域名
    //   - CORS 未对 origin 放行（旧版本 Worker CORS 白名单没包含当前部署域名）
    //   - 当前网络不通 / DNS 污染
    console.error(`[api request] 网络连接失败：${method} ${url}`, e && e.stack ? e.stack : e);
    return { success: false, message: `网络连接失败：${e.message}（若你部署在 Netlify，请确认 Worker CORS 已放开 origin=*；或在 index.html 设置 window.__CAMPUS_FORUM_API_BASE__）` };
  }

  let text = '';
  try {
    text = await res.text();
    let data = JSON.parse(text);
    if (res.status === 401) {
      const isAuthEndpoint = path === '/api/auth/login' || path === '/api/auth/register';
      if (!isAuthEndpoint) {
        console.warn(`[auth] ⚠️ 请求 ${method} ${path} 返回 401，已自动清除登录态。响应：`, text.slice(0, 300));
        clearAuth();
      }
    }
    return data;
  } catch {
    // 返回不是合法 JSON：可能是 CORS 被拦、Netlify/Vercel/Cloudflare 返回 500 页面、或 worker throw 500 直接给 HTML
    console.error(`[api request] 返回非 JSON：${method} ${url} status=${res.status} ${res.statusText}。响应片段：`, text.slice(0, 200));
    return { success: false, message: `响应格式错误（HTTP ${res.status}）：${(res.statusText || '').slice(0, 40) || '非 JSON 响应'}` };
  }
}

// ======================== 认证 ========================
export const auth = {
  async register(payload) {
    if (!/^\d{8}$/.test(payload.uid || '')) return { success: false, message: 'UID 必须是 8 位数字' };
    if (!payload.password || payload.password.length < 6) return { success: false, message: '密码至少 6 位' };
    return request('/api/auth/register', { method: 'POST', body: payload, needsAuth: false });
  },
  async login(uid, password) {
    if (!/^\d{8}$/.test(uid)) return { success: false, message: 'UID 必须是 8 位数字' };
    if (!password) return { success: false, message: '请输入密码' };
    const res = await request('/api/auth/login', { method: 'POST', body: { uid, password }, needsAuth: false });
    if (res.success && res.token) setAuth(res.token, res.data);
    return res;
  },
  async me() {
    if (!tokenCache) return { success: false, message: '未登录' };
    const res = await request('/api/auth/me');
    if (res.success && res.data) {
      userCache = res.data;
      localStorage.setItem(USER_KEY, JSON.stringify(res.data));
    }
    return res;
  },
  /**
   * 修改密码（必须登录）。后端支持 oldPassword/newPassword 驼峰或下划线风格，
   * 这里传驼峰方便前端 JS 字段命名，字段两种命名都会被后端识别。
   */
  async changePwd({ oldPassword, newPassword, confirmPassword }) {
    if (!tokenCache) return { success: false, message: '请先登录' };
    if (!oldPassword) return { success: false, message: '请填写旧密码' };
    if (!newPassword) return { success: false, message: '请填写新密码' };
    if (newPassword.length < 6) return { success: false, message: '新密码至少 6 位' };
    if (newPassword === oldPassword) return { success: false, message: '新密码不能与旧密码相同' };
    if (confirmPassword !== undefined && confirmPassword !== newPassword) return { success: false, message: '两次输入的新密码不一致' };
    return request('/api/auth/me', {
      method: 'PATCH',
      body: { oldPassword, newPassword, confirmPassword },
    });
  },
  /**
   * 修改资料：按字段更新，传哪个字段改哪个，没传的不动。
   *   { nickname?, bio?, avatarUrl? }
   *   - avatarUrl 给空串 → 清空头像；不给 → 头像不变（用于只改昵称/简介）
   *   - avatarUrl 填 http(s) 外链 → 用外链当头像
   *   R2 上传的头像请用 uploadAvatar，不要走这里
   */
  async updateProfile({ nickname, bio, avatarUrl } = {}) {
    if (!tokenCache) return { success: false, message: '请先登录' };
    const body = {};
    if (nickname !== undefined) body.nickname = nickname;
    if (bio !== undefined) body.bio = bio;
    if (avatarUrl !== undefined) body.avatarUrl = avatarUrl;
    if (Object.keys(body).length === 0) return { success: false, message: '没有需要更新的字段' };
    const res = await request('/api/auth/me/profile', { method: 'PUT', body });
    if (res.success && res.data) {
      userCache = res.data;
      try { localStorage.setItem(USER_KEY, JSON.stringify(res.data)); } catch {}
    }
    return res;
  },
  /**
   * 上传头像到 R2（需 R2 已启用）。成功后后端直接写库，前端刷新即可。
   * file: File 对象（来自 <input type=file>）
   */
  async uploadAvatar(file) {
    if (!tokenCache) return { success: false, message: '请先登录' };
    if (!file) return { success: false, message: '请选择文件' };
    if (!file.type || !file.type.startsWith('image/')) return { success: false, message: '仅支持图片' };
    if (file.size > 2 * 1024 * 1024) return { success: false, message: '图片不能超过 2MB' };
    const fd = new FormData();
    fd.append('file', file);
    const res = await request('/api/auth/me/avatar', { method: 'POST', body: fd, raw: true });
    // 上传成功后拉一次最新资料，把 userCache 的 avatarUrl 同步
    if (res.success) { try { await this.me(); } catch {} }
    return res;
  },
  logout() { clearAuth(); },
};

/**
 * 把用户资料里的 avatarUrl 字段翻译成 <img src> 能直接用的 URL。
 *   - R2 上传（'r2:...'）→ 走 Worker 公开取图接口 /api/auth/avatar/:uid
 *   - http(s) 外链 → 原样返回
 *   - 没头像 → null（调用方显示首字母占位）
 * cacheBust：资料更新后避免图片缓存，用 updatedAt/时间戳拼 ?v=
 */
export function getAvatarUrl(user) {
  if (!user || !user.uid) return null;
  const a = user.avatarUrl;
  if (!a) return null;
  // kv:（KV 存储）或 r2:（R2 存储，历史）→ 都走 Worker 公开取图接口
  if (typeof a === 'string' && (a.startsWith('kv:') || a.startsWith('r2:'))) {
    const v = user.updatedAt || user.createdAt || '';
    return `${API_BASE}/api/auth/avatar/${encodeURIComponent(user.uid)}${v ? ('?v=' + encodeURIComponent(v)) : ''}`;
  }
  if (typeof a === 'string' && /^https?:\/\//i.test(a)) return a;
  return null;
}

// ======================== 帖子 ========================
export const posts = {
  /**
   * 列表：支持分页 + 搜索/标签/日期/排序 组合筛选
   * filters = { q, tag, category, dateFrom, dateTo, sortBy }
   */
  async list(page = 1, pageSize = 20, filters = {}) {
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    const f = filters || {};
    if (f.category) qs.set('category', f.category);
    if (f.q) qs.set('q', f.q);
    if (f.tag) qs.set('tag', f.tag);
    if (f.dateFrom) qs.set('date_from', f.dateFrom); // YYYY-MM-DD
    if (f.dateTo)   qs.set('date_to', f.dateTo);
    if (f.sortBy)   qs.set('sort_by', f.sortBy);     // 'latest' | 'hot'
    return request(`/api/posts?${qs}`, { needsAuth: false });
  },
  /** 热门标签榜（首页搜索条 chip 推荐用） */
  async popularTags() {
    return request('/api/posts/tags/popular', { needsAuth: false });
  },
  async byId(id) {
    return request(`/api/posts/${id}`, { needsAuth: false });
  },
  async mine(page = 1, pageSize = 20) {
    // 后端暂时没有 author_uid 筛选，拿 100 条前端过滤。如需加后端接口改 posts.list() 里的 whereParts 即可。
    const res = await request('/api/posts?pageSize=100', { needsAuth: false });
    if (res.success && userCache) {
      res.data = res.data.filter(p => p.authorUid === userCache.uid);
      if (res.pagination) res.pagination.total = res.data.length;
    }
    return res;
  },
  /**
   * 发新帖：分区 + 标签并存模式
   *   - category: 字符串（CATEGORIES key，前端发帖页必填显式选一个）
   *   - tags: 数组<string>（最多 5 个）
   * 后端会优先采用前端传的 category；如果不合法 → 管理员级校验不通过 → 再回退 general。
   */
  async create(title, content, tags = [], category = 'general', isPinned = false) {
    if (!tokenCache) return { success: false, message: '请先登录' };
    if (!Array.isArray(tags)) tags = [];
    return request('/api/posts', { method: 'POST', body: { title, content, tags, category, isPinned } });
  },
  async remove(id) {
    return request(`/api/posts/${id}`, { method: 'DELETE' });
  },
  async update(id, { title, content, tags, category }) {
    if (!tokenCache) return { success: false, message: '请先登录' };
    return request(`/api/posts/${id}`, { method: 'PUT', body: { title, content, tags, category } });
  },
  /** 置顶 / 取消置顶（管理员专属，后端会再校验角色） */
  async setPin(id, isPinned) {
    if (!tokenCache) return { success: false, message: '请先登录' };
    return request(`/api/posts/${id}/pin`, { method: 'PATCH', body: { isPinned: !!isPinned } });
  },
};

// ======================== 评论 ========================
export const comments = {
  async byPost(postId) {
    return request(`/api/comments?post_id=${postId}`, { needsAuth: false });
  },
  async create({ postId, content, replyToId }) {
    if (!tokenCache) return { success: false, message: '请先登录' };
    const body = { post_id: postId, content };
    if (replyToId) body.reply_to_id = replyToId;
    return request('/api/comments', { method: 'POST', body });
  },
  async remove(id) {
    return request(`/api/comments/${id}`, { method: 'DELETE' });
  },
  async update(id, content) {
    if (!tokenCache) return { success: false, message: '请先登录' };
    return request(`/api/comments/${id}`, { method: 'PUT', body: { content } });
  },
};

// ======================== 点赞 ========================
export const likes = {
  async toggle(postId) {
    if (!tokenCache) return { success: false, message: '请先登录' };
    return request('/api/likes/toggle', { method: 'POST', body: { post_id: postId } });
  },
  async mine(page = 1, pageSize = 20) {
    return request(`/api/likes/mine?page=${page}&pageSize=${pageSize}`);
  },
};

// ======================== 收藏 ========================
export const favorites = {
  async toggle(postId) {
    if (!tokenCache) return { success: false, message: '请先登录' };
    return request('/api/favorites/toggle', { method: 'POST', body: { post_id: postId } });
  },
  async mine(page = 1, pageSize = 20) {
    return request(`/api/favorites/mine?page=${page}&pageSize=${pageSize}`);
  },
};

// ======================== 私信 ========================
export const messages = {
  async unreadCount() {
    if (!tokenCache) return { success: true, data: { count: 0 } };
    return request('/api/messages/unread-count');
  },
  async conversations() {
    return request('/api/messages/conversations');
  },
  async withUser(otherUid) {
    return request(`/api/messages/conversation/${otherUid}`);
  },
  async send(toUid, content) {
    if (!tokenCache) return { success: false, message: '请先登录' };
    return request('/api/messages', { method: 'POST', body: { to_uid: toUid, content } });
  },
  async markRead(otherUid) {
    return request(`/api/messages/read/${otherUid}`, { method: 'POST' });
  },
};

// ======================== 公告 ========================
export const announcements = {
  async list(page = 1, pageSize = 20) {
    return request(`/api/announcements?page=${page}&pageSize=${pageSize}`, { needsAuth: false });
  },
  async unread() {
    if (!tokenCache) return { success: true, data: [] };
    return request('/api/announcements/unread');
  },
  async markRead(id) {
    return request(`/api/announcements/read/${id}`, { method: 'POST' });
  },
  async create({ title, content, isPinned = false }) {
    if (!tokenCache) return { success: false, message: '请先登录' };
    return request('/api/announcements', { method: 'POST', body: { title, content, is_pinned: !!isPinned } });
  },
};

// ======================== 管理员面板（仅 admin/dev_admin，后端再校验角色）========================
export const admin = {
  /** 列出所有已注册账号（含每用户帖子数） */
  async listUsers() {
    if (!tokenCache) return { success: false, message: '请先登录' };
    return request('/api/admin/users');
  },
  /** 列出所有置顶帖（按 pin_order 升序） */
  async pinnedPosts() {
    if (!tokenCache) return { success: false, message: '请先登录' };
    return request('/api/admin/pinned-posts');
  },
  /** 列出所有非置顶帖（按 created_at 倒序，只读展示用） */
  async listPosts() {
    if (!tokenCache) return { success: false, message: '请先登录' };
    return request('/api/admin/posts');
  },
  /** 批量调整置顶帖顺序：order 为帖子 id 数组，顺序即新 pin_order(1,2,3...) */
  async updatePinOrder(order) {
    if (!tokenCache) return { success: false, message: '请先登录' };
    if (!Array.isArray(order)) return { success: false, message: 'order 必须是数组' };
    return request('/api/admin/pin-order', { method: 'POST', body: { order } });
  },
  /** 全量标签及出现次数 */
  async allTags() {
    if (!tokenCache) return { success: false, message: '请先登录' };
    return request('/api/admin/tags');
  },
  /** 封禁账号（危险操作，前端需二次确认） */
  async banUser(uid) {
    if (!tokenCache) return { success: false, message: '请先登录' };
    if (!uid) return { success: false, message: '缺少 uid' };
    return request(`/api/admin/users/${encodeURIComponent(uid)}/ban`, { method: 'POST' });
  },
  /** 解封账号 */
  async unbanUser(uid) {
    if (!tokenCache) return { success: false, message: '请先登录' };
    if (!uid) return { success: false, message: '缺少 uid' };
    return request(`/api/admin/users/${encodeURIComponent(uid)}/unban`, { method: 'POST' });
  },
  /** 注销账号（物理删除，危险操作，前端需二次确认） */
  async deleteUser(uid) {
    if (!tokenCache) return { success: false, message: '请先登录' };
    if (!uid) return { success: false, message: '缺少 uid' };
    return request(`/api/admin/users/${encodeURIComponent(uid)}`, { method: 'DELETE' });
  },
};
