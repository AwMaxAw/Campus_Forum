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
  try {
    const payload = c.get('jwtPayload');
    const uid = payload && payload.sub;
    if (!uid) return fail('需要登录', 401);
    const row = await c.env.DB
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE to_uid = ? AND is_read = 0')
      .bind(uid).first();
    return c.json(ok({ count: row.c }));
  } catch (e) {
    return fail(`[unread-count] ${e.message}`, 500);
  }
});

// ==================== 会话列表（按对方聚合）====================
messages.get('/conversations', requireAuth(), async (c) => {
  try {
    const payload = c.get('jwtPayload');
    const uid = payload && payload.sub;
    if (!uid) return fail('需要登录', 401);

    const db = c.env.DB;

    // 取"我和哪些人聊过"：把我发出的和我收到的并起来，取对方 UID
    // 再对每一组取"最后一条消息 + 未读计数（对方发给我的未读）"
    // SQLite 窗口函数在 D1 可能不稳定，这里用子查询 + 代码聚合。
    const pairsRows = await db
      .prepare(
        `SELECT from_uid AS other_uid, to_uid AS me FROM messages WHERE to_uid = ?
         UNION
         SELECT to_uid AS other_uid, from_uid AS me FROM messages WHERE from_uid = ?`
      )
      .bind(uid, uid).all();
    const pairs = (pairsRows.results || []).map(r => r.other_uid);

    const list = [];
    for (const otherUid of pairs) {
      const otherUser = await db.prepare('SELECT nickname, role FROM users WHERE uid = ?').bind(otherUid).first();
      const lastMsg = await db
        .prepare(
          `SELECT * FROM messages
           WHERE (from_uid = ? AND to_uid = ?) OR (from_uid = ? AND to_uid = ?)
           ORDER BY id DESC LIMIT 1`
        )
        .bind(uid, otherUid, otherUid, uid).first();
      const unreadRow = await db
        .prepare('SELECT COUNT(*) AS c FROM messages WHERE from_uid = ? AND to_uid = ? AND is_read = 0')
        .bind(otherUid, uid).first();
      list.push({
        otherUid,
        otherNickname: (otherUser && otherUser.nickname) || `用户${otherUid}`,
        otherRole: (otherUser && otherUser.role) || null,
        lastMessage: lastMsg ? {
          id: lastMsg.id,
          fromUid: lastMsg.from_uid,
          content: lastMsg.content,
          createdAt: lastMsg.created_at,
        } : null,
        unreadCount: unreadRow.c,
      });
    }
    // 按最后一条消息 id 倒序
    list.sort((a, b) => (b.lastMessage && b.lastMessage.id || 0) - (a.lastMessage && a.lastMessage.id || 0));
    return c.json(ok(list));
  } catch (e) {
    return fail(`[conversations] ${e.message}`, 500);
  }
});

// ==================== 对话详情（与某人的所有消息） ====================
messages.get('/conversation/:otherUid', requireAuth(), async (c) => {
  try {
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
  } catch (e) {
    return fail(`[conversation] ${e.message}`, 500);
  }
});

// ==================== 发私信 ====================
messages.post('/', requireAuth(), async (c) => {
  try {
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
    const recipient = await db.prepare('SELECT uid FROM users WHERE uid = ?').bind(toUid).first();
    if (!recipient) return fail('接收方用户不存在', 404);

    const result = await db
      .prepare('INSERT INTO messages (from_uid, to_uid, content) VALUES (?, ?, ?)')
      .bind(fromUid, toUid, content).run();

    const newId = result && result.meta && typeof result.meta.last_row_id === 'number'
      ? result.meta.last_row_id
      : null;
    if (!newId) return fail(`插入失败：result.meta=${JSON.stringify(result && result.meta)}`, 500);

    const created = await db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .bind(newId).first();

    return c.json(ok(mapMsgRow(created)), 201);
  } catch (e) {
    // 同时打印到 Worker 日志 + 返回前端显示，双向可查
    console.error('[messages POST] 500 异常：', e);
    return fail(`[send] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 显式标某对话已读（备用，打开对话时其实会自动标）====================
messages.post('/read/:otherUid', requireAuth(), async (c) => {
  try {
    const payload = c.get('jwtPayload');
    const uid = payload && payload.sub;
    if (!uid) return fail('需要登录', 401);
    const otherUid = c.req.param('otherUid');
    if (!/^\d{8}$/.test(otherUid)) return fail('对方 UID 格式无效');

    await c.env.DB
      .prepare('UPDATE messages SET is_read = 1 WHERE from_uid = ? AND to_uid = ? AND is_read = 0')
      .bind(otherUid, uid).run();

    return c.json(ok({ read: true }));
  } catch (e) {
    return fail(`[mark-read] ${e.message}`, 500);
  }
});

export default messages;
