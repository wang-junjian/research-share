import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { APP_VERSION, DOC_MAX_CHARS } from '../lib/constants.js'
import { createStaticFiles } from '../lib/static-files.js'

// ---------------------------------------------------------------------------
// 共享常量（GLOSSARY: 共享常量）：口径版本与文档字符上限的单一来源对照测试。
//
// 三个消费方——客户端埋点（assets/track.js）、快速分享（assets/quick-share.js）、
// SSR 埋点（lib/track.js）——全部读同一来源，双写在测试层面不可能漂移。
// 浏览器侧经静态资源模块动态生成 /assets/constants.js（不落盘、演示模式可用）；
// db/06 的 CHECK 与平台边缘 WAF 规则无法由代码生成，维持注释对照。
// ---------------------------------------------------------------------------

test('单一来源的值与现网一致：口径版本 v2、文档上限 1000000 字符', () => {
  assert.equal(APP_VERSION, 'v2')
  assert.equal(DOC_MAX_CHARS, 1000000)
})

test('生成的浏览器常量脚本：不落盘也可加载，内容 === 单一来源', async () => {
  // 空 assets 目录（盘上无 constants.js）——生成通道不依赖落盘文件
  const root = await mkdtemp(path.join(tmpdir(), 'constants-'))
  const assetsDir = path.join(root, 'assets')
  await mkdir(assetsDir)
  const adminTemplate = path.join(root, 'admin.html')
  await writeFile(adminTemplate, '')

  const { tryServeStatic } = createStaticFiles({ assetsDir, adminTemplate, publicConfigJson: '{}' })
  const res = {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) { res.status = status; res.headers = headers },
    end(body) { res.body = body },
  }
  assert.equal(await tryServeStatic('constants.js', res), true)
  assert.equal(res.status, 200)
  assert.equal(res.headers['Content-Type'], 'text/javascript; charset=utf-8')

  // 以浏览器方式执行生成的脚本，挂出的全局必须与来源值逐项相等
  const win = {}
  new Function('window', res.body.toString())(win)
  assert.deepEqual(win.RS_CONST, { APP_VERSION, DOC_MAX_CHARS })
})
