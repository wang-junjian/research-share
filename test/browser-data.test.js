import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeCloud } from './helpers/fake-cloud.js'

// ---------------------------------------------------------------------------
// 浏览器数据面（GLOSSARY: 浏览器数据面）的 interface 测试。
//
// 数据面收在 assets/data.js 的 App.data，在 cloud.js 之后加载。本票竖切
// publish（快速分享的录入写路径），数据面独占：
//   · 文档型成果的 payload 形状（kind:'doc' + doc_html、url 留空，与 db/06
//     CHECK 同口径——期望值直接对照 db/06-doc-items.sql 的
//     research_items_shape_check，不照抄实现）
//   · owner_name 内部补全（Auth.nickname()，falsy → null）
//   · res.error → App.msg 翻译后 throw（调用方不再碰 SDK 的 res 形状）
//   · 写动 0 行即 throw（RLS 静默拦截语义，fake 经 silentBlock 仿真）
//
// seam 与 item-identity.test.js / auth-gate.test.js 同款：预设最小 window 后
// 顶层 import，window.cloud 挂 fake-cloud（写链与 0 行语义见 helpers/fake-cloud.js）。
// ---------------------------------------------------------------------------

globalThis.window = {}
await import('../assets/cloud.js')
await import('../assets/data.js')
const App = globalThis.window.App

function setup(rows = []) {
  const fake = fakeCloud(rows)
  globalThis.window.cloud = fake
  App.auth.session = null
  App.auth.user = null
  return fake
}

test('publish 链接型：payload 形状与现状一致（url 直传、不带 kind/doc_html）', async () => {
  const fake = setup()
  App.auth.user = { name: '军舰' }

  const row = await App.data.publish({
    title: '标题', summary: '概览', url: 'https://x.example/a', item_date: '2026-10-20',
  })

  assert.equal(fake.state.writes.length, 1)
  const w = fake.state.writes[0]
  assert.equal(w.table, 'research_items')
  assert.equal(w.type, 'insert')
  assert.deepEqual(w.payload, {
    title: '标题',
    summary: '概览',
    url: 'https://x.example/a',
    item_date: '2026-10-20',
    owner_name: '军舰',
  }, '链接型 payload：五个字段，不多不少')
  assert.equal(row, w.affected[0], 'resolve 新行（调用方读 id 直达详情页）')
})

test('publish 文档型：kind:\'doc\' + doc_html、url 留空（与 db/06 CHECK 同口径）', async () => {
  const fake = setup()
  App.auth.user = { name: '军舰' }

  await App.data.publish({
    title: '标题', summary: '概览', doc_html: '<p>正文</p>', item_date: '2026-10-20',
  })

  const w = fake.state.writes[0]
  assert.deepEqual(w.payload, {
    title: '标题',
    summary: '概览',
    doc_html: '<p>正文</p>',
    item_date: '2026-10-20',
    owner_name: '军舰',
    kind: 'doc',
  }, '文档型 payload：kind + doc_html，url 键不存在（走列默认 NULL）')
  assert.ok(!('url' in w.payload), '文档型 payload 不含 url 键')
})

test('owner_name 由数据面内部补全：未登录（Auth 无 user）落 null，与现状口径等价', async () => {
  const fake = setup() // setup 已清空 Auth.session/user

  await App.data.publish({ title: 'T', summary: 'S', url: 'https://x.example/a', item_date: '2026-10-20' })

  assert.equal(fake.state.writes[0].payload.owner_name, null, 'falsy → null')
})

test('res.error 经 App.msg 翻译后 throw：调用方不再碰 SDK 的 res 形状', async () => {
  const fake = setup()
  fake.state.error = { code: '42501', message: 'permission denied' }

  await assert.rejects(
    App.data.publish({ title: 'T', summary: 'S', url: 'https://x.example/a', item_date: '2026-10-20' }),
    (err) => {
      assert.equal(err.message, '没有权限执行该操作（该内容仅录入者本人或管理员可管理）。')
      return true
    })
  assert.equal(fake.state.writes.length, 0, '出错不产生写记录')
})

test('整条链 reject（网络级失败）同样翻译成可读 Error', async () => {
  const fake = setup()
  fake.state.rejectWith = { kind: 'network', message: 'fetch failed' }

  await assert.rejects(
    App.data.publish({ title: 'T', summary: 'S', url: 'https://x.example/a', item_date: '2026-10-20' }),
    (err) => {
      assert.equal(err.message, '网络连接失败，请检查网络后重试。')
      return true
    })
})

test('写动 0 行即 throw：RLS 静默拦截翻译成可读错误', async () => {
  const fake = setup()
  fake.state.silentBlock = true // 写链动 0 行、不报 error

  await assert.rejects(
    App.data.publish({ title: 'T', summary: 'S', url: 'https://x.example/a', item_date: '2026-10-20' }),
    (err) => {
      assert.match(err.message, /发布未生效/)
      return true
    })
})
