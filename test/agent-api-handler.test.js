import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createAgentApi } from '../lib/agent-api.js'
import { sendJson } from '../lib/http.js'

// ---------------------------------------------------------------------------
// createAgentApi 的 interface 测试：handleApi 的读/写路径。
// 纯函数（extractToken / pickText / pickDate / apiShape）在 test/agent-api.test.js；
// 这里锁的是接缝处的组合行为：token 三通道 → rpc → 错误映射 → 响应，
// 以及「写成功后必须 invalidate」（见 docs/adr/0001）。
// 此前这些只在 scripts/smoke.sh（需真实后端 + token）里被覆盖。
// ---------------------------------------------------------------------------

// fake cloud：按 rpc 函数名返回预置 {data, error}，调用全部记录
function fakeCloud(responses = {}) {
  const calls = []
  return {
    calls,
    database: {
      rpc: async (fn, args) => {
        calls.push({ fn, args })
        return responses[fn] || { data: {}, error: null }
      },
    },
  }
}

// itemsStore 三方法 stub：invalidate 计数，find 返回物化 item
const ITEM = {
  id: 7,
  no: 'NO.007',
  title: 'T',
  summary: 'S',
  url: 'https://a.com',
  date: '2026-10-18',
  owner_name: '军舰',
  source_key: 'k',
  source_agent: null,
  created_at: 'c',
  updated_at: 'u',
  page_url: 'https://x.com/item/7',
  og_image: 'https://x.com/og/7.png',
}

function stubStore() {
  const state = { invalidated: 0 }
  return {
    state,
    store: {
      list: async () => [ITEM],
      find: async (id) => (id === ITEM.id ? ITEM : null),
      invalidate: () => {
        state.invalidated++
      },
    },
  }
}

const TOKEN = 'test-token-1234567'
const site = { name: '研究成果', url: 'https://x.com' }

async function withApi(responses, fn) {
  const cloud = fakeCloud(responses)
  const stub = stubStore()
  const { handleApi } = createAgentApi({ cloud, site, itemsStore: stub.store })
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://localhost')
    try {
      await handleApi(req, res, reqUrl.pathname, reqUrl)
    } catch (err) {
      // 与 server.js 的错误边界同一条 seam：自己抛的 4xx 原样返回
      if (err && err.expose) {
        return sendJson(res, err.status || 400, { ok: false, error: err.code, message: err.message })
      }
      throw err
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await fn(base, cloud, stub)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

const auth = { authorization: `Bearer ${TOKEN}` }
const VALID = { title: '标题', summary: '概览', url: 'https://a.com' }

test('写路径缺 token → 401 missing_token（三道通道都没有）', async () => {
  await withApi({}, async (base, cloud) => {
    const res = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID),
    })
    assert.equal(res.status, 401)
    assert.equal((await res.json()).error, 'missing_token')
    assert.equal(cloud.calls.length, 0) // 没到 rpc 就被拦下
  })
})

test('token 三道通道等价：Bearer / X-Agent-Token / ?token=', async () => {
  await withApi({ agent_delete_item: { data: { title: 'T' }, error: null } }, async (base, cloud) => {
    for (const init of [
      [`${base}/api/items/7`, { method: 'DELETE', headers: auth }],
      [`${base}/api/items/7`, { method: 'DELETE', headers: { 'x-agent-token': TOKEN } }],
      [`${base}/api/items/7?token=${TOKEN}`, { method: 'DELETE' }],
    ]) {
      const res = await fetch(...init)
      assert.equal(res.status, 200)
    }
    assert.equal(cloud.calls.length, 3)
    assert.ok(cloud.calls.every((c) => c.args.p_token === TOKEN))
  })
})

test('POST 缺必填字段：pickText 抛出的 httpError 经错误边界变 400，rpc 未被调用', async () => {
  await withApi({}, async (base, cloud) => {
    const res = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ summary: 'S', url: 'https://a.com' }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error, 'missing_field')
    assert.match(body.message, /title/)
    assert.equal(cloud.calls.length, 0)
  })
})

