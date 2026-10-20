import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createTrack } from '../lib/track.js'
import { APP_VERSION } from '../lib/constants.js'

// ---------------------------------------------------------------------------
// createTrack 的 interface 测试：trackServerPageView / handleTrack。
// 纯函数群的表驱动测试在 test/track.test.js；这里锁的是「调用方式」——
// 注释级别的业务不变量（SSR 不带 session_id、串行落库、永远 204）变成断言。
//
// 「这批事件落库完成了」是 interface 的一部分：两个函数都返回落库 promise
// （生产调用方不 await，语义不变；测试经 flush() 攒批 await，不再轮询）。
// ---------------------------------------------------------------------------

// fake cloud：rpc 被调时同步记录函数名与入参，但结果推迟一个事件循环 tick 才
// resolve —— 逼出真实的串行等待：flush() 若没有等到全部落库完成，断言必红。
function fakeCloud() {
  const calls = []
  return {
    calls,
    database: {
      rpc: (fn, args) => {
        calls.push({ fn, args })
        return new Promise((r) =>
          setImmediate(() => r({ data: { id: calls.length }, error: null })),
        )
      },
    },
  }
}

const siteUrl = 'https://share.example.com'

async function withTrack(fn) {
  const cloud = fakeCloud()
  const { trackServerPageView, handleTrack } = createTrack({
    salt: 'test-salt',
    siteUrl,
    cloud,
  })
  const writes = []
  const server = http.createServer((req, res) => {
    if (req.url === '/api/track') {
      writes.push(handleTrack(req, res))
      return
    }
    // SSR 路径：渲染成功后补一条服务端 page_view
    writes.push(trackServerPageView(req, { page: req.url }))
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  // 确定性同步点：攒批 await 所有经 interface 返回的落库 promise
  const flush = () => Promise.all(writes)
  try {
    await fn(base, cloud, flush)
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
  await withTrack(async (base, cloud, flush) => {
    const res = await fetch(`${base}/item/7`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (iPhone) MicroMessenger/8.0',
        cookie: 'rs_vid=visitor_123',
      },
    })
    assert.equal(res.status, 200)
    await flush()

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
    // 口径版本读共享常量单一来源（lib/constants.js），与客户端同版本
    assert.equal(args.p_app_version, APP_VERSION)
  })
})

test('浏览器批量上报：source=client、携带 session，多条事件按批内顺序串行落库', async () => {
  await withTrack(async (base, cloud, flush) => {
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
    await flush()

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
  await withTrack(async (base, cloud, flush) => {
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
    // 确定性负断言：落库 promise 全部 resolve 之后，断言什么都没有发生
    await flush()
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
  await withTrack(async (base, cloud, flush) => {
    await post(base, { v: 'visitor_abc', s: 'session_xyz', ver: 'v2', events: [{ n: 'page_view', pg: '/' }] })
    await post(base, { v: 'visitor_abc', s: 'session_xyz', ver: 'not-a-version', events: [{ n: 'page_view', pg: '/' }] })
    await post(base, { v: 'visitor_abc', s: 'session_xyz', events: [{ n: 'page_view', pg: '/' }] })
    await flush()

    assert.equal(cloud.calls[0].args.p_app_version, 'v2')
    assert.equal('p_app_version' in cloud.calls[1].args, false) // 非法 → 不传
    assert.equal('p_app_version' in cloud.calls[2].args, false) // 缺失 → 不传
  })
})

test('单批事件数截断到 20 条，多余的丢弃', async () => {
  await withTrack(async (base, cloud, flush) => {
    const events = Array.from({ length: 25 }, (_, i) => ({ n: `ev_${i}`, pg: '/' }))
    const res = await post(base, { v: 'visitor_abc', s: 'session_xyz', events })
    assert.equal(res.status, 204)
    await flush()
    assert.equal(cloud.calls.length, 20)
    assert.equal(cloud.calls[19].args.p_event, 'ev_19')
  })
})

test('单 IP 频控：窗口内第 61 次请求起，事件被丢弃', async () => {
  await withTrack(async (base, cloud, flush) => {
    for (let i = 0; i < 61; i++) {
      const res = await post(base, { v: 'visitor_abc', s: 'session_xyz', events: [{ n: 'page_view', pg: '/' }] })
      assert.equal(res.status, 204)
    }
    await flush()
    assert.equal(cloud.calls.length, 60)
  })
})
