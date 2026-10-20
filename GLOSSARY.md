# GLOSSARY.md

本项目的领域语言。代码命名、文档与架构讨论以此为准。

## 核心概念

- **研究成果（Item）**：本站分享的一条内容单元：标题、概览（summary）、原文链接、日期。对应数据表 `research_items`。按正文形态分两种：**链接型成果**与**文档型成果**。
- **链接型成果（Link Item）**：正文在站外，成果记录其站外原文链接。
- **文档型成果（Document Item）**：正文为一份自包含 HTML 文档（CSS/JS 全部内联、无外部本地资源），上传到本站托管；托管后生成的站内地址即该成果的原文链接。隔离决策记录见 [ADR-0004](docs/adr/0004-hosted-html-csp-sandbox.md)。
- **成果编号（Item No）**：由数据库主键派生的展示编号，形如 `NO.007`，稳定不随排序变化，像笔记的索引号。
- **条目公共身份**：一条成果的编号、页面 URL（`/item/:id`）与 OG 封面 URL（`/og/:id.png`）三个派生量，由条目存储单点派生，调用方只读字段不自行推导。文档型成果另有**托管地址**（`/item/:id/doc`）派生，其原文链接即托管地址、不落库。浏览器侧（admin / quick-share / analytics 经 SDK 直连数据面，拿不到物化字段）的派生收口在 `assets/cloud.js` 的 `App.itemNo` / `App.itemPath` / `App.docPath` / `App.isDoc`，返回站内路径，消费方只调用不推导，口径与服务端物化一致。
- **条目存储（Items Store）**：数据访问与身份派生的深模块（`lib/items-store.js`）。`createItemsStore({ cloud, siteUrl })` 返回 `{ list, find, findDocument, invalidate }`；60s 缓存、select 列清单、排序、「miss → invalidate → 重查一次」策略、以及日期归一化（`item_date` → `YYYY-MM-DD`）全部收在 interface 后面。`list`/`find` 返回的 item 物化携带派生字段：`no`（NO.007）、`no_num`（编号的数字部分 `007`，供分享海报与文件名）、`date`、`page_url`、`og_image`、`doc_url`（文档型成果的托管地址，与上述字段同点派生；物化后其 `url` 字段即该地址）。`findDocument` 单行另取文档原文（`doc_html` 不进列表查询）。决策记录见 [ADR-0001](docs/adr/0001-items-store.md)。

- **浏览器数据面（Browser Data）**：浏览器侧数据访问的深模块（`assets/data.js`），挂 `App.data`，在 cloud.js 之后加载。独占表名、select 列清单、`res.error` → `App.msg` 的解包翻译、文档型 payload 形状、以及「写动 0 行即抛错」的 RLS 静默拦截语义；目标覆盖 `research_items` / `admins` / `analytics_exclude` 与 `rpc('analytics_dashboard')`，调用方（admin / quick-share / analytics）只调用不拼链，错误一律 catch 后展示。与服务端条目存储互为镜像。落地分票：票 #10 先竖切 `publish`（快速分享接入），admin / analytics 的接入随票 #11 补齐——在此之前 admin.js / analytics.js 仍各自拼链，属过渡态。
- **共享常量（Shared Constants）**：跨服务端/浏览器双写常量的单一来源（`lib/constants.js`，口径版本 `APP_VERSION` 与文档字符上限 `DOC_MAX_CHARS`）。浏览器侧由静态资源模块动态生成 `/assets/constants.js`（挂 `window.RS_CONST`，不落盘、演示模式可用，公开页布局先于 track.js 无条件加载），服务端直接 import；`db/` 迁移与平台边缘 WAF 规则无法由代码生成，维持注释对照。

## 站点形态

