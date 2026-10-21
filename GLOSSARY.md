# GLOSSARY.md

本项目的领域语言。代码命名、文档与架构讨论以此为准。

## 核心概念

- **研究成果（Item）**：本站分享的一条内容单元：标题、概览（summary）、原文链接、日期。对应数据表 `research_items`。按正文形态分两种：**链接型成果**与**文档型成果**。
- **链接型成果（Link Item）**：正文在站外，成果记录其站外原文链接。
- **文档型成果（Document Item）**：正文为一份自包含 HTML 文档（CSS/JS 全部内联、无外部本地资源），上传到本站托管；托管后生成的站内地址即该成果的原文链接。隔离决策记录见 [ADR-0004](docs/adr/0004-hosted-html-csp-sandbox.md)。
- **成果编号（Item No）**：由数据库主键派生的展示编号，形如 `NO.007`，稳定不随排序变化，像笔记的索引号。
- **条目公共身份**：一条成果的编号、页面 URL（`/item/:id`）与 OG 封面 URL（`/og/:id.png`）三个派生量，由条目存储单点派生，调用方只读字段不自行推导。文档型成果另有**托管地址**（`/item/:id/doc`）派生，其原文链接即托管地址、不落库。浏览器侧（admin / quick-share / analytics 经 SDK 直连数据面，拿不到物化字段）的派生收口在 `assets/cloud.js` 的 `App.itemNo` / `App.itemPath` / `App.docPath` / `App.isDoc`，返回站内路径，消费方只调用不推导，口径与服务端物化一致。
- **条目存储（Items Store）**：数据访问与身份派生的深模块（`lib/items-store.js`）。`createItemsStore({ cloud, siteUrl })` 返回 `{ list, find, findDocument, invalidate }`；60s 缓存、select 列清单、排序、「miss → invalidate → 重查一次」策略、以及日期归一化（`item_date` → `YYYY-MM-DD`）全部收在 interface 后面。`list`/`find` 返回的 item 物化携带派生字段：`no`（NO.007）、`no_num`（编号的数字部分 `007`，供分享海报与文件名）、`date`、`page_url`、`og_image`、`doc_url`（文档型成果的托管地址，与上述字段同点派生；物化后其 `url` 字段即该地址）。`findDocument` 单行另取文档原文（`doc_html` 不进列表查询）。决策记录见 [ADR-0001](docs/adr/0001-items-store.md)。

- **浏览器数据面（Browser Data）**：浏览器侧数据访问的深模块（`assets/data.js`），挂 `App.data`，在 cloud.js 之后加载。独占表名、select 列清单、`res.error` → `App.msg` 的解包翻译、文档型 payload 形状、以及「写动 0 行即抛错」的 RLS 静默拦截语义；覆盖 `research_items`（listItems/publish/updateItem/deleteItem/deleteItems）、`admins`（listAdmins/addAdmin/removeAdmin）、`analytics_exclude`（listExclusions/excludeVisitor/includeVisitor）与看板 rpc（dashboard），调用方（admin / quick-share / analytics）只调用不拼链，错误一律 catch 后展示。刻意例外：`analytics_exclude` 写动不做 0 行抛错（并发移除的 0 行是正常终态）。与服务端条目存储互为镜像（select 列清单注释互相点名）。决策记录见 [ADR-0005](docs/adr/0005-browser-side-deep-modules.md)。
- **共享常量（Shared Constants）**：跨服务端/浏览器双写常量的单一来源（`lib/constants.js`，口径版本 `APP_VERSION`、文档字符上限 `DOC_MAX_CHARS` 与「退出统计」键名 `OPTOUT_LS_KEY` / `OPTOUT_COOKIE_KEY`）。浏览器侧由静态资源模块动态生成 `/assets/constants.js`（挂 `window.RS_CONST`，不落盘、演示模式可用，公开页布局先于 track-core.js / track.js 无条件加载），服务端直接 import；`db/` 迁移 CHECK、平台边缘 WAF 规则与 render.js 的退出开关内联脚本（先于 deferred constants.js 执行、读不到 RS_CONST）无法由代码生成，维持注释对照。

