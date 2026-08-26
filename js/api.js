/**
 * API 封装层（所有对 Worker 的调用都收口在这里，将来换后端只改这里）
 *
 * 所有接口返回统一结构：{ success: boolean, message?: string, data?: any, ...extra }
 * 401（token 过期）会自动清空本地登录态。
 */

const API_BASE = 'https://campus-forum.max-li-ggm.workers.dev';
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

async function request(path, { method = 'GET', body, needsAuth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (needsAuth && tokenCache) headers.Authorization = 'Bearer ' + tokenCache;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(API_BASE + path, init);
  } catch (e) {
    return { success: false, message: `网络连接失败：${e.message}` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    data = { success: false, message: `HTTP ${res.status}: ${res.statusText}` };
  }
  if (res.status === 401) {
    // 登录、注册接口本身 401 不要清（否则会把刚刚登录成功的态清掉）
    const isAuthEndpoint = path === '/api/auth/login' || path === '/api/auth/register';
    if (!isAuthEndpoint) {
      console.warn(`[auth] ⚠️ 请求 ${method} ${path} 返回 401，已自动清除登录态。原因：`, data);
      clearAuth();
    }
  }
  return data;
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
  logout() { clearAuth(); },
};

// ======================== 帖子 ========================
export const posts = {
  async list(page = 1, pageSize = 20, category = null) {
    const qs = new URLSearchParams({ page, pageSize });
    if (category) qs.set('category', category);
    return request(`/api/posts?${qs}`, { needsAuth: false });
  },
  async byId(id) {
    return request(`/api/posts/${id}`, { needsAuth: false });
  },
  async mine(page = 1, pageSize = 20) {
    // "我发的帖"：后端没单独接口，这里走列表 + 前端按 authorUid 过滤也行。
    // 为了准确，我们直接取列表时后端没有这个端点——因此新增：/api/posts?author_uid=xxx 在后端我们没加。
    // 简单方案：拿 100 条最新在前端过滤 authorUid === 当前用户
    const res = await request('/api/posts?pageSize=100', { needsAuth: false });
    if (res.success && userCache) {
      res.data = res.data.filter(p => p.authorUid === userCache.uid);
      if (res.pagination) res.pagination.total = res.data.length;
    }
    return res;
  },
  async create(title, content, category = 'general', tags = []) {
    if (!tokenCache) return { success: false, message: '请先登录' };
    return request('/api/posts', { method: 'POST', body: { title, content, category, tags } });
  },
  async remove(id) {
    return request(`/api/posts/${id}`, { method: 'DELETE' });
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
