/**
 * 公开用户资料路由：
 *   GET /api/users/:uid      → 任意用户的公开主页资料（昵称/简介/头像/角色/注册时间/帖子数）
 *   GET /api/users/search?q= → 按 UID（精确）或昵称（模糊包含）搜索用户
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

// ==================== 用户搜索：按 UID 精确 或 昵称模糊 ====================
// GET /api/users/search?q=keyword
users.get('/search', async (c) => {
  try {
    const q = (c.req.query('q') || '').trim();
    if (!q) return fail('请输入搜索关键字');
    if (q.length > 50) return fail('搜索关键字过长');

    const db = c.env.DB;
    let results = [];

    // 如果全部是数字（且长度 <= 8），按 UID 精确匹配
    if (/^\d{1,8}$/.test(q)) {
      const row = await db
        .prepare(
          `SELECT u.uid, u.nickname, u.bio, u.avatar_url, u.role, u.created_at,
                  (SELECT COUNT(*) FROM posts p WHERE p.author_uid = u.uid AND p.is_hidden = 0) AS post_count
           FROM users u WHERE u.uid = ?`
        )
        .bind(q)
        .first();
      if (row) {
        results.push({
          uid: row.uid,
          nickname: row.nickname,
          bio: row.bio || '',
          avatarUrl: row.avatar_url || null,
          role: row.role || 'member',
          createdAt: row.created_at,
          postCount: row.post_count || 0,
          matchType: 'uid',
        });
      }
    }

    // 同时按昵称模糊匹配（包含关键字，不区分大小写）
    const likePattern = `%${q}%`;
    const rows = await db
      .prepare(
        `SELECT u.uid, u.nickname, u.bio, u.avatar_url, u.role, u.created_at,
                (SELECT COUNT(*) FROM posts p WHERE p.author_uid = u.uid AND p.is_hidden = 0) AS post_count
         FROM users u
         WHERE LOWER(u.nickname) LIKE LOWER(?)
         ORDER BY
           CASE WHEN u.nickname = ? THEN 0 ELSE 1 END,
           u.created_at ASC
         LIMIT 30`
      )
      .bind(likePattern, q)
      .all();

    // 合并去重
    const seen = new Set(results.map(r => r.uid));
    for (const r of rows.results || []) {
      if (seen.has(r.uid)) continue;
      seen.add(r.uid);
      results.push({
        uid: r.uid,
        nickname: r.nickname,
        bio: r.bio || '',
        avatarUrl: r.avatar_url || null,
        role: r.role || 'member',
        createdAt: r.created_at,
        postCount: r.post_count || 0,
        matchType: 'nickname',
      });
    }

    return c.json(ok(results, { total: results.length }));
  } catch (e) {
    return fail(`[user search] ${e.name}: ${e.message}`, 500);
  }
});

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
