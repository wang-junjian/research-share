// ---------------------------------------------------------------------------
// HTTP helpers：Agent API 与埋点共用的底层请求/响应工具。
// 两个 module 都需要 readJsonBody 与 sendJson，放在这里避免互相 import。
// ---------------------------------------------------------------------------

export function httpError(status, code, message) {
  const e = new Error(message)
  e.status = status
  e.code = code
  e.expose = true
  return e
}

export function sendJson(res, code, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2) + '\n'
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

export function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

export function sendMethodNotAllowed(res, allow) {
  sendJson(res, 405, { ok: false, error: 'method_not_allowed', message: `该路径只支持 ${allow.join(' / ')}` }, { Allow: allow.join(', ') })
}

// CORS：接口无 cookie / 无会话，凭证就是 Bearer token，所以放开来源不会
// 让第三方页面凭空获得写权限（它拿不到 token）。放开是为了让浏览器里的
// agent 工具也能直接调。
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, X-Agent-Token, Content-Type',
  'Access-Control-Max-Age': '86400',
}

export const API_MAX_BODY = 512 * 1024 // 512KB，批量 500 条约 200KB，留一倍余量

export function readJsonBody(req, max = API_MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks = []
    req.on('data', (c) => {
      if (settled) return
      size += c.length
      if (size > max) {
        settled = true
        reject(httpError(413, 'payload_too_large', `请求体过大（上限 ${Math.round(max / 1024)}KB）`))
        // 这里**不能** req.destroy()：调用方随后还要写响应（接口是 413、埋点是 204），
        // 立刻销毁 socket 会让响应根本发不出去 —— 客户端只看到连接被重置
        // （实测 curl 拿到 000 而不是 204/413）。改成把余下数据排空，连接能正常收尾；
        // 内存仍由上面的 size 上限守住，只是不再「连读都不读」。
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(httpError(400, 'invalid_json', '请求体不是合法 JSON'))
      }
    })
    req.on('error', (e) => {
      if (settled) return
      settled = true
      reject(e)
    })
  })
}
