/**
 * 五中校园论坛 - 前端主逻辑
 *
 * 阶段 3：接真账号体系
 *   - API_BASE 指向 Worker：https://campus-forum.max-li-ggm.workers.dev
 *   - api.register/login/me 走真实 fetch (PBKDF2 + JWT)
 *   - 登录后存 JWT token → 以后每一个需要登录的请求都带 Authorization: Bearer <token>
 *   - 新增 #register 路由：注册表单
 *
 * 设计原则（演化友好）：
 *   1. API 调用集中在 api 对象里（将来换后端只动这一层）
 *   2. 状态集中在 state 对象里
 *   3. UI 用 template string 生成，方便将来转 Vue/React
 */

// ==================== 配置 ====================
const API_BASE = 'https://campus-forum.max-li-ggm.workers.dev';
const TOKEN_KEY = 'campus_forum_token';
const USER_KEY = 'campus_forum_user';

// ==================== 全局状态 ====================
const state = {
  currentUser: JSON.parse(localStorage.getItem(USER_KEY) || 'null'),
  token: localStorage.getItem(TOKEN_KEY) || null,
  posts: [],
  pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 }
};

// ==================== API 层（换后端只改这里） ====================
/**
 * 统一请求封装
 *   - 自动给需要登录的请求加 Authorization: Bearer <token>
 *   - 对非 2xx 也把 body 解析出来当错误，避免 "NetworkError" 这种无意义提示
 *   - 401 时自动清掉本地 token（说明 token 过期/失效了）
 */
async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (options.needsAuth !== false && state.token) {
    headers['Authorization'] = 'Bearer ' + state.token;
  }
  const init = { headers, ...options };
  if (init.body && typeof init.body !== 'string') {
    init.body = JSON.stringify(init.body);
  }

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

  // 401 = token 过期/无效，静默清掉下次会要求重新登录
  if (res.status === 401 && state.token) {
    state.token = null;
    state.currentUser = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
  return data;
}

