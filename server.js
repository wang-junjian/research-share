import http from 'node:http'
import dns from 'node:dns/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk'
import { drawCover } from './og-image.js'
import { createDemoCloud } from './lib/demo-cloud.js'
import { loadEnv } from './lib/load-env.js'
import { renderList, renderDetail, renderError } from './lib/render.js'
import { createTrack } from './lib/track.js'
import { createAgentApi } from './lib/agent-api.js'
import { createItemsStore } from './lib/items-store.js'
import { createStaticFiles } from './lib/static-files.js'
import { sendJson, sendHtml, CORS_HEADERS } from './lib/http.js'

// ---------------------------------------------------------------------------
// 错误描述：线上 500 只看到 `TypeError: fetch failed` 是这个项目的老坑。
// 原因有两层：
//   1. undici 把 DNS / 连接超时 / TLS 全包成一个 `TypeError: fetch failed`；
//   2. 云服务 SDK 又把它重包成 `{ message, details, hint, code }`，`message`
//      只剩第一行，底层原因（`getaddrinfo ENOTFOUND`、`connect ETIMEDOUT`）
//      只留在 `details` 里，而且**没有 `cause`** —— 只遍历 cause 链会扑空。
// 所以这里同时展开 cause 链与 details，产出可直接判读的一行日志。
// ---------------------------------------------------------------------------
export function describeError(err) {
  const chain = []
  let details = ''
  let cur = err
  let depth = 0
  // 上限 5 层：正常 cause 链 1~2 层，防环状引用把日志打爆
  while (cur && depth < 5) {
    const head = [cur.name, cur.message].filter(Boolean).join(': ')
    const extra = []
    for (const k of ['code', 'errno', 'syscall', 'address', 'port', 'hostname']) {
      if (cur[k] !== undefined && cur[k] !== '') extra.push(`${k}=${cur[k]}`)
    }
    if (head || extra.length) chain.push(extra.length ? `${head} (${extra.join(' ')})` : head)
    // SDK 包装层的底层原因（含 Caused by 段），只取最外层一份
    if (!details && typeof cur.details === 'string' && cur.details) details = cur.details
    cur = cur.cause
    depth++
  }
  let out = chain.join(' <- ')
  if (details) {
    // 去掉缩进的 stack 帧，压成单行：日志按行 grep 时不会被冲散
    const flat = details.split('\n').map((s) => s.trim())
      .filter((s) => s && !s.startsWith('at ')).join(' | ')
    if (flat) out += ` ‖ details: ${flat}`
  }
  if (!out && err) out = String(err)
  return out.length > 1200 ? out.slice(0, 1200) + '…' : out
}

