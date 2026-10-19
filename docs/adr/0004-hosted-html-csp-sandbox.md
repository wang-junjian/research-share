# 同源托管用户上传的 HTML 文档，以 CSP sandbox 隔离

文档型成果要求本站直出用户上传的原始 HTML：托管地址 `/item/:id/doc` 即该成果的原文链接，详情页亦内嵌同一份文档。同源直出意味着文档脚本与本站页面同源，可读写 localStorage 中的登录会话（见 ADR-0002）、以本站身份发请求、伪造登录页。我们决定：托管页响应统一携带 `Content-Security-Policy: sandbox allow-scripts`——文档被浏览器当作孤立源（opaque origin），JS 照跑（图表可交互）但摸不到本站会话、父页面与表单提交；详情页 iframe 再加 `sandbox="allow-scripts"` 作双保险；托管页另加 `X-Content-Type-Options: nosniff`。不做 HTML 消毒。

## Considered Options

- **写入时消毒 HTML（杀脚本/白名单）**：拒绝。项目零运行时依赖，引入消毒库代价大；且会杀死图表类文档的 JS，与「自包含 HTML 可交互」的核心诉求冲突。保真度优先。
- **独立域名/子域托管**：拒绝。WorkBuddy 应用平台只有单域名（`*.app.workbuddy.host`），拿不到第二个源；引入外部托管增加部署与运维面。
- **仅靠 iframe 的 sandbox 属性**：拒绝。读者新标签页直达托管地址时该保护失效；CSP sandbox 随响应头走，顶层打开同样生效。

## Consequences

- 文档脚本运行在孤立源：读不到本站 localStorage/Cookie，无法读取或嵌入父页面，不能提交表单。文档内想调本站接口拿登录态数据不可能——报告类文档本不需要，视作刻意限制。
- 隔离防不住「视觉钓鱼」（伪造登录页的长相）。兜底靠发布必须登录、每条成果记 `owner_id` 可追溯，而非技术手段。
- 极老浏览器忽略 CSP 头时会无隔离直出，属可接受残留风险；现代 Chrome/Edge/Firefox/Safari 均支持 CSP sandbox。
- 文档内容不可变：`doc_html` 写入后任何路径（含 `source_key` 幂等重投）都不可覆盖，换文档即删除重发。该约束与本 ADR 的隔离模型配套——不存在「已审核内容被换掉」的窗口，故无需审核环节。
