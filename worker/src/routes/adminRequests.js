/**
 * 管理员协助申请路由
 * 角色分层：
 *   ops_admin (运维管理员，UID 00000001)  — 拥有最高权限，可审批 + 执行
 *   admin (协助管理员，UID 26120001/2..) — 仅可提交申请，不能直接删/禁
 *
 * 申请类型 type:
 *   delete_post    删除帖子    target_id = posts.id
 *   delete_comment 删除评论    target_id = comments.id
 *   ban_user       封禁用户    target_id = users.uid
 *   ban_guild      封禁公会    target_id = guilds.id
 *
 * 公开路径：
 *   POST /api/admin-requests                  创建申请（admin 或 ops_admin）
 *   GET  /api/admin-requests/mine             我提交的申请（待通过 + 历史 分开两个接口调用）
 *   GET  /api/admin-requests/pending          ops_admin 待审批列表
 *   GET  /api/admin-requests/history          所有已处理的历史申请（含 approved/rejected）
 *   POST /api/admin-requests/:id/approve      ops_admin 审批通过（同时执行目标动作）
 *   POST /api/admin-requests/:id/reject       ops_admin 审批拒绝
 */

import { Hono } from 'hono';
import { requireAnyAdmin, requireOpsAdmin, isOpsAdmin } from '../utils/auth.js';

const adminRequests = new Hono();

const ok = (data, meta) => ({ success: true, data, ...(meta ? { meta } : {}) });
const fail = (msg, code = 400) => ({ success: false, message: msg });

const VALID_TYPES = new Set(['delete_post', 'delete_comment', 'ban_user', 'ban_guild']);
const TYPE_LABEL = {
  delete_post: '删除帖子',
  delete_comment: '删除评论',
  ban_user: '封禁用户',
  ban_guild: '封禁公会',
};

function mapRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    type: r.type,
    typeLabel: TYPE_LABEL[r.type] || r.type,
    targetId: r.target_id,
    targetSnapshot: r.target_snapshot || '',
    reason: r.reason || '',
    requesterUid: r.requester_uid,
    requesterNickname: r.requester_nickname || '',
    status: r.status,
    reviewerUid: r.reviewer_uid || null,
    reviewerNote: r.reviewer_note || '',
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at || null,
  };
}

