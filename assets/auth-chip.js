/* ============================================================
 * 公开页顶栏登录态（GLOSSARY: 登录态）
 *
 * 登录态只存在于浏览器 localStorage（workbuddy-cloud SDK 的 SessionStore），
 * SSR 不感知身份：顶栏默认渲染「登录」链接（lib/render.js 的
 * [data-auth-chip] 挂载点），本脚本在客户端读会话，已登录则替换为
 * 头像+用户名（点击进 /admin）。
 *
 * 过期与刷新交给 SDK 的 getSession()；拿不到有效会话就保持默认「登录」。
 * 任何一步失败（SDK 缺失、配置缺失、网络错误）都静默降级，不影响公开页。
 *
 * 无构建步骤：defer 加载，排在 vendor SDK 与 cloud.js 之后，
 * 消费它们挂出的 window.cloud / window.App。
 * ============================================================ */
(function () {
  'use strict'

  var nav = document.querySelector('[data-auth-chip]')
  if (!nav) return
  if (!window.App || !App.ready || !window.cloud) return

  cloud.auth.getSession().then(function (res) {
    var session = res && res.data
    var u = session && session.user
    if (!u) return

    var name = u.name || '已登录'
    // 头像缺失时用昵称首字符兜底，与「头像+用户名」的呈现约定一致
    var avatar = u.avatarUrl
      ? '<img class="topbar-avatar" alt="" src="' + App.esc(u.avatarUrl) + '">'
      : '<span class="topbar-avatar topbar-avatar-text" aria-hidden="true">' + App.esc(name.slice(0, 1)) + '</span>'
    nav.innerHTML =
      '<a class="topbar-link topbar-user" href="/admin" title="进入后台">' +
      avatar +
      '<span>' + App.esc(name) + '</span></a>'
  }).catch(function () {
    // 读会话失败视同未登录：顶栏保持默认「登录」入口
  })
})()
