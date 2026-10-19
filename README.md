# 研究成果分享站

一个服务于「把研究成果发到微信里给人看」这个具体场景的小站点。它只做四件事，但每件都做到底：

- **服务端渲染的列表页与详情页** —— 因为微信抓取分享卡片时不执行 JavaScript
- **每一条成果都有自己的一张分享封面图** —— 分享出去是带图的卡片，不是一条光秃秃的链接
- **Agent 读写接口** —— 用一行 curl 或一个脚本批量维护内容，不必登录后台点
- **自带埋点与数据看板** —— 知道访客从哪里来、看了什么、有没有点去原文

没有构建步骤，没有前端框架，没有 npm 依赖树。`node server.js` 就能跑。

```
┌──────────────────────────────────────────────────────────┐
│  公网访客（含微信内置浏览器）                              │
│    ├── /            列表页（SSR）                         │
│    ├── /item/:id    详情页（SSR + OG 标签 + 封面图）       │
│    └── /og/:id.png  分享封面图（运行时生成）               │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│  Node HTTP 服务（server.js，单文件路由）                   │
│    ├── HTML 渲染        ── 读取内容，拼完整 HTML            │
│    ├── /api/*           ── Agent 读写（token 鉴权）         │
│    └── /api/track       ── 埋点上报（永远 204）             │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│  云服务：数据库 + 登录                                     │
│    ├── research_items   ── 内容                           │
│    ├── agent_tokens     ── 写权限令牌（只存 SHA-256）       │
│    ├── research_events  ── 埋点明细（匿名不可直读直写）     │
│    └── 数据库函数        ── 所有写操作的唯一入口             │
└──────────────────────────────────────────────────────────┘
```

---

## 快速开始

### 方式一：先看界面（零配置，30 秒）

```bash
git clone https://github.com/wang-junjian/research-share.git
cd research-share
npm install
npm start
# 打开 http://127.0.0.1:3000
```

没有配置任何密钥时，服务会进入**演示模式**：

- 公开页面用 `data/sample-items.json` 里的 8 条示例数据渲染，样式、响应式、OG 标签全部是真实的
- 后台管理不可用（登录与看板都需要真实云服务）
- 所有写操作与埋点上报被丢弃，不会持久化 —— 这一点是刻意的，让你不会误以为写入成功了

### 方式二：接上自己的数据

**1. 创建云服务应用**

这个应用把数据与登录托管在云服务上（数据库 + 对象存储 + 用户登录）。创建一个应用后，你会拿到两个值：

| 值 | 用途 | 是否敏感 |
|---|---|---|
| `endpoint` | 数据面地址 | 否 |
| `publishableKey` | 公开客户端标识，服务端强制 Origin 校验 | 否 |

这两个值本身不带权限语义，但仍应通过环境变量注入，不要写死在源码里 —— 一份写死的 key 会让所有 clone 仓库的人都连到同一个数据库。

注意 `endpoint` 就是应用自己的域名（`https://<前缀>.app.workbuddy.host`），它要发布之后才存在 —— 所以第一次部署免不了「先发布拿域名，再填配置发布一次」，见文末「首次部署」。

**2. 执行迁移**

按顺序在云服务的 SQL 控制台执行，全部是幂等的：

```
db/01-research-items.sql   内容表、管理员表、is_admin()
db/02-agent-api.sql        agent_tokens、四个读写函数
db/03-analytics.sql        埋点表、track_event()、analytics_dashboard()
db/04-track-event-version.sql   track_event() 接入口径版本
db/05-founder-admin.sql    初始管理员：is_founder 列、is_founder()、任命权收窄 + 种子
db/06-doc-items.sql        文档型成果：kind/doc_html 两列 + CHECK，agent_upsert_item 升级
db/07-funnel-interacted.sql     漏斗 interacted 口径收窄为只计 select_content（v2）
db/08-track-event-overload.sql  收掉 track_event 旧签名重载 + 权限收敛
```

**3. 初始管理员**

管理员任命权收归「初始管理员」独占（ADR-0003）：只有初始管理员能任命或移除管理员，普通管理员只能管理成果与看板。`db/05` 会把种子 user_id 标为初始管理员——**clone 本仓库自建部署时，先把 `db/05` 末尾的 user_id 换成你自己的**（登录一次后台，「管理员设置」里可见并复制），再执行迁移。

不执行这一步，后台能登录但没有任何写权限，也看不到「数据看板」页签。

初始管理员不可经后台或 API 移除（RLS 拦截，含本人）。要交接时走一次性手工 SQL：

