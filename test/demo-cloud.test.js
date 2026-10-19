import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHandler } from '../server.js'
import { createItemsStore } from '../lib/items-store.js'
import { createAgentApi } from '../lib/agent-api.js'
import { createDemoCloud } from '../lib/demo-cloud.js'

// 演示模式（lib/demo-cloud.js）的行为测试：缺云配置启动时，data/sample-items.json
// 里的文档型样例要在列表可见、详情页可内嵌、托管地址可读回原文；
// 既有的「只读、写操作丢弃」语义不变。

const site = { name: '研究成果', desc: 'd', url: 'https://demo.example.com', favicon: 'data:image/svg+xml,x' }

async function loadSampleItems() {
  const raw = await readFile(new URL('../data/sample-items.json', import.meta.url), 'utf8')
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : parsed.items || []
}

async function loadDocSample() {
  const doc = (await loadSampleItems()).find((it) => it.kind === 'doc')
  assert.ok(doc, '样例数据中应包含一条文档型成果（kind: "doc"）')
  return doc
}

async function withDemoServer(fn) {
  const cloud = createDemoCloud()
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

test('演示模式：文档型样例在列表可见，标题照常进卡片', async () => {
  const doc = await loadDocSample()
  await withDemoServer(async (base) => {
    const res = await fetch(`${base}/`)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.ok(html.includes(doc.title), '列表页应出现文档型样例的标题')
  })
})

test('演示模式：详情页不内嵌文档（无 iframe），「查看原文」指向托管地址', async () => {
  const doc = await loadDocSample()
  await withDemoServer(async (base) => {
    const res = await fetch(`${base}/item/${doc.id}`)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.ok(!html.includes('<iframe'))
    assert.doesNotMatch(html, /全屏阅读/)
    assert.match(html, new RegExp(`<a class="btn btn-primary" href="https://demo\\.example\\.com/item/${doc.id}/doc" rel="noopener">查看原文 ↗</a>`))
  })
})

test('演示模式：托管地址可读回文档原文，携带 CSP sandbox 响应头', async () => {
  const doc = await loadDocSample()
  await withDemoServer(async (base) => {
    const res = await fetch(`${base}/item/${doc.id}/doc`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(res.headers.get('content-security-policy'), 'sandbox allow-scripts')
    assert.equal(await res.text(), doc.doc_html)
  })
})

test('样例 doc_html 小于 10KB 且自包含（无外部资源引用）', async () => {
  const doc = await loadDocSample()
  assert.ok(Buffer.byteLength(doc.doc_html, 'utf8') < 10 * 1024, 'doc_html 应小于 10KB')
  assert.ok(!/https?:\/\//.test(doc.doc_html), 'doc_html 不应引用任何外部资源地址')
})

test('演示模式：写操作丢弃语义不变（Agent API 写入失败且不持久化）', async () => {
  const doc = await loadDocSample()
  await withDemoServer(async (base) => {
    const res = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Token': 'demo-token' },
      body: JSON.stringify({ title: 't', summary: 's', url: 'https://a.com' }),
    })
    assert.ok(res.status >= 400, '演示模式下写入应失败')
    // 列表内容不变
    const html = await (await fetch(`${base}/`)).text()
    assert.ok(html.includes(doc.title))
    assert.ok(!html.includes('>t<'))
  })
})