## 站点形态

- **演示模式（Demo）**：缺 `CLOUD_ENDPOINT` / `CLOUD_PUBLISHABLE_KEY` 时启用。只读、零依赖，用 `data/sample-items.json` 渲染界面；写操作与埋点全部丢弃。适配器在 `lib/demo-cloud.js`。
- **页面模板（Render）**：服务端渲染的 HTML 生成，纯函数群，位于 `lib/render.js`。视觉见 `assets/style.css`（浅色纸感 + 朱红批注）。
- **静态资源（Static Files）**：磁盘文件 → HTTP 响应的深模块（`lib/static-files.js`）。`createStaticFiles({ assetsDir, adminTemplate, publicConfigJson })` 返回 `{ tryServeStatic, getAdminHtml }`；mime 表、路径穿越防护（最多三层普通文件名）、字体 immutable / 其余 300s 的缓存策略、admin 模板的 `__PUBLIC_CONFIG__` 替换与缓存全部收在 interface 后面。未命中返回 `false` 且不写字节，怎么 404 由路由层决定。
- **微信分享卡片**：详情页的 og meta + `/og/:id.png` 封面图（`og-image.js` 实时生成 PNG，不落盘）。
- **海报排版（Poster Layout）**：分享海报与复制文案的纯逻辑深模块（`assets/poster-layout.js`，挂 `window.PosterLayout`，详情页在 share.js 前加载）。interface 六个成员：`tokenize`（按词/单个 CJK 字符切分）、`wrap(measure, text, maxWidth)`（断行）、`fit(measure, text, maxWidth, opts)`（逐 2px 缩字号 + 省略号回退截断）、`posterSpec(measure, data, fonts)`（整版版面决策：刊头/朱红短线/标题概览垂直居中/底部满版朱红带——左栏纯文字三行层级（部门署名「研发中心」站点级常量、日期作者、长按识别引导）、右栏二维码白卡与码区，坐标字号一次算清，概念①「红底对撞」）、`composeText`（文字分享正文：标题/概览/原文链接三段）、`srcLink`（原文链接口径：src 优先、url 兜底——海报二维码编的也是它）。测量经 `measure(text, fontCss)` 注入，module 不碰 canvas；`assets/share.js` 退为接线壳（调色、canvas 绘制、剪贴板、弹层）。`fit` 返回的 size/lineHeight 始终是最后实际测量的字号（循环耗尽不多减一次，drawPoster 不会拿小号字画大号排版）。测试见 `test/poster-layout.test.js`。
- **海报二维码（Poster QR）**：海报右下角二维码的深模块（`assets/qr.js`，挂 `window.QR`）。interface 两个成员：`matrix(text)`（经 vendored qrcode-generator 生成模块矩阵，纠错等级 H、自动版本、UTF-8 编码）与 `draw(ctx, matrix, opts)`（圆角方块码点、三定位角朱红、其余近黑；无 `roundRect` 的旧 webview 退化 fillRect）。编码内容是 `srcLink` 口径的原文链接，供收到海报的人长按识别直达原文。依赖 `assets/vendor/qrcode.js`（qrcode-generator 1.4.4，MIT，归属见 NOTICE.md）先于自身加载；库缺失或编码失败时 share.js 跳过二维码、海报其余照常。测试见 `test/qr.test.js`。

## 接口与埋点

