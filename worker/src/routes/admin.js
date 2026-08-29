/**
 * 运维管理员面板路由（仅 ops_admin）
 *
 *   GET    /api/admin/users            列出所有已注册账号（含每用户帖子数 + 最后登录 + 封禁状态）
 *   GET    /api/admin/pinned-posts     列出所有置顶帖（按 pin_order 升序）
 *   POST   /api/admin/pin-order        批量调整置顶帖顺序（body: { order: [id1, id2, ...] }）
 *   GET    /api/admin/tags             全量标签及出现次数（不限时间）
 *   POST   /api/admin/users/:uid/ban   封禁账号（危险操作）
 *   POST   /api/admin/users/:uid/unban 解封账号
 *   DELETE /api/admin/users/:uid       注销账号（危险操作，软删/物理删可配置）
 */

import { Hono } from 'hono';
import { jwt } from 'hono/jwt';
import { createMiddleware } from 'hono/factory';

const admin = new Hono();

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
// 运维管理员专属：JWT 通过后再校验角色
function requireAdmin() {
  return createMiddleware(async (c, next) => {
    const mw = jwt({ secret: c.env.JWT_SECRET, alg: 'HS256' });
    await mw(c, async () => {});
    const payload = c.get('jwtPayload');
    const role = payload && payload.role;
    if (role !== 'ops_admin') {
      return fail('只有运维管理员才能访问该面板', 403);
    }
    await next();
  });
}

function parseTags(str) {
  if (!str) return [];
  return String(str).split(',').map(t => t.trim()).filter(Boolean);
}
function mapPostRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    authorUid: row.author_uid,
    authorNickname: row.author_nickname || null,
    category: row.category,
    tags: parseTags(row.tags),
    isPinned: !!row.is_pinned,
    pinOrder: row.pin_order != null ? row.pin_order : 0,
    createdAt: row.created_at,
  };
}