// ---------- 1. 创建申请（admin / ops_admin 都能提交） ----------
adminRequests.post('/', requireAnyAdmin(), async (c) => {
  try {
    const payload = c.get('jwtPayload');
    const uid = payload.sub;
    const db = c.env.DB;

    const body = await c.req.json().catch(() => ({}));
    const type = body.type;
    const targetId = (body.targetId || body.target_id || '').toString().trim();
    const reason = (body.reason || '').toString().trim().slice(0, 500);

    if (!VALID_TYPES.has(type)) return c.json(fail('非法申请类型，仅支持：delete_post / delete_comment / ban_user / ban_guild'), 400);
    if (!targetId) return c.json(fail('请输入目标编号/UID/ID'), 400);
    if (!reason) return c.json(fail('请输入申请理由'), 400);

    // 校验目标存在，并生成快照
    let targetSnapshot = '';
    let targetExists = false;
    switch (type) {
      case 'delete_post': {
        const r = await db.prepare('SELECT id, title, author_uid, author_nickname FROM posts WHERE id = ? AND is_hidden = 0').bind(targetId).first();
        if (r) {
          targetExists = true;
          targetSnapshot = `帖子 #${r.id}｜${r.title}｜作者 ${r.author_nickname || r.author_uid}`;
        }
        break;
      }
      case 'delete_comment': {
        const r = await db.prepare(`SELECT c.id, c.content, c.author_uid, u.nickname AS author_nickname, p.id AS post_id, p.title AS post_title
          FROM comments c JOIN users u ON u.uid = c.author_uid LEFT JOIN posts p ON p.id = c.post_id
          WHERE c.id = ?`).bind(targetId).first();
        if (r) {
          targetExists = true;
          const snippet = (r.content || '').slice(0, 20).replace(/\s+/g, ' ');
          targetSnapshot = `评论 #${r.id}｜作者 ${r.author_nickname}｜内容: ${snippet}｜所属帖 #${r.post_id || '-'} ${r.post_title || ''}`;
        }
        break;
      }
      case 'ban_user': {
        const r = await db.prepare('SELECT uid, nickname, role FROM users WHERE uid = ?').bind(targetId).first();
        if (r) {
          targetExists = true;
          if (isOpsAdmin(r.role)) return c.json(fail('不允许申请封禁运维管理员'), 400);
          targetSnapshot = `用户 ${r.uid}｜昵称 ${r.nickname}｜角色 ${r.role}`;
        }
        break;
      }
      case 'ban_guild': {
        const r = await db.prepare('SELECT id, name, founder_uid, status FROM guilds WHERE id = ?').bind(targetId).first();
        if (r) {
          targetExists = true;
          targetSnapshot = `公会 #${r.id}｜名称 ${r.name}｜状态 ${r.status}｜创始者 ${r.founder_uid}`;
        }
        break;
      }
    }
    if (!targetExists) return c.json(fail(`未找到对应的${TYPE_LABEL[type]}目标，请确认编号/UID`), 404);

    // 防止重复：同一人对同一个 type+target 的 pending 申请，不再重复
    const dup = await db
      .prepare(`SELECT id FROM admin_requests WHERE type = ? AND target_id = ? AND requester_uid = ? AND status = 'pending'`)
      .bind(type, targetId, uid).first();
    if (dup) return c.json(fail('你已有同一条待审批申请，请等待运维管理员处理'), 400);

    const meNick = await db.prepare('SELECT nickname FROM users WHERE uid = ?').bind(uid).first();
    const result = await db
      .prepare(`INSERT INTO admin_requests (type, target_id, target_snapshot, reason, requester_uid, requester_nickname, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`)
      .bind(type, targetId, targetSnapshot, reason, uid, meNick && meNick.nickname || '')
      .run();

    const inserted = await db.prepare('SELECT * FROM admin_requests WHERE id = ?').bind(Number(result.lastRowId || result.meta && result.meta.last_row_id)).first();
    return c.json(ok(mapRow(inserted)), 201);
  } catch (e) {
    return c.json(fail(`[adminRequests create] ${e.name}: ${e.message}`, 500), 500);
  }
});

// ---------- 2. 我提交的申请列表（按状态返回 pending 或 历史） ----------
adminRequests.get('/mine', requireAnyAdmin(), async (c) => {
  try {
    const payload = c.get('jwtPayload');
    const db = c.env.DB;
    const rows = await db.prepare(`SELECT * FROM admin_requests WHERE requester_uid = ? ORDER BY id DESC LIMIT 200`)
      .bind(payload.sub).all();
    return c.json(ok((rows.results || []).map(mapRow)));
  } catch (e) {
    return c.json(fail(`[adminRequests mine] ${e.message}`, 500), 500);
  }
});

// ---------- 3. ops_admin 待审批列表 ----------
adminRequests.get('/pending', requireOpsAdmin(), async (c) => {
  try {
    const rows = await c.env.DB.prepare(`SELECT * FROM admin_requests WHERE status = 'pending' ORDER BY id DESC LIMIT 300`).all();
    return c.json(ok((rows.results || []).map(mapRow)));
  } catch (e) {
    return c.json(fail(`[adminRequests pending] ${e.message}`, 500), 500);
  }
});

// ---------- 4. 所有已处理历史（含 approved/rejected，ops_admin 看全部，admin 仅看自己提交的） ----------
adminRequests.get('/history', requireAnyAdmin(), async (c) => {
  try {
    const payload = c.get('jwtPayload');
    const db = c.env.DB;
    const role = (await db.prepare('SELECT role FROM users WHERE uid = ?').bind(payload.sub).first() || {}).role;
    const rows = isOpsAdmin(role)
      ? await db.prepare(`SELECT * FROM admin_requests WHERE status <> 'pending' ORDER BY id DESC LIMIT 300`).all()
      : await db.prepare(`SELECT * FROM admin_requests WHERE requester_uid = ? AND status <> 'pending' ORDER BY id DESC LIMIT 300`).bind(payload.sub).all();
    return c.json(ok((rows.results || []).map(mapRow)));
  } catch (e) {
    return c.json(fail(`[adminRequests history] ${e.message}`, 500), 500);
  }
});

