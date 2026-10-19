// ---------------------------------------------------------------------------
// Agent API module（/api/*）
//
// 为什么需要这一层：服务端进程是 anon 身份，而 anon 在 research_items 上只有
// SELECT —— 直连表根本写不进去；也不该把 INSERT 授权给 anon（publishableKey
// 明文写在源码里，那等于公开写权限）。所以写操作一律经数据库里的
// SECURITY DEFINER 函数落库，token 校验与字段校验都发生在函数内部，
// 库里只存 token 的 SHA-256，原文不落任何地方。
//
// 认证：Authorization: Bearer <token>
// 读：公开（与网站同源，本来就是公开数据）
//
// 纯函数（extractToken / pickText / pickDate / apiShape）直接导出，
// 单测见 test/agent-api.test.js；handleApi 由 createAgentApi factory 给出。
//
// 数据访问一律经条目存储（itemsStore）：缓存、失效、miss 重查与身份派生
// 都是它的内部细节（GLOSSARY: 条目存储；docs/adr/0001）。
// ---------------------------------------------------------------------------

import { httpError, sendJson, sendMethodNotAllowed, readJsonBody, CORS_HEADERS } from './http.js'

const TOKEN_VALUE_RE = /^[A-Za-z0-9._~-]{16,200}$/

// 取 token。三道通道按优先级试：
//   1) Authorization: Bearer <token>   —— 标准做法，本地直连可用
//   2) X-Agent-Token: <token>          —— 自定义头
//   3) ?token=<token> / ?access_token= —— 查询串
// 为什么不止用 1：这个平台的边缘代理会把 Authorization 请求头吃掉，
// 线上实测同一个 token 走 header 得到 missing_token、走查询串正常。
// 查询串的代价是 token 会进 URL（日志/历史），所以 header 能用就优先用。
export function extractToken(req, reqUrl) {
  const h = req.headers['authorization']
  if (h) {
    const m = /^Bearer\s+(.+)$/i.exec(String(h).trim())
    if (m && TOKEN_VALUE_RE.test(m[1].trim())) return { token: m[1].trim(), via: 'header.authorization' }
  }
  const x = req.headers['x-agent-token']
  if (x) {
    const v = String(x).trim()
    if (TOKEN_VALUE_RE.test(v)) return { token: v, via: 'header.x-agent-token' }
  }
  if (reqUrl) {
    for (const k of ['token', 'access_token']) {
      const v = (reqUrl.searchParams.get(k) || '').trim()
      if (TOKEN_VALUE_RE.test(v)) return { token: v, via: `query.${k}` }
    }
  }
  return { token: '', via: '' }
}

function requireToken(req, reqUrl) {
  const { token } = extractToken(req, reqUrl)
  if (!token) {
    throw httpError(
      401,
      'missing_token',
      '未收到 token。可用 Authorization: Bearer <token>、X-Agent-Token: <token>，或 ?token=<token>',
    )
  }
  return token
}

// 数据库函数抛的异常 → HTTP 语义。message 形如 'missing_field: title'
const RPC_ERRORS = [
  [/^invalid_token/, 401, 'invalid_token', 'token 无效或已失效'],
  [/^item_not_found/, 404, 'not_found', '目标条目不存在'],
  [/^missing_field/, 400, 'missing_field', '缺少必填字段'],
  [/^invalid_field/, 400, 'invalid_field', '字段不合法'],
  [/^field_too_long/, 400, 'field_too_long', '字段超长'],
]

function rpcFailure(res, err) {
  const msg = String((err && err.message) || err || '')
  for (const [re, status, code, zh] of RPC_ERRORS) {
    if (!re.test(msg)) continue
    const detail = msg.replace(/^[a-z_]+:\s*/, '')
    return sendJson(res, status, {
      ok: false,
      error: code,
      message: detail === msg ? zh : `${zh}（${detail}）`,
    }, CORS_HEADERS)
  }
  console.error('[research-share] rpc error:', msg, (err && err.code) || '')
  return sendJson(res, 502, { ok: false, error: 'database_error', message: `数据库调用失败：${msg}` }, CORS_HEADERS)
}

