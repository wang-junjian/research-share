# 「研究成果」数据埋点与看板设计方案

> 这份文档是一份**可独立复用的设计基线**：它先讲清为什么这么设计，再给出可执行的 SQL 与接口。
> 文中所有「实测」字样后的数字都来自真实运行结果。实现层面的偏差修正集中记录在 §14.1，
> 建议实现前逐条读一遍 —— 那六条都是「写错了也能看起来在工作」的地方。

> 状态：**待评审**。本文只做设计，未改动站点、未建表、未发布。
> 配套：`dashboard-preview.html`（自包含单文件看板原型，模拟数据 + 真实条目标题）

---

## 0. 一句话方案

**自建一套「服务端兜底 + 客户端补交互」的轻量埋点**，原始事件落一张表，看板聚合走 `SECURITY DEFINER` 函数（管理员校验），管理后台加一个「数据看板」页签，回答六个问题：**火不火 / 谁在看 / 看什么 / 看到了什么程度 / 会不会再来 / 分享有没有用**。

不引入任何第三方（GA、Umami、Plausible、神策）——理由见 §1。

---

## 1. 为什么自建，而不是接第三方

| 候选 | 否决理由 |
|---|---|
| Google Analytics 4 | 境内不稳定；微信内直接打不开；需要外部脚本，违背本站「零外部请求」的架构 |
| Umami / Plausible 自建 | 要另开一个服务 + 一个数据库，为一个 37 条内容的个人站不值当 |
| 神策 / GrowingIO 等 SaaS | 面向企业，要账号、要埋 SDK、要钱；数据出域 |
| 平台自带统计 | 当前平台只提供应用运行指标（启动、错误），不提供访客行为 |

而且**本站的技术前提已经决定了答案**：数据库、SSR 服务、登录体系都是现成的；埋点表就是第 4 张表，看板就是后台第 2 个页签。自己做的边际成本最低，且数据不出你自己的库。

---

## 2. 借的行业方法（哪条来自哪里）

| 实践 | 来源 | 落到本站的做法 |
|---|---|---|
| **事件-属性二级模型**，全站统一事件字典 | GA4 事件模型 / 国内埋点规范（神策、GrowingIO 系列） | §5 事件字典；事件名小写+下划线、动词在后（`outbound_click` 而非 `click_outbound`） |
| **公参 + 事件私有属性分离** | 埋点规范通用做法 | `visitor_id / session_id / device / ref_kind / app_version` 等公参由采集层统一注入，业务代码不手传 |
| **关键事件双端埋点**：客户端补交互细节，服务端保数据完整 | 行业标准（客户端埋点会被 JS 失败/广告拦截吃掉） | `page_view` **两端都埋**：SSR 渲染时服务端写一条权威记录，客户端再补一条带身份的记录。两者之差 = 埋点覆盖率（§9-J） |
| ~~GA4 enhanced measurement 的 scroll / engaged session 口径~~ | GA4 | **本轮未采用**（你选择不采停留时长与滚动深度）。留作将来加回「有效阅读数」时的现成口径 |
| **用 `share` + `method` 维度，而不是 5 个事件名** | GA4 recommended events (`share`) | 5 个分享按钮 = 1 个事件 × 5 个 method 值，看板天然可分组 |
| **漏斗 + 留存 + 来源归因三件套** | AARRR / 内容站分析惯例 | 看板 D/E/F/H 区块 |
| **HEART 框架的「投入度」维度** | Google HEART | 北极星不取 PV，取最接近「真读进去了」的动作（见 §3） |
| **埋点数据质量四维：准确/完整/一致/可追溯** | 埋点治理实践 | `app_version` 公参 + §9-J 健康度面板 + 断流预警 |
| **首日就设排除自己人** | GA4 常见错误清单 | `exclude` 机制：管理员/开发者的 visitor_id 打标，看板默认剔除（§8） |

---

## 3. 北极星指标

**原文跳转数（outbound_click）** —— 点击「查看原文 ↗」或详情页原文链接的次数。

**为什么不是 PV / UV**：本站的价值是「他写的成果有没有被真正读进去」。UV 会因一次转发虚高，PV 会被「切了网格/列表」这类无意义翻页灌水。而「点开了原文」在本站是**唯一一个必须真有兴趣才会发生的动作**——他真正的产出在原文那一边，人没点过去，就等于没读到。

**为什么不选「有效阅读数」（详情页停留 ≥15 秒）**：那是更贴的北极星，也是我原本的首选，但它依赖采集浏览时长。本轮你选择**不采集停留时长与滚动深度**，因此方案退回到「可用信号里最强的那个」。

