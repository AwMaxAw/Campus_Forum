# 五中校园论坛 · 管理员控制台指令速查

> 适用场景：管理员在**本地 Terminal（macOS / Linux / Windows PowerShell）** 或 Cloudflare Dashboard 里操作。
> 文档分成两大类：
>
> | 类别 | 工具 | 适用场景 |
> |---|---|---|
> | **① HTTP API 调用（推荐日常）** | `curl` / Postman | 日常运营：注册用户、发公告、发帖、删帖、发私信（就像前端在做这些事），走线上生产 Worker |
> | **② 直接改 D1 数据库（应急后门）** | `npx wrangler d1 execute` | 紧急情况：给某个账号升 admin、软封禁账号、重置密码、直接清某条垃圾数据 |
>
> **线上地址**
> - 前端（Vercel）：https://campus-forum-omega.vercel.app/
> - 后端（Cloudflare Worker）：https://campus-forum.max-li-ggm.workers.dev
> - 管理员默认账号（schema.sql 初始化时写入，若已执行过）：
>   - UID：`10281028`，密码：`admin123`（生产环境请立刻修改！）

---

## 0. 前置：拿到管理员 Token（99% 的指令都要）

在调用任何需要管理员权限的接口之前，先用你的管理员 UID 换一个 JWT：

```bash
# ================ Windows PowerShell ================
$resp = Invoke-RestMethod -Method Post `
  -Uri "https://campus-forum.max-li-ggm.workers.dev/api/auth/login" `
  -ContentType "application/json" `
  -Body '{"uid":"10281028","password":"admin123"}'
$ADMIN_TOKEN = $resp.token
Write-Host "✅ Token (复制下面这行存起来，有效期 7 天)："
Write-Host $ADMIN_TOKEN

# ================ macOS / Linux (Bash/Zsh) ================
export ADMIN_TOKEN=$(curl -s -X POST \
  https://campus-forum.max-li-ggm.workers.dev/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"uid":"10281028","password":"admin123"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")
echo "✅ Token: $ADMIN_TOKEN"
```

**后续所有 curl 示例默认你已经 `export ADMIN_TOKEN=...` 或 `$ADMIN_TOKEN = ...` 设置好了。**

> 若 Token 丢了或过期了，重新跑上面这段就拿到新 Token。Token 过期时间在响应里也有 `tokenExpiresAt`（签发后 7 天）。

---

## I. 日常运营：HTTP API 指令（curl）

### 1. 用户管理

#### 1.1 注册一个新账号（开放给用户自己调用的，管理员也可以帮人注册）

任何人（包括未登录）都能调用。

```bash
curl -s -X POST https://campus-forum.max-li-ggm.workers.dev/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{
    "uid":      "88880001",
    "password": "zhang123456",
    "nickname": "张三（高二3班）",
    "bio":      "羽毛球社社长，欢迎约球🏸"
  }'
# 成功：HTTP 201，返回新用户对象 + success:true
# 失败：UID 格式不对、重复注册、密码太短会返回对应 message
```

字段说明：
- `uid`（必填）：8 位数字
- `password`（必填）：≥6 位
- `nickname`（可选，不填就默认"用户{uid}"）：1~20 字
- `bio`（可选）：≤200 字
- `avatarUrl`（可选）：头像直链

#### 1.2 查看某个账号的公开信息（当前账号自己）

```bash
curl -s "https://campus-forum.max-li-ggm.workers.dev/api/auth/me" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

#### 1.3（应急·D1）把某个用户升级为管理员 / 开发管理员

```bash
# 首先进 worker 目录
cd worker

# 设为普通管理员（可以发公告、删帖、删评论）
npx wrangler d1 execute campus-forum \
  --command "UPDATE users SET role='admin' WHERE uid='88880001';"

# 设为开发管理员（除上述外，能执行所有高权限操作——未来的系统级后门）
npx wrangler d1 execute campus-forum \
  --command "UPDATE users SET role='dev_admin' WHERE uid='88880001';"

# 降回普通成员
npx wrangler d1 execute campus-forum \
  --command "UPDATE users SET role='member' WHERE uid='88880001';"
```

#### 1.4（应急·D1）封禁 / 解禁账号（软封禁，is_banned 字段）

> 当前前端 UI 不展示封禁判断（预留字段）。软封禁后该账号登录会返回"账号已被封禁（未来启用）"逻辑在代码里是注释状态——如需生效，在 `worker/src/routes/auth.js` 的登录 handler 里取消注释 3 行即可。

