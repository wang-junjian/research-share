import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk'
import { drawCover } from './og-image.js'
import { createDemoCloud } from './lib/demo-cloud.js'
import { loadEnv } from './lib/load-env.js'

// 先读 .env，再读下面的配置。已存在的环境变量优先，不会被 .env 覆盖。
loadEnv()

// ---------------------------------------------------------------------------
// 配置
//
// 全部来自环境变量（见 .env.example）。这里**刻意不提供任何默认密钥**：
// 一旦把某个人真实的 publishableKey 硬编码进源码，所有 clone 本仓库的人
// 都会用同一个应用身份读写同一份数据库 —— 那是别人的数据。
//
// 缺配置时进入演示模式（lib/demo-cloud.js）：只读、零依赖，用于先看界面。
// ---------------------------------------------------------------------------
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

// 演示模式：缺任一必需配置即启用。只读，用于零配置预览界面。
const DEMO = !ENDPOINT || !PUBLISHABLE_KEY

const FAVICON_SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>" +
  "<rect width='64' height='64' rx='14' fill='%230F1013'/>" +
  "<rect x='6.75' y='6.75' width='50.5' height='50.5' rx='9' fill='none' stroke='%23E0A458' stroke-opacity='.45' stroke-width='1.5'/>" +
  "<text x='32' y='45' font-family='Songti SC,serif' font-size='34' fill='%23E0A458' text-anchor='middle'>研</text></svg>"
const FAVICON = 'data:image/svg+xml,' + FAVICON_SVG.replaceAll('#', '%23')

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

// ---------------------------------------------------------------------------
// 数据访问：60s 内存缓存，减少对数据面的请求
// ---------------------------------------------------------------------------
const CACHE_TTL = 60_000
let cache = { items: null, at: 0 }

async function getItems({ fresh = false } = {}) {
  if (!fresh && cache.items && Date.now() - cache.at < CACHE_TTL) return cache.items
  const { data, error } = await cloud.database
    .from('research_items')
    // source_key / source_agent / updated_at 只有 /api/* 用得到，页面模板不渲染它们，
    // 一起取回来是为了让 agent 读写走同一份数据，不必再查一次库
    .select('id, title, summary, url, item_date, owner_name, source_key, source_agent, created_at, updated_at')
    .order('item_date', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) throw error
  cache = { items: data || [], at: Date.now() }
  return cache.items
}

function invalidateCache() {
  cache = { items: null, at: 0 }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function truncate(s, n) {
  const t = String(s ?? '').trim()
  return t.length <= n ? t : t.slice(0, n).trimEnd() + '…'
}

function fmtDate(d) {
  return String(d ?? '').slice(0, 10)
}

// 年份已在 tag 中，正文只显示 月-日
function fmtMD(d) {
  const s = fmtDate(d)
  return s.length >= 10 ? s.slice(5) : s
}

function yearTag(dateStr) {
  const y = fmtDate(dateStr).slice(0, 4) || ''
  const now = String(new Date().getFullYear())
  return `<span class="tag ${y === now ? 't-now' : 't-past'}">${esc(y)}</span>`
}

// 编号：用数据库主键，稳定不随排序变化，像笔记的索引号
function itemNo(id) {
  return `<span class="entry-no">NO.${String(id).padStart(3, '0')}</span>`
}

function byLine(it) {
  return it.owner_name ? `<span class="entry-by">${esc(it.owner_name)}</span>` : ''
}

// ---------------------------------------------------------------------------
// 埋点：UA / 来源 / IP 的解析与归类
//
// 完整设计见 analytics/DESIGN.md。这里集中三条原则：
//  1. 解析只做一次、只在一个地方做（服务端）——客户端只负责送原始值
//     （referrer 与 UA 由浏览器自带），口径不会因为谁写前端而漂移。
//  2. 能落库的只有枚举值：device / os / browser / ref_kind 都是小写枚举，
//     没有原始 UA、没有 IP 明文。IP 只存「加盐 sha256 前 32 位」，不可逆。
//  3. 识别不准时的默认值要「安全」：未知一律 Other / other / desktop，
//     宁可少一个维度，也不要把猜测当成事实写进库。
// ---------------------------------------------------------------------------

const ANALYTICS_SALT = process.env.ANALYTICS_SALT || 'research-share/v1/ip'

// 机器流量：能识别就标记（不丢弃）。空 UA 也算 —— 真浏览器不会不带 UA。
const BOT_RE =
  /bot|spider|crawl|slurp|preview|headless|phantomjs|python-requests|curl\/|wget|http-client|node-fetch|axios\/|okhttp|go-http-client|java\/|libwww|scrapy|semrush|ahrefs|dataprovider|facebookexternalhit|whatsapp|telegrambot|bytespider|petalbot|yisouspider/i

// 反代之后 remoteAddress 只是内网地址，XFF 的第一个值才是真实客户端
function clientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (xff) {
    const first = String(xff).split(',')[0].trim()
    if (first) return first
  }
  return (req.socket && req.socket.remoteAddress) || ''
}