> 补记：将来若想加回「有效阅读」，只需补两个事件（`engaged_read`、`scroll`）并在看板加一列，**数据模型与表结构都不用动**。

一句话结论：**「N 个人来了，M 次点开了详情，其中 X% 顺着走进了原文。」**（跳转率 = `outbound_click` ÷ `view_item`）


---

## 4. 数据模型

### 4.1 事件表 `research_events`

```sql
create table if not exists public.research_events (
  id           bigserial primary key,
  occurred_at  timestamptz not null default now(),   -- 事件发生时间（客户端为触发时刻，服务端为处理时刻）
  event        text not null,                        -- 白名单事件名，见 §5
  source       text not null default 'client',       -- client | server
  app_version  text not null default 'v1',           -- 埋点版本，改口径时递增，可追溯

  -- 身份（匿名）：均不带任何真实身份信息
  visitor_id   text,            -- 一年期随机 id（localStorage / cookie 双写）
  session_id   text,            -- 30 分钟不活动即过期的会话 id

  -- 语境
  item_id      bigint references public.research_items(id) on delete set null,
  page         text,            -- '/' | '/item/12'
  referrer     text,            -- 截断 200 字
  ref_kind     text,            -- wechat | zhihu | search | direct | internal | other
  device       text,            -- mobile | tablet | desktop
  os           text,
  browser      text,
  is_bot       boolean not null default false,
  ip_hash      text,            -- sha256(ip + 站点盐) 前 16 位，**不可逆**，只用于去重与风控
  props        jsonb not null default '{}'::jsonb,   -- 只允许白名单键，见 §5.3
  created_at   timestamptz not null default now()
);

create index on public.research_events (occurred_at desc);
create index on public.research_events (item_id, occurred_at desc);
create index on public.research_events (event, occurred_at desc);
create index on public.research_events (visitor_id);
create index on public.research_events (session_id);

alter table public.research_events enable row level security;
-- 关键：不建任何 policy。anon / authenticated 都读不到原始事件，
-- 只有 SECURITY DEFINER 函数能写入、只有管理员聚合函数能读出。
```

**为什么没有 `owner_id`、也没有给 `authenticated` 任何 policy**：埋点是**访客**行为，不是登录用户的行为，按人隔离没有意义；而原始事件含 `ip_hash` 与完整路径，属于「可以看聚合、不必看明细」的数据。明细只在实时流里露出最近 20 条，且已经过脱敏（§9-I）。

### 4.2 写入函数 `track_event`（唯一公开写入口）

```sql
create or replace function public.track_event(
  p_event text, p_visitor text default null, p_session text default null,
  p_item bigint default null, p_page text default null, p_referrer text default null,
  p_device text default null, p_os text default null, p_browser text default null,
  p_props jsonb default '{}'::jsonb, p_source text default 'client', p_ip text default null
) returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_event text := lower(coalesce(p_event,''));
begin
  -- 1. 事件名白名单，不认识的直接丢弃（不报错，避免暴露字典）
  if v_event <> all (array['session_start','page_view','view_item','select_content',
                         'change_view_mode','outbound_click','share','session_end',
                         'error','content_publish']) then return; end if;

  -- 2. 属性白名单 + 类型收敛：只留已知键，字符串一律截断
  --    （未知键直接丢掉，杜绝把事件表当 KV 存储写）
  ...
  -- 3. 身份格式校验：只接受 8~64 位 [A-Za-z0-9_-]
  -- 4. item_id 必须真实存在，否则置 null
  -- 5. 频控：同 (session, event, item) 在 3 秒内只落一条 → 去抖
  -- 6. 单会话事件上限 500 条，超过即丢弃（防刷）
  insert into research_events (...) values (...);
end $$;

revoke all on function public.track_event(...) from anon, authenticated, public;
grant execute on function public.track_event(...) to anon;   -- 服务端是 anon 身份
```

**诚实说明一个边界**：这个函数必须授予 `anon`（服务端进程就是 anon 身份），而 `publishableKey` 事实上是公开的（任何人 `GET /admin` 的 HTML 里就内联着它）。所以**埋点通道是一条公开的低信任通道**——这是所有客户端埋点的共同宿命，不是本方案的缺陷。因此：

- 防护目标是**驱散噪音**（爬虫、误触、脚本乱灌），不是对抗定向攻击；
- 每条指标在看板上都标注样本量与「可被污染」的前提；
- 原始事件全量**永久保留**（按你的选择），异常可回溯清洗。