```sql
-- 顺序不能反：唯一索引要求全站至多一个 founder，先交权再授权
begin;
update public.admins set is_founder = false where user_id = '<你自己>';
update public.admins set is_founder = true  where user_id = '<接任者>';  -- 须已是管理员
commit;
```

**4. 配置并启动**

```bash
cp .env.example .env
# 填入 CLOUD_ENDPOINT、CLOUD_PUBLISHABLE_KEY、SITE_URL
npm start
```

---

## 三个值得单独说的设计决策

### 1. 分享卡片必须在服务端生成，没有第二条路

微信抓取链接预览时**不执行 JavaScript**。它只发一个普通 HTTP 请求，从返回的 HTML 里读 `og:title` / `og:description` / `og:image`，然后就走了。

这意味着任何客户端渲染的单页应用，在微信里分享出去都只有一条裸链接 —— 抓取发生时页面还是空壳。这不是优化问题，是能力问题。

配套的两条硬约束：

- **`og:image` 必须是绝对 URL。** 写 `/og/1.png` 会得到空白缩略图，微信不会替你补域名。
- **绝对 URL 不能靠请求的 `Host` 头拼。** 反向代理后面 `Host` 往往是内网地址，拼出来的地址微信访问不到。必须用一个显式配置的 `SITE_URL`。

### 2. 漏斗统计必须嵌套，否则会算出负流失

如果你把漏斗每一步按「到达该步的会话数」独立统计，看起来天经地义。但只要有人从分享链接**直接落在详情页**、跳过了首页，第三步的人数就可能超过第二步，流失率变成负数 —— 而界面还会把它标成「最大流失点，优先动这里」，等于给出反向建议。

正确做法是用标志位把每一步定义成上一级的**子集**，使各级单调不增：

```sql
select e.session_id,
       bool_or(e.event = 'select_content')                      as interacted,
       bool_or(e.event = 'view_item')                            as viewed,
       bool_or(e.event = 'outbound_click')                        as jumped
from research_events e
group by e.session_id
```

然后「详情页浏览」定义为 `interacted and viewed`，而不是单独的 `viewed`。另配一个 `direct` 计数，把「直接从分享链接落在详情页」的会话单独说明 —— 不藏着。

### 3. 写权限锁进数据库函数，不靠应用层自律

公开站点需要匿名可读，但绝不能匿名可写。给 `anon` 开放表的 `INSERT` 权限，等于把「谁能写」这件事交给客户端自律。

这个应用的结构是：`research_events` 与 `agent_tokens` **不建任何 policy，并已从 `anon` / `authenticated` 收回全部权限**，唯一写入口是 `SECURITY DEFINER` 函数。事件名白名单、属性白名单、三档频率控制全部发生在函数内部。

理由很直接：应用层可以被绕过（直接打接口就行），数据库层不能。

同样地，`analytics_dashboard()` 内部第一件事就是 `is_admin()` 判断 —— 鉴权只有一个点，不会漏。

---

## 目录结构

```
.
├── server.js              HTTP 服务与路由（入口：依赖注入装配，实现都在 lib/）
├── og-image.js            分享封面图生成（手写 PNG 编码，零原生依赖）
├── admin.html             后台管理页（模板，配置由服务端注入）
├── lib/
│   ├── render.js          SSR 拼 HTML（列表 / 详情 / 分享面板）
│   ├── items-store.js     内容读写与条目身份派生（ADR-0001 的深模块边界）
│   ├── agent-api.js       /api/* 写接口
│   ├── track.js           埋点上报与 SSR page_view
│   ├── static-files.js    静态资源
│   ├── http.js            sendJson / sendHtml
│   ├── demo-cloud.js      演示模式的数据适配层
│   └── load-env.js        极简 .env 加载器（零依赖）
├── assets/
│   ├── style.css          全站样式
│   ├── admin.js           后台逻辑
│   ├── analytics.js       数据看板渲染
│   ├── share.js           分享交互（链接、海报、纯文本）
│   ├── track.js           埋点采集层
│   ├── cloud.js           云服务客户端初始化
│   ├── auth-chip.js       公开页顶栏登录态（读会话，替换「登录」入口）
│   └── vendor/
│       ├── fonts/         自托管字体（不依赖外部 CDN）
│       └── workbuddy-cloud-sdk.global.js
├── .env.example           配置样例（真实 .env 不进仓库）
├── db/                    数据库迁移（01 → 08，均幂等）
├── data/
│   └── sample-items.json  演示模式示例数据
├── docs/                  接口说明与埋点设计
└── scripts/
    ├── preflight.sh       发布前自检（配置 / 语法 / 真实数据 / 非演示模式）
    ├── smoke.sh           Agent 接口冒烟测试（跑完不留数据）
    └── probe-anon.mjs     以应用进程身份试探库的权限边界（只读 + 三条应失败的写）
```

