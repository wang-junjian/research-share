// 验证 OG 封面图：PNG 结构 + 像素统计（自写解码器，零依赖）
import zlib from 'node:zlib'
import fs from 'node:fs'
import { drawCover, COVER_WIDTH, COVER_HEIGHT } from '../og-image.js'

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
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
      }
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
      const inFrameBand = (x < 60 || x > width - 61 || y < 60 || y > height - 61)
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
const png = drawCover(item)
fs.writeFileSync('/tmp/og-cover.png', png)

console.log('PNG 字节数:', png.length, '| 压缩率:', ((png.length / (COVER_WIDTH * COVER_HEIGHT * 4)) * 100).toFixed(2) + '%')

const img = decodePNG(png)
const s = stats(img)
console.log('IHDR:', `${s.width}x${s.height}`, 'depth=' + img.depth, 'colorType=' + img.colorType)
console.log('颜色种类:', s.distinctColors)
console.log('非底色像素:', s.nonBgPixels, `(${((s.nonBgPixels / s.total) * 100).toFixed(3)}%)`)
console.log('朱红像素:', s.redPixels)

// 断言
const SAFE_LO = 285
const SAFE_HI = 915
const b = s.bbox
console.log('内容包围盒:', `x ${b.minX}..${b.maxX}`, `y ${b.minY}..${b.maxY}`)
const checks = [
  ['尺寸 1200x630', s.width === COVER_WIDTH && s.height === COVER_HEIGHT],
  ['RGBA 8bit', img.depth === 8 && img.colorType === 6],
  ['不是纯色图', s.distinctColors >= 4],
  ['有可见内容', s.nonBgPixels > 5000],
  ['朱红色出现', s.redPixels > 500],
  ['体积合理(<200KB)', png.length < 200 * 1024],
  [`版面在居中方形安全区内 (${SAFE_LO}..${SAFE_HI})`, b.minX >= SAFE_LO && b.maxX <= SAFE_HI],
]
let pass = true
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) pass = false
}

// 决定性差异：不同成果应产出不同封面
const other = drawCover({ id: 2, title: '电子宠物方向调研', date: '2026-10-12' })
console.log(`  ${Buffer.compare(png, other) !== 0 ? 'PASS' : 'FAIL'}  不同成果封面不同`)
console.log(pass ? '\n全部通过' : '\n存在失败项')
