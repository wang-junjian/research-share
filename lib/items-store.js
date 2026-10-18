// ---------------------------------------------------------------------------
// 条目存储 module（GLOSSARY: 条目存储 / Items Store，决策见 docs/adr/0001）
//
// 数据访问与条目公共身份的唯一 owner：
//   · 60s 内存缓存 + invalidate + 「miss → invalidate → 重查一次」策略
//   · select 列清单与排序
//   · 派生字段物化：list/find 返回的 item 直接携带 no / date / page_url / og_image，
//     调用方（render / agent-api / 路由）只读字段，不自行推导
//
// 为什么缓存需要重查策略：admin 前端经浏览器 SDK 直连数据库写入，绕过本进程，
// 所以缓存必然可能陈旧；find 在缓存 miss 时重查一次，保证「写入后首访」不立即可见失败。
// ---------------------------------------------------------------------------

const CACHE_TTL = 60_000

// source_key / source_agent / updated_at 只有 /api/* 用得到，页面模板不渲染它们，
// 一起取回来是为了让 agent 读写走同一份数据，不必再查一次库
const COLUMNS =
  'id, title, summary, url, item_date, owner_name, source_key, source_agent, created_at, updated_at'

export function createItemsStore({ cloud, siteUrl }) {
  let cache = { items: null, at: 0 }

  // 日期归一化（item_date → YYYY-MM-DD）与身份派生都只发生在这里。
  // no 是完整编号（NO.007）；no_num 是其数字部分（007），分享给海报文案与
  // 下载文件名用（assets/share.js 的 data-no 契约）——调用方不应反向解析 no。
  function materialize(it) {
    const num = String(it.id).padStart(3, '0')
    return {
      ...it,
      no: 'NO.' + num,
      no_num: num,
      date: String(it.item_date ?? '').slice(0, 10),
      page_url: `${siteUrl}/item/${it.id}`,
      og_image: `${siteUrl}/og/${it.id}.png`,
    }
  }

  async function query() {
    const { data, error } = await cloud.database
      .from('research_items')
      .select(COLUMNS)
      .order('item_date', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) throw error
    cache = { items: (data || []).map(materialize), at: Date.now() }
    return cache.items
  }

  async function list() {
    if (cache.items && Date.now() - cache.at < CACHE_TTL) return cache.items
    return query()
  }

  function invalidate() {
    cache = { items: null, at: 0 }
  }

  async function lookup(id) {
    return (await list()).find((x) => x.id === id)
  }

  // 统一的 miss 语义：缓存未命中 → invalidate → 重查一次 → 仍 miss 返回 null
  async function find(id) {
    const cached = await lookup(id)
    if (cached) return cached
    invalidate()
    return (await lookup(id)) || null
  }

  return { list, find, invalidate }
}
