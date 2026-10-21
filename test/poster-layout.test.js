import test from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// 海报排版（GLOSSARY: 海报排版）的 interface 表征测试。
//
// 期望值钉住的是抽出前 assets/share.js 的对外行为（票 #12 零行为变化重构）：
//   · tokenize：英文按词、CJK 与全角标点按单字、空白各自成 token
//   · wrap：按 maxWidth 断行、行首空格跳过、行尾空格修剪、空白文本得 []
//   · fit：逐 2px 缩字号直到行数达标；循环耗尽时返回最后实际测量的字号
//     （原 quirk「多减一次」已修复，见模块头注释）
//   · composeText / srcLink：原文链接口径（src 优先、url 兜底）与三段正文
//
// seam 与 browser-data.test.js 同款：预设最小 window 后顶层 import。
// fake measure 用「半em 等宽」模型：每字符宽 = 字号 × 0.5，字号从 fontCss 解析。
// ---------------------------------------------------------------------------

globalThis.window = {}
await import('../assets/poster-layout.js')
const PosterLayout = globalThis.window.PosterLayout

// 等宽测量：每字符 10px（wrap 用，不需要字号）
const w10 = (t) => t.length * 10

// 半 em 等宽测量：字号经 fontCss 传入（fit 用）
function halfEm(text, fontCss) {
  const size = fontCss ? Number(/([\d.]+)px/.exec(fontCss)[1]) : 10
  return text.length * size * 0.5
}

test('tokenize：英文按词、CJK 与全角标点按单字、空白各自成 token', () => {
  assert.deepEqual(PosterLayout.tokenize('hello 世界'), ['hello', ' ', '世', '界'])
  assert.deepEqual(PosterLayout.tokenize('ab中cd'), ['ab', '中', 'cd'])
  assert.deepEqual(PosterLayout.tokenize('，。'), ['，', '。'])
  assert.deepEqual(PosterLayout.tokenize(''), [])
})

test('wrap：按 maxWidth 断行，行尾空格修剪', () => {
  // 字宽 10：「你好 世」40 恰好放下，「界」溢出换行
  assert.deepEqual(PosterLayout.wrap(w10, '你好 世界 abc', 40), ['你好 世', '界', 'abc'])
})

test('wrap：断行点落在空格 token 上时，新行不吃前导空格', () => {
  assert.deepEqual(PosterLayout.wrap(w10, 'abcd ef', 40), ['abcd', 'ef'])
})

test('wrap：纯空白与空文本都得空行数组', () => {
  assert.deepEqual(PosterLayout.wrap(w10, '   ', 40), [])
  assert.deepEqual(PosterLayout.wrap(w10, '', 40), [])
})

test('fit：逐 2px 缩字号直到行数达标', () => {
  // 20 个 CJK 字、maxWidth 100：字号 s 时每行 floor(200/s) 字
  // 62→3 字/行→7 行 … 22→9 字/行→3 行；20→10 字/行→2 行，达标
  const r = PosterLayout.fit(halfEm, '一'.repeat(20), 100, {
    maxLines: 2, startSize: 62, minSize: 20, weight: '400', family: 'F', lineRatio: 1.42,
  })
  assert.deepEqual(r, {
    lines: ['一'.repeat(10), '一'.repeat(10)],
    size: 20,
    lineHeight: 28,
  })
})

test('fit：短文本不需要缩字号，startSize 原样返回；lineRatio 缺省 1.42', () => {
  const r = PosterLayout.fit(halfEm, '短', 100, {
    maxLines: 4, startSize: 62, minSize: 36, weight: '400', family: 'F',
  })
  assert.deepEqual(r, { lines: ['短'], size: 62, lineHeight: Math.round(62 * 1.42) })
})

test('fit：循环耗尽时返回最后实际测量的字号，lines 按它截断', () => {
  // 与上一例同参数但 minSize=22：循环在 22 仍超行（3 行），size 减到 20 后退出——
  // lines 是按 22px 量的（9 字/行），返回的 size 也必须是 22（quirk 已修复：
  // 原先返回多减一次的 20，drawPoster 会拿 20px 去画按 22px 排的版）。
  const r = PosterLayout.fit(halfEm, '一'.repeat(20), 100, {
    maxLines: 2, startSize: 62, minSize: 22, weight: '400', family: 'F', lineRatio: 1.42,
  })
  assert.equal(r.size, 22, '最后实际测量的字号，不低于 minSize')
  assert.equal(r.lines.length, 2)
  assert.equal(r.lines[0], '一'.repeat(9), '按 22px 断行：9 字/行')
  // 末行逐字回退到能放下省略号：9 字+… 在 22px 下是 110>100，退到 8 字+…（99≤100）
  assert.equal(r.lines[1], '一'.repeat(8) + '…')
  assert.equal(r.lineHeight, Math.round(22 * 1.42))
})

