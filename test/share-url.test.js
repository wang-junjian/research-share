// 分享码（GLOSSARY: 分享码）：平台发布域名前的防爬闸门只认 ?sharecode=<码>，
// 干净域名对外一律 403。这一组测试钉住「对外地址必须带码」这条口径 ——
// 它一旦静默退化成干净地址，站内自己点得开（本地已种 cookie），
// 但每一个被复制出去、印成二维码的链接对别人都是拦截页。
import test from 'node:test'
import assert from 'node:assert/strict'
import { withShare, shareUrlOf } from '../lib/share-url.js'
import { renderList, renderDetail } from '../lib/render.js'
import { createItemsStore } from '../lib/items-store.js'
import { createDemoCloud } from '../lib/demo-cloud.js'

const site = { name: '研究成果', desc: 'D', url: 'https://example.com', favicon: 'x' }

const item = {
  id: 7,
  title: '一篇成果',
  summary: '概览。',
  url: 'https://src.example.com/a',
  no: 'NO.007',
  no_num: '007',
  date: '2026-10-16',
  page_url: 'https://example.com/item/7?sharecode=ABC123',
  og_image: 'https://example.com/og/7.png?sharecode=ABC123',
}

test('withShare：无码原样返回，有码用 ? 追加，已有 query 用 &', () => {
  assert.equal(withShare('https://e.com/item/1', ''), 'https://e.com/item/1')
  assert.equal(withShare('https://e.com/item/1', null), 'https://e.com/item/1')
  assert.equal(withShare('https://e.com/item/1', 'ABC'), 'https://e.com/item/1?sharecode=ABC')
  assert.equal(withShare('https://e.com/a?x=1', 'ABC'), 'https://e.com/a?x=1&sharecode=ABC')
  // 码里若有非常规字符必须转义，不能把后面的参数截断
  assert.equal(withShare('https://e.com/', 'a b&c'), 'https://e.com/?sharecode=a%20b%26c')
  assert.equal(withShare('', 'ABC'), '')
})

test('shareUrlOf：origin 尾斜杠不重复，路径缺省为 /', () => {
  assert.equal(shareUrlOf('https://e.com/', '/item/7', 'ABC'), 'https://e.com/item/7?sharecode=ABC')
  assert.equal(shareUrlOf('https://e.com', '/', 'ABC'), 'https://e.com/?sharecode=ABC')
  assert.equal(shareUrlOf('https://e.com', '/item/7', ''), 'https://e.com/item/7')
})

test('首页 canonical 带码（站点在闸门后面时干净域名是死链）', () => {
  const html = renderList({ ...site, shareCode: 'ABC123' }, [item])
  assert.match(html, /<link rel="canonical" href="https:\/\/example\.com\/\?sharecode=ABC123">/)
  assert.match(html, /<meta property="og:url" content="https:\/\/example\.com\/\?sharecode=ABC123">/)
})

test('首页未配分享码时 canonical 保持干净（本地/别人的 clone）', () => {
  const html = renderList(site, [item])
  assert.match(html, /<link rel="canonical" href="https:\/\/example\.com\/">/)
  assert.doesNotMatch(html, /sharecode/)
})

test('详情页 data-url 与 og:image 来自带码的物化字段，且不做二次转义', () => {
  const html = renderDetail({ ...site, shareCode: 'ABC123' }, item)
  // data-url 是「复制链接」与海报二维码的唯一来源：漏码 = 印出去的二维码扫不开
  assert.match(html, /data-url="https:\/\/example\.com\/item\/7\?sharecode=ABC123"/)
  assert.match(html, /<meta property="og:image" content="https:\/\/example\.com\/og\/7\.png\?sharecode=ABC123">/)
  assert.match(html, /<meta property="og:url" content="https:\/\/example\.com\/item\/7\?sharecode=ABC123">/)
})

// 物化是「对外地址」的唯一出口：三条地址都在这里成型，配上码就都带上。
// 漏掉任何一条，对应那条分享通道就是死的。
test('条目存储物化：page_url / og_image / doc_url 都带码，未配则都不带', async () => {
  const withCode = createItemsStore({ cloud: createDemoCloud(), siteUrl: 'https://e.com', shareCode: 'ABC123' })
  const rows = await withCode.list()
  assert.ok(rows.length > 0, '演示数据应有条目')
  for (const it of rows) {
    assert.match(it.page_url, /^https:\/\/e\.com\/item\/\d+\?sharecode=ABC123$/)
    assert.match(it.og_image, /^https:\/\/e\.com\/og\/\d+\.png\?sharecode=ABC123$/)
    if (it.kind === 'doc') {
      assert.match(it.doc_url, /\?sharecode=ABC123$/)
      // 文档型的原文 url 即托管地址，同样要带码（否则「查看原文」对读者是 403）
      assert.equal(it.url, it.doc_url)
    }
  }

  const plain = createItemsStore({ cloud: createDemoCloud(), siteUrl: 'https://e.com' })
  for (const it of await plain.list()) {
    assert.doesNotMatch(it.page_url, /sharecode/)
    assert.doesNotMatch(it.og_image, /sharecode/)
  }
})
