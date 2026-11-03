# 两跳发布：实测事实与接口细节

这份文件是 SKILL.md 的证据底稿。数字都来自 2026-11-03 的两次真实发布（一份 118KB 技术手册 + 一次端到端冒烟），需要复跑时照着对。

---

## 一次真实发布的完整轨迹

样例：`CAPTURE_PIPELINE_GUIDE.html`（118KB，11 章、7 表、13 代码块、11 幅内联 SVG）

```
precheck     117.5 KB  sha256:2d4e3447…  script=1  污染=0  外链=0  → needs_sanitize
library      import_html.py  → node P4Pgwq…/Xa1drm…，publish_url=workbuddy.link/p/<node>
site         POST /api/items → 201，id=101，NO.101，count 58→59
verify       detail 200 / og 5915B / listed true / source_link_live true
```

耗时约 20 秒（上传取决于文件大小，110KB 约 3 秒）。

---

## 第 1 跳：资料库脚本

都住在 WorkBuddy 内置的 `skills/library/` 下（应用内路径随版本变化，用 `publish.py` 的探测器找，别硬编码）。脚本**失败时也是 exit 0**，只在 stdout 吐一行 JSON，必须解析内容而不是看退出码。

| 脚本 | 参数 | 成功标记 |
|---|---|---|
| `page/import_html.py` | `<path> [--file-name] [--space-id] [--parent-id] [--node-block-id] [--databases]` | `KS_IMPORT_OK {node_block_id,file_name,url,publish_url}` |
| `page/publish_page.py` | `--node-id <id>` | `KS_PAGE_PUBLISH\t<url>` |
| `page/unpublish_page.py` | `--node-id <id>` | `KS_PAGE_UNPUBLISH\tOK` |
| `export/export_node.py` | `--node-id <id>` | 导出任务（返回临时下载链接） |

约束与事实：

- 只收 `.html` / `.htm` / `.zip`，单文件上限 **50 MiB**；非该后缀直接 `{"error": "..."}`。
- 文件名缺乏语义（`index`/`default`/纯数字/UUID 片段）时会自动从 `<title>` / `<h1>` 抠一个语义名。
- `import_html` 返回的 `publish_url` 在新导入时通常为空，需要再调一次 `publish_page`。这正是 2026-11-03 第一次实践里手工做的第二步。
- 节点 ID 就是公开链接里的 ID：`workbuddy.link/p/<nodeId>`、编辑页 `workbuddy.cn/space/d/<nodeId>`。
- 落库位置默认个人空间根目录（`spaceId` 可省）。个人空间的 `spaceId` 用 `space_api.py space.workspace.list-user-spaces` 取。
- **上传本身不产生分享链接**。资料库里是私有的，必须 `publish_page` 才有公开链接——这是最容易漏的一步。

### 关于导出的副本

`export_node.py` 导出的是页面**当前版本**，会被页面编辑器整篇回写：

| | 原件 | 导出件 | 剥掉注入后 |
|---|---|---|---|
| 体积 | 118 KB（120,343 B） | 231 KB（231,659 B） | — |
| `data-page-node-id` | 0 | 1532 处 | 0 |
| `<script>` | 1（文档自己的） | 2（多一个 `/page/page_comm/inject.js`） | 0 |
| 字符数 | 103,071 | 214,387 | 102,474 / 141,881 |

结论：**要发布就用原件**。手上只有导出件时，`sanitize.py` 能清干净，但会多出约 4 万字符的重复内联样式。

---

## 第 2 跳：研究成果站接口

`POST /api/items`，认证 `X-Agent-Token`。

| 字段 | 约束 |
|---|---|
| `title` | 必填，≤300 字（JS `s.length`，即 UTF-16 码元数） |
| `summary` | 必填，≤400 字（同口径） |
| `url` | 链接型必填 ≤2000；**带 `doc_html` 时不得同传**（400 `invalid_field`） |
| `doc_html` | ≤1,000,000 **字符**；带上即文档型，原文不落库 |
| `date` | `YYYY-MM-DD`，缺省当天 |
| `source_key` | ≤300 字，唯一索引上的幂等键 |

### 字数上限的实测细节（2026-11-03）

`lib/agent-api.js` 的 `pickText` 是 `if (max && v.length > max) throw 400 field_too_long`：

