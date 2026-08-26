/**
 * 收藏帖子
 *
 * POST   /api/favorites/toggle      toggle 收藏/取消 → 返回 { favorited, favoriteCount? }
 * GET    /api/favorites/mine         我收藏的帖子列表（JWT，分页）
 *
 * 唯一性：favorites 表 PRIMARY KEY (uid, post_id)
 */

import { Hono } from 'hono';
import { jwt } from 'hono/jwt';

const favorites = new Hono();

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

favorites.post('/toggle', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);

  let body;
  try { body = await c.req.json(); } catch { return fail('请求体必须是合法 JSON'); }
  const postId = parseInt(body.post_id || '0', 10);
  if (!postId || postId <= 0) return fail('缺少 post_id');

  const db = c.env.DB;

  const post = await db.prepare('SELECT id, is_hidden FROM posts WHERE id = ?').bind(postId).first();
  if (!post || post.is_hidden) return fail('帖子不存在或已被删除', 404);

  const existing = await db.prepare('SELECT 1 FROM favorites WHERE uid = ? AND post_id = ?')
    .bind(uid, postId).first();

  let favorited;
  if (existing) {
    await db.prepare('DELETE FROM favorites WHERE uid = ? AND post_id = ?').bind(uid, postId).run();
    favorited = false;
  } else {
    await db.prepare('INSERT OR IGNORE INTO favorites (uid, post_id) VALUES (?, ?)').bind(uid, postId).run();
    favorited = true;
  }

  return c.json(ok({ favorited }));
});

favorites.get('/mine', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);

  const { searchParams } = new URL(c.req.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));
  const offset = (page - 1) * pageSize;
  const db = c.env.DB;

  const count = await db
    .prepare('SELECT COUNT(*) AS c FROM favorites f JOIN posts p ON p.id = f.post_id WHERE f.uid = ? AND p.is_hidden = 0')
    .bind(uid).first();
  const total = count.c;

  const rows = await db
    .prepare(
      `SELECT p.*, u.nickname AS author_nickname, u.role AS author_role
       FROM favorites f
       JOIN posts p ON p.id = f.post_id
       LEFT JOIN users u ON u.uid = p.author_uid
       WHERE f.uid = ? AND p.is_hidden = 0
       ORDER BY f.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(uid, pageSize, offset).all();

  return c.json(ok(
    rows.results.map(r => ({
      id: r.id, title: r.title, content: r.content,
      authorUid: r.author_uid, authorNickname: r.author_nickname, authorRole: r.author_role,
      category: r.category, tags: r.tags ? r.tags.split(',') : [],
      viewCount: r.view_count, likeCount: r.like_count, commentCount: r.comment_count,
      isPinned: !!r.is_pinned, createdAt: r.created_at, updatedAt: r.updated_at,
      isFavorited: true,
    })),
    { pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } }
  ));
});

export default favorites;
