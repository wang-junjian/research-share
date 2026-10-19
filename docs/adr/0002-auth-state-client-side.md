# 登录态只存浏览器，公开页由客户端读取呈现

公开页（SSR）需要在顶栏呈现登录态，但登录体系由云服务 SDK 托管，会话只写浏览器 localStorage，服务端拿不到也不应拿到。我们决定保持这一边界：公开页顶栏 SSR 默认渲染「登录」入口（`data-auth-chip` 挂载点），加载 vendor SDK + cloud.js + auth-chip.js 后在客户端读会话，已登录则替换为头像+用户名；过期与刷新交给 SDK 的 `getSession()`，读不到有效会话即视同未登录。

## Considered Options

- **改 cookie 会话、SSR 注入用户名**：拒绝。要替换 SDK 的 SessionStore 默认行为并自管 token 刷新与 cookie 安全属性，偏离托管登录的语义，改动面与维护成本远大于收益。
- **手写读 localStorage 的 session JSON（不加载 SDK）**：拒绝。省 ~79KB 下载，但耦合 SDK 内部存储 key 与字段格式，SDK 升级即静默失效；且失去 `getSession()` 的过期处理。

## Consequences

- 公开页每个访客多下载 vendor SDK + cloud.js（约 79KB，defer 加载不阻塞首屏）。这是为「与后台完全一致的会话语义」刻意付的价。
- 登录用户首屏会看到顶栏从「登录」短暂替换为头像+用户名（SSR 无法预知身份）。这是刻意接受的闪烁，不要在未来评审中当作疏漏重新提出。
- 演示模式（缺云服务配置）下公开页不加载 SDK，顶栏恒为「登录」入口；`site.publicConfigJson` 为空即整条登录态链路关闭。
