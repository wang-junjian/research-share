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
// ---------------------------------------------------------------------------

import { httpError, sendJson, sendMethodNotAllowed, readJsonBody, CORS_HEADERS } from './http.js'
import { fmtDate } from './render.js'

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

// 对外统一形态：页面 URL 与 OG 封面图一起给出，agent 直接就能拿去分享
export function apiShape(it, siteUrl) {
  return {
    id: it.id,
    no: 'NO.' + String(it.id).padStart(3, '0'),
    title: it.title,
    summary: it.summary,
    url: it.url,
    date: fmtDate(it.item_date),
    owner: it.owner_name || null,
    source_key: it.source_key || null,
    source_agent: it.source_agent || null,
    created_at: it.created_at || null,
    updated_at: it.updated_at || null,
    page_url: `${siteUrl}/item/${it.id}`,
    og_image: `${siteUrl}/og/${it.id}.png`,
  }
}

export function createAgentApi({ cloud, siteName, siteUrl, getItems, invalidateCache, handleTrack }) {
  async function findItem(id) {
    const items = await getItems({ fresh: true })
    return items.find((x) => x.id === id) || null
  }

  async function handleApi(req, res, path, reqUrl) {
    // 埋点上报语义不同（公开、无 token、永远 204），先于其它 API 分流
    if (path === '/api/track' || path === '/api/track/') return handleTrack(req, res)

    const method = req.method === 'HEAD' ? 'GET' : req.method

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      return res.end()
    }

    const itemMatch = /^\/api\/items\/(\d+)\/?$/.exec(path)

    // ---- 读：公开 ----
    if (method === 'GET') {
      if (path === '/api' || path === '/api/health' || path === '/api/health/') {
        const items = await getItems()
        return sendJson(res, 200, {
          ok: true,
          service: siteName,
          site: siteUrl,
          count: items.length,
          time: new Date().toISOString(),
        }, CORS_HEADERS)
      }
      if (path === '/api/items' || path === '/api/items/') {
        const items = await getItems()
        return sendJson(res, 200, { ok: true, count: items.length, items: items.map((it) => apiShape(it, siteUrl)) }, CORS_HEADERS)
      }
      if (itemMatch) {
        const it = await findItem(Number(itemMatch[1]))
        if (!it) return sendJson(res, 404, { ok: false, error: 'not_found', message: '目标条目不存在' }, CORS_HEADERS)
        return sendJson(res, 200, { ok: true, item: apiShape(it, siteUrl) }, CORS_HEADERS)
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
      const { data, error } = await cloud.database.rpc('agent_upsert_item', {
        p_token: token,
        p_title: pickText(body, 'title', { required: true, max: 300 }),
        p_summary: pickText(body, 'summary', { required: true, max: 400 }),
        p_url: pickText(body, 'url', { required: true, max: 2000 }),
        p_date: pickDate(body, 'date'),
        p_source_key: pickText(body, 'source_key', { max: 300 }),
      })
      if (error) return rpcFailure(res, error)
      invalidateCache()
      const it = await findItem(Number(data.id))
      return sendJson(res, data.action === 'created' ? 201 : 200, {
        ok: true,
        action: data.action,
        id: data.id,
        item: it ? apiShape(it, siteUrl) : null,
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
        p_items: list.map((it) => ({
          title: pickText(it, 'title', { required: true, max: 300 }),
          summary: pickText(it, 'summary', { required: true, max: 400 }),
          url: pickText(it, 'url', { required: true, max: 2000 }),
          date: pickDate(it, 'date'),
          source_key: pickText(it, 'source_key', { max: 300 }),
        })),
      })
      if (error) return rpcFailure(res, error)
      invalidateCache()
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
      const { error } = await cloud.database.rpc('agent_patch_item', {
        p_token: token,
        p_id: Number(itemMatch[1]),
        p_title: pickText(body, 'title', { max: 300 }),
        p_summary: pickText(body, 'summary', { max: 400 }),
        p_url: pickText(body, 'url', { max: 2000 }),
        p_date: pickDate(body, 'date'),
      })
      if (error) return rpcFailure(res, error)
      invalidateCache()
      const it = await findItem(Number(itemMatch[1]))
      return sendJson(res, 200, { ok: true, action: 'updated', id: Number(itemMatch[1]), item: it ? apiShape(it, siteUrl) : null }, CORS_HEADERS)
    }

    if (method === 'DELETE' && itemMatch) {
      const token = requireToken(req, reqUrl)
      const { data, error } = await cloud.database.rpc('agent_delete_item', {
        p_token: token,
        p_id: Number(itemMatch[1]),
      })
      if (error) return rpcFailure(res, error)
      invalidateCache()
      return sendJson(res, 200, { ok: true, action: 'deleted', id: Number(itemMatch[1]), title: data && data.title }, CORS_HEADERS)
    }

    if (path === '/api/items' || path === '/api/items/') return sendMethodNotAllowed(res, ['GET', 'POST', 'OPTIONS'])
    if (path === '/api/items/batch' || path === '/api/items/batch/') return sendMethodNotAllowed(res, ['POST', 'OPTIONS'])
    if (itemMatch) return sendMethodNotAllowed(res, ['GET', 'PATCH', 'DELETE', 'OPTIONS'])
    return sendJson(res, 404, { ok: false, error: 'not_found', message: '接口不存在' }, CORS_HEADERS)
  }

  return { handleApi }
}