### 4.3 读取函数 `analytics_dashboard(p_days int)`（管理员专属）

```sql
create or replace function public.analytics_dashboard(p_days int default 30)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  -- 时区口径统一在 Asia/Shanghai，服务端一次性算完
  return jsonb_build_object(
    'range',    ..., 'overview',  ..., 'trend',   ...,
    'items',    ..., 'funnel',    ..., 'sources', ...,
    'devices',  ..., 'share',     ..., 'retention', ...,
    'recent',   ..., 'quality',   ...
  );
end $$;
revoke all on function public.analytics_dashboard(int) from anon, public;
grant execute on function public.analytics_dashboard(int) to authenticated;
```

**为什么聚合放在函数里、而不是前端拉原始事件自己算**：① 原始事件不能给任何人 SELECT（§4.1）；② 明细会随天数线性膨胀，前端算不出全量；③ 一次性返回一个 `jsonb`，看板只发 **1 个请求**、只渲染一次，也符合本站零构建的风格。

### 4.4 保留策略

**原始事件永久保留**（按你的选择）。低流量下一年也就几十万行，`occurred_at` 上有时序索引，聚合函数不受影响。

代价要说清：明细长期堆积意味着 `analytics_dashboard` 的窗口外查询（回访归因要扫全表算每个访客的首次到访）会随年限变慢。**触发条件是可量化的**：当表超过约 500 万行、或看板首屏超过 1.5 秒时，再补每日汇总表 `research_stats_daily` 与 `analytics_purge`，届时数据模型不用改，只加读取路径。


---

## 5. 事件字典

### 5.1 事件清单（共 9 个）

| # | 事件名 | GA4 对应 | 触发时机 | 私有属性 | 端 |
|---|---|---|---|---|---|
| 1 | `session_start` | session_start | 新会话的首个事件之前 | `landing` | C |
| 2 | `page_view` | page_view | 页面 `load` 后（客户端）／SSR 渲染时（服务端） | `title` | **S + C** |
| 3 | `view_item` | view_item | 详情页可见（同会话同条目 3 秒内去抖） | `item_id, from` | C |
| 4 | `select_content` | select_content | 首页卡片点击后跳转前 | `item_id, position, view_mode` | C |
| 5 | `change_view_mode` | — | 网格/列表切换 | `to` | C |
| 6 | `outbound_click` | click (outbound) | 点「查看原文 ↗」或详情页原文链接 | `item_id, dest_host` | C |
| 7 | `share` | **share** | 点任一分享按钮（成功或降级都记） | `method, degrade, item_id` | C |
| 8 | `error` | — | `window.onerror` / 资源加载失败 / 服务端 5xx | `kind, msg` | S + C |
| 9 | `content_publish` | — | 新成果落库成功后（`research_items` 的 AFTER INSERT 触发器） | `item_id` | **S** |

`share` 的 5 个 `method` 取值，与现有按钮一一对应：`copy_link` / `copy_text` / `show_poster` / `copy_poster` / `copy_poster_link`。
—— 这一条会直接回答一个悬了很久的问题：**5 个分享按钮里，哪几个是真的被用了、哪几个是摆设。**

**本轮明确不采集**：滚动深度（`scroll`）、浏览时长（`engaged_read`）——按你的选择。

**`session_end` 已从字典中去掉**（原表第 8 项）。理由：会话边界由「30 分钟不活动」定义，
而 `pagehide` 只代表页面卸载、不代表会话结束——两者不是一回事，记下来反而会制造一个漂亮的错数。
`session_end` 原本携带的 `pages`（本会话浏览页数）可由同会话的 `page_view` 条数直接算出，
属于冗余字段。数据库的 `track_event` 白名单同步只接受上表 9 个事件，
发 `session_end` 会被计入「不认识的事件名」而不是静默入库（见 §14.1 第 4 条）。


### 5.2 公共属性（采集层统一注入，业务代码不手传）

| 属性 | 取值 | 说明 |
|---|---|---|
| `visitor_id` | 随机 22 位 | 一年有效，localStorage 为主、cookie 兜底（SSR 用得上） |
| `session_id` | 随机 22 位 | 30 分钟不活动即新建 |
| `device` / `os` / `browser` | 枚举 | 由 UA 解析，服务端统一做（客户端只负责送 UA） |
| `ref_kind` | `wechat\|zhihu\|search\|direct\|internal\|other` | 服务端归类，避免客户端口径漂移 |
| `app_version` | `v1` | 埋点版本号。**改口径必须递增**，否则跨版本趋势不可比 |
| `page` | 路径 | 不含 query，避免把搜索词/令牌带进库 |

