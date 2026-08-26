/**
 * 五中校园论坛 - Cloudflare Worker 入口
 *
 * 阶段 3：接入账号体系（PBKDF2 密码哈希 + JWT）
 *   GET  /api/health            健康检查
 *   POST /api/auth/register     注册
 *   POST /api/auth/login        登录 → 返回 JWT
 *   GET  /api/auth/me           取当前用户（需 Authorization: Bearer <token>）
 *   GET  /api/posts             帖子列表（公开，无需登录）
 *   POST /api/posts             发新帖（需 JWT）
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { jwt } from 'hono/jwt';
import authRoutes from './routes/auth.js';

const app = new Hono();

// ==================== CORS（允许三种前端） ====================
app.use(
  '*',
  cors({
    origin: (origin) => {
      const allowed = [
        /^https:\/\/campus-forum.*\.vercel\.app$/,
        /^https:\/\/awmaxaw\.github\.io$/,
        /^http:\/\/localhost:\d+$/,
      ];
      return allowed.some(r => r.test(origin)) ? origin : 'null';
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
    maxAge: 86400,
  })
);

// ==================== 账号路由（/api/auth/*） ====================
app.route('/api/auth', authRoutes);

// ==================== 健康检查 ====================
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'campus-forum-worker',
    time: new Date().toISOString(),
  });
});

// ==================== 工具函数 ====================
function mapPostRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    authorUid: row.author_uid,
    authorNickname: row.author_nickname || null,
    category: row.category,
    tags: row.tags ? row.tags.split(',') : [],
    viewCount: row.view_count,
    likeCount: row.like_count,
    commentCount: row.comment_count,
    isPinned: !!row.is_pinned,
    isHidden: !!row.is_hidden,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ok(data, extra) {
  return { success: true, data, ...(extra || {}) };
}
function fail(message, status = 400) {
  return new Response(JSON.stringify({ success: false, message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 从 Authorization 头里取 Bearer <token>，再用 JWT 中间件解析。
 * jwt 中间件本身是 Hono 官方提供的，但它默认从 c.env.JWT_SECRET 取 key，
 * 我们要动态取 c.env.JWT_SECRET，所以用一个小函数包一下。
 */
function requireAuth() {
  return jwt({ secret: (c) => c.env.JWT_SECRET, alg: 'HS256' });
}

// ==================== 帖子列表（公开，不用登录） ====================
app.get('/api/posts', async (c) => {
  const { searchParams } = new URL(c.req.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));
  const category = searchParams.get('category');
  const offset = (page - 1) * pageSize;

  const db = c.env.DB;

  const whereParts = ['p.is_hidden = 0'];
  const params = [];
  if (category) {
    whereParts.push('p.category = ?');
    params.push(category);
  }
  const whereSQL = whereParts.join(' AND ');

  const countResult = await db
    .prepare(`SELECT COUNT(*) AS c FROM posts p WHERE ${whereSQL}`)
    .bind(...params)
    .first();
  const total = countResult.c;

  const rows = await db
    .prepare(
      `SELECT p.*, u.nickname AS author_nickname
       FROM posts p
       LEFT JOIN users u ON u.uid = p.author_uid
       WHERE ${whereSQL}
       ORDER BY p.is_pinned DESC, p.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...params, pageSize, offset)
    .all();

  return c.json(ok(rows.results.map(mapPostRow), {
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  }));
});

// ==================== 发新帖（需 JWT） ====================
app.post('/api/posts', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);

  // 发帖前再验证一下用户是否存在（防止 JWT 里的 sub 是已删除用户）
  const db = c.env.DB;
  const author = await db
    .prepare('SELECT uid, role FROM users WHERE uid = ?')
    .bind(uid)
    .first();
  if (!author) return fail('用户不存在', 401);

  let body;
  try {
    body = await c.req.json();
  } catch {
    return fail('请求体必须是合法 JSON');
  }
  const title = (body.title || '').trim();
  const content = (body.content || '').trim();
  const category = (body.category || 'general').trim();
  const tags = Array.isArray(body.tags) ? body.tags.slice(0, 5).join(',') : '';

  if (!title) return fail('标题不能为空');
  if (!content) return fail('内容不能为空');
  if (title.length > 100) return fail('标题不能超过 100 字');
  if (content.length > 2000) return fail('内容不能超过 2000 字');
  const allowedCategories = ['general', 'study', 'club', 'life', 'meta'];
  if (!allowedCategories.includes(category)) return fail(`分区必须是 ${allowedCategories.join('/')}`);

  // 插入帖子
  const result = await db
    .prepare(
      `INSERT INTO posts (author_uid, title, content, category, tags)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(uid, title, content, category, tags)
    .run();

  const postId = result.meta.last_row_id;

  const created = await db
    .prepare(
      `SELECT p.*, u.nickname AS author_nickname
       FROM posts p LEFT JOIN users u ON u.uid = p.author_uid
       WHERE p.id = ?`
    )
    .bind(postId)
    .first();

  return c.json(ok(mapPostRow(created)), 201);
});

// ==================== 兜底 404 ====================
app.notFound((c) => {
  return fail(`Not Found: ${c.req.method} ${new URL(c.req.url).pathname}`, 404);
});

export default app;
