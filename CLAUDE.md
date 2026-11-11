# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

```bash
npm start                              # 启动服务（无云服务配置时进入演示模式）
npm test                               # 全部测试（node:test，无测试框架依赖）
node --test test/server.test.js        # 跑单个测试文件
npm run preflight                      # 发布前自检（配置/语法/真实数据/非演示模式）
npm run smoke                          # Agent API 冒烟测试（需要 token，见脚本头部）
```

无构建步骤、无前端框架、无 lint 配置。Node >= 20，唯一的 npm 依赖是云服务 SDK。

## 架构要点

**单进程 SSR，零前端框架。** `server.js` 是唯一入口，导出 `createHandler({...deps})`：所有依赖（itemsStore、track、agent-api、静态文件、admin 模板）经参数注入，import 本文件不会起服务。测试（`test/server.test.js`）与真实入口共用这一个 handler，改路由时不需要另写集成层。

**模块边界在 `lib/`**：`render.js`（SSR 拼 HTML）、`items-store.js`（内容读写）、`agent-api.js`（`/api/*` 写接口）、`track.js`（埋点上报，`/api/track` 由路由层直接分派给它，不经 agent-api——见 ADR-0001）、`static-files.js`、`demo-cloud.js`（演示模式适配层）、`http.js`（sendJson/sendHtml）、`load-env.js`（极简 .env 加载）、`constants.js`（共享常量单一来源，`/assets/constants.js` 由 static-files 动态生成——见 GLOSSARY「共享常量」）。

**演示模式是刻意的静默降级**：缺 `CLOUD_ENDPOINT` / `CLOUD_PUBLISHABLE_KEY` 时页面照常 200，只是内容换成 `data/sample-items.json`。所以「接口通了」必须验数据条数，不能只信返回码——`preflight.sh` 就是为这个坑存在的。

**写权限锁在数据库函数里**：`research_events` 与 `agent_tokens` 不建任何 RLS policy、已收回 anon/authenticated 全部权限，唯一写入口是 `SECURITY DEFINER` 函数（`db/02`、`db/03`）。改鉴权逻辑时鉴权点只有一个：`is_admin()` / `is_founder()`。迁移按 `db/01 → 08` 顺序执行，均幂等。

## 容易踩的坑（线上才暴露）

- **不要用 `Authorization: Bearer`**，平台边缘代理会吃掉这个头，线上 401。Agent API 用 `X-Agent-Token`。
- **文档型成果的请求体不能含 `<script` 或内联事件属性**（`onclick=` 等），边缘 WAF 直接 403 拦截页，请求到不了应用（ADR-0004）。
- **`og:image` 必须是绝对 URL 且来自显式配置的 `SITE_URL`**，不能拼请求 `Host` 头（反代后是内网地址）。
- **服务端 `page_view` 埋点刻意不带 `session_id`**，否则会撞掉客户端那条的 3 秒去抖，埋点覆盖率指标作废（`docs/analytics.md`）。
- **顶栏外链（`SITE_LINK_*`，`lib/render.js` 的 layout）必须带 `data-track-skip`**：它是跨域外链，`assets/track.js` 的点击委托会把它记成 `outbound_click`，而看板的「原文跳转率」= `outbound_click ÷ view_item` —— 顶栏的一次导航点击就能让这个比率超过 100%，把入口误报成转化。新增任何「非成果内容」的外链都要跟着加这个属性（判断放在委托函数最前面，避免新增分支时漏掉）。
- **分享按钮的 `data-act` 与数据库 `method` 白名单是两处枚举**（DOM 用连字符、事件用下划线）：改按钮必须同时改 `db/09` 的 `track_event` 白名单与分享效力表 values，否则事件照落库、props 被静默清空，看板「分享总数 ≠ 明细之和」。`test/track-schema.test.js` 钉住这五处闭合。
- **会话 id 有标签页级存储与 cookie 两份**（cookie 兜底跨标签页，值带 `lastAt`）：只改一处会让「新开标签页 = 新会话」复发，会话数虚高、页均浏览偏低、漏斗被切碎。
- **文档型成果的「原文」是本站托管地址**（`/item/N/doc`）：只按跨域判外链会让这类条目的北极星恒为 0，须带 `via=doc`；该页不加载 `track.js`，服务端 `page_view` 是唯一证据，且覆盖率分母要排除它。
- 漏斗统计必须用嵌套子集口径（`interacted and viewed`），独立统计会算出负流失——见 README「三个值得单独说的设计决策」。

## 部署

发布动作由 WorkBuddy 桌面应用的运行时执行（对它说「发布应用」），**没有独立 CLI**，终端里喊「发布」发不出去。应用身份记在工作区根的 `.workbuddy/applications.yaml`（`name` + `locator`），不在仓库里；换目录发布会得到新应用和新域名。

## 领域文档

`GLOSSARY.md`（术语表）+ `docs/adr/` 是单一事实来源。改埋点口径看 `docs/analytics.md`，改 Agent API 看 `docs/agent-api.md`。

## Agent skills

### Issue tracker

Issues 存放在本仓库的 GitHub Issues（`wang-junjian/research-share`），通过 `gh` CLI 读写。 See `docs/agents/issue-tracker.md`.

### Triage labels

使用五个默认规范标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。 See `docs/agents/triage-labels.md`.

### Domain docs

Single-context 布局：根目录 `GLOSSARY.md` + `docs/adr/`。 See `docs/agents/domain.md`.
