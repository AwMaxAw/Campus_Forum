/**
 * 广五校园论坛 - Cloudflare Worker 入口
 *
 * 阶段 4：帖子详情 + 评论/楼中楼 + 点赞 + 收藏 + 私信 + 公告
 *
 *   GET    /api/health                健康检查
 *   账号：
 *     POST   /api/auth/register       注册
 *     POST   /api/auth/login          登录 → JWT
 *     GET    /api/auth/me             当前用户
 *   帖子：
 *     GET    /api/posts               列表（分页、分区）
 *     GET    /api/posts/:id           详情（view_count + 1 + 附带 isLiked/isFavorited）
 *     POST   /api/posts               发新帖（JWT）
 *     DELETE /api/posts/:id           软删帖（JWT：作者或 admin）
 *   评论（楼中楼靠 reply_to_id）：
 *     GET    /api/comments?post_id=X  某帖评论列表（扁平化升序）
 *     POST   /api/comments            发评论 / 回复某条评论（JWT，body: post_id, content, reply_to_id?）
 *     DELETE /api/comments/:id        软删评论（JWT：作者或 admin）
 *   点赞：
 *     POST   /api/likes/toggle        toggle 点赞/取消点赞（JWT）→ { liked, likeCount }
 *     GET    /api/likes/post/:id      自己对某帖是否点赞（公开）
 *     GET    /api/likes/mine          我点过赞的帖子（JWT，分页）
 *   收藏：
 *     POST   /api/favorites/toggle    toggle 收藏（JWT）→ { favorited }
 *     GET    /api/favorites/mine      我收藏的帖子（JWT，分页）
 *   私信：
 *     GET    /api/messages/conversations          会话列表（JWT）
 *     GET    /api/messages/conversation/:uid      与某人的对话消息（JWT）
 *     POST   /api/messages                         发私信（JWT，body: to_uid, content）
 *     POST   /api/messages/read/:uid              标记与某人的对话为已读（JWT）
 *     GET    /api/messages/unread-count           未读消息总数（JWT）
 *   公告：
 *     GET    /api/announcements/unread             登录后拉未读公告（JWT）
 *     POST   /api/announcements/read/:id          标记某公告已读（JWT）
 *     GET    /api/announcements                   全部公告历史（分页，公开）
 *     POST   /api/announcements                   发新公告（JWT：仅 ops_admin（运维管理员））
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import authRoutes from './routes/auth.js';
import postsRoutes from './routes/posts.js';
import commentsRoutes from './routes/comments.js';
import likesRoutes from './routes/likes.js';
import favoritesRoutes from './routes/favorites.js';
import messagesRoutes from './routes/messages.js';
import announcementsRoutes from './routes/announcements.js';
import adminRoutes from './routes/admin.js';
import usersRoutes from './routes/users.js';
import imagesRoutes from './routes/images.js';
import feedbacksRoutes from './routes/feedbacks.js';
import notificationsRoutes from './routes/notifications.js';
import checkinRoutes from './routes/checkin.js';
import guildsRoutes from './routes/guilds.js';
import adminRequestsRoutes from './routes/adminRequests.js';

const app = new Hono();

app.use(
  '*',
  cors({
    // 广五校园论坛是公开 API，不依赖 Cookie 鉴权（JWT 放在 Authorization header）。
    // 放开 origin=* 可支持任意前端部署域名：Vercel / Netlify / Cloudflare Pages / 自定义域名 / GitHub Pages / localhost。
    // 这比维护一份白名单稳得多（否则每个新部署域名都要改 Worker 并重新 deploy）。
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['X-Request-Id'],
    credentials: false,
    maxAge: 86400,
  })
);

app.route('/api/auth', authRoutes);
app.route('/api/posts', postsRoutes);
app.route('/api/comments', commentsRoutes);
app.route('/api/likes', likesRoutes);
app.route('/api/favorites', favoritesRoutes);
app.route('/api/messages', messagesRoutes);
app.route('/api/announcements', announcementsRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/users', usersRoutes);
app.route('/api/images', imagesRoutes);
app.route('/api/feedbacks', feedbacksRoutes);
app.route('/api/notifications', notificationsRoutes);
app.route('/api/checkin', checkinRoutes);
app.route('/api/guilds', guildsRoutes);
app.route('/api/admin-requests', adminRequestsRoutes);

// ==================== 运维管理员：手动触发一次帖子备份到 GitHub（调试入口） ====================
app.post('/api/admin/backup-posts-now', async (c) => {
  // JWT 校验：仅 ops_admin
  try {
    const jwtMw = (await import('hono/jwt')).jwt({ secret: c.env.JWT_SECRET, alg: 'HS256' });
    await jwtMw(c, async () => {});
  } catch {
    return c.json({ success: false, message: '需要登录' }, 401);
  }
  const payload = c.get && c.get('jwtPayload');
  if (!payload || payload.role !== 'ops_admin') {
    return c.json({ success: false, message: '仅运维管理员可手动触发备份' }, 403);
  }
  try {
    const r = await runBackup(c.env);
    return c.json({ success: true, data: r });
  } catch (e) {
    return c.json({ success: false, message: `[backup-posts-now] ${e.name}: ${e.message}` }, 500);
  }
});

// ============ 轻量自迁移：首次请求时给老库补新列（schema.sql 已含这些列，仅兼容旧部署）============
// 用模块级 flag 避免同一 isolate 内重复执行；列已存在时 pragma 查到 c>0 直接跳过。
let autoMigrated = false;
app.use('*', async (c, next) => {
  if (!autoMigrated && c.env && c.env.DB) {
    try {
      // posts.pin_order
      const r1 = await c.env.DB
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('posts') WHERE name='pin_order'")
        .first();
      if (r1 && r1.c === 0) {
        await c.env.DB.prepare('ALTER TABLE posts ADD COLUMN pin_order INTEGER NOT NULL DEFAULT 0').run();
      }
      // posts.image_ids
      const r1b = await c.env.DB
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('posts') WHERE name='image_ids'")
        .first();
      if (r1b && r1b.c === 0) {
        await c.env.DB.prepare('ALTER TABLE posts ADD COLUMN image_ids TEXT').run();
      }
      // posts.region（运维管理员发帖可选定分区）
      const r1c = await c.env.DB
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('posts') WHERE name='region'")
        .first();
      if (r1c && r1c.c === 0) {
        await c.env.DB.prepare('ALTER TABLE posts ADD COLUMN region TEXT').run();
      }
      // users.is_banned
      const r2 = await c.env.DB
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('users') WHERE name='is_banned'")
        .first();
      if (r2 && r2.c === 0) {
        await c.env.DB.prepare('ALTER TABLE users ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0').run();
      }
      // users.last_login_at
      const r3 = await c.env.DB
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('users') WHERE name='last_login_at'")
        .first();
      if (r3 && r3.c === 0) {
        await c.env.DB.prepare('ALTER TABLE users ADD COLUMN last_login_at TEXT').run();
      }
      // users.exp_points（等级积分系统：累计积分）
      const rExp = await c.env.DB
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('users') WHERE name='exp_points'")
        .first();
      if (rExp && rExp.c === 0) {
        await c.env.DB.prepare('ALTER TABLE users ADD COLUMN exp_points INTEGER NOT NULL DEFAULT 0').run();
      }
      // users.exp_daily_date（浏览积分发放日期，跨天重置）
      const rExpDate = await c.env.DB
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('users') WHERE name='exp_daily_date'")
        .first();
      if (rExpDate && rExpDate.c === 0) {
        await c.env.DB.prepare('ALTER TABLE users ADD COLUMN exp_daily_date TEXT').run();
      }
      // users.exp_daily_browse（当日已发放浏览积分）
      const rExpBrowse = await c.env.DB
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('users') WHERE name='exp_daily_browse'")
        .first();
      if (rExpBrowse && rExpBrowse.c === 0) {
        await c.env.DB.prepare('ALTER TABLE users ADD COLUMN exp_daily_browse INTEGER NOT NULL DEFAULT 0').run();
      }
      // users.checkin_streak（连续签到天数）
      const rStreak = await c.env.DB
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('users') WHERE name='checkin_streak'")
        .first();
      if (rStreak && rStreak.c === 0) {
        await c.env.DB.prepare('ALTER TABLE users ADD COLUMN checkin_streak INTEGER NOT NULL DEFAULT 0').run();
      }
      // images 表（若不存在则创建）
      const r4 = await c.env.DB
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('images')")
        .first();
      if (r4 && r4.c === 0) {
        await c.env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER,
            author_uid TEXT NOT NULL,
            filename TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            width INTEGER,
            height INTEGER,
            data BLOB NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (post_id) REFERENCES posts(id),
            FOREIGN KEY (author_uid) REFERENCES users(uid)
          )
        `).run();
        await c.env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_images_post ON images(post_id)').run();
        await c.env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_images_author ON images(author_uid)').run();
      }
      // feedbacks 表
      const r5 = await c.env.DB
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('feedbacks')")
        .first();
      if (r5 && r5.c === 0) {
        await c.env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS feedbacks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            author_uid TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (author_uid) REFERENCES users(uid)
          )
        `).run();
      }
      // notifications 表（系统通知：积分变动等，导航栏铃铛入口）
      const r6 = await c.env.DB
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('notifications')")
        .first();
      if (r6 && r6.c === 0) {
        await c.env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uid TEXT NOT NULL,
            type TEXT NOT NULL,
            content TEXT NOT NULL,
            exp_delta INTEGER NOT NULL DEFAULT 0,
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (uid) REFERENCES users(uid)
          )
        `).run();
        await c.env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_notifications_uid ON notifications(uid, is_read, created_at DESC)').run();
      }
      // check_ins 表（每日签到）
      const r7 = await c.env.DB
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('check_ins')")
        .first();
      if (r7 && r7.c === 0) {
        await c.env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS check_ins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uid TEXT NOT NULL,
            check_date TEXT NOT NULL,
            exp_delta INTEGER NOT NULL DEFAULT 3,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(uid, check_date),
            FOREIGN KEY (uid) REFERENCES users(uid)
          )
        `).run();
        await c.env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_check_ins_uid_date ON check_ins(uid, check_date DESC)').run();
      }
      // guilds 表
      const rGuilds = await c.env.DB
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('guilds')")
        .first();
      if (rGuilds && rGuilds.c === 0) {
        await c.env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS guilds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            description TEXT,
            icon TEXT,
            owner_uid TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (owner_uid) REFERENCES users(uid)
          )
        `).run();
      }
      // guild_members 表
      const rGm = await c.env.DB
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('guild_members')")
        .first();
      if (rGm && rGm.c === 0) {
        await c.env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS guild_members (
            guild_id INTEGER NOT NULL,
            uid TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',
            joined_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (uid),
            FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
            FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
          )
        `).run();
        await c.env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_guild_members_guild ON guild_members(guild_id)').run();
      }
      // guild_join_requests 表
      const rGjr = await c.env.DB
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('guild_join_requests')")
        .first();
      if (rGjr && rGjr.c === 0) {
        await c.env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS guild_join_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id INTEGER NOT NULL,
            uid TEXT NOT NULL,
            reason TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            reviewed_by TEXT,
            reviewed_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
            FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
          )
        `).run();
      }
      // guild_create_requests 表
      const rGcr = await c.env.DB
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('guild_create_requests')")
        .first();
      if (rGcr && rGcr.c === 0) {
        await c.env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS guild_create_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            requester_uid TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            icon TEXT,
            reason TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            reviewed_by TEXT,
            reviewed_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (requester_uid) REFERENCES users(uid) ON DELETE CASCADE
          )
        `).run();
      }

      // ---- admin_requests ----
      const hasAdminReq = await c.env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='admin_requests'`).first();
      if (!hasAdminReq) {
        await c.env.DB.prepare(`
          CREATE TABLE admin_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL CHECK (type IN ('delete_post','delete_comment','ban_user','ban_guild')),
            target_id TEXT NOT NULL,
            target_snapshot TEXT,
            reason TEXT NOT NULL DEFAULT '',
            requester_uid TEXT NOT NULL,
            requester_nickname TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            reviewer_uid TEXT,
            reviewer_note TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            reviewed_at TEXT
          )
        `).run();
        await c.env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_admin_req_status ON admin_requests(status)`).run();
        await c.env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_admin_req_requester ON admin_requests(requester_uid)`).run();
      }
      autoMigrated = true; // 全部成功才标记，失败则下次请求重试
    } catch (e) {
      console.warn('[migrate] 自动迁移失败（下次请求将重试）：', e && e.message);
    }
  }
  await next();
});

app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'campus-forum-worker',
    time: new Date().toISOString(),
  });
});

app.notFound((c) => {
  const { method, pathname } = { method: c.req.method, pathname: new URL(c.req.url).pathname };
  return new Response(
    JSON.stringify({ success: false, message: `Not Found: ${method} ${pathname}` }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }
  );
});

// ================================================================
// 每天 0 点（北京时间）自动备份所有帖子 → GitHub 仓库 backup/posts/
//   - Cloudflare Workers Cron Trigger：scheduled 事件
//   - wrangler.toml: crons = ["0 16 * * *"]   (UTC 16:00 = Beijing 00:00)
//   - 需要环境变量（secret）：GITHUB_PAT、BACKUP_REPO(可选，默认 AwMaxAw/Campus_Forum)、BACKUP_BRANCH(可选，默认 main)
// ================================================================

/**
 * 从 D1 导出所有帖子（含作者昵称、评论、是否置顶/隐藏、图片id等）+ 基础统计信息，
 * 返回 { meta, posts } 结构。
 */
