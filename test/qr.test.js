import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// ---------------------------------------------------------------------------
// 海报二维码（GLOSSARY: 海报二维码）的 interface 表征测试。
//
//   · matrix(text)：经 vendored qrcode-generator（assets/vendor/qrcode.js，
//     经典脚本顶层 var 挂全局，node 侧用 vm.runInThisContext 模拟 <script>
//     语义）生成模块矩阵；纠错等级 H、typeNumber 0 自动版本
//   · draw(ctx, matrix, opts)：圆角方块码点、三定位角用朱红、其余近黑；
//     ctx 有 roundRect 用圆角路径，否则退化为 fillRect
//
// matrix 的期望值来自 QR 规范的必然性质（尺寸公式、定位角图案），与实现
// 无关；draw 用 fake matrix + 记录型 ctx 钉住颜色分派与几何。
// seam 与 poster-layout.test.js 同款：预设 window + 顶层 import。
// ---------------------------------------------------------------------------

globalThis.window = {}
vm.runInThisContext(readFileSync(new URL('../assets/vendor/qrcode.js', import.meta.url), 'utf8'))
await import('../assets/qr.js')
const QR = globalThis.window.QR

test('matrix：矩阵尺寸符合 QR 版本公式（21 + 4k），纠错等级 H 自动选版本', () => {
  const m = QR.matrix('https://example.com/original')
  assert.ok(m.count >= 21)
  assert.equal((m.count - 21) % 4, 0, '版本尺寸公式 21+4·(version-1)')
})

test('matrix：定位角图案是规范必然——外角与芯为深、环带为浅', () => {
  const m = QR.matrix('https://example.com/x')
  assert.equal(m.isDark(0, 0), true, '左上定位角外角')
  assert.equal(m.isDark(3, 3), true, '左上定位角 3×3 芯')
  assert.equal(m.isDark(1, 1), false, '定位角内浅环带')
  assert.equal(m.isDark(0, m.count - 1), true, '右上定位角外角')
  assert.equal(m.isDark(m.count - 1, 0), true, '左下定位角外角')
})

// 记录型 ctx：记下每次 fill 的 fillStyle 与路径参数；
// withRoundRect=false 时整个方法缺席，模拟旧 webview
function spyCtx(withRoundRect) {
  const calls = []
  const ctx = {
    calls,
    fillStyle: '',
    beginPath() {},
    fill() { calls.push({ at: this._path, fillStyle: this.fillStyle }) },
    fillRect(x, y, w, h) { calls.push({ rect: { x, y, w, h }, fillStyle: this.fillStyle }) },
  }
  if (withRoundRect) ctx.roundRect = function (x, y, w, h, r) { this._path = { x, y, w, h, r } }
  return ctx
}

// fake matrix：21×21，(r+c) 偶数为深
const FAKE = { count: 21, isDark: (r, c) => (r + c) % 2 === 0 }
const OPTS = { x: 706, y: 1060, size: 240, dark: '#1A1A1A', finder: '#C62B38' }

test('draw：三定位角用朱红、其余深色码点用近黑、浅色码点不画', () => {
  const ctx = spyCtx(true)
  QR.draw(ctx, FAKE, OPTS)
  const at = (r, c) => {
    const ms = OPTS.size / FAKE.count
    return ctx.calls.find((k) => k.at && k.at.x === OPTS.x + c * ms && k.at.y === OPTS.y + r * ms)
  }
  assert.equal(at(0, 0).fillStyle, OPTS.finder, '左上定位角')
  assert.equal(at(0, 20).fillStyle, OPTS.finder, '右上定位角')
  assert.equal(at(20, 0).fillStyle, OPTS.finder, '左下定位角')
  assert.equal(at(20, 20).fillStyle, OPTS.dark, '右下角不是定位角（那是校正图形区）')
  assert.equal(at(10, 10).fillStyle, OPTS.dark, '数据区深色码点')
  assert.equal(at(0, 1), undefined, '浅色码点不画')
})

test('draw：码点几何——铺满码区、圆角半径 40% 码点宽', () => {
  const ctx = spyCtx(true)
  QR.draw(ctx, FAKE, OPTS)
  const ms = OPTS.size / FAKE.count
  const first = ctx.calls[0].at
  assert.equal(first.w, ms)
  assert.equal(first.h, ms)
  assert.equal(first.r, ms * 0.4)
})

test('draw：ctx 没有 roundRect 时退化为 fillRect（旧 webview 仍可扫）', () => {
  const ctx = spyCtx(false)
  QR.draw(ctx, FAKE, OPTS)
  assert.ok(ctx.calls.length > 0)
  assert.ok(ctx.calls.every((k) => k.rect), '全部走 fillRect 退路')
})
