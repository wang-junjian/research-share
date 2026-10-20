# 浏览器侧三模块深化：共享常量 / 登录态门控 / 浏览器数据面

浏览器侧脚本（admin / quick-share / analytics / auth-chip / track 等，约 2860 行）是全仓改动最密的地方，却几乎零测试，且存在三处结构性摩擦：数据访问没有 seam（三个脚本各自裸调云 SDK，表名、select 列清单、`res.error` 解包、文档型 payload 形状散布十余处，与服务端条目存储的列清单平行演化、无对照）；登录态门控逐行重复（auth-chip 与 quick-share 各自写「读会话 → 未登录降级」，一次页面加载三次 `getSession`）；常量双写靠注释钉住（口径版本与文档字符上限各两份）。我们决定以三个深模块收口浏览器侧，对外行为完全不变：

1. **共享常量（Shared Constants）**：`lib/constants.js` 为单一来源（口径版本 `APP_VERSION`、文档字符上限 `DOC_MAX_CHARS`）；浏览器侧由静态资源模块在请求时动态生成 `/assets/constants.js`（挂 `window.RS_CONST`，不落盘、演示模式可用），SSR 埋点直接 import。db 迁移 CHECK 与平台边缘 WAF 规则无法由代码生成，维持注释对照。
2. **登录态门控（Auth Gate）**：收进 `assets/cloud.js` 的 `App.authGate`（Auth 订阅分发的延伸，不独立成文件）。公开页顶栏挂件声明 `{ mount, render(session) }`，机制统一读一次会话、填充 Auth 的 session/user（公开页首次填充）、逐挂件分发；未登录不动 SSR 输出。auth-chip 与 quick-share 退化为两份声明。
3. **浏览器数据面（Browser Data）**：新模块 `assets/data.js` 挂 `App.data`，独占表名、select 列清单、`res.error` → `App.msg` 解包翻译、文档型 payload 形状（`kind:'doc'` + `doc_html`、`url` 留空）与「写动 0 行即 throw」语义，覆盖 `research_items` / `admins` / `analytics_exclude` 三张表与看板 rpc；admin / quick-share / analytics 只调用不拼链，catch 后只负责展示。与服务端条目存储（[ADR-0001](0001-items-store.md)）互为镜像，列清单注释互相点名。

三者与 ADR-0001（条目存储，服务端那一半的数据访问收口）、[ADR-0002](0002-auth-state-client-side.md)（登录态只存浏览器，门控是其落地形态）、[ADR-0004](0004-hosted-html-csp-sandbox.md)（文档托管与 WAF 写入约束，文档型 payload 形状与预检的源头）配套，共同构成浏览器侧与服务端两侧的完整 seam。

## Considered Options

- **数据面按 SDK 形状命名（insert/update/delete 透传）**：拒绝。浅封装只搬不解耦，调用方仍要知道表名与行数语义；按领域语义命名（`publish` / `addAdmin` / `excludeVisitor`），interface 为现有调用点去重后的最小并集。
- **「写动 0 行」留给调用方检查**：拒绝。现状就是有的查（admin 的编辑/删除）、有的不查（quick-share、admin 录入），RLS 静默拦截在新调用方必然再被忘一次；统一在数据面 throw 可读错误，调用方不再碰行数。唯一例外是 `analytics_exclude` 的写动：并发移除同一标识后的 0 行是正常终态而非权限拦截，「排除本机」行为与文案不变，刻意不抛错。
- **门控复用 `Auth.start()`**：拒绝。OAuth 回调的唯一处理者是 admin 页，公开页 SSR 内联脚本已把带 code 的 `/` 弹转过去；公开页跑 `start()` 会与弹转竞态双换同一个 code（微信通道无消费标记会二次 POST，WorkBuddy 通道 PKCE verifier 被清后报假错误）。门控只调一次 `getSession()`，不引入 `onChange` 订阅（公开页没有页面内登录态变化源）。
- **常量脚本落盘或构建时生成**：拒绝。项目无构建步骤；由静态资源模块在请求时动态生成，不落盘、无缓存一致性问题、演示模式（track.js 无条件加载）同样可用。

## Consequences

- 浏览器侧数据逻辑第一次进入 `npm test`：数据面全方法经「window stub + 顶层 import + fake-cloud」seam 单测（列清单、payload 形状、错误翻译、0 行抛错），seam 不新增。
- admin 的录入/任命在 RLS 静默拦下时从「假成功 toast」变为可读错误；编辑/删除/移除的提示文案原样搬进数据面。这是刻意修正的静默失败，不要在未来评审中当作行为回退。
- 一次公开页加载只读一次会话；第三个挂件（可预期会有）与第三条写入路径（第三个录入入口）零样板接入。
- 改口径版本或文档上限只改 `lib/constants.js` 一处；db/06 CHECK 与边缘 WAF 规则仍需手工同步（注释对照），这是平台侧不可生成而刻意保留的例外。
- 浏览器侧 select 列清单与服务端条目存储列清单互为唯一对照点（注释互相点名，两侧刻意不同：浏览器要 `owner_id`，服务端要 `source_key` 等）；改任何一侧须到另一侧核对。