// ---------------------------------------------------------------------------
// 启动自检：数据面域名的 DNS 可达性。
//
// 线上出现过「整站 500、日志只有 fetch failed」的故障，根因是容器内
// `getaddrinfo ENOTFOUND <应用自身域名>` —— 运行沙箱解析不到发布域名，
// 而这条信息原本要翻到 SDK 错误对象的 details 里才看得到。每次启动打一行，
// 把「解析得到 / 解析失败 / 耗时」摊在明面上：出网类故障不必再猜。
// 失败不阻塞启动：只是打印，服务照常起（页面会自行降级为 500 错误页）。
// ---------------------------------------------------------------------------
function lookupWithTimeout(host, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Object.assign(new Error('lookup timeout'), { code: 'ETIMEOUT' })),
      ms,
    )
    dns.lookup(host).then(
      (r) => { clearTimeout(timer); resolve(r) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

async function logEndpointDns(endpoint, demo) {
  if (demo) return { skipped: 'demo' }
  let host
  try {
    host = new URL(endpoint).hostname
  } catch {
    console.log(`[research-share] dns: endpoint 不是合法 URL：${endpoint}`)
    return { error: 'bad_endpoint' }
  }
  const started = Date.now()
  try {
    const r = await lookupWithTimeout(host)
    const ms = Date.now() - started
    console.log(`[research-share] dns ${host} -> ${r.address} (${ms}ms)`)
    return { host, address: r.address, ms }
  } catch (e) {
    const ms = Date.now() - started
    console.log(`[research-share] dns ${host} -> FAIL ${e.code || e.message} (${ms}ms)`)
    console.log('[research-share] 数据面域名在容器内解析不到：服务端所有查库请求都会失败（页面 500）。')
    return { host, error: e.code || e.message, ms }
  }
}

// ---------------------------------------------------------------------------
// 健康探针：把「运行期到底哪条链路断了」用一次 GET 摊开。
//
// 分两档返回，默认档只有「进程活着」这一个事实：
//   默认（未配 HEALTH_TOKEN / token 不符）：{ ok, demo, uptimeSec }
//   详情（?token= 与 HEALTH_TOKEN 相符）：追加 node / endpoint / dns / proxyEnv
// 未配置 HEALTH_TOKEN 时永远只出默认档 —— 少填一个环境变量就少一条泄露路径。
// 详情档里的 proxyEnv 只报键名：代理值可能带凭据。
//
// 与 /api/health 的分工：那个要 await 一次列表查询，数据面断了它也 500，
// 看不到原因；本探针不碰数据面，专门回答「断在哪」。
// ---------------------------------------------------------------------------
const HEALTH_DETAIL_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS',
]

export function createHealth({ demo, endpoint, siteUrl, port, token, readDns, env = process.env }) {
  return function getHealth(url) {
    const brief = { ok: true, demo, uptimeSec: Math.round(process.uptime()) }
    if (!token) return brief
    // 内部排障端点，不是身份凭证的比对入口：普通相等判断即可
    if (!url || url.searchParams.get('token') !== token) return brief
    return {
      ...brief,
      node: process.version,
      endpoint: demo ? null : endpoint,
      siteUrl,
      port,
      dns: readDns(),
      proxyEnv: HEALTH_DETAIL_KEYS.filter((k) => env[k]),
    }
  }
}

// ---------------------------------------------------------------------------
// 路由 handler：纯函数式 module，全部依赖经 deps 注入，import 本文件不起服务。
// 测试（test/server.test.js）与真实入口共用这一个 handler —— 同一条 seam。
// ---------------------------------------------------------------------------

export function createHandler({ site, itemsStore, trackServerPageView, handleTrack, handleApi, getAdminHtml, tryServeStatic, getHealth }) {
  return async function handler(req, res) {
    const rawUrl = req.url || '/'
    let reqUrl
    try {
      reqUrl = new URL(rawUrl, 'http://localhost')
    } catch {
      reqUrl = new URL('/', 'http://localhost')
    }
    const path = reqUrl.pathname
    const isApi = path === '/api' || path.startsWith('/api/')
    try {
      if (isApi) {
        // 埋点上报语义不同（公开、无 token、永远 204），是 track module 的路由，
        // 由路由层按路径直接分派，不经 agent-api 转手（docs/adr/0001）
        if (path === '/api/track' || path === '/api/track/') return handleTrack(req, res)
        // Agent API 有自己的方法语义与认证，先于页面路由分流
        return await handleApi(req, res, path, reqUrl)
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendHtml(res, 405, renderError(site, '仅支持 GET 请求'))
      }
      if (path === '/' || path === '/index.html') {
        const items = await itemsStore.list()
        const html = renderList(site, items)
        // 先发埋点请求（RPC 立刻发出），再写响应 —— 两者重叠，不给用户加延迟
        trackServerPageView(req, { page: '/' })
        return sendHtml(res, 200, html)
      }
      if (path === '/admin') {
        const html = await getAdminHtml()
        return sendHtml(res, 200, html)
      }
      // 健康自检：把「运行期到底哪条链路断了」用一次 GET 摊开。
      // 默认只回「进程活着」，详情要 ?token= 与 HEALTH_TOKEN 相符（见 createHealth），
      // 不含任何密钥 —— 排查线上 500 时不必再翻部署日志。
      if (path === '/__health' && getHealth) {
        return sendJson(res, 200, await getHealth(reqUrl), { 'Cache-Control': 'no-store' })
      }
      if (path.startsWith('/assets/')) {
        // 「怎么发」是静态资源 module 的内部细节，路由层只问命中与否
        const served = await tryServeStatic(path.slice('/assets/'.length), res)
        if (!served) return sendHtml(res, 404, renderError(site, '资源不存在'))
        return undefined
      }
      // 微信卡片封面图：服务端实时生成，不落盘、不占云存储
      const ogm = path.match(/^\/og\/(\d+)\.png$/)
      if (ogm) {
        const it = await itemsStore.find(Number(ogm[1]))
        if (!it) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          return res.end('not found')
        }
        const png = drawCover({ id: it.id, title: it.title, date: it.date })
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': png.length,
          'Cache-Control': 'public, max-age=3600',
        })
        return res.end(png)
      }
      // 文档型成果的托管地址：直出原始 HTML。CSP sandbox 把文档关进孤立源：
      // 脚本能跑（图表可交互）但摸不到访客登录会话（docs/adr/0004）。
      //
      // 这里**要埋**服务端 page_view（itemId + /item/N/doc）：
      //   · 该页不加载 track.js（沙箱页注定跑不了本站埋点），服务端这条是
      //     「文档真的被打开过」的唯一证据；
      //   · 早先注释写的「否则详情页浏览会双倍计数」只在内嵌 iframe 时代成立，
      //     详情页已改为「查看原文」直达（lib/render.js 注释），前提不存在了；
      //   · 它不参与埋点覆盖率的分母 —— analytics_dashboard 里 serverPv 排除
      //     page like '%/doc'，否则一个天然没有客户端事件的页面会把覆盖率压低。
      const docm = path.match(/^\/item\/(\d+)\/doc\/?$/)
      if (docm) {
        const it = await itemsStore.find(Number(docm[1]))
        if (!it || it.kind !== 'doc') {
          return sendHtml(res, 404, renderError(site, '未找到该研究成果'))
        }
        const doc = await itemsStore.findDocument(it.id)
        if (!doc || doc.doc_html == null) {
          return sendHtml(res, 404, renderError(site, '未找到该研究成果'))
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': 'sandbox allow-scripts',
          'X-Content-Type-Options': 'nosniff',
        })
        trackServerPageView(req, { itemId: it.id, page: `/item/${it.id}/doc` })
        return res.end(doc.doc_html)
      }
      const m = path.match(/^\/item\/(\d+)\/?$/)
      if (m) {
        const it = await itemsStore.find(Number(m[1]))
        if (!it) {
          return sendHtml(res, 404, renderError(site, '未找到该研究成果'))
        }
        // 相邻条目导航：列表按日期倒序，「上一条」= 排在前面（更新），
        // 「下一条」= 排在后面（更早）。find 内部已查过列表（60s 缓存），
        // 这里重取同一份缓存，不添新查询。
        const items = await itemsStore.list()
        const idx = items.findIndex((x) => x.id === it.id)
        const html = renderDetail(site, it, {
          prev: idx > 0 ? items[idx - 1] : null,
          next: idx >= 0 && idx < items.length - 1 ? items[idx + 1] : null,
        })
        trackServerPageView(req, { itemId: it.id, page: `/item/${it.id}` })
        return sendHtml(res, 200, html)
      }
      return sendHtml(res, 404, renderError(site, '页面不存在'))
    } catch (err) {
      // 响应已经发出去一半（例如 body 读流中途出错），再写头会抛 write-after-end
      if (res.headersSent || res.writableEnded) {
        try { res.end() } catch { /* 已结束 */ }
        return undefined
      }
      // 自己抛的 4xx（缺 token、字段不合法、请求体超限）原样返回，不进 500 日志
      if (err && err.expose) {
        return sendJson(res, err.status || 400, { ok: false, error: err.code || 'bad_request', message: err.message }, CORS_HEADERS)
      }
      console.error('[research-share] error:', describeError(err))
      if (isApi) {
        return sendJson(res, 500, { ok: false, error: 'internal_error', message: '服务暂时不可用' }, CORS_HEADERS)
      }
      return sendHtml(res, 500, renderError(site, '服务暂时不可用，请稍后重试'))
    }
  }
}

