import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeCloud } from './helpers/fake-cloud.js'

// ---------------------------------------------------------------------------
// 浏览器数据面（GLOSSARY: 浏览器数据面）的 interface 测试。
//
// 数据面收在 assets/data.js 的 App.data，在 cloud.js 之后加载。全方法覆盖
// （票 #10 竖切 publish，票 #11 铺满），数据面独占：
//   · 表名与 select 列清单（期望值取自调用方原来的裸链字面量，与服务端
//     条目存储 lib/items-store.js 的列清单互为对照点，注释互相点名）
//   · 文档型成果的 payload 形状（kind:'doc' + doc_html、url 留空，与 db/06
//     CHECK 同口径——期望值直接对照 db/06-doc-items.sql 的
//     research_items_shape_check，不照抄实现）
//   · owner_name 内部补全（Auth.nickname()，falsy → null）
//   · res.error → App.msg 翻译后 throw（调用方不再碰 SDK 的 res 形状）
//   · 写动 0 行即 throw（RLS 静默拦截语义，fake 经 silentBlock 仿真；
//     update/delete 过滤不到行时 fake 自然 affected=[]）
//   · 看板 rpc 的名称/参数与 jsonb 字符串/对象两种返回形状的兜底
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

// ---------------------------------------------------------------------------
// 列表与写动（票 #11：admin 接入）
// ---------------------------------------------------------------------------

test('listItems：表名、列清单与排序收口在数据面（原 admin 裸链同口径）', async () => {
  const fake = setup([{ id: 1, title: 'T' }])

  const rows = await App.data.listItems()

  assert.deepEqual(rows, [{ id: 1, title: 'T' }])
  assert.equal(fake.state.reads.length, 1)
  const r = fake.state.reads[0]
  assert.equal(r.table, 'research_items')
  // 期望值是 admin.js 原 loadItems 的裸链字面量（独立事实来源）；
  // 与服务端条目存储列清单的对照关系见 data.js 的 ITEMS_COLUMNS 注释
  assert.equal(r.columns, 'id, title, summary, url, kind, item_date, owner_id, owner_name, created_at')
  assert.deepEqual(r.orders, [
    ['item_date', { ascending: false }],
    ['created_at', { ascending: false }],
  ])
})

test('listItems：res.error 翻译成可读 Error', async () => {
  const fake = setup()
  fake.state.error = { code: '42501', message: 'permission denied' }

  await assert.rejects(App.data.listItems(), (err) => {
    assert.equal(err.message, '没有权限执行该操作（该内容仅录入者本人或管理员可管理）。')
    return true
  })
})

test('updateItem：patch 与 eq 过滤收口在数据面，resolve 更新后的行', async () => {
  const fake = setup([{ id: 7, title: '旧', summary: 'S' }])

  const row = await App.data.updateItem(7, { title: '新', summary: 'S2', item_date: '2026-10-20' })

  assert.equal(fake.state.writes.length, 1)
  const w = fake.state.writes[0]
  assert.equal(w.table, 'research_items')
  assert.equal(w.type, 'update')
  assert.deepEqual(w.patch, { title: '新', summary: 'S2', item_date: '2026-10-20' })
  assert.deepEqual(w.filters, [['eq', 'id', 7]])
  assert.equal(row.title, '新', 'resolve 更新后的行')
})

test('updateItem：0 行（RLS 静默拦截或条目不存在）throw 统一的可读错误', async () => {
  setup([{ id: 7, title: '旧' }])

  await assert.rejects(App.data.updateItem(8, { title: '新' }), (err) => {
    // 期望值是 admin.js 原编辑弹窗的内联文案（独立事实来源）
    assert.equal(err.message, '没有改动生效：该成果可能不存在，或你没有权限（仅录入者本人或管理员可修改）。')
    return true
  })
})

