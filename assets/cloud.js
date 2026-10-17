/* ============================================================
 * 研究成果分享 · 共享层
 * 云服务 SDK 初始化 / 通用工具 / 错误翻译 / Toast / 弹窗 / 登录门
 * 无构建步骤：<script> 引入，挂在 window.App 上
 * 设计模式借鉴自「英文随手记」的 assets/cloud.js，按本项目调整
 *
 * publicConfig 由服务端在页面内联注入 window.PUBLIC_CONFIG
 * （endpoint / oauthRelayBaseUrl / publishableKey，均无权限语义）
 * ============================================================ */
(function () {
  'use strict'

  var PUBLIC_CONFIG = window.PUBLIC_CONFIG || null

  /* ---------- 1. 初始化唯一的 cloud 客户端 ---------- */
  var cloud = null
  var initError = ''
  if (!PUBLIC_CONFIG || !PUBLIC_CONFIG.endpoint || !PUBLIC_CONFIG.publishableKey) {
    initError = PUBLIC_CONFIG && PUBLIC_CONFIG.demo
      ? '演示模式：未配置云服务，后台管理不可用。请设置 CLOUD_ENDPOINT 与 CLOUD_PUBLISHABLE_KEY 后重启服务。'
      : '页面未获得云服务配置，请刷新重试。'
  } else if (window.WorkBuddyCloud && typeof window.WorkBuddyCloud.createWorkBuddyCloud === 'function') {
    try {
      cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: PUBLIC_CONFIG.endpoint,
        oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,
        publishableKey: PUBLIC_CONFIG.publishableKey
      })
    } catch (e) {
      initError = '云服务初始化失败：' + (e && e.message ? e.message : String(e))
    }
  } else {
    initError = '云服务 SDK 未能加载（assets/vendor/workbuddy-cloud-sdk.global.js 缺失或损坏），请刷新页面重试。'
  }
  window.cloud = cloud

  var App = {}
  window.App = App
  App.ready = !!cloud
  App.initError = initError

  /* ---------- 2. 通用工具 ---------- */
  App.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  App.truncate = function (s, n) {
    var t = String(s == null ? '' : s).trim()
    return t.length <= n ? t : t.slice(0, n).replace(/\s+$/, '') + '…'
  }

  App.today = function () {
    var d = new Date()
    var p = function (n) { return n < 10 ? '0' + n : '' + n }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }

  App.fmtShort = function (iso) {
    if (!iso) return ''
    var d = new Date(iso)
    if (isNaN(d.getTime())) return String(iso).slice(0, 10)
    var p = function (n) { return n < 10 ? '0' + n : '' + n }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  // 把 SDK / PostgreSQL 的错误翻译成人话
  App.msg = function (err) {
    if (!err) return '发生未知错误'
    var kind = err.kind || ''
    var code = err.code || ''
    if (kind === 'unauthenticated' || kind === 'invalid_grant') return '登录状态已失效，请重新登录。'
    if (kind === 'network') return '网络连接失败，请检查网络后重试。'
    if (kind === 'backend-unavailable') return '服务暂时不可用，请稍后重试。'
    if (code === '42P01') return '数据表不存在，请联系应用管理员。'
    if (code === '42501') return '没有权限执行该操作（该内容仅录入者本人或管理员可管理）。'
    if (code === '23505') return '该记录已存在。'
    if (code === 'MISSING_CREDENTIALS' || code === 'ACCESS_TOKEN_KID_INVALID') {
      return '云服务凭证校验未通过，请联系应用管理员。'
    }
    return err.message || String(err)
  }

  /* ---------- 3. Toast ---------- */
  var toastEl = null
  var toastTimer = null
  App.toast = function (text, kind) {
    if (!toastEl) {
      toastEl = document.createElement('div')
      toastEl.className = 'toast'
      document.body.appendChild(toastEl)
    }
    toastEl.textContent = text
    toastEl.className = 'toast is-show' + (kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : '')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { toastEl.className = 'toast' }, 2600)
  }

  /* ---------- 4. 模态 ---------- */
  function mountModal(html, opts) {
    opts = opts || {}
    var host = document.getElementById('modalMount') || document.body
    var mask = document.createElement('div')
    mask.className = 'modal-mask'
    mask.innerHTML = html
    host.appendChild(mask)

    function close() {
      mask.remove()
      document.removeEventListener('keydown', onKey)
    }
    function onKey(ev) { if (ev.key === 'Escape') { close(); if (opts.onCancel) opts.onCancel() } }

    mask.addEventListener('mousedown', function (ev) {
      if (ev.target === mask) { close(); if (opts.onCancel) opts.onCancel() }
    })
    document.addEventListener('keydown', onKey)

    var closeBtn = mask.querySelector('[data-act="cancel"]')
    if (closeBtn) closeBtn.addEventListener('click', function () { close(); if (opts.onCancel) opts.onCancel() })

    return { el: mask, close: close }
  }
  App.mountModal = mountModal

  // 二次确认；危险操作统一走这里
  App.confirm = function (opts) {
    opts = opts || {}
    return new Promise(function (resolve) {
      var m = mountModal(
        '<div class="modal" style="max-width:430px">' +
        '  <div class="modal-head"><h3>' + App.esc(opts.title || '确认操作') + '</h3></div>' +
        '  <div class="modal-body"><p class="danger-text">' + App.esc(opts.message || '') + '</p></div>' +
        '  <div class="modal-foot">' +
        '    <button class="btn" data-act="cancel" type="button">' + App.esc(opts.cancelText || '取消') + '</button>' +
        '    <button class="btn btn-danger" data-act="ok" type="button">' + App.esc(opts.okText || '确定') + '</button>' +
        '  </div>' +
        '</div>',
        { onCancel: function () { resolve(false) } }
      )
      m.el.querySelector('[data-act="ok"]').addEventListener('click', function () {
        m.close()
        resolve(true)
      })
    })
  }

  /* ---------- 5. 登录 ---------- */
  var Auth = {
    session: null,
    user: null,
    _subs: [],

    onChange: function (fn) { this._subs.push(fn) },
    _emit: function () {
      var self = this
      this._subs.forEach(function (fn) { try { fn(self.session) } catch (e) {} })
    },

    // 页面入口：先处理 OAuth 回调，再恢复会话
    start: function () {
      var self = this
      if (!App.ready) { self._emit(); return Promise.resolve(null) }
      return self._dispatchCallback().then(function () {
        return cloud.auth.getSession()
      }).then(function (res) {
        self.session = (res && res.data) || null
        self.user = self.session && self.session.user ? self.session.user : null
        self._emit()
        return self.session
      }).catch(function () {
        self.session = null
        self._emit()
        return null
      })
    },

    // 一个页面只分发一次：按 provider 选择对应的回调处理器
    _dispatchCallback: function () {
      var url = new URL(location.href)
      var hasCode = url.searchParams.has('code')
      var hasError = url.searchParams.has('error')
      if (!hasCode && !hasError) return Promise.resolve()

      var provider = url.searchParams.get('provider')
      if (provider !== 'wechat' && provider !== 'workbuddy') {
        App.toast('登录回调缺少有效的登录方式，请重新登录。', 'error')
        return Promise.resolve()
      }
      var handler = provider === 'wechat' ? cloud.auth.handleWechatWebCallback : cloud.auth.handleWorkBuddyCallback
      if (typeof handler !== 'function') {
        App.toast('当前 SDK 版本不支持该登录方式，请稍后再试。', 'error')
        return Promise.resolve()
      }
      return handler.call(cloud.auth).then(function (res) {
        if (res && res.error) { App.toast(App.msg(res.error), 'error'); return }
        if (res && res.data) {
          url.searchParams.delete('code')
          url.searchParams.delete('state')
          url.searchParams.delete('provider')
          url.searchParams.delete('next')
          history.replaceState(null, '', url.pathname + url.search + url.hash)
        }
      }).catch(function (e) {
        App.toast(App.msg(e), 'error')
      })
    },

    signOut: function () {
      var self = this
      return cloud.auth.signOut().then(function () {
        self.session = null
        self.user = null
        self._emit()
      }).catch(function (e) { App.toast(App.msg(e), 'error') })
    },

    // 写入 owner_name 用的昵称快照
    nickname: function () {
      var u = this.user
      return u && u.name ? u.name : null
    },

    displayName: function () {
      var u = this.user
      if (!u) return '未登录'
      return u.name || '已登录'
    },

    requireSession: function () {
      return !!(this.session && this.session.user)
    }
  }
  App.auth = Auth

  /* ---------- 6. 登录面板（微信 + WorkBuddy，两者都走平台 Relay） ---------- */
  App.renderLogin = function (mount, opts) {
    opts = opts || {}
    if (!App.ready) {
      mount.innerHTML = '<div class="auth-card"><h2 style="margin:0 0 8px;font-size:17px">无法连接云服务</h2>' +
        '<p class="auth-desc">' + App.esc(App.initError || '云服务不可用') + '</p></div>'
      return
    }

    mount.innerHTML = '' +
      '<div class="auth-card">' +
      '  <div class="auth-brand">' +
      '    <span class="logo-mark">研</span>' +
      '    <div><h1>研究成果</h1><p class="auth-sub">登录后录入与管理研究成果</p></div>' +
      '  </div>' +
      '  <button type="button" class="btn btn-wechat btn-block" id="wechatBtn">微信扫码登录</button>' +
      '  <div class="auth-divider"><span>或</span></div>' +
      '  <button type="button" class="btn btn-block" id="wbBtn">使用 WorkBuddy 登录</button>' +
      '  <p class="auth-hint" id="authHint"></p>' +
      '  <p class="auth-foot">录入者仅能修改自己录入的内容；管理员可管理全部成果。</p>' +
      '</div>'

    var hint = mount.querySelector('#authHint')
    var btns = [mount.querySelector('#wechatBtn'), mount.querySelector('#wbBtn')]

    function setBusy(on) {
      btns.forEach(function (b) { b.disabled = !!on })
    }

    function startOAuth(provider) {
      setBusy(true)
      hint.className = 'auth-hint'
      hint.textContent = ''
      // 回调必须落在站点根路径（平台 Relay 规则），业务参数放 query
      var back = new URL(location.href)
      back.pathname = '/'
      back.search = '?next=admin'
      back.hash = ''
      cloud.auth.signInWithOAuth({ provider: provider, redirectTo: back.toString() }).then(function (res) {
        if (res && res.error) {
          setBusy(false)
          hint.className = 'auth-hint is-error'
          hint.textContent = App.msg(res.error)
          return
        }
        if (res && res.data && res.data.url) {
          location.assign(res.data.url)
          return
        }
        setBusy(false)
        hint.className = 'auth-hint is-error'
        hint.textContent = '未能获取登录地址，请重试。'
      }).catch(function (e) {
        setBusy(false)
        hint.className = 'auth-hint is-error'
        hint.textContent = App.msg(e)
      })
    }

    btns[0].addEventListener('click', function () { startOAuth('wechat') })
    btns[1].addEventListener('click', function () { startOAuth('workbuddy') })
  }

  /* ---------- 7. 启动时统一跑一次会话恢复 ---------- */
  App.bootstrap = function () { return Auth.start() }
})()