test('rpc 错误映射：missing_field/invalid_token/item_not_found → 400/401/404 + 中文消息', async () => {
  const responses = {
    agent_upsert_item: { data: null, error: new Error('missing_field: title') },
    agent_patch_item: { data: null, error: new Error('invalid_token') },
    agent_delete_item: { data: null, error: new Error('item_not_found: 7') },
  }
  await withApi(responses, async (base, cloud, stub) => {
    const post = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(VALID),
    })
    assert.equal(post.status, 400)
    assert.match((await post.json()).message, /缺少必填字段（title）/)

    const patch = await fetch(`${base}/api/items/7`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ title: 'X' }),
    })
    assert.equal(patch.status, 401)
    assert.equal((await patch.json()).error, 'invalid_token')

    const del = await fetch(`${base}/api/items/7`, { method: 'DELETE', headers: auth })
    assert.equal(del.status, 404)

    assert.equal(stub.state.invalidated, 0) // 失败路径不得 invalidate
  })
})

test('rpc 未知错误 → 502 database_error，不伪装成 4xx', async () => {
  await withApi(
    { agent_upsert_item: { data: null, error: new Error('connection reset by peer') } },
    async (base) => {
      const res = await fetch(`${base}/api/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(VALID),
      })
      assert.equal(res.status, 502)
      assert.equal((await res.json()).error, 'database_error')
    },
  )
})

test('POST 成功：201 created、invalidate 被调、响应携带 apiShape 物化字段', async () => {
  await withApi(
    { agent_upsert_item: { data: { action: 'created', id: 7 }, error: null } },
    async (base, cloud, stub) => {
      const res = await fetch(`${base}/api/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(VALID),
      })
      assert.equal(res.status, 201)
      const body = await res.json()
      assert.equal(body.action, 'created')
      assert.equal(body.item.no, 'NO.007')
      assert.equal(body.item.owner, '军舰') // owner_name → owner 重命名
      assert.equal(stub.state.invalidated, 1)
      // 字段经 pickText 后才进 rpc
      assert.equal(cloud.calls[0].args.p_title, '标题')
    },
  )
})

test('batch：501 条 → 400、空数组 → 400；合法批次原子提交后 invalidate', async () => {
  await withApi(
    { agent_upsert_items: { data: { created: 2, updated: 0, total: 2, items: [] }, error: null } },
    async (base, cloud, stub) => {
      const tooMany = await fetch(`${base}/api/items/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ items: Array.from({ length: 501 }, () => VALID) }),
      })
      assert.equal(tooMany.status, 400)
      assert.match((await tooMany.json()).message, /500/)

      const empty = await fetch(`${base}/api/items/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ items: [] }),
      })
      assert.equal(empty.status, 400)

      const ok = await fetch(`${base}/api/items/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ items: [VALID, VALID] }),
      })
      assert.equal(ok.status, 200)
      assert.equal((await ok.json()).created, 2)
      assert.equal(cloud.calls.length, 1) // 前两次没到 rpc
      assert.equal(stub.state.invalidated, 1)
    },
  )
})

test('PATCH/DELETE 成功后 invalidate；PATCH 部分字段时其余传 null', async () => {
  await withApi(
    { agent_patch_item: { data: null, error: null }, agent_delete_item: { data: { title: 'T' }, error: null } },
    async (base, cloud, stub) => {
      const patch = await fetch(`${base}/api/items/7`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ title: '新标题' }),
      })
      assert.equal(patch.status, 200)
      const patchArgs = cloud.calls[0].args
      assert.equal(patchArgs.p_title, '新标题')
      assert.equal(patchArgs.p_summary, null) // 未给出的字段传 null

      const del = await fetch(`${base}/api/items/7`, { method: 'DELETE', headers: auth })
      assert.equal(del.status, 200)
      assert.equal((await del.json()).action, 'deleted')
      assert.equal(stub.state.invalidated, 2)
    },
  )
})

test('读路径保持公开：GET /api/items 无需 token；不存在的方法组合 → 405', async () => {
  await withApi({}, async (base) => {
    const list = await fetch(`${base}/api/items`)
    assert.equal(list.status, 200)
    assert.equal((await list.json()).items[0].no, 'NO.007')

    const put = await fetch(`${base}/api/items`, { method: 'PUT' })
    assert.equal(put.status, 405)
  })
})

// ---- 文档型成果写入契约（GLOSSARY: 文档型成果 / 托管地址；内容不可变 docs/adr/0004） ----

const DOC = '<!DOCTYPE html><html><body><h1>DOC-MARKER</h1></body></html>'
const post = (base, payload) =>
  fetch(`${base}/api/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(payload),
  })

test('POST 携带 doc_html → 文档型：p_doc_html 透传 rpc、p_url 置空、201', async () => {
  await withApi(
    { agent_upsert_item: { data: { action: 'created', id: 7 }, error: null } },
    async (base, cloud) => {
      const res = await post(base, { title: 'T', summary: 'S', doc_html: DOC, source_key: 'k' })
      assert.equal(res.status, 201)
      assert.equal(cloud.calls.length, 1)
      const args = cloud.calls[0].args
      assert.equal(args.p_doc_html, DOC)
      assert.equal(args.p_url, null) // 文档型没有站外原文链接，url 不落库
    },
  )
})

