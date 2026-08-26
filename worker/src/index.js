/**
 * 五中校园论坛 - Cloudflare Worker 入口
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
 *     POST   /api/announcements                   发新公告（JWT：仅 admin/dev_admin）
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

const app = new Hono();

app.use(
  '*',
  cors({
    origin: (origin) => {
      const allowed = [
        /^https:\/\/campus-forum.*\.vercel\.app$/,
        /^https:\/\/awmaxaw\.github\.io$/,
        /^http:\/\/localhost:\d+$/,
      ];
      return allowed.some(r => r.test(origin)) ? origin : 'null';
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
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