字体与 SDK 都是自托管的，页面不请求任何外部域名。这不是洁癖：`<link>` 引外部字体时，浏览器要额外做一次 DNS + TLS 握手，中文站点的首屏往往就卡在这一步；而且外部 CDN 挂掉时页面会闪一下无衬线体。

---

## HTTP 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/` | 无 | 列表页（SSR，杂志特稿版式：刊头 + 头条 + 双栏编号） |
| GET | `/item/:id` | 无 | 详情页（SSR，带 OG 标签） |
| GET | `/og/:id.png` | 无 | 分享封面图 |
| GET | `/admin` | 登录 | 后台管理 |
| GET | `/api/health` | 无 | 健康检查 |
| GET | `/api/items` | 无 | 内容列表（JSON） |
| POST | `/api/items` | token | 新增一条 |
| POST | `/api/items/batch` | token | 批量写入（按 `source_key` 幂等） |
| PATCH | `/api/items/:id` | token | 修改一条 |
| DELETE | `/api/items/:id` | token | 删除一条 |
| POST | `/api/track` | 无 | 埋点上报，**永远返回 204** |

写操作的认证用 `X-Agent-Token: <token>`。详见 [docs/agent-api.md](docs/agent-api.md)。

接口调通了别只信返回码：`bash scripts/smoke.sh` 会把三条认证通道和主要写操作各跑一遍，跑完不留数据（需要 token，见脚本头部）。

有一个坑值得提前知道：**不要用 `Authorization: Bearer`。** 平台的边缘代理会把这个请求头吃掉，线上会得到 `401 missing_token`。这个问题在本地直连时不会出现，只在线上暴露。

---

## 埋点

8 个事件，全部小写加下划线，动词在后：

| 事件 | 触发时机 | 关键属性 |
|---|---|---|
| `session_start` | 新会话第一次上报 | `ref_kind`（来源类型） |
| `page_view` | 页面加载（**客户端与服务端各记一条**） | `page`、`source` |
| `view_item` | 打开详情页 | `item_id` |
| `select_content` | 列表页点击卡片 | `item_id` |
| `outbound_click` | 点击「查看原文」 | `item_id` |
| `share` | 点击任一分享按钮 | `method`（5 个值） |
| `error` | 前端捕获到异常 | `code` |
| `content_publish` | 内容发布 | `item_id` |

`page_view` 记两条是有意的：服务端那条代表「页面确实被送到了浏览器」，客户端那条代表「脚本确实跑起来了」。两者之比就是**埋点覆盖率** —— 如果只有客户端一条，脚本因报错没加载时你什么都看不到，数据会静默变少。

服务端那条**刻意不带 `session_id`**。带上它会撞掉客户端那条的 3 秒去抖，覆盖率恒为 1，这个指标就废了。

设计细节与口径定义见 [docs/analytics.md](docs/analytics.md)。

---

## 部署

### 平台托管发布（app.workbuddy.host）

**发布动作由 WorkBuddy 运行时执行，没有独立 CLI。** 在 WorkBuddy 桌面应用里打开本工作区，对它的智能体说一句「发布应用」即可；在 VSCode、终端等其他环境里喊「发布」是发不出去的。

**应用身份记在工作区，不在仓库里。** 工作区根的 `.workbuddy/applications.yaml` 存着 `name` + `locator`（即 appId），`~/.workbuddy/cloudstudio-deploy-history/` 里另有一份以 `sha256(目录绝对路径)[:16]` 为键的发布记录。发布时按这两处找回应用，所以：

- 换目录、换机器发布会**创建一个新应用**，拿到新域名 —— 别人已经收到的旧链接会失效。
- 想让已有应用跟着某个目录走，先确认那个工作区的 `applications.yaml` 里写着对应 `locator`，再从该工作区发布。
- `.wbapp_<appId>.genie` 是发布**之后**写出来的标记（给应用列表用的），不是发布时的输入；复制它、改它的 `localDir` 都不会迁移身份，实测无效。

所以要在一台新机器上继续维护**同一个**应用，就是把它的 `locator` 写进那个工作区：

```yaml
# <工作区根>/.workbuddy/applications.yaml
applications:
  - name: 研究成果分享
    locator: wbapp_你的appId        # 从「设置—数据管理—应用」或发布记录里取
```

