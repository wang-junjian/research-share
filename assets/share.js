/* ============================================================
 * 研究成果 · 分享交互
 * 1) 复制海报图    —— 把 PNG 写进系统剪贴板，粘贴即得图
 * 2) 显示海报图    —— Canvas 绘制后弹层预览，可长按保存 / 下载 PNG
 * 3) 复制原文链接  —— clipboard API + execCommand 回退（微信 webview 可用）
 * 4) 复制本页链接  —— 同上，复制的是站内详情页地址
 * 5) 复制海报图+原文链接 —— 同一次 write 里带 image/png 与 text/plain 两种风味
 * 6) 复制文字+原文链接 —— 纯文本三段：标题 / 概览 / 原文链接
 *
 * 海报上的数据来自详情页 .sharebar 的 data-* 属性，不额外请求接口。
 * 零依赖、无外链。
 *
 * 兼容性说明：写图片进剪贴板依赖 async clipboard + ClipboardItem，微信内置
 * 浏览器不支持，桌面 Chrome / Edge / Safari 14+ 支持。不支持时一律降级为
 * 「打开海报图弹层」，由用户长按保存 —— 绝不给一个点了没反应的按钮。
 * ============================================================ */
(function () {
  'use strict'

  var root = document.querySelector('[data-share]')
  if (!root) return

  var mount = document.querySelector('[data-poster-mount]')
  var note = root.querySelector('[data-note]')
  var NOTE_DEFAULT = note ? note.textContent : ''

  var data = {
    title: root.getAttribute('data-title') || '',
    summary: root.getAttribute('data-summary') || '',
    // overview 是完整概览（data-summary 给海报用，限 220 字）
    overview: root.getAttribute('data-overview') || '',
    date: root.getAttribute('data-date') || '',
    by: root.getAttribute('data-by') || '',
    no: root.getAttribute('data-no') || '',
    url: root.getAttribute('data-url') || location.href.split('#')[0],
    src: root.getAttribute('data-src') || '',
  }

  var UA = navigator.userAgent || ''
  var IS_WECHAT = /MicroMessenger/i.test(UA)
  var IS_TOUCH = ('ontouchstart' in window) || navigator.maxTouchPoints > 0

  // 弹层里的操作提示：能不能长按、要不要点下载，取决于有没有触摸屏
  function defaultHint() {
    return IS_TOUCH
      ? '长按图片 → 保存到相册，再粘贴到微信'
      : '点下面的「下载 PNG」保存；手机端可长按图片保存'
  }

  // 海报要用 Instrument Serif / Archivo 两套自托管字体。剪贴板写入必须在用户
  // 手势里同步发起（Safari 尤其严格），没法等 Promise，所以这里在脚本载入时
  // 就把「字体是否就绪」记下来；未就绪时该次点击改走弹层，不让画布用兜底字体。
  var FONTS_READY = !(document.fonts && document.fonts.ready)
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { FONTS_READY = true }, function () { FONTS_READY = true })
  }

  function errMsg(e) {
    return e && e.message ? e.message : '未知错误'
  }

  function setNote(text, kind) {
    if (!note) return
    note.textContent = text
    note.className = 'share-note' + (kind ? ' is-' + kind : '')
  }

  function resetNoteSoon() {
    window.setTimeout(function () { setNote(NOTE_DEFAULT, '') }, 4200)
  }

  // ---------------- 复制文本 ----------------
  function legacyCopy(text) {
    var ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    if (ta.setSelectionRange) { try { ta.setSelectionRange(0, ta.value.length) } catch (e) {} }
    var ok = false
    try { ok = document.execCommand('copy') } catch (e) { ok = false }
    document.body.removeChild(ta)
    return ok
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () { return true },
        function () { return legacyCopy(text) },
      )
    }
    return Promise.resolve(legacyCopy(text))
  }

  // 原文链接口径与分享正文口径都收口在海报排版 module（assets/poster-layout.js，
  // GLOSSARY: 海报排版，先于本脚本加载）：srcLink / composeText 只调用不各写一份
  var Layout = window.PosterLayout

  function copyShareText() {
    var text = Layout.composeText(data)
    copyText(text).then(function (ok) {
      if (ok) {
        setNote('文字 + 原文链接已复制，粘贴到微信即可发送', 'ok')
        resetNoteSoon()
      } else {
        setNote('这个环境不让自动复制，请长按选中页面上的标题、概览与原文链接', 'error')
      }
    })
  }

  function copyLink() {
    copyText(data.url).then(function (ok) {
      if (ok) {
        setNote('本页链接已复制，去微信里粘贴发送即可', 'ok')
        resetNoteSoon()
      } else {
        setNote('这个环境不让自动复制，请长按选中：' + data.url, 'error')
      }
    })
  }

  // 「复制原文链接」：原始出处地址，口径见 PosterLayout.srcLink
  function copySrcLink() {
    var src = Layout.srcLink(data)
    copyText(src).then(function (ok) {
      if (ok) {
        setNote('原文链接已复制，去微信里粘贴发送即可', 'ok')
        resetNoteSoon()
      } else {
        setNote('这个环境不让自动复制，请长按选中：' + src, 'error')
      }
    })
  }

  // ---------------- 海报图 ----------------
  // 版面决策（坐标/字号/红带几何/二维码卡位）收口在 PosterLayout.posterSpec，
  // 二维码矩阵与绘制收口在 window.QR；这里只剩调色与照着 spec 画
  function drawPoster() {
    var cv = document.createElement('canvas')
    var ctx = cv.getContext('2d')

    // 注入排版 module 的测量：给了 fontCss 就先设字体再量（fit 逐字号试排靠这个）
    var measure = function (t, font) {
      if (font) ctx.font = font
      return ctx.measureText(t).width
    }

    var SERIF = "'Instrument Serif', 'Songti SC', 'Noto Serif SC', serif"
    var SANS = "'Archivo', -apple-system, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"

    var spec = Layout.posterSpec(measure, data, { serif: SERIF, sans: SANS })
    cv.width = spec.W
    cv.height = spec.H

    // 暖白纸底
    ctx.fillStyle = '#FAF9F7'
    ctx.fillRect(0, 0, spec.W, spec.H)

    // 顶部刊头：编号（左）· 域名（右）
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#6E6B66'
    ctx.font = '500 ' + spec.masthead.size + 'px ' + SANS
    ctx.fillText(spec.masthead.no, spec.pad, spec.masthead.y)
    ctx.textAlign = 'right'
    ctx.fillText(spec.masthead.host, spec.W - spec.pad, spec.masthead.y)
    ctx.textAlign = 'left'

    // 朱红短线，和 OG 封面同一套语言
    ctx.fillStyle = '#C62B38'
    ctx.fillRect(spec.rule.x, spec.rule.y, spec.rule.w, spec.rule.h)

    ctx.textBaseline = 'top'

    // 标题
    ctx.fillStyle = '#1A1A1A'
    ctx.font = '400 ' + spec.title.size + 'px ' + SERIF
    var y = spec.title.y
    for (var i = 0; i < spec.title.lines.length; i++) {
      ctx.fillText(spec.title.lines[i], spec.title.x, y)
      y += spec.title.lineHeight
    }

    // 分隔线
    ctx.fillStyle = '#E0DDD8'
    ctx.fillRect(spec.divider.x, spec.divider.y, spec.divider.w, spec.divider.h)

    // 概览
    ctx.fillStyle = '#4B4945'
    ctx.font = '400 ' + spec.summary.size + 'px ' + SANS
    y = spec.summary.y
    for (var j = 0; j < spec.summary.lines.length; j++) {
      ctx.fillText(spec.summary.lines[j], spec.summary.x, y)
      y += spec.summary.lineHeight
    }

    ctx.textBaseline = 'alphabetic'

    // 底部满版朱红带（出血到下缘与两缘）
    ctx.fillStyle = '#C62B38'
    ctx.fillRect(spec.band.x, spec.band.y, spec.band.w, spec.band.h)

    // 红带左栏三行纯文字层级：部门署名（最大最粗）/ 日期·作者 / 长按识别引导
    ctx.fillStyle = '#FFFFFF'
    ctx.font = '600 ' + spec.dept.size + 'px ' + SANS
    ctx.fillText(spec.dept.text, spec.dept.x, spec.dept.y)

    ctx.font = '500 ' + spec.meta.size + 'px ' + SANS
    ctx.fillText(spec.meta.text, spec.meta.x, spec.meta.y)

    // 二维码：库缺失或编码失败时跳过卡与提示，海报其余部分照常
    var qrMatrix = null
    try { qrMatrix = window.QR.matrix(spec.src) } catch (e) { qrMatrix = null }
    if (qrMatrix) {
      ctx.fillStyle = '#FFFFFF'
      ctx.font = '400 ' + spec.qrHint.size + 'px ' + SANS
      ctx.fillText(spec.qrHint.text, spec.qrHint.x, spec.qrHint.y)

      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(spec.qrCard.x, spec.qrCard.y, spec.qrCard.size, spec.qrCard.size)
      window.QR.draw(ctx, qrMatrix, {
        x: spec.qr.x, y: spec.qr.y, size: spec.qr.size,
        dark: '#1A1A1A', finder: '#C62B38',
      })
    }

    return cv
  }

  // ---------------- 海报弹层 ----------------
  var modalEl = null

  function closeModal() {
    if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl)
    modalEl = null
    document.removeEventListener('keydown', onKey)
  }

  function onKey(e) {
    if (e.key === 'Escape') closeModal()
  }

  function openModal(dataUrl, hintText) {
    closeModal()
    var mask = document.createElement('div')
    mask.className = 'modal-mask'
    mask.setAttribute('data-poster-modal', '')

    var modal = document.createElement('div')
    modal.className = 'modal'

    var head = document.createElement('div')
    head.className = 'modal-head'
    var h3 = document.createElement('h3')
    h3.textContent = '海报图'
    var close = document.createElement('button')
    close.type = 'button'
    close.className = 'btn-icon modal-close'
    close.setAttribute('aria-label', '关闭')
    close.textContent = '×'
    close.addEventListener('click', closeModal)
    head.appendChild(h3)
    head.appendChild(close)

    var body = document.createElement('div')
    body.className = 'modal-body'
    var stage = document.createElement('div')
    stage.className = 'poster-stage'
    var img = document.createElement('img')
    img.src = dataUrl
    img.alt = '研究成果海报图'
    stage.appendChild(img)
    var hint = document.createElement('p')
    hint.className = 'poster-hint' + (hintText ? ' is-strong' : '')
    hint.textContent = hintText || defaultHint()
    body.appendChild(stage)
    body.appendChild(hint)

    var foot = document.createElement('div')
    foot.className = 'modal-foot'
    var dl = document.createElement('button')
    dl.type = 'button'
    dl.className = 'btn btn-sm'
    dl.textContent = '下载 PNG'
    dl.addEventListener('click', function () {
      try {
        var a = document.createElement('a')
        a.href = dataUrl
        a.download = 'research-' + (data.no || 'note') + '.png'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
      } catch (e) {
        setNote('这个环境不支持直接下载，请长按图片保存', 'error')
      }
    })
    var closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'btn btn-sm btn-ghost'
    closeBtn.textContent = '关闭'
    closeBtn.addEventListener('click', closeModal)
    foot.appendChild(dl)
    foot.appendChild(closeBtn)

    modal.appendChild(head)
    modal.appendChild(body)
    modal.appendChild(foot)
    mask.appendChild(modal)
    mask.addEventListener('click', function (e) { if (e.target === mask) closeModal() })
    ;(mount || document.body).appendChild(mask)
    modalEl = mask
    document.addEventListener('keydown', onKey)
  }

  // ---------------- 显示海报图 ----------------
  function showPoster(hintText, doneNote) {
    setNote('正在生成海报图…', '')
    var run = function () {
      try {
        openModal(drawPoster().toDataURL('image/png'), hintText)
        if (doneNote) setNote(doneNote.text, doneNote.kind)
        else setNote(NOTE_DEFAULT, '')
      } catch (e) {
        setNote('海报图生成失败：' + errMsg(e), 'error')
      }
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(run, run)
    else run()
  }

  // ---------------- 复制海报图（可带原文链接） ----------------
  // 写图片进剪贴板只有 async clipboard + ClipboardItem 这一条路，微信内置浏览器
  // 没有；任何一步不成立都降级为「打开海报图弹层」，绝不给点了没反应的按钮。
  function canWriteImage() {
    return !!(window.ClipboardItem && navigator.clipboard && navigator.clipboard.write && window.isSecureContext)
  }

  function pngBlob(cv) {
    return new Promise(function (resolve, reject) {
      cv.toBlob(function (b) { b ? resolve(b) : reject(new Error('海报图编码失败')) }, 'image/png')
    })
  }

  function copyPoster(withLink) {
    var what = withLink ? '海报图 + 原文链接' : '海报图'

    // 带链接时先把文字单独复制一份：这样即便下面的图片写入失败，链接也已经进了
    // 剪贴板。而且必须在用户手势里同步做，不能等 Promise。
    var textCopied = false
    if (withLink) {
      try { textCopied = legacyCopy(composeText()) } catch (e) { textCopied = false }
    }

    function fallback(cause) {
      var tail = textCopied ? '原文链接已单独复制，' : ''
      // 弹层会把页面级的提示压在遮罩底下，所以关键信息必须写进弹层自己的提示行
      showPoster(
        '这个环境不支持直接复制图片，' + (textCopied ? '原文链接已复制，' : '') + '长按这张图保存后再粘贴',
        { text: cause + tail + '已为你打开海报图，长按图片保存即可。', kind: 'error' },
      )
    }

    if (!FONTS_READY) { fallback('海报字体还在载入，'); return }
    if (!canWriteImage()) {
      fallback(IS_WECHAT ? '微信内置浏览器不支持把图片写进剪贴板，' : '当前浏览器不支持把图片写进剪贴板，')
      return
    }

    var cv
    try { cv = drawPoster() } catch (e) { setNote('海报图生成失败：' + errMsg(e), 'error'); return }

    // 值一律传 Promise：Safari 要求 ClipboardItem 的值是可等待对象，Chrome 也接受
    var items = { 'image/png': pngBlob(cv) }
    if (withLink) items['text/plain'] = Promise.resolve(new Blob([composeText()], { type: 'text/plain' }))

    var pending
    try {
      pending = navigator.clipboard.write([new ClipboardItem(items)])
    } catch (e) {
      fallback('浏览器拒绝了这次剪贴板写入，')
      return
    }
    setNote('正在把海报图写入剪贴板…', '')
    pending.then(
      function () {
        setNote(what + '已复制，粘贴到微信即可发送', 'ok')
        resetNoteSoon()
      },
      function (e) { fallback('剪贴板写入失败（' + errMsg(e) + '），') },
    )
  }

  root.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-act]') : null
    if (!btn || btn.disabled) return
    var act = btn.getAttribute('data-act')
    if (act === 'copy-link') copyLink()
    else if (act === 'copy-src') copySrcLink()
    else if (act === 'copy-text') copyShareText()
    else if (act === 'show-poster') showPoster()
    else if (act === 'copy-poster') copyPoster(false)
    else if (act === 'copy-poster-link') copyPoster(true)
  })
})()
