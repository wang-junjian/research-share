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
// doc_html 刻意不进清单：大文本（≤1MB）不进列表查询，文档原文由 findDocument 单行另取
// 与浏览器数据面 assets/data.js 的 ITEMS_COLUMNS 互为唯一对照点（注释互相点名）：
// 两侧清单刻意不同（浏览器侧要 owner_id，服务端要 source_key 等），改任何一侧
// 列清单时到另一侧核对口径。
const COLUMNS =
  'id, title, summary, url, kind, item_date, owner_name, source_key, source_agent, created_at, updated_at'

export function createItemsStore({ cloud, siteUrl }) {
  let cache = { items: null, at: 0 }

  // 日期归一化（item_date → YYYY-MM-DD）与身份派生都只发生在这里。
  // no 是完整编号（NO.007）；no_num 是其数字部分（007），分享给海报文案与
  // 下载文件名用（assets/share.js 的 data-no 契约）——调用方不应反向解析 no。
  // 文档型成果（GLOSSARY: 文档型成果）的原文链接不落库，物化时把 url 改写为
  // 派生托管地址 doc_url，调用方（render 的「查看原文」、apiShape 的 url）只读不推导。
  function materialize(it) {
    const num = String(it.id).padStart(3, '0')
    const kind = it.kind ?? 'link'
    const doc_url = kind === 'doc' ? `${siteUrl}/item/${it.id}/doc` : undefined
    return {
      ...it,
      kind,
      // 文档型的 url 即托管地址；展开顺序保证改写覆盖原值（null）
      ...(doc_url ? { doc_url, url: doc_url } : {}),
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

  // 文档原文单行查询：doc_html 不进列表缓存（见 COLUMNS 注释），托管路由
  // （GET /item/:id/doc）经这里取原文。直查不缓存：托管页访问远少于列表，
  // 且文档不可变（docs/adr/0004），直查代价固定。不存在返回 null。
  async function findDocument(id) {
    const { data, error } = await cloud.database
      .from('research_items')
      .select('id, doc_html')
      .eq('id', id)
    if (error) throw error
    return (data || [])[0] || null
  }

  return { list, find, findDocument, invalidate }
}
