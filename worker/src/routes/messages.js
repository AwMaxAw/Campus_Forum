/**
 * 私信系统（不做实时推送，打开页面时拉取 + 手动点「标为已读」——MVP 够了）
 *
 * GET  /api/messages/unread-count                 未读总数（顶栏小红点数字）
 * GET  /api/messages/conversations                会话列表：按每个"对方 UID"聚合，显示最后一条消息 + 未读计数
 * GET  /api/messages/conversation/:otherUid       与某人的对话：双方所有消息（升序，返回时自动把对方的消息标为已读）
 * POST /api/messages                               发私信（body: { to_uid, content }）
 * POST /api/messages/read/:otherUid                手动标某对话已读（其实 GET /conversation/:uid 也会标已读，但给前端一个显式入口）
 */

import { Hono } from 'hono';
import { jwt } from 'hono/jwt';
import { createMiddleware } from 'hono/factory';

const messages = new Hono();

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
 * 关键修复：不要直接返回 jwt({ secret: (c) => c.env.JWT_SECRET })，
 * 因为在子路由挂载时 jwt({...}) 会"立即"执行，此时 secret 回调拿到的 c.env 上下文
 * 可能未被正确绑定（Hono v4 子路由的闭包/作用域差异），结果就是 JWT 验证时 secret 实际上
 * 是 undefined，导致全部 401（前端会自动 clearAuth 把登录态清掉）。
 *
 * 解决方案：createMiddleware 把 jwt() 的创建延迟到"请求实际到来的那一刻"，此时
 * `c` 是真实的请求上下文，c.env.JWT_SECRET 一定有值。
 */
function requireAuth() {
  return createMiddleware(async (c, next) => {
    const mw = jwt({ secret: c.env.JWT_SECRET, alg: 'HS256' });
    return mw(c, next);
  });
}

function mapMsgRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    fromUid: row.from_uid,
    toUid: row.to_uid,
    content: row.content,
    isRead: !!row.is_read,
    createdAt: row.created_at,
  };
}

// ==================== 未读消息总数（顶栏红点数字）====================
messages.get('/unread-count', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);
  const row = await c.env.DB
    .prepare('SELECT COUNT(*) AS c FROM messages WHERE to_uid = ? AND is_read = 0')
    .bind(uid).first();
  return c.json(ok({ count: row.c }));
});

// ==================== 会话列表（按对方聚合）====================
messages.get('/conversations', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);

  const db = c.env.DB;

  // 取"我和哪些人聊过"：把我发出的和我收到的并起来，取对方 UID
  // 再对每一组取"最后一条消息 + 未读计数（对方发给我的未读）"
  // SQLite 用窗口函数最优雅，但 D1 支持得一般；这里用子查询保持兼容。
  const rows = await db
    .prepare(
      `SELECT DISTINCT other_uid,
              (SELECT nickname FROM users WHERE uid = other_uid) AS other_nickname,
              (SELECT role FROM users WHERE uid = other_uid) AS other_role,
              (SELECT id FROM messages
                 WHERE (from_uid = me AND to_uid = other_uid) OR (from_uid = other_uid AND to_uid = me)
                 ORDER BY id DESC LIMIT 1) AS last_msg_id
       FROM (
         SELECT from_uid AS other_uid, to_uid AS me FROM messages WHERE to_uid = ?
         UNION
         SELECT to_uid AS other_uid, from_uid AS me FROM messages WHERE from_uid = ?
       ) pairs
       ORDER BY last_msg_id DESC`
    )
    .bind(uid, uid).all();

  // 对每个会话补 last_msg 内容 + unread_count
  const list = [];
  for (const r of rows.results) {
    const lastMsg = r.last_msg_id
      ? await db.prepare('SELECT * FROM messages WHERE id = ?').bind(r.last_msg_id).first()
      : null;
    const unreadRow = await db
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE from_uid = ? AND to_uid = ? AND is_read = 0')
      .bind(r.other_uid, uid).first();
    list.push({
      otherUid: r.other_uid,
      otherNickname: r.other_nickname || `用户${r.other_uid}`,
      otherRole: r.other_role || null,
      lastMessage: lastMsg ? {
        id: lastMsg.id,
        fromUid: lastMsg.from_uid,
        content: lastMsg.content,
        createdAt: lastMsg.created_at,
      } : null,
      unreadCount: unreadRow.c,
    });
  }
  return c.json(ok(list));
});

// ==================== 对话详情（与某人的所有消息） ====================
messages.get('/conversation/:otherUid', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);
  const otherUid = c.req.param('otherUid');
  if (!/^\d{8}$/.test(otherUid)) return fail('对方 UID 格式无效');

  const db = c.env.DB;

  // 先把对方给我的未读全部标为已读（只要打开对话就算"看过了"，这是主流 IM 行为）
  await db
    .prepare('UPDATE messages SET is_read = 1 WHERE from_uid = ? AND to_uid = ? AND is_read = 0')
    .bind(otherUid, uid).run();

  // 然后拉全量消息（按 id 升序）
  const rows = await db
    .prepare(
      `SELECT * FROM messages
       WHERE (from_uid = ? AND to_uid = ?) OR (from_uid = ? AND to_uid = ?)
       ORDER BY id ASC`
    )
    .bind(uid, otherUid, otherUid, uid).all();

  return c.json(ok(rows.results.map(mapMsgRow)));
});

// ==================== 发私信 ====================
messages.post('/', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const fromUid = payload && payload.sub;
  if (!fromUid) return fail('需要登录', 401);

  let body;
  try { body = await c.req.json(); } catch { return fail('请求体必须是合法 JSON'); }
  const toUid = (body.to_uid || '').trim();
  const content = (body.content || '').trim();

  if (!/^\d{8}$/.test(toUid)) return fail('对方 UID 必须是 8 位数字');
  if (toUid === fromUid) return fail('不能给自己发消息');
  if (!content) return fail('消息内容不能为空');
  if (content.length > 1000) return fail('消息不能超过 1000 字');

  const db = c.env.DB;
  const recipient = await db.prepare('SELECT uid, is_hidden FROM users WHERE uid = ?').bind(toUid).first();
  if (!recipient) return fail('接收方用户不存在', 404);

  const result = await db
    .prepare('INSERT INTO messages (from_uid, to_uid, content) VALUES (?, ?, ?)')
    .bind(fromUid, toUid, content).run();

  const created = await db
    .prepare('SELECT * FROM messages WHERE id = ?')
    .bind(result.meta.last_row_id).first();

  return c.json(ok(mapMsgRow(created)), 201);
});

// ==================== 显式标某对话已读（备用，打开对话时其实会自动标）====================
messages.post('/read/:otherUid', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);
  const otherUid = c.req.param('otherUid');
  if (!/^\d{8}$/.test(otherUid)) return fail('对方 UID 格式无效');

  await c.env.DB
    .prepare('UPDATE messages SET is_read = 1 WHERE from_uid = ? AND to_uid = ? AND is_read = 0')
    .bind(otherUid, uid).run();

  return c.json(ok({ read: true }));
});

export default messages;
