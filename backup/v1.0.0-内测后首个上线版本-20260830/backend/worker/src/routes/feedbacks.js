/**
 * 反馈（悬浮球提交 bug/建议）
 *
 * POST /api/feedbacks          提交一条反馈（JWT）
 * GET  /api/feedbacks          查看反馈列表（公开，按时间倒序，每页 50 条）
 */

import { Hono } from 'hono';
import { jwt } from 'hono/jwt';
import { createMiddleware } from 'hono/factory';

const feedbacks = new Hono();

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

// ==================== 提交反馈（需登录）====================
feedbacks.post('/', requireAuth(), async (c) => {
  try {
    const payload = c.get('jwtPayload');
    const uid = payload && payload.sub;
    if (!uid) return fail('需要登录', 401);

    const body = await c.req.json();
    const content = (body.content || '').trim();
    if (!content) return fail('反馈内容不能为空');
    if (content.length > 1000) return fail('反馈内容不能超过 1000 字');

    const db = c.env.DB;
    const info = await db
      .prepare('INSERT INTO feedbacks (author_uid, content) VALUES (?, ?)')
      .bind(uid, content)
      .run();

    // Cloudflare D1 返回的自增 ID 在 meta.last_row_id 中
    const newId = info.meta && info.meta.last_row_id;
    if (!newId) return fail('写入失败', 500);

    const row = await db
      .prepare(`SELECT f.id, f.content, f.created_at, f.author_uid, u.nickname, u.avatar_url, u.role
                FROM feedbacks f LEFT JOIN users u ON u.uid = f.author_uid
                WHERE f.id = ?`)
      .bind(newId)
      .first();

    return c.json(ok(mapFeedbackRow(row)));
  } catch (e) {
    return fail(`[feedback post] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 反馈列表（公开，按时间倒序）====================
feedbacks.get('/', async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50', 10) || 50));
    const offset = (page - 1) * limit;

    const db = c.env.DB;
    const countRow = await db.prepare('SELECT COUNT(*) AS c FROM feedbacks').first();
    const rows = await db
      .prepare(
        `SELECT f.id, f.content, f.created_at, f.author_uid,
                u.nickname, u.avatar_url, u.role
         FROM feedbacks f
         LEFT JOIN users u ON u.uid = f.author_uid
         ORDER BY f.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .bind(limit, offset)
      .all();

    const list = (rows.results || []).map(mapFeedbackRow);
    return c.json(ok(list, {
      pagination: {
        page, limit, total: countRow.c,
        hasMore: offset + list.length < countRow.c,
      },
    }));
  } catch (e) {
    return fail(`[feedback list] ${e.name}: ${e.message}`, 500);
  }
});

function mapFeedbackRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    content: r.content,
    createdAt: r.created_at,
    author: {
      uid: r.author_uid,
      nickname: r.nickname || null,
      avatarUrl: r.avatar_url || null,
      role: r.role || 'member',
    },
  };
}

export default feedbacks;