test('deleteItem：eq 过滤收口在数据面；0 行 throw 统一的可读错误', async () => {
  const fake = setup([{ id: 7, title: 'T' }])

  await App.data.deleteItem(7)

  const w = fake.state.writes[0]
  assert.equal(w.type, 'delete')
  assert.deepEqual(w.filters, [['eq', 'id', 7]])
  assert.equal(fake.state.rows.length, 0, '行被移除')

  await assert.rejects(App.data.deleteItem(7), (err) => {
    // 期望值是 admin.js 原单删的内联文案（独立事实来源）
    assert.equal(err.message, '删除未生效：仅录入者本人或管理员可删除')
    return true
  })
})

test('deleteItems：in 过滤；resolve 实际删除行（部分无权限由调用方报数），0 行 throw', async () => {
  const fake = setup([{ id: 1 }, { id: 2 }, { id: 3 }])

  // id 4 不存在：模拟「部分无权限/已被并发删除」——动 >0 行不 throw，
  // resolve 实际删除的行，差数由调用方报「部分无权限，已跳过」
  const removed = await App.data.deleteItems([1, 2, 4])

  const w = fake.state.writes[0]
  assert.equal(w.type, 'delete')
  assert.deepEqual(w.filters, [['in', 'id', [1, 2, 4]]])
  assert.equal(removed.length, 2)
  assert.deepEqual(fake.state.rows.map((r) => r.id), [3])

  await assert.rejects(App.data.deleteItems([4, 5]), (err) => {
    // 期望值是 admin.js 原批量删的内联文案（独立事实来源）
    assert.equal(err.message, '删除未生效：这些成果不在你的管理范围内')
    return true
  })
})

// ---------------------------------------------------------------------------
// admins 与 analytics_exclude（票 #11：admin 任命/移除、看板「排除本机」接入）
// ---------------------------------------------------------------------------

test('listAdmins：表名与列清单收口在数据面（原 admin 裸链同口径）', async () => {
  const fake = setup()
  fake.state.tables.admins = [{ user_id: 'u1', added_at: '2026-10-20', is_founder: true }]

  const rows = await App.data.listAdmins()

  assert.deepEqual(rows, [{ user_id: 'u1', added_at: '2026-10-20', is_founder: true }])
  const r = fake.state.reads[0]
  assert.equal(r.table, 'admins')
  // 期望值是 admin.js 原 loadAdmins 的裸链字面量（独立事实来源）
  assert.equal(r.columns, 'user_id, added_at, is_founder')
})

test('addAdmin：payload 形状收口在数据面；0 行（非初始管理员被 RLS 拦下）throw', async () => {
  const fake = setup()

  const row = await App.data.addAdmin('u2')

  const w = fake.state.writes[0]
  assert.equal(w.table, 'admins')
  assert.equal(w.type, 'insert')
  assert.deepEqual(w.payload, { user_id: 'u2' })
  assert.deepEqual(row, { user_id: 'u2' }, 'resolve 新行')

  // db/05：任命权归初始管理员，RLS 对其他人静默拦下（0 行、不报 error）
  fake.state.silentBlock = true
  await assert.rejects(App.data.addAdmin('u3'), (err) => {
    assert.equal(err.message, '任命未生效：仅初始管理员可任命管理员')
    return true
  })
})

test('removeAdmin：eq 过滤收口在数据面；0 行 throw（原 admin 内联文案）', async () => {
  const fake = setup()
  fake.state.tables.admins = [{ user_id: 'u2', is_founder: false }]

  await App.data.removeAdmin('u2')

  const w = fake.state.writes[0]
  assert.equal(w.type, 'delete')
  assert.deepEqual(w.filters, [['eq', 'user_id', 'u2']])
  assert.equal(fake.state.tables.admins.length, 0)

  await assert.rejects(App.data.removeAdmin('u2'), (err) => {
    // 期望值是 admin.js 原移除管理员检查 removed.length 的内联文案（独立事实来源）
    assert.equal(err.message, '移除未生效：你可能已不是管理员')
    return true
  })
})

