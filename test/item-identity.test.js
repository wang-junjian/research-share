import test from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// 条目公共身份的浏览器侧派生收口（GLOSSARY: 条目公共身份，决策见 docs/adr/0001）。
//
// 服务端由条目存储（lib/items-store.js）物化；admin / quick-share / analytics
// 经浏览器 SDK 直连数据面、结构上拿不到物化字段，编号 / 详情页路径 / 托管地址
// 三条规则收在 assets/cloud.js 的 App.*，消费方只调用不推导。
//
// cloud.js 是浏览器脚本（IIFE 挂 window.App）：预设最小 window 后动态 import，
// 从 App 这个消费方实际使用的 seam 测。期望值对照服务端物化
// （lib/items-store.js materialize）的口径：'NO.' + padStart(3,'0')、
// /item/:id、/item/:id/doc、kind 缺省视为 'link'。
// ---------------------------------------------------------------------------

globalThis.window = {}
await import('../assets/cloud.js')
const App = globalThis.window.App

test('itemNo：数字编号补零到三位，与服务端物化口径一致', () => {
  assert.equal(App.itemNo(7), 'NO.007')
  assert.equal(App.itemNo(42), 'NO.042')
  assert.equal(App.itemNo(123), 'NO.123')
  assert.equal(App.itemNo(1234), 'NO.1234') // 超过三位不截断
})

test('itemPath / docPath：站内路径，不含 origin（展示处自行拼 location.origin）', () => {
  assert.equal(App.itemPath(7), '/item/7')
  assert.equal(App.docPath(7), '/item/7/doc')
})

test('isDoc：型别看 kind 列，缺省（存量行）视为链接型', () => {
  assert.equal(App.isDoc({ kind: 'doc' }), true)
  assert.equal(App.isDoc({ kind: 'link' }), false)
  assert.equal(App.isDoc({}), false) // kind 缺省 = 'link'（对齐服务端 materialize 的 ?? 'link'）
})
