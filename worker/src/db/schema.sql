-- 广五校园论坛数据库 schema
-- D1 是 SQLite，语法按 SQLite 写
-- 初始化: npx wrangler d1 execute campus-forum --remote --file=src/db/schema.sql

-- 用户表（UID 为主键，对应广五学号）
CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  nickname TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',      -- member / ops_admin（运维管理员）
  avatar_url TEXT,
  bio TEXT,                                -- 简介
  is_banned INTEGER NOT NULL DEFAULT 0,    -- 0/1，是否被管理员封禁（封禁后无法登录）
  last_login_at TEXT,                       -- 上次最后登录时间（登录成功时更新；为兼容 D1 ADD COLUMN，不带 NOT NULL）
  exp_points INTEGER NOT NULL DEFAULT 0,    -- 累计积分（等级积分系统，只增不减）
  exp_daily_date TEXT,                       -- 最近一次浏览积分发放日期 YYYY-MM-DD（跨天重置 exp_daily_browse；ADD COLUMN 兼容不带 NOT NULL）
  exp_daily_browse INTEGER NOT NULL DEFAULT 0,-- 当日已发放的浏览积分（防刷，每日上限 10）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT                          -- 最后修改时间（改密码 / 改资料时更新；为兼容 D1 ADD COLUMN，不带 NOT NULL 与不稳定 DEFAULT）
);

-- 帖子表
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_uid TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,                               -- 逗号分隔，如 "学习,社团"
  category TEXT DEFAULT 'general',         -- 分区：general / study / club / life / meta
  image_ids TEXT,                          -- JSON 数组，如 "[1,2,3]"，存关联的图片 id
  view_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  is_pinned INTEGER NOT NULL DEFAULT 0,    -- 0/1，是否置顶
  pin_order INTEGER NOT NULL DEFAULT 0,    -- 置顶排序：is_pinned=1 时生效，越小越靠前；多个置顶帖按此值升序排列
  region TEXT,                              -- 帖子所属分区（运维管理员发帖时选定；NULL 时按 author_uid 前缀过滤）
  is_hidden INTEGER NOT NULL DEFAULT 0,    -- 0/1，是否被管理员隐藏
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (author_uid) REFERENCES users(uid)
);

-- 图片表（帖子图片，存 D1 BLOB）
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER,                          -- 关联帖子 ID（可为空，上传时先存图片再关联帖子）
  author_uid TEXT NOT NULL,                 -- 上传者 UID
  filename TEXT NOT NULL,                   -- 原始文件名
  mime_type TEXT NOT NULL,                  -- MIME 类型：image/png, image/jpeg, image/webp
  size INTEGER NOT NULL,                    -- 图片字节数
  width INTEGER,                            -- 宽度（像素）
  height INTEGER,                           -- 高度（像素）
  data BLOB NOT NULL,                       -- 图片二进制数据
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (post_id) REFERENCES posts(id),
  FOREIGN KEY (author_uid) REFERENCES users(uid)
);

-- 评论表
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  author_uid TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_to_id INTEGER,                     -- 引用哪条评论（楼中楼）
  is_hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (post_id) REFERENCES posts(id),
  FOREIGN KEY (author_uid) REFERENCES users(uid)
);

-- 收藏表（多对多）
CREATE TABLE IF NOT EXISTS favorites (
  uid TEXT NOT NULL,
  post_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (uid, post_id),
  FOREIGN KEY (uid) REFERENCES users(uid),
  FOREIGN KEY (post_id) REFERENCES posts(id)
);

-- 点赞表（帖子）
CREATE TABLE IF NOT EXISTS post_likes (
  uid TEXT NOT NULL,
  post_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (uid, post_id),
  FOREIGN KEY (uid) REFERENCES users(uid),
  FOREIGN KEY (post_id) REFERENCES posts(id)
);

-- 私信表
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_uid TEXT NOT NULL,
  to_uid TEXT NOT NULL,
  content TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (from_uid) REFERENCES users(uid),
  FOREIGN KEY (to_uid) REFERENCES users(uid)
);

-- 公告表（管理员发布的全站弹窗公告）
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_uid TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,     -- 越大越优先弹
  expires_at TEXT,                          -- 过期时间，NULL=永不过期
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (author_uid) REFERENCES users(uid)
);

-- 公告已读表（避免同一个公告反复弹给用户）
CREATE TABLE IF NOT EXISTS announcements_read (
  uid TEXT NOT NULL,
  announcement_id INTEGER NOT NULL,
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (uid, announcement_id),
  FOREIGN KEY (uid) REFERENCES users(uid),
  FOREIGN KEY (announcement_id) REFERENCES announcements(id)
);

-- 反馈表（悬浮球收集 bug / 建议）
CREATE TABLE IF NOT EXISTS feedbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_uid TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (author_uid) REFERENCES users(uid)
);

