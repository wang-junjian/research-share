import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStaticFiles } from '../lib/static-files.js'

// ---------------------------------------------------------------------------
// 静态资源 module 的 interface 测试。fixture 全部造在临时目录里，
// 不依赖仓库真实的 assets/（内容变化不该弄脆防护与缓存策略的断言）。
// ---------------------------------------------------------------------------

// module 只用 res.writeHead / res.end，最小 fake 即可
function fakeRes() {
  const r = {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      r.status = status
      r.headers = headers
    },
    end(body) {
      r.body = body
    },
  }
  return r
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'static-files-'))
  const assetsDir = path.join(root, 'assets')
  await mkdir(path.join(assetsDir, 'vendor', 'fonts'), { recursive: true })
  await writeFile(path.join(assetsDir, 'style.css'), 'body{}')
  await writeFile(path.join(assetsDir, 'app.js'), 'void 0')
  await writeFile(path.join(assetsDir, 'vendor', 'fonts', 'x.woff2'), 'font-bytes')
  await writeFile(path.join(assetsDir, 'logo.unknownext'), '???')
  const adminTemplate = path.join(root, 'admin.html')
  await writeFile(adminTemplate, '<script>window.cfg=__PUBLIC_CONFIG__</script>')
  return { assetsDir, adminTemplate }
}

test('命中：按扩展名给 mime；字体一年 immutable，其余 300s', async () => {
  const { assetsDir, adminTemplate } = await fixture()
  const { tryServeStatic } = createStaticFiles({ assetsDir, adminTemplate, publicConfigJson: '{}' })

  const css = fakeRes()
  assert.equal(await tryServeStatic('style.css', css), true)
  assert.equal(css.headers['Content-Type'], 'text/css; charset=utf-8')
  assert.equal(css.headers['Cache-Control'], 'public, max-age=300')
  assert.equal(css.body.toString(), 'body{}')

  const font = fakeRes()
  assert.equal(await tryServeStatic('vendor/fonts/x.woff2', font), true)
  assert.equal(font.headers['Content-Type'], 'font/woff2')
  assert.equal(font.headers['Cache-Control'], 'public, max-age=31536000, immutable')

  const unknown = fakeRes()
  assert.equal(await tryServeStatic('logo.unknownext', unknown), true)
  assert.equal(unknown.headers['Content-Type'], 'application/octet-stream')
})

test('路径穿越与非法路径：返回 false 且一个字节都不写', async () => {
  const { assetsDir, adminTemplate } = await fixture()
  const { tryServeStatic } = createStaticFiles({ assetsDir, adminTemplate, publicConfigJson: '{}' })

  for (const rel of [
    '../../etc/passwd',
    'vendor/../../../etc/passwd',
    '..',
    'a/b/c/d.js', // 超过三层
    '/etc/passwd',
    'style.css?x=1', // 带查询串（防御性：路由层已剥离，这里仍不放行）
  ]) {
    const res = fakeRes()
    assert.equal(await tryServeStatic(rel, res), false, rel)
    assert.equal(res.status, null, rel)
    assert.equal(res.body, null, rel)
  }
})

test('文件不存在：返回 false，由路由层决定怎么 404', async () => {
  const { assetsDir, adminTemplate } = await fixture()
  const { tryServeStatic } = createStaticFiles({ assetsDir, adminTemplate, publicConfigJson: '{}' })
  const res = fakeRes()
  assert.equal(await tryServeStatic('nope.css', res), false)
  assert.equal(res.status, null)
})

test('getAdminHtml：替换 __PUBLIC_CONFIG__ 占位符并缓存（只读一次盘）', async () => {
  const { assetsDir, adminTemplate } = await fixture()
  const { getAdminHtml } = createStaticFiles({
    assetsDir,
    adminTemplate,
    publicConfigJson: '{"endpoint":"https://e.com"}',
  })
  const html = await getAdminHtml()
  assert.equal(html, '<script>window.cfg={"endpoint":"https://e.com"}</script>')
  // 缓存：删掉模板文件后再取，仍返回第一次的结果
  await writeFile(adminTemplate, 'changed')
  assert.equal(await getAdminHtml(), html)
})
