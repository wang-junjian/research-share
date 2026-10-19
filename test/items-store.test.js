import test from 'node:test'
import assert from 'node:assert/strict'
import { createItemsStore } from '../lib/items-store.js'
import { fakeCloud } from './helpers/fake-cloud.js'

// fake cloud 见 test/helpers/fake-cloud.js：rows 可随时替换，模拟「另一个写入者」
// （admin 前端经浏览器 SDK 直连数据库，绕过本进程的缓存）

const RAW = {
  id: 7,
  title: 'T',
  summary: 'S',
  url: 'https://a.com',
  item_date: '2026-10-16T00:00:00Z',
  owner_name: '军舰',
  source_key: 'k',
  source_agent: 'main-agent',
  created_at: 'c',
  updated_at: 'u',
}

test('list: item 物化携带派生字段 no/date/page_url/og_image', async () => {
  const cloud = fakeCloud([RAW])
  const store = createItemsStore({ cloud, siteUrl: 'https://share.example.com' })
  const items = await store.list()
  assert.equal(items.length, 1)
  const it = items[0]
  // 派生字段
  assert.equal(it.no, 'NO.007')
  assert.equal(it.no_num, '007')
  assert.equal(it.date, '2026-10-16')
  assert.equal(it.page_url, 'https://share.example.com/item/7')
  assert.equal(it.og_image, 'https://share.example.com/og/7.png')
  // 原始字段保留（store 只做加法）
  assert.equal(it.title, 'T')
  assert.equal(it.item_date, '2026-10-16T00:00:00Z')
})

test('list: TTL 内命中缓存不重复查库，invalidate 后重查', async () => {
  const cloud = fakeCloud([RAW])
  const store = createItemsStore({ cloud, siteUrl: 'https://x.com' })
  await store.list()
  await store.list()
  assert.equal(cloud.state.queries, 1)
  store.invalidate()
  await store.list()
  assert.equal(cloud.state.queries, 2)
})

test('find: 缓存命中直接返回物化 item', async () => {
  const cloud = fakeCloud([RAW])
  const store = createItemsStore({ cloud, siteUrl: 'https://x.com' })
  const it = await store.find(7)
  assert.equal(it.no, 'NO.007')
  assert.equal(cloud.state.queries, 1)
  // 第二次 find 命中同一缓存
  await store.find(7)
  assert.equal(cloud.state.queries, 1)
})

test('find: 缓存 miss → invalidate → 重查一次（模拟后台直连数据库写入后的首访）', async () => {
  const cloud = fakeCloud([]) // 先建立空缓存
  const store = createItemsStore({ cloud, siteUrl: 'https://x.com' })
  await store.list()
  assert.equal(cloud.state.queries, 1)

  cloud.state.rows = [RAW] // 「另一个写入者」插入新条目，本进程缓存已陈旧
  const it = await store.find(7)
  assert.equal(it?.title, 'T')
  assert.equal(cloud.state.queries, 2) // 恰好重查一次
})

test('find: 重查后仍 miss 返回 null', async () => {
  const cloud = fakeCloud([RAW])
  const store = createItemsStore({ cloud, siteUrl: 'https://x.com' })
  assert.equal(await store.find(999), null)
})

const RAW_DOC = {
  id: 8,
  title: '一份文档成果',
  summary: 'S',
  url: null,
  kind: 'doc',
  item_date: '2026-10-18',
  owner_name: '军舰',
  source_key: null,
  source_agent: null,
  created_at: 'c',
  updated_at: 'u',
}

test('list: 文档型成果物化携带派生托管地址，url 字段即托管地址', async () => {
  const cloud = fakeCloud([RAW_DOC])
  const store = createItemsStore({ cloud, siteUrl: 'https://share.example.com' })
  const [it] = await store.list()
  assert.equal(it.doc_url, 'https://share.example.com/item/8/doc')
  assert.equal(it.url, 'https://share.example.com/item/8/doc')
})

test('list: 链接型成果不派生托管地址，url 保持站外原文链接', async () => {
  const cloud = fakeCloud([RAW])
  const store = createItemsStore({ cloud, siteUrl: 'https://share.example.com' })
  const [it] = await store.list()
  assert.equal(it.doc_url, undefined)
  assert.equal(it.url, 'https://a.com')
})

test('findDocument: 返回单行的文档原文；不存在的 id 返回 null', async () => {
  const docHtml = '<!DOCTYPE html><title>报告</title>'
  const cloud = fakeCloud([{ ...RAW_DOC, doc_html: docHtml }])
  const store = createItemsStore({ cloud, siteUrl: 'https://x.com' })
  const doc = await store.findDocument(8)
  assert.equal(doc.doc_html, docHtml)
  assert.equal(await store.findDocument(999), null)
})
