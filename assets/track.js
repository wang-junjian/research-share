/* ============================================================
 * 研究成果 · 埋点采集（零依赖，约 3KB）
 *
 * 设计要点
 *  1. 身份匿名：visitor_id 一年期（localStorage + cookie 双写，cookie 供 SSR 侧复用），
 *     session_id 30 分钟不活动即过期（cookie 续期 + sessionStorage 镜像）。
 *  2. 批量上报：最多攒 10 条或 3 秒；pagehide / 切后台时强制 flush。
 *  3. 不上页面关键路径：用 sendBeacon，降级 fetch(keepalive)，失败即丢弃不重试。
 *     埋点丢几条，远好过让用户多等 200ms。
 *  4. 不采滚动深度、不采停留时长（按约定）。
 *  5. 所有点击类事件都在这里用委托捕获，业务脚本（share.js 等）保持零改动。
 *  6. 任何异常都被吞掉：埋点永远不该弄坏页面。
 *
 * 本文件负责 7 个事件：session_start / page_view / view_item / select_content /
 * outbound_click / share / error。
 * 另外两个不在浏览器侧：
 *   - page_view 由服务端 SSR 再补一条（source='server'，用于算埋点覆盖率）；
 *   - content_publish 由数据库触发器在成果落库时写（event='content_publish'）。
 * 也没有 session_end：会话是否结束由「30 分钟不活动」定义，页面卸载不等于会话结束
 * （翻页也会触发 pagehide），多发一个会被误读的事件不如不发。
 *
 * 对外接口：window.RS.track(name, props, itemId) —— 供后台等场景手动补报
 * ============================================================ */