const api = {
  /** 注册新账号：uid (8位) + password (>=6位) + nickname (可选) + bio (可选) */
  async register(payload) {
    if (!/^\d{8}$/.test(payload.uid || '')) {
      return { success: false, message: '请输入 8 位数字 UID' };
    }
    if (!payload.password || payload.password.length < 6) {
      return { success: false, message: '密码至少 6 位' };
    }
    return request('/api/auth/register', { method: 'POST', needsAuth: false, body: payload });
  },

  /** 登录 → 拿到 user + token，分别存 localStorage */
  async login(uid, password) {
    if (!/^\d{8}$/.test(uid)) {
      return { success: false, message: '请输入 8 位数字 UID' };
    }
    if (!password) {
      return { success: false, message: '请输入密码' };
    }
    const res = await request('/api/auth/login', {
      method: 'POST',
      needsAuth: false,
      body: { uid, password }
    });
    if (res.success && res.token) {
      state.token = res.token;
      state.currentUser = res.data;
      localStorage.setItem(TOKEN_KEY, res.token);
      localStorage.setItem(USER_KEY, JSON.stringify(res.data));
    }
    return res;
  },

  /** 静默 token 验证：打开页面时调一次，保证 localStorage 里的 token 没过期 */
  async me() {
    if (!state.token) return { success: false, message: '未登录' };
    const res = await request('/api/auth/me', { needsAuth: true });
    if (res.success && res.data) {
      // 刷新下 localStorage 里的用户资料（昵称变了之类的）
      state.currentUser = res.data;
      localStorage.setItem(USER_KEY, JSON.stringify(res.data));
    }
    return res;
  },

  async getPosts(page = 1, pageSize = 20, category = null) {
    const qs = new URLSearchParams({ page, pageSize });
    if (category) qs.set('category', category);
    return request(`/api/posts?${qs}`, { needsAuth: false });
  },

  async createPost(title, content, category = 'general', tags = []) {
    if (!state.token) return { success: false, message: '请先登录' };
    return request('/api/posts', {
      method: 'POST',
      needsAuth: true,
      body: { title, content, category, tags }
    });
  },

  /** 退出登录：同时清 localStorage */
  logout() {
    state.token = null;
    state.currentUser = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
};

// ==================== 路由 ====================
function route() {
  const hash = location.hash.slice(1) || 'home';
  const app = document.getElementById('app');
  renderUserMenu();

  if (hash === 'login') renderLogin(app);
  else if (hash === 'register') renderRegister(app);
  else if (hash === 'post') {
    if (!state.currentUser) { location.hash = 'login'; return; }
    renderPost(app);
  }
  else if (hash === 'logout') doLogout();
  else renderHome(app);
}

// ==================== 视图渲染 ====================
function renderUserMenu() {
  const menu = document.getElementById('userMenu');
  if (state.currentUser) {
    const roleBadge = state.currentUser.role === 'dev_admin'
      ? `<span style="color:#dc2626;background:#fee2e2;padding:1px 6px;border-radius:4px;font-size:11px;margin-right:6px">开发管理员</span>`
      : state.currentUser.role === 'admin'
        ? `<span style="color:#b45309;background:#fef3c7;padding:1px 6px;border-radius:4px;font-size:11px;margin-right:6px">管理员</span>`
        : '';
    menu.innerHTML = `
      <span class="user-nickname">${roleBadge}${escapeHtml(state.currentUser.nickname)}</span>
      <button class="secondary" onclick="doLogout()">退出</button>
    `;
  } else {
    menu.innerHTML = `
      <button class="secondary" onclick="location.hash='register'">注册</button>
      <button class="secondary" onclick="location.hash='login'">登录</button>
    `;
  }
}

async function renderHome(app) {
  // 未登录态：展示引导
  if (!state.currentUser) {
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
    `;
    return;
  }

  // 已登录态：异步拉帖子列表
  app.innerHTML = `
    <div class="toolbar">
      <span id="postCount">加载中...</span>
      <button onclick="location.hash='post'">+ 发新帖</button>
    </div>
    <div class="empty" id="postList">🔄 正在读取帖子...</div>
  `;

  try {
    const res = await api.getPosts();
    if (!res.success) {
      document.getElementById('postList').outerHTML =
        `<div class="card">❌ 加载失败：${escapeHtml(res.message)}</div>`;
      return;
    }
    state.posts = res.data || [];
    state.pagination = res.pagination || state.pagination;

    document.getElementById('postCount').textContent = `共 ${state.pagination.total} 条帖子`;

    if (state.posts.length === 0) {
      document.getElementById('postList').outerHTML =
        `<div class="empty">还没有帖子，快来发第一条吧</div>`;
      return;
    }

    const list = state.posts.map(formatPostCard).join('');
    document.getElementById('postList').outerHTML = list;
  } catch (e) {
    document.getElementById('postList').outerHTML =
      `<div class="card">❌ 网络错误：${escapeHtml(e.message)}</div>`;
  }
}

function formatPostCard(p) {
  const author = p.authorNickname || '未知用户';
  const time = formatTime(p.createdAt);
  const pinBadge = p.isPinned
    ? `<span style="color:#f59e0b;background:#fef3c7;padding:1px 6px;border-radius:4px;font-size:11px;margin-right:6px">置顶</span>`
    : '';
  const catBadge = p.category
    ? `<span style="color:#2563eb;background:#dbeafe;padding:1px 6px;border-radius:4px;font-size:11px;margin-right:6px">${escapeHtml(p.category)}</span>`
    : '';
  const tags = (p.tags && p.tags.length)
    ? `<div style="margin-top:6px;color:#6b7280;font-size:12px">${p.tags.map(t => `#${escapeHtml(t)}`).join(' ')}</div>`
    : '';
  const stats = `👁 ${p.viewCount || 0}　👍 ${p.likeCount || 0}　💬 ${p.commentCount || 0}`;
  return `
    <div class="card">
      <div class="meta">
        ${pinBadge}${catBadge}
        <span>${escapeHtml(author)}</span>
        <span>·</span>
        <span>${escapeHtml(time)}</span>
      </div>
      <h3>${escapeHtml(p.title)}</h3>
      <p style="white-space:pre-wrap">${escapeHtml(p.content)}</p>
      ${tags}
      <div class="meta" style="margin-top:8px">${stats}</div>
    </div>
  `;
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return isoStr;
  }
}

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
  document.getElementById('pwdInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
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
  document.getElementById('pwd2Input').addEventListener('keydown', e => {
    if (e.key === 'Enter') doRegister();
  });
}

function renderPost(app) {
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

// ==================== 事件处理 ====================
async function doLogin() {
  const uid = document.getElementById('uidInput').value.trim();
  const password = document.getElementById('pwdInput').value;
  if (!/^\d{8}$/.test(uid)) { alert('请输入 8 位数字 UID'); return; }
  if (!password) { alert('请输入密码'); return; }

  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.textContent = '登录中...';
  try {
    const res = await api.login(uid, password);
    if (res.success) {
      location.hash = 'home';
    } else {
      alert(res.message || '登录失败');
    }
  } catch (e) {
    alert('网络错误：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
}

async function doRegister() {
  const uid = document.getElementById('uidInput').value.trim();
  const password = document.getElementById('pwdInput').value;
  const confirm = document.getElementById('pwd2Input').value;
  const nickname = document.getElementById('nickInput').value.trim();
  const bio = document.getElementById('bioInput').value.trim();

  if (!/^\d{8}$/.test(uid)) { alert('请输入 8 位数字 UID'); return; }
  if (password.length < 6) { alert('密码至少 6 位'); return; }
  if (password !== confirm) { alert('两次输入的密码不一致'); return; }
  if (nickname.length > 20) { alert('昵称不超过 20 字'); return; }
  if (bio.length > 200) { alert('简介不超过 200 字'); return; }

  const btn = document.getElementById('regBtn');
  btn.disabled = true;
  btn.textContent = '注册中...';
  try {
    const res = await api.register({
      uid, password,
      nickname: nickname || `用户${uid}`,
      bio: bio || undefined
    });
    if (res.success) {
      // 注册成功 → 自动登录（省一次点击）
      const loginRes = await api.login(uid, password);
      if (loginRes.success) {
        alert('注册成功！已自动登录');
        location.hash = 'home';
      } else {
        alert('注册成功，请手动登录：' + (loginRes.message || ''));
        location.hash = 'login';
      }
    } else {
      alert(res.message || '注册失败');
    }
  } catch (e) {
    alert('网络错误：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '注册';
  }
}

function doLogout() {
  api.logout();
  location.hash = 'home';
  route();
}

async function doPost() {
  const title = document.getElementById('titleInput').value.trim();
  const content = document.getElementById('contentInput').value.trim();
  const category = document.getElementById('catInput').value;
  if (!title) { alert('标题不能为空'); return; }
  if (!content) { alert('内容不能为空'); return; }

  const btn = document.getElementById('postBtn');
  btn.disabled = true;
  btn.textContent = '发布中...';
  try {
    const res = await api.createPost(title, content, category);
    if (res.success) {
      location.hash = 'home';
    } else {
      alert(res.message || '发布失败');
    }
  } catch (e) {
    alert('网络错误：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '发布';
  }
}

// ==================== 工具函数 ====================
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ==================== 启动：尝试用 /me 静默刷新本地用户/token ====================
window.addEventListener('hashchange', route);
window.addEventListener('load', async () => {
  // 如果本地有 token，后台静默调一下 /me，过期了就自动清掉
  if (state.token) {
    try { await api.me(); } catch {}
  }
  route();
});
