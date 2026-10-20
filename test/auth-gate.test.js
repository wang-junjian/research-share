import test from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// 登录态门控（GLOSSARY: 登录态门控）的机制测试。
//
// 门控收在 assets/cloud.js 的 App.authGate：挂件声明 { mount, render(session, el) }，
// 机制统一读一次会话、填充 Auth、逐挂件分发；未登录/读失败不动 SSR 输出。
// 这里测的是机制本身（纯判定）：deps 全注入（getSession / resolve / widgets），
// 不触 DOM。auth-chip / quick-share 两份声明的 DOM 细节不在本 seam。
//
// cloud.js 是浏览器脚本（IIFE 挂 window.App）：预设最小 window 后动态 import，
// 与 item-identity.test.js 同款 seam。
// ---------------------------------------------------------------------------

globalThis.window = {}
await import('../assets/cloud.js')
const App = globalThis.window.App

const SESSION = { accessToken: 'tok', user: { name: '军舰', avatarUrl: 'https://x.example/a.png' } }

function resetAuth() {
  App.auth.session = null
  App.auth.user = null
}

// 造一个挂件间谍：record 调用，返回 { decl, calls }
function spyWidget() {
  const calls = []
  return { decl: { mount: '[data-x]', render: (session, el) => calls.push({ session, el }) }, calls }
}

test('有会话：读一次会话、填充 Auth、逐挂件分发 render(session, el)', async () => {
  resetAuth()
  let reads = 0
  const el = { innerHTML: '<a>登录</a>' }
  const w1 = spyWidget()
  const w2 = spyWidget()
  const session = await App.authGate.run({
    getSession: () => { reads++; return Promise.resolve({ data: SESSION }) },
    resolve: () => el,
    widgets: [w1.decl, w2.decl],
  })

  assert.equal(reads, 1, '两个挂件也只读一次会话')
  assert.equal(session, SESSION)
  assert.equal(App.auth.session, SESSION, 'Auth.session 被填充')
  assert.equal(App.auth.user, SESSION.user, 'Auth.user 被填充')
  assert.equal(App.auth.nickname(), '军舰', 'nickname() 在公开页可用')
  assert.equal(w1.calls.length, 1)
  assert.equal(w2.calls.length, 1)
  assert.equal(w1.calls[0].session, SESSION, 'render 收到会话')
  assert.equal(w1.calls[0].el, el, 'render 收到挂载元素')
})

test('无会话：不调 render、不填 Auth，SSR 输出原样保留', async () => {
  resetAuth()
  const el = { innerHTML: '<a>登录</a>' } // SSR 默认输出
  const w = spyWidget()
  const session = await App.authGate.run({
    getSession: () => Promise.resolve({ data: null }),
    resolve: () => el,
    widgets: [w.decl],
  })

  assert.equal(session, null)
  assert.equal(w.calls.length, 0, '未登录不调 render')
  assert.equal(el.innerHTML, '<a>登录</a>', 'SSR 输出未被触碰')
  assert.equal(App.auth.session, null)
  assert.equal(App.auth.user, null)
})

test('会话无 user 字段视同未登录（SDK 异常形状兜底）', async () => {
  resetAuth()
  const w = spyWidget()
  await App.authGate.run({
    getSession: () => Promise.resolve({ data: { accessToken: 'tok' } }),
    resolve: () => ({}),
    widgets: [w.decl],
  })
  assert.equal(w.calls.length, 0)
  assert.equal(App.auth.session, null)
})

test('读会话失败：静默降级，视同未登录（ADR-0002）', async () => {
  resetAuth()
  const w = spyWidget()
  const session = await App.authGate.run({
    getSession: () => Promise.reject(new Error('network')),
    resolve: () => ({}),
    widgets: [w.decl],
  })
  assert.equal(session, null)
  assert.equal(w.calls.length, 0)
  assert.equal(App.auth.session, null)
})

test('无注册挂件：不读会话（admin 页零挂件，会话读取仍只有 bootstrap 那次）', async () => {
  resetAuth()
  let reads = 0
  await App.authGate.run({
    getSession: () => { reads++; return Promise.resolve({ data: SESSION }) },
    resolve: () => ({}),
    widgets: [],
  })
  assert.equal(reads, 0)
})

test('挂载点缺失跳过该挂件；单挂件 render 抛错不影响其余', async () => {
  resetAuth()
  const ok = spyWidget()
  const bad = { mount: '[data-bad]', render: () => { throw new Error('boom') } }
  const els = { '[data-bad]': {} } // ok 挂件的 [data-x] 解析不到
  await App.authGate.run({
    getSession: () => Promise.resolve({ data: SESSION }),
    resolve: (sel) => els[sel] || null,
    widgets: [bad, ok.decl],
  })
  assert.equal(ok.calls.length, 0, '挂载点缺失：render 不被调用')
  assert.equal(App.auth.session, SESSION, '挂件失败不影响 Auth 填充')

  // 挂载点都在、但前一个挂件 render 抛错：后一个照常分发
  const ok2 = spyWidget()
  await App.authGate.run({
    getSession: () => Promise.resolve({ data: SESSION }),
    resolve: () => ({}),
    widgets: [bad, ok2.decl],
  })
  assert.equal(ok2.calls.length, 1, '前一挂件抛错不阻断后一挂件')
})
