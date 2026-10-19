/* ============================================================
 * 首页快速分享入口（顶栏「＋ 分享」）
 *
 * 挂载点 [data-share-entry] 只由首页输出（lib/render.js 的 shareEntry 选项），
 * SSR 默认 hidden：本脚本读到有效会话后才显示 —— 与 auth-chip.js 同款门控，
 * 读者永远看不到这个入口。
 *
 * 流程（设计结论见分支 proto/quick-share-entry 的原型，A2 模式）：
 *   模态录入（标题/概览/链接/日期，与后台录入同口径）
 *   → 浏览器 SDK 直写 research_items（与 admin 同一条写入路径，绕过本进程；
 *     首页列表的 60s 缓存不受影响——成功态直接带用户去详情页，
 *     而 find 的「miss → invalidate → 重查」保证详情页立即可见）
 *   → 成功态给出「去详情页分享 →」：详情页本就有完整分享条（链接/文字/海报），
 *     分享能力永远与详情页同步，不在这里维护第二份
 *
 * 无构建步骤：defer 加载，排在 vendor SDK 与 cloud.js 之后，
 * 消费它们挂出的 window.cloud / window.App。任何一步失败静默降级。
 * ============================================================ */
(function () {
  'use strict'

  var entry = document.querySelector('[data-share-entry]')
  if (!entry) return
  if (!window.App || !App.ready || !window.cloud) return

  cloud.auth.getSession().then(function (res) {
    var user = res && res.data && res.data.user
    if (!user) return // 未登录：入口保持 hidden
    entry.hidden = false
    entry.addEventListener('click', function () { openComposer(user) })
  }).catch(function () {
    // 读会话失败视同未登录：入口保持 hidden
  })

  /* ---------------- 录入模态 ---------------- */
  function openComposer(user) {
    var m = App.mountModal(
      '<div class="modal qs-modal" style="max-width:520px">' +
      '  <div class="modal-head"><h3>分享新成果</h3></div>' +
      '  <div class="modal-body">' +
      '    <div class="modal-field"><input data-qs="title" type="text" maxlength="120" placeholder="标题：一句话说清这项研究" autocomplete="off"></div>' +
      '    <div class="modal-field"><textarea data-qs="summary" maxlength="400" placeholder="概览（约 200 字）：研究内容、方法、结论。微信分享卡片会取前 80 字。"></textarea></div>' +
      '    <div class="qs-row">' +
      '      <div class="modal-field"><input data-qs="url" type="url" placeholder="原文链接 https://" autocomplete="off"></div>' +
      '      <div class="modal-field"><input data-qs="date" type="date" title="成果日期，默认今天"></div>' +
      '    </div>' +
      '  </div>' +
      '  <div class="modal-foot">' +
      '    <span class="qs-hint" data-qs="hint" role="status" aria-live="polite"></span>' +
      '    <button class="btn" type="button" data-act="cancel">取消</button>' +
      '    <button class="btn btn-primary" type="button" data-qs="publish">发布</button>' +
      '  </div>' +
      '</div>'
    )

    var el = {}
    m.el.querySelectorAll('[data-qs]').forEach(function (node) { el[node.getAttribute('data-qs')] = node })
    el.date.value = App.today()
    el.title.focus()

    function busy(on) {
      el.publish.disabled = on
      el.publish.textContent = on ? '发布中…' : '发布'
    }
    function fail(msg) {
      el.hint.textContent = msg
      el.hint.className = 'qs-hint is-error'
    }

    el.publish.addEventListener('click', function () {
      var payload = {
        title: el.title.value.trim(),
        summary: el.summary.value.trim(),
        url: el.url.value.trim(),
        item_date: el.date.value || App.today(),
        owner_name: user.name || null,
      }
      if (!payload.title || !payload.summary || !payload.url) {
        fail('请填写标题、概览与原文链接')
        return
      }
      busy(true)
      el.hint.textContent = ''
      cloud.database.from('research_items').insert(payload).select().then(function (res) {
        busy(false)
        if (res && res.error) { fail(App.msg(res.error)); return }
        var row = res && res.data && (Array.isArray(res.data) ? res.data[0] : res.data)
        var id = row && row.id
        // 拿不到新 id 就无法直达详情页：退回 toast，让用户去后台确认
        if (!id) { m.close(); App.toast('已发布，可到后台查看', 'ok'); return }
        showDone(m, payload, id, user)
      }).catch(function (err) {
        busy(false)
        fail(App.msg(err))
      })
    })
  }

  /* ---------------- 成功态：直达详情页分享（A2） ---------------- */
  function showDone(m, payload, id, user) {
    var num = String(id).padStart(3, '0')
    var pagePath = '/item/' + id
    var card = m.el.querySelector('.modal')
    card.innerHTML =
      '<div class="modal-head"><h3>已发布</h3></div>' +
      '<div class="modal-body">' +
      '  <div class="qs-done">' +
      '    <span class="qs-done-no">NO.' + num + '</span>' +
      '    <div class="qs-done-title">' + App.esc(payload.title) + '</div>' +
      '    <div class="qs-done-url">' + App.esc(location.origin + pagePath) + '</div>' +
      '    <p class="qs-done-hint">详情页内含完整分享条：复制链接、复制文字、生成海报。</p>' +
      '  </div>' +
      '</div>' +
      '<div class="modal-foot">' +
      '  <button class="btn" type="button" data-qs-again>再分享一条</button>' +
      '  <a class="btn btn-primary" href="' + pagePath + '">去详情页分享 →</a>' +
      '</div>'
    card.querySelector('[data-qs-again]').addEventListener('click', function () {
      m.close()
      openComposer(user)
    })
  }
})()
