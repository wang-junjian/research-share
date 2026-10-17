// ---------------------------------------------------------------------------
// 演示模式（demo mode）
//
// 没配置 CLOUD_ENDPOINT / CLOUD_PUBLISHABLE_KEY 时启用，让 clone 下来的人
// `npm start` 就能看到完整界面，而不必先去注册一个云服务应用。
//
// 设计约束：
//   1. 只读。所有写操作返回一个明确的只读错误，而不是假装成功 —— 演示模式
//      让人以为写入生效、刷新后又没了，比直接报错更难排查。
//   2. 结构与真 SDK 保持一致：调用方 await 到 { data, error } 形态，
//      所以 server.js 里的业务代码一行都不用改。
//   3. 不改任何线上行为。只有配置缺失时才会走到这里。
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const SAMPLE_PATH = fileURLToPath(new URL('../data/sample-items.json', import.meta.url))

let sampleCache = null
async function loadSample() {
  if (sampleCache) return sampleCache
  const raw = await readFile(SAMPLE_PATH, 'utf8')
  const parsed = JSON.parse(raw)
  // 允许样本文件既可以是裸数组，也可以是 { items: [...] }
  sampleCache = Array.isArray(parsed) ? parsed : parsed.items || []
  return sampleCache
}

// 演示看板：字段与 analytics_dashboard() 的输出对齐，数值是编的，
// 目的是让页面有东西可渲染，而不是展示真实统计口径。
const DEMO_DASHBOARD = {
  overview: {
    visitors: 128, sessions: 164, pageviews: 512,
    outboundClicks: 96, outboundRate: 0.1875, shares: 27,
  },
  daily: [],
  hourly: [],
  funnel: {
    steps: [
      { label: '会话', hint: '30 分钟不活动即切新会话', n: 164 },
      { label: '首页有交互', hint: '点了卡片或切换视图', n: 118 },
      { label: '详情页浏览', hint: '有交互的会话里点开了详情', n: 74 },
      { label: '原文跳转', hint: '一路走到「查看原文」', n: 41 },
    ],
    direct: 46,
  },
  contents: [],
  health: { totalEvents: 512, botEvents: 3, versions: [{ version: 'demo', n: 512 }] },
  excl: { visitors: 0, names: [] },
}

const READONLY_ERROR = {
  message: '演示模式为只读：请配置 CLOUD_ENDPOINT 与 CLOUD_PUBLISHABLE_KEY 后再写入',
  code: 'demo_readonly',
}

// 一个最小的链式查询构造器：够覆盖 server.js 里实际用到的调用形态。
// 真正的 SDK 有几十个方法，这里只实现被用到的那些，其余抛错以暴露缺口。
function makeQuery(table, kind) {
  const chain = {
    _filter: null,
    select() { return chain },
    order() { return chain },
    eq() { return chain },
    in() { return chain },
    limit() { return chain },
    // await 这个对象时执行
    then(resolve) {
      resolve(execute())
    },
  }

  async function execute() {
    if (kind !== 'select') return { data: null, error: READONLY_ERROR }
    if (table === 'research_items') {
      const items = await loadSample()
      const rows = items.map((it, i) => ({
        id: it.id != null ? it.id : i + 1,
        title: it.title || '',
        summary: it.summary || '',
        url: it.url || '',
        item_date: it.date || it.item_date || null,
        owner_name: it.owner_name || null,
        source_key: it.source_key || null,
        source_agent: it.source_agent || null,
        created_at: it.created_at || new Date().toISOString(),
        updated_at: it.updated_at || new Date().toISOString(),
      }))
      // 与线上一致的排序：先 item_date 倒序，再 created_at 倒序
      rows.sort((a, b) => String(b.item_date || '').localeCompare(String(a.item_date || ''))
        || String(b.created_at || '').localeCompare(String(a.created_at || '')))
      return { data: rows, error: null }
    }
    // admins / 其它表：演示模式没有管理员概念
    return { data: [], error: null }
  }

  return chain
}

export function createDemoCloud() {
  return {
    demo: true,
    database: {
      from(table) {
        const q = makeQuery(table, 'select')
        // 写操作：返回一个"会报只读错误"的查询对象
        return new Proxy(q, {
          get(target, prop) {
            if (prop === 'insert' || prop === 'update' || prop === 'delete' || prop === 'upsert') {
              return () => makeQuery(table, 'write')
            }
            return target[prop]
          },
        })
      },
      async rpc(fn, args) {
        if (fn === 'track_event') {
          // 埋点在演示模式下直接吞掉，与线上「永远 204」的语义一致
          return { data: true, error: null }
        }
        if (fn === 'analytics_dashboard') {
          return { data: DEMO_DASHBOARD, error: null }
        }
        return { data: null, error: { message: `演示模式未实现 rpc: ${fn}`, code: 'demo_unimplemented' } }
      },
    },
  }
}
