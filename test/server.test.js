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
    select() { return builder },
    order() { return builder },
    then(resolve) { return resolve({ data: state.rows, error: null }) },
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

async function withServer(rows, fn) {
  const cloud = fakeCloud(rows)
  const itemsStore = createItemsStore({ cloud, siteUrl: site.url })
  const { handleApi } = createAgentApi({ cloud, site, itemsStore })
  const handler = createHandler({
    site,
    itemsStore,
    trackServerPageView: () => {},
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
