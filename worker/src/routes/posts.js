/**
 * 帖子相关路由
 *
 * GET    /api/posts              列表（分页、分区过滤）
 * GET    /api/posts/:id          帖子详情（view_count += 1，附带作者信息）
 * POST   /api/posts              发新帖（JWT）
 * DELETE /api/posts/:id          删帖（JWT，作者本人 或 admin）
 */

import { Hono } from 'hono';
import { jwt } from 'hono/jwt';

const posts = new Hono();

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
  return jwt({ secret: (c) => c.env.JWT_SECRET, alg: 'HS256' });
}

function mapPostRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    authorUid: row.author_uid,
    authorNickname: row.author_nickname || null,
    authorRole: row.author_role || null,
    category: row.category,
    tags: row.tags ? row.tags.split(',') : [],
    viewCount: row.view_count,
    likeCount: row.like_count,
    commentCount: row.comment_count,
    isPinned: !!row.is_pinned,
    isHidden: !!row.is_hidden,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 详情页才有的额外字段：当前用户是否点赞/收藏
    isLiked: !!row.is_liked,
    isFavorited: !!row.is_favorited,
  };
}

// ==================== 列表（公开）====================
posts.get('/', async (c) => {
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
      `SELECT p.*, u.nickname AS author_nickname, u.role AS author_role
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

// ==================== 详情（公开，附带当前用户是否点赞/收藏）====================
posts.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id) || id <= 0) return fail('帖子 ID 无效');

  const db = c.env.DB;

  // 浏览量 +1（用 UPDATE ... RETURNING 直接拿最新数据）
  // SQLite 3.35+ 支持 RETURNING，D1 是 OK 的
  const row = await db
    .prepare(
      `UPDATE posts SET view_count = view_count + 1
       WHERE id = ? AND is_hidden = 0
       RETURNING *, (SELECT nickname FROM users WHERE uid = author_uid) AS author_nickname,
                    (SELECT role FROM users WHERE uid = author_uid) AS author_role`
    )
    .bind(id)
    .first();
  if (!row) return fail('帖子不存在或已被删除', 404);

  // 查当前用户是否点赞/收藏（没登录就 false）
  let uid = null;
  try {
    // 轻量解析 JWT（不 throw，失败就当未登录）
    const auth = c.req.header('Authorization') || '';
    if (auth.startsWith('Bearer ')) {
      // 先只看 payload 不验签——"我是谁"信任请求头里的 uid；真正写入类接口再走 requireAuth() 强校验
      const parts = auth.slice(7).split('.');
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
          uid = payload.sub;
        } catch {}
      }
    }
  } catch {}

  let isLiked = false;
  let isFavorited = false;
  if (uid) {
    const likeRow = await db.prepare('SELECT 1 FROM post_likes WHERE uid = ? AND post_id = ?').bind(uid, id).first();
    const favRow = await db.prepare('SELECT 1 FROM favorites WHERE uid = ? AND post_id = ?').bind(uid, id).first();
    isLiked = !!likeRow;
    isFavorited = !!favRow;
  }

  const result = mapPostRow({ ...row, is_liked: isLiked, is_favorited: isFavorited });
  return c.json(ok(result));
});

// ==================== 发新帖（JWT）====================
posts.post('/', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);

  const db = c.env.DB;
  const author = await db
    .prepare('SELECT uid, role FROM users WHERE uid = ?')
    .bind(uid)
    .first();
  if (!author) return fail('用户不存在', 401);

  let body;
  try { body = await c.req.json(); } catch { return fail('请求体必须是合法 JSON'); }
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

  const result = await db
    .prepare(`INSERT INTO posts (author_uid, title, content, category, tags) VALUES (?, ?, ?, ?, ?)`)
    .bind(uid, title, content, category, tags)
    .run();

  const postId = result.meta.last_row_id;
  const created = await db
    .prepare(
      `SELECT p.*, u.nickname AS author_nickname, u.role AS author_role
       FROM posts p LEFT JOIN users u ON u.uid = p.author_uid WHERE p.id = ?`
    )
    .bind(postId)
    .first();

  return c.json(ok(mapPostRow(created)), 201);
});

// ==================== 删帖（JWT：作者本人 或 admin/dev_admin）====================
posts.delete('/:id', requireAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id) || id <= 0) return fail('帖子 ID 无效');

  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  const role = payload && payload.role;

  const db = c.env.DB;
  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  if (!post) return fail('帖子不存在', 404);

  const isAdmin = role === 'admin' || role === 'dev_admin';
  if (post.author_uid !== uid && !isAdmin) return fail('没有权限删除该帖子', 403);

  // 软删除：is_hidden = 1，不物理删
  await db.prepare('UPDATE posts SET is_hidden = 1 WHERE id = ?').bind(id).run();
  // 同时隐藏该帖下所有评论（保持数据一致，但不改变原 is_hidden = 1 的评论——不管）
  await db.prepare('UPDATE comments SET is_hidden = 1 WHERE post_id = ?').bind(id).run();

  return c.json(ok({ id, hidden: true }));
});

export default posts;