function hashIp(ip) {
  if (!ip) return null
  return createHash('sha256').update(ANALYTICS_SALT + '|' + ip).digest('hex').slice(0, 32)
}

function parseUA(raw) {
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
function classifyRef(referrer, ua) {
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
    selfHost = new URL(SITE_URL).hostname.toLowerCase()
  } catch { /* 配置异常时退化为不做站内判定 */ }
  if (selfHost && host === selfHost) return 'internal'
  if (/(^|\.)weixin\.qq\.com$/.test(host)) return 'wechat'
  if (/(^|\.)(zhihu\.com|zhihulive\.com|zhihu\.pro)$/.test(host)) return 'zhihu'
  if (SEARCH_HOST_RE.test(host)) return 'search'
  return 'other'
}

// 身份 id 的格式校验（与数据库函数里那条正则保持一致）：
// 只接受 8~64 位 [A-Za-z0-9_-]，挡住把事件表当 KV 存储乱写的尝试
function cleanId(v) {
  const s = String(v == null ? '' : v)
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null
}

// SSR 侧从 cookie 里取客户端写的 visitor_id（首次访问时还没有，返回 null）
function visitorFromCookie(req) {
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
// 页面模板（视觉见 assets/style.css：浅色纸感 + 朱红批注）
// ---------------------------------------------------------------------------

// 视图状态在 <head> 里就写进 documentElement，首次绘制即生效，切换不闪
const VIEW_STATE_SCRIPT = `<script>try{if(localStorage.getItem('rs:view')==='list')document.documentElement.setAttribute('data-view','list')}catch(e){}</script>`

const ICON_GRID = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>'
const ICON_LIST = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>'
const ICON_EDIT = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'

// 分享面板的四个图标（20px，线性，与站内图标同一套笔法）
const shareIcon = (paths) => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>'
const ICON_LINK = shareIcon('<path d="M10.5 13.5a4.5 4.5 0 0 0 6.4.5l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.5"/><path d="M13.5 10.5a4.5 4.5 0 0 0-6.4-.5L4.5 12.6a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5"/>')
const ICON_EYE = shareIcon('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>')
const ICON_COPY_IMG = shareIcon('<rect x="3" y="3" width="13" height="13" rx="2"/><circle cx="7.4" cy="7.4" r="1.3"/><path d="m3 13 2.6-2.6a1.6 1.6 0 0 1 2.3 0L11 13.5"/><path d="M18 20.5h1.5a2 2 0 0 0 2-2V17"/><path d="M9 20.5h6"/>')
const ICON_IMG_TEXT = shareIcon('<rect x="3" y="2.5" width="18" height="13" rx="2"/><circle cx="8" cy="7.5" r="1.4"/><path d="m3.6 15.5 3.4-3.4a1.6 1.6 0 0 1 2.3 0l3.3 3.3"/><path d="M6 19.5h12"/><path d="M6 22h7"/>')
const ICON_TEXT = shareIcon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9.4 13h5.2"/><path d="M9.4 17h3.4"/>')

// 视图切换：只改 documentElement 上的 data-view，排布完全交给 CSS
const VIEW_SWITCH_SCRIPT = `<script>
(function () {
  var btns = document.querySelectorAll('.view-btn')
  if (!btns.length) return
  function current() {
    return document.documentElement.getAttribute('data-view') === 'list' ? 'list' : 'grid'
  }
  function apply(v) {
    if (v === 'list') document.documentElement.setAttribute('data-view', 'list')
    else document.documentElement.removeAttribute('data-view')
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-view') === v
      btns[i].classList.toggle('is-on', on)
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false')
    }
  }
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function () {
      var v = this.getAttribute('data-view')
      apply(v)
      try { localStorage.setItem('rs:view', v) } catch (e) {}
    })
  }
  apply(current())
})()
</script>`

// 页脚：隐私说明与「一键退出统计」入口。退出写 localStorage + cookie，
// assets/track.js 在每次入队前都会重读这个开关，点了立刻生效（不用刷新）。
const FOOT_NOTE = `<p class="foot-note"><span>${esc(SITE_NAME)} · 微信内转发本页即可分享卡片</span><span class="foot-dot">·</span><a class="foot-opt" href="#" data-optout title="本站只用随机 id 统计访问量：不记录 IP、不记录个人信息、不跨站追踪。点此可退出统计。">匿名统计 · 可退出</a></p>`

const OPTOUT_SCRIPT = `<script>
(function () {
  var a = document.querySelector('.foot-opt')
  if (!a) return
  function off() {
    try {
      return localStorage.getItem('rs:optout') === '1' || /(?:^|; )rs_optout=1/.test(document.cookie)
    } catch (e) { return false }
  }
  function paint() {
    var o = off()
    a.textContent = o ? '已退出统计 · 点此恢复' : '匿名统计 · 可退出'
    a.setAttribute('aria-pressed', o ? 'true' : 'false')
  }
  a.addEventListener('click', function (e) {
    e.preventDefault()
    var next = off() ? '0' : '1'
    try {
      localStorage.setItem('rs:optout', next)
      document.cookie = 'rs_optout=' + next + ';path=/;max-age=31536000;SameSite=Lax'
    } catch (err) {}
    paint()
  })
  paint()
})()
</script>`

function layout({ title, description, ogType = 'website', canonical = '', ogImage = '', body, script = '', viewScript = false }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="${FAVICON}">
<meta property="og:site_name" content="${esc(SITE_NAME)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="${esc(ogType)}">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:image" content="${esc(ogImage)}">` : ''}
${canonical ? `<meta property="og:url" content="${esc(canonical)}">\n<link rel="canonical" href="${esc(canonical)}">` : ''}
<link rel="stylesheet" href="/assets/style.css">
${viewScript ? VIEW_STATE_SCRIPT : ''}
<script src="/assets/track.js" defer></script>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <div class="brand">
      <a href="/">
        <span class="logo-mark">研</span>
        <span class="brand-name">${esc(SITE_NAME)}</span>
      </a>
      <span class="brand-tag">RESEARCH NOTES</span>
    </div>
    <div class="topbar-spacer"></div>
    <nav class="topbar-nav">
      <a class="topbar-link" href="/admin">${ICON_EDIT}<span>管理</span></a>
    </nav>
  </div>
</header>
<main class="page">
${body}
</main>
${FOOT_NOTE}
${OPTOUT_SCRIPT}
${script}
<script>
(function () {
  var q = new URLSearchParams(location.search)
  if (q.has('code') || q.has('error')) {
    location.replace('/admin' + location.search + location.hash)
  }
})()
</script>
</body>
</html>`
}

function renderList(items) {
  const cards = items.length
    ? items
        .map(
          (it) => `<a class="entry" href="/item/${it.id}">
  <div class="entry-body">
    <div class="entry-top">
      ${itemNo(it.id)}
      ${yearTag(it.item_date)}
    </div>
    <div class="entry-title">${esc(it.title)}</div>
    <div class="entry-summary">${esc(it.summary)}</div>
    <div class="entry-foot">
      <span class="entry-date">${esc(fmtMD(it.item_date))}</span>
      ${byLine(it)}
    </div>
  </div>
  <div class="entry-arrow">→</div>
</a>`
        )
        .join('\n')
    : '<div class="empty"><h3>暂无研究成果</h3><p>从后台录入第一条成果后，这里会立即出现。</p></div>'

  const viewSwitch = `<div class="view-switch" role="group" aria-label="切换视图">
    <button type="button" class="view-btn" data-view="grid" aria-pressed="true" title="网格视图" aria-label="网格视图">${ICON_GRID}</button>
    <button type="button" class="view-btn" data-view="list" aria-pressed="false" title="列表视图" aria-label="列表视图">${ICON_LIST}</button>
  </div>`

  return layout({
    title: SITE_NAME + ' · 研究笔记',
    description: SITE_DESC,
    canonical: SITE_URL + '/',
    viewScript: true,
    // fit.js 不加 defer：它紧跟在卡片后面解析，在首绘之前就把摘要行数算好，
    // 因此看不到「先按 fallback 行数画一帧、再跳成正确行数」的闪烁。
    script: '<script src="/assets/fit.js"></script>' + VIEW_SWITCH_SCRIPT,
    body: `<div class="page-head">
  <div class="page-title">研究成果</div>
  <div class="page-sub">${items.length ? `共 ${items.length} 条 · 按日期倒序` : '研究笔记 · 持续更新'}</div>
  ${items.length ? viewSwitch : ''}
</div>
<div class="entry-list">
${cards}
</div>`,
  })
}

function renderDetail(it) {
  const desc = truncate(it.summary, 80)
  const canonical = `${SITE_URL}/item/${it.id}`
  const ogImage = `${SITE_URL}/og/${it.id}.png`
  // 分享条把数据挂在 data-* 上，由 assets/share.js 读取，避免重复请求
  const shareData = [
    `data-share`,
    `data-title="${esc(it.title)}"`,
    // data-summary 给海报用（限 220 字，免得版面被撑爆）；data-overview 是纯文字分享
    // 要用的完整概览 —— 两者口径不同，别合并
    `data-summary="${esc(truncate(it.summary, 220))}"`,
    `data-overview="${esc(it.summary)}"`,
    `data-date="${esc(fmtDate(it.item_date))}"`,
    `data-by="${esc(it.owner_name || '')}"`,
    `data-no="${String(it.id).padStart(3, '0')}"`,
    `data-url="${esc(canonical)}"`,
    `data-src="${esc(it.url || '')}"`,
  ].join(' ')

  return layout({
    title: it.title,
    description: desc,
    ogType: 'article',
    canonical,
    ogImage,
    script: '<script src="/assets/share.js" defer></script>',
    body: `<article class="detail card-panel">
  <div class="entry-top">
    ${itemNo(it.id)}
    ${yearTag(it.item_date)}
    <span class="entry-date">${esc(fmtDate(it.item_date))}</span>
    ${byLine(it)}
  </div>
  <h1 class="detail-title">${esc(it.title)}</h1>
  <p class="detail-summary">${esc(it.summary)}</p>
  <hr class="detail-rule">
  <div class="detail-foot">
    <a class="btn btn-primary" href="${esc(it.url)}" rel="noopener">查看原文 ↗</a>
    <a class="btn btn-ghost" href="/">← 全部成果</a>
  </div>
  <div class="detail-src">原文链接：<a href="${esc(it.url)}" rel="noopener">${esc(it.url)}</a></div>
</article>

<div class="sharebar" ${shareData}>
  <div class="sharebar-head"><span class="sharebar-label">分享</span></div>
  <div class="share-actions">
    <button class="share-act" type="button" data-act="copy-link">
      <span class="share-act-ico">${ICON_LINK}</span>
      <span class="share-act-txt">
        <span class="share-act-name">复制本页链接</span>
        <span class="share-act-desc">粘贴到微信即可发送</span>
      </span>
    </button>
    <button class="share-act" type="button" data-act="copy-text">
      <span class="share-act-ico">${ICON_TEXT}</span>
      <span class="share-act-txt">
        <span class="share-act-name">复制文字+原文链接</span>
        <span class="share-act-desc">含标题、概览与链接</span>
      </span>
    </button>
    <button class="share-act" type="button" data-act="show-poster">
      <span class="share-act-ico">${ICON_EYE}</span>
      <span class="share-act-txt">
        <span class="share-act-name">显示海报图</span>
        <span class="share-act-desc">预览长图，可保存下载</span>
      </span>
    </button>
    <button class="share-act" type="button" data-act="copy-poster">
      <span class="share-act-ico">${ICON_COPY_IMG}</span>
      <span class="share-act-txt">
        <span class="share-act-name">复制海报图</span>
        <span class="share-act-desc">图片直接粘贴进聊天</span>
      </span>
    </button>
    <button class="share-act" type="button" data-act="copy-poster-link">
      <span class="share-act-ico">${ICON_IMG_TEXT}</span>
      <span class="share-act-txt">
        <span class="share-act-name">复制海报图+原文链接</span>
        <span class="share-act-desc">图片与原文链接一起复制</span>
      </span>
    </button>
  </div>
  <p class="share-note" data-note role="status" aria-live="polite"></p>
</div>
<div data-poster-mount></div>`,
  })
}

function renderError(msg) {
  return layout({
    title: '出错了 · ' + SITE_NAME,
    description: '页面暂时不可用',
    body: `<div class="empty" style="margin-top:48px"><h3>${esc(msg)}</h3><p><a href="/">返回研究成果列表</a></p></div>`,
  })
}

// ---------------------------------------------------------------------------
// Agent API（/api/*）
//
// 为什么需要这一层：服务端进程是 anon 身份，而 anon 在 research_items 上只有
// SELECT —— 直连表根本写不进去；也不该把 INSERT 授权给 anon（publishableKey
// 明文写在源码里，那等于公开写权限）。所以写操作一律经数据库里的
// SECURITY DEFINER 函数落库，token 校验与字段校验都发生在函数内部，
// 库里只存 token 的 SHA-256，原文不落任何地方。
//
// 认证：Authorization: Bearer <token>
// 读：公开（与网站同源，本来就是公开数据）
// ---------------------------------------------------------------------------

const API_MAX_BODY = 512 * 1024 // 512KB，批量 500 条约 200KB，留一倍余量

function httpError(status, code, message) {
  const e = new Error(message)
  e.status = status
  e.code = code
  e.expose = true
  return e
}

function sendJson(res, code, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2) + '\n'
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

function sendMethodNotAllowed(res, allow) {
  sendJson(res, 405, { ok: false, error: 'method_not_allowed', message: `该路径只支持 ${allow.join(' / ')}` }, { Allow: allow.join(', ') })
}

// CORS：接口无 cookie / 无会话，凭证就是 Bearer token，所以放开来源不会
// 让第三方页面凭空获得写权限（它拿不到 token）。放开是为了让浏览器里的
// agent 工具也能直接调。
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, X-Agent-Token, Content-Type',
  'Access-Control-Max-Age': '86400',
}