async function dumpPostsForBackup(db) {
  // 所有帖子（含被隐藏/置顶的，完整状态）
  const postsRaw = await db.prepare(`
    SELECT p.id, p.title, p.content, p.tags, p.category, p.region, p.image_ids,
           p.is_pinned, p.pin_order, p.is_hidden, p.view_count, p.like_count, p.comment_count,
           p.author_uid, u.nickname AS author_nickname, u.role AS author_role,
           p.created_at, p.updated_at
    FROM posts p
    LEFT JOIN users u ON u.uid = p.author_uid
    ORDER BY p.id ASC
  `).all();
  const posts = postsRaw.results || [];

  // 所有评论（扁平）
  const commentsRaw = await db.prepare(`
    SELECT c.id, c.post_id, c.author_uid, u.nickname AS author_nickname,
           c.content, c.reply_to_id, c.is_hidden, c.created_at
    FROM comments c
    LEFT JOIN users u ON u.uid = c.author_uid
    ORDER BY c.post_id ASC, c.id ASC
  `).all();
  const comments = commentsRaw.results || [];

  // 按 post_id 分组成 Map<postId, comments[]>
  const commentsByPost = new Map();
  for (const c of comments) {
    const arr = commentsByPost.get(c.post_id) || [];
    arr.push(c);
    commentsByPost.set(c.post_id, arr);
  }

  // 解析 image_ids 并拼 comments
  const finalPosts = posts.map(p => {
    let imageIds = [];
    try {
      if (p.image_ids) {
        const parsed = JSON.parse(p.image_ids);
        if (Array.isArray(parsed)) imageIds = parsed.map(Number).filter(n => Number.isFinite(n));
      }
    } catch {}
    return {
      id: p.id,
      title: p.title,
      content: p.content,
      tags: (p.tags || '').split(',').map(s => s.trim()).filter(Boolean),
      category: p.category,
      region: p.region || null,
      imageIds,
      isPinned: !!p.is_pinned,
      pinOrder: p.pin_order || 0,
      isHidden: !!p.is_hidden,
      stats: {
        views: p.view_count || 0,
        likes: p.like_count || 0,
        comments: p.comment_count || 0,
      },
      author: {
        uid: p.author_uid,
        nickname: p.author_nickname || null,
        role: p.author_role || 'member',
      },
      comments: commentsByPost.get(p.id) || [],
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    };
  });

  // 统计信息（备份的元数据）
  const stats = {
    totalPosts: finalPosts.length,
    visiblePosts: finalPosts.filter(p => !p.isHidden).length,
    hiddenPosts: finalPosts.filter(p => p.isHidden).length,
    pinnedPosts: finalPosts.filter(p => p.isPinned).length,
    totalComments: comments.length,
    postsWithImages: finalPosts.filter(p => p.imageIds.length > 0).length,
    byCategory: {},
  };
  for (const p of finalPosts) {
    stats.byCategory[p.category || 'unknown'] = (stats.byCategory[p.category || 'unknown'] || 0) + 1;
  }

  return {
    meta: {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      source: 'campus-forum-worker-d1',
      stats,
    },
    posts: finalPosts,
  };
}

