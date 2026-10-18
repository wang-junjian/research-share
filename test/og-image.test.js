import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { drawCover, COVER_WIDTH, COVER_HEIGHT } from '../og-image.js'

// ---------------------------------------------------------------------------
// OG 封面（微信分享卡片）的绘制不变量。drawCover 是纯函数，直接 import。
// 解码器与像素统计是测试 harness，留在本文件，不进 og-image.js 的 interface。
// （断言内核移植自 scripts/verify-og.mjs，原脚本已随本测试落地而删除。）
// ---------------------------------------------------------------------------

function decodePNG(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('PNG signature mismatch')
  let off = 8
  let ihdr = null
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9] }
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (!ihdr) throw new Error('no IHDR')
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const { width, height } = ihdr
  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]
    if (ft !== 0) throw new Error('unexpected filter type ' + ft + ' at row ' + y)
    raw.copy(out, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
  }
  return { ...ihdr, pixels: out }
}

function stats(img) {
  const { width, height, pixels } = img
  const colors = new Map()
  let red = 0
  let nonBg = 0
  const bg = [247, 243, 236]
  // 外框本身不是内容，统计内容包围盒时排除贴边 2px 的范围
  let minX = width, maxX = 0, minY = height, maxY = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2]
      const key = (r << 16) | (g << 8) | b
      colors.set(key, (colors.get(key) || 0) + 1)
      const isBg = r === bg[0] && g === bg[1] && b === bg[2]
      if (!isBg) nonBg++
      // 朱红 #C62B38
      if (Math.abs(r - 198) <= 6 && Math.abs(g - 43) <= 6 && Math.abs(b - 56) <= 6) red++
      // 内容包围盒：排除外框（inset 40）与右上角标
      const inFrameBand = x < 60 || x > width - 61 || y < 60 || y > height - 61
      const isTick = x > width - 170 && y < 140
      if (!isBg && !inFrameBand && !isTick) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return { width, height, distinctColors: colors.size, nonBgPixels: nonBg, redPixels: red, total: width * height, bbox: { minX, maxX, minY, maxY } }
}

const item = { id: 1, title: 'DSpark 深度研究：speculative decoding 系统拆解', date: '2026-10-15' }

test('封面绘制不变量：尺寸、色彩、版面安全区、体积', () => {
  const png = drawCover(item)
  const img = decodePNG(png)
  const s = stats(img)

  assert.equal(s.width, COVER_WIDTH, '宽度')
  assert.equal(s.height, COVER_HEIGHT, '高度')
  assert.equal(img.depth, 8, 'RGBA 8bit depth')
  assert.equal(img.colorType, 6, 'RGBA colorType')
  assert.ok(s.distinctColors >= 4, `不是纯色图（实际 ${s.distinctColors} 种）`)
  assert.ok(s.nonBgPixels > 5000, `有可见内容（实际 ${s.nonBgPixels} 像素）`)
  assert.ok(s.redPixels > 500, `朱红色出现（实际 ${s.redPixels} 像素）`)
  assert.ok(png.length < 200 * 1024, `体积合理（实际 ${(png.length / 1024).toFixed(1)}KB）`)

  // 版面在居中方形安全区内：微信会话里封面常被裁成方图
  const SAFE_LO = 285
  const SAFE_HI = 915
  const b = s.bbox
  assert.ok(b.minX >= SAFE_LO && b.maxX <= SAFE_HI, `内容包围盒 x ${b.minX}..${b.maxX} 应在 ${SAFE_LO}..${SAFE_HI}`)
})

test('确定性：同一成果恒得同一封面，不同成果封面不同', () => {
  const a = drawCover(item)
  const b = drawCover(item)
  assert.deepEqual(a, b, '同输入应恒同输出（缓存与微信抓图依赖这一点）')

  const other = drawCover({ id: 2, title: '电子宠物方向调研', date: '2026-10-12' })
  assert.notEqual(Buffer.compare(a, other), 0, '不同成果应产出不同封面')
})
