// ---------------------------------------------------------------------------
// 静态资源 module：磁盘文件 → HTTP 响应的全部细节收在这里——
// mime 表、路径穿越防护、缓存策略、admin 模板的读取与占位符替换，
// 以及不落盘的 /assets/constants.js 生成（共享常量，见 lib/constants.js）。
// 路由层（server.js）只问「命中与否」，不再感知这些实现细节。
//
// interface：createStaticFiles({ assetsDir, adminTemplate, publicConfigJson, favicon })
//   → { tryServeStatic(rel, res), getAdminHtml() }
// 两个路径都来自装配层（main()），本 module 不读环境变量、不依赖 render。
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { browserConstantsScript } from './constants.js'

const STATIC_TYPES = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  woff: 'font/woff',
  png: 'image/png',
}

// 仅放行 assets 下最多三层普通文件名（如 vendor/fonts/x.woff2），杜绝路径穿越
const SAFE_REL_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,2}$/

export function createStaticFiles({ assetsDir, adminTemplate, publicConfigJson, favicon = '' }) {
  // 返回是否命中：未命中（穿越、不存在）时什么都不写，由路由层决定怎么 404
  async function tryServeStatic(rel, res) {
    // /assets/constants.js 不落盘：由共享常量 module 在请求时动态生成
    // （GLOSSARY: 共享常量），演示模式下同样可用——track.js 无条件加载它。
    if (rel === 'constants.js') {
      res.writeHead(200, {
        'Content-Type': STATIC_TYPES.js,
        'Cache-Control': 'public, max-age=300',
      })
      res.end(browserConstantsScript())
      return true
    }
    if (!SAFE_REL_RE.test(rel) || rel.includes('..')) return false
    let buf
    try {
      buf = await readFile(path.join(assetsDir, rel))
    } catch {
      return false
    }
    const ext = rel.slice(rel.lastIndexOf('.') + 1)
    const isFont = ext === 'woff2' || ext === 'woff'
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': isFont ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    })
    res.end(buf)
    return true
  }

  // admin.html 带 __PUBLIC_CONFIG__ / __FAVICON__ 占位符：读一次、替换、缓存。
  // 配置串由装配层算好传入（env 是装配职责），这里只管文件与缓存。
  let adminHtmlCache = null
  async function getAdminHtml() {
    if (adminHtmlCache) return adminHtmlCache
    const tpl = await readFile(adminTemplate, 'utf8')
    adminHtmlCache = tpl
      .replaceAll('__PUBLIC_CONFIG__', publicConfigJson)
      .replaceAll('__FAVICON__', favicon)
    return adminHtmlCache
  }

  return { tryServeStatic, getAdminHtml }
}
