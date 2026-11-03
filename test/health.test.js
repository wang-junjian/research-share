import test from 'node:test'
import assert from 'node:assert/strict'
import { describeError, createHealth } from '../server.js'

// ---- describeError：线上 500 只剩 `TypeError: fetch failed` 时的唯一线索 ----
// undici 把 DNS / 连接超时 / TLS 全压成一句 fetch failed，SDK 会再包一层并把
// 底层原因塞进 details 而不给 cause —— 两种形态都要能把根因挖出来。

test('describeError: undici 原生形态，沿 cause 链取到 code/hostname', () => {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND dp.example'), {
    code: 'ENOTFOUND', hostname: 'dp.example', syscall: 'getaddrinfo',
  })
  const err = new TypeError('fetch failed', { cause })
  const out = describeError(err)
  assert.match(out, /TypeError: fetch failed/)
  assert.match(out, /ENOTFOUND dp\.example/)
  assert.match(out, /code=ENOTFOUND/)
  assert.match(out, /hostname=dp\.example/)
  // cause 链用箭头串起来，一行日志能看出层级
  assert.match(out, /<-/)
})

test('describeError: SDK 包装形态只有 details、没有 cause，也要挖到底层原因', () => {
  const err = Object.assign(new Error('fetch failed'), {
    code: 'INTERNAL',
    details: 'Caused by: Error: connect ETIMEDOUT 10.0.0.7:443\n    at connect (/app/n.js:1:1)\n    at async run (/app/server.js:9:9)',
  })
  const out = describeError(err)
  assert.match(out, /connect ETIMEDOUT 10\.0\.0\.7:443/)
  // stack 帧被压平去掉：日志按行 grep 时不会被冲散
  assert.doesNotMatch(out, /at connect/)
  assert.match(out, /details:/)
})

test('describeError: 普通错误原样可读，空值与字符串不抛', () => {
  assert.equal(describeError(new Error('boom')), 'Error: boom')
  assert.equal(describeError('something odd'), 'something odd')
  assert.equal(describeError(null), '')
  assert.equal(describeError(undefined), '')
})

test('describeError: 环状 cause 不会把日志打爆（深度封顶）', () => {
  const a = new Error('a')
  const b = new Error('b', { cause: a })
  a.cause = b // 成环
  const out = describeError(a)
  assert.ok(out.length < 1200, `输出应被截断，实际 ${out.length}`)
})

// ---- createHealth：默认档只报「进程活着」，详情要 token ----

const okDns = () => ({ host: 'dp.example', address: '10.0.0.7', ms: 3 })

function probe(over = {}) {
  return createHealth({
    demo: false,
    endpoint: 'https://dp.example',
    siteUrl: 'https://site.example',
    port: 3000,
    token: 'sekret',
    readDns: okDns,
    env: {},
    ...over,
  })
}

const at = (q = '') => new URL('http://127.0.0.1:3000/__health' + q)

test('createHealth: 未带 token / token 不符，只回精简档', () => {
  const getHealth = probe()
  const brief = getHealth(at())
  assert.deepEqual(Object.keys(brief).sort(), ['demo', 'ok', 'uptimeSec'])
  assert.deepEqual(getHealth(at('?token=wrong')), brief)
})

test('createHealth: token 相符才给详情（node / endpoint / dns / proxyEnv）', () => {
  const getHealth = probe({ env: { HTTPS_PROXY: 'http://user:pw@proxy:8080', NO_PROXY: 'localhost' } })
  const full = getHealth(at('?token=sekret'))
  assert.equal(full.ok, true)
  assert.equal(full.endpoint, 'https://dp.example')
  assert.equal(full.siteUrl, 'https://site.example')
  assert.equal(full.port, 3000)
  assert.deepEqual(full.dns, okDns())
  assert.match(full.node, /^v\d+\./)
  // 只报键名，绝不带值：代理串里可能是凭据
  assert.deepEqual(full.proxyEnv, ['HTTPS_PROXY', 'NO_PROXY'])
})

test('createHealth: 未配置 HEALTH_TOKEN 时详情永不开启（少一个变量少一条泄露路径）', () => {
  const getHealth = probe({ token: '' })
  const bare = getHealth(at())
  for (const q of ['?token=', '?token=sekret', '?token=anything']) {
    assert.deepEqual(getHealth(at(q)), bare)
  }
  assert.deepEqual(Object.keys(bare).sort(), ['demo', 'ok', 'uptimeSec'])
})
