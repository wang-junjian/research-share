/* ============================================================
 * 浏览器数据面（GLOSSARY: 浏览器数据面）
 *
 * 浏览器侧数据访问的深模块，挂 App.data，在 cloud.js 之后加载（依赖
 * window.App 的 auth/msg 与 window.cloud 的 database 链）。独占：
 *   · 表名与 select 列清单（与服务端条目存储 lib/items-store.js 互为镜像）
 *   · res.error → App.msg 的解包翻译：对外一律 throw 带用户可读消息的
 *     Error，调用方 catch 后只负责展示（toast / 内联 hint 各归各），
 *     不再碰 SDK 的 res 形状
 *   · 文档型成果的 payload 形状（kind:'doc' + doc_html、url 留空，
 *     与 db/06 的 CHECK 同口径）
 *   · 「写动 0 行即 throw」：RLS 静默拦截不报错只返回空行，统一在这里
 *     翻译成可读错误，调用方不再检查行数
 *
 * 落地顺序：本文件先竖切 publish（快速分享录入写路径，票 #10），
 * 列表/更新/删除/admins/analytics_exclude/看板 rpc 随调用方接入补齐（票 #11）。
 *
 * 无构建步骤：defer 加载，排在 cloud.js 之后。
 * ============================================================ */
(function () {
  'use strict'

  if (!window.App) return
  var App = window.App

  function db() {
    if (!window.cloud) throw new Error(App.initError || '云服务不可用，请刷新重试。')
    return window.cloud.database
  }

  // 写链公共收尾：res.error 翻译、0 行检查、数组/单对象形状归一。
  // 返回受影响行数组；任何失败都 throw 带用户可读消息的 Error。
  function unwrapWrite(res, zeroRowsMsg) {
    if (res && res.error) throw new Error(App.msg(res.error))
    var rows = res && res.data ? (Array.isArray(res.data) ? res.data : [res.data]) : []
    if (rows.length === 0) throw new Error(zeroRowsMsg)
    return rows
  }

  App.data = {
    // 录入新成果（快速分享与后台录入同一条写路径）：
    //   链接型 publish({ title, summary, url, item_date })
    //     —— kind 走列默认 'link'，payload 不带 kind/doc_html
    //   文档型 publish({ title, summary, doc_html, item_date })
    //     —— kind:'doc' + doc_html 直插，url 留空（不传，走列默认 NULL），
    //        与 db/06 的 research_items_shape_check 同口径
    // owner_name 由 Auth.nickname() 内部补全（falsy → null，两条录入路径
    // 同口径），调用方不再各自传。字段校验与提示文案留在调用方（各入口
    // 文案不同，是有意的）。resolve 新行（调用方读 id 直达详情页）。
    publish: function (input) {
      var payload = {
        title: input.title,
        summary: input.summary,
        item_date: input.item_date,
        owner_name: App.auth.nickname()
      }
      if (input.doc_html != null) {
        payload.kind = 'doc'
        payload.doc_html = input.doc_html
      } else {
        payload.url = input.url
      }
      return Promise.resolve()
        .then(function () { return db().from('research_items').insert(payload).select() })
        .then(function (res) {
          return unwrapWrite(res, '发布未生效：写入被静默拦下，请重新登录后重试。')[0]
        }, function (err) {
          throw new Error(App.msg(err))
        })
    }
  }
})()
