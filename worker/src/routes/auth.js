/**
 * 账号路由：注册 / 登录 / 当前用户 / 修改密码
 *
 * POST   /api/auth/register  → 创建新用户
 * POST   /api/auth/login     → 验证账号密码 → 返回 JWT
 * GET    /api/auth/me        → 用 Authorization: Bearer <JWT> 取当前用户
 * PATCH  /api/auth/me        → 修改密码（需旧密码验证 + JWT）
 */

import { Hono } from 'hono';
import { jwt } from 'hono/jwt';
import { sign } from 'hono/jwt';
import { createMiddleware } from 'hono/factory';
import {
  hashPassword,
  verifyPassword,
  isUidValid,
  serializeUser,
  JWT_TTL_SEC,
} from '../utils/auth.js';

const auth = new Hono();

/** 统一响应格式（和 index.js 里保持一致，避免每个路由重复写）*/
function ok(data, extra) {
  return { success: true, data, ...(extra || {}) };
}
function fail(message, status = 400) {
  return new Response(JSON.stringify({ success: false, message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function requireAuth() {
  return createMiddleware(async (c, next) => {
    const mw = jwt({ secret: c.env.JWT_SECRET, alg: 'HS256' });
    return mw(c, next);
  });
}

// ==================== 注册 ====================
auth.post('/register', async (c) => {
  const db = c.env.DB;
  let body;
  try {
    body = await c.req.json();
  } catch {
    return fail('请求体必须是合法 JSON');
  }

  const uid = (body.uid || '').trim();
  const password = (body.password || '').toString();
  const nickname = (body.nickname || '').trim() || `用户${uid}`;
  // bio / avatar_url 可选，注册不强制填
  const bio = (body.bio || '').toString().slice(0, 200) || null;
  const avatarUrl = (body.avatarUrl || body.avatar_url || '').toString().slice(0, 500) || null;

  if (!isUidValid(uid)) return fail('UID 格式无效：26(年份) + 校区(1=广五本部/2=金碧校区) + 学段(1=初中/2=高中) + 班级(2位) + 学号(2位)，共8位');
  if (password.length < 6) return fail('密码至少 6 位');
  if (password.length > 128) return fail('密码不能超过 128 位');
  if (nickname.length < 1 || nickname.length > 20) return fail('昵称 1-20 字');

  // 检查 UID 是否已存在
  const exists = await db
    .prepare('SELECT uid FROM users WHERE uid = ?')
    .bind(uid)
    .first();
  if (exists) return fail('该 UID 已注册，请直接登录或找回密码', 409);

  // 哈希密码（异步 Web Crypto，稍慢但对注册/登录这种低频操作 OK）
  const hash = await hashPassword(password);

  // 默认 role 是 member（不要开放用户自己设 admin！）
  await db
    .prepare(
      `INSERT INTO users (uid, password_hash, nickname, avatar_url, bio)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(uid, hash, nickname, avatarUrl, bio)
    .run();

  const row = await db
    .prepare('SELECT * FROM users WHERE uid = ?')
    .bind(uid)
    .first();

  return c.json(ok(serializeUser(row)), 201);
});

// ==================== 登录 ====================
auth.post('/login', async (c) => {
  try {
    const db = c.env.DB;
    let body;
    try {
      body = await c.req.json();
    } catch {
      return fail('请求体必须是合法 JSON');
    }

    const uid = (body.uid || '').trim();
    const password = (body.password || '').toString();
    if (!/^\d{8}$/.test(uid)) return fail('请输入 8 位数字 UID');
    if (!password) return fail('请输入密码');

    const user = await db
      .prepare('SELECT * FROM users WHERE uid = ?')
      .bind(uid)
      .first();

    // 用户不存在 → 别告诉前端是"UID错了"还是"密码错了"，统一一条信息避免枚举
    const genericMsg = 'UID 或密码不正确';
    if (!user) return fail(genericMsg, 401);

    const pwOk = await verifyPassword(password, user.password_hash);
    if (!pwOk) return fail(genericMsg, 401);

    // 被封禁？拒绝登录
    if (user.is_banned) {
      return fail('该账号已被管理员封禁，如有疑问请联系管理员申诉', 403);
    }

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: user.uid,
      role: user.role,
      iat: now,
      exp: now + JWT_TTL_SEC,
    };
    const token = await sign(payload, c.env.JWT_SECRET, 'HS256');

    // 登录成功 → 更新 last_login_at（失败不阻塞主流程）
    try {
      await db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE uid = ?").bind(user.uid).run();
    } catch (e) {
      console.warn('[login] 更新 last_login_at 失败（可忽略）：', e && e.message);
    }

    return c.json(ok(serializeUser(user), {
      token,
      tokenExpiresAt: new Date((now + JWT_TTL_SEC) * 1000).toISOString(),
    }));
  } catch (e) {
    return fail(`[login] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 管理员免密快速登录（需要 MASTER_KEY + 管理员 UID）====================
// curl -X POST https://your-worker.workers.dev/api/auth/quick-login \
//   -H "Content-Type: application/json" \
//   -d '{"uid":"00000000","masterKey":"xxxxx"}'
auth.post('/quick-login', async (c) => {
  try {
    const masterKey = c.env.MASTER_KEY;
    if (!masterKey) return fail('快速登录未配置（服务端缺少 MASTER_KEY）', 503);

    let body;
    try { body = await c.req.json(); } catch { return fail('请求体必须是合法 JSON'); }

    const uid = (body.uid || '').trim();
    const key = (body.masterKey || '').toString();

    if (!uid) return fail('请输入管理员 UID');
    if (key !== masterKey) return fail('master key 不正确', 401);

    const db = c.env.DB;
    const user = await db.prepare('SELECT * FROM users WHERE uid = ?').bind(uid).first();
    if (!user) return fail('用户不存在', 404);

    // 只允许管理员角色免密登录
    if (user.role !== 'dev_admin' && user.role !== 'admin') {
      return fail('该 UID 不是管理员，不可使用快速登录', 403);
    }

    if (user.is_banned) return fail('该账号已被封禁', 403);

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: user.uid,
      role: user.role,
      iat: now,
      exp: now + JWT_TTL_SEC,
    };
    const token = await sign(payload, c.env.JWT_SECRET, 'HS256');

    try {
      await db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE uid = ?").bind(user.uid).run();
    } catch {}

    return c.json(ok(serializeUser(user), {
      token,
      tokenExpiresAt: new Date((now + JWT_TTL_SEC) * 1000).toISOString(),
    }));
  } catch (e) {
    return fail(`[quick-login] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 当前用户（JWT 中间件保护） ====================
auth.get('/me', requireAuth(), async (c) => {
  try {
    const payload = c.get('jwtPayload');
    if (!payload || !payload.sub) return fail('无效的 token', 401);

    const user = await c.env.DB
      .prepare('SELECT * FROM users WHERE uid = ?')
      .bind(payload.sub)
      .first();

    if (!user) return fail('用户不存在', 401);
    return c.json(ok(serializeUser(user)));
  } catch (e) {
    return fail(`[me] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 修改密码（需要登录 + 旧密码验证） ====================
auth.patch('/me', requireAuth(), async (c) => {
  try {
    const payload = c.get('jwtPayload');
    if (!payload || !payload.sub) return fail('无效的 token', 401);
    const uid = payload.sub;

    let body;
    try { body = await c.req.json(); } catch { return fail('请求体必须是合法 JSON'); }
    const oldPwd = (body.old_password || body.oldPassword || '').toString();
    const newPwd = (body.new_password || body.newPassword || '').toString();
    const confirmPwd = (body.confirm_password || body.confirmPassword || '').toString();

    if (!oldPwd) return fail('请填写旧密码');
    if (!newPwd) return fail('请填写新密码');
    if (newPwd.length < 6) return fail('新密码至少 6 位');
    if (newPwd.length > 128) return fail('新密码不能超过 128 位');
    if (newPwd === oldPwd) return fail('新密码不能与旧密码相同');
    if (confirmPwd && newPwd !== confirmPwd) return fail('两次输入的新密码不一致');

    const db = c.env.DB;
    const user = await db.prepare('SELECT * FROM users WHERE uid = ?').bind(uid).first();
    if (!user) return fail('用户不存在', 401);

    const oldOk = await verifyPassword(oldPwd, user.password_hash);
    if (!oldOk) return fail('旧密码不正确', 401);

    const newHash = await hashPassword(newPwd);
    const updatedAt = new Date().toISOString();
    await db
      .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE uid = ?')
      .bind(newHash, updatedAt, uid)
      .run();

    return c.json(ok({ changed: true, updatedAt }));
  } catch (e) {
    return fail(`[change password] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 修改资料（昵称 / 简介 / 头像URL，仅需登录）====================
// 只更新请求体里出现的字段；avatarUrl 留空串则清空头像，undefined 则不动。
// 头像优先走 /api/auth/me/avatar 上传到 R2；本接口的 avatarUrl 用于"填外链图片"那条路。
auth.put('/me/profile', requireAuth(), async (c) => {
  try {
    const payload = c.get('jwtPayload');
    if (!payload || !payload.sub) return fail('无效的 token', 401);
    const uid = payload.sub;

    let body;
    try { body = await c.req.json(); } catch { return fail('请求体必须是合法 JSON'); }

    const sets = [];      // 动态拼 SET 子句
    const vals = [];
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

    if (has('nickname')) {
      const nickname = (body.nickname || '').toString().trim();
      if (nickname.length < 1 || nickname.length > 20) return fail('昵称 1-20 字');
      sets.push('nickname = ?'); vals.push(nickname);
    }
    if (has('bio')) {
      const bio = (body.bio || '').toString();
      if (bio.length > 200) return fail('简介最多 200 字');
      sets.push('bio = ?'); vals.push(bio || null);
    }
    if (has('avatarUrl')) {
      let avatarUrl = (body.avatarUrl || '').toString().trim();
      if (avatarUrl) {
        // 只接受 http(s) 外链；R2 上传的头像由 /me/avatar 接口直接写库（r2: 前缀），不在这里传
        if (!/^https?:\/\//i.test(avatarUrl)) return fail('头像链接必须是 http(s) 网址');
        if (avatarUrl.length > 500) return fail('头像链接过长');
      } else {
        avatarUrl = null;   // 空串 → 清空头像
      }
      sets.push('avatar_url = ?'); vals.push(avatarUrl);
    }

    if (sets.length === 0) return fail('没有需要更新的字段');
    sets.push("updated_at = datetime('now')");
    vals.push(uid);

    const db = c.env.DB;
    await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE uid = ?`).bind(...vals).run();
    const row = await db.prepare('SELECT * FROM users WHERE uid = ?').bind(uid).first();
    return c.json(ok(serializeUser(row), { updatedAt: row && row.updated_at }));
  } catch (e) {
    return fail(`[update profile] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 上传头像到 KV（仅需登录）====================
// multipart/form-data，字段名 file；存为 avatars/<uid>/<时间戳随机>.<ext>
// 成功后直接把 users.avatar_url 更新为 'kv:<key>'，前端用 GET /api/auth/avatar/:uid 取图。
// KV 免费档不要绑卡；写入后全球同步最多约 1 分钟，上传完用本地 object URL 立即预览兜底。
auth.post('/me/avatar', requireAuth(), async (c) => {
  try {
    if (!c.env || !c.env.AVATARS || typeof c.env.AVATARS.put !== 'function') {
      return fail('头像上传未启用：KV 存储未配置', 503);
    }
    const payload = c.get('jwtPayload');
    if (!payload || !payload.sub) return fail('无效的 token', 401);
    const uid = payload.sub;

    let form;
    try { form = await c.req.raw.formData(); } catch { return fail('请求体解析失败（需 multipart/form-data）'); }
    // 标准 FormData 用 .get()；兼容 parseBody 返回的普通对象
    const file = form ? (typeof form.get === 'function' ? form.get('file') : form.file) : null;
    if (!file || typeof file.arrayBuffer !== 'function') return fail('缺少文件字段 file');

    const type = (file.type || '').toLowerCase();
    if (!type.startsWith('image/')) return fail('仅支持图片格式');
    const MAX = 2 * 1024 * 1024;   // 2MB
    if (file.size && file.size > MAX) return fail('图片不能超过 2MB');

    // 扩展名：image/png→png, image/jpeg→jpg, image/gif→gif, image/webp→webp, 其它用 subtype
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })[type]
      || (type.split('/')[1] || 'bin');

    const data = await file.arrayBuffer();
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const key = `avatars/${uid}/${ts}-${rand}.${ext}`;
    await c.env.AVATARS.put(key, data, { metadata: { contentType: type || 'image/png' } });

    // 删旧头像（如有），避免 KV 堆积；kv:/r2: 前缀的旧 key 才删
    const db = c.env.DB;
    const cur = await db.prepare('SELECT avatar_url FROM users WHERE uid = ?').bind(uid).first();
    const oldA = cur && typeof cur.avatar_url === 'string' ? cur.avatar_url : null;
    const oldKey = (oldA && (oldA.startsWith('kv:') || oldA.startsWith('r2:'))) ? oldA.slice(3) : null;
    await db.prepare("UPDATE users SET avatar_url = ?, updated_at = datetime('now') WHERE uid = ?")
      .bind(`kv:${key}`, uid).run();
    if (oldKey && oldKey !== key) {
      try { await c.env.AVATARS.delete(oldKey); } catch {}
    }
    return c.json(ok({ avatarUrl: `kv:${key}` }));
  } catch (e) {
    return fail(`[upload avatar] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 公开取头像（无需登录，<img> 直接用）====================
// GET /api/auth/avatar/:uid
//   - avatar_url 形如 kv:<key> → 从 KV 流式返回原图（带 contentType metadata）
//   - 形如 http(s) 外链 → 302 跳转
//   - 无 → 404（前端回退到首字母占位）
auth.get('/avatar/:uid', async (c) => {
  try {
    const uid = (c.req.param('uid') || '').trim();
    if (!/^\d{1,8}$/.test(uid)) return new Response(null, { status: 404 });
    const row = await c.env.DB.prepare('SELECT avatar_url FROM users WHERE uid = ?').bind(uid).first();
    const url = row && row.avatar_url;
    if (!url) return new Response(null, { status: 404 });
    // KV 存储的头像
    if (url.startsWith('kv:')) {
      if (!c.env || !c.env.AVATARS || typeof c.env.AVATARS.getWithMetadata !== 'function') {
        return new Response(null, { status: 404 });
      }
      const key = url.slice(3);
      const r = await c.env.AVATARS.getWithMetadata(key, { type: 'stream' });
      if (!r || !r.value) return new Response(null, { status: 404 });
      const headers = { 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' };
      const ct = r.metadata && r.metadata.contentType;
      headers['Content-Type'] = (ct && typeof ct === 'string') ? ct : 'image/png';
      return new Response(r.value, { headers });
    }
    // http(s) 外链 → 302 跳转
    if (/^https?:\/\//i.test(url)) return Response.redirect(url, 302);
    return new Response(null, { status: 404 });
  } catch (e) {
    return new Response(null, { status: 404 });
  }
});

export default auth;
