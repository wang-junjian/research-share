/* ============================================================
 * 研究成果 · 海报排版（GLOSSARY: 海报排版）
 *
 * 分享海报与复制文案的纯逻辑深模块，从 assets/share.js 抽出（票 #12）：
 * CJK/英文混排的切分、断行、缩字号与截断，以及文字分享的正文口径。
 * 测量经 measure(text, fontCss) 注入，本 module 不碰 canvas；
 * share.js 只剩 canvas 绘制、剪贴板与弹层接线。
 *
 * 行为口径与抽出前完全一致（零行为变化重构）——包括 fit 循环耗尽时
 * 「返回 size 低于最后测量字号」的现状（表征测试钉住，修复另议）。
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
  // 末行逐字回退到能放下省略号。opts = { maxLines, startSize, minSize,
  // weight, family, lineRatio }；measure(text, fontCss) => width。
  function fit(measure, text, maxWidth, opts) {
    var size = opts.startSize
    var lines = []
    var font = ''
    while (size >= opts.minSize) {
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
    return { lines: lines, size: size, lineHeight: Math.round(size * (opts.lineRatio || 1.42)) }
  }

  // 原文链接的单点口径：优先原文地址（src），缺失退回本页链接（url），
  // 绝不复制出空串。composeText 与调用方的「复制原文链接」共用，别各写一份
  function srcLink(d) {
    return d.src || d.url
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
    composeText: composeText,
    srcLink: srcLink,
  }
})()
