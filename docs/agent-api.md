# 研究成果 · Agent 接口

给外部 agent（或任何能发 HTTP 请求的东西）用的读写接口。**一行 curl 就能维护站点内容**，不必登录后台。

- 站点：下文统一用 `$BASE` 指代，换成你自己的地址即可
- 接口前缀：`/api`
- 认证：**`X-Agent-Token: <token>`**（只有写操作需要；读是公开的，与网站同源）
- Token 原文只存在本机（默认读项目根目录的 `.agent-token`），数据库里只存 SHA-256

> ⚠️ **别用 `Authorization: Bearer`。** 平台的边缘代理会把这个请求头吃掉，线上会得到 `401 missing_token`。
> 详见下面「认证通道」一节。

---

## 30 秒上手

```bash
cd research-share
BASE=http://127.0.0.1:3000
TOKEN=$(cat .agent-token)

# 看全部内容
curl -s $BASE/api/items | python3 -m json.tool | head -30

# 新增一条
curl -s -X POST $BASE/api/items \
  -H "X-Agent-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"标题","summary":"概览","url":"https://原文链接","date":"2026-10-16"}'
```

**自检随时可跑**：`bash scripts/smoke.sh`（会自己造数据、自己清干净）

---

## 认证通道（线上实测）

同一个 token，三条通道只有两条能用：

| 通道 | 线上 | 本地直连 | 备注 |
|---|---|---|---|
| `X-Agent-Token: <token>` | ✅ | ✅ | **推荐** |
| `?token=<token>` | ✅ | ✅ | 可用，但 token 会进 URL / 日志 |
| `Authorization: Bearer <token>` | ❌ 401 | ✅ | 边缘代理剥掉了这个头 |

想换个通道：`AUTH_HEADER=Authorization bash scripts/smoke.sh`。

---

## 接口一览

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 否 | 探活，返回条数与站点地址 |
| GET | `/api/items` | 否 | 全部条目（按日期倒序） |
| GET | `/api/items/:id` | 否 | 单条 |
| POST | `/api/items` | **是** | 新建；带 `source_key` 时同键重复提交 = 更新 |
| POST | `/api/items/batch` | **是** | 批量 upsert，**原子**（任一条不合格则整批回滚） |
| PATCH | `/api/items/:id` | **是** | 只改传了的字段，未传的保持原值 |
| DELETE | `/api/items/:id` | **是** | 删除 |

### 字段

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `title` | string | ✅ | 1–300 字 |
| `summary` | string | ✅ | 1–400 字（**完整概览**，卡片与详情页都用它） |
| `url` | string | 链接型 ✅ | 1–2000 字，原文链接；**携带 `doc_html` 时不得同传**（400 `invalid_field`） |
| `doc_html` | string | — | ≤ 1MB 字符。**携带即为文档型成果**：原文不落库，其原文链接由系统派生为站内托管地址；不携带即链接型（`url` 必填，契约不变） |
| `date` | string | — | `YYYY-MM-DD`，缺省取当天 |
| `source_key` | string | — | ≤300 字。**幂等键**，见下节 |

`PATCH` 只接受 `title` / `summary` / `url` / `date`；`id` 从路径取。**只要携带 `doc_html` 键（任意值，含空串 / null）即 `400 immutable_field`**——文档内容一经发布不可修改（`docs/adr/0004`），想换内容请删除后重新发布。文档型成果的 `url` 不落库（派生托管地址），PATCH 对它传 `url` 同样会被数据库约束拒绝。

> **含脚本的文档会被平台边缘防护拦下。** 请求体里出现 `<script` 或内联事件属性（如 `onclick=`）时，
> 网关的 WAF 会直接返回 **403 的 HTML 拦截页**（不是本接口的 JSON），请求根本到不了应用——
> 浏览器直写数据面与 Agent API 两条通道同此限制，应用侧无法用错误码表达它。
> 所以 `doc_html` 只收不含脚本的静态 HTML；需要图表这类交互时，请在发布前把脚本渲染成静态
> SVG / 图片再内联。

### 返回

`POST` / `PATCH` / `GET` 单条都返回完整条目对象：

```json
{
  "ok": true,
  "action": "created",
  "id": 5,
  "item": {
    "id": 5,
    "no": "NO.005",
    "title": "标题",
    "summary": "概览",
    "url": "https://原文链接",
    "date": "2026-10-16",
    "owner": "你的名字",
    "source_key": "notion:abcd-1234",
    "source_agent": "main-agent",
    "created_at": "2026-10-16T16:38:15.251Z",
    "updated_at": "2026-10-16T16:38:15.251Z",
    "page_url": "<your-site>/item/5",
    "og_image": "<your-site>/og/5.png"
  }
}
```

`page_url` 是站内详情页，`og_image` 是分享卡片的封面图 —— 都是现成的，拿去发微信就行。

> 文档型成果（POST 时携带 `doc_html`）的 `url` 字段返回**派生托管地址**（`$BASE/item/<id>/doc`），可直接访问、可转发；其余字段形态不变。

---

## 幂等：`source_key` 怎么用

`source_key` 是唯一索引上的**幂等键**。同一把键重复提交**只会更新，不会新增**：

```bash
# 第 1 次 → action=created
# 第 2 次（同 source_key）→ action=updated，id 不变
curl -s -X POST $BASE/api/items \
  -H "X-Agent-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"新的标题","summary":"概览","url":"https://x","source_key":"notion:abcd-1234"}'
```

