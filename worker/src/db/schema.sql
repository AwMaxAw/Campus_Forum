-- 五中校园论坛数据库 schema
-- D1 是 SQLite，语法按 SQLite 写
-- 初始化: npx wrangler d1 execute campus-forum --remote --file=src/db/schema.sql

-- 用户表（UID 为主键，对应五中学号）
CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  nickname TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',      -- member / admin / dev_admin
  avatar_url TEXT,
  bio TEXT,                                -- 简介
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
  view_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  is_pinned INTEGER NOT NULL DEFAULT 0,    -- 0/1，是否置顶
  is_hidden INTEGER NOT NULL DEFAULT 0,    -- 0/1，是否被管理员隐藏
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
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

-- ============ 索引（SQLite 默认 B-tree 主键够用，但常用查询建索引更稳）============
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_uid);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_category_created ON posts(category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_uid);
CREATE INDEX IF NOT EXISTS idx_favorites_uid ON favorites(uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_from_to ON messages(from_uid, to_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_to_read ON messages(to_uid, is_read, created_at DESC);

-- ============ 种子数据：预置管理员用户 + 2 条欢迎帖 ============
-- 注意：
--   - 本项目密码哈希格式是 pbkdf2_sha256$100000$salt$hash
--     （见 worker/src/utils/auth.js hashPassword / verifyPassword）
--   - 每次生成的 salt 不同，所以 hash 不能静态写死在 schema.sql 里。
--   - 真实部署步骤（任选其一）：
--       A) 注册一个普通账号，之后用 wrangler d1 execute 把它 UPDATE 成 dev_admin。
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
  'dev_admin'
);

-- 两条欢迎帖（作者 00000000）
INSERT OR IGNORE INTO posts (author_uid, title, content, category, is_pinned, id) VALUES (
  '00000000',
  '欢迎来到五中校园论坛',
  '这是五中校园论坛的第一条帖子。当前阶段：✅ Cloudflare D1 数据库已建好，Worker 最小骨架部署成功。\n\n下一步：接入账号体系（注册/登录/JWT认证），让前端真的能发帖。',
  'meta',
  1,
  1
);

INSERT OR IGNORE INTO posts (author_uid, title, content, category, is_pinned, id) VALUES (
  '00000000',
  '关于使用建议',
  '请文明发言，遵守校规。本论坛仅限五中师生使用，发帖请勿包含真实姓名、电话等隐私信息。\n\n发现违规内容可以在帖子详情页举报，管理员会尽快处理。',
  'meta',
  1,
  2
);
