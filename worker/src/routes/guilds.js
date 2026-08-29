/**
 * 公会系统路由
 *
 *   公开：
 *     GET    /api/guilds                     列出所有 active 公会（含成员数）
 *   登录用户：
 *     GET    /api/guilds/my                  我所在的公会
 *     POST   /api/guilds/create-request      申请新建公会
 *   运维管理员（ops_admin）：
 *     GET    /api/guilds/admin/list                  所有公会（含 banned）
 *     POST   /api/guilds/admin                       管理员直接创建公会
 *     PUT    /api/guilds/admin/:id                   编辑公会
 *     DELETE /api/guilds/admin/:id                   注销公会
 *     POST   /api/guilds/admin/:id/ban               封禁公会
 *     POST   /api/guilds/admin/:id/unban             解封公会
 *     POST   /api/guilds/admin/:id/members           加人到公会
 *     DELETE /api/guilds/admin/:id/members/:uid      从公会踢人
 *     GET    /api/guilds/admin/join-requests         所有加入申请
 *     POST   /api/guilds/admin/join-requests/:id/approve  审批通过
 *     POST   /api/guilds/admin/join-requests/:id/reject   审批拒绝
 *     GET    /api/guilds/admin/create-requests       所有建会申请
 *     POST   /api/guilds/admin/create-requests/:id/approve  审批通过
 *     POST   /api/guilds/admin/create-requests/:id/reject   审批拒绝
 *   精确匹配优先级：所有 /my /create-request /admin/* 必须在 /:id 之前
 *   详情 + 操作（带 :id）：
 *     GET    /api/guilds/:id                     公会详情（含成员列表）
 *     POST   /api/guilds/:id/apply              申请加入公会
 *     POST   /api/guilds/:id/leave              退出公会
 */

import { Hono } from 'hono';
import { jwt } from 'hono/jwt';
import { createMiddleware } from 'hono/factory';

const guilds = new Hono();

// ==================== 工具函数 ====================
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
function requireAdmin() {
  return createMiddleware(async (c, next) => {
    const mw = jwt({ secret: c.env.JWT_SECRET, alg: 'HS256' });
    await mw(c, async () => {});
    const payload = c.get('jwtPayload');
    if (payload && payload.role !== 'ops_admin') {
      return fail('无权限', 403);
    }
    await next();
  });
}
function mapGuildRow(row, memberCount) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    icon: row.icon || '🏰',
    ownerUid: row.owner_uid || null,
    status: row.status || 'active',
    memberCount: memberCount != null ? memberCount : 0,
    createdAt: row.created_at,
  };
}

