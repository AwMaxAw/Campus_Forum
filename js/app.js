/**
 * 五中校园论坛 - 前端主逻辑
 *
 * 阶段 2：接真后端（Cloudflare Worker + D1）
 *   - API_BASE 指向 Worker：https://campus-forum.max-li-ggm.workers.dev
 *   - api.getPosts/createPost 走真实 fetch
 *   - 登录仍用前端临时保存（下一阶段接 JWT + bcrypt + /api/auth/login）
 *
 * 设计原则（演化友好）：
 *   1. API 调用集中在 api 对象里（将来换后端只动这一层）
 *   2. 状态集中在 state 对象里
 *   3. UI 用 template string 生成，方便将来转 Vue/React
 */

// ==================== 配置 ====================
const API_BASE = 'https://campus-forum.max-li-ggm.workers.dev';

// ==================== 全局状态 ====================
const state = {
  currentUser: JSON.parse(localStorage.getItem('currentUser') || 'null'),
  posts: [],
  pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 }
};

// ==================== API 层（换后端只改这里） ====================
/**
 * 统一请求封装：对非 2xx 也把 body 解析出来当错误
 * 避免 "NetworkError" 这种无意义提示
 */
async function request(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { success: false, message: `HTTP ${res.status}: ${res.statusText}` };
  }
  if (!res.ok && !data) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return data;
}

const api = {
  /**
   * 登录
   * 注意：现在阶段后端还没做 /api/auth/login（下一阶段接 bcrypt + JWT）。
   * 所以这里依然是纯前端校验格式，通过后把 { uid, nickname } 存 localStorage。
   * 真要鉴权时用 UID 当 query 参数（后端 POST /api/posts?uid=XXX 的临时方案）。
   */
  async login(uid, password) {
    if (!/^\d{8}$/.test(uid)) {
      return { success: false, message: '请输入 8 位数字 UID' };
    }
    if (!password) {
      return { success: false, message: '请输入密码' };
    }
    // TODO: 下一阶段替换为真实调用
    // const res = await request('/auth/login', { method: 'POST', body: JSON.stringify({ uid, password }) });
    // return res;
    return { success: true, data: { uid, nickname: `用户${uid}` } };
  },

  async getPosts(page = 1, pageSize = 20, category = null) {
    const qs = new URLSearchParams({ page, pageSize });
    if (category) qs.set('category', category);
    return request(`/api/posts?${qs}`);
  },

  async createPost(title, content, category = 'general') {
    if (!state.currentUser) {
      return { success: false, message: '请先登录' };
    }
    // 临时鉴权：后端还没 JWT，就用 query 带 uid
    const qs = new URLSearchParams({ uid: state.currentUser.uid });
    return request(`/api/posts?${qs}`, {
      method: 'POST',
      body: JSON.stringify({ title, content, category })
    });
  }
};

// ==================== 路由 ====================
function route() {
  const hash = location.hash.slice(1) || 'home';
  const app = document.getElementById('app');
  renderUserMenu();

  if (hash === 'login') renderLogin(app);
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
    menu.innerHTML = `
      <span class="user-nickname">${escapeHtml(state.currentUser.nickname)}</span>
      <button class="secondary" onclick="doLogout()">退出</button>
    `;
  } else {
    menu.innerHTML = `<button class="secondary" onclick="location.hash='login'">登录</button>`;
  }
}

async function renderHome(app) {
  // 未登录态：展示欢迎 + 引导登录
  if (!state.currentUser) {
    app.innerHTML = `
      <div class="card">
        <h3>欢迎来到五中校园论坛</h3>
        <p>当前为游客身份，<a href="#login">点此登录</a>后才能发帖和评论。</p>
      </div>
      <div class="card">
        <h3>项目阶段</h3>
        <p>✅ 前端骨架</p>
        <p>✅ Cloudflare Worker + D1 后端已接通（API 持久化写入 D1）</p>
        <p>🔧 下一阶段：接 JWT 认证 + 注册/登录/密码加密</p>
      </div>
      <div class="card">
        <h3>现在就能试</h3>
        <p>登录（任意 8 位 UID + 任意密码）→ 发新帖 → 刷新页面后帖子依然存在（真的存在 D1 里！）</p>
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
      document.getElementById('postList').outerHTML = `<div class="card">❌ 加载失败：${escapeHtml(res.message)}</div>`;
      return;
    }
    state.posts = res.data || [];
    state.pagination = res.pagination || state.pagination;

    document.getElementById('postCount').textContent = `共 ${state.pagination.total} 条帖子`;

    if (state.posts.length === 0) {
      document.getElementById('postList').outerHTML = `<div class="empty">还没有帖子，快来发第一条吧</div>`;
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
  const author = p.authorNickname || p.author || '未知用户';
  // 后端字段是 createdAt (ISO 风格字符串)，转成本地显示
  const time = formatTime(p.createdAt);
  const pinBadge = p.isPinned ? `<span style="color:#f59e0b;background:#fef3c7;padding:1px 6px;border-radius:4px;font-size:11px;margin-right:6px">置顶</span>` : '';
  const catBadge = p.category
    ? `<span style="color:#2563eb;background:#dbeafe;padding:1px 6px;border-radius:4px;font-size:11px;margin-right:6px">${escapeHtml(p.category)}</span>`
    : '';
  const tags = (p.tags && p.tags.length)
    ? `<div style="margin-top:6px;color:#6b7280;font-size:12px">${p.tags.map(t => `#${escapeHtml(t)}`).join(' ')}</div>`
    : '';
  const stats =
    `👁 ${p.viewCount || 0}` +
    `　👍 ${p.likeCount || 0}` +
    `　💬 ${p.commentCount || 0}`;
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
      <input id="pwdInput" type="password" placeholder="密码">
      <button id="loginBtn" onclick="doLogin()">登录</button>
      <p class="hint">临时阶段：任意 8 位数字 UID + 任意密码即可登录。<br>下一阶段接入真实 bcrypt + JWT 账号体系。</p>
    </div>
  `;
  document.getElementById('pwdInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
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
  if (!/^\d{8}$/.test(uid)) {
    alert('请输入 8 位数字 UID');
    return;
  }
  if (!password) {
    alert('请输入密码');
    return;
  }
  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.textContent = '登录中...';
  try {
    const res = await api.login(uid, password);
    if (res.success) {
      state.currentUser = res.data;
      localStorage.setItem('currentUser', JSON.stringify(state.currentUser));
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

function doLogout() {
  state.currentUser = null;
  localStorage.removeItem('currentUser');
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

// ==================== 启动 ====================
window.addEventListener('hashchange', route);
window.addEventListener('load', route);
