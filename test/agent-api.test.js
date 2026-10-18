import test from 'node:test'
import assert from 'node:assert/strict'
import { extractToken, pickText, pickDate, apiShape } from '../lib/agent-api.js'

const TOKEN = 'rsa_' + 'a'.repeat(32)

test('extractToken: Authorization Bearer 优先', () => {
  const req = { headers: { authorization: `Bearer ${TOKEN}`, 'x-agent-token': 'x'.repeat(16) } }
  const got = extractToken(req, new URL('https://x/?token=' + 'y'.repeat(16)))
  assert.equal(got.token, TOKEN)
  assert.equal(got.via, 'header.authorization')
})

test('extractToken: X-Agent-Token 次优', () => {
  const req = { headers: { 'x-agent-token': TOKEN } }
  const got = extractToken(req, null)
  assert.equal(got.token, TOKEN)
  assert.equal(got.via, 'header.x-agent-token')
})

test('extractToken: 查询串兜底（token / access_token）', () => {
  const got = extractToken({ headers: {} }, new URL(`https://x/?token=${TOKEN}`))
  assert.equal(got.via, 'query.token')
  const got2 = extractToken({ headers: {} }, new URL(`https://x/?access_token=${TOKEN}`))
  assert.equal(got2.via, 'query.access_token')
})

test('extractToken: 格式不合规一律不收', () => {
  assert.equal(extractToken({ headers: { authorization: 'Bearer short' } }, null).token, '')
  assert.equal(extractToken({ headers: { 'x-agent-token': '带中文的非法token字符串' } }, null).token, '')
  assert.equal(extractToken({ headers: {} }, null).token, '')
})

test('pickText: 必填缺失抛 missing_field', () => {
  assert.throws(() => pickText({}, 'title', { required: true }), /缺少必填字段：title/)
  assert.throws(() => pickText({ title: '' }, 'title', { required: true }), /缺少必填字段/)
})

test('pickText: 可选缺失返回 null', () => {
  assert.equal(pickText({}, 'source_key'), null)
})

test('pickText: 类型不对抛 invalid_field，超长抛 field_too_long', () => {
  assert.throws(() => pickText({ title: 123 }, 'title'), /必须是字符串/)
  assert.throws(() => pickText({ title: 'x'.repeat(301) }, 'title', { max: 300 }), /超过 300 字/)
  assert.equal(pickText({ title: 'x'.repeat(300) }, 'title', { max: 300 }).length, 300)
})

test('pickDate: 只收 YYYY-MM-DD', () => {
  assert.equal(pickDate({ date: '2026-10-16' }, 'date'), '2026-10-16')
  assert.equal(pickDate({}, 'date'), null)
  assert.throws(() => pickDate({ date: '2026/01/01' }, 'date'), /YYYY-MM-DD/)
  assert.throws(() => pickDate({ date: 20261016 }, 'date'), /YYYY-MM-DD/)
})

test('apiShape: 白名单浅映射，消费物化字段，不泄漏未列字段', () => {
  const shaped = apiShape({
    id: 7,
    title: 'T',
    summary: 'S',
    url: 'https://a.com',
    owner_name: '军舰',
    source_key: 'k',
    source_agent: 'main-agent',
    created_at: 'c',
    updated_at: 'u',
    // 物化派生字段（由 items-store 给出，apiShape 不再推导）
    no: 'NO.007',
    no_num: '007',
    date: '2026-10-16',
    page_url: 'https://share.example.com/item/7',
    og_image: 'https://share.example.com/og/7.png',
    item_date: '2026-10-16T00:00:00Z', // 内部字段，不应出现在输出
  })
  assert.equal(shaped.no, 'NO.007')
  assert.equal(shaped.page_url, 'https://share.example.com/item/7')
  assert.equal(shaped.og_image, 'https://share.example.com/og/7.png')
  assert.equal(shaped.date, '2026-10-16')
  assert.equal(shaped.owner, '军舰')
  assert.ok(!('item_date' in shaped))
  assert.ok(!('owner_name' in shaped))
  assert.ok(!('no_num' in shaped)) // 分享条专用，不进公开 API
})

test('apiShape: 可空字段缺省为 null', () => {
  const shaped = apiShape({ id: 1, title: 'T', summary: 'S', url: 'u', no: 'NO.001', date: '2026-01-01', page_url: 'p', og_image: 'o' })
  assert.equal(shaped.owner, null)
  assert.equal(shaped.source_key, null)
  assert.equal(shaped.no, 'NO.001')
})