### 5.3 `props` 白名单（防事件表被当垃圾场）

只接受：`method`(enum) `to`(enum) `view_mode`(enum) `position`(int 0–200) `dest_host`(host ≤64) `from`(enum) `kind`(enum) `msg`(≤120 字) `landing`(路径) `degrade`(bool) `q`(≤60 字，后台搜索用)。
其余键**静默丢弃**。枚举类字段值不在表内的，丢弃该键而非整条事件。
（`degrade` 是 `share` 用来标记「浏览器剪贴板不可用、退化成手动长按」的布尔位，看板的分享效力表要用它。）

### 5.4 明确不采集

真实的 IP（只存加盐哈希）、User-Agent 原文（只存解析后的 3 个枚举）、邮箱/昵称/用户 id、鼠标轨迹、输入内容、滚动位置、停留时长、任何跨站标识。后台管理页的**登录用户**不建画像——数据看板看的是访客，不是同事。

---

## 6. 采集层设计

```
浏览器                        Node 服务端（已存在）              数据库
────────                      ────────────────────              ──────
track.js (≈2.5KB, defer)
  ├─ 生成/读取 visitor_id、session_id
  ├─ 事件入内存队列，最多攒 10 条 / 3 秒
  ├─ sendBeacon('/api/track')  ──►  /api/track  ── 解析 UA/IP ──► track_event()
  ├─ 失败降级 fetch(keepalive)        ├─ 频控：单 IP 60 次/分
  └─ pagehide 时 flush                 ├─ bot UA 过滤
                                       └─ 立即 204（绝不让埋点拖慢页面）

SSR 渲染 /item/:id、/          ──►  直接调 track_event(source='server')
                                      └─ 无法被 JS 拦截吃掉，作为流量底盘
```

**几个刻意的选择**

1. **用 `sendBeacon` 而不是 `fetch`**：`sendBeacon` 在页面卸载时也能发出去，且不阻塞导航。降级顺序 `sendBeacon → fetch(keepalive) → 放弃`。
2. **立即返回 204，不等数据库**：埋点永远不该出现在用户的可感知路径上。写失败就丢，不重试（丢几条埋点 << 让用户等 200ms）。
3. **批量但不积压**：最多攒 10 条或 3 秒，`visibilitychange`/`pagehide` 强制 flush。
4. **服务端 SSR 也埋 `page_view`**：这是唯一能覆盖「JS 没跑起来」的流量（广告拦截、脚本报错、微信 X5 内核异常）。两个来源之差本身就是指标。
5. **同会话去抖**：详情页反复刷新不会把 `view_item` 刷爆；`scroll` 每档位每会话只报一次。
6. **对页面性能零影响**：`track.js` 用 `defer`，且**不注册任何会阻塞首绘的监听**（滚动监听用 `passive: true`，时间累计用 `IntersectionObserver` 而非 `setInterval`）。

---

## 7. 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `POST` | `/api/track` | 无（公开、低信任） | 埋点上报。请求体 ≤8KB，单次 ≤20 条事件。**永远返回 204**，不暴露任何校验细节 |

**看板数据不加 HTTP 接口**——后台页面本来就是登录态直连数据面（`admin.js` 现在就在直连 `research_items` / `admins`），看板同样直接调 RPC：

```js
cloud.database.rpc('analytics_dashboard', { p_days: 30 })
```

三个好处：① 服务端进程是 **anon** 身份，本来就没权限调这个函数，绕一层代理只会更绕；② 鉴权交给函数内的 `is_admin()`，**单点判定**，不会出现「接口层放行了、函数层没拦住」的缝隙；③ 少一个公开接口面。

埋点接口遵守现有约定：CORS 放开（无 cookie 凭证语义）、`Cache-Control: no-store`。

---

## 8. 反作弊与排除

| 手段 | 做法 |
|---|---|
| Bot 过滤 | UA 正则（`bot\|spider\|crawl\|preview\|headless`）+ `navigator.webdriver` + 无 `sec-fetch-*` 头的请求，标 `is_bot=true`（**标记而非丢弃**，看板可切换查看） |
| 频控 | 单 IP 60 次/分钟、单会话 500 条；超出静默丢弃并计数（看板显示丢弃量） |
| 去抖 | 同 (session, event, item) 3 秒窗口去重 |
| 排除自己人 | 管理员在后台点一次「排除本机」→ 该 `visitor_id` 写入 `analytics_exclude` 表，看板默认剔除；再点一次取消。**P0 就要有**：否则第一天的数据就是你自己刷出来的 |
| 代理/预览 | 只允许 `Origin`/`Referer` 为本站或空（`sendBeacon` 可能不带 Referer）；托管平台的临时预览域名直接丢弃 |
| 明显异常 | 单事件类型日均超过历史 P99 的 5 倍 → 健康度面板红标（人看，不自动清洗） |

