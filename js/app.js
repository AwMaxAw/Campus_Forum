/**
 * 五中校园论坛 - 前端主逻辑（简易版）
 *
 * 当前阶段：纯前端 + 假数据 + hash 路由
 * 下一阶段：把 doLogin/doPost/getPosts 改成 fetch 调用 Cloudflare Worker
 *
 * 设计原则（演化友好）：
 *   1. API 调用集中在 api 对象里（将来改后端只动这一层）
 *   2. 状态集中在 state 对象里
 *   3. UI 用 template string 生成，方便将来转 Vue/React
 */

// ==================== 假数据 ====================
const MOCK_POSTS = [
  {
    id: 1,
    title: '欢迎来到五中校园论坛',
    content: '这是简易版前端骨架，目前用假数据。下一步会接 Cloudflare Workers + D1 后端，让帖子真正持久化保存。',
    author: 'admin',
    createdAt: '2026-08-26 10:00'
  },
  {
    id: 2,
    title: '关于使用建议',
    content: '请文明发言，遵守校规。本论坛仅限五中师生使用，发帖请勿包含真实姓名、电话等隐私信息。',
    author: 'admin',
    createdAt: '2026-08-26 11:00'
  }
];

// ==================== 全局状态 ====================
const state = {
  currentUser: JSON.parse(localStorage.getItem('currentUser') || 'null'),
  posts: [...MOCK_POSTS]
};

// ==================== API 层（将来换后端只改这里） ====================
const api = {
  /**
   * 当前用假数据模拟，将来改成 fetch
   * 例如：return fetch(API_BASE + '/auth/login', { method:'POST', body: JSON.stringify({uid, password}) }).then(r => r.json())
   */
  async login(uid, password) {
    // 简易版：任意 8 位 UID + 任意密码即可登录
    await new Promise(r => setTimeout(r, 200)); // 模拟网络延迟
    return { success: true, data: { uid, nickname: `用户${uid}` } };
  },

  async getPosts() {
    await new Promise(r => setTimeout(r, 200));
    return { success: true, data: state.posts };
  },

  async createPost(title, content) {
    await new Promise(r => setTimeout(r, 200));
    const post = {
      id: Date.now(),
      title,
      content,
      author: state.currentUser.nickname,
      createdAt: new Date().toLocaleString('zh-CN', { hour12: false })
    };
    state.posts.unshift(post);
    return { success: true, data: post };
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

function renderHome(app) {
  if (!state.currentUser) {
    app.innerHTML = `
      <div class="card">
        <h3>欢迎来到五中校园论坛</h3>
        <p>当前为游客身份，<a href="#login">点此登录</a>后才能发帖和评论。</p>
      </div>
      <div class="card">
        <h3>项目阶段</h3>
        <p>当前阶段：✅ 前端骨架 + 假数据</p>
        <p>下一步：🔧 接 Cloudflare Workers + D1 数据库</p>
      </div>
    `;
    return;
  }
  const list = state.posts.map(p => `
    <div class="card">
      <div class="meta">
        <span>${escapeHtml(p.author)}</span>
        <span>·</span>
        <span>${escapeHtml(p.createdAt)}</span>
      </div>
      <h3>${escapeHtml(p.title)}</h3>
      <p>${escapeHtml(p.content)}</p>
    </div>
  `).join('');
  app.innerHTML = `
    <div class="toolbar">
      <span>共 ${state.posts.length} 条帖子</span>
      <button onclick="location.hash='post'">+ 发新帖</button>
    </div>
    ${list || '<div class="empty">还没有帖子，快来发第一条吧</div>'}
  `;
}

function renderLogin(app) {
  app.innerHTML = `
    <div class="card">
      <h3>登录</h3>
      <input id="uidInput" placeholder="用户UID（8位数字）" maxlength="8" inputmode="numeric">
      <input id="pwdInput" type="password" placeholder="密码">
      <button id="loginBtn" onclick="doLogin()">登录</button>
      <p class="hint">提示：简易版任意 8 位数字 + 任意密码即可登录。后端接好后会改成真实账号体系。</p>
    </div>
  `;
  // 回车提交
  document.getElementById('pwdInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
}

function renderPost(app) {
  app.innerHTML = `
    <div class="card">
      <h3>发新帖</h3>
      <input id="titleInput" placeholder="标题（必填）" maxlength="100">
      <textarea id="contentInput" placeholder="说点什么...（必填）" maxlength="2000"></textarea>
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
  // 如果当前 hash 已是 home，单纯改 hash 不会触发 hashchange，
  // 需要手动调一次 route() 强制刷新顶栏 UI
  location.hash = 'home';
  route();
}

async function doPost() {
  const title = document.getElementById('titleInput').value.trim();
  const content = document.getElementById('contentInput').value.trim();
  if (!title) { alert('标题不能为空'); return; }
  if (!content) { alert('内容不能为空'); return; }

  const btn = document.getElementById('postBtn');
  btn.disabled = true;
  btn.textContent = '发布中...';
  try {
    const res = await api.createPost(title, content);
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
