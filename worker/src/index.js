/**
 * 五中校园论坛 - Cloudflare Worker 入口
 *
 * 第一阶段：最小骨架，仅支持 2 个路由（先用临时 uid，不做 JWT 认证）
 *   GET  /api/posts          → 取帖子列表（带分页）
 *   POST /api/posts          → 发新帖（临时用 query ?uid=xxx 鉴权，下一步接 JWT）
 *   GET  /api/health         → 健康检查
 *
 * 下一阶段：接 auth.js（注册/登录/JWT/bcrypt）
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

// 允许 Vercel / GitHub Pages / 本地开发三种前端来源跨域
// 更严的限制在业务层
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

// ==================== 健康检查 ====================
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'campus-forum-worker',
    time: new Date().toISOString(),
  });
});

// ==================== 工具函数 ====================

/** 把 D1 返回的 snake_case 行对象转成前端友好的格式 */
function mapPostRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    authorUid: row.author_uid,
    authorNickname: row.author_nickname || null,   // 有 JOIN 时用
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

/** 统一响应格式，跟前端 api 对象返回结构对齐 */
function ok(data, extra) {
  return { success: true, data, ...(extra || {}) };
}
function fail(message, status = 400) {
  return new Response(JSON.stringify({ success: false, message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ==================== 帖子列表 ====================
app.get('/api/posts', async (c) => {
  const { searchParams } = new URL(c.req.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));
  const category = searchParams.get('category');
  const offset = (page - 1) * pageSize;

  const db = c.env.DB;

  // 基础 WHERE：隐藏帖只有管理员能看到，这阶段先不过滤管理员身份，直接都不显示
  const whereParts = ['p.is_hidden = 0'];
  const params = [];
  if (category) {
    whereParts.push('p.category = ?');
    params.push(category);
  }
  const whereSQL = whereParts.join(' AND ');

  // 总数（用于前端分页）
  const countResult = await db
    .prepare(`SELECT COUNT(*) AS c FROM posts p WHERE ${whereSQL}`)
    .bind(...params)
    .first();
  const total = countResult.c;

  // 分页结果 + JOIN 作者昵称
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

// ==================== 发新帖 ====================
// 注意：这阶段鉴权简化成 query.uid，下一步接 JWT 会改成 Authorization: Bearer <token>
app.post('/api/posts', async (c) => {
  // 临时鉴权：query 参数里要带 uid（8 位数字），否则 401
  const { searchParams } = new URL(c.req.url);
  const uid = searchParams.get('uid');
  if (!uid || !/^\d{8}$/.test(uid)) {
    return fail('需要登录（临时鉴权：?uid=8位数字）', 401);
  }

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

  const db = c.env.DB;

  // 作者不存在？先自动创建一个（简化版，下一阶段接注册流程时移除）
  const existingUser = await db
    .prepare('SELECT uid FROM users WHERE uid = ?')
    .bind(uid)
    .first();
  if (!existingUser) {
    // bcrypt hash of '123456' —— 占位，用户注册时会覆盖
    const defaultHash = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    await db
      .prepare('INSERT INTO users (uid, password_hash, nickname) VALUES (?, ?, ?)')
      .bind(uid, defaultHash, `用户${uid}`)
      .run();
  }

  // 插入帖子
  const result = await db
    .prepare(
      `INSERT INTO posts (author_uid, title, content, category, tags)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(uid, title, content, category, tags)
    .run();

  const postId = result.meta.last_row_id;

  // 读回刚插入的行，返回完整对象
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
