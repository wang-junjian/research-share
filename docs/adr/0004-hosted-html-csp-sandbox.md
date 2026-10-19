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

## 修订（2026-10-19）：平台边缘 WAF 收缩了写入面

真实部署后发现：WorkBuddy 平台边缘的 WAF 会拦截请求体含 `<script`、内联事件属性（`onclick=` 等）或 `javascript:` 链接的请求，直接返回 403 HTML 拦截页（非本站 JSON），请求到不了应用——浏览器直写数据面与 Agent API 两条写入通道同此限制。

对原决策的影响：**「不做消毒、JS 照跑、图表可交互」的写入前提在 API 通道上不成立**——含脚本的文档根本入不了库，实际写入的 `doc_html` 均为无脚本静态 HTML。「＋ 分享」模态据此在提交前前置拦截并说明原因（`assets/quick-share.js` 的 `DOC_BLOCKED`），Agent API 文档同步标注（`docs/agent-api.md`）；图表等交互内容需在发布前渲染成静态 SVG / 图片再内联。

隔离方案保留不变：CSP sandbox + iframe sandbox 双保险仍覆盖三条残留路径——WAF 规则变动放行、SQL 控制台等绕过 API 的写入通道、以及存量内容；威胁模型与文档不可变约束亦不变。

## 修订二（2026-10-19）：详情页不再内嵌 iframe，隔离收口为 CSP sandbox 单保险

详情页形态的 product 决策变化：文档型详情页不再内嵌整份文档（iframe 移除），按钮组与链接型完全一致——「查看原文 ↗」直达托管地址。读者与文档的接触面因此只剩托管路由本身，iframe 那道「双保险」随之不复存在，**隔离由托管路由的 `Content-Security-Policy: sandbox allow-scripts` 响应头独力承担**。

这没有削弱实际防护：iframe sandbox 本就只是冗余层（读者新标签直达托管地址时它从不生效，见原决策对「仅靠 iframe sandbox」的拒绝理由），CSP sandbox 随响应头走、顶层打开同样生效，三条残留路径（WAF 规则变动放行、绕过 API 的写入通道、存量内容）依旧被它覆盖。威胁模型与文档不可变约束不变。
