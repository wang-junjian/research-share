// ---------------------------------------------------------------------------
// 埋点 module：UA / 来源 / IP 的解析与归类 + 服务端写入
//
// 完整设计见 docs/analytics.md。这里集中三条原则：
//  1. 解析只做一次、只在一个地方做（服务端）——客户端只负责送原始值
//     （referrer 与 UA 由浏览器自带），口径不会因为谁写前端而漂移。
//  2. 能落库的只有枚举值：device / os / browser / ref_kind 都是小写枚举，
//     没有原始 UA、没有 IP 明文。IP 只存「加盐 sha256 前 32 位」，不可逆。
//  3. 识别不准时的默认值要「安全」：未知一律 Other / other / desktop，
//     宁可少一个维度，也不要把猜测当成事实写进库。
//
// 纯函数（parseUA / classifyRef / cleanId / hashIp / clientIp /
// visitorFromCookie）直接导出，表驱动单测见 test/track.test.js；
// 有状态的部分（限流桶、cloud 落库）收进 createTrack factory。
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { readJsonBody, sendMethodNotAllowed } from './http.js'
import { APP_VERSION } from './constants.js'

// 机器流量：能识别就标记（不丢弃）。空 UA 也算 —— 真浏览器不会不带 UA。
const BOT_RE =
  /bot|spider|crawl|slurp|preview|headless|phantomjs|python-requests|curl\/|wget|http-client|node-fetch|axios\/|okhttp|go-http-client|java\/|libwww|scrapy|semrush|ahrefs|dataprovider|facebookexternalhit|whatsapp|telegrambot|bytespider|petalbot|yisouspider/i

// 反代之后 remoteAddress 只是内网地址，XFF 的第一个值才是真实客户端
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (xff) {
    const first = String(xff).split(',')[0].trim()
    if (first) return first
  }
  return (req.socket && req.socket.remoteAddress) || ''
}

export function hashIp(ip, salt) {
  if (!ip) return null
  return createHash('sha256').update(salt + '|' + ip).digest('hex').slice(0, 32)
}