---

## 9. 看板信息架构

固定头部：**时间范围（今天 / 7 天 / 30 天 / 90 天）+ 对比上一周期 + 数据新鲜度（最后一条事件距今）+ 时区说明（Asia/Shanghai）**。
区块划分与原型（`dashboard-preview.html`）逐块对应。

### A. 核心指标（6 张卡）
访客数 · 会话数 · 页面浏览 · **原文跳转数（北极星，带 ★ 标记）** · 原文跳转率 · 分享次数
每张卡：数值 + 环比徽标（涨用朱红、跌用绿，与站点强调色一致）+ 迷你趋势线。
> 每张卡右下角标样本量；`n < 30` 时打「样本少」灰标，避免在小样本上读出假趋势。**在 3 个访客上谈 50% 增长是自欺。**

### B. 流量趋势（双轴）
左轴访客（柱）、右轴页面浏览（折线）——两个量级差 4 倍，同轴会把柱子压成方块。
淡色竖带标出**当天发布了新条目**，并在图下直接给出「发布次日访客均值 vs 非发布日均值」，把内容动作和流量变化的因果摆在同一张图上。

### C. 行为漏斗与分享效力（并排）
- **漏斗**：`会话 → 首页有交互 → 详情页浏览 → 原文跳转`，每两级之间标流失人数与流失率，**最大流失点用朱红标出**——那是唯一需要立刻动的地方。分叉终点（原文跳转 / 分享）另起一行。
- **分享效力**：5 个 `method` 的点击数、占比、**降级次数**。微信内 clipboard 不可用会退化成弹层，这一列直接回答「5 个按钮里哪几个是摆设」。

### D. 内容表现（可排序表格）
`编号 · 标题 · 详情浏览 · 原文跳转 · 跳转率 · 分享 · 最近被看`（详情浏览列带迷你条形）。
两个诊断标签是重点：
- **「有曝光无人点」**：首页出现却零点击的条目 → 标题/概览没抓住人，是内容问题不是流量问题。零点击条目在表尾**单独成段**列出，不藏在 Top N 之外。
- **「点开不跳转」**：`view_item` 高但跳转率低 → 概览没让人产生「必须看原文」的动机。
表头写清：`37 条中 N 条被读过 · 头部 3 条占全部阅读的 X%`（长尾集中度）。

### E. 来源、设备与回访（并排）
- 来源分类排行（直接 / 知乎 / 站内 / 搜索引擎 / 微信 / 其他）+ 设备堆叠条 + 浏览器占比。
- 新访客 vs 回访访客、**回访率趋势**，并给一句可执行的判断（例：「回访率 28%，落在内容站 20–35% 区间偏低 → 首页应更像索引而不是引导页」）。
> 低流量期不画留存矩阵（每格样本个位数，看着专业其实没有信息量），只给趋势与占比。

### F. 实时与埋点健康度（并排）
- **实时**：最近 30 分钟活跃访客 + 今日分时柱 + 最近事件流（已脱敏：只有时间、事件名、条目编号、设备与来源分类，**不含 IP / UA / 身份**）。
- **健康度（先证明数据可信，再谈结论）**：埋点覆盖率（客户端 `page_view` ÷ 服务端 `page_view`）· 被丢弃事件数（频控/白名单/去抖各多少）· bot 占比 · 事件量突变预警。埋点版本 `app_version` 分布也放这里，防止新旧口径混算。

### G. 空数据形态（跨区块要求）
上线第一天看板必须好看地空着：每个区块都有明确空状态文案（例：「还没有数据。埋点从今天开始记录，明早这里会有第一份完整趋势。」），而不是一整屏 `0` 或报错。


---

## 10. 隐私与合规

- **不采集个人信息**：只有随机 visitor_id 与哈希 IP，且哈希不可逆（加站点盐）。按《个人信息保护法》口径，这属于「去标识化」而非个人信息。
- **不跨站追踪**：visitor_id 只在本站使用，不做任何第三方共享、不接任何外部脚本。
- **数据留在自己库里**：全部在应用自己的云数据库内，无出域。
- **可退出**：详情页页脚加一行极简说明（「本站使用匿名的访问统计，不记录个人信息」），并提供一键退出（写 localStorage 后 track.js 不再上报）。
- **保留策略透明**：事件永久保留（你的选择），同时明确写出「什么时候该加汇总表」的量化条件（§4.4），不让「先这样」变成「一直这样」。