- 判据是 **`>`**，不是 `>=`：恰好 300 / 400 字**放行**，301 / 401 才拒。
- `v.length` 是 JS 字符串长度 = **UTF-16 码元数**。中文与西文各算 1，emoji 与 BMP 外字符算 2。Python 侧必须用 `len(s.encode('utf-16-le')) // 2` 对齐，用 `len()` 会少算 emoji。
- 计数对象是**未 trim 的原值**，但本脚本发送前已 `.strip()`，所以本地数 strip 后的长度与服务端一致。
- 回归样例：`summary` 403 字 → `400 field_too_long`，且此时**第 1 跳已成功、资料库已有页面**（两跳非事务）。因此 `publish.py` 把字数校验前置到上传前（`cmd_all` 的 preflight），超限时 `stage_library` 根本不会被调用。

返回码与行为：

| 场景 | HTTP | `action` | 说明 |
|---|---|---|---|
| 新建 | **201** | `created` | 只认 200 会误判失败 |
| 同 `source_key` 重投 | 200 | `updated` | id 不变，文档型 `doc_html` 不覆盖 |
| 缺字段 / 超长 | 400 | — | `missing_field` / `field_too_long` |
| token 不对 | 401 | — | `missing_token` / `invalid_token` |
| 请求体含脚本 | **403** | — | 平台 WAF 的 HTML 拦截页，不是本站 JSON |
| 请求体 > 2MB | 413 | — | `payload_too_large` |

写权限锁在 `SECURITY DEFINER` 数据库函数里，`anon` 身份直连表的写操作全部 42501 拒绝；`owner_name` 由函数写死（当前是「军舰」），调用方改不了。

### 两种形态的判别

`apiShape` 的输出里**没有 `kind`**：`id no title summary url date owner source_key source_agent created_at updated_at page_url og_image`。

- 文档型：`url` 是派生地址 `<site>/item/<id>/doc`，该路由 200 且响应头带 `Content-Security-Policy: sandbox allow-scripts` + `X-Content-Type-Options: nosniff`。
- 链接型：`/item/<id>/doc` 返回 404。

形态由 `source_key` 所在行决定，重投不会改变已存在行的 `kind`——想换形态要换 key。

---

## 分享卡片：为什么必须发站点链接

| | `workbuddy.link/p/<id>` | `<site>/item/<id>` |
|---|---|---|
| `og:title` | 文档 `<title>`（正确） | 卡片标题（正确） |
| `og:description` | 固定文案「WorkBuddy - 可人机协作的在线 Page」 | 你写的 summary |
| `og:image` | 通用 HTML 文件图标（`docs.gtimg.com/…/wb-file-html-solid.png`，560×560） | 服务端实时生成的 1200×630 专属封面，约 5.9 KB |
| `og:site_name` | WorkBuddy | 研究成果 |

微信抓取不执行 JS、只读这几个标签，所以两者的卡片长相差别就是「通用图标 + 机器文案」与「专属封面 + 人写的摘要」。

---

## 已取消发布的公开页长什么样

`unpublish_page.py` 之后，`workbuddy.link/p/<id>` **仍返回 200**，内容是 5957 字节的通用壳页：`<title>WorkBuddy</title>`、`<body>` 几乎为空。用状态码判断「链接还活着」会得出完全错误的结论——`verify` 因此改用页面标题判据。

---

## 站点侧的其它常量

- `/api/health` 返回 `count`，是内容对账的唯一可靠数字（演示模式也返回 200，只是 count=8 且内容是示例数据）。
- 列表页有 **60 秒内存缓存**；经 Agent API 写入会立即失效缓存，绕过接口直改数据库则会滞后。
- 删除是硬删除，无回收站：条目删除后 `/item/<id>` 立刻 404，已发出去的卡片全部失效。
- 封面图 `/og/<id>.png` 运行时手写 PNG 编码生成，正常体积 5.9 KB 左右；低于 2 KB 视作异常。
- **全站封面字节数都是 5915 B，这是设计而非故障**：`og-image.js` 画的是「研究笔记横格纸」抽象图（暖白纸底 + 墨色横格 + 一条朱红批注线），**不含任何文字字形**；每条的区别只在朱红横线的位置与长度（由内容哈希决定），压缩后体积恰好撞到同一字节数。别把它当占位骨架，也别用「字节数相同」当「图没生成」的证据。
- 字体与 SDK 自托管，页面不请求外部域名——所以文档里的外部图片会加载失败，静态 SVG 是安全的。