文件写好后，从该工作区发布一次就会认领回原来的应用和域名。不写，那就是一个新应用。

发布前的自检跑一遍即可：

```bash
./scripts/preflight.sh
```

它会检查 `.env` 三项配置、两个入口文件的语法，然后真起一次服务——只有读到真实数据、且不是演示模式才算通过。这一步不能省：缺配置时页面照样返回 200，只是内容悄悄变成示例数据。

### 首次部署（新用户）

`clone` 下来发布，得到的会是你自己的应用和域名，这是正常路径，不需要任何额外配置：

```bash
npm install && npm start     # 演示模式，先确认界面能跑
```

要接上真实数据：

1. 接入云服务，按顺序执行 `db/01` → `db/08`（`db/05` 末尾的初始管理员 user_id 先换成你自己的）
2. 填 `.env`：`CLOUD_ENDPOINT`、`CLOUD_PUBLISHABLE_KEY`、`SITE_URL`
3. 发布 → 得到 `https://<你的前缀>.app.workbuddy.host`
4. **再发布一次**：把 `CLOUD_ENDPOINT` 和 `SITE_URL` 改成上一步拿到的域名

第 4 步不能省，原因有两个：云服务的 `endpoint` 就是这个应用域名，而域名要发布后才存在；`SITE_URL` 决定 `og:image` 的绝对地址，写错微信就抓不到封面图。

另外 `/admin` 的登录和写操作是浏览器直连云服务的，请求带的是**站点域名**的 `Origin`，白名单里没有该域名会失败。这条建议在部署后自己登录一次确认。

### 发布后的验收

```bash
curl -s https://<你的域名>/api/health              # count 应等于你库里的条数，不是 8
curl -s https://<你的域名>/og/1.png -o /dev/null -w '%{http_code} %{size_download}\n'   # 200，约 5.9KB
```

只看 200 是不够的——演示模式也返回 200。

### 微信分享的三条现实约束

- **换成自己的域名时，若服务器在中国大陆需要备案**，未备案的域名在微信里打开会被拦截。用平台托管的 `app.workbuddy.host` 则不经这一步。
- **改完 OG 标签后，微信有缓存。** 同一个 URL 的卡片可能几分钟到几小时不更新。调试时换一个查询串（`?v=2`）可以绕过缓存看到新结果。
- **分享卡片的高度是微信控制的，不是 CSS 控制的。** 标题最多两行、描述最多两行，超出部分会被截断，不要指望通过在描述里写长文来传递信息。

---

## 已知边界

这个项目刻意只做一件事，所以下面这些**没有**实现，不是遗漏：

- 没有评论、点赞、收藏等互动功能
- 没有搜索（内容量在几十到几百条时，列表本身就够用）
- 埋点不采滚动深度与停留时长 —— 这两个指标的解释成本远高于它的信息量，采了容易得出「用户很投入」的错误结论
- 后台不做内容审核流，因为写入口本来就只有受信任的 agent 与管理员
- **文档型成果只收不含脚本的静态 HTML。** 请求体里出现 `<script` 或内联事件属性（如 `onclick=`）时，
  平台边缘的 WAF 会直接返回 403 拦截页（HTML，不是本站的 JSON），请求到不了应用——浏览器直写与
  Agent API 两条通道同此限制，应用侧表达不了这个错误码。所以「＋ 分享」在提交前就拦下并说明原因；
  图表等交互内容请在发布前渲染成静态 SVG / 图片

---

## License

MIT，见 [LICENSE](LICENSE)。

字体（Archivo、Instrument Serif）来自 Google Fonts，采用 SIL Open Font License 1.1。

---

## English

A minimal, server-rendered site for sharing research notes inside WeChat.

WeChat's link-preview crawler **does not execute JavaScript**, so any client-rendered SPA shared in WeChat shows up as a bare link. This project solves that by rendering every page on the server, generating a per-item cover image at request time, and emitting absolute `og:*` URLs from an explicitly configured `SITE_URL`.

Beyond that it provides an agent-facing read/write API (`X-Agent-Token`, not `Authorization: Bearer` — the edge proxy strips the latter), and a self-hosted analytics pipeline with eight events, a nested funnel, and a dashboard that talks directly to the database via RPC.

```bash
git clone https://github.com/wang-junjian/research-share.git
cd research-share && npm install && npm start
```

Runs in read-only demo mode with sample data when no cloud credentials are configured. To connect real data, apply `db/01` → `db/08`, fill in `.env`, and put your own user id in the founder seed at the end of `db/05` before running it.

Key design decisions are documented in Chinese above and in [`docs/analytics.md`](docs/analytics.md).