// ==================== 列出所有账号 ====================
admin.get('/users', requireAdmin(), async (c) => {
  try {
    const db = c.env.DB;
    // 左连 posts 统计每用户的帖子数（不含软删）+ 返回 last_login_at / is_banned
    const rows = await db
      .prepare(
        `SELECT u.uid, u.nickname, u.role, u.bio, u.avatar_url, u.created_at,
                u.is_banned, u.last_login_at,
                (SELECT COUNT(*) FROM posts p WHERE p.author_uid = u.uid AND p.is_hidden = 0) AS post_count
         FROM users u
         ORDER BY u.created_at ASC`
      )
      .all();
    const data = (rows.results || []).map(r => ({
      uid: r.uid,
      nickname: r.nickname,
      role: r.role,
      bio: r.bio || '',
      avatarUrl: r.avatar_url || '',
      createdAt: r.created_at,
      isBanned: !!r.is_banned,
      lastLoginAt: r.last_login_at || null,
      postCount: r.post_count || 0,
    }));
    return c.json(ok(data, { total: data.length }));
  } catch (e) {
    return fail(`[admin users] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 封禁账号 ====================
admin.post('/users/:uid/ban', requireAdmin(), async (c) => {
  try {
    const targetUid = (c.req.param('uid') || '').trim();
    const db = c.env.DB;
    const target = await db.prepare('SELECT uid, role FROM users WHERE uid = ?').bind(targetUid).first();
    if (!target) return fail('用户不存在', 404);

    const payload = c.get('jwtPayload');
    const myUid = payload && payload.sub;
    const myRole = payload && payload.role;

    // 保护：不能封禁自己、不能封禁运维管理员
    if (targetUid === myUid) return fail('不能封禁自己', 400);
    if (target.role === 'ops_admin') {
      return fail('运维管理员账号不可被封禁', 403);
    }

    await db.prepare("UPDATE users SET is_banned = 1, updated_at = datetime('now') WHERE uid = ?").bind(targetUid).run();
    return c.json(ok({ uid: targetUid, isBanned: true }));
  } catch (e) {
    return fail(`[admin ban] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 解封账号 ====================
admin.post('/users/:uid/unban', requireAdmin(), async (c) => {
  try {
    const targetUid = (c.req.param('uid') || '').trim();
    const db = c.env.DB;
    const target = await db.prepare('SELECT uid FROM users WHERE uid = ?').bind(targetUid).first();
    if (!target) return fail('用户不存在', 404);

    await db.prepare("UPDATE users SET is_banned = 0, updated_at = datetime('now') WHERE uid = ?").bind(targetUid).run();
    return c.json(ok({ uid: targetUid, isBanned: false }));
  } catch (e) {
    return fail(`[admin unban] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 注销账号（物理删除，连带删帖/评论/私信/点赞/收藏/公告）====================
admin.delete('/users/:uid', requireAdmin(), async (c) => {
  try {
    const targetUid = (c.req.param('uid') || '').trim();
    const db = c.env.DB;
    const target = await db.prepare('SELECT uid, role FROM users WHERE uid = ?').bind(targetUid).first();
    if (!target) return fail('用户不存在', 404);

    const payload = c.get('jwtPayload');
    const myUid = payload && payload.sub;
    const myRole = payload && payload.role;

    // 保护：不能注销自己、不能注销其他运维管理员
    if (targetUid === myUid) return fail('不能注销自己', 400);
    if (target.role === 'ops_admin') {
      return fail('运维管理员账号不可被注销', 403);
    }

    // 物理删除：连带清理所有关联数据
    const stmts = [
      db.prepare('DELETE FROM post_likes WHERE uid = ?').bind(targetUid),
      db.prepare('DELETE FROM favorites WHERE uid = ?').bind(targetUid),
      db.prepare('DELETE FROM messages WHERE from_uid = ? OR to_uid = ?').bind(targetUid, targetUid),
      db.prepare('DELETE FROM announcements_read WHERE uid = ?').bind(targetUid),
      db.prepare('DELETE FROM comments WHERE author_uid = ?').bind(targetUid),
      db.prepare('DELETE FROM posts WHERE author_uid = ?').bind(targetUid),
      db.prepare('DELETE FROM announcements WHERE author_uid = ?').bind(targetUid),
      db.prepare('DELETE FROM users WHERE uid = ?').bind(targetUid),
    ];
    await db.batch(stmts);
    return c.json(ok({ uid: targetUid, deleted: true }));
  } catch (e) {
    return fail(`[admin delete user] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 列出所有置顶帖（按 pin_order 升序）====================
admin.get('/pinned-posts', requireAdmin(), async (c) => {
  try {
    const db = c.env.DB;
    const rows = await db
      .prepare(
        `SELECT p.id, p.title, p.author_uid, p.category, p.tags, p.is_pinned, p.pin_order, p.created_at,
                u.nickname AS author_nickname
         FROM posts p
         LEFT JOIN users u ON u.uid = p.author_uid
         WHERE p.is_pinned = 1 AND p.is_hidden = 0
         ORDER BY p.pin_order ASC, p.created_at ASC`
      )
      .all();
    return c.json(ok((rows.results || []).map(mapPostRow)));
  } catch (e) {
    return fail(`[admin pinned-posts] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 批量调整置顶帖顺序 ====================
// body: { order: [id1, id2, id3, ...] }
// 按数组顺序设置 pin_order = 1, 2, 3...（数组里必须是当前所有置顶帖 id 的某个排列）
admin.post('/pin-order', requireAdmin(), async (c) => {
  try {
    let body;
    try { body = await c.req.json(); } catch { return fail('请求体必须是合法 JSON'); }
    const order = Array.isArray(body.order) ? body.order : null;
    if (!order || order.length === 0) return fail('order 必须是非空 id 数组');

    const db = c.env.DB;
    // 拿当前所有置顶帖 id，校验 order 是否覆盖了全部置顶帖（不多不少）
    const cur = await db.prepare('SELECT id FROM posts WHERE is_pinned = 1 AND is_hidden = 0').all();
    const currentIds = new Set((cur.results || []).map(r => r.id));
    const orderSet = new Set(order);
    if (order.length !== currentIds.size || [...order].some(id => !currentIds.has(id))) {
      return fail('order 数组必须恰好包含当前全部置顶帖的 id');
    }

    // 逐条 UPDATE pin_order = 索引+1；用 batch 保证原子性
    const stmts = order.map((id, idx) =>
      db.prepare("UPDATE posts SET pin_order = ?, updated_at = datetime('now') WHERE id = ? AND is_pinned = 1")
        .bind(idx + 1, id)
    );
    await db.batch(stmts);

    return c.json(ok({ order }));
  } catch (e) {
    return fail(`[admin pin-order] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 全量标签及出现次数（不限时间）====================
admin.get('/tags', requireAdmin(), async (c) => {
  try {
    const db = c.env.DB;
    const rows = await db
      .prepare(
        `SELECT tags FROM posts WHERE is_hidden = 0 AND tags IS NOT NULL AND tags <> ''`
      )
      .all();
    const counter = new Map();
    for (const r of rows.results || []) {
      for (const t of parseTags(r.tags)) {
        const key = t.slice(0, 20);
        if (!key) continue;
        counter.set(key, (counter.get(key) || 0) + 1);
      }
    }
    const data = [...counter.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
    return c.json(ok(data, { total: data.length }));
  } catch (e) {
    return fail(`[admin tags] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 非置顶帖列表（按创建时间倒序，管理员只读展示用）====================
admin.get('/posts', requireAdmin(), async (c) => {
  try {
    const db = c.env.DB;
    const rows = await db
      .prepare(
        `SELECT p.id, p.title, p.author_uid, p.category, p.tags, p.is_pinned, p.pin_order, p.created_at,
                u.nickname AS author_nickname, u.role AS author_role,
                p.view_count, p.like_count, p.comment_count
         FROM posts p
         LEFT JOIN users u ON u.uid = p.author_uid
         WHERE p.is_pinned = 0 AND p.is_hidden = 0
         ORDER BY p.created_at DESC
         LIMIT 500`
      )
      .all();
    return c.json(ok((rows.results || []).map(mapPostRow), {
      total: (rows.results || []).length,
    }));
  } catch (e) {
    return fail(`[admin posts] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 带图片的帖子列表（管理员专用，紧凑预览）====================
admin.get('/posts-with-images', requireAdmin(), async (c) => {
  try {
    const db = c.env.DB;
    // 查出所有有 image_ids 的帖子
    const rows = await db
      .prepare(
        `SELECT p.id, p.title, p.author_uid, p.category, p.tags, p.image_ids, p.created_at,
                u.nickname AS author_nickname
         FROM posts p
         LEFT JOIN users u ON u.uid = p.author_uid
         WHERE p.is_hidden = 0 AND p.image_ids IS NOT NULL AND p.image_ids <> '' AND p.image_ids <> '[]'
         ORDER BY p.created_at DESC
         LIMIT 500`
      )
      .all();

    const data = [];
    for (const r of rows.results || []) {
      // 解析 image_ids JSON，取第一张图的 id 作为缩略图
      let imageIds = [];
      try {
        const parsed = JSON.parse(r.image_ids);
        if (Array.isArray(parsed)) imageIds = parsed.map(Number).filter(n => Number.isFinite(n) && n > 0);
      } catch {}

      // 取第一张图片的元信息（mime_type）用于前端正确显示
      let firstImage = null;
      if (imageIds.length > 0) {
        const img = await db
          .prepare('SELECT id, mime_type, size FROM images WHERE id = ?')
          .bind(imageIds[0])
          .first();
        if (img) firstImage = { id: img.id, mimeType: img.mime_type, size: img.size };
      }

      data.push({
        id: r.id,
        title: r.title,
        authorUid: r.author_uid,
        authorNickname: r.author_nickname || null,
        category: r.category,
        tags: parseTags(r.tags),
        imageIds,
        imageCount: imageIds.length,
        firstImage,
        createdAt: r.created_at,
      });
    }

    return c.json(ok(data, { total: data.length }));
  } catch (e) {
    return fail(`[admin posts-with-images] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 删除帖子（管理员，连带删除图片记录）====================
admin.delete('/posts/:id', requireAdmin(), async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return fail('帖子 ID 无效');

    const db = c.env.DB;
    const post = await db.prepare('SELECT id, author_uid, image_ids FROM posts WHERE id = ?').bind(id).first();
    if (!post) return fail('帖子不存在', 404);

    // 删除关联的图片记录
    if (post.image_ids) {
      try {
        const ids = JSON.parse(post.image_ids);
        if (Array.isArray(ids) && ids.length > 0) {
          const stmts = ids.map(imgId =>
            db.prepare('DELETE FROM images WHERE id = ?').bind(Number(imgId))
          );
          await db.batch(stmts);
        }
      } catch {}
    }

    // 删除帖子及其关联数据
    const stmts = [
      db.prepare('DELETE FROM post_likes WHERE post_id = ?').bind(id),
      db.prepare('DELETE FROM favorites WHERE post_id = ?').bind(id),
      db.prepare('DELETE FROM comments WHERE post_id = ?').bind(id),
      db.prepare('DELETE FROM posts WHERE id = ?').bind(id),
    ];
    await db.batch(stmts);

    return c.json(ok({ id, deleted: true }));
  } catch (e) {
    return fail(`[admin delete post] ${e.name}: ${e.message}`, 500);
  }
});

export default admin;