function readJsonBody(req, max = API_MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks = []
    req.on('data', (c) => {
      if (settled) return
      size += c.length
      if (size > max) {
        settled = true
        reject(httpError(413, 'payload_too_large', `请求体过大（上限 ${Math.round(max / 1024)}KB）`))
        // 这里**不能** req.destroy()：调用方随后还要写响应（接口是 413、埋点是 204），
        // 立刻销毁 socket 会让响应根本发不出去 —— 客户端只看到连接被重置
        // （实测 curl 拿到 000 而不是 204/413）。改成把余下数据排空，连接能正常收尾；
        // 内存仍由上面的 size 上限守住，只是不再「连读都不读」。
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(httpError(400, 'invalid_json', '请求体不是合法 JSON'))
      }
    })
    req.on('error', (e) => {
      if (settled) return
      settled = true
      reject(e)
    })
  })
}

const TOKEN_VALUE_RE = /^[A-Za-z0-9._~-]{16,200}$/

// 取 token。三道通道按优先级试：
//   1) Authorization: Bearer <token>   —— 标准做法，本地直连可用
//   2) X-Agent-Token: <token>          —— 自定义头
//   3) ?token=<token> / ?access_token= —— 查询串
// 为什么不止用 1：这个平台的边缘代理会把 Authorization 请求头吃掉，
// 线上实测同一个 token 走 header 得到 missing_token、走查询串正常。
// 查询串的代价是 token 会进 URL（日志/历史），所以 header 能用就优先用。
function extractToken(req, reqUrl) {
  const h = req.headers['authorization']
  if (h) {
    const m = /^Bearer\s+(.+)$/i.exec(String(h).trim())
    if (m && TOKEN_VALUE_RE.test(m[1].trim())) return { token: m[1].trim(), via: 'header.authorization' }
  }
  const x = req.headers['x-agent-token']
  if (x) {
    const v = String(x).trim()
    if (TOKEN_VALUE_RE.test(v)) return { token: v, via: 'header.x-agent-token' }
  }
  if (reqUrl) {
    for (const k of ['token', 'access_token']) {
      const v = (reqUrl.searchParams.get(k) || '').trim()
      if (TOKEN_VALUE_RE.test(v)) return { token: v, via: `query.${k}` }
    }
  }
  return { token: '', via: '' }
}

