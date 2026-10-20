import test, { mock } from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// 埋点采集核心（GLOSSARY: 埋点采集核心）的 interface 表征测试。
//
// 期望值钉住的是抽出前 assets/track.js 的对外行为（票 #12 零行为变化重构）：
//   · 身份：访客一年期双写对齐、会话 30 分钟 TTL、push 每次续期
//   · 队列：入队形状（n/i/p/pg/t 与 currentItem、getPage 缺省）、10 条立即
//     flush、不足 10 条 3 秒定时 flush
//   · 降级链：beacon falsy / 抛错 / 缺失都降级 fetchKeepalive，失败即丢弃
//   · optout：中途退出丢队列不补发、之后 push 不再入队
//   · payload：ver 缺省时 JSON 无 ver 键（走数据库默认 'v1'）、rf 取自 referrer
//
// seam 与 browser-data.test.js 同款：预设最小 window 后顶层 import。
// 存储 adapter 与 track.js 壳里同签名：(key) 读、(key, val) 写、异常自吞。
// ---------------------------------------------------------------------------

globalThis.window = {}
await import('../assets/track-core.js')
const TrackCore = globalThis.window.TrackCore

function fakeStorage() {
  const mem = { ls: new Map(), ss: new Map(), cookie: new Map() }
  return {
    mem,
    ls(key, val) { if (val === undefined) return mem.ls.has(key) ? mem.ls.get(key) : null; mem.ls.set(key, val); return val },
    ss(key, val) { if (val === undefined) return mem.ss.has(key) ? mem.ss.get(key) : null; mem.ss.set(key, val); return val },
    cookie(key, val) { if (val === undefined) return mem.cookie.has(key) ? mem.cookie.get(key) : null; mem.cookie.set(key, val); return val },
  }
}

function fakeDeps(overrides = {}) {
  const store = fakeStorage()
  const sent = []
  const state = { now: 1_000_000, randSeq: 0 }
  const deps = {
    ls: store.ls,
    ss: store.ss,
    cookie: store.cookie,
    rand: () => 'rand' + String(++state.randSeq),
    now: () => state.now,
    referrer: () => 'https://ref.example/x',
    version: 'v9',
    channels: {
      beacon: (text) => { sent.push({ channel: 'beacon', text }); return true },
      fetchKeepalive: (text) => { sent.push({ channel: 'fetch', text }) },
    },
    optout: { lsKey: 'rs:optout', cookieKey: 'rs_optout' },
    getPage: () => '/',
    currentItem: null,
    ...overrides,
  }
  return { deps, store, sent, state }
}

test('optedOut：localStorage 与 cookie 任一置 1 即退出，键名经参数传入', () => {
  const s = fakeStorage()
  const o = { ls: s.ls, cookie: s.cookie, lsKey: 'rs:optout', cookieKey: 'rs_optout' }
  assert.equal(TrackCore.optedOut(o), false)
  s.ls('rs:optout', '1')
  assert.equal(TrackCore.optedOut(o), true)
  s.ls('rs:optout', '0')
  assert.equal(TrackCore.optedOut(o), false)
  s.cookie('rs_optout', '1')
  assert.equal(TrackCore.optedOut(o), true)
})

test('itemIdFromPath：/item/:id 识别口径', () => {
  assert.equal(TrackCore.itemIdFromPath('/item/12'), 12)
  assert.equal(TrackCore.itemIdFromPath('/item/12/doc'), 12)
  assert.equal(TrackCore.itemIdFromPath('/'), null)
  assert.equal(TrackCore.itemIdFromPath(''), null)
  assert.equal(TrackCore.itemIdFromPath(null), null)
})

test('新访客：rand 发证并双写 localStorage + cookie；新会话同理发证', () => {
  const { deps, store } = fakeDeps()
  const t = TrackCore.createTracker(deps)
  assert.equal(t.visitorId, 'rand1')
  assert.equal(store.mem.ls.get('rs:vid'), 'rand1')
  assert.equal(store.mem.cookie.get('rs_vid'), 'rand1')
  assert.equal(t.isNewSession, true)
  assert.equal(t.sessionId, 'rand2')
  assert.equal(store.mem.ss.get('rs:sid'), 'rand2|1000000')
  assert.equal(store.mem.cookie.get('rs:sid'), 'rand2')
})

test('老访客：cookie 已有 rs_vid 时沿用，并对齐写回 localStorage', () => {
  const f = fakeDeps()
  f.store.cookie('rs_vid', 'old-v')
  const t = TrackCore.createTracker(f.deps)
  assert.equal(t.visitorId, 'old-v')
  assert.equal(f.store.mem.ls.get('rs:vid'), 'old-v')
})

