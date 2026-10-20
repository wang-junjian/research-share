import test from 'node:test'
import assert from 'node:assert/strict'
import { esc, truncate, layout, renderList, renderDetail, renderError } from '../lib/render.js'

const site = { name: '研究成果', desc: '站点描述', url: 'https://example.com', favicon: 'data:image/svg+xml,x' }

// render 消费的是 items-store 物化后的 item：携带 no/date/page_url/og_image，
// 不再有 item_date（日期归一化是条目存储的内部细节）
const item = {
  id: 7,
  title: '一篇成果',
  summary: '这是概览。',
  url: 'https://src.example.com/a',
  owner_name: '军舰',
  no: 'NO.007',
  no_num: '007',
  date: '2026-10-16',
  page_url: 'https://example.com/item/7',
  og_image: 'https://example.com/og/7.png',
}

test('esc 转义 HTML 特殊字符', () => {
  assert.equal(esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  assert.equal(esc(null), '')
  assert.equal(esc(undefined), '')
})

test('truncate 超长截断并补省略号，短文本原样', () => {
  assert.equal(truncate('短', 5), '短')
  assert.equal(truncate('一二三四五六七', 5), '一二三四五…')
  assert.equal(truncate(null, 5), '')
})

test('layout 含 og meta 与 favicon，无 ogImage 时不输出 image meta', () => {
  const html = layout(site, { title: 'T', description: 'D', body: 'B' })
  assert.match(html, /<meta property="og:site_name" content="研究成果">/)
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,x">/)
  assert.doesNotMatch(html, /og:image/)
})

test('layout 转义 title 与 description', () => {
  const html = layout(site, { title: '<script>', description: '"x"', body: '' })
  assert.doesNotMatch(html, /<title><script>/)
  assert.match(html, /&lt;script&gt;/)
})

test('renderList 空态文案', () => {
  const html = renderList(site, [])
  assert.match(html, /暂无研究成果/)
})

test('renderList 渲染刊头指标、头条与链接', () => {
  const html = renderList(site, [item])
  // 头条：编号、日期与作者
  assert.match(html, /NO\.007/)
  assert.match(html, /href="\/item\/7"/)
  assert.match(html, /整理：军舰/)
  assert.match(html, /2026-10-16/)
  // 刊头核心指标条：收录 1 篇 / 1 位作者 / 2026 / 最近更新 10-16
  assert.match(html, /<span class="fv">1<\/span><span class="fk">收录成果<\/span>/)
  assert.match(html, /<span class="fv">1<\/span><span class="fk">执笔作者<\/span>/)
  assert.match(html, /<span class="fv">2026<\/span><span class="fk">时间跨度<\/span>/)
  assert.match(html, /<span class="fv">10-16<\/span><span class="fk">最近更新<\/span>/)
  // 宗旨取自 site.desc
  assert.match(html, /<div class="mast-sub">站点描述<\/div>/)
})

test('renderDetail 含 canonical、og:image 与分享 data-*', () => {
  const html = renderDetail(site, item)
  assert.match(html, /<link rel="canonical" href="https:\/\/example\.com\/item\/7">/)
  assert.match(html, /<meta property="og:image" content="https:\/\/example\.com\/og\/7\.png">/)
  assert.match(html, /data-no="007"/)
  assert.match(html, /data-date="2026-10-16"/)
  assert.match(html, /data-url="https:\/\/example\.com\/item\/7"/)
  assert.match(html, /og:type" content="article"/)
})

test('renderDetail 转义标题中的 HTML', () => {
  const html = renderDetail(site, { ...item, title: '<img onerror=x>' })
  assert.match(html, /&lt;img onerror=x&gt;/)
  assert.doesNotMatch(html, /<h1 class="detail-title"><img/)
})

test('renderDetail 文档型与链接型同构：无 iframe、无「全屏阅读」，主按钮为「查看原文 ↗」', () => {
  const html = renderDetail(site, { ...item, kind: 'doc', url: 'https://example.com/item/7/doc' })
  assert.ok(!html.includes('<iframe'))
  assert.doesNotMatch(html, /全屏阅读/)
  assert.match(html, /<a class="btn btn-primary" href="https:\/\/example\.com\/item\/7\/doc" rel="noopener">查看原文 ↗<\/a>/)
})

// 相邻条目导航：prev = 更新的一篇，next = 更早的一篇（路由按列表序注入）
const sibPrev = { ...item, id: 8, no: 'NO.008', title: '更新的一篇', date: '2026-10-18' }
const sibNext = { ...item, id: 6, no: 'NO.006', title: '更早的一篇', date: '2026-10-10' }

test('renderDetail 相邻导航：两侧页签指向相邻条目，窄屏横排签同在', () => {
  const html = renderDetail(site, item, { prev: sibPrev, next: sibNext })
  assert.match(html, /<div class="summary-zone">/)
  assert.match(html, /<a class="sibnav sibnav-prev" href="\/item\/8">/)
  assert.match(html, /<a class="sibnav sibnav-next" href="\/item\/6">/)
  assert.match(html, /上一条 · 更新/)
  assert.match(html, /下一条 · 更早/)
  assert.match(html, /更新的一篇/)
  assert.match(html, /更早的一篇/)
  assert.match(html, /<div class="sibnav-mini">/)
})

test('renderDetail 相邻导航到头：缺省侧不渲染页签，横排签留「没有了」', () => {
  const html = renderDetail(site, item, { prev: null, next: sibNext })
  assert.ok(!html.includes('sibnav sibnav-prev'))
  assert.match(html, /<a class="sibnav sibnav-next" href="\/item\/6">/)
  assert.match(html, /← 上一条 · 没有了/)
})

test('renderDetail 两侧都到头（仅一条内容）：与无导航输出同构', () => {
  const html = renderDetail(site, item, { prev: null, next: null })
  assert.ok(!html.includes('summary-zone'))
  assert.ok(!html.includes('sibnav'))
})

test('renderDetail 相邻导航转义相邻条目标题中的 HTML', () => {
  const html = renderDetail(site, item, { prev: { ...sibPrev, title: '<img onerror=x>' }, next: null })
  assert.match(html, /&lt;img onerror=x&gt;/)
})


test('renderDetail 顶栏含「分享」快速录入挂载点（与首页同一入口）', () => {
  const html = renderDetail(site, item)
  assert.match(html, /<button class="topbar-link topbar-share" type="button" data-share-entry hidden>/)
})

test('renderDetail 分享面板六个动作按既定顺序（含「复制原文链接」）', () => {
  const html = renderDetail(site, item)
  const acts = [...html.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(acts, ['copy-poster', 'show-poster', 'copy-src', 'copy-link', 'copy-poster-link', 'copy-text'])
  assert.match(html, /复制原文链接/)
  // 「复制原文链接」的数据源：原文地址挂在 data-src 上
  assert.match(html, /data-src="https:\/\/src\.example\.com\/a"/)
})

test('renderDetail 有 publicConfigJson 时加载 quick-share.js', () => {
  const authSite = { ...site, publicConfigJson: '{"endpoint":"https://e.example.com"}' }
  const html = renderDetail(authSite, item)
  assert.match(html, /<script src="\/assets\/quick-share\.js" defer><\/script>/)
})

test('layout 顶栏默认渲染「登录」入口（挂载点 data-auth-chip）', () => {
  const html = layout(site, { title: 'T', description: 'D', body: 'B' })
  assert.match(html, /<nav class="topbar-nav" data-auth-chip>/)
  assert.match(html, /<a class="topbar-link" href="\/admin">/)
  assert.match(html, />登录</)
})

test('layout 无 publicConfigJson 时不加载登录态脚本', () => {
  const html = layout(site, { title: 'T', description: 'D', body: 'B' })
  assert.doesNotMatch(html, /PUBLIC_CONFIG/)
  assert.doesNotMatch(html, /workbuddy-cloud-sdk/)
  assert.doesNotMatch(html, /auth-chip\.js/)
})

test('layout 无条件加载共享常量脚本，且先于 track.js（defer 按文档序执行）', () => {
  // 演示模式（无 publicConfigJson）也必须加载：track.js 无条件读 window.RS_CONST
  const html = layout(site, { title: 'T', description: 'D', body: 'B' })
  const iConst = html.indexOf('/assets/constants.js')
  const iTrack = html.indexOf('/assets/track.js')
  assert.ok(iConst !== -1, '常量脚本缺失')
  assert.ok(iTrack !== -1, 'track 脚本缺失')
  assert.ok(iConst < iTrack, '常量脚本必须先于 track.js')
})

test('layout 常量脚本先于 quick-share.js：DOC_MAX_CHARS 在 IIFE 顶层即读', () => {
  const authSite = { ...site, publicConfigJson: '{"endpoint":"https://e.example.com"}' }
  const html = layout(authSite, { title: 'T', description: 'D', body: 'B', shareEntry: true })
  const iConst = html.indexOf('/assets/constants.js')
  const iShare = html.indexOf('/assets/quick-share.js')
  assert.ok(iConst !== -1 && iShare !== -1, '两个脚本都应在')
  assert.ok(iConst < iShare, '常量脚本必须先于 quick-share.js')
})

test('layout 有 publicConfigJson 时注入公开配置与登录态脚本', () => {
  const authSite = { ...site, publicConfigJson: '{"endpoint":"https://e.example.com"}' }
  const html = layout(authSite, { title: 'T', description: 'D', body: 'B' })
  assert.match(html, /window\.PUBLIC_CONFIG = \{"endpoint":"https:\/\/e\.example\.com"\}/)
  assert.match(html, /<script src="\/assets\/vendor\/workbuddy-cloud-sdk\.global\.js" defer><\/script>/)
  assert.match(html, /<script src="\/assets\/cloud\.js" defer><\/script>/)
  assert.match(html, /<script src="\/assets\/auth-chip\.js" defer><\/script>/)
})

test('renderError 渲染错误页', () => {
  const html = renderError(site, '服务暂时不可用')
  assert.match(html, /服务暂时不可用/)
  assert.match(html, /出错了 · 研究成果/)
})