function requireToken(req, reqUrl) {
  const { token } = extractToken(req, reqUrl)
  if (!token) {
    throw httpError(
      401,
      'missing_token',
      '未收到 token。可用 Authorization: Bearer <token>、X-Agent-Token: <token>，或 ?token=<token>',
    )
  }
  return token
}

// 数据库函数抛的异常 → HTTP 语义。message 形如 'missing_field: title'
const RPC_ERRORS = [
  [/^invalid_token/, 401, 'invalid_token', 'token 无效或已失效'],
  [/^item_not_found/, 404, 'not_found', '目标条目不存在'],
  [/^missing_field/, 400, 'missing_field', '缺少必填字段'],
  [/^invalid_field/, 400, 'invalid_field', '字段不合法'],
  [/^field_too_long/, 400, 'field_too_long', '字段超长'],
]

function rpcFailure(res, err) {
  const msg = String((err && err.message) || err || '')
  for (const [re, status, code, zh] of RPC_ERRORS) {
    if (!re.test(msg)) continue
    const detail = msg.replace(/^[a-z_]+:\s*/, '')
    return sendJson(res, status, {
      ok: false,
      error: code,
      message: detail === msg ? zh : `${zh}（${detail}）`,
    }, CORS_HEADERS)
  }
  console.error('[research-share] rpc error:', msg, (err && err.code) || '')
  return sendJson(res, 502, { ok: false, error: 'database_error', message: `数据库调用失败：${msg}` }, CORS_HEADERS)
}