test('composeText：标题/概览/原文链接三段；src 优先、url 兜底', () => {
  assert.equal(
    PosterLayout.composeText({ title: 'T', overview: 'O', src: 'https://a', url: 'https://b' }),
    'T\nO\n原文链接：https://a',
  )
  assert.equal(
    PosterLayout.composeText({ title: 'T', overview: 'O', src: '', url: 'https://b' }),
    'T\nO\n本页链接：https://b',
  )
  assert.equal(
    PosterLayout.composeText({ title: '', overview: 'O', src: 'https://a', url: 'u' }),
    'O\n原文链接：https://a',
    '空标题不占行',
  )
})

test('srcLink：原文地址优先，缺失退回本页链接', () => {
  assert.equal(PosterLayout.srcLink({ src: 's', url: 'u' }), 's')
  assert.equal(PosterLayout.srcLink({ src: '', url: 'u' }), 'u')
})

// ---------------------------------------------------------------------------
// posterSpec：整版版面决策（GLOSSARY: 海报排版）。期望值按常量手算：
// W=1080 H=1350 PAD=104，红带高 340（y=1010 起到下缘满版），
// 白卡 300×300（x=676,y=1030），码区 240×240（x=706,y=1060，白卡内缩 30）。
// 内容区 y∈[290, 962] 垂直居中；标题 72→40px serif、概览 32→22px sans。
// ---------------------------------------------------------------------------

const DATA = {
  no: '042', title: '一'.repeat(20), summary: '一'.repeat(40),
  date: '2026-10-21', by: '甲', url: 'https://research-share.app.workbuddy.host/item/42',
  src: 'https://example.com/original',
}

test('posterSpec：刊头是编号 + 域名（域名取 data.url 的 host）', () => {
  const spec = PosterLayout.posterSpec(halfEm, DATA)
  assert.equal(spec.masthead.no, 'NO.042')
  assert.equal(spec.masthead.host, 'research-share.app.workbuddy.host')
  assert.equal(spec.masthead.y, 168)
  assert.equal(spec.masthead.size, 26)
  assert.equal(spec.pad, 104, '页边距显式导出，调用方不反推')
  assert.deepEqual(spec.rule, { x: 104, y: 200, w: 108, h: 5 })
})

test('posterSpec：红带满版出血，二维码白卡居右、码区内缩', () => {
  const spec = PosterLayout.posterSpec(halfEm, DATA)
  assert.deepEqual(spec.band, { x: 0, y: 1010, w: 1080, h: 340 })
  assert.deepEqual(spec.qrCard, { x: 676, y: 1030, size: 300 })
  assert.deepEqual(spec.qr, { x: 706, y: 1060, size: 240 })
})

test('posterSpec：红带左侧三行——部门标签胶囊 / 日期·作者 / 长按识别', () => {
  const spec = PosterLayout.posterSpec(halfEm, DATA)
  // 部门标签：站点级署名常量「研发中心」，胶囊几何由文案宽度派生
  // halfEm：4 字 × 22px × 0.5 = 44，加左右内边距 18×2 → w=80
  assert.equal(spec.dept.text, '研发中心')
  assert.equal(spec.dept.size, 22)
  assert.deepEqual(
    { x: spec.dept.x, y: spec.dept.y, w: spec.dept.w, h: spec.dept.h },
    { x: 104, y: 1010 + 56, w: 80, h: 44 },
  )
  assert.equal(spec.meta.text, '2026-10-21  ·  甲')
  assert.equal(spec.meta.x, 104)
  assert.equal(spec.meta.y, 1010 + 176)
  assert.equal(spec.meta.size, 30)
  assert.equal(spec.qrHint.text, '长按识别 · 阅读原文')
  assert.equal(spec.qrHint.x, 104)
  assert.equal(spec.qrHint.y, 1010 + 231)
  assert.equal(spec.qrHint.size, 26)
})

test('posterSpec：标题与概览居中于内容区，不侵入红带', () => {
  const spec = PosterLayout.posterSpec(halfEm, DATA)
  // halfEm：标题 20 字在 72px 下每行 floor(872/36)=24 字 → 1 行，不缩字号
  assert.equal(spec.title.size, 72)
  assert.deepEqual(spec.title.lines, ['一'.repeat(20)])
  assert.equal(spec.title.lineHeight, Math.round(72 * 1.38))
  // 概览 40 字在 32px 下每行 floor(872/16)=54 字 → 1 行
  assert.equal(spec.summary.size, 32)
  assert.deepEqual(spec.summary.lines, ['一'.repeat(40)])
  // 垂直居中：totalH = 99+56+2+36+55 = 248，y0 = 290 + (672-248)/2 = 502
  assert.equal(spec.title.y, 502)
  assert.equal(spec.divider.y, 502 + 99 + 56)
  assert.equal(spec.summary.y, 502 + 99 + 56 + 2 + 36)
  const summaryBottom = spec.summary.y + spec.summary.lineHeight
  assert.ok(summaryBottom <= 962, '内容区下缘不越过红带')
})

test('posterSpec：src 走 srcLink 口径（src 优先、url 兜底）', () => {
  assert.equal(PosterLayout.posterSpec(halfEm, DATA).src, 'https://example.com/original')
  const docType = Object.assign({}, DATA, { src: '' })
  assert.equal(PosterLayout.posterSpec(halfEm, docType).src, DATA.url)
})
