/**
 * 帖子相关路由
 *
 * GET    /api/posts              列表（分页、分类、关键字搜索、标签、日期区间）
 * GET    /api/posts/tags/popular 热门标签榜（用于首页搜索条推荐）
 * GET    /api/posts/:id          帖子详情（view_count += 1，附带作者信息 + 当前用户点赞/收藏）
 * POST   /api/posts              发新帖（JWT，支持多标签 tags 数组，不传 category 则默认 general）
 * DELETE /api/posts/:id          删帖（JWT，作者本人 或 ops_admin（运维管理员））
 */

import { Hono } from 'hono';
import { jwt } from 'hono/jwt';
import { createMiddleware } from 'hono/factory';
import { EXP, addExp, addBrowseExp } from '../utils/exp.js';

const posts = new Hono();

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

// 分区白名单（必须与前端 js/api.js CATEGORIES.key 完全一致，避免映射不一致）
const ALLOWED_CATEGORIES_KEYS = ['general', 'study', 'club', 'life', 'meta'];
const ADMIN_ROLES = new Set(['ops_admin']);

// 目前 tags 在 DB 里存的是逗号分隔字符串（a,b,c），前后端都按数组来用
function parseTags(str) {
  if (!str) return [];
  return String(str).split(',').map(t => t.trim()).filter(Boolean);
}

function mapPostRow(row) {
  if (!row) return null;
  // image_ids 是 JSON 数组字符串，解析成数字数组
  let imageIds = [];
  if (row.image_ids) {
    try {
      const parsed = JSON.parse(row.image_ids);
      if (Array.isArray(parsed)) imageIds = parsed.map(Number).filter(n => Number.isFinite(n) && n > 0);
    } catch {}
  }
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    authorUid: row.author_uid,
    authorNickname: row.author_nickname || null,
    authorRole: row.author_role || null,
    authorAvatarUrl: row.author_avatar_url || null,
    authorUpdatedAt: row.author_updated_at || null,
    category: row.category,
    tags: parseTags(row.tags),
    imageIds,
    viewCount: row.view_count,
    likeCount: row.like_count,
    commentCount: row.comment_count,
    isPinned: !!row.is_pinned,
    pinOrder: row.pin_order != null ? row.pin_order : 0,
    isHidden: !!row.is_hidden,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 详情页才有的额外字段：当前用户是否点赞/收藏
    isLiked: !!row.is_liked,
    isFavorited: !!row.is_favorited,
  };
}

