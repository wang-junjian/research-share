/* ============================================================
 * 研究成果 · 海报排版（GLOSSARY: 海报排版）
 *
 * 分享海报与复制文案的纯逻辑深模块，从 assets/share.js 抽出（票 #12）：
 * CJK/英文混排的切分、断行、缩字号与截断，以及文字分享的正文口径。
 * 测量经 measure(text, fontCss) 注入，本 module 不碰 canvas；
 * share.js 只剩 canvas 绘制、剪贴板与弹层接线。
 *
 * 行为口径与抽出前完全一致（零行为变化重构），除一处已修复的 quirk：
 * fit 循环耗尽时原先把「多减一次的 size」返回给 drawPoster（拿小号字
 * 去画按大号排的版），现返回最后实际测量的字号（表征测试同步更新）。
 * 测试见 test/poster-layout.test.js（seam 与 browser-data.test.js 同款）。
 * ============================================================ */
(function () {
  'use strict'

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

  // measure(text) => width：当前字号下文本的渲染宽度
  function wrap(measure, text, maxWidth) {
    var lines = []
    var line = ''
    var tokens = tokenize(String(text).replace(/\s+/g, ' ').trim())
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i]
      if (t === ' ' && !line) continue
      var probe = line + t
      if (measure(probe) > maxWidth && line) {
        lines.push(line.replace(/\s+$/, ''))
        line = t === ' ' ? '' : t
      } else {
        line = probe
      }
    }
    if (line.trim()) lines.push(line.replace(/\s+$/, ''))
    return lines
  }

  // 从 startSize 逐 2px 缩字号直到行数达标；仍超则截到 maxLines 行，
  // 末行逐字回退到能放下省略号。返回的 size/lineHeight 始终是最后实际
  // 测量的字号（循环耗尽时不会多减一次），调用方拿它去画不会货不对版。
  // opts = { maxLines, startSize, minSize, weight, family, lineRatio }；
  // measure(text, fontCss) => width。
  function fit(measure, text, maxWidth, opts) {
    var size = opts.startSize
    var usedSize = opts.startSize
    var lines = []
    var font = ''
    while (size >= opts.minSize) {
      usedSize = size
      font = opts.weight + ' ' + size + 'px ' + opts.family
      lines = wrap(function (t) { return measure(t, font) }, text, maxWidth)
      if (lines.length <= opts.maxLines) break
      size -= 2
    }
    if (lines.length > opts.maxLines) {
      lines = lines.slice(0, opts.maxLines)
      var last = lines[opts.maxLines - 1]
      while (last.length > 1 && measure(last + '…', font) > maxWidth) last = last.slice(0, -1)
      lines[opts.maxLines - 1] = last + '…'
    }
    return { lines: lines, size: usedSize, lineHeight: Math.round(usedSize * (opts.lineRatio || 1.42)) }
  }

  // 原文链接的单点口径：优先原文地址（src），缺失退回本页链接（url），
  // 绝不复制出空串。composeText 与调用方的「复制原文链接」共用，别各写一份
  function srcLink(d) {
    return d.src || d.url
  }

  // data.url 的 host 做刊头域名；解析失败退回原文串（与抽出前 share.js 同款）
  function hostOf(url) {
    try { return new URL(url).host } catch (e) { return url }
  }

  // -----------------------------------------------------------------------
  // 整版版面决策（概念①「红底对撞」）：刊头（编号 + 域名）/ 朱红短线 /
  // 标题 + 概览垂直居中 / 底部满版朱红带（左栏纯文字三行层级：部门署名、
  // 日期·作者、长按识别引导；右：二维码白卡）。坐标、字号、行数全部在这里
  // 算好（含刊头与红带文字的固定字号），drawPoster 只照着画；页边距经
  // pad 导出，调用方不反推。fonts = { serif, sans } 由调用方注入（测试传
  // 占位串）。
  // -----------------------------------------------------------------------
  var W = 1080
  var H = 1350
  var PAD = 104
  var BAND_H = 340
  var CARD = 300
  var CARD_INSET = 30
  // 部门署名：站点级常量，红带左栏最大最粗的一行；要可配时再提升为共享常量
  var DEPT = '研发中心'

  function posterSpec(measure, d, fonts) {
    fonts = fonts || {}
    var serif = fonts.serif || 'serif'
    var sans = fonts.sans || 'sans-serif'
    var right = W - PAD
    var bandY = H - BAND_H

    // 内容区：朱红短线之下、红带之上，垂直居中
    var AVAIL_TOP = 290
    var AVAIL_H = bandY - AVAIL_TOP - 48
    var GAP = 56
    var RULE_H = 2
    var GAP_AFTER_RULE = 36

    var title = fit(measure, d.title, right - PAD, { maxLines: 4, startSize: 72, minSize: 40, weight: '400', family: serif, lineRatio: 1.38 })
    var titleH = title.lines.length * title.lineHeight

    var remain = AVAIL_H - titleH - GAP - RULE_H - GAP_AFTER_RULE
    var sumMaxLines = Math.max(3, Math.min(8, Math.floor(remain / (32 * 1.72))))
    var summary = fit(measure, d.summary, right - PAD, { maxLines: sumMaxLines, startSize: 32, minSize: 22, weight: '400', family: sans, lineRatio: 1.72 })
    var sumH = summary.lines.length * summary.lineHeight

    var totalH = titleH + GAP + RULE_H + GAP_AFTER_RULE + sumH
    var y = AVAIL_TOP + Math.max(0, Math.round((AVAIL_H - totalH) / 2))

    return {
      W: W, H: H, pad: PAD,
      masthead: {
        no: d.no ? 'NO.' + d.no : '',
        host: hostOf(d.url),
        y: 168, size: 26,
      },
      rule: { x: PAD, y: 200, w: 108, h: 5 },
      title: { lines: title.lines, size: title.size, lineHeight: title.lineHeight, x: PAD, y: y },
      divider: { x: PAD, y: y + titleH + GAP, w: right - PAD, h: RULE_H },
      summary: { lines: summary.lines, size: summary.size, lineHeight: summary.lineHeight, x: PAD, y: y + titleH + GAP + RULE_H + GAP_AFTER_RULE },
      band: { x: 0, y: bandY, w: W, h: BAND_H },
      dept: { text: DEPT, x: PAD, y: bandY + 118, size: 34 },
      meta: { text: [d.date, d.by].filter(Boolean).join('  ·  '), x: PAD, y: bandY + 182, size: 30 },
      qrHint: { text: '长按识别 · 阅读原文', x: PAD, y: bandY + 237, size: 26 },
      qrCard: { x: W - PAD - CARD, y: bandY + (BAND_H - CARD) / 2, size: CARD },
      qr: { x: W - PAD - CARD + CARD_INSET, y: bandY + (BAND_H - CARD) / 2 + CARD_INSET, size: CARD - CARD_INSET * 2 },
      src: srcLink(d),
    }
  }

  // 「文字 + 原文链接」的正文：标题 / 概览 / 原文链接，三段各占一行。
  // 「复制海报图 + 原文链接」也复用这段文字 —— 图片写不进去时它就是唯一的载体。
  function composeText(d) {
    var src = srcLink(d)
    var label = d.src ? '原文链接' : '本页链接'
    var lines = []
    if (d.title) lines.push(d.title)
    if (d.overview) lines.push(d.overview)
    lines.push(label + '：' + src)
    return lines.join('\n')
  }

  window.PosterLayout = {
    tokenize: tokenize,
    wrap: wrap,
    fit: fit,
    posterSpec: posterSpec,
    composeText: composeText,
    srcLink: srcLink,
  }
})()
