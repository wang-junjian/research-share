/* ============================================================
 * 研究成果 · 埋点采集核心（GLOSSARY: 埋点采集核心）
 *
 * 客户端埋点的纯逻辑深模块，从 assets/track.js 抽出（票 #12）：
 * 身份、队列、降级链全部收在 createTracker 闭包里，存储 / 时钟 /
 * 随机源 / 发送通道经参数注入；track.js 只剩页面守卫与 DOM 事件接线。
 *
 * 行为口径与抽出前完全一致（零行为变化重构）。表征测试见
 * test/track-core.test.js（seam 与 browser-data.test.js 同款：
 * 预设最小 window + 顶层 import）。
 * ============================================================ */
(function () {
  'use strict'

  var MAX_BATCH = 10
  var FLUSH_MS = 3000
  var SESSION_TTL = 30 * 60 * 1000
  var YEAR = 365 * 24 * 60 * 60

  // 「退出统计」判定：localStorage 与 cookie 任一置 '1' 即退出。
  // 键名的单一来源是 lib/constants.js（OPTOUT_LS_KEY / OPTOUT_COOKIE_KEY），
  // 经调用方从 window.RS_CONST 读入后传参，本文件不写字面量。
  // 存储 adapter 自身吞异常：抛错 = 读不到 = 未退出。
  function optedOut(o) {
    return o.ls(o.lsKey) === '1' || o.cookie(o.cookieKey) === '1'
  }

  function itemIdFromPath(p) {
    var m = /^\/item\/(\d+)/.exec(p || '')
    return m ? Number(m[1]) : null
  }

  // deps = {
  //   ls, ss, cookie,          // 存储 adapter：(key) 读、(key, val[, maxAge]) 写，异常自吞
  //   rand, now,               // 随机源 / 时钟（注入后可确定性测试）
  //   referrer,                // () => string，flush 组包时才读
  //   version,                 // 口径版本（RS_CONST.APP_VERSION，可 undefined → JSON 无 ver 键）
  //   channels: {              // 发送通道：beacon(text)=>bool，falsy 或抛错降级 fetchKeepalive
  //     beacon,                //   可为 null（无 sendBeacon 环境）
  //     fetchKeepalive,        //   失败即丢弃，不重试
  //   },
  //   optout: { lsKey, cookieKey },
  //   getPage, currentItem,    // push 缺省值：pg 取 getPage()，i 取 currentItem
  // }
  function createTracker(deps) {
    var ls = deps.ls
    var ss = deps.ss
    var cookie = deps.cookie
    var rand = deps.rand
    var now = deps.now
    var referrer = deps.referrer
    var version = deps.version
    var channels = deps.channels
    var optoutKeys = deps.optout
    var getPage = deps.getPage
    var currentItem = deps.currentItem

    function isOptedOut() {
      return optedOut({ ls: ls, cookie: cookie, lsKey: optoutKeys.lsKey, cookieKey: optoutKeys.cookieKey })
    }

    // ---------------- 身份 ----------------
    // visitor_id 一年期（localStorage + cookie 双写，cookie 供 SSR 侧复用），
    // session_id 30 分钟不活动即过期（cookie 续期 + sessionStorage 镜像）。
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
    var isNewSession = !sessionId || !lastAt || (now() - lastAt > SESSION_TTL)
    if (isNewSession) sessionId = rand()
    function touchSession() {
      lastAt = now()
      ss('rs:sid', sessionId + '|' + lastAt)
      cookie('rs:sid', sessionId, 1800)
    }
    touchSession()

    // ---------------- 队列 ----------------
    var queue = []
    var timer = null

    function payload(events) {
      var body = { v: visitorId, s: sessionId, ver: version, events: events }
      if (events.length) body.rf = referrer() || ''
      return JSON.stringify(body)
    }

    function flush() {
      if (timer) { clearTimeout(timer); timer = null }
      // 中途退出统计：已入队但还没发出的直接丢掉，不再补发
      if (isOptedOut()) { queue = []; return }
      if (!queue.length) return
      var events = queue
      queue = []
      var text = payload(events)
      var ok = false
      try {
        if (channels.beacon) ok = channels.beacon(text)
      } catch (e) { ok = false }
      if (ok) return
      try {
        channels.fetchKeepalive(text)
      } catch (e) { /* 埋点失败即丢弃，不重试 */ }
    }

    function push(name, props, item, page) {
      try {
        // 每次入队前重读开关：用户在页脚点了「退出统计」，当前页面立刻生效，不用刷新
        if (isOptedOut()) return
        touchSession()
        queue.push({
          n: name,
          i: item === undefined ? currentItem : item,
          p: props || null,
          pg: page || getPage(),
          t: now(),
        })
        if (queue.length >= MAX_BATCH) flush()
        else if (!timer) timer = setTimeout(flush, FLUSH_MS)
      } catch (e) {}
    }

    return {
      push: push,
      flush: flush,
      visitorId: visitorId,
      sessionId: sessionId,
      isNewSession: isNewSession,
    }
  }

  window.TrackCore = {
    optedOut: optedOut,
    itemIdFromPath: itemIdFromPath,
    createTracker: createTracker,
  }
})()
