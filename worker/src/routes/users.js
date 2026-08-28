/**
 * 公开用户资料路由：
 *   GET /api/users/:uid  → 任意用户的公开主页资料（昵称/简介/头像/角色/注册时间/帖子数）
 *
 * 故意不返回敏感字段：password_hash / is_banned / last_login_at / updated_at 等。
 */

import { Hono } from 'hono';

const users = new Hono();

function ok(data, extra) {
  return { success: true, data, ...(extra || {}) };
}
function fail(message, status = 400) {
  return new Response(JSON.stringify({ success: false, message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

users.get('/:uid', async (c) => {
  try {
    const uid = (c.req.param('uid') || '').trim();
    if (!/^\d{1,8}$/.test(uid)) return fail('UID 无效');
    const db = c.env.DB;
    const row = await db
      .prepare(
        `SELECT u.uid, u.nickname, u.bio, u.avatar_url, u.role, u.created_at, u.updated_at,
                (SELECT COUNT(*) FROM posts p WHERE p.author_uid = u.uid AND p.is_hidden = 0) AS post_count
         FROM users u
         WHERE u.uid = ?`
      )
      .bind(uid)
      .first();
    if (!row) return fail('用户不存在', 404);
    return c.json(ok({
      uid: row.uid,
      nickname: row.nickname,
      bio: row.bio || '',
      avatarUrl: row.avatar_url || null,
      role: row.role || 'member',
      createdAt: row.created_at,
      updatedAt: row.updated_at || null,
      postCount: row.post_count || 0,
    }));
  } catch (e) {
    return fail(`[user profile] ${e.name}: ${e.message}`, 500);
  }
});

export default users;
