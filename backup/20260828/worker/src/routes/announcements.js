/**
 * 全站公告
 *
 * GET  /api/announcements              公告历史（公开，分页，按时间倒序）
 * GET  /api/announcements/unread       "我还有哪些没读的公告"（JWT）→ 返回未读列表，前端弹窗一条条展示
 * POST /api/announcements/read/:id     标记某公告"我已读"（JWT）
 * POST /api/announcements              发新公告（仅 admin / dev_admin，body: { title, content, is_pinned? }）
 */

import { Hono } from 'hono';
import { jwt } from 'hono/jwt';
import { createMiddleware } from 'hono/factory';

const announcements = new Hono();

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

function mapAnnouncement(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    isPinned: !!row.is_pinned,
    authorUid: row.author_uid,
    authorNickname: row.author_nickname || null,
    createdAt: row.created_at,
  };
}

// ==================== 公告历史（公开，分页）====================
announcements.get('/', async (c) => {
  const { searchParams } = new URL(c.req.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));
  const offset = (page - 1) * pageSize;
  const db = c.env.DB;

  const count = await db.prepare('SELECT COUNT(*) AS c FROM announcements').first();
  const total = count.c;

  const rows = await db
    .prepare(
      `SELECT a.*, u.nickname AS author_nickname
       FROM announcements a LEFT JOIN users u ON u.uid = a.author_uid
       ORDER BY a.is_pinned DESC, a.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(pageSize, offset).all();

  return c.json(ok(rows.results.map(mapAnnouncement), {
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  }));
});

// ==================== 未读公告（JWT 取当前用户） ====================
// 算法：announcements 里"没有出现在 announcements_read（user_uid=我）"的那些，按创建时间倒序
announcements.get('/unread', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);

  const rows = await c.env.DB
    .prepare(
      `SELECT a.*, u.nickname AS author_nickname
       FROM announcements a LEFT JOIN users u ON u.uid = a.author_uid
       WHERE a.id NOT IN (SELECT announcement_id FROM announcements_read WHERE user_uid = ?)
       ORDER BY a.is_pinned DESC, a.created_at ASC`
    )
    .bind(uid).all();

  return c.json(ok(rows.results.map(mapAnnouncement)));
});

// ==================== 标记某公告已读 ====================
announcements.post('/read/:id', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id) || id <= 0) return fail('公告 ID 无效');

  const db = c.env.DB;
  const ann = await db.prepare('SELECT id FROM announcements WHERE id = ?').bind(id).first();
  if (!ann) return fail('公告不存在', 404);

  // INSERT OR IGNORE：重复点"知道了"不报错
  await db
    .prepare('INSERT OR IGNORE INTO announcements_read (user_uid, announcement_id) VALUES (?, ?)')
    .bind(uid, id).run();

  return c.json(ok({ read: true }));
});

// ==================== 发新公告（仅 admin / dev_admin） ====================
announcements.post('/', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  const role = payload && payload.role;
  if (!uid) return fail('需要登录', 401);
  const isAdmin = role === 'admin' || role === 'dev_admin';
  if (!isAdmin) return fail('只有管理员才能发公告', 403);

  let body;
  try { body = await c.req.json(); } catch { return fail('请求体必须是合法 JSON'); }
  const title = (body.title || '').trim();
  const content = (body.content || '').trim();
  const isPinned = body.is_pinned ? 1 : 0;

  if (!title) return fail('标题不能为空');
  if (!content) return fail('内容不能为空');
  if (title.length > 100) return fail('标题不能超过 100 字');
  if (content.length > 5000) return fail('内容不能超过 5000 字');

  const db = c.env.DB;
  const result = await db
    .prepare('INSERT INTO announcements (author_uid, title, content, is_pinned) VALUES (?, ?, ?, ?)')
    .bind(uid, title, content, isPinned).run();

  const created = await db
    .prepare(
      `SELECT a.*, u.nickname AS author_nickname
       FROM announcements a LEFT JOIN users u ON u.uid = a.author_uid
       WHERE a.id = ?`
    )
    .bind(result.meta.last_row_id).first();

  return c.json(ok(mapAnnouncement(created)), 201);
});

export default announcements;
