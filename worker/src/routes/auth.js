/**
 * 账号路由：注册 / 登录 / 当前用户
 *
 * POST /api/auth/register  → 创建新用户
 * POST /api/auth/login     → 验证账号密码 → 返回 JWT
 * GET  /api/auth/me        → 用 Authorization: Bearer <JWT> 取当前用户
 */

import { Hono } from 'hono';
import { jwt } from 'hono/jwt';
import { sign } from 'hono/jwt';
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

  if (!isUidValid(uid)) return fail('UID 必须是 8 位数字');
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
  const db = c.env.DB;
  let body;
  try {
    body = await c.req.json();
  } catch {
    return fail('请求体必须是合法 JSON');
  }

  const uid = (body.uid || '').trim();
  const password = (body.password || '').toString();
  if (!isUidValid(uid)) return fail('请输入 8 位数字 UID');
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

  // 被软删/封禁？扩展字段先预留着，现在不启用
  // if (user.is_banned) return fail('账号已被封禁', 403);

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user.uid,
    role: user.role,
    iat: now,
    exp: now + JWT_TTL_SEC,
  };
  const token = await sign(payload, c.env.JWT_SECRET, 'HS256');

  return c.json(ok(serializeUser(user), {
    token,
    tokenExpiresAt: new Date((now + JWT_TTL_SEC) * 1000).toISOString(),
  }));
});

// ==================== 当前用户（JWT 中间件保护） ====================
auth.get('/me', jwt({ secret: (c) => c.env.JWT_SECRET, alg: 'HS256' }), async (c) => {
  const payload = c.get('jwtPayload');
  if (!payload || !payload.sub) return fail('无效的 token', 401);

  const user = await c.env.DB
    .prepare('SELECT * FROM users WHERE uid = ?')
    .bind(payload.sub)
    .first();

  if (!user) return fail('用户不存在', 401);
  return c.json(ok(serializeUser(user)));
});

export default auth;