export function parseUA(raw) {
  const ua = String(raw || '')
  const isBot = !ua || BOT_RE.test(ua)

  let device = 'desktop'
  if (/ipad|tablet|playbook|silk|kindle/i.test(ua)) device = 'tablet'
  else if (/mobi|android|iphone|ipod|windows phone|harmonyos/i.test(ua)) device = 'mobile'

  let os = 'Other'
  if (/harmonyos/i.test(ua)) os = 'HarmonyOS'
  else if (/windows nt/i.test(ua)) os = 'Windows'
  else if (/android/i.test(ua)) os = 'Android'
  else if (/iphone|ipad|ipod|ios/i.test(ua)) os = 'iOS'
  else if (/mac os x|macintosh/i.test(ua)) os = 'macOS'
  else if (/cros/i.test(ua)) os = 'ChromeOS'
  else if (/linux/i.test(ua)) os = 'Linux'

  // 顺序即优先级：微信 / QQ / UC 等国产内核的 UA 里同时带着 Chrome 与 Safari，
  // 放在后面判就永远判不到它们。
  let browser = 'Other'
  if (/micromessenger/i.test(ua)) browser = 'WeChat'
  else if (/wxwork/i.test(ua)) browser = 'WeCom'
  else if (/qqbrowser/i.test(ua)) browser = 'QQBrowser'
  else if (/ucbrowser|ubrowser|ucweb/i.test(ua)) browser = 'UC'
  else if (/huaweibrowser|honorbrowser/i.test(ua)) browser = 'Huawei'
  else if (/miuibrowser/i.test(ua)) browser = 'Xiaomi'
  else if (/baidubrowser|bidubrowser/i.test(ua)) browser = 'Baidu'
  else if (/sogoumobilebrowser|metasr/i.test(ua)) browser = 'Sogou'
  else if (/quark/i.test(ua)) browser = 'Quark'
  else if (/edg\//i.test(ua)) browser = 'Edge'
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera'
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox'
  else if (/crios|chrome/i.test(ua)) browser = 'Chrome'
  else if (/safari/i.test(ua)) browser = 'Safari'

  return { device, os, browser, isBot }
}

// 搜索引擎只认整段主机名，不用「包含 so 就算搜索」这种模糊规则 ——
// 后者会把 sos.example.com 之类无关域名算进来。
const SEARCH_HOST_RE =
  /(^|\.)(baidu\.com|sogou\.com|so\.com|bing\.com|google\.[a-z.]+|sm\.cn|toutiao\.com|shenma\.com|yisou\.com|so360\.com|haosou\.com|ecosia\.org|duckduckgo\.com|yandex\.[a-z]+|naver\.com)$/

/**
 * 来源归类。
 *
 * 有一个刻意的例外：微信内置浏览器的 referrer **恒为空**（微信会剥掉它），
 * 只看 referrer 会把「朋友在群里转给我、我点开」的流量全部算成「直接访问」，
 * 于是来源面板永远看不到微信 —— 而那恰恰是本站最重要的传播渠道。
 * 所以容器优先按 UA 判（MicroMessenger），其余一律按 referrer 判。
 */
export function classifyRef(referrer, ua, siteUrl) {
  if (/micromessenger/i.test(String(ua || ''))) return 'wechat'
  const r = String(referrer || '').trim()
  if (!r) return 'direct'
  let host = ''
  try {
    host = new URL(r).hostname.toLowerCase()
  } catch {
    return 'other'
  }
  if (!host) return 'other'
  let selfHost = ''
  try {
    selfHost = new URL(siteUrl).hostname.toLowerCase()
  } catch { /* 配置异常时退化为不做站内判定 */ }
  if (selfHost && host === selfHost) return 'internal'
  if (/(^|\.)weixin\.qq\.com$/.test(host)) return 'wechat'
  if (/(^|\.)(zhihu\.com|zhihulive\.com|zhihu\.pro)$/.test(host)) return 'zhihu'
  if (SEARCH_HOST_RE.test(host)) return 'search'
  return 'other'
}

// 身份 id 的格式校验（与数据库函数里那条正则保持一致）：
// 只接受 8~64 位 [A-Za-z0-9_-]，挡住把事件表当 KV 存储乱写的尝试
export function cleanId(v) {
  const s = String(v == null ? '' : v)
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null
}

// SSR 侧从 cookie 里取客户端写的 visitor_id（首次访问时还没有，返回 null）
export function visitorFromCookie(req) {
  const raw = String(req.headers.cookie || '')
  const m = /(?:^|;\s*)rs_vid=([^;]*)/.exec(raw)
  if (!m) return null
  let v = m[1]
  try {
    v = decodeURIComponent(v)
  } catch { /* 非法编码就按原文校验 */ }
  return cleanId(v)
}

// ---------------------------------------------------------------------------
// 埋点写入（服务端一侧）
//
// 两条路径，共用同一个数据库函数 track_event：
//   A. SSR page_view —— 渲染 / 与 /item/:id 成功后直接写一条 source='server'。
//      这是唯一能覆盖「JS 没跑起来」的流量（广告拦截、脚本报错、微信内核异常）。
//   B. POST /api/track —— 浏览器批量上报，source='client'。
//
// 两者的数量关系本身就是指标：客户端 ÷ 服务端 = 埋点覆盖率（看板 F 区块）。
// 因此这里有一个**必须保留的细节**：SSR 那条**不带 session_id**。
// 带了的话，同一个会话里的客户端 page_view 会在 3 秒去抖窗口内被判为重复而丢弃
// —— 覆盖率就恒等于 1，这个指标也就废了。
// ---------------------------------------------------------------------------

const TRACK_MAX_BODY = 16 * 1024 // 客户端最多攒 10 条，16KB 是宽松上限
const TRACK_MAX_EVENTS = 20      // 单次最多接受多少条事件
const TRACK_RATE_WINDOW = 60_000 // 单 IP 频控窗口
const TRACK_RATE_MAX = 60        // 单 IP 每窗口最多多少次请求（事件数另有会话级上限）

// 口径版本 APP_VERSION 来自共享常量单一来源（lib/constants.js，
// GLOSSARY: 共享常量），与客户端 assets/track.js 读到的 window.RS_CONST 同源。
// SSR 这条也带上，否则 versions 面板里同口径的事件会被拆成两个版本块。

// Origin 白名单：只认本站与本地调试地址。sendBeacon 在页面卸载时也可能不带
// Origin，所以「缺失」必须放行（否则会丢掉最宝贵的那批事件）。
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function createTrack({ salt, siteUrl, cloud, debug = false }) {
  const rateBuckets = new Map() // ip -> { at, n }

  function ipOverLimit(ip) {
    if (!ip) return false
    const now = Date.now()
    const rec = rateBuckets.get(ip)
    if (!rec || now - rec.at >= TRACK_RATE_WINDOW) {
      rateBuckets.set(ip, { at: now, n: 1 })
      // 防止 Map 被无限撑大：只在超阈值时顺手清理过期桶
      if (rateBuckets.size > 5000) {
        for (const [k, v] of rateBuckets) {
          if (now - v.at >= TRACK_RATE_WINDOW) rateBuckets.delete(k)
        }
      }
      return false
    }
    rec.n += 1
    return rec.n > TRACK_RATE_MAX
  }

  function originAllowed(req) {
    const origin = String(req.headers.origin || '').trim()
    if (!origin || origin === 'null') return true
    let host = ''
    try {
      host = new URL(origin).hostname.toLowerCase()
    } catch {
      return false
    }
    if (LOCAL_HOSTS.has(host)) return true
    try {
      return host === new URL(siteUrl).hostname.toLowerCase()
    } catch {
      return true // 配置异常时不因白名单把正常流量拦掉
    }
  }

  // 落库：串行、按批内原始顺序，失败只记一行日志。
  //
  // 为什么必须串行：occurred_at 由数据库 now() 决定，并行插入时同一批事件的时间戳
  // 是乱序的 —— 实测会出现 session_start 排在 page_view 之后，实时事件流看着像坏了，
  // 「按最早事件判定来源」的归因也会跟着飘。串行插入换来的时间是服务端的，
  // 客户端早已拿到 204，不影响任何人。
  // 失败不重试：埋点丢几条远好过让用户多等 200ms。
  //
  // 返回落库完成的 promise（永不 reject：错误已在此 catch）。生产调用方不 await
  // —— 「永远 204、不阻塞响应」的语义不变；这个出口是给测试的确定性同步点，
  // 见 test/track-handler.test.js 的 flush()。
  function writeEvents(jobs, tag) {
    if (!jobs.length) return Promise.resolve()
    return (async () => {
      for (const job of jobs) {
        try {
          const r = await job()
          if (r && r.error) throw new Error(String(r.error.message || r.error))
          if (debug) console.log(`[track] ${tag} <-`, r && r.data)
        } catch (e) {
          console.warn(`[research-share] ${tag} 落库失败:`, (e && e.message) || e)
          return // 连不上库时继续打也是白打
        }
      }
    })()
  }

  // A. SSR：页面渲染成功后补一条服务端 page_view
  function trackServerPageView(req, { itemId = null, page }) {
    const ua = String(req.headers['user-agent'] || '')
    const { device, os, browser, isBot } = parseUA(ua)
    const referrer = String(req.headers.referer || '')
    return writeEvents([
      () => cloud.database.rpc('track_event', {
        p_event: 'page_view',
        p_visitor: visitorFromCookie(req),
        // 见本节开头：刻意不带 session_id，否则会撞掉客户端那条、覆盖率恒为 1
        p_session: null,
        p_item: itemId,
        p_page: page,
        p_referrer: referrer || null,
        p_ref_kind: classifyRef(referrer, ua, siteUrl),
        p_device: device,
        p_os: os,
        p_browser: browser,
        p_props: {},
        p_source: 'server',
        p_app_version: APP_VERSION,
        p_ip_hash: hashIp(clientIp(req), salt),
        p_is_bot: isBot,
      }),
    ], 'ssr page_view')
  }

  // B. 浏览器批量上报
  async function handleTrack(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Cache-Control': 'no-store' })
      return res.end()
    }
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST', 'OPTIONS'])

    const ip = clientIp(req)
    const ua = String(req.headers['user-agent'] || '')
    const { device, os, browser, isBot } = parseUA(ua)

    // 先把请求体收干净，再回应 —— 但要先发回应、后落库（见下）
    let body = null
    try {
      body = await readJsonBody(req, TRACK_MAX_BODY)
    } catch {
      body = null
    }
    if (!originAllowed(req)) body = null

    // 无论上面发生了什么，一律 204：埋点不上用户可感知路径，
    // 也不给调用方任何「这条路通不通、参数对不对」的可用反馈。
    res.writeHead(204, { 'Cache-Control': 'no-store' })
    res.end()

    if (!body || typeof body !== 'object' || Array.isArray(body)) return
    if (ipOverLimit(ip)) return

    const list = Array.isArray(body.events) ? body.events.slice(0, TRACK_MAX_EVENTS) : []
    if (!list.length) return

    if (debug) {
      console.log(`[track] batch n=${list.length} ua=${JSON.stringify(ua)} isBot=${isBot} names=${list.map((e) => (e && e.n) || '?').join(',')}`)
    }

    const visitor = cleanId(body.v)
    const session = cleanId(body.s)
    // 口径版本：客户端发 ver（改口径必须递增），落进 app_version 列。
    // 格式非法就不传这个参数，走数据库默认 'v1'，不让脏值进维度。
    const ver = typeof body.ver === 'string' && /^v\d{1,8}$/.test(body.ver) ? body.ver : null
    const referrer = typeof body.rf === 'string' ? body.rf : String(req.headers.referer || '')
    const refKind = classifyRef(referrer, ua, siteUrl)
    const ipHash = hashIp(ip, salt)

    const jobs = []
    for (const ev of list) {
      if (!ev || typeof ev !== 'object') continue
      const name = String(ev.n || '').toLowerCase()
      if (!name) continue
      // 不在这里判白名单：合法性由数据库函数单点裁决，
      // 这样「被丢弃的事件」才能被 analytics_drops 如实计数（看板健康度要用）。
      jobs.push(() => cloud.database.rpc('track_event', {
        p_event: name,
        p_visitor: visitor,
        p_session: session,
        p_item: Number.isInteger(ev.i) ? ev.i : null,
        p_page: typeof ev.pg === 'string' ? ev.pg : null,
        p_referrer: referrer || null,
        p_ref_kind: refKind,
        p_device: device,
        p_os: os,
        p_browser: browser,
        p_props: ev.p && typeof ev.p === 'object' && !Array.isArray(ev.p) ? ev.p : {},
        p_source: 'client',
        p_ip_hash: ipHash,
        p_is_bot: isBot,
        // 合法才传；null 时省略此参数，走数据库默认 'v1'
        ...(ver ? { p_app_version: ver } : {}),
      }))
    }
    // 落库 promise 透传给调用方：生产不 await（204 已发），测试靠它同步
    return writeEvents(jobs, 'track')
  }

  return { trackServerPageView, handleTrack }
}