async function callRpc(fn, args) {
  return cloud.database.rpc(fn, args)
}

// 从请求体里取字符串字段：缺失 → null（可选）或抛 400（必填）；类型不对 → 400
function pickText(body, key, { required = false, max = 0 } = {}) {
  const v = body[key]
  if (v === undefined || v === null || v === '') {
    if (required) throw httpError(400, 'missing_field', `缺少必填字段：${key}`)
    return null
  }
  if (typeof v !== 'string') throw httpError(400, 'invalid_field', `${key} 必须是字符串`)
  if (max && v.length > max) throw httpError(400, 'field_too_long', `${key} 超过 ${max} 字`)
  return v
}

function pickDate(body, key) {
  const v = body[key]
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw httpError(400, 'invalid_field', `${key} 必须是 YYYY-MM-DD 格式`)
  }
  return v
}

// 对外统一形态：页面 URL 与 OG 封面图一起给出，agent 直接就能拿去分享
function apiShape(it) {
  return {
    id: it.id,
    no: 'NO.' + String(it.id).padStart(3, '0'),
    title: it.title,
    summary: it.summary,
    url: it.url,
    date: fmtDate(it.item_date),
    owner: it.owner_name || null,
    source_key: it.source_key || null,
    source_agent: it.source_agent || null,
    created_at: it.created_at || null,
    updated_at: it.updated_at || null,
    page_url: `${SITE_URL}/item/${it.id}`,
    og_image: `${SITE_URL}/og/${it.id}.png`,
  }
}