// 从请求体里取字符串字段：缺失 → null（可选）或抛 400（必填）；类型不对 → 400
export function pickText(body, key, { required = false, max = 0 } = {}) {
  const v = body[key]
  if (v === undefined || v === null || v === '') {
    if (required) throw httpError(400, 'missing_field', `缺少必填字段：${key}`)
    return null
  }
  if (typeof v !== 'string') throw httpError(400, 'invalid_field', `${key} 必须是字符串`)
  if (max && v.length > max) throw httpError(400, 'field_too_long', `${key} 超过 ${max} 字`)
  return v
}

export function pickDate(body, key) {
  const v = body[key]
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw httpError(400, 'invalid_field', `${key} 必须是 YYYY-MM-DD 格式`)
  }
  return v
}

// doc_html 上限与 db/06 的 CHECK 同口径（按字符数）；超长在此直接 400，不进库
const DOC_HTML_MAX = 1_000_000

function nonEmpty(v) {
  return v !== undefined && v !== null && v !== ''
}

// 写入字段归一（POST 单条与 batch 共用）：携带非空 doc_html 即文档型成果
// （GLOSSARY: 文档型成果）——原文链接是派生托管地址、不落库，url 不得同传；
// 不携带则链接型，url 必填（契约不变）。
function pickUpsertFields(body) {
  const rawDoc = pickText(body, 'doc_html', { max: DOC_HTML_MAX })
  // 与 db/06 的 btrim(p_doc_html) <> '' 同口径：纯空白不算文档，
  // 否则应用层按文档型处理（url 置空）、库内却判链接型，调用方收到莫名其妙的 missing_field: url
  const docHtml = rawDoc && rawDoc.trim() ? rawDoc : null
  if (docHtml && nonEmpty(body.url)) {
    throw httpError(400, 'invalid_field', '文档型成果不接受 url 字段：原文链接即派生托管地址（GLOSSARY: 托管地址）')
  }
  return {
    title: pickText(body, 'title', { required: true, max: 300 }),
    summary: pickText(body, 'summary', { required: true, max: 400 }),
    url: docHtml ? null : pickText(body, 'url', { required: true, max: 2000 }),
    date: pickDate(body, 'date'),
    source_key: pickText(body, 'source_key', { max: 300 }),
    doc_html: docHtml,
  }
}

// 公开输出的字段白名单：物化字段（no/date/page_url/og_image）直接透传，
// owner_name 在此重命名为 owner。只做映射，不做推导 —— 推导是条目存储的职责。
export function apiShape(it) {
  return {
    id: it.id,
    no: it.no,
    title: it.title,
    summary: it.summary,
    url: it.url,
    date: it.date,
    owner: it.owner_name || null,
    source_key: it.source_key || null,
    source_agent: it.source_agent || null,
    created_at: it.created_at || null,
    updated_at: it.updated_at || null,
    page_url: it.page_url,
    og_image: it.og_image,
  }
}