从 Notion / 其他系统同步时，**用它那边每页稳定的 ID 当 `source_key`**（Notion 用 page id）。这样：

- 整个同步任务可以随便重跑，不会灌出一堆重复卡片
- 源那边改了标题，重跑只更新那一条
- 站点自身的 id（NO.005 那个编号）保持稳定，分享出去的链接不会失效

不带 `source_key` 则每次都是新增。

---

## 批量（同步主力）

```bash
curl -s -X POST $BASE/api/items/batch \
  -H "X-Agent-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "items": [
      {"title":"A","summary":"…","url":"https://a","date":"2026-10-14","source_key":"notion:aaa"},
      {"title":"B","summary":"…","url":"https://b","date":"2026-10-13","source_key":"notion:bbb"}
    ]
  }'
# → {"ok":true,"created":2,"updated":0,"total":2,"items":[{"ok":true,"action":"created","id":6},…]}
```

- 单次上限 **500 条**，请求体上限 **2MB**（容纳 1MB 文档加 JSON 包装；文档型条目可混入批次）
- **整批原子**：任一条不合格 → 整批回滚，不会写一半。已双重验证：
  ① 走接口（HTTP 400，库里无新行）；② 在数据库层直接调函数让第 2 条超长（`DATABASE_22001`，第 1 条也没落库）
- 也接受裸数组：`-d '[{…},{…}]'`

---

## 错误码

| HTTP | `error` | 含义 |
|---|---|---|
| 400 | `missing_field` / `invalid_field` / `field_too_long` | 字段缺失、类型/格式不对、超长 |
| 400 | `immutable_field` | PATCH 携带 `doc_html`（文档内容不可变） |
| 400 | `invalid_json` / `invalid_body` | 请求体不是合法 JSON / 结构不对 |
| 401 | `missing_token` / `invalid_token` | 没带 token / token 无效或已停用 |
| 404 | `not_found` | 条目或接口不存在 |
| 405 | `method_not_allowed` | 方法不对（响应头里有 `Allow`） |
| 413 | `payload_too_large` | 请求体超 2MB |
| 502 | `database_error` | 数据库侧异常 |

---

## 清理与回滚

```bash
# 改一条
curl -s -X PATCH $BASE/api/items/5 \
  -H "X-Agent-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"summary":"只换摘要，标题和链接不动"}'

# 删一条（不可恢复）
curl -s -X DELETE $BASE/api/items/5 -H "X-Agent-Token: $TOKEN"
```

> 删除是**硬删除**，没有回收站。批量操作前请自行备份：`GET /api/items > backup.json`。

---

## 已知边界（用之前先知道）

1. **写入后 60 秒内，若绕过接口直接从数据库改数据，网站可能显示旧内容。** 页面有 60 秒内存缓存；通过这套接口写会**立即失效缓存**，所以「接口写、网站看」是实时的。
2. **删除不级联。** 条目被删后 `/item/:id` 返回 404，旧的分享卡片链接随之失效。想避免就永远别删，改用 PATCH。
3. **`owner` 取自内容本身，不由 token 决定。** 同步进来的条目记在同步者名下，后台可以直接改删。`source_agent` 记录了是哪个 token 写的，但后台界面暂不展示。
4. **`X-Agent-Token` 这个自定义头如果将来也被网关吃掉**，退回 `?token=<token>` 即可，两条通道都已实测可用。
5. **微信内能否打开取决于你的域名，与本接口无关。** 托管平台可能按 UA 拦截默认分配的域名；要稳定分享，请绑定自己的域名并完成备案（中国大陆服务器）。卡片预览失效时，可退回详情页的「复制文字 + 原文链接」。

---

## Token 轮换

Token 只在数据库里存哈希，**原文丢了只能重新生成**。轮换步骤：

```sql
-- 停用旧 token（不删，保留 last_used_at 审计）
UPDATE public.agent_tokens SET enabled = false WHERE name = 'main-agent';
```

然后生成一个新的并登记它的哈希（步骤见 `db/02-agent-api.sql` 第 9 节）。
查谁在用：`SELECT name, enabled, last_used_at FROM agent_tokens;`
每条记录最后一次被使用的时刻，长期没用的可以直接停掉。

---

## 安全姿态（实测结论）

应用进程是 `anon` 身份（只有 publishableKey，没有登录会话），所以**把写权限锁在受检的窄口里**，而不是给表开权限：

| 以 anon 身份探测 | 结果 |
|---|---|
| 读 `agent_tokens` | `DATABASE_42501 permission denied for table agent_tokens` |
| 直连 `INSERT research_items` | `DATABASE_42501 permission denied for table research_items` |
| 直接调 `agent_check_token` | `DATABASE_42501 permission denied for function` |
| 调写入口 + 伪造 token | `DATABASE_28000 invalid_token` |

即：**即使拿到源码里那个 publishableKey，也写不进任何数据、读不到任何 token。** 唯一的写入口就是那个需要 token 的 `SECURITY DEFINER` 函数。

复跑这两组证据：

```bash
bash scripts/smoke.sh          # 接口层 37 项
node scripts/probe-anon.mjs    # anon 越权探测 5 项
```

数据库改动的完整 SQL 在 `db/` 目录，每条都能重新执行。