-- 签到记录表（每日签到 + 连续签到日历）
CREATE TABLE IF NOT EXISTS check_ins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL,
  check_date TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
  exp_delta INTEGER NOT NULL DEFAULT 3,   -- 本次签到获得的积分
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(uid, check_date),
  FOREIGN KEY (uid) REFERENCES users(uid)
);
CREATE INDEX IF NOT EXISTS idx_check_ins_uid_date ON check_ins(uid, check_date DESC);

-- 系统通知表（积分变动等系统消息，导航栏铃铛入口）
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL,                       -- 接收者 UID
  type TEXT NOT NULL,                      -- 类型：post / comment / liked / replied / exp 等
  content TEXT NOT NULL,                  -- 展示正文
  exp_delta INTEGER NOT NULL DEFAULT 0,    -- 关联的积分变化（0 表示无积分变动）
  is_read INTEGER NOT NULL DEFAULT 0,     -- 0/1 是否已读
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (uid) REFERENCES users(uid)
);

-- 公会表
CREATE TABLE IF NOT EXISTS guilds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,              -- 公会名称（唯一）
  description TEXT,                        -- 简介
  icon TEXT,                               -- 图标 emoji 或字符
  owner_uid TEXT,                          -- 创始者（可为空，管理员直接创建的）
  status TEXT NOT NULL DEFAULT 'active',   -- active / banned
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (owner_uid) REFERENCES users(uid)
);

-- 公会成员表（每个用户只能属于一个公会）
CREATE TABLE IF NOT EXISTS guild_members (
  guild_id INTEGER NOT NULL,
  uid TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',     -- owner / admin / member
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (uid),                      -- 一个用户只能属于一个公会
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_guild_members_guild ON guild_members(guild_id);

-- 公会加入申请表
CREATE TABLE IF NOT EXISTS guild_join_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id INTEGER NOT NULL,
  uid TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending / approved / rejected
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(guild_id, uid, status) WHERE status = 'pending',  -- 每个用户对每个公会只能有一个 pending 申请
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);

-- 公会创建申请表（普通用户申请新建公会，需管理员审批）
CREATE TABLE IF NOT EXISTS guild_create_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_uid TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending / approved / rejected
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (requester_uid) REFERENCES users(uid) ON DELETE CASCADE
);

-- ============ 索引（SQLite 默认 B-tree 主键够用，但常用查询建索引更稳）============
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_uid);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_category_created ON posts(category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_uid);
CREATE INDEX IF NOT EXISTS idx_favorites_uid ON favorites(uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_from_to ON messages(from_uid, to_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_to_read ON messages(to_uid, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_post ON images(post_id);
CREATE INDEX IF NOT EXISTS idx_images_author ON images(author_uid);
CREATE INDEX IF NOT EXISTS idx_notifications_uid ON notifications(uid, is_read, created_at DESC);

-- ============ 种子数据：预置管理员用户 + 2 条欢迎帖 ============
-- 注意：
--   - 本项目密码哈希格式是 pbkdf2_sha256$100000$salt$hash
--     （见 worker/src/utils/auth.js hashPassword / verifyPassword）
--   - 每次生成的 salt 不同，所以 hash 不能静态写死在 schema.sql 里。
--   - 真实部署步骤（任选其一）：
--       A) 注册一个普通账号，之后用 wrangler d1 execute 把它 UPDATE 成 ops_admin。
--       B) 用下面这条 node 命令生成你想要的密码的 hash，再把 INSERT 里的
--          <GENERATED_PBKDF2_HASH> 替换掉：
--          node -e "const {pbkdf2Sync,randomBytes}=require('crypto');\
--          const s=randomBytes(16),d=pbkdf2Sync('你的密码',s,100000,32,'sha256');\
--          console.log('pbkdf2_sha256$100000$'+s.toString('hex')+'$'+d.toString('hex'));"
--   - 下面例子占位符使用前必须先替换，否则登录会失败。
INSERT OR IGNORE INTO users (uid, password_hash, nickname, role) VALUES (
  '00000000',
  '<GENERATED_PBKDF2_HASH_OF_admin123>',
  '系统管理员',
  'ops_admin'
);

-- 两条欢迎帖（作者 00000000）
INSERT OR IGNORE INTO posts (author_uid, title, content, category, is_pinned, id) VALUES (
  '00000000',
  '欢迎来到广五校园论坛',
  '这是广五校园论坛的第一条帖子。当前阶段：✅ Cloudflare D1 数据库已建好，Worker 最小骨架部署成功。\n\n下一步：接入账号体系（注册/登录/JWT认证），让前端真的能发帖。',
  'meta',
  1,
  1
);

INSERT OR IGNORE INTO posts (author_uid, title, content, category, is_pinned, id) VALUES (
  '00000000',
  '关于使用建议',
  '请文明发言，遵守校规。本论坛仅限广五师生使用，发帖请勿包含真实姓名、电话等隐私信息。\n\n发现违规内容可以在帖子详情页举报，管理员会尽快处理。',
  'meta',
  1,
  2
);
