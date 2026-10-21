/* ============================================================
 * 研究成果 · 海报二维码（GLOSSARY: 海报二维码）
 *
 * 分享海报右下角二维码的深模块，挂 window.QR，interface 两个成员：
 *   matrix(text)        —— 经 vendored qrcode-generator 生成模块矩阵
 *                          （纠错等级 H，30% 面积可污损仍可扫；typeNumber 0
 *                          按内容长度自动选版本；UTF-8 编码防链接带中文）
 *   draw(ctx, m, opts)  —— 把矩阵画进画布：圆角方块码点（半径 40% 码点宽）、
 *                          三定位角用朱红、其余码点近黑；ctx 无 roundRect
 *                          （旧 webview）退化为 fillRect，可扫性不受影响
 *
 * vendored 库是经典脚本（顶层 var 挂全局 qrcode），详情页在 poster-layout.js
 * 前加载；这里只经 globalThis.qrcode 惰性取用，缺失时报错由调用方降级
 * （share.js 画海报时 try/catch 后跳过二维码，绝不让整张海报失败）。
 * 测试见 test/qr.test.js（seam 与 poster-layout.test.js 同款）。
 * ============================================================ */
(function () {
  'use strict'

  // 加载时把 vendored 库的字符串编码切到 UTF-8（防链接带中文被按字节截断）。
  // 只设这一次，matrix() 内不再碰全局；库后于本脚本加载时这里静默跳过，
  // matrix() 的取用检查兜底报错，由 share.js 降级（不画二维码）。
  var qrcodeGen = globalThis.qrcode
  if (qrcodeGen && qrcodeGen.stringToBytesFuncs) {
    qrcodeGen.stringToBytes = qrcodeGen.stringToBytesFuncs['UTF-8']
  }

  function matrix(text) {
    var gen = globalThis.qrcode
    if (!gen) throw new Error('二维码库未加载（assets/vendor/qrcode.js）')
    var q = gen(0, 'H')
    q.addData(text)
    q.make()
    return {
      count: q.getModuleCount(),
      isDark: function (r, c) { return q.isDark(r, c) },
    }
  }

  // 三个 7×7 定位角：左上 / 右上 / 左下（右下角是校正图形，不算）
  function isFinder(r, c, n) {
    return (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7)
  }

  function fillRound(ctx, x, y, w, h, radius) {
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, radius)
      ctx.fill()
    } else {
      ctx.fillRect(x, y, w, h)
    }
  }

  // opts = { x, y, size, dark, finder }：码点铺满 [x, x+size) × [y, y+size)，
  // 四周留白（quiet zone）由外层白卡的内缩保证，这里不额外留边
  function draw(ctx, m, opts) {
    var ms = opts.size / m.count
    var radius = ms * 0.4
    for (var r = 0; r < m.count; r++) {
      for (var c = 0; c < m.count; c++) {
        if (!m.isDark(r, c)) continue
        ctx.fillStyle = isFinder(r, c, m.count) ? opts.finder : opts.dark
        fillRound(ctx, opts.x + c * ms, opts.y + r * ms, ms, ms, radius)
      }
    }
  }

  window.QR = { matrix: matrix, draw: draw }
})()
