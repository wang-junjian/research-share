/* ============================================================
 * 浏览器数据面（GLOSSARY: 浏览器数据面，决策见 docs/adr/0005）
 *
 * 浏览器侧数据访问的深模块，挂 App.data，在 cloud.js 之后加载（依赖
 * window.App 的 auth/msg 与 window.cloud 的 database 链）。独占：
 *   · 表名与 select 列清单（与服务端条目存储 lib/items-store.js 互为镜像，
 *     对照注释互相点名）
 *   · res.error → App.msg 的解包翻译：对外一律 throw 带用户可读消息的
 *     Error，调用方 catch 后只负责展示（toast / 内联 hint 各归各），
 *     不再碰 SDK 的 res 形状
 *   · 文档型成果的 payload 形状（kind:'doc' + doc_html、url 留空，
 *     与 db/06 的 CHECK 同口径）
 *   · 「写动 0 行即 throw」：RLS 静默拦截不报错只返回空行，统一在这里
 *     翻译成可读错误，调用方不再检查行数（排除清单写动例外，见其注释）
 *
 * 覆盖 research_items（listItems/publish/updateItem/deleteItem/deleteItems）、
 * admins（listAdmins/addAdmin/removeAdmin）、analytics_exclude
 * （listExclusions/excludeVisitor/includeVisitor）与看板 rpc（dashboard）；
 * 调用方（admin / quick-share / analytics）只调用不拼链。
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

  // select 列清单：与服务端条目存储 lib/items-store.js 的 COLUMNS 互为
  // 唯一对照点（注释互相点名）。两侧清单刻意不同：浏览器侧要 owner_id
  // （admin 的归属判定与「我录入的」筛选），服务端要 source_key /
  // source_agent / updated_at（/api/* 用）；doc_html 两侧都不进列表查询。
  // 改任何一侧的列清单时，到另一侧核对口径。
  var ITEMS_COLUMNS = 'id, title, summary, url, kind, item_date, owner_id, owner_name, created_at'
  var ADMINS_COLUMNS = 'user_id, added_at, is_founder'
  var EXCLUSIONS_COLUMNS = 'visitor_id, note, created_at'

  // 读链公共收尾：res.error 翻译，resolve 行数组。
  function unwrapRead(res) {
    if (res && res.error) throw new Error(App.msg(res.error))
    return (res && res.data) || []
  }

  // 整条链 reject（网络级失败、cloud 未就绪）的统一翻译。
  function rethrow(err) {
    throw new Error(App.msg(err))
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
    // 成果列表（admin 的全量浏览：量小直接前端算统计与筛选）。
    // 列清单与排序收口在这里（见上方 ITEMS_COLUMNS 的对照注释）。
    listItems: function () {
      return Promise.resolve()
        .then(function () {
          return db().from('research_items').select(ITEMS_COLUMNS)
            .order('item_date', { ascending: false })
            .order('created_at', { ascending: false })
        })
        .then(unwrapRead, rethrow)
    },

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
        }, rethrow)
    },

    // 更新标元（admin 编辑弹窗）：patch 由调用方组装（文档型不含 url，
    // 内容不可变见 docs/adr/0004）。0 行（RLS 静默拦截或条目不存在）
    // 统一 throw；resolve 更新后的行。
    updateItem: function (id, patch) {
      return Promise.resolve()
        .then(function () { return db().from('research_items').update(patch).eq('id', id).select() })
        .then(function (res) {
          return unwrapWrite(res, '没有改动生效：该成果可能不存在，或你没有权限（仅录入者本人或管理员可修改）。')[0]
        }, rethrow)
    },

    // 单删（admin）：0 行统一 throw。
    deleteItem: function (id) {
      return Promise.resolve()
        .then(function () { return db().from('research_items').delete().eq('id', id).select() })
        .then(function (res) {
          return unwrapWrite(res, '删除未生效：仅录入者本人或管理员可删除')[0]
        }, rethrow)
    },

    // 批量删（admin）：部分无权限时 RLS 只放行有权限的行——动 >0 行不
    // throw，resolve 实际删除的行，差数由调用方报「部分无权限，已跳过」；
    // 0 行才统一 throw。
    deleteItems: function (ids) {
      return Promise.resolve()
        .then(function () { return db().from('research_items').delete().in('id', ids).select() })
        .then(function (res) {
          return unwrapWrite(res, '删除未生效：这些成果不在你的管理范围内')
        }, rethrow)
    },

    // 管理员列表（admin 设置面板与 isAdmin/isFounder 判定）。
    listAdmins: function () {
      return Promise.resolve()
        .then(function () { return db().from('admins').select(ADMINS_COLUMNS) })
        .then(unwrapRead, rethrow)
    },

    // 任命（仅初始管理员，db/05 的 RLS 强制；UI 只是不挑逗）。
    // 其他人走到这里会被 RLS 静默拦下：0 行统一 throw。resolve 新行。
    addAdmin: function (uid) {
      return Promise.resolve()
        .then(function () { return db().from('admins').insert({ user_id: uid }).select() })
        .then(function (res) {
          return unwrapWrite(res, '任命未生效：仅初始管理员可任命管理员')[0]
        }, rethrow)
    },

    // 移除管理员（仅初始管理员；founder 行 RLS 本来就删不掉，UI 不提供
    // 注定失败的按钮）。0 行统一 throw。
    removeAdmin: function (uid) {
      return Promise.resolve()
        .then(function () { return db().from('admins').delete().eq('user_id', uid).select() })
        .then(function (res) {
          return unwrapWrite(res, '移除未生效：你可能已不是管理员')[0]
        }, rethrow)
    },

    // 「自己人」排除清单（看板「排除本机」）。
    listExclusions: function () {
      return Promise.resolve()
        .then(function () { return db().from('analytics_exclude').select(EXCLUSIONS_COLUMNS) })
        .then(unwrapRead, rethrow)
    },

    // 排除/恢复本机。刻意不做 0 行抛错：另一个管理员并发移除同一标识后
    // 再删是 0 行，而「本机已不在清单」正是目标终态，不是权限拦截——
    // 「排除本机」行为与文案不变是有意的（票 #11）。resolve 受影响行。
    excludeVisitor: function (visitorId, note) {
      return Promise.resolve()
        .then(function () {
          return db().from('analytics_exclude').insert({ visitor_id: visitorId, note: note }).select()
        })
        .then(unwrapRead, rethrow)
    },

    includeVisitor: function (visitorId) {
      return Promise.resolve()
        .then(function () {
          return db().from('analytics_exclude').delete().eq('visitor_id', visitorId).select()
        })
        .then(unwrapRead, rethrow)
    },

    // 数据看板：聚合在库里的 analytics_dashboard（is_admin() 一处鉴权，
    // 非管理员被它拦下时 res.error 同样走统一翻译）。
    // SDK 对 jsonb 返回值可能已解好对象、也可能仍是字符串，两种都兜住；
    // 形状不符（无 overview）throw，resolve 解析后的看板对象。
    dashboard: function (days) {
      return Promise.resolve()
        .then(function () { return db().rpc('analytics_dashboard', { p_days: days }) })
        .then(function (res) {
          if (res && res.error) throw new Error(App.msg(res.error))
          var d = res && res.data
          if (typeof d === 'string') { try { d = JSON.parse(d) } catch (e) { d = null } }
          if (!d || !d.overview) throw new Error('数据格式不符合预期')
          return d
        }, rethrow)
    }
  }
})()