(function () {
  'use strict'

  // 埋点口径版本读共享常量（GLOSSARY: 共享常量）：/assets/constants.js 由服务端
  // 单一来源动态生成，公开页布局先于本脚本无条件加载。读不到时 ver 缺省，
  // 服务端走数据库默认 'v1'，不为此弄坏页面。
  var VERSION = (window.RS_CONST || {}).APP_VERSION
  var ENDPOINT = '/api/track'
  var MAX_BATCH = 10
  var FLUSH_MS = 3000
  var SESSION_TTL = 30 * 60 * 1000
  var YEAR = 365 * 24 * 60 * 60

  // 后台管理页不做访客统计；自动化浏览器直接不上报
  if (/^\/admin/.test(location.pathname)) return
  if (navigator.webdriver) return

  function store(fn, fallback) { try { return fn() } catch (e) { return fallback } }

  function ls(key, val) {
    if (val === undefined) return store(function () { return localStorage.getItem(key) }, null)
    try { localStorage.setItem(key, val) } catch (e) {}
    return val
  }
  function ss(key, val) {
    if (val === undefined) return store(function () { return sessionStorage.getItem(key) }, null)
    try { sessionStorage.setItem(key, val) } catch (e) {}
    return val
  }
  function cookie(key, val, maxAge) {
    if (val === undefined) {
      var m = document.cookie.match(new RegExp('(?:^|; )' + key + '=([^;]*)'))
      return m ? decodeURIComponent(m[1]) : null
    }
    try {
      document.cookie = key + '=' + encodeURIComponent(val) + ';path=/;max-age=' + maxAge + ';SameSite=Lax'
    } catch (e) {}
    return val
  }

  function rand() {
    var s = ''
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    if (window.crypto && crypto.getRandomValues) {
      var a = new Uint8Array(16)
      crypto.getRandomValues(a)
      for (var i = 0; i < a.length; i++) s += chars[a[i] % chars.length]
      return s
    }
    for (var j = 0; j < 20; j++) s += chars[Math.floor(Math.random() * chars.length)]
    return s
  }

  // 允许用户退出统计（页脚有「匿名统计 · 可退出」开关）
  function optedOut() {
    return store(function () {
      return localStorage.getItem('rs:optout') === '1' || /(?:^|; )rs_optout=1/.test(document.cookie)
    }, false)
  }
  if (optedOut()) return

  // ---------------- 身份 ----------------
  var visitorId = cookie('rs_vid') || ls('rs:vid')
  if (!visitorId) {
    visitorId = rand()
    cookie('rs_vid', visitorId, YEAR)
  }
  ls('rs:vid', visitorId)
  cookie('rs_vid', visitorId, YEAR)      // 与 localStorage 对齐，SSR 侧也读得到

  var sessionId = null
  var lastAt = 0
  var sidRaw = ss('rs:sid')
  if (sidRaw) {
    var parts = sidRaw.split('|')
    sessionId = parts[0]
    lastAt = Number(parts[1]) || 0
  }
  var isNewSession = !sessionId || !lastAt || (Date.now() - lastAt > SESSION_TTL)
  if (isNewSession) sessionId = rand()
  function touchSession() {
    lastAt = Date.now()
    ss('rs:sid', sessionId + '|' + lastAt)
    cookie('rs:sid', sessionId, 1800)
  }
  touchSession()

  // ---------------- 队列表 ----------------
  var queue = []
  var timer = null
  var pagesThisSession = {}

  function path() {
    return location.pathname.replace(/\/+$/, '') || '/'
  }

  function itemIdFromPath(p) {
    var m = /^\/item\/(\d+)/.exec(p || '')
    return m ? Number(m[1]) : null
  }

  var currentItem = itemIdFromPath(location.pathname)

  function push(name, props, item, page) {
    try {
      // 每次入队前重读开关：用户在页脚点了「退出统计」，当前页面立刻生效，不用刷新
      if (optedOut()) return
      touchSession()
      var pg = page || path()
      pagesThisSession[pg] = 1
      queue.push({
        n: name,
        i: item === undefined ? currentItem : item,
        p: props || null,
        pg: pg,
        t: Date.now(),
      })
      if (queue.length >= MAX_BATCH) flush()
      else if (!timer) timer = setTimeout(flush, FLUSH_MS)
    } catch (e) {}
  }

  function payload(events) {
    var body = { v: visitorId, s: sessionId, ver: VERSION, events: events }
    if (events.length) body.rf = document.referrer || ''
    return JSON.stringify(body)
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null }
    // 中途退出统计：已入队但还没发出的直接丢掉，不再补发
    if (optedOut()) { queue = []; return }
    if (!queue.length) return
    var events = queue
    queue = []
    var text = payload(events)
    var ok = false
    try {
      if (navigator.sendBeacon) {
        // text/plain 兼容性最好，服务端按 JSON 解析；不触发预检
        ok = navigator.sendBeacon(ENDPOINT, new Blob([text], { type: 'application/json' }))
      }
    } catch (e) { ok = false }
    if (ok) return
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text,
        keepalive: true,
      }).catch(function () {})
    } catch (e) { /* 埋点失败即丢弃，不重试 */ }
  }

  // ---------------- 自动事件 ----------------
  if (isNewSession) push('session_start', { landing: path() })
  push('page_view')

  // 详情页：view_item（去抖交给数据库，3 秒内同会话同条目只落一条）
  if (currentItem) {
    var refFrom = document.referrer
      ? (/^https?:\/\//i.test(document.referrer) && document.referrer.indexOf(location.origin) !== 0 ? 'other' : 'home')
      : 'direct'
    push('view_item', { from: refFrom })
  }

  window.RS = {
    track: function (name, props, item) { push(name, props, item) },
    flush: flush,
    visitorId: visitorId,
    sessionId: sessionId,
  }

  // ---------------- 点击类事件：统一委托 ----------------
  document.addEventListener('click', function (e) {
    try {
      var el = e.target
      // 分享按钮：一个事件 + method 维度（对齐 GA4 recommended event share）
      var shareBtn = el.closest && el.closest('.share-act[data-act]')
      if (shareBtn) {
        // DOM 上的 data-act 用连字符（copy-link，share.js 也在读它），
        // 事件字典里的 method 用下划线（copy_link）：只在这里换一次，
        // 不动 share.js。换错的表现是 method 被白名单静默丢掉、props 变成 {}。
        var method = String(shareBtn.getAttribute('data-act') || '').replace(/-/g, '_')
        var props = { method: method }
        // 两个「复制海报图」按钮在微信里必然降级 —— 这是能力检查，不是猜测
        if (method === 'copy_poster' || method === 'copy_poster_link') {
          props.degrade = !(navigator.clipboard && window.ClipboardItem && navigator.clipboard.write)
        }
        push('share', props)
        return
      }

      // 首页卡片点击：头条与编号条目都是卡片；跳转前上报（sendBeacon 保证导航中也能发出去）
      var card = el.closest && el.closest('.feat, .col-item')
      if (card) {
        var href = card.getAttribute('href') || ''
        var m = /\/item\/(\d+)/.exec(href)
        if (m) {
          var all = document.querySelectorAll('.feat, .col-item')
          var pos = 0
          for (var k = 0; k < all.length; k++) { if (all[k] === card) { pos = k + 1; break } }
          push('select_content', {
            position: pos,
          }, Number(m[1]), '/')
          flush()
        }
        return
      }

      // 外部链接：本站的终极转化（原文跳转）
      var a = el.closest && el.closest('a[href]')
      if (a) {
        var url = a.getAttribute('href') || ''
        if (/^https?:\/\//i.test(url)) {
          var host = ''
          try { host = new URL(url).hostname } catch (err) { host = '' }
          if (host && host !== location.hostname) {
            push('outbound_click', { dest_host: host })
            flush()
          }
        }
      }
    } catch (err) {}
  }, true)

  // ---------------- 错误（数据质量用） ----------------
  function errText(m) {
    return String(m || '').replace(/\s+/g, ' ').slice(0, 120)
  }
  window.addEventListener('error', function (e) {
    try {
      if (e && e.target && e.target !== window && (e.target.src || e.target.href)) {
        push('error', { kind: 'resource', msg: errText(e.target.src || e.target.href) })
      } else if (e && e.message) {
        push('error', { kind: 'js', msg: errText(e.message) })
      }
    } catch (err) {}
  }, true)
  window.addEventListener('unhandledrejection', function (e) {
    try {
      push('error', { kind: 'unhandled', msg: errText(e.reason && e.reason.message ? e.reason.message : e.reason) })
    } catch (err) {}
  })

  // ---------------- 离开：把队列送出去 ----------------
  // 这里不发 session_end：会话是否结束由「30 分钟不活动」定义，而页面卸载不等于
  // 会话结束（翻页也会触发 pagehide）。真正要用的人均页数 = 页面浏览 ÷ 会话，
  // 看板直接算得出来，不需要为此多存一个会被误解的事件。
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush()
  })
})()