// ---------- 5. ops_admin 审批：通过（同时执行目标动作） ----------
async function executeAction(db, type, targetId) {
  switch (type) {
    case 'delete_post': {
      await db.prepare(`UPDATE posts SET is_hidden = 1, updated_at = datetime('now') WHERE id = ? AND is_hidden = 0`).bind(targetId).run();
      return true;
    }
    case 'delete_comment': {
      await db.prepare(`DELETE FROM comments WHERE id = ?`).bind(targetId).run();
      return true;
    }
    case 'ban_user': {
      await db.prepare(`UPDATE users SET is_banned = 1, updated_at = datetime('now') WHERE uid = ? AND (is_banned IS NULL OR is_banned = 0)`).bind(targetId).run();
      return true;
    }
    case 'ban_guild': {
      await db.prepare(`UPDATE guilds SET status = 'banned', updated_at = datetime('now') WHERE id = ? AND status <> 'banned'`).bind(targetId).run();
      return true;
    }
  }
  return false;
}

adminRequests.post('/:id/approve', requireOpsAdmin(), async (c) => {
  try {
    const db = c.env.DB;
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json(fail('申请 ID 非法'), 400);

    const body = await c.req.json().catch(() => ({}));
    const note = (body.note || '').toString().trim().slice(0, 300);
    const reviewerUid = c.get('jwtPayload').sub;

    const req = await db.prepare(`SELECT * FROM admin_requests WHERE id = ?`).bind(id).first();
    if (!req) return c.json(fail('申请不存在'), 404);
    if (req.status !== 'pending') return c.json(fail(`该申请已${req.status === 'approved' ? '执行' : '拒绝'}，无需重复操作`), 400);

    // 执行动作
    await executeAction(db, req.type, req.target_id);

    // 标记为 approved
    await db
      .prepare(`UPDATE admin_requests SET status = 'approved', reviewer_uid = ?, reviewer_note = ?, reviewed_at = datetime('now') WHERE id = ?`)
      .bind(reviewerUid, note, id).run();

    const after = await db.prepare(`SELECT * FROM admin_requests WHERE id = ?`).bind(id).first();
    return c.json(ok(mapRow(after)));
  } catch (e) {
    return c.json(fail(`[adminRequests approve] ${e.name}: ${e.message}`, 500), 500);
  }
});

// ---------- 6. ops_admin 审批：拒绝 ----------
adminRequests.post('/:id/reject', requireOpsAdmin(), async (c) => {
  try {
    const db = c.env.DB;
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json(fail('申请 ID 非法'), 400);
    const body = await c.req.json().catch(() => ({}));
    const note = (body.note || '').toString().trim().slice(0, 300);
    const reviewerUid = c.get('jwtPayload').sub;

    const req = await db.prepare(`SELECT * FROM admin_requests WHERE id = ?`).bind(id).first();
    if (!req) return c.json(fail('申请不存在'), 404);
    if (req.status !== 'pending') return c.json(fail('该申请已处理'), 400);

    await db
      .prepare(`UPDATE admin_requests SET status = 'rejected', reviewer_uid = ?, reviewer_note = ?, reviewed_at = datetime('now') WHERE id = ?`)
      .bind(reviewerUid, note, id).run();
    const after = await db.prepare(`SELECT * FROM admin_requests WHERE id = ?`).bind(id).first();
    return c.json(ok(mapRow(after)));
  } catch (e) {
    return c.json(fail(`[adminRequests reject] ${e.message}`, 500), 500);
  }
});

export { adminRequests };
export default adminRequests;