---

## 11. 分期实施

| 阶段 | 内容 | 验收断言 |
|---|---|---|
| **P0**（本轮） | 建表 + `track_event` + `analytics_dashboard` + `/api/track` + `track.js`（10 个事件全埋）+ 分享接入 + 后台「数据看板」页签（A–F 六块，含「排除本机」） | 本地真实浏览器**零 pageerror / console.error / requestfailed**；事件真落库且字段正确；看板数值与手算逐项一致；非管理员调 RPC 得 `forbidden`；anon 直读事件表得 `42501`；连续两次访问不产生重复 `view_item` |
| **P1**（按需触发） | 事件表长期化后的每日汇总、报表导出、周报推送（企业微信 / 邮件） | 汇总值与原始事件重算结果逐项吻合 |

**P0 先行**的理由：先拿到真数据，再决定要不要为「留存矩阵」「路径分析」这类重活写代码。**没有数据支撑的看板设计都是猜。**

P1 的触发条件是量化的：事件表 > 500 万行，或看板首屏 > 1.5 秒。

---

## 12. 已知取舍（请重点看这三条）

1. **低信任通道**：§4.2 已说明，埋点可被伪造。缓解是「标注 + 回溯清洗 + 不用于对外汇报的硬数字」，不是「杜绝」。
2. **低流量统计显著性**：本站日访客大概率是两位数甚至一位数。看板会把「环比」「百分比」在小样本下打灰标，并优先展示绝对数——**在 3 个访客上谈 50% 增长是自欺**。
3. **不做点击热力图 / 会话录屏 / 停留时长**：需要采集坐标、DOM 结构与持续计时，隐私代价和实现成本都不匹配这个站的价值。按你的选择，本轮连滚动深度与停留时长都不采——代价是看板上**看不到「他读了多久」**，只能看「他有没有点进原文」。这是知情下的取舍，不是遗漏。
4. **看板会在低样本下打灰标**：日访客两位数时，「环比 +30%」的绝对值可能只差 4 个人。看板在所有百分比旁保留绝对数，并给小样本加标记——**让数字体面，但不让它骗人**。

---

## 13. 原型与实测

**`dashboard-preview.html`**（本目录）是一份**自包含单文件原型**：内联了站点真实的 `style.css` 与三个自托管字体，条目标题取自线上真实的 37 条内容，模拟数据由 `build-preview.py` 生成——所有指标从**同一份日粒度数据**推导，不存在自相矛盾（漏斗、KPI、趋势、排行互相可验算）。

实测（真实 Chrome，`file://` 直开，三个断点各跑一遍）：

| 项 | 结果 |
|---|---|
| JavaScript 报错 / console.error / 请求失败 | **0 / 0 / 0** |
| 外部请求 | **0**（字体已 base64 内联，离线可开） |
| 文档级横向溢出 @1440 / 1280 / 390 | 无 / 无 / 无（表格在窄屏内部滚动） |
| 衬线字体加载 | 是（`document.fonts.check('16px "Instrument Serif"')` 通过） |

**实施时要注意的两点**

1. **新增 CSS 的 `.topbar` 相关规则必须收窄作用域**。原型里为了移动端而写的 `.brand-name { display: none }` 若直接进 `style.css`，会连**公开页顶栏**一起改掉。落地时用 body 上的 class（如 `body.page-admin`）限定。
2. **图表按容器实测宽度渲染**（原型即如此，含 debounce 的 resize 重绘）。不要用 `viewBox` 缩放——窄屏会把轴标签一起缩到 4px，等于没有标签。

---

## 14. 决策记录（2026-10-16 已拍板）

| # | 问题 | 你的选择 | 对方案的影响 |
|---|---|---|---|
| 1 | 实施范围 | **只做 P0** | 本轮交付 §11 的 P0 全部内容；P1 按量化触发条件再启 |
| 2 | 参与度埋点（滚动深度 + 停留时长） | **不采** | 事件字典去掉 `scroll` / `engaged_read`（11 → 10 个）；**北极星由「有效阅读数」改为「原文跳转数」**（见 §3）；看板不出现「平均停留 / 滚动到达率」 |
| 3 | 数据保留 | **永久保留** | 去掉 `analytics_purge`；§4.4 给出后续加汇总表的量化触发条件 |
| 4 | 是否埋「内容发布」事件 | **埋** | 增加 `content_publish`，由**服务端**在落库成功后记录（agent API 与后台录入各一处）；趋势图上标出发布日并计算发布次日增量 |