```bash
cd worker

# 封禁（软）
npx wrangler d1 execute campus-forum \
  --command "UPDATE users SET is_banned=1 WHERE uid='88880001';"

# 解禁
npx wrangler d1 execute campus-forum \
  --command "UPDATE users SET is_banned=0 WHERE uid='88880001';"

# 查询该账号状态（确认封禁字段）
npx wrangler d1 execute campus-forum \
  --command "SELECT uid, nickname, role, is_banned, created_at FROM users WHERE uid='88880001';"
```

#### 1.5（应急·D1）重置某账号的密码（不知道原密码也可以）

```bash
cd worker
# ⚠️ 先在 Node.js 里手动生成新密码哈希（pbkdf2_sha256 格式，和系统内其它密码一致）：
#    打开本地 Terminal 跑：
#
# node -e "
# const crypto=require('crypto');
# (async()=>{
#   const pwd='这里填新密码明文，至少 6 位';
#   const salt=crypto.randomBytes(16);
#   const derived=crypto.pbkdf2Sync(pwd,salt,100000,32,'sha256');
#   console.log('pbkdf2_sha256\$100000\$'+salt.toString('hex')+'\$'+derived.toString('hex'));
# })();
# "
#
# 复制输出的 pbkdf2_sha256$... 整串作为 NEW_HASH，再：

npx wrangler d1 execute campus-forum \
  --command "UPDATE users SET password_hash='NEW_HASH' WHERE uid='88880001';"
```

---

### 2. 帖子管理

#### 2.1 管理员身份发一个新帖

```bash
curl -s -X POST https://campus-forum.max-li-ggm.workers.dev/api/posts \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "title":    "【重要】本周五下午社团招新大会",
    "content":  "所有高一同学下午 3:30 到体育馆参加社团招新，各个社团都会到场。\n\n现场有小礼品发放，先到先得！",
    "category": "club",
    "tags":     ["社团招新","通知","高一"]
  }'
# 成功：返回帖子对象，包含 id（后续删帖要用这个 id）
```

字段：
- `category`（可选，默认 `general`）：`general` / `study` / `club` / `life` / `meta`（站务）
- `tags`（可选）：字符串数组，前端会用空格拼接显示在帖子卡片底部

#### 2.2 查看帖子详情（任何人都能访问）

```bash
curl -s "https://campus-forum.max-li-ggm.workers.dev/api/posts/1"
```

#### 2.3 删除某个帖子（作者本人 OR 管理员 / 开发管理员）

```bash
# 把 POST_ID 换成要删的帖子 id（来自上面发新帖返回的 id，或首页帖子卡片链接 #detail/{id}）
curl -s -X DELETE "https://campus-forum.max-li-ggm.workers.dev/api/posts/POST_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# 成功：{ success: true, data: { deleted: true, id: POST_ID } }
# 失败：非作者 / 非管理员时返回 403
```

> 删除是**软删除**（`posts.is_hidden = 1`），数据库里数据仍保留，前端和列表不会再显示。若有纠纷需要回溯，直接 D1 里改 `is_hidden=0` 就可以恢复。

#### 2.4（应急·D1）恢复一个被误删的帖子

```bash
cd worker
npx wrangler d1 execute campus-forum \
  --command "UPDATE posts SET is_hidden=0 WHERE id=POST_ID;"
```

---

### 3. 评论管理

#### 3.1 管理员查看某帖的评论列表（包括楼中楼）

```bash
curl -s "https://campus-forum.max-li-ggm.workers.dev/api/comments?post_id=1"
```

#### 3.2 删除某条评论（作者或管理员）

```bash
curl -s -X DELETE "https://campus-forum.max-li-ggm.workers.dev/api/comments/COMMENT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# 软删除 comments.is_hidden=1，数据库仍保留
```

---

### 4. 公告管理（管理员专属高价值功能）

#### 4.1 发布一条全站公告（仅 `admin` / `dev_admin`）

```bash
curl -s -X POST https://campus-forum.max-li-ggm.workers.dev/api/announcements \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "title":     "【开学通知】2026 秋季学期报到安排",
    "content":   "各位同学：\n\n2026-2027 学年第一学期报到时间为 9 月 1 日 8:00–11:30，地点为本校体育馆。请携带：\n\n  1. 录取通知书原件\n  2. 一寸免冠照片 3 张\n  3. 学杂费缴费凭证\n\n如有疑问在下方评论区留言。",
    "is_pinned": true
  }'
# 成功：返回公告对象（含 id）。只要 is_pinned=true，在公告历史列表里会置顶显示。
```

