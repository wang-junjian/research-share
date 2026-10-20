# 条目存储（Items Store）收编数据访问与身份派生

数据访问（60s 缓存、失效、重查、select 列清单、排序）原先以闭包形式散在 server.js，「miss 怎么办」的策略在 `/og/:id.png` 路由（重查）与 `/item/:id` 路由（直接 404）出现了两种不一致的实现——后台经浏览器 SDK 直连数据库写入后，新条目首访详情页必 404。条目公共身份的派生同时散在 3 个文件 7+ 处。我们决定设立条目存储深模块（lib/items-store.js，`createItemsStore({ cloud, siteUrl }) → { list, find, invalidate }`）收编以上全部职责，并让 item 物化携带派生字段（`no` / `date` / `page_url` / `og_image`）。

同时：`/api/track` 路由从 agent-api 的分发器归还 track module，由 server.js 按路径直接分派；`apiShape` 保留为公开 API 的字段白名单（防内部字段泄漏），不再做推导。

## Considered Options

- **find(id) 永远绕过缓存（原 agent-api 行为）**：拒绝。单条读取是公开只读数据，与列表页保持同一个 60s 陈旧窗口换取三处查找逻辑归一；写路径写后已 invalidate，紧接的 find 必然查库，不受影响。
- **身份派生导出纯函数（itemNo/itemPath/ogPath），item 保持原样**：拒绝。调用点仍需各自推导，收编太浅；物化后调用方只读字段。

## Consequences

- `GET /api/items/:id` 从「永远新鲜」变为「60s 内可能陈旧，miss 必重查」。这是刻意接受的语义统一，不要在未来评审中当作疏漏重新提出。
- `fmtDate` 不再是 render 的导出：日期归一化（`item_date` → `YYYY-MM-DD`）是条目存储的内部细节，render 只对物化的 `date` 字符串做年/月截取。
- `createAgentApi` 入参从 6 个降到 3 个（`cloud, site, itemsStore`；`site` 即 `{name, url, ...}` 配置对象，健康检查回显用之，不经 store 转手）。

## 相关决策

- [ADR-0005](0005-browser-side-deep-modules.md)：浏览器数据面是本模块在浏览器侧的镜像（select 列清单注释互相点名），登录态门控与共享常量同期收口。
