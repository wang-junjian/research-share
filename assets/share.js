/* ============================================================
 * 研究成果 · 分享交互
 * 1) 复制本页链接  —— clipboard API + execCommand 回退（微信 webview 可用）
 * 2) 复制文字+原文链接 —— 纯文本三段：标题 / 概览 / 原文链接
 * 3) 显示海报图    —— Canvas 绘制后弹层预览，可长按保存 / 下载 PNG
 * 4) 复制海报图    —— 把 PNG 写进系统剪贴板，粘贴即得图
 * 5) 复制海报图+原文链接 —— 同一次 write 里带 image/png 与 text/plain 两种风味
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

  // 「文字 + 原文链接」的正文：标题 / 概览 / 原文链接，三段各占一行。
  // 「复制海报图 + 原文链接」也复用这段文字 —— 图片写不进去时它就是唯一的载体。
  function composeText() {
    var src = data.src || data.url
    var label = data.src ? '原文链接' : '本页链接'
    var lines = []
    if (data.title) lines.push(data.title)
    if (data.overview) lines.push(data.overview)
    lines.push(label + '：' + src)
    return lines.join('\n')
  }

  function copyShareText() {
    var text = composeText()
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

  // ---------------- 海报图 ----------------
  var W = 1080
  var H = 1350

  // 按「词 / 单个 CJK 字符」切分，避免把英文单词从中间截断
  function tokenize(text) {
    var out = []
    var buf = ''
    for (var i = 0; i < text.length; i++) {
      var ch = text[i]
      var isWide = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch)
      var isSpace = /\s/.test(ch)
      if (isWide || isSpace) {
        if (buf) { out.push(buf); buf = '' }
        out.push(ch)
      } else {
        buf += ch
      }
    }
    if (buf) out.push(buf)
    return out
  }

  function wrap(ctx, text, maxWidth) {
    var lines = []
    var line = ''
    var tokens = tokenize(String(text).replace(/\s+/g, ' ').trim())
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i]
      if (t === ' ' && !line) continue
      var probe = line + t
      if (ctx.measureText(probe).width > maxWidth && line) {
        lines.push(line.replace(/\s+$/, ''))
        line = t === ' ' ? '' : t
      } else {
        line = probe
      }
    }
    if (line.trim()) lines.push(line.replace(/\s+$/, ''))
    return lines
  }

  function fit(ctx, text, maxWidth, maxLines, startSize, minSize, weight, family, lineRatio) {
    var size = startSize
    var lines = []
    while (size >= minSize) {
      ctx.font = weight + ' ' + size + 'px ' + family
      lines = wrap(ctx, text, maxWidth)
      if (lines.length <= maxLines) break
      size -= 2
    }
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines)
      var last = lines[maxLines - 1]
      while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1)
      lines[maxLines - 1] = last + '…'
    }
    return { lines: lines, size: size, lineHeight: Math.round(size * (lineRatio || 1.42)) }
  }

  function drawPoster() {
    var cv = document.createElement('canvas')
    cv.width = W
    cv.height = H
    var ctx = cv.getContext('2d')

    var SERIF = "'Instrument Serif', 'Songti SC', 'Noto Serif SC', serif"
    var SANS = "'Archivo', -apple-system, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"

    // 暖白纸底
    ctx.fillStyle = '#FAF9F7'
    ctx.fillRect(0, 0, W, H)

    // 外框
    ctx.strokeStyle = '#E0DDD8'
    ctx.lineWidth = 2
    ctx.strokeRect(48, 48, W - 96, H - 96)

    var PAD = 104
    var right = W - PAD

    // 顶部编号与站名
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#6E6B66'
    ctx.font = '500 26px ' + SANS
    var noText = data.no ? 'NO.' + data.no : ''
    ctx.fillText(noText, PAD, 168)
    ctx.textAlign = 'right'
    ctx.fillText('RESEARCH NOTES', right, 168)
    ctx.textAlign = 'left'

    // 朱红短线，和 OG 封面同一套语言
    ctx.fillStyle = '#C62B38'
    ctx.fillRect(PAD, 200, 108, 5)

    // 内容区（标题 + 概览）垂直居中，避免中部留白
    var AVAIL_TOP = 290
    var AVAIL_H = 830
    var GAP = 56
    var RULE_H = 2
    var GAP_AFTER_RULE = 36

    ctx.textBaseline = 'top'

    var titleBlock = fit(ctx, data.title, right - PAD, 4, 62, 36, '400', SERIF, 1.38)
    var titleH = titleBlock.lines.length * titleBlock.lineHeight

    var remain = AVAIL_H - titleH - GAP - RULE_H - GAP_AFTER_RULE
    var sumMaxLines = Math.max(3, Math.min(10, Math.floor(remain / (30 * 1.72))))
    var sumBlock = fit(ctx, data.summary, right - PAD, sumMaxLines, 32, 22, '400', SANS, 1.72)
    var sumH = sumBlock.lines.length * sumBlock.lineHeight

    var totalH = titleH + GAP + RULE_H + GAP_AFTER_RULE + sumH
    var y = AVAIL_TOP + Math.max(0, Math.round((AVAIL_H - totalH) / 2))

    // 标题
    ctx.fillStyle = '#1A1A1A'
    ctx.font = '400 ' + titleBlock.size + 'px ' + SERIF
    for (var i = 0; i < titleBlock.lines.length; i++) {
      ctx.fillText(titleBlock.lines[i], PAD, y)
      y += titleBlock.lineHeight
    }

    // 分隔线
    y += GAP
    ctx.fillStyle = '#E0DDD8'
    ctx.fillRect(PAD, y, right - PAD, RULE_H)
    y += RULE_H + GAP_AFTER_RULE

    // 概览
    ctx.fillStyle = '#4B4945'
    ctx.font = '400 ' + sumBlock.size + 'px ' + SANS
    for (var j = 0; j < sumBlock.lines.length; j++) {
      ctx.fillText(sumBlock.lines[j], PAD, y)
      y += sumBlock.lineHeight
    }

    ctx.textBaseline = 'alphabetic'

    // 底部：日期 · 作者 / 域名
    var footY = H - 140
    ctx.fillStyle = '#E0DDD8'
    ctx.fillRect(PAD, footY - 58, right - PAD, 2)

    // 页边批注竖条（与 OG 封面同一母题），不与文字重叠
    ctx.fillStyle = '#C62B38'
    ctx.fillRect(PAD, footY - 44, 4, 56)

    ctx.fillStyle = '#1A1A1A'
    ctx.font = '500 30px ' + SANS
    var meta = [data.date, data.by].filter(Boolean).join('  ·  ')
    ctx.fillText(meta, PAD + 26, footY)

    ctx.fillStyle = '#6E6B66'
    ctx.font = '400 26px ' + SANS
    var host = ''
    try { host = new URL(data.url).host } catch (e) { host = data.url }
    ctx.textAlign = 'right'
    ctx.fillText(host, right, footY)
    ctx.textAlign = 'left'

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
    else if (act === 'copy-text') copyShareText()
    else if (act === 'show-poster') showPoster()
    else if (act === 'copy-poster') copyPoster(false)
    else if (act === 'copy-poster-link') copyPoster(true)
  })
})()
