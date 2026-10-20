/* ============================================================
 * 公开页顶栏登录态（GLOSSARY: 登录态 / 登录态门控）
 *
 * 本脚本是一份挂件声明：读会话、未登录不动 SSR 输出等门控逻辑
 * 收在 cloud.js 的 App.authGate（一次页面加载只读一次会话），
 * 这里只声明挂载点与「已登录时把顶栏替换为头像+用户名」的渲染。
 *
 * 过期与刷新交给 SDK 的 getSession()（门控内部调用，ADR-0002）；
 * 拿不到有效会话门控不会调 render，顶栏保持 SSR 默认「登录」。
 *
 * 无构建步骤：defer 加载，排在 vendor SDK 与 cloud.js 之后，
 * 消费它们挂出的 window.App。
 * ============================================================ */
(function () {
  'use strict'

  if (!window.App || !App.authGate) return

  App.authGate.register({
    mount: '[data-auth-chip]',
    render: function (session, nav) {
      var u = session.user
      var name = u.name || '已登录'
      // 头像缺失时用昵称首字符兜底，与「头像+用户名」的呈现约定一致
      var avatar = u.avatarUrl
        ? '<img class="topbar-avatar" alt="" src="' + App.esc(u.avatarUrl) + '">'
        : '<span class="topbar-avatar topbar-avatar-text" aria-hidden="true">' + App.esc(name.slice(0, 1)) + '</span>'
      nav.innerHTML =
        '<a class="topbar-link topbar-user" href="/admin" title="进入后台">' +
        avatar +
        '<span>' + App.esc(name) + '</span></a>'
    }
  })
})()
