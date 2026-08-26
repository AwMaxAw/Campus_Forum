# Campus_Forum · 五中校园论坛

五中师生交流论坛。当前阶段：**简易前端骨架 + 假数据**，下一步接 Cloudflare Workers + D1 后端。

## 技术栈

| 层 | 选型 | 状态 |
|---|---|---|
| 前端 | 原生 HTML + vanilla JS + CSS（SPA + hash 路由）| ✅ 已搭 |
| 托管 | Vercel | ⏳ 待部署 |
| 后端 | Cloudflare Workers + Hono 框架 | ⏳ 待开发 |
| 数据库 | Cloudflare D1 (SQLite) | ⏳ 待建库 |
| 存储 | Cloudflare R2 | ⏳ 待建桶 |

## 项目结构

```
Campus_Forum/
├── index.html          # SPA 入口
├── css/
│   └── style.css       # 全局样式（Apple 风格）
├── js/
│   └── app.js          # 主逻辑（假数据 + hash 路由 + API 封装）
└── README.md
```

## 本地预览

直接用浏览器打开 `index.html` 即可，或起一个静态服务器：

```bash
npx serve .
# 或
python3 -m http.server 8000
```

访问 http://localhost:8000（或对应端口）。

## 当前能做什么 / 不能做什么

| ✅ 能做 | ❌ 暂时不能做 |
|---|---|
| 登录（任意 8 位 UID + 任意密码）| 真正的账号体系（注册/找回密码）|
| 发帖（标题 + 正文）| 帖子持久化（刷新后假数据还在，新发的丢了）|
| 看帖子列表 | 评论、点赞、收藏 |
| 退出登录 | 上传头像、图片 |
| 跨设备访问 | 多用户隔离 |

## 演进路线

```
当前       → 简易 SPA + 假数据 ✅
下一步     → 建 Cloudflare Worker，把 api 层的假数据改成 fetch 调用
再下一步   → 加 D1 数据库，持久化存储
再下一步   → 加注册、JWT 认证、密码哈希
最后       → 加 R2 头像/图片、评论、点赞、搜索
```

## 设计原则（演化友好）

1. **API 调用集中在 `js/app.js` 的 `api` 对象里** —— 将来换后端只动这一层
2. **状态集中在 `state` 对象** —— 不散落在 DOM 上
3. **UI 用 template string 生成** —— 方便将来转 Vue/React
4. **hash 路由** —— 不依赖服务端配置，迁移到任何托管平台都不用改路由

## 部署到 Vercel

1. 注册 https://vercel.com（用 GitHub 账号登录）
2. New Project → Import `AwMaxAw/Campus_Forum`
3. Framework Preset: `Other`
4. Build Command / Output Directory: 留空
5. Deploy → 几秒后访问 `https://campus-forum-xxx.vercel.app`

之后每次 push 到 main，Vercel 自动重新部署。

## License

MIT