- **Agent API**：`/api/*` 下的读写接口，位于 `lib/agent-api.js`。读公开、写需 token（三道通道：`Authorization: Bearer`、`X-Agent-Token`、`?token=`）。写操作经数据库 SECURITY DEFINER 函数落库，token 只存 SHA-256。
- **埋点事件（Track Event）**：匿名访问统计，位于 `lib/track.js`。两条路径：SSR page_view（source='server'，刻意不带 session_id）与浏览器批量上报 `/api/track`（source='client'，永远 204）。客户端 ÷ 服务端 = 埋点覆盖率。
- **口径版本（ver）**：客户端埋点上报携带的版本号（`assets/track.js` 的 `VERSION`，形如 `v1`；改口径必须递增，否则跨版本趋势不可比）。经 `track_event(p_app_version)` 落进 `research_events.app_version` 列，看板 versions 维度据此分组。格式非法（非 `^v\d{1,8}$`）时服务端不传参，走数据库默认 `'v1'`。迁移见 `db/04-track-event-version.sql`。
- **访客识别**：UA 解析（device / os / browser / isBot 枚举）与来源归类（wechat / zhihu / search / direct / internal / other）。IP 只存加盐 SHA-256 前 32 位，不落明文。
- **埋点采集核心（Track Core）**：客户端埋点的纯逻辑深模块（`assets/track-core.js`，挂 `window.TrackCore`）。interface 三个成员：`optedOut`（退出统计判定，键名经参数传入）、`itemIdFromPath`（`/item/:id` 识别）、`createTracker(deps) → { push, flush, visitorId, sessionId, isNewSession }`——访客身份双写对齐、会话 30 分钟 TTL、队列去抖（10 条/3 秒）、payload 组装、optout 重读、sendBeacon→fetch 降级链全部收在闭包里，存储/时钟/随机源/发送通道经参数注入。`assets/track.js` 退为接线壳：页面守卫（/admin、webdriver、optout 早退）、DOM 事件委托、自动事件、`window.RS` 暴露。测试经「预设 window + 顶层 import」seam 直贴 interface（`test/track-core.test.js`）。

## 身份与登录

- **登录态**：用户登录后的身份呈现。仅存在于浏览器 localStorage（云服务 SDK 的 SessionStore），服务端不感知身份；公开页顶栏默认渲染「登录」入口，由 `assets/auth-chip.js` 在客户端读会话后替换为头像+用户名。决策记录见 [ADR-0002](docs/adr/0002-auth-state-client-side.md)。
- **会话（Session）**：云服务 SDK 颁发的 `{accessToken, refreshToken, expiresAt, user}` 合称，存于浏览器 localStorage；过期判断与刷新交给 SDK 的 `getSession()`，业务代码不自实现。
- **初始管理员（Founder Admin）**：第一个管理员，全站唯一、不可被移除。独占管理员任命权：只有初始管理员能把录入者提升为管理员、把管理员降回录入者。决策记录见 [ADR-0003](docs/adr/0003-founder-admin-exclusive-appoint.md)。
- **登录态门控（Auth Gate）**：公开页「登录后才出现或替换的顶栏挂件」的声明式注册机制（`assets/cloud.js` 的 `App.authGate`，登录态词条的落地形态）。挂件声明 `{ mount, render(session) }`；读会话一次、填充 Auth 的 session/user、逐挂件分发渲染均由机制统一做，一次页面加载只读一次会话；未登录不动 SSR 输出。机制不调 `Auth.start()`、不碰 OAuth 回调派发（回调的唯一处理者是 admin 页），也不引入 onChange 订阅（公开页没有页面内登录态变化源）。auth-chip 与 quick-share 是挂件。依赖 defer 加载序：挂件脚本须 defer 排在 cloud.js 之后（注册先于 DOMContentLoaded 的统一运行）。admin 页的页面级登录门（showLogin/showAdmin 整页切换）粒度不同，不属于门控机制。决策记录见 [ADR-0002](docs/adr/0002-auth-state-client-side.md)。
- **管理员**：角色之一，可管理全部研究成果与数据看板；但不能任命或移除管理员（那是初始管理员的独占权限）。
- **录入者**：角色之一（普通用户），仅能录入、修改与删除自己录入的成果；发布无需审核、直接公开。数据看板对录入者不可见（页签不显示）。

## 架构词汇

架构讨论使用 `/codebase-design` 的词汇：**module**、**interface**、**depth**、**seam**、**adapter**、**leverage**、**locality**。决策记录见 `docs/adr/`。