// ==================== ① 公开：列出所有 active 公会 ====================
guilds.get('/', async (c) => {
  try {
    const db = c.env.DB;
    const rows = await db
      .prepare(
        `SELECT g.*,
                (SELECT COUNT(*) FROM guild_members gm WHERE gm.guild_id = g.id) AS member_count
         FROM guilds g
         WHERE g.status = 'active'
         ORDER BY member_count DESC, g.created_at ASC`
      )
      .all();
    return c.json(ok((rows.results || []).map(r => mapGuildRow(r, r.member_count))));
  } catch (e) {
    return fail(`[guilds list] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== ② 登录用户：我所在的公会 ====================
guilds.get('/my/me', requireAuth(), async (c) => {
  try {
    const payload = c.get('jwtPayload');
    const uid = payload && payload.sub;
    if (!uid) return fail('需要登录', 401);
    const db = c.env.DB;

    const row = await db
      .prepare(
        `SELECT g.*, gm.role AS my_role, gm.joined_at,
                (SELECT COUNT(*) FROM guild_members gm2 WHERE gm2.guild_id = g.id) AS member_count
         FROM guild_members gm
         JOIN guilds g ON g.id = gm.guild_id
         WHERE gm.uid = ?`
      )
      .bind(uid)
      .first();

    if (!row) return c.json(ok(null));
    return c.json(ok({
      guild: mapGuildRow(row, row.member_count),
      myRole: row.my_role,
      joinedAt: row.joined_at,
    }));
  } catch (e) {
    return fail(`[my guild] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== ③ 登录用户：申请新建公会 ====================
guilds.post('/create-request', requireAuth(), async (c) => {
  try {
    const payload = c.get('jwtPayload');
    const uid = payload && payload.sub;
    if (!uid) return fail('需要登录', 401);

    let body;
    try { body = await c.req.json(); } catch { return fail('请求体必须是合法 JSON'); }
    const name = (body.name || '').trim().slice(0, 30);
    const description = (body.description || '').trim().slice(0, 300) || null;
    const icon = (body.icon || '🏰').trim().slice(0, 4) || '🏰';
    const reason = (body.reason || '').trim().slice(0, 500) || null;

    if (!name) return fail('公会名称不能为空');

    const db = c.env.DB;

    const alreadyIn = await db.prepare('SELECT uid FROM guild_members WHERE uid = ?').bind(uid).first();
    if (alreadyIn) return fail('您已加入公会，不能再申请创建新公会');

    const pending = await db
      .prepare("SELECT id FROM guild_create_requests WHERE requester_uid = ? AND status = 'pending'")
      .bind(uid)
      .first();
    if (pending) return fail('您已有待审批的建会申请，请等待');

    const nameExists = await db.prepare('SELECT id FROM guilds WHERE name = ?').bind(name).first();
    if (nameExists) return fail('该公会名称已存在');

    const result = await db
      .prepare('INSERT INTO guild_create_requests (requester_uid, name, description, icon, reason, status) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(uid, name, description, icon, reason, 'pending')
      .run();

    return c.json(ok({ id: result.meta.last_row_id, status: 'pending' }));
  } catch (e) {
    return fail(`[guild create request] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== ④ 运维管理员：所有公会 ====================
guilds.get('/admin/list', requireAdmin(), async (c) => {
  try {
    const db = c.env.DB;
    const rows = await db
      .prepare(
        `SELECT g.*,
                (SELECT COUNT(*) FROM guild_members gm WHERE gm.guild_id = g.id) AS member_count,
                owner.nickname AS owner_nickname
         FROM guilds g
         LEFT JOIN users owner ON owner.uid = g.owner_uid
         ORDER BY g.status ASC, member_count DESC`
      )
      .all();
    return c.json(ok((rows.results || []).map(r => ({
      ...mapGuildRow(r, r.member_count),
      ownerNickname: r.owner_nickname || null,
    }))));
  } catch (e) {
    return fail(`[admin guilds list] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 运维管理员：直接创建公会 ====================
guilds.post('/admin', requireAdmin(), async (c) => {
  try {
    let body;
    try { body = await c.req.json(); } catch { return fail('请求体必须是合法 JSON'); }
    const name = (body.name || '').trim().slice(0, 30);
    const description = (body.description || '').trim().slice(0, 300) || null;
    const icon = (body.icon || '🏰').trim().slice(0, 4) || '🏰';
    const ownerUid = (body.ownerUid || '').trim() || null;

    if (!name) return fail('公会名称不能为空');

    const db = c.env.DB;
    const nameExists = await db.prepare('SELECT id FROM guilds WHERE name = ?').bind(name).first();
    if (nameExists) return fail('该公会名称已存在');

    const result = await db
      .prepare('INSERT INTO guilds (name, description, icon, owner_uid, status) VALUES (?, ?, ?, ?, ?)')
      .bind(name, description, icon, ownerUid, 'active')
      .run();
    const guildId = result.meta.last_row_id;

    if (ownerUid) {
      try {
        await db.prepare('INSERT OR IGNORE INTO guild_members (guild_id, uid, role) VALUES (?, ?, ?)')
          .bind(guildId, ownerUid, 'owner').run();
      } catch {}
    }

    const row = await db.prepare('SELECT * FROM guilds WHERE id = ?').bind(guildId).first();
    return c.json(ok(mapGuildRow(row, 0)), 201);
  } catch (e) {
    return fail(`[admin create guild] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 运维管理员：编辑公会 ====================
guilds.put('/admin/:id', requireAdmin(), async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return fail('公会 ID 无效');
    let body;
    try { body = await c.req.json(); } catch { return fail('请求体必须是合法 JSON'); }

    const db = c.env.DB;
    const guild = await db.prepare('SELECT id FROM guilds WHERE id = ?').bind(id).first();
    if (!guild) return fail('公会不存在', 404);

    const updates = [];
    const args = [];
    if (body.name != null) {
      const name = String(body.name).trim().slice(0, 30);
      if (!name) return fail('公会名称不能为空');
      const dup = await db.prepare('SELECT id FROM guilds WHERE name = ? AND id != ?').bind(name, id).first();
      if (dup) return fail('该公会名称已存在');
      updates.push('name = ?'); args.push(name);
    }
    if (body.description != null) {
      updates.push('description = ?'); args.push(String(body.description).trim().slice(0, 300) || null);
    }
    if (body.icon != null) {
      updates.push('icon = ?'); args.push(String(body.icon).trim().slice(0, 4) || '🏰');
    }
    if (updates.length === 0) return fail('没有要更新的字段');
    args.push(id);

    await db.prepare(`UPDATE guilds SET ${updates.join(', ')} WHERE id = ?`).bind(...args).run();
    const row = await db
      .prepare(`SELECT g.*, (SELECT COUNT(*) FROM guild_members gm WHERE gm.guild_id = g.id) AS member_count FROM guilds g WHERE g.id = ?`)
      .bind(id).first();
    return c.json(ok(mapGuildRow(row, row.member_count)));
  } catch (e) {
    return fail(`[admin edit guild] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 运维管理员：注销公会 ====================
guilds.delete('/admin/:id', requireAdmin(), async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return fail('公会 ID 无效');
    const db = c.env.DB;
    const guild = await db.prepare('SELECT id, name FROM guilds WHERE id = ?').bind(id).first();
    if (!guild) return fail('公会不存在', 404);

    const stmts = [
      db.prepare('DELETE FROM guild_join_requests WHERE guild_id = ?').bind(id),
      db.prepare('DELETE FROM guild_members WHERE guild_id = ?').bind(id),
      db.prepare('DELETE FROM guilds WHERE id = ?').bind(id),
    ];
    await db.batch(stmts);

    return c.json(ok({ id, deleted: true }));
  } catch (e) {
    return fail(`[admin delete guild] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 运维管理员：封禁公会 ====================
guilds.post('/admin/:id/ban', requireAdmin(), async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return fail('公会 ID 无效');
    const db = c.env.DB;
    const guild = await db.prepare('SELECT id FROM guilds WHERE id = ?').bind(id).first();
    if (!guild) return fail('公会不存在', 404);
    await db.prepare("UPDATE guilds SET status = 'banned' WHERE id = ?").bind(id).run();
    return c.json(ok({ id, status: 'banned' }));
  } catch (e) {
    return fail(`[admin ban guild] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 运维管理员：解封公会 ====================
guilds.post('/admin/:id/unban', requireAdmin(), async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return fail('公会 ID 无效');
    const db = c.env.DB;
    const guild = await db.prepare('SELECT id FROM guilds WHERE id = ?').bind(id).first();
    if (!guild) return fail('公会不存在', 404);
    await db.prepare("UPDATE guilds SET status = 'active' WHERE id = ?").bind(id).run();
    return c.json(ok({ id, status: 'active' }));
  } catch (e) {
    return fail(`[admin unban guild] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 运维管理员：加人到公会 ====================
guilds.post('/admin/:id/members', requireAdmin(), async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return fail('公会 ID 无效');
    let body;
    try { body = await c.req.json(); } catch { return fail('请求体必须是合法 JSON'); }
    const uid = (body.uid || '').trim();
    const role = (body.role || 'member').trim();
    if (!uid) return fail('缺少 uid');
    if (!['owner', 'admin', 'member'].includes(role)) return fail('role 必须是 owner/admin/member');

    const db = c.env.DB;
    const guild = await db.prepare('SELECT id, status FROM guilds WHERE id = ?').bind(id).first();
    if (!guild) return fail('公会不存在', 404);
    if (guild.status === 'banned') return fail('公会已被封禁');

    const user = await db.prepare('SELECT uid FROM users WHERE uid = ?').bind(uid).first();
    if (!user) return fail('用户不存在', 404);

    const alreadyIn = await db.prepare('SELECT guild_id FROM guild_members WHERE uid = ?').bind(uid).first();
    if (alreadyIn && alreadyIn.guild_id !== id) return fail('该用户已在其他公会，请先让他退出');

    await db.prepare('INSERT OR REPLACE INTO guild_members (guild_id, uid, role) VALUES (?, ?, ?)')
      .bind(id, uid, role).run();

    return c.json(ok({ guildId: id, uid, role }));
  } catch (e) {
    return fail(`[admin add member] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 运维管理员：从公会踢人 ====================
guilds.delete('/admin/:id/members/:uid', requireAdmin(), async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    const uid = (c.req.param('uid') || '').trim();
    if (!Number.isFinite(id) || id <= 0) return fail('公会 ID 无效');
    if (!uid) return fail('缺少 uid');
    const db = c.env.DB;
    const guild = await db.prepare('SELECT id FROM guilds WHERE id = ?').bind(id).first();
    if (!guild) return fail('公会不存在', 404);
    const member = await db.prepare('SELECT role FROM guild_members WHERE guild_id = ? AND uid = ?').bind(id, uid).first();
    if (!member) return fail('该用户不在公会中', 404);
    if (member.role === 'owner') return fail('不能踢出创始者，请先转让或注销公会');

    await db.prepare('DELETE FROM guild_members WHERE guild_id = ? AND uid = ?').bind(id, uid).run();
    return c.json(ok({ kicked: true, uid }));
  } catch (e) {
    return fail(`[admin remove member] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 运维管理员：所有加入申请 ====================
guilds.get('/admin/join-requests', requireAdmin(), async (c) => {
  try {
    const db = c.env.DB;
    const rows = await db
      .prepare(
        `SELECT r.*,
                g.name AS guild_name, g.id AS guild_id,
                u.nickname AS applicant_nickname, u.uid AS applicant_uid
         FROM guild_join_requests r
         JOIN guilds g ON g.id = r.guild_id
         JOIN users u ON u.uid = r.uid
         ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, r.created_at DESC
         LIMIT 500`
      )
      .all();
    return c.json(ok((rows.results || []).map(r => ({
      id: r.id,
      guildId: r.guild_id,
      guildName: r.guild_name,
      uid: r.applicant_uid,
      applicantNickname: r.applicant_nickname || null,
      reason: r.reason || '',
      status: r.status,
      reviewedBy: r.reviewed_by || null,
      reviewedAt: r.reviewed_at || null,
      createdAt: r.created_at,
    }))));
  } catch (e) {
    return fail(`[admin join requests] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 运维管理员：审批加入申请 ====================
async function reviewJoinRequest(c, approve) {
  try {
    const payload = c.get('jwtPayload');
    const reviewerUid = payload && payload.sub;
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return fail('申请 ID 无效');

    const db = c.env.DB;
    const req = await db.prepare('SELECT * FROM guild_join_requests WHERE id = ?').bind(id).first();
    if (!req) return fail('申请不存在', 404);
    if (req.status !== 'pending') return fail('该申请已处理', 400);

    await db.prepare(
      "UPDATE guild_join_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?"
    ).bind(approve ? 'approved' : 'rejected', reviewerUid, id).run();

    if (approve) {
      const guild = await db.prepare('SELECT status FROM guilds WHERE id = ?').bind(req.guild_id).first();
      if (!guild || guild.status === 'banned') return fail('公会不可用');
      const alreadyIn = await db.prepare('SELECT guild_id FROM guild_members WHERE uid = ?').bind(req.uid).first();
      if (!alreadyIn) {
        await db.prepare('INSERT INTO guild_members (guild_id, uid, role) VALUES (?, ?, ?)')
          .bind(req.guild_id, req.uid, 'member').run();
      }
    }

    return c.json(ok({ id, approved: approve }));
  } catch (e) {
    return fail(`[review join] ${e.name}: ${e.message}`, 500);
  }
}
guilds.post('/admin/join-requests/:id/approve', requireAdmin(), (c) => reviewJoinRequest(c, true));
guilds.post('/admin/join-requests/:id/reject', requireAdmin(), (c) => reviewJoinRequest(c, false));

// ==================== 运维管理员：所有建会申请 ====================
guilds.get('/admin/create-requests', requireAdmin(), async (c) => {
  try {
    const db = c.env.DB;
    const rows = await db
      .prepare(
        `SELECT r.*, u.nickname AS applicant_nickname
         FROM guild_create_requests r
         JOIN users u ON u.uid = r.requester_uid
         ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, r.created_at DESC
         LIMIT 500`
      )
      .all();
    return c.json(ok((rows.results || []).map(r => ({
      id: r.id,
      requesterUid: r.requester_uid,
      applicantNickname: r.applicant_nickname || null,
      name: r.name,
      description: r.description || '',
      icon: r.icon || '🏰',
      reason: r.reason || '',
      status: r.status,
      reviewedBy: r.reviewed_by || null,
      reviewedAt: r.reviewed_at || null,
      createdAt: r.created_at,
    }))));
  } catch (e) {
    return fail(`[admin create requests] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 运维管理员：审批建会申请 ====================
async function reviewCreateRequest(c, approve) {
  try {
    const payload = c.get('jwtPayload');
    const reviewerUid = payload && payload.sub;
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return fail('申请 ID 无效');

    const db = c.env.DB;
    const req = await db.prepare('SELECT * FROM guild_create_requests WHERE id = ?').bind(id).first();
    if (!req) return fail('申请不存在', 404);
    if (req.status !== 'pending') return fail('该申请已处理', 400);

    if (approve) {
      const exists = await db.prepare('SELECT id FROM guilds WHERE name = ?').bind(req.name).first();
      if (exists) {
        await db.prepare(
          "UPDATE guild_create_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), reason = '名称冲突自动驳回' WHERE id = ?"
        ).bind(reviewerUid, id).run();
        return fail('公会名称已存在，自动驳回');
      }

      const alreadyIn = await db.prepare('SELECT guild_id FROM guild_members WHERE uid = ?').bind(req.requester_uid).first();
      if (alreadyIn) {
        await db.prepare(
          "UPDATE guild_create_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), reason = '申请人已在其他公会，自动驳回' WHERE id = ?"
        ).bind(reviewerUid, id).run();
        return fail('申请人已在其他公会');
      }

      const result = await db
        .prepare('INSERT INTO guilds (name, description, icon, owner_uid, status) VALUES (?, ?, ?, ?, ?)')
        .bind(req.name, req.description, req.icon, req.requester_uid, 'active')
        .run();
      const guildId = result.meta.last_row_id;

      await db.prepare('INSERT INTO guild_members (guild_id, uid, role) VALUES (?, ?, ?)')
        .bind(guildId, req.requester_uid, 'owner').run();

      await db.prepare(
        "UPDATE guild_create_requests SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?"
      ).bind(reviewerUid, id).run();

      return c.json(ok({ id, guildId, guildName: req.name }));
    } else {
      await db.prepare(
        "UPDATE guild_create_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?"
      ).bind(reviewerUid, id).run();
      return c.json(ok({ id, approved: false }));
    }
  } catch (e) {
    return fail(`[review create] ${e.name}: ${e.message}`, 500);
  }
}
guilds.post('/admin/create-requests/:id/approve', requireAdmin(), (c) => reviewCreateRequest(c, true));
guilds.post('/admin/create-requests/:id/reject', requireAdmin(), (c) => reviewCreateRequest(c, false));

// ==================== ⑤ 公开：公会详情（/:id 必须排在所有精确路由之后！） ====================
guilds.get('/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return fail('公会 ID 无效');
    const db = c.env.DB;

    const row = await db
      .prepare(
        `SELECT g.*,
                (SELECT COUNT(*) FROM guild_members gm WHERE gm.guild_id = g.id) AS member_count
         FROM guilds g WHERE g.id = ?`
      )
      .bind(id)
      .first();
    if (!row) return fail('公会不存在', 404);

    const members = await db
      .prepare(
        `SELECT gm.uid, gm.role, gm.joined_at,
                u.nickname, u.avatar_url
         FROM guild_members gm
         LEFT JOIN users u ON u.uid = gm.uid
         WHERE gm.guild_id = ?
         ORDER BY CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, gm.joined_at ASC
         LIMIT 500`
      )
      .bind(id)
      .all();

    return c.json(ok({
      ...mapGuildRow(row, row.member_count),
      members: (members.results || []).map(m => ({
        uid: m.uid,
        nickname: m.nickname || null,
        avatarUrl: m.avatar_url || null,
        role: m.role,
        joinedAt: m.joined_at,
      })),
    }));
  } catch (e) {
    return fail(`[guild detail] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 登录用户：申请加入公会 ====================
guilds.post('/:id/apply', requireAuth(), async (c) => {
  try {
    const payload = c.get('jwtPayload');
    const uid = payload && payload.sub;
    if (!uid) return fail('需要登录', 401);

    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return fail('公会 ID 无效');

    let body;
    try { body = await c.req.json(); } catch { body = {}; }
    const reason = (body.reason || '').trim().slice(0, 500) || null;

    const db = c.env.DB;

    const guild = await db.prepare('SELECT id, name, status FROM guilds WHERE id = ?').bind(id).first();
    if (!guild) return fail('公会不存在', 404);
    if (guild.status === 'banned') return fail('该公会已被封禁，无法申请', 403);

    const alreadyIn = await db.prepare('SELECT uid FROM guild_members WHERE uid = ?').bind(uid).first();
    if (alreadyIn) return fail('您已加入公会，请先退出当前公会');

    const pending = await db
      .prepare(`SELECT id, status FROM guild_join_requests WHERE guild_id = ? AND uid = ? AND status IN ('pending','approved')`)
      .bind(id, uid)
      .first();
    if (pending && pending.status === 'pending') return fail('您已提交过申请，请等待审批');
    if (pending && pending.status === 'approved') return fail('您的申请已通过，请联系管理员或等待同步');

    const result = await db
      .prepare('INSERT INTO guild_join_requests (guild_id, uid, reason, status) VALUES (?, ?, ?, ?)')
      .bind(id, uid, reason, 'pending')
      .run();

    return c.json(ok({ id: result.meta.last_row_id, guildId: id, status: 'pending' }));
  } catch (e) {
    return fail(`[guild apply] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 登录用户：退出公会 ====================
guilds.post('/:id/leave', requireAuth(), async (c) => {
  try {
    const payload = c.get('jwtPayload');
    const uid = payload && payload.sub;
    if (!uid) return fail('需要登录', 401);

    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return fail('公会 ID 无效');

    const db = c.env.DB;
    const member = await db.prepare('SELECT role FROM guild_members WHERE guild_id = ? AND uid = ?').bind(id, uid).first();
    if (!member) return fail('您不是该公会成员', 400);
    if (member.role === 'owner') return fail('公会创始者不能直接退出，请先注销公会或转让管理权');

    await db.prepare('DELETE FROM guild_members WHERE guild_id = ? AND uid = ?').bind(id, uid).run();
    return c.json(ok({ left: true }));
  } catch (e) {
    return fail(`[guild leave] ${e.name}: ${e.message}`, 500);
  }
});

export default guilds;