- **演示模式（Demo）**：缺 `CLOUD_ENDPOINT` / `CLOUD_PUBLISHABLE_KEY` 时启用。只读、零依赖，用 `data/sample-items.json` 渲染界面；写操作与埋点全部丢弃。适配器在 `lib/demo-cloud.js`。
- **页面模板（Render）**：服务端渲染的 HTML 生成，纯函数群，位于 `lib/render.js`。视觉见 `assets/style.css`（浅色纸感 + 朱红批注）。
- **静态资源（Static Files）**：磁盘文件 → HTTP 响应的深模块（`lib/static-files.js`）。`createStaticFiles({ assetsDir, adminTemplate, publicConfigJson })` 返回 `{ tryServeStatic, getAdminHtml }`；mime 表、路径穿越防护（最多三层普通文件名）、字体 immutable / 其余 300s 的缓存策略、admin 模板的 `__PUBLIC_CONFIG__` 替换与缓存全部收在 interface 后面。未命中返回 `false` 且不写字节，怎么 404 由路由层决定。
- **微信分享卡片**：详情页的 og meta + `/og/:id.png` 封面图（`og-image.js` 实时生成 PNG，不落盘）。

## 接口与埋点

- **Agent API**：`/api/*` 下的读写接口，位于 `lib/agent-api.js`。读公开、写需 token（三道通道：`Authorization: Bearer`、`X-Agent-Token`、`?token=`）。写操作经数据库 SECURITY DEFINER 函数落库，token 只存 SHA-256。
- **埋点事件（Track Event）**：匿名访问统计，位于 `lib/track.js`。两条路径：SSR page_view（source='server'，刻意不带 session_id）与浏览器批量上报 `/api/track`（source='client'，永远 204）。客户端 ÷ 服务端 = 埋点覆盖率。
- **口径版本（ver）**：客户端埋点上报携带的版本号（`assets/track.js` 的 `VERSION`，形如 `v1`；改口径必须递增，否则跨版本趋势不可比）。经 `track_event(p_app_version)` 落进 `research_events.app_version` 列，看板 versions 维度据此分组。格式非法（非 `^v\d{1,8}$`）时服务端不传参，走数据库默认 `'v1'`。迁移见 `db/04-track-event-version.sql`。
- **访客识别**：UA 解析（device / os / browser / isBot 枚举）与来源归类（wechat / zhihu / search / direct / internal / other）。IP 只存加盐 SHA-256 前 32 位，不落明文。

## 身份与登录

- **登录态**：用户登录后的身份呈现。仅存在于浏览器 localStorage（云服务 SDK 的 SessionStore），服务端不感知身份；公开页顶栏默认渲染「登录」入口，由 `assets/auth-chip.js` 在客户端读会话后替换为头像+用户名。决策记录见 [ADR-0002](docs/adr/0002-auth-state-client-side.md)。
- **会话（Session）**：云服务 SDK 颁发的 `{accessToken, refreshToken, expiresAt, user}` 合称，存于浏览器 localStorage；过期判断与刷新交给 SDK 的 `getSession()`，业务代码不自实现。
- **初始管理员（Founder Admin）**：第一个管理员，全站唯一、不可被移除。独占管理员任命权：只有初始管理员能把录入者提升为管理员、把管理员降回录入者。决策记录见 [ADR-0003](docs/adr/0003-founder-admin-exclusive-appoint.md)。
- **登录态门控（Auth Gate）**：公开页「登录后才出现或替换的顶栏挂件」的声明式注册机制（`assets/cloud.js` 的 `App.authGate`，登录态词条的落地形态）。挂件声明 `{ mount, render(session) }`；读会话一次、填充 Auth 的 session/user、逐挂件分发渲染均由机制统一做，一次页面加载只读一次会话；未登录不动 SSR 输出。机制不调 `Auth.start()`、不碰 OAuth 回调派发（回调的唯一处理者是 admin 页），也不引入 onChange 订阅（公开页没有页面内登录态变化源）。auth-chip 与 quick-share 是挂件。依赖 defer 加载序：挂件脚本须 defer 排在 cloud.js 之后（注册先于 DOMContentLoaded 的统一运行）。admin 页的页面级登录门（showLogin/showAdmin 整页切换）粒度不同，不属于门控机制。决策记录见 [ADR-0002](docs/adr/0002-auth-state-client-side.md)。
- **管理员**：角色之一，可管理全部研究成果与数据看板；但不能任命或移除管理员（那是初始管理员的独占权限）。
- **录入者**：角色之一（普通用户），仅能录入、修改与删除自己录入的成果；发布无需审核、直接公开。数据看板对录入者不可见（页签不显示）。

## 架构词汇

架构讨论使用 `/codebase-design` 的词汇：**module**、**interface**、**depth**、**seam**、**adapter**、**leverage**、**locality**。决策记录见 `docs/adr/`。