test('listExclusions：表名与列清单收口在数据面（原看板裸链同口径）', async () => {
  const fake = setup()
  fake.state.tables.analytics_exclude = [{ visitor_id: 'v1', note: 'n', created_at: '2026-10-20' }]

  const rows = await App.data.listExclusions()

  assert.deepEqual(rows, [{ visitor_id: 'v1', note: 'n', created_at: '2026-10-20' }])
  const r = fake.state.reads[0]
  assert.equal(r.table, 'analytics_exclude')
  // 期望值是 analytics.js 原 loadExcl 的裸链字面量（独立事实来源）
  assert.equal(r.columns, 'visitor_id, note, created_at')
})

test('excludeVisitor / includeVisitor：payload 与过滤收口在数据面；刻意不做 0 行抛错', async () => {
  const fake = setup()

  await App.data.excludeVisitor('v1', '后台「排除本机」')

  const w1 = fake.state.writes[0]
  assert.equal(w1.table, 'analytics_exclude')
  assert.equal(w1.type, 'insert')
  assert.deepEqual(w1.payload, { visitor_id: 'v1', note: '后台「排除本机」' })

  await App.data.includeVisitor('v1')

  const w2 = fake.state.writes[1]
  assert.equal(w2.type, 'delete')
  assert.deepEqual(w2.filters, [['eq', 'visitor_id', 'v1']])
  assert.equal(fake.state.tables.analytics_exclude.length, 0)

  // 并发场景：另一个管理员已移除同一标识 → 再删是 0 行。这是正常终态
  // （本机已不在排除清单），不是权限拦截——「排除本机」行为与文案不变
  // 是有意的（票 #11），所以排除清单的写动不做 0 行抛错
  await App.data.includeVisitor('v1')
})

// ---------------------------------------------------------------------------
// 看板 rpc（票 #11：analytics 接入）
// ---------------------------------------------------------------------------

test('dashboard：rpc 名称与参数收口在数据面；jsonb 字符串返回也兜住', async () => {
  const fake = setup()
  const payload = { overview: { visitors: 3, sessions: 5 }, trend: [] }
  fake.state.rpcHandlers['analytics_dashboard'] = (args) => {
    // 期望值是 analytics.js 原裸调的参数形状（独立事实来源）
    assert.deepEqual(args, { p_days: 30 })
    // SDK 对 jsonb 返回值可能仍是字符串（未解好对象），数据面两种都兜
    return { data: JSON.stringify(payload), error: null }
  }

  const d = await App.data.dashboard(30)

  assert.deepEqual(d, payload)
})

test('dashboard：SDK 已解好对象时原样 resolve', async () => {
  const fake = setup()
  const payload = { overview: { visitors: 0, sessions: 0 }, trend: [] }
  fake.state.rpcHandlers['analytics_dashboard'] = () => ({ data: payload, error: null })

  const d = await App.data.dashboard(7)

  assert.equal(d, payload)
})

test('dashboard：res.error 翻译（非管理员调 rpc 被 is_admin() 拦下）', async () => {
  const fake = setup()
  // 真实拦截形状：db/03、07 的 analytics_dashboard 是
  //   raise exception 'forbidden: 仅管理员可查看数据看板'（SQLSTATE P0001），
  // App.msg 无 P0001 映射 → 原文透传；analytics.js 的 load() 靠
  // /forbidden|仅管理员/ 匹配这条原文给出「只有管理员能看数据看板」
  fake.state.error = { code: 'P0001', message: 'forbidden: 仅管理员可查看数据看板' }

  await assert.rejects(App.data.dashboard(30), (err) => {
    assert.equal(err.message, 'forbidden: 仅管理员可查看数据看板')
    return true
  })
})

test('dashboard：返回形状不符（无 overview）throw「数据格式不符合预期」', async () => {
  const fake = setup()
  fake.state.rpcHandlers['analytics_dashboard'] = () => ({ data: { oops: true }, error: null })

  // 期望值是 analytics.js 原 load() 的内联校验文案（独立事实来源）
  await assert.rejects(App.data.dashboard(30), /数据格式不符合预期/)
})