**本轮（P0）交付清单**

- 数据库：`research_events`（无 policy）、`analytics_exclude`、`track_event()`、`analytics_dashboard()`
- 服务端：`POST /api/track`、SSR 侧 `page_view`、落库后 `content_publish`、页面注入 `track.js`
- 前端：`assets/track.js`（10 个事件）、`share.js` 接入 `share` 事件、后台「数据看板」页签（A–F + 排除本机）、`style.css` 追加 `.an-*` 样式

---

## 14.1 实现阶段的口径修正（2026-10-16 实测发现）

三处是**实现时才暴露**的问题，都已改在代码里，记在这里以免下次重蹈。

### 1. 漏斗必须是「嵌套」的，不是「各步到达数」并列

§C 当初写的是 `会话 → 首页有交互 → 详情页浏览 → 原文跳转`，实现时按「各步到达的会话数」并列统计。
第一版真数据一跑就露馅：**7 → 3 → 6 → 3**——一个访客从分享链接直接落在详情页，没有「首页有交互」，却在「详情页浏览」里被计入。
后果不只是形状难看：流失量算成 **-3 个会话、-100%**，而 UI 上还郑重标着「最大流失点，优先动这里」——等于给出一个反向建议。

**改法**：用按会话聚合的标志位 CTE 把嵌套关系写进数据本身，第 N 级 ⊆ 第 N-1 级，
所以各级必然单调不增、流失必然非负（对账脚本里加了一条「单调性」断言盯着它）。

**但嵌套会带来新的误读风险**：这条链从「首页有交互」起算，天然漏掉**直接从分享链接落在详情页**的会话。
实测数据集里 9 个会话有 6 个属于这一类——若不说出来，「67% 流失在首页」就是纯粹的误导。
所以 `funnel` 返回值里同时给出 `direct` 计数，漏斗下方固定展示一行：
「另有 N 个会话是直接从分享链接落在详情页的，没经过首页（上面这条链不含它们）。首页的流失率要跟这个数一起看。」

> 设计原型没发现这个坑，是因为 `dashboard-preview.html` 的 mock 漏斗是**按百分比造的**（100% → 59.9% → 50.5% → 25.1%），
> 天然单调。**用百分比造出来的假数据，验不出集合关系上的错。**

### 2. 来源归因必须写显式 tie-break，否则同一次查询结果会飘

原先的写法是 `select distinct on (e.session_id) … order by e.session_id, e.occurred_at`。
问题是 `session_start` 与紧跟着的 `page_view` **常常落在同一时刻**，而 `ref_kind` 只挂在其中一条上
（`ref_kind` 为 null 的那条会让归因落到「其他」）。时刻相同时谁抢到「该会话第一条」是**未定义**的——
同一批数据两次查询给出不同的来源分布（JS 独立复算与 SQL 输出对不上，才把这个问题揪出来）。

**改法**：`order by e.session_id, (e.ref_kind is null), e.occurred_at, e.id` ——
规则变成「会话里最早一条**带 ref_kind** 的事件决定来源」，且完全确定。

### 3. `funnel` 的 JSON 结构从数组改为对象

`[{label,hint,n}×4]` → `{steps:[{label,hint,n}×4], direct:<int>}`，以便携带上面第 1 条里的 `direct`。
`analytics.js` 的 `drawFunnel()` 随之读取 `D.funnel.steps`。前端与函数同批改完，无兼容期。

### 4. `session_end` 事件被去掉（事件字典 10 → 9）

§5.1 原本把 `session_end` 列为第 8 个事件。实现时判定它是个**会制造错数的字段**：
会话边界由「30 分钟不活动」定义，而 `pagehide` 只代表页面卸载——把页面卸载当成会话结束，
会把「看了 1 页就切到别的标签页」和「真的走了」混为一谈。它携带的 `pages` 也可由同会话的 `page_view` 条数算出，纯冗余。
于是前端不发、数据库白名单也不收。**§5.1 与 §5.3 已按此订正**（共 9 个事件，props 白名单去掉 `pages`、补上 `degrade`）。

### 5. 空态判据不能用「含机器人」的事件总数

原先写的是 `isEmpty = !D.health.totalEvents`。但 `health.totalEvents` **含机器人流量**，
于是「只有爬虫来过的日子」（新站上线初期很常见）会走「有数据」分支、画出 30 根 0 柱子——
恰好是设计里明确要避免的「一整屏 0」。

