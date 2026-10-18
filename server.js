import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk'
import { drawCover } from './og-image.js'
import { createDemoCloud } from './lib/demo-cloud.js'
import { loadEnv } from './lib/load-env.js'
import { renderList, renderDetail, renderError } from './lib/render.js'
import { createTrack } from './lib/track.js'
import { createAgentApi } from './lib/agent-api.js'
import { createItemsStore } from './lib/items-store.js'
import { sendJson, CORS_HEADERS } from './lib/http.js'

// ---------------------------------------------------------------------------
// 路由 handler：纯函数式 module，全部依赖经 deps 注入，import 本文件不起服务。
// 测试（test/server.test.js）与真实入口共用这一个 handler —— 同一条 seam。
// ---------------------------------------------------------------------------

function send(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

const STATIC_TYPES = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  woff: 'font/woff',
  png: 'image/png',
}

export function createHandler({ site, itemsStore, trackServerPageView, handleTrack, handleApi, getAdminHtml }) {
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
        return send(res, 405, renderError(site, '仅支持 GET 请求'))
      }
      if (path === '/' || path === '/index.html') {
        const items = await itemsStore.list()
        const html = renderList(site, items)
        // 先发埋点请求（RPC 立刻发出），再写响应 —— 两者重叠，不给用户加延迟
        trackServerPageView(req, { page: '/' })
        return send(res, 200, html)
      }
      if (path === '/admin') {
        const html = await getAdminHtml()
        return send(res, 200, html)
      }
      if (path.startsWith('/assets/')) {
        const rel = path.slice('/assets/'.length)
        // 仅放行 assets 下最多三层普通文件名（如 vendor/fonts/x.woff2），杜绝路径穿越
        if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,2}$/.test(rel) || rel.includes('..')) {
          return send(res, 404, renderError(site, '资源不存在'))
        }
        try {
          const buf = await readFile(fileURLToPath(new URL('./assets/' + rel, import.meta.url)))
          const ext = rel.slice(rel.lastIndexOf('.') + 1)
          const isFont = ext === 'woff2' || ext === 'woff'
          res.writeHead(200, {
            'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': isFont ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
          })
          return res.end(buf)
        } catch {
          return send(res, 404, renderError(site, '资源不存在'))
        }
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
      const m = path.match(/^\/item\/(\d+)\/?$/)
      if (m) {
        const it = await itemsStore.find(Number(m[1]))
        if (!it) {
          return send(res, 404, renderError(site, '未找到该研究成果'))
        }
        const html = renderDetail(site, it)
        trackServerPageView(req, { itemId: it.id, page: `/item/${it.id}` })
        return send(res, 200, html)
      }
      return send(res, 404, renderError(site, '页面不存在'))
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
      console.error('[research-share] error:', err && err.message)
      if (isApi) {
        return sendJson(res, 500, { ok: false, error: 'internal_error', message: '服务暂时不可用' }, CORS_HEADERS)
      }
      return send(res, 500, renderError(site, '服务暂时不可用，请稍后重试'))
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
    "<rect width='64' height='64' rx='14' fill='%230F1013'/>" +
    "<rect x='6.75' y='6.75' width='50.5' height='50.5' rx='9' fill='none' stroke='%23E0A458' stroke-opacity='.45' stroke-width='1.5'/>" +
    "<text x='32' y='45' font-family='Songti SC,serif' font-size='34' fill='%23E0A458' text-anchor='middle'>研</text></svg>"
  const FAVICON = 'data:image/svg+xml,' + FAVICON_SVG.replaceAll('#', '%23')

  // 传给页面模板 module 的站点配置（lib/render.js 不读环境变量）
  const site = { name: SITE_NAME, desc: SITE_DESC, url: SITE_URL, favicon: FAVICON }

  // 注入 admin.html 的公开配置（publishableKey 无权限语义，可进源码）
  const PUBLIC_CONFIG_JSON = JSON.stringify({
    endpoint: ENDPOINT,
    oauthRelayBaseUrl: OAUTH_RELAY,
    publishableKey: PUBLISHABLE_KEY,
    // 前端据此把「配置缺失」和「演示模式」区分开，给出不同提示
    demo: DEMO,
  }).replaceAll('<', '\\u003c')

  let adminHtmlCache = null
  async function getAdminHtml() {
    if (adminHtmlCache) return adminHtmlCache
    const tpl = await readFile(fileURLToPath(new URL('./admin.html', import.meta.url)), 'utf8')
    adminHtmlCache = tpl.replaceAll('__PUBLIC_CONFIG__', PUBLIC_CONFIG_JSON)
    return adminHtmlCache
  }

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

  const server = http.createServer(
    createHandler({ site, itemsStore, trackServerPageView, handleTrack, handleApi, getAdminHtml }),
  )

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[research-share] listening on 0.0.0.0:${PORT}, endpoint=${DEMO ? '(demo)' : ENDPOINT}`)
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