> 公告发布后，**所有未登录过这条公告的用户在下一次登录时会自动弹窗**（逐条展示，点"我知道了"标记已读）。已读记录在 `announcement_reads` 表，不会重复骚扰用户。

#### 4.2 查看公告历史（任何人，不需要登录）

```bash
curl -s "https://campus-forum.max-li-ggm.workers.dev/api/announcements"
# 分页（每页 20 条）：?page=2&pageSize=20
```

#### 4.3（应急·D1）强制下线某条公告（不需要前端支持）

```bash
cd worker
# 软隐藏某条公告（相当于下线，不再显示在任何列表和弹窗中）
npx wrangler d1 execute campus-forum \
  --command "UPDATE announcements SET is_hidden=1 WHERE id=ANNO_ID;"

# 重新置顶 / 取消置顶
npx wrangler d1 execute campus-forum \
  --command "UPDATE announcements SET is_pinned=1 WHERE id=ANNO_ID;"
```

---

### 5. 私信（管理员对用户发系统通知、或代替老师家长私信学生）

#### 5.1 系统管理员 → 某个用户发一条私信

```bash
curl -s -X POST https://campus-forum.max-li-ggm.workers.dev/api/messages \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "to_uid":  "88880001",
    "content": "【系统通知】你的账号密码疑似被多次尝试登录，如果不是你本人操作请尽快修改密码。"
  }'
# 成功：201 Created，返回消息对象（含 id、createdAt）
# 该用户下次进入 💬 私信页面 就能看到对话；顶栏未读数字 +1
```

#### 5.2 查看某管理员 / 用户的当前会话列表

```bash
curl -s "https://campus-forum.max-li-ggm.workers.dev/api/messages/conversations" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# 返回每个会话：对方 UID、昵称、最后一条消息、未读计数
```

#### 5.3 查看与某个用户的完整对话（含历史）

```bash
curl -s "https://campus-forum.max-li-ggm.workers.dev/api/messages/conversation/88880001" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# ⚠️ 同时会把对方发给管理员的未读消息自动标记为"已读"（和打开页面一样的行为）
```

---

### 6. 点赞 / 收藏（应急查询）

一般管理员不需要手动调，但如果有人反馈"我明明点赞了却不显示"，可用以下接口做验证：

```bash
# 看管理员自己点过赞的帖子
curl -s "https://campus-forum.max-li-ggm.workers.dev/api/likes/mine" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 看管理员自己收藏的帖子
curl -s "https://campus-forum.max-li-ggm.workers.dev/api/favorites/mine" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 查某帖子自己的点赞状态（其实前端详情页会自动拉）
curl -s "https://campus-forum.max-li-ggm.workers.dev/api/likes/post/1" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## II. 应急后门：直接操作 D1（wrangler d1 execute）

### 环境准备

在你本地电脑终端进入 `Campus_Forum/worker` 目录：

```bash
cd /你的本地仓库路径/Campus_Forum/worker

# 如果还没登录 wrangler（第一次）：
npx wrangler login

# 验证账号对不对：
npx wrangler whoami
# 期望：Max.li.ggm@gmail.com's Account / 8a4b522c57ac8bffb17750be9867cfbb
```

### II.1 软封禁 / 解禁用户

见 I.1.4。

### II.2 升级 / 降级角色

见 I.1.3。

### II.3 重置密码

见 I.1.5。

### II.4 直接从数据库删除一条垃圾私信 / 评论 / 帖子

> ⚠️ 这类操作用**软删除**（`is_hidden=1`）就够了，前端会直接隐藏。数据库里保留数据用于以后纠纷回溯。不要直接 `DELETE`，除非 100% 确认是违法违规内容。

```bash
cd worker

# 软删一条违规私信
npx wrangler d1 execute campus-forum \
  --command "UPDATE messages SET is_hidden=1 WHERE id=MESSAGE_ID;"

# 软删一条评论
npx wrangler d1 execute campus-forum \
  --command "UPDATE comments SET is_hidden=1 WHERE id=COMMENT_ID;"

# 软删一个帖子
npx wrangler d1 execute campus-forum \
  --command "UPDATE posts SET is_hidden=1 WHERE id=POST_ID;"