export function createAgentApi({ cloud, site, itemsStore }) {
  const { list, find, invalidate } = itemsStore

  async function handleApi(req, res, path, reqUrl) {
    const method = req.method === 'HEAD' ? 'GET' : req.method

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      return res.end()
    }

    const itemMatch = /^\/api\/items\/(\d+)\/?$/.exec(path)

    // ---- 读：公开 ----
    if (method === 'GET') {
      if (path === '/api' || path === '/api/health' || path === '/api/health/') {
        const items = await list()
        return sendJson(res, 200, {
          ok: true,
          service: site.name,
          site: site.url,
          count: items.length,
          time: new Date().toISOString(),
        }, CORS_HEADERS)
      }
      if (path === '/api/items' || path === '/api/items/') {
        const items = await list()
        return sendJson(res, 200, { ok: true, count: items.length, items: items.map(apiShape) }, CORS_HEADERS)
      }
      if (itemMatch) {
        const it = await find(Number(itemMatch[1]))
        if (!it) return sendJson(res, 404, { ok: false, error: 'not_found', message: '目标条目不存在' }, CORS_HEADERS)
        return sendJson(res, 200, { ok: true, item: apiShape(it) }, CORS_HEADERS)
      }
      return sendJson(res, 404, { ok: false, error: 'not_found', message: '接口不存在' }, CORS_HEADERS)
    }

    // ---- 写：需 token ----
    if (method === 'POST' && (path === '/api/items' || path === '/api/items/')) {
      const body = await readJsonBody(req)
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw httpError(400, 'invalid_body', '请求体必须是 JSON 对象')
      }
      const token = requireToken(req, reqUrl)
      const f = pickUpsertFields(body)
      const { data, error } = await cloud.database.rpc('agent_upsert_item', {
        p_token: token,
        p_title: f.title,
        p_summary: f.summary,
        p_url: f.url,
        p_date: f.date,
        p_source_key: f.source_key,
        p_doc_html: f.doc_html,
      })
      if (error) return rpcFailure(res, error)
      invalidate()
      const it = await find(Number(data.id))
      return sendJson(res, data.action === 'created' ? 201 : 200, {
        ok: true,
        action: data.action,
        id: data.id,
        item: it ? apiShape(it) : null,
      }, CORS_HEADERS)
    }

    if (method === 'POST' && (path === '/api/items/batch' || path === '/api/items/batch/')) {
      const body = await readJsonBody(req)
      const list = Array.isArray(body) ? body : body && body.items
      if (!Array.isArray(list)) throw httpError(400, 'invalid_body', '请求体需要 { items: [...] } 或直接是数组')
      if (!list.length) throw httpError(400, 'invalid_body', 'items 不能为空数组')
      if (list.length > 500) throw httpError(400, 'invalid_body', `单次最多 500 条，收到 ${list.length} 条`)
      list.forEach((it, i) => {
        if (it === null || typeof it !== 'object' || Array.isArray(it)) {
          throw httpError(400, 'invalid_body', `items[${i}] 必须是对象`)
        }
      })
      const token = requireToken(req, reqUrl)
      const { data, error } = await cloud.database.rpc('agent_upsert_items', {
        p_token: token,
        p_items: list.map((it) => pickUpsertFields(it)),
      })
      if (error) return rpcFailure(res, error)
      invalidate()
      // 批量是原子的：任一条不合法则整批回滚，不会写一半
      return sendJson(res, 200, {
        ok: true,
        created: data.created,
        updated: data.updated,
        total: data.total,
        items: data.items,
      }, CORS_HEADERS)
    }

    if (method === 'PATCH' && itemMatch) {
      const body = await readJsonBody(req)
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw httpError(400, 'invalid_body', '请求体必须是 JSON 对象')
      }
      const token = requireToken(req, reqUrl)
      // 文档内容不可变（docs/adr/0004）：doc_html 一经写入不支持任何修改。
      // 键出现即拒（含空串/null）：只拦非空值会让 doc_html:"" 静默放行，
      // 调用方会误以为修改已生效
      if (Object.hasOwn(body, 'doc_html')) {
        throw httpError(400, 'immutable_field', '文档内容不可变：doc_html 一经写入不可修改（docs/adr/0004）')
      }
      const { error } = await cloud.database.rpc('agent_patch_item', {
        p_token: token,
        p_id: Number(itemMatch[1]),
        p_title: pickText(body, 'title', { max: 300 }),
        p_summary: pickText(body, 'summary', { max: 400 }),
        p_url: pickText(body, 'url', { max: 2000 }),
        p_date: pickDate(body, 'date'),
      })
      if (error) return rpcFailure(res, error)
      invalidate()
      const it = await find(Number(itemMatch[1]))
      return sendJson(res, 200, { ok: true, action: 'updated', id: Number(itemMatch[1]), item: it ? apiShape(it) : null }, CORS_HEADERS)
    }

    if (method === 'DELETE' && itemMatch) {
      const token = requireToken(req, reqUrl)
      const { data, error } = await cloud.database.rpc('agent_delete_item', {
        p_token: token,
        p_id: Number(itemMatch[1]),
      })
      if (error) return rpcFailure(res, error)
      invalidate()
      return sendJson(res, 200, { ok: true, action: 'deleted', id: Number(itemMatch[1]), title: data && data.title }, CORS_HEADERS)
    }

    if (path === '/api/items' || path === '/api/items/') return sendMethodNotAllowed(res, ['GET', 'POST', 'OPTIONS'])
    if (path === '/api/items/batch' || path === '/api/items/batch/') return sendMethodNotAllowed(res, ['POST', 'OPTIONS'])
    if (itemMatch) return sendMethodNotAllowed(res, ['GET', 'PATCH', 'DELETE', 'OPTIONS'])
    return sendJson(res, 404, { ok: false, error: 'not_found', message: '接口不存在' }, CORS_HEADERS)
  }

  return { handleApi }
}
