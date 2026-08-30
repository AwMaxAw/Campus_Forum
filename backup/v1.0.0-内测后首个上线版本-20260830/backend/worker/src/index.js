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

export default app;