# 真·物理删除（只在遇到违法/涉黄/涉暴等合规红线时用！会永久丢失！）
npx wrangler d1 execute campus-forum \
  --command "DELETE FROM posts WHERE id=POST_ID; DELETE FROM post_likes WHERE post_id=POST_ID; DELETE FROM post_favorites WHERE post_id=POST_ID; DELETE FROM comments WHERE post_id=POST_ID;"
```

### II.5 重置数据库（紧急清场 / 测试环境用）

```bash
cd worker
# ⚠️ 这会删掉所有表和数据！生产环境绝对不要用！
#
# 顺序：先删外键依赖的（子表），再删父表
cat <<'EOF' | npx wrangler d1 execute campus-forum --file /dev/stdin
DROP TABLE IF EXISTS post_favorites;
DROP TABLE IF EXISTS post_likes;
DROP TABLE IF EXISTS announcement_reads;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS posts;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS announcements;
EOF
# 然后重新执行 schema.sql（建所有空表 + 默认 admin 账号）：
npx wrangler d1 execute campus-forum --file src/db/schema.sql
```

### II.6 查看统计数字（论坛运营概况）

```bash
cd worker

# 概览：总用户数 / 总帖数 / 总评论数 / 总私信数 / 已发公告数
npx wrangler d1 execute campus-forum --command "
SELECT
  (SELECT COUNT(*) FROM users)                   AS total_users,
  (SELECT COUNT(*) FROM posts WHERE is_hidden=0) AS total_posts,
  (SELECT COUNT(*) FROM comments WHERE is_hidden=0) AS total_comments,
  (SELECT COUNT(*) FROM messages)                AS total_messages,
  (SELECT COUNT(*) FROM announcements WHERE is_hidden=0) AS total_announcements;
"

# 最活跃用户 Top 10（发帖数 + 评论数综合）
npx wrangler d1 execute campus-forum --command "
SELECT
  u.uid,
  u.nickname,
  (SELECT COUNT(*) FROM posts WHERE author_uid=u.uid AND is_hidden=0) AS post_count,
  (SELECT COUNT(*) FROM comments WHERE author_uid=u.uid AND is_hidden=0) AS comment_count
FROM users u
ORDER BY post_count*2 + comment_count DESC
LIMIT 10;
"
```

---

## III. 常见报错速查

| 错误信息 | 说明 | 处理方法 |
|---|---|---|
| `HTTP 401: Unauthorized` / `"无效的 token"` | JWT 过期 / 拼错了 / 没带 `Authorization: Bearer xxx` | 重新执行 §0 拿新 Token |
| `"UID 或密码不正确"` | 登录失败（UID 不存在或密码错） | 检查 UID 拼写；若密码忘走 I.1.5 重置 |
| `"该 UID 已注册..."`（409）| 重复注册 | 走重置密码流程 |
| `HTTP 403` 或 `"无权限"` | 该操作需要 admin/dev_admin，但当前登录的是 member 角色 | 用 I.1.3 升角色后重试 |
| `HTTP 404: Not Found` | 帖子 / 用户 / 评论 id 不存在 | 检查 id 是否拼写正确 |
| `no such table: xxx` | D1 还没执行 schema.sql 建表 | `cd worker && npx wrangler d1 execute campus-forum --file src/db/schema.sql` |
| `columns not match` / `has no column named xxx` | schema 字段对不上（可能是老库里没跑新迁移） | 重新跑 schema.sql 或写对应 ALTER TABLE |

---

## IV. 安全守则（重要！）

1. **不要把 `ADMIN_TOKEN` 贴到任何公开地方**（聊天记录、论坛帖子、Git 仓库）。如果不小心泄露了，直接在 Cloudflare Dashboard 重新 `wrangler secret put JWT_SECRET` 换一个新 secret，所有现存 Token 立刻作废，不会有损失。

2. **不要把 `cfut_` 开头的 Cloudflare User API Key 和 GitHub Token 存明文**。文档里所有例子都是用 `$ADMIN_TOKEN` 环境变量，方便随时换。

3. **生产环境默认管理员 `10281028 / admin123` 必须立刻改掉！** 要么登录后走"修改密码"（如果以后加了这个功能），要么直接 I.1.5 用 wrangler d1 execute 重置成强密码。

4. **所有 DELETE / UPDATE D1 操作**，先跑 `SELECT ... WHERE id=X` 看一下是不是目标行，确认再执行。避免手滑全表 UPDATE。
