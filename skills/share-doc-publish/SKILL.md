---
name: share-doc-publish
description: 把一份本地 HTML 文档连着做完两跳发布——先上传到 WorkBuddy 资料库并「发布为网站」拿到 workbuddy.link 公开链接，再登记到 research-share 研究成果站，得到列表卡片、详情页与专属微信分享封面。当用户说「把这个文档发出去」「上传到资料库并分享」「发布为公开链接」「挂到研究成果站」或给出一份本地 html 要求生成可分享链接时使用。
agent_created: true
---

# 文档两跳发布管线

一份本地 HTML → 一个能在微信里转发的链接 → 一张站点上的卡片。这是两件不同的事，本技能把它们连成一条可复跑的链。

```
① 资料库（第 1 跳）                                   ② 研究成果站（第 2 跳）
   import_html.py   上传 → 「页面」节点                    POST /api/items
   publish_page.py  发布 → workbuddy.link/p/<nodeId>   → 列表卡片 + /item/<id> + /og/<id>.png
        ↑ 任何人不登录可看，带目录、表格、交互                ↑ 专属分享封面 + 真实摘要，微信卡片好看
        └──────────── node_id 当幂等键 ────────────────────┘
```

**两跳各解决一个特定问题，缺一不可**：

- 资料库解决「别人不登录也能读到原文」，但它的分享卡片是通用模板（`og:image` 是 HTML 文件图标、`og:description` 是固定文案「WorkBuddy - 可人机协作的在线 Page」）——发到微信里很敷衍。
- 研究成果站解决「分享出去好看」，但它只存卡片元数据，正文要么跳资料库、要么把静态 HTML 存进自己库里。

所以给用户交付时，**要发的是站点详情页 `/item/<id>`，不是 workbuddy.link 链接**。

---

## 一条命令跑完

> 下面所有命令都假定当前目录是技能目录：`cd ~/.workbuddy/skills/share-doc-publish`。

```bash
python3 scripts/publish.py all <本地文件.html> \
  --title "卡片标题（≤300 字，建议 20–40 字）" \
  --summary "实质概览（≤400 字，建议 200–360 字，卡片和详情页都用它）" \
  --date 2026-11-03
```

跑完输出三段：资料库公开链接、编辑链接、站点详情页与封面图，外加验收结果。

先看会做什么、不落任何东西：

```bash
python3 scripts/publish.py all <file> --title … --summary … --dry-run
```

`--dry-run` 不上传、不写入——第 1 跳一旦执行就会在资料库里真建一个页面。

---

## 标题与摘要：字数上限是硬约束

站点接口对这两个字段有硬上限，超一个字就 400。**坑在于它是在第 1 跳已经把页面传上去之后才拒的**（2026-11-03 真实踩过：summary 403 字，资料库里白建了一个页面）。所以校验现在**挪到了上传前**——超限时命令直接退出，资料库连页面都不会建。

| 字段 | 上限 | 计数口径 | 建议落点 |
|---|---|---|---|
| `--title` | **300 字** | UTF-16 码元：中文/西文各算 1、emoji 算 2，与服务端 JS `s.length` 完全同口径 | 20–40 字，h1 那种「A 与 B：做了什么」 |
| `--summary` | **400 字** | 同上 | 200–360 字，给自己留余量 |

超限时报错长这样，别硬撞：

```
error: 标题/摘要不合规，未上传（资料库没有被建页面）：summary 403 字，超上限 3 字（上限 400）
```

改字之前先只数字数，不联网、不落库：

```bash
python3 scripts/publish.py meta --title "…" --summary "…"
```

`meta` 返回 `title_len` / `summary_len` 与 `title_left` / `summary_left`（还能写多少字，负数即超出量），`ok=false` 时 `problems` 里直接写「超了 N 字」。**别用 `len()` 自己数**：emoji 这类字符服务端算 2、Python `len()` 算 1，本地看着够、线上必 400。

两条内容要求（不是长度问题，但同样决定卡片好不好看）：

- `summary` 别照抄资料库的 og 描述——那是固定文案「WorkBuddy - 可人机协作的在线 Page」，要按正文重写成实质概览。
- `title` 别直接搬文档 `<title>`——那通常是「技术选型 · 副标题」这种文档名，站内卡片用 h1 那种句式更贴读者。

不传 `--title` 时的兜底顺序：**文档 h1 → `<title>` → 文件名**。兜底值也参与字数校验，且报告里 `meta.title_source` 会写明来源；兜底标题超长时报错会提示你用 `--title` 显式给一个短的。所以**最好总是显式写 `--title`**——兜底只是为了让漏传时不至于发出一个叫 `index` 的卡片。

---

## 先体检，再决定形态

```bash
python3 scripts/precheck.py <file>
```

`verdict` 三种取值决定下一步：

| verdict | 含义 | 怎么办 |
|---|---|---|
| `ok` | 干净，无 WAF 红线 | 两种形态都能发 |
| `needs_sanitize` | 含 `<script>` / 内联事件 / `javascript:` | 链接型可直接发；要走文档型先 `sanitize.py` |
| `blocked` | 不存在 / 非 HTML / 超限 / 取不到标题 | 停下来问用户 |

**只有 `.html` / `.htm` 能走这条路。** 资料库只在 HTML 上生成「页面」节点，而 `publish_page` 只对页面节点有效。markdown / pdf / docx 得先转成单文件 HTML。

### 两种形态怎么选