/**
 * 通过 GitHub Contents REST API 把备份 JSON 写到仓库 backup/posts/posts-YYYYMMDD.json
 *   PUT /repos/:owner/:repo/contents/:path
 *   每次备份都是新建一个新文件（文件名带日期），无需 SHA，不会覆盖旧的。
 */
async function pushBackupToGithub({ env, filename, contentStr }) {
  const pat = env.GITHUB_PAT;
  if (!pat) throw new Error('GITHUB_PAT 环境变量未设置');

  const repo = env.BACKUP_REPO || 'AwMaxAw/Campus_Forum';
  const branch = env.BACKUP_BRANCH || 'main';
  const path = `backup/posts/${filename}`;
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;

  const today = new Date();
  const beijing = new Date(today.getTime() + 8 * 3600 * 1000);
  const dateStr = beijing.toISOString().slice(0, 10);
  const postCountMatch = contentStr.match(/"totalPosts"\s*:\s*(\d+)/);
  const postCount = postCountMatch ? Number(postCountMatch[1]) : 0;

  const base64 = btoa(unescape(encodeURIComponent(contentStr)));
  const body = {
    message: `backup: 帖子每日快照 ${dateStr}（${postCount} 篇）`,
    content: base64,
    branch,
  };

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${pat}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'campus-forum-worker-backup/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

/** 执行一次完整备份（scheduled 事件和手动 HTTP 调试入口共用） */
async function runBackup(env) {
  if (!env.DB) throw new Error('DB binding missing');
  const payload = await dumpPostsForBackup(env.DB);
  const content = JSON.stringify(payload, null, 2);

  // 文件名：posts-YYYYMMDD.json（北京时间日期）
  const now = new Date(Date.now() + 8 * 3600 * 1000); // Beijing
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const filename = `posts-${yyyy}${mm}${dd}.json`;

  const ghRes = await pushBackupToGithub({ env, filename, contentStr: content });

  return {
    filename,
    postCount: payload.meta.stats.totalPosts,
    commentCount: payload.meta.stats.totalComments,
    github: ghRes && ghRes.content ? { path: ghRes.content.path, sha: ghRes.content.sha, htmlUrl: ghRes.content.html_url } : null,
  };
}

// Cron Trigger 入口（Cloudflare Workers 标准 API：{ fetch, scheduled }）
export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const r = await runBackup(env);
        console.log('[cron backup] OK', JSON.stringify(r));
      } catch (e) {
        console.error('[cron backup] FAIL', e && e.stack || e);
        throw e; // 触发 Cloudflare 内置失败告警（有配置的话）
      }
    })());
  },
};
