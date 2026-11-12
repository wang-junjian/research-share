import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 顶栏外部入口（ext_click）的「五处闭合」测试，以及看板默认时间范围。
//
// 这条链跨 5 个文件，任何一处漂移都会让「入口有没有人点」这个数字**静默归零**，
// 而看板上看不出来 —— 0 次点击长得像「没人点」，不像「没埋上」：
//
//   1. lib/render.js        顶栏链接挂 data-ext="topbar"
//                           （且不能同时挂 data-track-skip：skip 的判断排在
//                             data-ext 之前，两者并存 = 统计被静默关掉）
//   2. assets/track.js      读到 data-ext 就 push('ext_click') + flush()
//                           （flush 必须有：同标签页导航，不刷就随卸载丢掉）
//   3. db/10 track_event    事件白名单含 ext_click、props 白名单放行 slot
//   4. db/10 dashboard      返回 'ext', v_ext
//   5. assets/analytics.js  drawExt 读 D.ext；读不到时降级为空态，不画 0
//
// 为什么单独一条事件而不复用 outbound_click：后者是「原文跳转」的分子，
// 顶栏点一次会让它变大而 view_item 不变，跳转率直接失真。两者回答的是
// 不同问题，不能共用一个计数器（详见 db/10-ext-click.sql 的头部说明）。
// ---------------------------------------------------------------------------

const read = (p) => readFile(fileURLToPath(new URL('../' + p, import.meta.url)), 'utf8')

test('顶栏外部入口 ext_click 在五处口径上闭合', async () => {
  const [render, track, sql, dash] = await Promise.all([
    read('lib/render.js'),
    read('assets/track.js'),
    read('db/10-ext-click.sql'),
    read('assets/analytics.js'),
  ])

  // 1. 页面：挂对标记，且不挂跳过闸门
  const anchor = /<a class="topbar-link topbar-ext"[^>]*>/.exec(render)
  assert.ok(anchor, 'lib/render.js 里找不到顶栏外链')
  assert.match(anchor[0], /data-ext="topbar"/, '顶栏外链应挂 data-ext="topbar"')
  assert.doesNotMatch(anchor[0], /data-track-skip/, 'data-track-skip 会让 ext_click 永远发不出去')

  // 2. 采集：认 data-ext、发 ext_click、导航前 flush
  assert.match(track, /closest\('\[data-ext\]'\)/, 'track.js 未识别 data-ext')
  assert.match(track, /push\('ext_click'/, 'track.js 未上报 ext_click')
  const extBlock = track.slice(track.indexOf("closest('[data-ext]')"), track.indexOf("closest('[data-ext]')") + 400)
  assert.match(extBlock, /flush\(\)/, 'ext_click 之后必须 flush：它是同标签页导航')
  assert.match(extBlock, /return/, '上报后必须 return，否则会继续落到 outbound_click 分支')

  // 3. 数据库入口校验：事件名与 props 都要被白名单认下
  //    只加事件名不加 props，事件会落库但 props 被清空 —— 口径看着有数、细看没维度。
  assert.match(sql, /'content_publish','ext_click'\]/, 'track_event 事件白名单缺 ext_click')
  assert.match(sql, /p_props \? 'slot'[^\n]*any\(array\['topbar'\]\)/, 'props 白名单缺 slot/topbar')

  // 4. 聚合：dashboard 要把 ext 返回出去
  assert.match(sql, /\) into v_ext/, 'dashboard 没有把结果写进 v_ext')
  assert.match(sql, /'ext', v_ext/, 'dashboard 的返回值里没有 ext')

  // 5. 展示：认 D.ext，且缺数据时不画 0
  assert.match(dash, /function drawExt\(/, 'analytics.js 缺 drawExt')
  assert.match(dash, /var X = D\.ext/, 'drawExt 没有读 D.ext')
  assert.match(dash, /drawExt\(D\)/, 'render() 没有调用 drawExt')
  // 前端可能先于 db/10 上线（部署顺序不可控）：这时要出空态说明，
  // 而不是把 undefined 当成 0 —— 「0 次点击」是一个结论，缺数据不是。
  assert.match(dash, /if \(!X\) \{[\s\S]{0,120}emptyBox/, 'D.ext 缺失时应降级为空态说明')
})

test('数据看板默认时间范围是「今天」，且文案不出现「近 1 天」', async () => {
  const [html, dash] = await Promise.all([read('admin.html'), read('assets/analytics.js')])

  // 状态默认值与按钮高亮必须同时改：只改一处会出现「按钮高亮写着今天、
  // 实际查的是 30 天」这种最坏情况 —— 数据看着正常，口径是错的。
  assert.match(dash, /days:\s*1,/, 'analytics.js 的 state.days 默认值应为 1')
  const on = [...html.matchAll(/data-d="(\d+)" class="is-on"/g)].map((m) => m[1])
  assert.deepEqual(on, ['1'], '默认高亮的范围按钮应只有「今天」')
  assert.equal((html.match(/class="is-on"/g) || []).length, 1, 'is-on 只能有一个')

  // 「近 1 天」是机器说法；1 天窗口里 from === to，也不能写成「A ~ A」
  assert.match(dash, /D\.range\.days === 1[\s\S]{0,80}'今天 · '/, 'rangeSub 在 1 天窗口下应显示「今天」')
  assert.match(dash, /days === 1 \? '今天累计'/, '健康度的「N 天累计」在 1 天窗口下应写「今天累计」')
})
