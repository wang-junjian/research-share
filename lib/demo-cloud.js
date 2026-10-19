// ---------------------------------------------------------------------------
// 演示模式（demo mode）
//
// 没配置 CLOUD_ENDPOINT / CLOUD_PUBLISHABLE_KEY 时启用，让 clone 下来的人
// `npm start` 就能看到完整界面，而不必先去注册一个云服务应用。
//
// 设计约束：
//   1. 只读。所有写操作返回一个明确的错误，而不是假装成功 —— 演示模式
//      让人以为写入生效、刷新后又没了，比直接报错更难排查。服务端写路径
//      全走 rpc('agent_*')，由下面的兜底报错覆盖。
//   2. 结构与真 SDK 保持一致：调用方 await 到 { data, error } 形态，
//      所以 server.js 里的业务代码一行都不用改。
//   3. 不改任何线上行为。只有配置缺失时才会走到这里。
//
// 本 adapter 只实现 seam 上被实际消费的子集：
//   from('research_items').select().order().order()（条目存储）
//   rpc('track_event')（埋点，演示模式直接吞掉，与线上「永远 204」一致）
// 其余 rpc 一律兜底报错 —— 报错即缺口地图：未来真需要时，照着补。
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

// 一个最小的链式查询构造器：只实现被用到的 select/order/eq，其余方法不存在，
// 调了就是 TypeError，当场暴露缺口。
// eq 供条目存储的 findDocument 单行查询（select('id, doc_html').eq('id', …)）使用。
function makeQuery(table) {
  const filters = []
  const chain = {
    select() { return chain },
    order() { return chain },
    eq(col, val) { filters.push([col, val]); return chain },
    // await 这个对象时执行
    then(resolve) {
      resolve(execute())
    },
  }

  async function execute() {
    if (table === 'research_items') {
      const items = await loadSample()
      const rows = items.map((it, i) => ({
        id: it.id != null ? it.id : i + 1,
        title: it.title || '',
        summary: it.summary || '',
        url: it.url || '',
        // 文档型成果（GLOSSARY: 文档型成果）的两列透传；链接型样例不带，回落为线上默认值
        kind: it.kind || 'link',
        doc_html: it.doc_html ?? null,
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
      return { data: rows.filter((r) => filters.every(([c, v]) => r[c] === v)), error: null }
    }
    // admins / 其它表：演示模式没有管理员概念
    return { data: [], error: null }
  }

  return chain
}

export function createDemoCloud() {
  return {
    database: {
      from: (table) => makeQuery(table),
      async rpc(fn) {
        if (fn === 'track_event') {
          // 埋点在演示模式下直接吞掉，与线上「永远 204」的语义一致
          return { data: true, error: null }
        }
        return { data: null, error: { message: `演示模式未实现 rpc: ${fn}`, code: 'demo_unimplemented' } }
      },
    },
  }
}