async function findItem(id) {
  const items = await getItems({ fresh: true })
  return items.find((x) => x.id === id) || null
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
// 本地排查埋点用：TRACK_DEBUG=1 打开后打印每批的 UA / 判定与每条落库结果
const TRACK_DEBUG = !!process.env.TRACK_DEBUG

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

// Origin 白名单：只认本站与本地调试地址。sendBeacon 在页面卸载时也可能不带
// Origin，所以「缺失」必须放行（否则会丢掉最宝贵的那批事件）。
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

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
    return host === new URL(SITE_URL).hostname.toLowerCase()
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
function writeEvents(jobs, tag) {
  if (!jobs.length) return
  void (async () => {
    for (const job of jobs) {
      try {
        const r = await job()
        if (r && r.error) throw new Error(String(r.error.message || r.error))
        if (TRACK_DEBUG) console.log(`[track] ${tag} <-`, r && r.data)
      } catch (e) {
        console.warn(`[research-share] ${tag} 落库失败:`, (e && e.message) || e)
        return // 连不上库时继续打也是白打
      }
    }
  })()
}

function rpcTrack(args) {
  return cloud.database.rpc('track_event', args)
}

// A. SSR：页面渲染成功后补一条服务端 page_view
function trackServerPageView(req, { itemId = null, page }) {
  const ua = String(req.headers['user-agent'] || '')
  const { device, os, browser, isBot } = parseUA(ua)
  const referrer = String(req.headers.referer || '')
  writeEvents([
    () => rpcTrack({
      p_event: 'page_view',
      p_visitor: visitorFromCookie(req),
      // 见本节开头：刻意不带 session_id，否则会撞掉客户端那条、覆盖率恒为 1
      p_session: null,
      p_item: itemId,
      p_page: page,
      p_referrer: referrer || null,
      p_ref_kind: classifyRef(referrer, ua),
      p_device: device,
      p_os: os,
      p_browser: browser,
      p_props: {},
      p_source: 'server',
      p_ip_hash: hashIp(clientIp(req)),
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

  if (TRACK_DEBUG) {
    console.log(`[track] batch n=${list.length} ua=${JSON.stringify(ua)} isBot=${isBot} names=${list.map((e) => (e && e.n) || '?').join(',')}`)
  }

  const visitor = cleanId(body.v)
  const session = cleanId(body.s)
  const referrer = typeof body.rf === 'string' ? body.rf : String(req.headers.referer || '')
  const refKind = classifyRef(referrer, ua)
  const ipHash = hashIp(ip)

  const jobs = []
  for (const ev of list) {
    if (!ev || typeof ev !== 'object') continue
    const name = String(ev.n || '').toLowerCase()
    if (!name) continue
    // 不在这里判白名单：合法性由数据库函数单点裁决，
    // 这样「被丢弃的事件」才能被 analytics_drops 如实计数（看板健康度要用）。
    jobs.push(() => rpcTrack({
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
    }))
  }
  writeEvents(jobs, 'track')
}

async function handleApi(req, res, path, reqUrl) {
  // 埋点上报语义不同（公开、无 token、永远 204），先于其它 API 分流
  if (path === '/api/track' || path === '/api/track/') return handleTrack(req, res)

  const method = req.method === 'HEAD' ? 'GET' : req.method

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    return res.end()
  }

  const itemMatch = /^\/api\/items\/(\d+)\/?$/.exec(path)

  // ---- 读：公开 ----
  if (method === 'GET') {
    if (path === '/api' || path === '/api/health' || path === '/api/health/') {
      const items = await getItems()
      return sendJson(res, 200, {
        ok: true,
        service: SITE_NAME,
        site: SITE_URL,
        count: items.length,
        time: new Date().toISOString(),
      }, CORS_HEADERS)
    }
    if (path === '/api/items' || path === '/api/items/') {
      const items = await getItems()
      return sendJson(res, 200, { ok: true, count: items.length, items: items.map(apiShape) }, CORS_HEADERS)
    }
    if (itemMatch) {
      const it = await findItem(Number(itemMatch[1]))
      if (!it) return sendJson(res, 404, { ok: false, error: 'not_found', message: '目标条目不存在' }, CORS_HEADERS)
      return sendJson(res, 200, { ok: true, item: apiShape(it) }, CORS_HEADERS)
    }
    return sendJson(res, 404, { ok: false, error: 'not_found', message: '接口不存在' }, CORS_HEADERS)
  }

  // ---- 写：需 token ----
  if (method === 'POST' && (path === '/api/items' || path === '/api/items/')) {
    const body = await readJsonBody(req)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw httpError(400, 'invalid_body', '请求体必须是 JSON 对象')
    }
    const token = requireToken(req, reqUrl)
    const { data, error } = await callRpc('agent_upsert_item', {
      p_token: token,
      p_title: pickText(body, 'title', { required: true, max: 300 }),
      p_summary: pickText(body, 'summary', { required: true, max: 400 }),
      p_url: pickText(body, 'url', { required: true, max: 2000 }),
      p_date: pickDate(body, 'date'),
      p_source_key: pickText(body, 'source_key', { max: 300 }),
    })
    if (error) return rpcFailure(res, error)
    invalidateCache()
    const it = await findItem(Number(data.id))
    return sendJson(res, data.action === 'created' ? 201 : 200, {
      ok: true,
      action: data.action,
      id: data.id,
      item: it ? apiShape(it) : null,
    }, CORS_HEADERS)
  }

  if (method === 'POST' && (path === '/api/items/batch' || path === '/api/items/batch/')) {
    const body = await readJsonBody(req)
    const list = Array.isArray(body) ? body : body && body.items
    if (!Array.isArray(list)) throw httpError(400, 'invalid_body', '请求体需要 { items: [...] } 或直接是数组')
    if (!list.length) throw httpError(400, 'invalid_body', 'items 不能为空数组')
    if (list.length > 500) throw httpError(400, 'invalid_body', `单次最多 500 条，收到 ${list.length} 条`)
    list.forEach((it, i) => {
      if (it === null || typeof it !== 'object' || Array.isArray(it)) {
        throw httpError(400, 'invalid_body', `items[${i}] 必须是对象`)
      }
    })
    const token = requireToken(req, reqUrl)
    const { data, error } = await callRpc('agent_upsert_items', {
      p_token: token,
      p_items: list.map((it) => ({
        title: pickText(it, 'title', { required: true, max: 300 }),
        summary: pickText(it, 'summary', { required: true, max: 400 }),
        url: pickText(it, 'url', { required: true, max: 2000 }),
        date: pickDate(it, 'date'),
        source_key: pickText(it, 'source_key', { max: 300 }),
      })),
    })
    if (error) return rpcFailure(res, error)
    invalidateCache()
    // 批量是原子的：任一条不合法则整批回滚，不会写一半
    return sendJson(res, 200, {
      ok: true,
      created: data.created,
      updated: data.updated,
      total: data.total,
      items: data.items,
    }, CORS_HEADERS)
  }

  if (method === 'PATCH' && itemMatch) {
    const body = await readJsonBody(req)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw httpError(400, 'invalid_body', '请求体必须是 JSON 对象')
    }
    const token = requireToken(req, reqUrl)
    const { error } = await callRpc('agent_patch_item', {
      p_token: token,
      p_id: Number(itemMatch[1]),
      p_title: pickText(body, 'title', { max: 300 }),
      p_summary: pickText(body, 'summary', { max: 400 }),
      p_url: pickText(body, 'url', { max: 2000 }),
      p_date: pickDate(body, 'date'),
    })
    if (error) return rpcFailure(res, error)
    invalidateCache()
    const it = await findItem(Number(itemMatch[1]))
    return sendJson(res, 200, { ok: true, action: 'updated', id: Number(itemMatch[1]), item: it ? apiShape(it) : null }, CORS_HEADERS)
  }

  if (method === 'DELETE' && itemMatch) {
    const token = requireToken(req, reqUrl)
    const { data, error } = await callRpc('agent_delete_item', {
      p_token: token,
      p_id: Number(itemMatch[1]),
    })
    if (error) return rpcFailure(res, error)
    invalidateCache()
    return sendJson(res, 200, { ok: true, action: 'deleted', id: Number(itemMatch[1]), title: data && data.title }, CORS_HEADERS)
  }

  if (path === '/api/items' || path === '/api/items/') return sendMethodNotAllowed(res, ['GET', 'POST', 'OPTIONS'])
  if (path === '/api/items/batch' || path === '/api/items/batch/') return sendMethodNotAllowed(res, ['POST', 'OPTIONS'])
  if (itemMatch) return sendMethodNotAllowed(res, ['GET', 'PATCH', 'DELETE', 'OPTIONS'])
  return sendJson(res, 404, { ok: false, error: 'not_found', message: '接口不存在' }, CORS_HEADERS)
}

// ---------------------------------------------------------------------------
// HTTP 服务
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

const server = http.createServer(async (req, res) => {
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
    // Agent API 有自己的方法语义与认证，先于页面路由分流
    if (isApi) {
      return await handleApi(req, res, path, reqUrl)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, renderError('仅支持 GET 请求'))
    }
    if (path === '/' || path === '/index.html') {
      const items = await getItems()
      const html = renderList(items)
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
        return send(res, 404, renderError('资源不存在'))
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
        return send(res, 404, renderError('资源不存在'))
      }
    }
    // 微信卡片封面图：服务端实时生成，不落盘、不占云存储
    const ogm = path.match(/^\/og\/(\d+)\.png$/)
    if (ogm) {
      const id = Number(ogm[1])
      const items = await getItems()
      let it = items.find((x) => x.id === id)
      if (!it) {
        invalidateCache()
        it = (await getItems()).find((x) => x.id === id)
      }
      if (!it) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        return res.end('not found')
      }
      const png = drawCover({
        id: it.id,
        title: it.title,
        date: fmtDate(it.item_date),
      })
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': png.length,
        'Cache-Control': 'public, max-age=3600',
      })
      return res.end(png)
    }
    const m = path.match(/^\/item\/(\d+)\/?$/)
    if (m) {
      const id = Number(m[1])
      const items = await getItems()
      const it = items.find((x) => x.id === id)
      if (!it) {
        invalidateCache()
        return send(res, 404, renderError('未找到该研究成果'))
      }
      const html = renderDetail(it)
      trackServerPageView(req, { itemId: id, page: `/item/${id}` })
      return send(res, 200, html)
    }
    return send(res, 404, renderError('页面不存在'))
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
    return send(res, 500, renderError('服务暂时不可用，请稍后重试'))
  }
})

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
