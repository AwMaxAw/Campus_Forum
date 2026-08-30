/**
 * 系统通知（notifications 表）
 *
 * GET    /api/notifications              我的系统通知列表（JWT，分页，按时间倒序）
 * GET    /api/notifications/unread-count  我的未读通知数（JWT，用于导航栏铃铛红点）
 * POST   /api/notifications/read         全部标记已读（JWT）
 * POST   /api/notifications/read/:id     标记单条已读（JWT）
 *
 * 通知来源：发帖/评论/被赞/被回复等行为发生时，由 utils/exp.js 的 addExp 同步写入。
 */

import { Hono } from 'hono';
import { jwt } from 'hono/jwt';
import { createMiddleware } from 'hono/factory';

const notifications = new Hono();

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

function mapRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    type: r.type,
    content: r.content,
    expDelta: r.exp_delta,
    isRead: !!r.is_read,
    createdAt: r.created_at,
  };
}

// ==================== 我的系统通知列表（分页，倒序）====================
notifications.get('/', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);

  const { searchParams } = new URL(c.req.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));
  const offset = (page - 1) * pageSize;

  const db = c.env.DB;
  const count = await db
    .prepare('SELECT COUNT(*) AS c FROM notifications WHERE uid = ?')
    .bind(uid).first();
  const total = count.c;

  const rows = await db
    .prepare('SELECT * FROM notifications WHERE uid = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
    .bind(uid, pageSize, offset).all();

  return c.json(ok(rows.results.map(mapRow), {
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  }));
});

// ==================== 未读数（导航栏铃铛红点）====================
notifications.get('/unread-count', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);

  const db = c.env.DB;
  const row = await db
    .prepare('SELECT COUNT(*) AS c FROM notifications WHERE uid = ? AND is_read = 0')
    .bind(uid).first();
  return c.json(ok({ count: row ? row.c : 0 }));
});

// ==================== 全部标记已读 ====================
notifications.post('/read', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);

  const db = c.env.DB;
  await db.prepare('UPDATE notifications SET is_read = 1 WHERE uid = ? AND is_read = 0').bind(uid).run();
  return c.json(ok({ marked: true }));
});

// ==================== 标记单条已读 ====================
notifications.post('/read/:id', requireAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id) || id <= 0) return fail('ID 无效');

  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);

  const db = c.env.DB;
  await db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND uid = ?').bind(id, uid).run();
  return c.json(ok({ id, read: true }));
});

export default notifications;
