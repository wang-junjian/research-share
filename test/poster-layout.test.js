import test from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// 海报排版（GLOSSARY: 海报排版）的 interface 表征测试。
//
// 期望值钉住的是抽出前 assets/share.js 的对外行为（票 #12 零行为变化重构）：
//   · tokenize：英文按词、CJK 与全角标点按单字、空白各自成 token
//   · wrap：按 maxWidth 断行、行首空格跳过、行尾空格修剪、空白文本得 []
//   · fit：逐 2px 缩字号直到行数达标；循环耗尽时的现状（返回 size 低于
//     minSize、lines 按最后测量字号截断）原样钉住——修复另起 commit 评审
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

test('fit（钉住的现状）：循环耗尽时返回 size 低于 minSize，lines 按最后测量字号截断', () => {
  // 与上一例同参数但 minSize=22：循环在 22 仍超行（3 行），size 减到 20 后退出——
  // lines 是按 22px 量的（9 字/行），返回的 size 却是 20。
  // 这是抽出前就有的口径（drawPoster 会拿 20px 去画按 22px 排的版），
  // 本次重构原样钉住，是否修复另起 commit 评审。
  const r = PosterLayout.fit(halfEm, '一'.repeat(20), 100, {
    maxLines: 2, startSize: 62, minSize: 22, weight: '400', family: 'F', lineRatio: 1.42,
  })
  assert.equal(r.size, 20, '低于 minSize=22：现状如此')
  assert.equal(r.lines.length, 2)
  assert.equal(r.lines[0], '一'.repeat(9), '按 22px 断行：9 字/行')
  // 末行逐字回退到能放下省略号：9 字+… 在 22px 下是 110>100，退到 8 字+…（99≤100）
  assert.equal(r.lines[1], '一'.repeat(8) + '…')
  assert.equal(r.lineHeight, 28)
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
