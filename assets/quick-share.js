/* ============================================================
 * 快速分享入口（顶栏「＋ 分享」）
 *
 * 本脚本是一份挂件声明（GLOSSARY: 登录态门控）：挂载点 [data-share-entry]
 * 由首页与详情页输出（lib/render.js 的 shareEntry 选项），SSR 默认 hidden。
 * 读会话等门控逻辑收在 cloud.js 的 App.authGate，确认已登录才调 render ——
 * 读者永远看不到这个入口。
 *
 * 流程（设计结论见分支 proto/quick-share-entry 的原型，A2 模式）：
 *   模态录入（标题/概览/日期，加「链接 / 文档」类型切换：
 *     链接型填站外原文链接；文档型拖入/选择 .html 文件或粘贴 HTML 源码，
 *     两个入口汇入同一份 HTML 文本，提交前预检「非空、≤ 1MB 字符、不含脚本」——
 *     含 <script>/内联事件属性的文档会被平台边缘 WAF 直接 403，见下方 DOC_BLOCKED）
 *   → 浏览器 SDK 直写 research_items（与 admin 同一条写入路径，绕过本进程；
 *     文档型带 kind:'doc' + doc_html、url 留空，由 db/06 的 CHECK 兜底；
 *     首页列表的 60s 缓存不受影响——成功态直接带用户去详情页，
 *     而 find 的「miss → invalidate → 重查」保证详情页立即可见）
 *   → 成功态给出「去详情页分享 →」：详情页本就有完整分享条（链接/文字/海报），
 *     文档型在详情页内嵌全文（地基票 #3），分享能力永远与详情页同步，
 *     不在这里维护第二份
 *
 * 无构建步骤：defer 加载，排在 vendor SDK 与 cloud.js 之后，
 * 消费它们挂出的 window.cloud / window.App 与常量脚本挂出的 window.RS_CONST。
 * 任何一步失败静默降级。
 * ============================================================ */
