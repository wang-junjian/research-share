import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHandler } from '../server.js'
import { createItemsStore } from '../lib/items-store.js'
import { createAgentApi } from '../lib/agent-api.js'

// 最小可控 fake cloud：rows 可随时替换，模拟「另一个写入者」
// （admin 前端经浏览器 SDK 直连数据库，绕过本进程缓存）
function fakeCloud(rows) {
  const state = { rows }
  const builder = {
    filters: [],
    select() { return builder },
    order() { return builder },
    eq(col, val) { builder.filters.push([col, val]); return builder },
    then(resolve) {
      const data = state.rows.filter((r) => builder.filters.every(([c, v]) => r[c] === v))
      return resolve({ data, error: null })
    },
  }
  return { state, database: { from: () => builder, rpc: async () => ({ data: null, error: null }) } }
}

const RAW = {
  id: 7,
  title: '深夜写入的成果',
  summary: '概览',
  url: 'https://a.com',
  item_date: '2026-10-18',
  owner_name: null,
  source_key: null,
  source_agent: null,
  created_at: 'c',
  updated_at: 'u',
}

const site = { name: '研究成果', desc: 'd', url: 'https://x.com', favicon: 'data:image/svg+xml,x' }

async function withServer(rows, fn, { trackServerPageView = () => {} } = {}) {
  const cloud = fakeCloud(rows)
  const itemsStore = createItemsStore({ cloud, siteUrl: site.url })
  const { handleApi } = createAgentApi({ cloud, site, itemsStore })
  const handler = createHandler({
    site,
    itemsStore,
    trackServerPageView,
    handleTrack: (req, res) => {
      res.writeHead(204)
      res.end()
    },
    handleApi,
    getAdminHtml: async () => '<html>admin</html>',
    tryServeStatic: async () => false,
  })
  const server = http.createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await fn(base, cloud)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('后台直连数据库写入后，首访 /item/:id 不再 404', async () => {
  await withServer([], async (base, cloud) => {
    // 先访问列表，建立空缓存
    const list = await fetch(`${base}/`)
    assert.equal(list.status, 200)

    cloud.state.rows = [RAW] // 另一个写入者插入，本进程缓存已陈旧
    const res = await fetch(`${base}/item/7`)
    assert.equal(res.status, 200)
    assert.match(await res.text(), /深夜写入的成果/)
  })
})

test('同场景下 /og/:id.png 也能出图（两条路由的重查语义一致）', async () => {
  await withServer([], async (base, cloud) => {
    await fetch(`${base}/`)
    cloud.state.rows = [RAW]
    const res = await fetch(`${base}/og/7.png`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
  })
})

test('POST /api/track 由路由层直接分派给 track module（永远 204）', async () => {
  await withServer([], async (base) => {
    const res = await fetch(`${base}/api/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [] }),
    })
    assert.equal(res.status, 204)
  })
})

test('GET /api/items 经真实 agent-api + items-store 返回物化字段', async () => {
  await withServer([RAW], async (base) => {
    const res = await fetch(`${base}/api/items`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.items[0].no, 'NO.007')
    assert.equal(body.items[0].page_url, 'https://x.com/item/7')
  })
})

// ---- 文档型成果（GLOSSARY: 文档型成果 / 托管地址；隔离决策 docs/adr/0004） ----

const DOC_HTML =
  '<!DOCTYPE html><html><head><title>季度数据报告</title></head>' +
  '<body><h1>DOC-MARKER-报告正文</h1><script>console.log(1)</script></body></html>'

const RAW_DOC = {
  id: 9,
  title: '季度数据报告',
  summary: '概览',
  url: null,
  kind: 'doc',
  doc_html: DOC_HTML,
  item_date: '2026-10-18',
  owner_name: null,
  source_key: null,
  source_agent: null,
  created_at: 'c',
  updated_at: 'u',
}

test('GET /item/:id/doc 直出文档原文，携带 CSP sandbox 与 nosniff 响应头', async () => {
  await withServer([RAW_DOC], async (base) => {
    const res = await fetch(`${base}/item/9/doc`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(res.headers.get('content-security-policy'), 'sandbox allow-scripts')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(await res.text(), DOC_HTML)
  })
})

test('GET /item/:id/doc 对链接型成果与不存在的 id 均 404', async () => {
  await withServer([RAW, RAW_DOC], async (base) => {
    assert.equal((await fetch(`${base}/item/7/doc`)).status, 404)
    assert.equal((await fetch(`${base}/item/999/doc`)).status, 404)
  })
})

test('埋点口径：托管地址不产生 page_view，详情页恰为一次', async () => {
  let pageViews = 0
  await withServer([RAW_DOC], async (base) => {
    assert.equal((await fetch(`${base}/item/9/doc`)).status, 200)
    assert.equal(pageViews, 0)
    assert.equal((await fetch(`${base}/item/9`)).status, 200)
    assert.equal(pageViews, 1)
  }, { trackServerPageView: () => { pageViews++ } })
})

test('详情页·文档型：sandbox iframe 指向托管地址，含全屏入口，文档内容不内联', async () => {
  await withServer([RAW_DOC], async (base) => {
    const res = await fetch(`${base}/item/9`)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.match(html, /<iframe[^>]*sandbox="allow-scripts"/)
    assert.match(html, /<iframe[^>]*src="https:\/\/x\.com\/item\/9\/doc"/)
    assert.match(html, /全屏阅读/)
    assert.match(html, /href="https:\/\/x\.com\/item\/9\/doc"/)
    assert.ok(!html.includes('DOC-MARKER-报告正文'))
    // 标元区不变
    assert.match(html, /季度数据报告/)
  })
})

test('详情页·链接型回归：无 iframe，保留「查看原文」', async () => {
  await withServer([RAW], async (base) => {
    const html = await (await fetch(`${base}/item/7`)).text()
    assert.ok(!html.includes('<iframe'))
    assert.match(html, /查看原文 ↗/)
    assert.match(html, /href="https:\/\/a\.com"/)
  })
})

test('列表页 HTML 不出现文档内容（doc_html 不进列表查询的行为表达）', async () => {
  await withServer([RAW, RAW_DOC], async (base) => {
    const html = await (await fetch(`${base}/`)).text()
    assert.match(html, /季度数据报告/) // 标题照常进卡片
    assert.ok(!html.includes('DOC-MARKER-报告正文'))
  })
})