// ---------------------------------------------------------------------------
// 入口：组装真实依赖并起服务。仅直接运行（node server.js）时执行；
// 被 import 时（测试）只提供 createHandler，不产生副作用。
// ---------------------------------------------------------------------------

async function main() {
  // 先读 .env，再读下面的配置。已存在的环境变量优先，不会被 .env 覆盖。
  loadEnv()

  // 配置全部来自环境变量（见 .env.example）。这里**刻意不提供任何默认密钥**：
  // 一旦把某个人真实的 publishableKey 硬编码进源码，所有 clone 本仓库的人
  // 都会用同一个应用身份读写同一份数据库 —— 那是别人的数据。
  //
  // 缺配置时进入演示模式（lib/demo-cloud.js）：只读、零依赖，用于先看界面。
  const PORT = Number(process.env.PORT || 3000)
  const ENDPOINT = process.env.CLOUD_ENDPOINT || ''
  const PUBLISHABLE_KEY = process.env.CLOUD_PUBLISHABLE_KEY || ''
  const SITE_NAME = process.env.SITE_NAME || '研究成果'
  const SITE_DESC = process.env.SITE_DESC || '持续更新的研究成果卡片：标题、概览与原文链接。'
  // 顶栏外链（可选）：右侧一个胶囊链接，指向同一位作者的另一款应用。
  // 走环境变量而不是写进模板，是因为它属于「这个部署」的私事 —— 别人的 clone
  // 不该继承我的链接。url 与 title 缺任一项就整条不渲染（见 lib/render.js）。
  const SITE_LINK_URL = process.env.SITE_LINK_URL || ''
  const SITE_LINK_TITLE = process.env.SITE_LINK_TITLE || ''
  // 站点公开 URL：用于 og:url / canonical / og:image。
  // 必须显式指定，不能靠请求的 Host 头拼：反向代理后面 Host 往往是内网地址，
  // 拼出来的 og:image 会让微信抓不到图（表现为分享卡片没有缩略图）。
  const SITE_URL = process.env.SITE_URL || `http://127.0.0.1:${PORT}`
  const OAUTH_RELAY = process.env.CLOUD_OAUTH_RELAY || 'https://www.workbuddy.cn/v2/as/genie-baas/oauth'
  // 本地排查埋点用：TRACK_DEBUG=1 打开后打印每批的 UA / 判定与每条落库结果
  const TRACK_DEBUG = !!process.env.TRACK_DEBUG

  // 演示模式：缺任一必需配置即启用。只读，用于零配置预览界面。
  const DEMO = !ENDPOINT || !PUBLISHABLE_KEY

  const FAVICON_SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>" +
    "<rect width='64' height='64' rx='14' fill='%23FAF9F7'/>" +
    "<rect x='6.75' y='6.75' width='50.5' height='50.5' rx='9' fill='none' stroke='%23C62B38' stroke-opacity='.5' stroke-width='1.5'/>" +
    "<text x='32' y='45' font-family='Songti SC,serif' font-size='34' fill='%23C62B38' text-anchor='middle'>研</text></svg>"
  const FAVICON = 'data:image/svg+xml,' + FAVICON_SVG.replaceAll('#', '%23')

  // 注入页面的公开配置（publishableKey 无权限语义，可进源码）。
  // 同一份配置走两条路：admin 模板经 __PUBLIC_CONFIG__ 占位符替换；
  // 公开页经 site.publicConfigJson 由页面模板内联（lib/render.js）。
  // 演示模式下公开页不加载 SDK（后台本就不可用），传 null。
  const PUBLIC_CONFIG_JSON = JSON.stringify({
    endpoint: ENDPOINT,
    oauthRelayBaseUrl: OAUTH_RELAY,
    publishableKey: PUBLISHABLE_KEY,
    // 前端据此把「配置缺失」和「演示模式」区分开，给出不同提示
    demo: DEMO,
    // 看板「外部入口」那行要显示入口的名字（如「AI每日要闻」），否则只能写
    // 「顶栏外部入口」。标题本来就在公开页顶栏明示，不是秘密。
    extTitle: SITE_LINK_TITLE,
  }).replaceAll('<', '\\u003c')

  // 传给页面模板 module 的站点配置（lib/render.js 不读环境变量）
  const site = {
    name: SITE_NAME,
    desc: SITE_DESC,
    url: SITE_URL,
    favicon: FAVICON,
    // 顶栏外链：null 时 render 不输出任何节点（不是隐藏，是不渲染）
    link: SITE_LINK_URL && SITE_LINK_TITLE
      ? { url: SITE_LINK_URL, title: SITE_LINK_TITLE }
      : null,
    publicConfigJson: DEMO ? null : PUBLIC_CONFIG_JSON,
  }

  const { tryServeStatic, getAdminHtml } = createStaticFiles({
    assetsDir: fileURLToPath(new URL('./assets/', import.meta.url)),
    adminTemplate: fileURLToPath(new URL('./admin.html', import.meta.url)),
    publicConfigJson: PUBLIC_CONFIG_JSON,
    favicon: FAVICON,
  })

  const cloud = DEMO
    ? createDemoCloud()
    : createWorkBuddyCloud({ endpoint: ENDPOINT, publishableKey: PUBLISHABLE_KEY })

  // 组装三个 deep module：条目存储（数据访问与身份派生）、埋点、Agent API
  const itemsStore = createItemsStore({ cloud, siteUrl: SITE_URL })

  const { trackServerPageView, handleTrack } = createTrack({
    salt: process.env.ANALYTICS_SALT || 'research-share/v1/ip',
    siteUrl: SITE_URL,
    cloud,
    debug: TRACK_DEBUG,
  })

  const { handleApi } = createAgentApi({ cloud, site, itemsStore })

  // 启动时探一次数据面域名解析，结果同时留给 /__health（排障时一眼看到断在哪）
  let dnsInfo = { pending: true }

  const getHealth = createHealth({
    demo: DEMO,
    endpoint: ENDPOINT,
    siteUrl: SITE_URL,
    port: PORT,
    // 未配置时详情档永不开启：线上要看得靠环境变量显式开启
    token: process.env.HEALTH_TOKEN || '',
    readDns: () => dnsInfo,
  })

  const server = http.createServer(
    createHandler({ site, itemsStore, trackServerPageView, handleTrack, handleApi, getAdminHtml, tryServeStatic, getHealth }),
  )

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[research-share] listening on 0.0.0.0:${PORT}, endpoint=${DEMO ? '(demo)' : ENDPOINT}`)
    // 只打键名不打值：代理值里可能带凭据。沙箱若只允许经代理出网，而 Node 的
    // fetch（undici）默认不读 HTTP(S)_PROXY，表现就是连接超时 —— 这行决定了
    // 「要不要给 SDK 注入 ProxyAgent」，是排查出网问题时最有信息量的一行。
    const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS']
      .filter((k) => process.env[k])
    console.log(`[research-share] proxy env: ${proxyKeys.join(',') || '(none)'}`)
    // 不 await：DNS 探测最多挂 5s，不能挡住端口就绪
    logEndpointDns(ENDPOINT, DEMO).then((info) => { dnsInfo = info })
    if (DEMO) {
      console.log('')
      console.log('[demo] 演示模式已启用：没有配置 CLOUD_ENDPOINT / CLOUD_PUBLISHABLE_KEY。')
      console.log('       · 公开页面（列表 / 详情）使用 data/sample-items.json 的示例数据')
      console.log('       · 后台管理不可用（登录与看板都需要真实的云服务）')
      console.log('       · 所有写操作与埋点上报都会被丢弃，不会持久化')
      console.log('       要接入真实数据：cp .env.example .env 并填入你自己的应用配置，见 README。')
      console.log('')
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
