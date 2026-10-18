# GLOSSARY.md

本项目的领域语言。代码命名、文档与架构讨论以此为准。

## 核心概念

- **研究成果（Item）**：本站分享的一条内容单元：标题、概览（summary）、原文链接、日期。对应数据表 `research_items`。
- **成果编号（Item No）**：由数据库主键派生的展示编号，形如 `NO.007`，稳定不随排序变化，像笔记的索引号。
- **条目公共身份**：一条成果的编号、页面 URL（`/item/:id`）与 OG 封面 URL（`/og/:id.png`）三个派生量，由条目存储单点派生，调用方只读字段不自行推导。
- **条目存储（Items Store）**：数据访问与身份派生的深模块（`lib/items-store.js`）。`createItemsStore({ cloud, siteUrl })` 返回 `{ list, find, invalidate }`；60s 缓存、select 列清单、排序、「miss → invalidate → 重查一次」策略、以及日期归一化（`item_date` → `YYYY-MM-DD`）全部收在 interface 后面。`list`/`find` 返回的 item 物化携带派生字段：`no`（NO.007）、`no_num`（编号的数字部分 `007`，供分享海报与文件名）、`date`、`page_url`、`og_image`。决策记录见 [ADR-0001](docs/adr/0001-items-store.md)。

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

## 架构词汇

架构讨论使用 `/codebase-design` 的词汇：**module**、**interface**、**depth**、**seam**、**adapter**、**leverage**、**locality**。决策记录见 `docs/adr/`。
