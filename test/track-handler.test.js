import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createTrack } from '../lib/track.js'

// ---------------------------------------------------------------------------
// createTrack 的 interface 测试：trackServerPageView / handleTrack。
// 纯函数群的表驱动测试在 test/track.test.js；这里锁的是「调用方式」——
// 注释级别的业务不变量（SSR 不带 session_id、串行落库、永远 204）变成断言。
// ---------------------------------------------------------------------------

// fake cloud：rpc 被调时同步记录函数名与入参（记录发生在 await 之前）
function fakeCloud() {
  const calls = []
  return {
    calls,
    database: {
      rpc: async (fn, args) => {
        calls.push({ fn, args })
        return { data: { id: calls.length }, error: null }
      },
    },
  }
}

// writeEvents 是「发射后不管」的异步串行落库：等它被调完只能靠轮询
async function waitFor(cond, { tries = 100, interval = 10 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  assert.fail('等待落库超时')
}

const siteUrl = 'https://share.example.com'

async function withTrack(fn) {
  const cloud = fakeCloud()
  const { trackServerPageView, handleTrack } = createTrack({
    salt: 'test-salt',
    siteUrl,
    cloud,
  })
  const server = http.createServer((req, res) => {
    if (req.url === '/api/track') return handleTrack(req, res)
    // SSR 路径：渲染成功后补一条服务端 page_view
    trackServerPageView(req, { page: req.url })
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await fn(base, cloud)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

const post = (base, body, headers = {}) =>
  fetch(`${base}/api/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

test('SSR page_view：刻意不带 session_id（否则覆盖率恒为 1），source=server', async () => {
  await withTrack(async (base, cloud) => {
    const res = await fetch(`${base}/item/7`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (iPhone) MicroMessenger/8.0',
        cookie: 'rs_vid=visitor_123',
      },
    })
    assert.equal(res.status, 200)
    await waitFor(() => cloud.calls.length === 1)

    const { fn, args } = cloud.calls[0]
    assert.equal(fn, 'track_event')
    assert.equal(args.p_event, 'page_view')
    assert.equal(args.p_source, 'server')
    assert.equal(args.p_session, null) // 这条是刻意为之，不许改
    assert.equal(args.p_visitor, 'visitor_123')
    assert.equal(args.p_item, null)
    assert.equal(args.p_page, '/item/7')
    assert.equal(args.p_browser, 'WeChat')
    assert.equal(args.p_ref_kind, 'wechat') // 微信 UA 优先于 referrer 判定
    assert.match(args.p_ip_hash, /^[0-9a-f]{32}$/)
    assert.equal(args.p_is_bot, false)
  })
})

test('浏览器批量上报：source=client、携带 session，多条事件按批内顺序串行落库', async () => {
  await withTrack(async (base, cloud) => {
    const res = await post(base, {
      v: 'visitor_abc',
      s: 'session_xyz',
      events: [
        { n: 'session_start', pg: '/' },
        { n: 'page_view', pg: '/', i: 7 },
        { n: 'click', pg: '/', p: { k: 1 } },
      ],
    })
    assert.equal(res.status, 204)
    await waitFor(() => cloud.calls.length === 3)

    // 串行 = rpc 调用顺序与批内顺序一致（时间戳由数据库 now() 决定，乱序会坏归因）
    assert.deepEqual(
      cloud.calls.map((c) => c.args.p_event),
      ['session_start', 'page_view', 'click'],
    )
    for (const { args } of cloud.calls) {
      assert.equal(args.p_source, 'client')
      assert.equal(args.p_visitor, 'visitor_abc')
      assert.equal(args.p_session, 'session_xyz')
    }
    assert.equal(cloud.calls[1].args.p_item, 7)
    assert.deepEqual(cloud.calls[2].args.p_props, { k: 1 })
  })
})

test('永远 204：非法 JSON、非对象 body、Origin 不在白名单，一律 204 且不落库', async () => {
  await withTrack(async (base, cloud) => {
    assert.equal((await post(base, 'not json{{{')).status, 204)
    assert.equal((await post(base, [1, 2, 3])).status, 204)
    assert.equal(
      (
        await post(base, { v: 'visitor_abc', s: 'session_xyz', events: [{ n: 'page_view' }] }, {
          origin: 'https://evil.example.com',
        })
      ).status,
      204,
    )
    // 给可能发生的落库一个机会，然后断言什么都没有发生
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(cloud.calls.length, 0)
  })
})

test('方法语义：OPTIONS 204，GET 405', async () => {
  await withTrack(async (base) => {
    const opt = await fetch(`${base}/api/track`, { method: 'OPTIONS' })
    assert.equal(opt.status, 204)
    const get = await fetch(`${base}/api/track`)
    assert.equal(get.status, 405)
  })
})

test('口径版本：合法的 ver 落进 p_app_version，非法的不传（走数据库默认 v1）', async () => {
  await withTrack(async (base, cloud) => {
    await post(base, { v: 'visitor_abc', s: 'session_xyz', ver: 'v2', events: [{ n: 'page_view', pg: '/' }] })
    await post(base, { v: 'visitor_abc', s: 'session_xyz', ver: 'not-a-version', events: [{ n: 'page_view', pg: '/' }] })
    await post(base, { v: 'visitor_abc', s: 'session_xyz', events: [{ n: 'page_view', pg: '/' }] })
    await waitFor(() => cloud.calls.length === 3)

    assert.equal(cloud.calls[0].args.p_app_version, 'v2')
    assert.equal('p_app_version' in cloud.calls[1].args, false) // 非法 → 不传
    assert.equal('p_app_version' in cloud.calls[2].args, false) // 缺失 → 不传
  })
})

test('单批事件数截断到 20 条，多余的丢弃', async () => {
  await withTrack(async (base, cloud) => {
    const events = Array.from({ length: 25 }, (_, i) => ({ n: `ev_${i}`, pg: '/' }))
    const res = await post(base, { v: 'visitor_abc', s: 'session_xyz', events })
    assert.equal(res.status, 204)
    await waitFor(() => cloud.calls.length === 20)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(cloud.calls.length, 20)
    assert.equal(cloud.calls[19].args.p_event, 'ev_19')
  })
})

test('单 IP 频控：窗口内第 61 次请求起，事件被丢弃', async () => {
  await withTrack(async (base, cloud) => {
    for (let i = 0; i < 61; i++) {
      const res = await post(base, { v: 'visitor_abc', s: 'session_xyz', events: [{ n: 'page_view', pg: '/' }] })
      assert.equal(res.status, 204)
    }
    await waitFor(() => cloud.calls.length === 60)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(cloud.calls.length, 60)
  })
})