| | 链接型（默认） | 文档型 `--mode doc` |
|---|---|---|
| 正文在哪 | 资料库，跳 `workbuddy.link` | 本站数据库，`/item/<id>/doc` 直出 |
| 脚本交互 | **保留**（目录滚动高亮、tab 都能用） | 必须剥掉（WAF 拦 `<script`） |
| 改内容 | 资料库改一次即可，站点不用重发 | **不可改**，只能删除重发 |
| 域名 | 两个（资料库 + 站点） | 一个（全在站点域名下） |
| 适用 | 默认选这个，站内既有内容全是这个形态 | 要求「链接都在自己域名下」或资料库链接不想暴露 |

文档型的隔离由托管路由的 `Content-Security-Policy: sandbox allow-scripts` 独力承担（ADR-0004）：脚本就算被写进去也摸不到本站会话。所以 `sanitize` 剥脚本是为了过 WAF，不是安全所必需——但两者效果一致。

---

## 脚本

| 脚本 | 作用 |
|---|---|
| `scripts/precheck.py` | 体检：体积、标题、WAF 红线、编辑器污染、外链 |
| `scripts/sanitize.py` | 清成静态 HTML：剥 script/iframe/on*/javascript:/编辑器属性 |
| `scripts/publish.py` | 主流程：`scan` / `meta` / `library` / `site` / `all` / `verify` |

`publish.py` 的子命令可以单独跑，用来接续或排障：

```bash
python3 scripts/publish.py meta --title … --summary …                          # 只数标题/摘要字数
python3 scripts/publish.py library <file> [--space-id S] [--node-block-id ID]   # 只做第 1 跳
python3 scripts/publish.py site --title … --summary … --url … --source-key …    # 只做第 2 跳
python3 scripts/publish.py verify <item_id>                                     # 只验收 / 巡检
```

`--node-block-id` 是对已有页面重导入（更新内容），不传就是新建。重跑整条链时**必须带上它**，否则资料库里会堆出重复页面。

---

## 验收标准（不看返回码）

```bash
python3 scripts/publish.py verify <item_id>
```

| 检查项 | 判据 | 为什么不能只看 200 |
|---|---|---|
| `detail_200` | `/item/<id>` 返回 200 | — |
| `og_200` | `/og/<id>.png` 返回 200 且 **> 2000 字节**（正常约 5900） | 演示模式也返回 200，只是内容全是示例数据 |
| `listed_on_home` | 首页 HTML 里能找到条目标题 | 60 秒内存缓存：接口写完即时失效，绕库直改则会滞后 |
| `source_link_live` | 公开页 `<title>` 不是通用壳页 | **取消发布后 workbuddy.link 仍返回 200**，只是换成 5957 字节的 `<title>WorkBuddy</title>` 空壳 |
| `doc_route_200` / `doc_csp_sandbox` | 仅文档型：`/item/<id>/doc` 200 且响应头含 `sandbox` | 托管原文与隔离头是这个形态的全部价值 |

站点总条数用 `/api/health` 的 `count` 对账：新建 +1，幂等重投不变。

---

## 会咬人的地方

1. **`Authorization: Bearer` 会被边缘代理吃掉**，线上 401 `missing_token`。必须用 `X-Agent-Token`。本地直连看不出来，只在线上暴露。
2. **`doc_html` 里出现 `<script` / `onclick=` / `javascript:` → 平台 WAF 直接返回 403 的 HTML 拦截页**，不是本站 JSON，请求根本到不了应用。看到 `waf_suspect` 就是这个。
3. **新建返回 201，幂等更新返回 200**。只认 200 会把成功判成失败（本人踩过，卡片其实已经建好了）。
4. **资料库导出的副本被编辑器回写过**：同一份文档原件 118KB、导出件 231KB，剥掉属性后分别是 102,474 与 141,881 字符。要发布就用**原件**；手上有导出件时先看 `precheck.py` 报的 `pollution`。
5. **Agent API 的返回里没有 `kind` 字段**。判断一个条目是不是文档型，只能探 `/item/<id>/doc`：200 是，404 是链接型。
6. **标题 ≤300、摘要 ≤400，且两跳不是事务**：第 1 跳一跑完资料库就有页面了，第 2 跳再因超长 400，那个页面白建。校验已前置到上传前（见上文「标题与摘要」），真撞上了就用 `--node-block-id <已有 node_id>` 带幂等键重跑，别重新新建。
7. **同一份文档的两种形态不能互转**：已存在的 `source_key` 若是链接型，重投文档型只会更新标元，`kind` 保持不变（db/06 的既定行为）。要换形态就换 `source_key`（如加 `:doc` 后缀）。
8. **别拿封面图字节数判断「是不是同一张图」**：`/og/<id>.png` 全是 5915 B——它是「研究笔记横格纸」抽象图，不含任何文字字形，只靠一条朱红批注线的位置（内容哈希决定）区分。字节数相同是设计如此，不是渲染失败或占位骨架。

---

## 收尾

发布完成后：

- 站点条目一旦删除就**没有回收站**，`/item/<id>` 随即 404、旧卡片链接失效。要改内容优先 `PATCH` 改标题/摘要，别删。
- 资料库页面用 `page/unpublish_page.py --node-id <id>` 可取消发布（公开链接随即变成壳页）。
- 把「源文件路径 / node_id / 站点 id / 公开链接」记进项目日志，下次重发才找得到幂等键。

更多细节与实测证据见 `references/pipeline-facts.md`。
