/**
 * 评论 + 楼中楼
 *
 * GET    /api/comments?post_id=123                 某帖评论（扁平化，带 reply_to_id，前端自己折叠层级）
 * POST   /api/comments                              发评论（JWT，body: { post_id, content, reply_to_id? }）
 * DELETE /api/comments/:id                          删评论（JWT，作者或 admin，软删 is_hidden=1）
 *
 * 楼中楼设计：
 *   - 每条评论带 reply_to_id（null = 主评论；非 null = 回复某条具体评论）
 *   - 回复嵌套层数不限（扁平化返回，前端按 reply_to_id 构建树）
 *   - 被回复的评论即使删掉，回复仍然保留（reply_to 会指向已删除评论，前端显示"该评论已删除"占位）
 */

import { Hono } from 'hono';
import { jwt } from 'hono/jwt';
import { createMiddleware } from 'hono/factory';

const comments = new Hono();

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

function mapCommentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    postId: row.post_id,
    authorUid: row.author_uid,
    authorNickname: row.author_nickname || null,
    authorRole: row.author_role || null,
    content: row.is_hidden ? null : row.content,  // 被软删的内容不给前端
    replyToId: row.reply_to_id,
    replyToAuthorNickname: row.reply_to_author_nickname || null,
    isHidden: !!row.is_hidden,
    createdAt: row.created_at,
  };
}

// ==================== 列表（公开，按 post_id 查，按创建时间升序）====================
comments.get('/', async (c) => {
  const { searchParams } = new URL(c.req.url);
  const postId = parseInt(searchParams.get('post_id') || '0', 10);
  if (!postId || postId <= 0) return fail('缺少 post_id 参数');

  const db = c.env.DB;
  // 评论不做分页（一般一帖几千条才需要，先全量；后面超过 1000 再改）
  const rows = await db
    .prepare(
      `SELECT c.*,
              u.nickname AS author_nickname,
              u.role AS author_role,
              ru.nickname AS reply_to_author_nickname
       FROM comments c
       LEFT JOIN users u ON u.uid = c.author_uid
       LEFT JOIN comments rc ON rc.id = c.reply_to_id
       LEFT JOIN users ru ON ru.uid = rc.author_uid
       WHERE c.post_id = ?
       ORDER BY c.created_at ASC`
    )
    .bind(postId)
    .all();

  return c.json(ok(rows.results.map(mapCommentRow)));
});

// ==================== 发评论（JWT）====================
comments.post('/', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);

  let body;
  try { body = await c.req.json(); } catch { return fail('请求体必须是合法 JSON'); }

  const postId = parseInt(body.post_id || '0', 10);
  const content = (body.content || '').trim();
  const replyToId = body.reply_to_id ? parseInt(body.reply_to_id, 10) : null;

  if (!postId || postId <= 0) return fail('缺少 post_id');
  if (!content) return fail('评论内容不能为空');
  if (content.length > 1000) return fail('评论不能超过 1000 字');

  const db = c.env.DB;

  // 1) 帖子存在？
  const post = await db.prepare('SELECT id, is_hidden FROM posts WHERE id = ?').bind(postId).first();
  if (!post || post.is_hidden) return fail('帖子不存在或已被删除', 404);

  // 2) 如回复某条评论：reply_to_id 存在且确实是同帖下的
  let replyToOk = true;
  if (replyToId) {
    if (!Number.isFinite(replyToId) || replyToId <= 0) replyToOk = false;
    else {
      const parent = await db.prepare('SELECT id, post_id FROM comments WHERE id = ?').bind(replyToId).first();
      if (!parent || parent.post_id !== postId) replyToOk = false;
    }
    if (!replyToOk) return fail('要回复的评论不存在', 404);
  }

  // 3) 插入
  const result = await db
    .prepare(`INSERT INTO comments (post_id, author_uid, content, reply_to_id) VALUES (?, ?, ?, ?)`)
    .bind(postId, uid, content, replyToId)
    .run();
  const commentId = result.meta.last_row_id;

  // 4) 帖子评论数 +1（D1 不支持触发器，手动 UPDATE）
  await db.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').bind(postId).run();

  // 5) 返回完整对象
  const created = await db
    .prepare(
      `SELECT c.*,
              u.nickname AS author_nickname,
              u.role AS author_role,
              ru.nickname AS reply_to_author_nickname
       FROM comments c
       LEFT JOIN users u ON u.uid = c.author_uid
       LEFT JOIN comments rc ON rc.id = c.reply_to_id
       LEFT JOIN users ru ON ru.uid = rc.author_uid
       WHERE c.id = ?`
    )
    .bind(commentId)
    .first();

  return c.json(ok(mapCommentRow(created)), 201);
});

// ==================== 删评论（JWT：作者或 admin，软删）====================
comments.delete('/:id', requireAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id) || id <= 0) return fail('评论 ID 无效');

  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  const role = payload && payload.role;

  const db = c.env.DB;
  const comment = await db.prepare('SELECT * FROM comments WHERE id = ?').bind(id).first();
  if (!comment) return fail('评论不存在', 404);

  const isAdmin = role === 'admin' || role === 'dev_admin';
  if (comment.author_uid !== uid && !isAdmin) return fail('没有权限删除该评论', 403);

  if (!comment.is_hidden) {
    await db.prepare('UPDATE comments SET is_hidden = 1 WHERE id = ?').bind(id).run();
    // 评论数 -1（只减一次）
    await db.prepare('UPDATE posts SET comment_count = MAX(0, comment_count - 1) WHERE id = ?').bind(comment.post_id).run();
  }
  return c.json(ok({ id, hidden: true }));
});

export default comments;