test('POST 文档型与 url 并存 → 400 invalid_field，rpc 未被调用', async () => {
  await withApi({}, async (base, cloud) => {
    const res = await post(base, { title: 'T', summary: 'S', doc_html: DOC, url: 'https://a.com' })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'invalid_field')
    assert.equal(cloud.calls.length, 0)
  })
})

test('链接型契约不变：不携带 doc_html 时 url 依旧必填', async () => {
  await withApi({}, async (base, cloud) => {
    const res = await post(base, { title: 'T', summary: 'S' })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error, 'missing_field')
    assert.match(body.message, /url/)
    assert.equal(cloud.calls.length, 0)
  })
})

test('doc_html 超 1MB 字符 → 400 field_too_long；恰 1MB 字符放行到 rpc（请求体上限已放宽）', async () => {
  await withApi(
    { agent_upsert_item: { data: { action: 'created', id: 7 }, error: null } },
    async (base, cloud) => {
      const tooLong = await post(base, { title: 'T', summary: 'S', doc_html: 'x'.repeat(1_000_001) })
      assert.equal(tooLong.status, 400)
      assert.equal((await tooLong.json()).error, 'field_too_long')
      assert.equal(cloud.calls.length, 0)

      // 恰 1MB 字符（约 1.05MB 请求体）：旧的 512KB 上限会 413，放宽后应直达 rpc
      const exact = await post(base, { title: 'T', summary: 'S', doc_html: 'x'.repeat(1_000_000) })
      assert.equal(exact.status, 201)
      assert.equal(cloud.calls.length, 1)
      assert.equal(cloud.calls[0].args.p_doc_html.length, 1_000_000)
    },
  )
})

test('请求体超 2MB → 413 payload_too_large', async () => {
  await withApi({}, async (base, cloud) => {
    const res = await post(base, { title: 'T', summary: 'S', doc_html: 'x'.repeat(2 * 1024 * 1024) })
    assert.equal(res.status, 413)
    assert.equal((await res.json()).error, 'payload_too_large')
    assert.equal(cloud.calls.length, 0)
  })
})

test('batch 支持文档型：doc_html 透传且 url 置空；批内文档型与 url 并存 → 400 整批不进 rpc', async () => {
  await withApi(
    { agent_upsert_items: { data: { created: 2, updated: 0, total: 2, items: [] }, error: null } },
    async (base, cloud) => {
      const ok = await fetch(`${base}/api/items/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ items: [VALID, { title: 'D', summary: 'S', doc_html: DOC }] }),
      })
      assert.equal(ok.status, 200)
      const items = cloud.calls[0].args.p_items
      assert.equal(items[0].doc_html, null) // 链接型不带 doc_html
      assert.equal(items[0].url, 'https://a.com')
      assert.equal(items[1].doc_html, DOC)
      assert.equal(items[1].url, null)

      const bad = await fetch(`${base}/api/items/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ items: [{ title: 'D', summary: 'S', doc_html: DOC, url: 'https://a.com' }] }),
      })
      assert.equal(bad.status, 400)
      assert.equal(cloud.calls.length, 1) // 整批被拦下
    },
  )
})

test('PATCH 只要携带 doc_html 键即拒：空串与 null 同样 → 400 immutable_field，rpc 未被调用', async () => {
  await withApi({}, async (base, cloud) => {
    for (const payload of [{ doc_html: '' }, { doc_html: null }]) {
      const res = await fetch(`${base}/api/items/7`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(payload),
      })
      assert.equal(res.status, 400)
      assert.equal((await res.json()).error, 'immutable_field')
    }
    assert.equal(cloud.calls.length, 0)
  })
})

test('PATCH 携带 doc_html → 400（文档内容不可变），rpc 未被调用；改标元不受影响', async () => {
  await withApi({ agent_patch_item: { data: null, error: null } }, async (base, cloud) => {
    const res = await fetch(`${base}/api/items/7`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ doc_html: DOC }),
    })
    assert.equal(res.status, 400)
    assert.equal(cloud.calls.length, 0)

    const meta = await fetch(`${base}/api/items/7`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ summary: '只改摘要' }),
    })
    assert.equal(meta.status, 200)
    assert.equal(cloud.calls.length, 1)
  })
})
