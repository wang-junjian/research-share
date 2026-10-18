import test from 'node:test'
import assert from 'node:assert/strict'
import { createItemsStore } from '../lib/items-store.js'

// 最小可控 fake cloud：数据可在测试中随时替换，模拟「另一个写入者」
// （admin 前端经浏览器 SDK 直连数据库，绕过本进程的缓存）
function fakeCloud(rows) {
  const state = { rows, queries: 0 }
  const builder = {
    select() { return builder },
    order() { return builder },
    then(resolve) {
      state.queries++
      return resolve({ data: state.rows, error: null })
    },
  }
  return { state, database: { from: () => builder } }
}

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
