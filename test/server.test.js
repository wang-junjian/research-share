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
  return {
    state,
    database: {
      // from() 返回同一个 builder，每次调用先清掉上一条链残留的 eq 过滤
      from: () => {
        builder.filters = []
        return builder
      },
      // 仿真 db/06 升级后写函数的库内语义，让全栈缝测试能断言外部行为；
      // 仿真只覆盖测试用到的三个写函数，真实 SQL 行为由 scripts/smoke.sh 对云验证
      rpc: async (fn, args) => {
        if (fn === 'agent_upsert_item') return { data: upsertRow(state, args), error: null }
        if (fn === 'agent_upsert_items') {
          let created = 0
          let updated = 0
          const items = []
          for (const it of args.p_items) {
            const r = upsertRow(state, {
              p_title: it.title, p_summary: it.summary, p_url: it.url,
              p_date: it.date, p_source_key: it.source_key, p_doc_html: it.doc_html,
            })
            if (r.action === 'created') created++; else updated++
            items.push(r)
          }
          return { data: { created, updated, total: created + updated, items }, error: null }
        }
        if (fn === 'agent_patch_item') {
          const row = state.rows.find((r) => r.id === args.p_id)
          if (!row) return { data: null, error: new Error(`item_not_found: ${args.p_id}`) }
          if (args.p_title) row.title = args.p_title
          if (args.p_summary) row.summary = args.p_summary
          if (args.p_url) row.url = args.p_url
          if (args.p_date) row.item_date = args.p_date
          row.updated_at = 'u2'
          return { data: { action: 'updated', id: row.id }, error: null }
        }
        return { data: null, error: null }
      },
    },
  }
}

// agent_upsert_item 语义仿真：携带 doc_html 即文档型（url 置空）；按 source_key 判
// 存在，重投只更新标元（链接型含 url），文档型永不覆盖 doc_html（docs/adr/0004）
function upsertRow(state, a) {
  const isDoc = !!a.p_doc_html
  const key = a.p_source_key || null
  let row = key ? state.rows.find((r) => r.source_key === key) : null
  if (!row) {
    const id = Math.max(0, ...state.rows.map((r) => r.id)) + 1
    row = {
      id,
      title: a.p_title,
      summary: a.p_summary,
      url: isDoc ? null : a.p_url,
      kind: isDoc ? 'doc' : 'link',
      doc_html: isDoc ? a.p_doc_html : null,
      item_date: a.p_date || '2026-10-19',
      owner_name: '军舰',
      source_key: key,
      source_agent: 'main-agent',
      created_at: 'c',
      updated_at: 'u',
    }
    state.rows = [...state.rows, row]
    return { action: 'created', id }
  }
  row.title = a.p_title
  row.summary = a.p_summary
  if (a.p_date) row.item_date = a.p_date
  if (!isDoc && row.kind !== 'doc') row.url = a.p_url
  row.updated_at = 'u2'
  return { action: 'updated', id: row.id }
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

// ---- Agent API 文档型写入契约（ticket #5；全栈缝：真 handler + 真 items-store） ----
// fake cloud 的 rpc 仿真 db/06 升级后 agent_upsert_item 的库内语义（按 source_key
// 判存在；重投只更新标元、文档型永不覆盖 doc_html），真实 SQL 行为由 scripts/smoke.sh
// 对真实云验证。

const AGENT_TOKEN = 'test-token-1234567'
const agentPost = (base, payload, path = '/api/items') =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': AGENT_TOKEN },
    body: JSON.stringify(payload),
  })

const SMOKE_DOC_A =
  '<!DOCTYPE html><html><body><h1>API-DOC-MARKER-A 首版</h1><script>console.log(1)</script></body></html>'
const SMOKE_DOC_B = '<!DOCTYPE html><html><body><h1>API-DOC-MARKER-B 覆盖版</h1></body></html>'

test('POST 携带 doc_html → 201，响应 url 为派生托管地址，且该地址可读回相同文档', async () => {
  await withServer([], async (base) => {
    const res = await agentPost(base, {
      title: 'API 写入的文档',
      summary: '概览',
      doc_html: SMOKE_DOC_A,
      source_key: 'api-doc:1',
    })
    assert.equal(res.status, 201)
    const body = await res.json()
    assert.equal(body.action, 'created')
    const hosted = `https://x.com/item/${body.id}/doc`
    assert.equal(body.item.url, hosted)

    const doc = await fetch(`${base}/item/${body.id}/doc`)
    assert.equal(doc.status, 200)
    assert.equal(doc.headers.get('content-security-policy'), 'sandbox allow-scripts')
    assert.equal(await doc.text(), SMOKE_DOC_A)
  })
})

test('同 source_key 重投不同 doc_html：标元更新、id 不变，托管页内容保持首次写入', async () => {
  await withServer([], async (base) => {
    const first = await (await agentPost(base, {
      title: '文档标题',
      summary: '概览',
      doc_html: SMOKE_DOC_A,
      source_key: 'api-doc:idem',
    })).json()

    const repost = await agentPost(base, {
      title: '文档标题（改）',
      summary: '概览（改）',
      doc_html: SMOKE_DOC_B,
      source_key: 'api-doc:idem',
    })
    assert.equal(repost.status, 200)
    const again = await repost.json()
    assert.equal(again.action, 'updated')
    assert.equal(again.id, first.id)
    assert.equal(again.item.title, '文档标题（改）') // 标元随重投更新

    const doc = await fetch(`${base}/item/${first.id}/doc`)
    assert.equal(await doc.text(), SMOKE_DOC_A) // 内容不可变：永不覆盖 doc_html

    // PATCH 改标元同样不动文档内容
    const patch = await fetch(`${base}/api/items/${first.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Token': AGENT_TOKEN },
      body: JSON.stringify({ summary: 'PATCH 改的摘要' }),
    })
    assert.equal(patch.status, 200)
    assert.equal(await (await fetch(`${base}/item/${first.id}/doc`)).text(), SMOKE_DOC_A)
  })
})

test('链接型 POST 契约不变；batch 端点同样支持文档型', async () => {
  await withServer([], async (base) => {
    const link = await agentPost(base, { title: '链接', summary: '概览', url: 'https://a.com/x' })
    assert.equal(link.status, 201)
    assert.equal((await link.json()).item.url, 'https://a.com/x')

    const batch = await agentPost(base, {
      items: [
        { title: '批内文档', summary: '概览', doc_html: SMOKE_DOC_A, source_key: 'api-doc:batch' },
        { title: '批内链接', summary: '概览', url: 'https://a.com/y', source_key: 'api-link:batch' },
      ],
    }, '/api/items/batch')
    assert.equal(batch.status, 200)
    assert.equal((await batch.json()).created, 2)

    const list = await (await fetch(`${base}/api/items`)).json()
    const docItem = list.items.find((i) => i.source_key === 'api-doc:batch')
    assert.equal(docItem.url, `https://x.com/item/${docItem.id}/doc`)
    const doc = await fetch(`${base}/item/${docItem.id}/doc`)
    assert.equal(await doc.text(), SMOKE_DOC_A)
    const linkItem = list.items.find((i) => i.source_key === 'api-link:batch')
    assert.equal(linkItem.url, 'https://a.com/y')
  })
})
