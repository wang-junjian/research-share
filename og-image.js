// ---------------------------------------------------------------------------
// OG 封面图生成器 · 零依赖
//
// 微信分享卡片（尤其朋友圈）必须带图，而本项目没有图片素材。
// 这里用纯 JS 在内存里画一张 1200×630 的封面，直接编码成 PNG 返回，
// 不落盘、不用任何图形库、不消耗云服务资源点。
//
// 视觉概念：「研究笔记」的横格纸 —— 暖白纸底 + 墨色横格 + 一条朱红批注线，
// 批注线的位置由成果内容哈希决定，所以每条成果的封面略有差异但风格统一。
// 纸色比页面底色略暖略深，这样在微信的冷白卡片里仍有清晰的边界。
//
// 只用 Node 内置 zlib 做压缩；PNG 的 chunk 与 CRC32 自己实现。
// ---------------------------------------------------------------------------

import zlib from 'node:zlib'

const W = 1200
const H = 630

// 与 style.css 的设计 token 保持一致
const BG = [247, 243, 236]        // #F7F3EC 暖白纸底
const RULE = [208, 200, 186]      // #D0C8BA 横格线（正文行）
const RULE_STRONG = [110, 105, 96] // #6E6960 标题行
const FRAME = [227, 221, 209]     // #E3DDD1 外框
const RED = [198, 43, 56]         // #C62B38 批注色（朱红）
const RED_DIM = [232, 195, 198]   // #E8C3C6 页边线

// ---------------------------------------------------------------------------
// PNG 编码（8-bit RGBA，filter 0）
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// 极简光栅画布
// ---------------------------------------------------------------------------
function createCanvas(width, height, bg) {
  const buf = Buffer.alloc(width * height * 4)
  const row = Buffer.alloc(width * 4)
  for (let x = 0; x < width; x++) {
    row[x * 4] = bg[0]
    row[x * 4 + 1] = bg[1]
    row[x * 4 + 2] = bg[2]
    row[x * 4 + 3] = 255
  }
  for (let y = 0; y < height; y++) row.copy(buf, y * width * 4)

  function px(x, y, c) {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const i = (y * width + x) * 4
    buf[i] = c[0]
    buf[i + 1] = c[1]
    buf[i + 2] = c[2]
    buf[i + 3] = 255
  }

  return {
    buf,
    fillRect(x, y, w, h, c) {
      const x0 = Math.max(0, x | 0)
      const y0 = Math.max(0, y | 0)
      const x1 = Math.min(width, x0 + (w | 0))
      const y1 = Math.min(height, y0 + (h | 0))
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) px(xx, yy, c)
    },
    // 1px 描边矩形（不做抗锯齿，深色底上足够干净）
    strokeRect(x, y, w, h, c) {
      for (let xx = x; xx < x + w; xx++) {
        px(xx, y, c)
        px(xx, y + h - 1, c)
      }
      for (let yy = y; yy < y + h; yy++) {
        px(x, yy, c)
        px(x + w - 1, yy, c)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 内容哈希：同一条成果永远得到同一张封面
// ---------------------------------------------------------------------------
function hashSeed(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// 封面绘制
// ---------------------------------------------------------------------------
function drawCover(item) {
  const cv = createCanvas(W, H, BG)
  const seed = hashSeed(`${item.id}|${item.title}|${item.date}`)

  // 外框
  cv.strokeRect(40, 40, W - 80, H - 80, FRAME)

  // 装订页边线
  const marginX = 300
  cv.fillRect(marginX, 118, 1, 396, RED_DIM)

  // 版面收在中央安全区内：微信会把卡片图居中裁成方形，
  // 内容全部落在 x ∈ [285, 915] 才能保证裁切后依然完整。
  const BLOCK_X = 344
  cv.fillRect(BLOCK_X, 132, 400, 16, RULE_STRONG)

  // 正文行：宽度由哈希决定，像一段段长短不齐的文字
  const lineH = 10
  const step = 46
  const first = 190
  const count = 7
  const lines = []
  for (let i = 0; i < count; i++) {
    let w = 220 + (((seed >>> (i * 3)) & 0xff) / 255) * 340
    if (i === count - 1) w = 160 + ((seed >>> 20) % 130) // 末行短，像段落收尾
    const y = first + i * step
    lines.push({ y, w: Math.round(w) })
    cv.fillRect(BLOCK_X, y, Math.round(w), lineH, RULE)
  }

  // 朱红批注线：替换其中一行，位置随内容固定
  const picked = 1 + (seed % (count - 2))
  const hit = lines[picked]
  cv.fillRect(BLOCK_X - 30, hit.y - 4, 10, 18, RED) // 页边批注记号
  cv.fillRect(BLOCK_X, hit.y - 4, hit.w, 18, RED)

  // 右上角标
  const tickX = W - 120 - ((seed >>> 16) % 5) * 14
  cv.fillRect(tickX, 96, 14, 14, RED)

  return encodePNG(W, H, cv.buf)
}

export { drawCover, encodePNG, createCanvas, W as COVER_WIDTH, H as COVER_HEIGHT }
