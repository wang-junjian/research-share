import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 分享 method 的「四处闭合」测试。
//
// 这条链有五段，任何一段漂移都会让数据静默变形，而页面上完全看不出来：
//
//   1. lib/render.js 的按钮  data-act="copy-src"
//   2. assets/share.js 的分支  act === 'copy-src'
//   3. assets/track.js 的采集  连字符 → 下划线（唯一的转换点）
//   4. db track_event 的 method 白名单  'copy_src'
//   5. db 分享效力表的 values 行        'copy_src','复制原文链接'
//
// 真实踩过的坑：1、2、3 都在，4 少了 copy_src —— 事件照落库但 props 被清空，
// 于是「分享总数」比 6 行明细之和大，UI 上一片正常。这个测试就是为它写的。
// 新增/改名分享按钮时，五处一起改，否则这里会红。
// ---------------------------------------------------------------------------

const read = (p) => readFile(fileURLToPath(new URL('../' + p, import.meta.url)), 'utf8')

test('分享按钮的 method 在五处口径上闭合', async () => {
  const [render, share, track, sql] = await Promise.all([
    read('lib/render.js'),
    read('assets/share.js'),
    read('assets/track.js'),
    read('db/09-analytics-fixes.sql'),
  ])

  // 1. 页面上的按钮
  const acts = [...render.matchAll(/class="share-act" type="button" data-act="([a-z-]+)"/g)].map((m) => m[1])
  assert.equal(acts.length, 6, `详情页应有 6 个分享按钮，实际 ${acts.length} 个`)

  // 2. share.js 必须为每个按钮分支，否则是「点了没反应」的死按钮
  const handled = new Set([...share.matchAll(/act === '([a-z-]+)'/g)].map((m) => m[1]))
  for (const a of acts) assert.ok(handled.has(a), `share.js 未处理 data-act=${a}`)

  // 3. 采集层的转换点：连字符 → 下划线（改这里等于改口径，故在此钉住）
  assert.match(track, /replace\(\/-\/g, '_'\)/, 'track.js 的 method 转换点不见了')
  const methods = acts.map((a) => a.replace(/-/g, '_'))

  // 4. track_event 的 method 白名单
  const block = /if p_props \? 'method'[^\n]*?any\(array\[([^\]]+)\]\)/.exec(sql)
  assert.ok(block, 'db/09 里找不到 method 白名单')
  const whitelist = new Set([...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))
  for (const m of methods) {
    assert.ok(whitelist.has(m), `method=${m} 不在 track_event 白名单里（会被静默清空 props）`)
  }

  // 5. 分享效力表的行：数量与 method 集合都要对上，顺序即页面顺序。
  // 不能直接用 /from \(values (.+?)\) k\(ord, method, label\)/：文件里还有
  // 来源表（k(ord, label, kind)），惰性匹配会把它一起吞进来。
  const ordAt = sql.indexOf('k(ord, method, label)')
  assert.ok(ordAt > 0, 'db/09 里找不到分享效力表')
  const valsAt = sql.lastIndexOf('from (values ', ordAt)
  assert.ok(valsAt > 0 && valsAt < ordAt, 'db/09 里找不到分享效力表的 values')
  const tableMethods = [...sql.slice(valsAt, ordAt).matchAll(/\((\d+),'([a-z_]+)'/g)].map((m) => m[2])
  assert.deepEqual(tableMethods, methods, '分享效力表的行与页面按钮不一致')
})

test('outbound_click 覆盖托管文档：采集层带 via=doc，db 白名单放行该键', async () => {
  const [track, sql] = await Promise.all([
    read('assets/track.js'),
    read('db/09-analytics-fixes.sql'),
  ])
  // 采集层：同域的 /item/N/doc 也要算跳出（否则文档型条目的北极星恒为 0）
  assert.match(track, /\\\/item\\\/\\d\+\\\/doc/, 'track.js 缺少托管文档路径判定')
  assert.match(track, /via: 'doc'|outProps\.via = 'doc'/, 'track.js 未给托管文档打 via 标记')
  // 数据库：via 不在白名单里会被静默丢弃
  assert.match(sql, /p_props \? 'via'[^\n]*any\(array\['doc'\]\)/, 'db 未放行 props.via=doc')
})

test('迁移文件本身可执行：每个函数体都以 $function$; 收尾', async () => {
  // 真实踩过的坑：db/09 生成时漏了最后一个函数末尾的分号，整文件贴进
  // 控制台会报语法错 —— 而「只跑一半」的后果更难查（前两个函数生效、
  // 看板函数还是旧的）。这里按语句切一遍，逐条确认以分号收尾，
  // 并确认函数个数与文件头声明的三条一致。
  const sql = await read('db/09-analytics-fixes.sql')
  const opens = (sql.match(/\$function\$/g) || []).length
  const closes = (sql.match(/\$function\$;/g) || []).length
  assert.equal(opens, closes * 2, `$function$ 不成对：出现 ${opens} 次、带分号收尾 ${closes} 次`)
  assert.equal(closes, 3, `db/09 应有 3 个函数（track_event / track_drop / analytics_dashboard），实际 ${closes} 个`)

  // 按「不在函数体内 + 行尾分号」切语句，逐条校验
  const stmts = []
  let buf = []
  let inBody = false
  for (const ln of sql.split('\n')) {
    if (!inBody && ln.trimStart().startsWith('--')) continue
    buf.push(ln)
    if ((ln.match(/\$function\$/g) || []).length === 1) inBody = !inBody
    if (!inBody && ln.trimEnd().endsWith(';')) {
      const t = buf.join('\n').trim()
      if (t) stmts.push(t)
      buf = []
    }
  }
  assert.equal(stmts.length, 11, `db/09 应切成 11 条语句（3 个函数 + 8 条权限），实际 ${stmts.length} 条`)
  for (const s of stmts) {
    assert.ok(s.endsWith(';'), `语句未以分号收尾：${s.split('\n')[0].slice(0, 60)}`)
  }
  // anon 只能出现在 track_event / track_drop 上；看板必须收回 anon
  const anonGrants = stmts.filter((s) => /grant .* to anon/.test(s))
  assert.equal(anonGrants.length, 2, 'anon 只应被授予 track_event 与 track_drop')
  assert.ok(
    stmts.some((s) => s.includes('analytics_dashboard') && s.startsWith('revoke') && /\banon\b/.test(s)),
    'analytics_dashboard 必须显式收回 anon 权限',
  )
})

test('会话跨标签页：采集核心读取 cookie 兜底，且值里带 lastAt', async () => {
  const core = await read('assets/track-core.js')
  // 读顺序必须是「标签页存储 → cookie」，反过来会让同标签页内的续期失效
  assert.match(core, /ss\('rs:sid'\) \|\| cookie\('rs:sid'\)/, '会话读取缺少 cookie 兜底')
  // cookie 与标签页存储写同一个值（sid|lastAt），否则过期会话会被续上
  assert.match(core, /cookie\('rs:sid', v, 1800\)/, 'cookie 会话未带时间戳')
})