// ==================== 列表（公开，支持搜索 / 标签 / 日期 / 分类 混合筛选）====================
posts.get('/', async (c) => {
  try {
    const { searchParams } = new URL(c.req.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));
    const category = searchParams.get('category');
    const q = (searchParams.get('q') || '').trim();         // 关键字：搜 title + content
    const tag = (searchParams.get('tag') || '').trim();     // 单标签：匹配是否包含在 tags 逗号串里
    const dateFrom = (searchParams.get('date_from') || '').trim(); // YYYY-MM-DD
    const dateTo = (searchParams.get('date_to') || '').trim();     // YYYY-MM-DD
    const sortBy = searchParams.get('sort_by') || 'latest'; // latest | likes | comments | views
    const author = (searchParams.get('author') || '').trim(); // 按作者 UID 过滤（用户主页用）
    const region = (searchParams.get('region') || '').trim();   // 区域前缀：2611/2612/2621/2622（按作者 UID 前缀过滤分区）
    const offset = (page - 1) * pageSize;

    const db = c.env.DB;
    const whereParts = ['p.is_hidden = 0'];
    const params = [];

    if (category) {
      whereParts.push('p.category = ?');
      params.push(category);
    }
    if (author && /^\d{1,8}$/.test(author)) {
      whereParts.push('p.author_uid = ?');
      params.push(author);
    }
    // 分区过滤：按作者 UID 前缀（2611=广五本部初中部 / 2612=广五本部高中部 / 2621=金碧校区初中部 / 2622=金碧校区高中部）
    if (region && /^26[12][12]$/.test(region)) {
      whereParts.push("CAST(p.author_uid AS TEXT) LIKE ?");
      params.push(`${region}%`);
    }
    if (q) {
      whereParts.push('(p.title LIKE ? OR p.content LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    if (tag) {
      // 多标签筛选：tag 可为逗号分隔的多个标签，AND 语义（帖子需同时包含全部选中标签）
      // 首尾补逗号匹配，避免"数学"误包含进"高等数学"的子串
      const tagList = String(tag).split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean);
      for (const t of tagList) {
        whereParts.push("(',' || p.tags || ',') LIKE ?");
        params.push(`%,${t},%`);
      }
    }
    if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      whereParts.push('DATE(p.created_at) >= DATE(?)');
      params.push(dateFrom);
    }
    if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      whereParts.push('DATE(p.created_at) <= DATE(?)');
      params.push(dateTo);
    }
    const whereSQL = whereParts.join(' AND ');

    const countResult = await db
      .prepare(`SELECT COUNT(*) AS c FROM posts p WHERE ${whereSQL}`)
      .bind(...params)
      .first();
    const total = countResult.c;

    const sortMap = {
      likes:    'p.is_pinned DESC, p.pin_order ASC, p.like_count DESC, p.created_at DESC',
      comments: 'p.is_pinned DESC, p.pin_order ASC, p.comment_count DESC, p.created_at DESC',
      views:    'p.is_pinned DESC, p.pin_order ASC, p.view_count DESC, p.created_at DESC',
    };
    const orderSQL = sortMap[sortBy] || 'p.is_pinned DESC, p.pin_order ASC, p.created_at DESC';

    const rows = await db
      .prepare(
        `SELECT p.*, u.nickname AS author_nickname, u.role AS author_role, u.avatar_url AS author_avatar_url, u.updated_at AS author_updated_at
         FROM posts p
         LEFT JOIN users u ON u.uid = p.author_uid
         WHERE ${whereSQL}
         ORDER BY ${orderSQL}
         LIMIT ? OFFSET ?`
      )
      .bind(...params, pageSize, offset)
      .all();

    return c.json(ok(rows.results.map(mapPostRow), {
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
      appliedFilters: { category: category || null, q: q || null, tag: tag || null, dateFrom: dateFrom || null, dateTo: dateTo || null, sortBy },
    }));
  } catch (e) {
    return fail(`[posts list] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 按月份获取帖子日历数据 ====================
// GET /api/posts/calendar?year=2026&month=8
// 返回该月每天有帖子发过的日期 + 帖子标题列表（不含隐藏帖）
posts.get('/calendar', async (c) => {
  try {
    const year = parseInt(c.req.query('year'), 10);
    const month = parseInt(c.req.query('month'), 10);
    if (!year || !month || month < 1 || month > 12) {
      return fail('请提供有效的 year 和 month 参数');
    }
    const db = c.env.DB;
    // D1 的 datetime('now') 存的是 UTC，substr 取前 7 位得到 "YYYY-MM"
    const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
    const rows = await db
      .prepare(
        `SELECT p.id, p.title, p.author_uid, p.category, p.created_at,
                u.nickname AS author_nickname
         FROM posts p
         LEFT JOIN users u ON u.uid = p.author_uid
         WHERE p.is_hidden = 0 AND substr(p.created_at, 1, 7) = ?
         ORDER BY p.created_at ASC`
      )
      .bind(monthPrefix)
      .all();
    // 按日期分组
    const byDay = {};
    for (const r of rows.results || []) {
      // created_at 格式 "YYYY-MM-DD HH:MM:SS"，取日部分
      const day = (r.created_at || '').slice(8, 10);
      if (!day) continue;
      const dayKey = parseInt(day, 10);
      if (!byDay[dayKey]) byDay[dayKey] = [];
      byDay[dayKey].push({
        id: r.id,
        title: r.title,
        authorUid: r.author_uid,
        authorNickname: r.author_nickname || `用户${r.author_uid}`,
        category: r.category,
        createdAt: r.created_at,
      });
    }
    return c.json(ok(byDay, { year, month, total: (rows.results || []).length }));
  } catch (e) {
    return fail(`[posts calendar] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 热门标签榜（用于首页搜索条 chip 推荐）====================
posts.get('/tags/popular', async (c) => {
  try {
    const db = c.env.DB;
    // 只统计最近 30 天内没被隐藏的帖子，取 TOP 30 标签
    const rows = await db
      .prepare(
        `SELECT p.tags
         FROM posts p
         WHERE p.is_hidden = 0 AND p.tags IS NOT NULL AND p.tags <> ''
           AND DATE(p.created_at) >= DATE('now', '-30 day')
         ORDER BY p.created_at DESC
         LIMIT 1000`
      )
      .all();
    const counter = new Map();
    for (const r of rows.results || []) {
      for (const t of parseTags(r.tags)) {
        const key = t.slice(0, 20); // 限制单个 tag 长度
        if (!key) continue;
        counter.set(key, (counter.get(key) || 0) + 1);
      }
    }
    const top = [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([tag, count]) => ({ tag, count }));

    return c.json(ok({ tags: top }));
  } catch (e) {
    return fail(`[tags popular] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 详情（公开，附带当前用户是否点赞/收藏）====================
posts.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id) || id <= 0) return fail('帖子 ID 无效');

  const db = c.env.DB;

  // 浏览量 +1（用 UPDATE ... RETURNING 直接拿最新数据）
  // SQLite 3.35+ 支持 RETURNING，D1 是 OK 的
  const row = await db
    .prepare(
      `UPDATE posts SET view_count = view_count + 1
       WHERE id = ? AND is_hidden = 0
       RETURNING *, (SELECT nickname FROM users WHERE uid = author_uid) AS author_nickname,
                    (SELECT role FROM users WHERE uid = author_uid) AS author_role,
                    (SELECT avatar_url FROM users WHERE uid = author_uid) AS author_avatar_url,
                    (SELECT updated_at FROM users WHERE uid = author_uid) AS author_updated_at`
    )
    .bind(id)
    .first();
  if (!row) return fail('帖子不存在或已被删除', 404);

  // 查当前用户是否点赞/收藏（没登录就 false）
  let uid = null;
  try {
    // 轻量解析 JWT（不 throw，失败就当未登录）
    const auth = c.req.header('Authorization') || '';
    if (auth.startsWith('Bearer ')) {
      // 先只看 payload 不验签——"我是谁"信任请求头里的 uid；真正写入类接口再走 requireAuth() 强校验
      const parts = auth.slice(7).split('.');
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
          uid = payload.sub;
        } catch {}
      }
    }
  } catch {}

  let isLiked = false;
  let isFavorited = false;
  if (uid) {
    const likeRow = await db.prepare('SELECT 1 FROM post_likes WHERE uid = ? AND post_id = ?').bind(uid, id).first();
    const favRow = await db.prepare('SELECT 1 FROM favorites WHERE uid = ? AND post_id = ?').bind(uid, id).first();
    isLiked = !!likeRow;
    isFavorited = !!favRow;
    // 浏览积分：已登录用户每打开帖子 +1（每日上限 10，跨天重置，见 utils/exp.js addBrowseExp）
    await addBrowseExp(db, uid);
  }

  const result = mapPostRow({ ...row, is_liked: isLiked, is_favorited: isFavorited });
  return c.json(ok(result));
});

// ==================== 发新帖（JWT）====================
posts.post('/', requireAuth(), async (c) => {
  try {
    const payload = c.get('jwtPayload');
    const uid = payload && payload.sub;
    if (!uid) return fail('需要登录', 401);

    const db = c.env.DB;
    const author = await db
      .prepare('SELECT uid, role FROM users WHERE uid = ?')
      .bind(uid)
      .first();
    if (!author) return fail('用户不存在', 401);

    let body;
    try { body = await c.req.json(); } catch { return fail('请求体必须是合法 JSON'); }
    const title = (body.title || '').trim();
    const content = (body.content || '').trim();

    // --- 分区 + 标签并存：先处理 tags（因为 tags 还要兜底 category）---
    // tags：接受 Array<string> 或 "a,b,c" 字符串（方便 curl 测试）；去重 + 最多 5 个；每个 ≤20 字
    const rawTags = Array.isArray(body.tags)
      ? body.tags
      : (typeof body.tags === 'string' ? body.tags.split(/[,，\s]+/) : []);
    const cleanTags = [...new Set(
      rawTags.map(t => String(t).trim()).filter(Boolean).map(t => t.slice(0, 20))
    )].slice(0, 5);
    const tagsStr = cleanTags.join(',');

    // 分区：前端显式选分区优先，不合法再 tags 兜底，仍不合法 → general
    let category = (body.category || '').trim();
    const isAdmin = ADMIN_ROLES.has(String(author.role || ''));

    // 1) 前端传的 category 若不在白名单 → 先清零（等下走 tags 兜底 / general）
    if (!ALLOWED_CATEGORIES_KEYS.includes(category)) {
      category = '';
    }
    // 2) meta 分区仅管理员：前端能传、但非管理员一律拦截 → 403（避免绕过 UI 直接调接口灌水公告）
    if (category === 'meta' && !isAdmin) {
      return fail('只有管理员才能发「公告」分区的帖子', 403);
    }
    // 3) 仍然无合法 category：用 tags 里第一个（若恰好是分区英文 key 则命中）→ 还是空 → general
    if (!category) {
      const picked = cleanTags[0] && ALLOWED_CATEGORIES_KEYS.includes(cleanTags[0].toLowerCase())
        ? cleanTags[0].toLowerCase()
        : null;
      // 保险：tags 兜底也不能给非管理员塞 meta（tag 名叫 meta 的情况虽然罕见）
      if (picked === 'meta' && !isAdmin) {
        category = 'general';
      } else {
        category = picked || 'general';
      }
    }

    if (!title) return fail('标题不能为空');
    if (!content) return fail('内容不能为空');
    if (title.length > 100) return fail('标题不能超过 100 字');
    if (content.length > 2000) return fail('内容不能超过 2000 字');
    if (cleanTags.some(t => /["'\\<>{}]/.test(t))) return fail('标签不能包含特殊字符');

    // 处理图片 ID 列表（最多 9 张）
    let imageIds = [];
    if (Array.isArray(body.imageIds)) {
      imageIds = body.imageIds
        .map(id => parseInt(id, 10))
        .filter(id => Number.isFinite(id) && id > 0)
        .slice(0, 9);
    }

    // 置顶：仅管理员可在发帖时直接置顶；置顶帖自动排到现有置顶队列末尾（pin_order = MAX+1）
    const isPinned = isAdmin && !!body.isPinned;
    let pinOrder = 0;
    if (isPinned) {
      const maxRow = await db.prepare('SELECT COALESCE(MAX(pin_order),0) AS m FROM posts WHERE is_pinned = 1').first();
      pinOrder = (maxRow && maxRow.m ? maxRow.m : 0) + 1;
    }

    const result = await db
      .prepare(`INSERT INTO posts (author_uid, title, content, category, tags, image_ids, is_pinned, pin_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
      .bind(uid, title, content, category, tagsStr, imageIds.length > 0 ? JSON.stringify(imageIds) : null, isPinned ? 1 : 0, pinOrder)
      .run();

    const postId = result && result.meta && typeof result.meta.last_row_id === 'number'
      ? result.meta.last_row_id : null;
    if (!postId) return fail('帖子创建失败（DB 返回空 id）', 500);

    // 发帖积分：作者 +EXP.POST（失败不阻塞主流程）
    await addExp(db, uid, EXP.POST);

    const created = await db
      .prepare(
        `SELECT p.*, u.nickname AS author_nickname, u.role AS author_role
         FROM posts p LEFT JOIN users u ON u.uid = p.author_uid WHERE p.id = ?`
      )
      .bind(postId)
      .first();

    return c.json(ok(mapPostRow(created)), 201);
  } catch (e) {
    return fail(`[posts create] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 编辑帖子（JWT：仅 ops_admin（运维管理员））====================
posts.put('/:id', requireAuth(), async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return fail('帖子 ID 无效');

    const payload = c.get('jwtPayload');
    const uid = payload && payload.sub;
    const role = payload && payload.role;
    const isAdmin = role === 'ops_admin';
    if (!isAdmin) return fail('只有管理员才能编辑帖子', 403);

    let body;
    try { body = await c.req.json(); } catch { return fail('请求体必须是合法 JSON'); }

    const db = c.env.DB;
    const post = await db.prepare('SELECT * FROM posts WHERE id = ? AND is_hidden = 0').bind(id).first();
    if (!post) return fail('帖子不存在或已删除', 404);

    // 可编辑字段：title / content / tags / category（不修改 created_at）
    const title = (body.title || '').trim();
    const content = (body.content || '').trim();
    if (!title) return fail('标题不能为空');
    if (!content) return fail('内容不能为空');
    if (title.length > 100) return fail('标题不能超过 100 字');
    if (content.length > 2000) return fail('内容不能超过 2000 字');

    // tags
    const rawTags = Array.isArray(body.tags)
      ? body.tags
      : (typeof body.tags === 'string' ? body.tags.split(/[,，\s]+/) : []);
    const cleanTags = [...new Set(
      rawTags.map(t => String(t).trim()).filter(Boolean).map(t => t.slice(0, 20))
    )].slice(0, 5);
    if (cleanTags.some(t => /["'\\<>{}]/.test(t))) return fail('标签不能包含特殊字符');
    const tagsStr = cleanTags.join(',');

    // category
    let category = (body.category || '').trim();
    if (!ALLOWED_CATEGORIES_KEYS.includes(category)) {
      category = 'general';
    }
    if (category === 'meta' && !isAdmin) {
      return fail('只有管理员才能发「站务」分区的帖子', 403);
    }

    // 只更新这 4 个字段 + updated_at（created_at 保持不变）
    // 处理图片 ID 列表
    let imageIdsStr = null;
    if (Array.isArray(body.imageIds)) {
      const parsed = body.imageIds
        .map(id => parseInt(id, 10))
        .filter(id => Number.isFinite(id) && id > 0)
        .slice(0, 9);
      imageIdsStr = parsed.length > 0 ? JSON.stringify(parsed) : null;
    }

    await db.prepare(
      `UPDATE posts SET title = ?, content = ?, tags = ?, category = ?, image_ids = COALESCE(?, image_ids), updated_at = datetime('now') WHERE id = ?`
    ).bind(title, content, tagsStr, category, imageIdsStr, id).run();

    const updated = await db
      .prepare(
        `SELECT p.*, u.nickname AS author_nickname, u.role AS author_role
         FROM posts p LEFT JOIN users u ON u.uid = p.author_uid WHERE p.id = ?`
      )
      .bind(id)
      .first();

    return c.json(ok(mapPostRow(updated)));
  } catch (e) {
    return fail(`[posts update] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 删帖（JWT：作者本人 或 ops_admin（运维管理员））====================
posts.delete('/:id', requireAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id) || id <= 0) return fail('帖子 ID 无效');

  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  const role = payload && payload.role;

  const db = c.env.DB;
  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  if (!post) return fail('帖子不存在', 404);

  const isAdmin = role === 'ops_admin';
  if (post.author_uid !== uid && !isAdmin) return fail('没有权限删除该帖子', 403);

  // 软删除：is_hidden = 1，不物理删
  await db.prepare('UPDATE posts SET is_hidden = 1 WHERE id = ?').bind(id).run();
  // 同时隐藏该帖下所有评论（保持数据一致，但不改变原 is_hidden = 1 的评论——不管）
  await db.prepare('UPDATE comments SET is_hidden = 1 WHERE post_id = ?').bind(id).run();

  return c.json(ok({ id, hidden: true }));
});

// ==================== 置顶/取消置顶（JWT：仅 ops_admin（运维管理员））====================
posts.patch('/:id/pin', requireAuth(), async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return fail('帖子 ID 无效');

    const payload = c.get('jwtPayload');
    const uid = payload && payload.sub;
    const role = payload && payload.role;
    const isAdmin = role === 'ops_admin';
    if (!isAdmin) return fail('只有管理员才能置顶/取消置顶帖子', 403);

    let body;
    try { body = await c.req.json(); } catch { body = {}; }
    const isPinned = !!body.isPinned;

    const db = c.env.DB;
    const post = await db.prepare('SELECT id, is_pinned FROM posts WHERE id = ? AND is_hidden = 0').bind(id).first();
    if (!post) return fail('帖子不存在或已删除', 404);

    // 置顶：放到现有置顶队列末尾（pin_order = MAX+1）；取消置顶：清零 pin_order
    let pinOrder = 0;
    if (isPinned) {
      const maxRow = await db.prepare('SELECT COALESCE(MAX(pin_order),0) AS m FROM posts WHERE is_pinned = 1').first();
      pinOrder = (maxRow && maxRow.m ? maxRow.m : 0) + 1;
    }
    await db.prepare("UPDATE posts SET is_pinned = ?, pin_order = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(isPinned ? 1 : 0, pinOrder, id).run();
    return c.json(ok({ id, isPinned, pinOrder }));
  } catch (e) {
    return fail(`[posts pin] ${e.name}: ${e.message}`, 500);
  }
});

export default posts;