(function () {
  'use strict'

  // 文档字符上限读共享常量（GLOSSARY: 共享常量）：/assets/constants.js 由服务端
  // 单一来源动态生成，公开页布局无条件加载。db/06 的 CHECK 无法由代码生成，
  // 维持注释对照——同口径，1MB 按字符数计（char_length）。
  var DOC_MAX_CHARS = (window.RS_CONST || {}).DOC_MAX_CHARS

  // 平台边缘 WAF 的 XSS 规则会直接 403 掉含脚本的请求体（返回一张 HTML 拦截页，
  // 不是 JSON），请求根本到不了应用 —— 浏览器直写数据面与 Agent API 两条写入通道
  // 同此限制。所以文档型只收静态 HTML：在这里前置拦下并说清原因，
  // 而不是让人撞上一个看不懂的 403 页面。
  var DOC_BLOCKED = [
    { re: /<\s*script[\s>]/i, what: '<script> 标签' },
    { re: /\son[a-z]{3,}\s*=/i, what: '内联事件属性（如 onclick=）' },
    { re: /javascript\s*:/i, what: 'javascript: 链接' }
  ]

  function blockedInDoc(html) {
    for (var i = 0; i < DOC_BLOCKED.length; i++) {
      if (DOC_BLOCKED[i].re.test(html)) return DOC_BLOCKED[i].what
    }
    return ''
  }

  if (!window.App || !App.authGate) return

  App.authGate.register({
    mount: '[data-share-entry]',
    render: function (session, el) {
      // 常量脚本缺失（RS_CONST 没挂上）时保持 hidden：录入模态依赖 DOC_MAX_CHARS
      if (!window.RS_CONST) return
      var user = session.user
      el.hidden = false
      el.addEventListener('click', function () { openComposer(user) })
    }
  })

  /* ---------------- 录入模态 ---------------- */
  function openComposer(user) {
    var m = App.mountModal(
      '<div class="modal qs-modal" style="max-width:520px">' +
      '  <div class="modal-head"><h3>分享新成果</h3></div>' +
      '  <div class="modal-body">' +
      '    <div class="qs-tabs" role="tablist" aria-label="成果类型">' +
      '      <button type="button" class="qs-tab is-on" role="tab" aria-selected="true" data-qs-tab="link">链接</button>' +
      '      <button type="button" class="qs-tab" role="tab" aria-selected="false" data-qs-tab="doc">文档</button>' +
      '    </div>' +
      '    <div class="modal-field"><input data-qs="title" type="text" maxlength="120" placeholder="标题：一句话说清这项研究" autocomplete="off"></div>' +
      '    <div class="modal-field"><textarea data-qs="summary" maxlength="400" placeholder="概览（约 200 字）：研究内容、方法、结论。微信分享卡片会取前 80 字。"></textarea></div>' +
      '    <div class="qs-pane" data-qs="paneLink">' +
      '      <div class="modal-field"><input data-qs="url" type="url" placeholder="原文链接 https://" autocomplete="off"></div>' +
      '    </div>' +
      '    <div class="qs-pane" data-qs="paneDoc" hidden>' +
      '      <div class="qs-drop" data-qs="drop" role="button" tabindex="0">' +
      '        <input data-qs="file" type="file" accept=".html,.htm,text/html" hidden>' +
      '        <span>拖入 .html 文件到这里，或点击选择文件</span>' +
      '      </div>' +
      '      <div class="modal-field"><textarea data-qs="source" class="qs-source" placeholder="或直接粘贴 HTML 源码（自包含文档：样式与内容全部内联，不含脚本）" spellcheck="false"></textarea></div>' +
      '      <span class="qs-count" data-qs="count">0 / 1,000,000 字符</span>' +
      '    </div>' +
      '    <div class="modal-field qs-date"><input data-qs="date" type="date" title="成果日期，默认今天"></div>' +
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
    function note(msg) {
      el.hint.textContent = msg
      el.hint.className = 'qs-hint'
    }

    /* ---- 类型切换：链接 / 文档（默认链接，标元字段两型共用） ---- */
    var kind = 'link'
    m.el.querySelectorAll('[data-qs-tab]').forEach(function (tab) {
      tab.addEventListener('click', function () { setKind(tab.getAttribute('data-qs-tab')) })
    })
    function setKind(next) {
      kind = next === 'doc' ? 'doc' : 'link'
      el.paneLink.hidden = kind !== 'link'
      el.paneDoc.hidden = kind !== 'doc'
      m.el.querySelectorAll('[data-qs-tab]').forEach(function (tab) {
        var on = tab.getAttribute('data-qs-tab') === kind
        tab.classList.toggle('is-on', on)
        tab.setAttribute('aria-selected', on ? 'true' : 'false')
      })
      note('')
    }

    /* ---- 文档录入：文件选择/拖拽与源码粘贴汇入同一份 HTML 文本 ---- */
    function updateCount() {
      var n = el.source.value.length
      el.count.textContent = n.toLocaleString() + ' / ' + DOC_MAX_CHARS.toLocaleString() + ' 字符'
      el.count.classList.toggle('is-over', n > DOC_MAX_CHARS)
    }
    function readFile(file) {
      if (!file) return
      if (!/\.html?$/i.test(file.name || '') && file.type !== 'text/html') {
        fail('请选择 .html 文件')
        return
      }
      file.text().then(function (text) {
        el.source.value = text // 与粘贴入口汇合：textarea 即唯一事实来源
        updateCount()
        note('已载入文件：' + file.name)
      }).catch(function () {
        fail('读取文件失败，请重试或改用粘贴源码')
      })
    }
    el.source.addEventListener('input', updateCount)
    el.file.addEventListener('change', function () {
      readFile(el.file.files && el.file.files[0])
      el.file.value = '' // 允许重复选择同一文件
    })
    el.drop.addEventListener('click', function () { el.file.click() })
    el.drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.file.click() }
    })
    el.drop.addEventListener('dragover', function (e) {
      e.preventDefault()
      el.drop.classList.add('is-over')
    })
    el.drop.addEventListener('dragleave', function () {
      el.drop.classList.remove('is-over')
    })
    el.drop.addEventListener('drop', function (e) {
      e.preventDefault()
      el.drop.classList.remove('is-over')
      readFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0])
    })

    el.publish.addEventListener('click', function () {
      var payload = {
        title: el.title.value.trim(),
        summary: el.summary.value.trim(),
        item_date: el.date.value || App.today(),
        owner_name: user.name || null,
      }
      if (kind === 'doc') {
        // 文档型：kind:'doc' + doc_html 直插，url 留空（不传，走列默认 NULL）
        var docHtml = el.source.value
        if (!payload.title || !payload.summary) { fail('请填写标题与概览'); return }
        if (!docHtml.trim()) { fail('文档为空：请拖入 .html 文件或粘贴 HTML 源码'); return }
        if (docHtml.length > DOC_MAX_CHARS) {
          fail('文档超过 1MB 上限（' + docHtml.length.toLocaleString() + ' 字符），请压缩或拆分后分享')
          return
        }
        var blocked = blockedInDoc(docHtml)
        if (blocked) {
          fail('文档含' + blocked + '：平台边缘防护会直接拦下这类提交（403），请改成不含脚本的静态 HTML 再分享')
          return
        }
        payload.kind = 'doc'
        payload.doc_html = docHtml
      } else {
        // 链接型：路径完全不变
        payload.url = el.url.value.trim()
        if (!payload.title || !payload.summary || !payload.url) {
          fail('请填写标题、概览与原文链接')
          return
        }
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
    // 编号与详情页路径经 App 的条目公共身份派生（GLOSSARY: 条目公共身份），不自行拼
    var no = App.itemNo(id)
    var pagePath = App.itemPath(id)
    var card = m.el.querySelector('.modal')
    card.innerHTML =
      '<div class="modal-head"><h3>已发布</h3></div>' +
      '<div class="modal-body">' +
      '  <div class="qs-done">' +
      '    <span class="qs-done-no">' + no + '</span>' +
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