test('会话 30 分钟 TTL：未过期续用同一 sessionId，过期换新', () => {
  const f1 = fakeDeps()
  f1.store.ss('rs:sid', 'sid9|' + String(f1.state.now - 29 * 60 * 1000))
  const t1 = TrackCore.createTracker(f1.deps)
  assert.equal(t1.sessionId, 'sid9')
  assert.equal(t1.isNewSession, false)

  const f2 = fakeDeps()
  f2.store.ss('rs:sid', 'sid9|' + String(f2.state.now - 31 * 60 * 1000))
  const t2 = TrackCore.createTracker(f2.deps)
  assert.equal(t2.sessionId, 'rand2', 'rand1 先被访客身份消费，新会话拿 rand2')
  assert.equal(t2.isNewSession, true)
})

test('push 入队形状：n/i/p/pg/t，i 缺省 currentItem、pg 缺省 getPage()', () => {
  const f = fakeDeps({ currentItem: 42 })
  const t = TrackCore.createTracker(f.deps)
  t.push('page_view')
  t.push('share', { method: 'copy_link' }, 7, '/item/7')
  t.flush()
  assert.equal(f.sent.length, 1)
  const body = JSON.parse(f.sent[0].text)
  assert.deepEqual(body.events, [
    { n: 'page_view', i: 42, p: null, pg: '/', t: 1000000 },
    { n: 'share', i: 7, p: { method: 'copy_link' }, pg: '/item/7', t: 1000000 },
  ])
  assert.equal(body.v, 'rand1')
  assert.equal(body.s, 'rand2')
  assert.equal(body.ver, 'v9')
  assert.equal(body.rf, 'https://ref.example/x')
})

test('push 每次续期会话（touchSession 写回 ss + cookie）', () => {
  const f = fakeDeps()
  const t = TrackCore.createTracker(f.deps)
  f.state.now = 1_001_000
  t.push('page_view')
  assert.equal(f.store.mem.ss.get('rs:sid'), t.sessionId + '|1001000')
  assert.equal(f.store.mem.cookie.get('rs:sid'), t.sessionId)
})

test('批量：满 10 条立即 flush，不等定时器', () => {
  const f = fakeDeps()
  const t = TrackCore.createTracker(f.deps)
  for (let i = 0; i < 9; i++) t.push('page_view')
  assert.equal(f.sent.length, 0)
  t.push('page_view')
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].channel, 'beacon')
  assert.equal(JSON.parse(f.sent[0].text).events.length, 10)
})

test('去抖：不足 10 条，3 秒后定时 flush', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const f = fakeDeps()
    const t = TrackCore.createTracker(f.deps)
    t.push('page_view')
    assert.equal(f.sent.length, 0)
    mock.timers.tick(2999)
    assert.equal(f.sent.length, 0)
    mock.timers.tick(1)
    assert.equal(f.sent.length, 1)
    // flush 后再次 push 重新武装定时器
    t.push('page_view')
    mock.timers.tick(3000)
    assert.equal(f.sent.length, 2)
  } finally {
    mock.timers.reset()
  }
})

test('降级链：beacon 返回 falsy、抛错、缺失都降级 fetchKeepalive；失败即丢弃不重试', () => {
  // 返回 false
  const f1 = fakeDeps()
  f1.deps.channels.beacon = () => false
  const t1 = TrackCore.createTracker(f1.deps)
  t1.push('page_view')
  t1.flush()
  assert.deepEqual(f1.sent.map((s) => s.channel), ['fetch'])

  // 抛错
  const f2 = fakeDeps()
  f2.deps.channels.beacon = () => { throw new Error('boom') }
  const t2 = TrackCore.createTracker(f2.deps)
  t2.push('page_view')
  t2.flush()
  assert.deepEqual(f2.sent.map((s) => s.channel), ['fetch'])

  // 无 sendBeacon 环境（beacon 为 null）
  const f3 = fakeDeps()
  f3.deps.channels.beacon = null
  const t3 = TrackCore.createTracker(f3.deps)
  t3.push('page_view')
  t3.flush()
  assert.deepEqual(f3.sent.map((s) => s.channel), ['fetch'])

  // 两条通道都失败：吞掉，不抛出
  const f4 = fakeDeps()
  f4.deps.channels.beacon = () => false
  f4.deps.channels.fetchKeepalive = () => { throw new Error('boom') }
  const t4 = TrackCore.createTracker(f4.deps)
  t4.push('page_view')
  assert.doesNotThrow(() => t4.flush())
})

test('中途退出统计：已入队未发出的丢弃不补发，之后 push 不再入队', () => {
  const f = fakeDeps()
  const t = TrackCore.createTracker(f.deps)
  t.push('page_view')
  f.store.ls('rs:optout', '1')
  t.flush()
  assert.equal(f.sent.length, 0)
  t.push('page_view')
  f.store.ls('rs:optout', '0')
  t.flush()
  assert.equal(f.sent.length, 0, '退出期间的队列与事件都不补发')
})

test('ver 缺省（undefined）时 JSON 无 ver 键：走数据库默认 v1', () => {
  const f = fakeDeps({ version: undefined })
  const t = TrackCore.createTracker(f.deps)
  t.push('page_view')
  t.flush()
  const body = JSON.parse(f.sent[0].text)
  assert.ok(!('ver' in body), 'ver undefined 时键不存在（JSON.stringify 丢弃 undefined）')
})