**改法**：`isEmpty = !(D.overview.sessions || D.overview.visitors)`，即「窗口内既无会话也无访客」。
机器人流量仍然由 F 区块的「机器人流量」格子如实报出，不会被空态藏起来。
专门加了一个 `botsonly` 测试状态（零真实会话/访客 + 4 条机器人事件）盯这条判据。

**收尾时又抓到它的第二次发作**：这个判据当时写在 `render()` 里，而 `resize` 的重绘分支
自己另抄了一份「重绘哪几块」的清单——用的是旧的 `!health.totalEvents`，还**无条件**调
`drawTrend()`。于是空态下窗口一 resize（手机上转屏、开 DevTools、拖窗口都会触发），
「埋点已经就位，只等第一个访客」的空态框就被换成一整屏 0 柱子，
正是本条要避免的画面。之所以一直没暴露，是因为原有的横向溢出检查恰好会把视口改三轮、
真实触发 resize，但只断言了溢出宽度。

**改法**：把判据抽成全站唯一的 `isEmptyData(D)`，并让 resize 分支**直接复用 `render()`**
（纯重绘、幂等、无副作用），不再维护第二份分支清单。同时补一条哨兵断言：
resize 后空态必须仍是空态（`trendEmpty && trendRects === 0 && hourlyEmpty && liveNow === '0'`）。
**这条断言已用「把 resize 分支改回旧写法」反向验证过**：旧写法下它如实报错
（`trendRects` 从 0 变成 41 = 30 根 0 柱 + 11 条发布竖带），说明它不是空断言。

### 6. `readJsonBody` 超限时 `req.destroy()` 会让响应根本发不出去

超限分支原本直接销毁 socket。后果是**调用方随后写的响应永远到不了客户端**：
其它写接口本该返回 413、埋点本该返回 204，实测 curl 一律拿到 `000`（连接被重置）。
这同时违反了 §7「`/api/track` 永远返回 204」的约定。
**改法**：拒绝后改为 `req.resume()` 排空余下数据，让响应正常送达；
内存仍由累积上限守住，只是不再「连读都不读」。实测 >16KB→204、>512KB→413。

### 关于 `dashboard-preview.html`

该原型是**P0 范围决策之前**冻结的设计制品，权威性止于版式与交互。两处已知的过时点：

- mock 的事件流里仍演示 `scroll` / `engaged_read`，而这两个事件已按 §14 决策 **不采**；
- mock 的漏斗是并列口径而非嵌套口径（见上第 1 条）。

**线上看板与 `analytics_dashboard()` 才是口径的事实来源**；原型只用于回答「长什么样」。

### 本轮实测结论（2026-10-16）

| 断言 | 结果 |
|---|---|
| 独立复算对账（另写一份 JS 聚合，逐字段比） | **30 天窗口 24 项全一致；7 天窗口 24 项全一致** |
| 漏斗单调性（9 → 3 → 3 → 2） | 通过 |
| 后台看板 UI（真实 Chrome，三种数据状态） | 有数据 **28/28**；首日空态 **18/18**；仅机器人流量 **19/19** |
| 三个断点无横向溢出 @1440 / 1280 / 390 | 通过 |
| resize 重绘路径（空态不被 0 柱图顶掉 / 有数据按新宽度重画） | 通过；该断言已反向验证能抓到旧写法（`trendRects` 0 → 41） |
| 真实浏览器埋点端到端（零页面报错） | 通过；3 次连刷只落 1 条 `view_item`（去抖生效） |
| 点「退出统计」后新增上报 | 0 次 |
| 单 IP 频控（60 次/分钟） | 连发 70 次，恰好落库 60 条 |
| `POST /api/track` 各异常路径（空体/坏 JSON/跨站 Origin/非法事件名/超大包） | 全部 204，且跨站 Origin 与超大包不落库 |
| >16KB body → 埋点 204；>512KB body → 接口 413 | 通过（修复前一律是连接重置） |
| 无身份 / 非管理员调 `analytics_dashboard` | `DATABASE_P0001 forbidden` |
| anon 读 / 写 `research_events`、读 `analytics_drops` | `42501`（动态 SQL 探针，非推断） |
| 非管理员读 `analytics_exclude` | RLS 挡成 0 行；该 policy 的 roles 只有 `{authenticated}` |
| 线上复测 | 公开页 / 后台页 / 静态资源全 200；上报 204；线上 `analytics.js` 已含本轮全部修复 |


