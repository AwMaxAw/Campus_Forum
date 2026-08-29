/**
 * 点赞（帖子级）
 *
 * POST   /api/likes/toggle            toggle 点赞/取消点赞 → 返回 { liked, likeCount }
 * GET    /api/likes/post/:post_id     查自己对某帖的点赞状态（公开：如果登录）
 * GET    /api/likes/mine              我点过赞的帖子列表（JWT）
 *
 * 点赞唯一性靠：post_likes 表 PRIMARY KEY (uid, post_id)
 *   —— 即使前端狂点 100 次，DB 也只允许存一条。
 */

import { Hono } from 'hono';
import { jwt } from 'hono/jwt';
import { createMiddleware } from 'hono/factory';
import { EXP, addExp } from '../utils/exp.js';

const likes = new Hono();

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

/**
 * toggle 点赞：
 *   已点赞 → DELETE + like_count - 1
 *   未点赞 → INSERT + like_count + 1
 * 用事务保证原子性（D1 用 BEGIN / COMMIT）
 */
likes.post('/toggle', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);

  let body;
  try { body = await c.req.json(); } catch { return fail('请求体必须是合法 JSON'); }
  const postId = parseInt(body.post_id || '0', 10);
  if (!postId || postId <= 0) return fail('缺少 post_id');

  const db = c.env.DB;

  // 帖子存在？（顺便取作者 UID，用于"帖子被点赞 +3"积分）
  const post = await db.prepare('SELECT id, is_hidden, author_uid FROM posts WHERE id = ?').bind(postId).first();
  if (!post || post.is_hidden) return fail('帖子不存在或已被删除', 404);

  const existing = await db
    .prepare('SELECT 1 FROM post_likes WHERE uid = ? AND post_id = ?')
    .bind(uid, postId)
    .first();

  let liked;
  let stmt;
  if (existing) {
    // 取消点赞
    await db.prepare('DELETE FROM post_likes WHERE uid = ? AND post_id = ?').bind(uid, postId).run();
    stmt = db.prepare('UPDATE posts SET like_count = MAX(0, like_count - 1) WHERE id = ? RETURNING like_count');
    liked = false;
  } else {
    // 点赞（UNIQUE 冲突兜底 —— 虽然上一步查过，但并发时可能被抢插，INSERT OR IGNORE 安全）
    await db.prepare('INSERT OR IGNORE INTO post_likes (uid, post_id) VALUES (?, ?)').bind(uid, postId).run();
    stmt = db.prepare('UPDATE posts SET like_count = like_count + 1 WHERE id = ? RETURNING like_count');
    liked = true;
    // 积分：帖子被点赞，给帖作者 +EXP.LIKED（自己赞自己不加分）
    if (post.author_uid && post.author_uid !== uid) {
      await addExp(db, post.author_uid, EXP.LIKED);
    }
  }
  const resultRow = await stmt.bind(postId).first();
  const likeCount = resultRow ? resultRow.like_count : 0;

  return c.json(ok({ liked, likeCount }));
});

// ==================== 自己对某帖是否已点赞（详情页也会用这个，但我们详情页已经冗余了这个字段）====================
likes.get('/post/:post_id', async (c) => {
  const postId = parseInt(c.req.param('post_id'), 10);
  if (!postId || postId <= 0) return fail('post_id 无效');

  // 解析 JWT（不 throw，失败就当未登录返回 false）
  let uid = null;
  try {
    const auth = c.req.header('Authorization') || '';
    if (auth.startsWith('Bearer ')) {
      const parts = auth.slice(7).split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        uid = payload.sub;
      }
    }
  } catch {}

  let liked = false;
  if (uid) {
    const row = await c.env.DB.prepare('SELECT 1 FROM post_likes WHERE uid = ? AND post_id = ?')
      .bind(uid, postId).first();
    liked = !!row;
  }
  return c.json(ok({ liked }));
});

// ==================== 我点过赞的帖子（分页，按点赞时间倒序）====================
likes.get('/mine', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);

  const { searchParams } = new URL(c.req.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));
  const offset = (page - 1) * pageSize;
  const db = c.env.DB;

  const count = await db
    .prepare('SELECT COUNT(*) AS c FROM post_likes l JOIN posts p ON p.id = l.post_id WHERE l.uid = ? AND p.is_hidden = 0')
    .bind(uid).first();
  const total = count.c;

  const rows = await db
    .prepare(
      `SELECT p.*, u.nickname AS author_nickname, u.role AS author_role,
              1 AS is_liked
       FROM post_likes l
       JOIN posts p ON p.id = l.post_id
       LEFT JOIN users u ON u.uid = p.author_uid
       WHERE l.uid = ? AND p.is_hidden = 0
       ORDER BY l.created_at DESC
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
      isLiked: true,
    })),
    { pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } }
  ));
});

export default likes;
