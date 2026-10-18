import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUA, classifyRef, cleanId, hashIp, clientIp, visitorFromCookie } from '../lib/track.js'

const SITE = 'https://share.example.com'

// parseUA：表驱动，锁死「顺序即优先级」—— 国产内核 UA 同时带 Chrome/Safari，
// 顺序错了它们就永远判不出来。
const UA_CASES = [
  ['空 UA 算机器流量', '', { device: 'desktop', os: 'Other', browser: 'Other', isBot: true }],
  ['curl 算机器流量', 'curl/8.0', { isBot: true, browser: 'Other' }],
  ['微信内置浏览器', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0.47 Mobile/15E148',
    { device: 'mobile', os: 'iOS', browser: 'WeChat', isBot: false }],
  ['企业微信', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) wxwork/4.1 Mobile',
    { browser: 'WeCom', os: 'iOS' }],
  ['QQ 浏览器优先于 Chrome', 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/110.0 Mobile QQBrowser/13.0',
    { browser: 'QQBrowser', os: 'Android', device: 'mobile' }],
  ['UC 优先于 Chrome', 'Mozilla/5.0 (Linux; U; Android 13) AppleWebKit/537.36 Chrome/100.0 UCBrowser/15.0 Mobile',
    { browser: 'UC' }],
  ['HarmonyOS 优先于 Android/Linux', 'Mozilla/5.0 (Linux; Android 12; HarmonyOS) AppleWebKit/537.36 Chrome/99.0 HuaweiBrowser/14.0',
    { os: 'HarmonyOS', browser: 'Huawei' }],
  ['Edge 优先于 Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0',
    { browser: 'Edge', os: 'Windows', device: 'desktop' }],
  ['桌面 Chrome', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
    { browser: 'Chrome', os: 'macOS', device: 'desktop' }],
  ['iPad 是平板', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
    { device: 'tablet', os: 'iOS', browser: 'Safari' }],
  ['iOS 上的 CriOS 判 Chrome', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0 Mobile',
    { browser: 'Chrome', os: 'iOS' }],
  ['未知 UA 安全默认', 'SomeExoticAgent/1.0', { device: 'desktop', os: 'Other', browser: 'Other', isBot: false }],
]

for (const [name, ua, want] of UA_CASES) {
  test(`parseUA: ${name}`, () => {
    const got = parseUA(ua)
    for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, `${k}: 期望 ${v}，实际 ${got[k]}`)
  })
}

const REF_CASES = [
  ['微信 UA 恒判 wechat（referrer 被微信剥掉）', '', 'Mozilla/5.0 MicroMessenger/8.0', 'wechat'],
  ['空 referrer 是直接访问', '', 'Mozilla/5.0 Chrome/120', 'direct'],
  ['站内跳转', 'https://share.example.com/item/3', 'Mozilla/5.0 Chrome/120', 'internal'],
  ['微信文章链接', 'https://weixin.qq.com/r/abc', 'Mozilla/5.0 Chrome/120', 'wechat'],
  ['知乎', 'https://www.zhihu.com/question/1', 'Mozilla/5.0 Chrome/120', 'zhihu'],
  ['搜索引擎整段匹配', 'https://www.baidu.com/s?wd=x', 'Mozilla/5.0 Chrome/120', 'search'],
  ['sos.example.com 不算搜索', 'https://sos.example.com/', 'Mozilla/5.0 Chrome/120', 'other'],
  ['非法 URL 安全归为 other', 'not a url', 'Mozilla/5.0 Chrome/120', 'other'],
  ['陌生域名', 'https://news.ycombinator.com/item?id=1', 'Mozilla/5.0 Chrome/120', 'other'],
]

for (const [name, ref, ua, want] of REF_CASES) {
  test(`classifyRef: ${name}`, () => {
    assert.equal(classifyRef(ref, ua, SITE), want)
  })
}

test('cleanId 只接受 8~64 位 [A-Za-z0-9_-]', () => {
  assert.equal(cleanId('abcd-1234'), 'abcd-1234')
  assert.equal(cleanId('short'), null)
  assert.equal(cleanId('has space ok no'), null)
  assert.equal(cleanId('a'.repeat(65)), null)
  assert.equal(cleanId(null), null)
  assert.equal(cleanId('中文id长度够但是不行'), null)
})

test('hashIp 加盐 sha256 前 32 位，稳定且不含明文', () => {
  const h1 = hashIp('1.2.3.4', 'salt')
  const h2 = hashIp('1.2.3.4', 'salt')
  assert.equal(h1, h2)
  assert.match(h1, /^[0-9a-f]{32}$/)
  assert.notEqual(hashIp('1.2.3.4', 'other-salt'), h1)
  assert.equal(hashIp('', 'salt'), null)
})

test('clientIp 优先 XFF 第一个值', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': ' 9.9.9.9, 10.0.0.1 ' }, socket: { remoteAddress: '127.0.0.1' } }), '9.9.9.9')
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1')
})

test('visitorFromCookie 解析 rs_vid 并校验格式', () => {
  assert.equal(visitorFromCookie({ headers: { cookie: 'a=1; rs_vid=visitor-123; b=2' } }), 'visitor-123')
  assert.equal(visitorFromCookie({ headers: { cookie: 'a=1' } }), null)
  assert.equal(visitorFromCookie({ headers: { cookie: 'rs_vid=bad' } }), null)
  assert.equal(visitorFromCookie({ headers: {} }), null)
})
