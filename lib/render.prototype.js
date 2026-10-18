// ===========================================================================
// PROTOTYPE —— 两种全新展示风格，评审后即弃，不进 main。
//
// 方案：列表页与详情页各两种新风格，经 ?variant=a / ?variant=b 挂在现有
// 路由上（不带参数即现行「纸感手稿」）。页面底部有浮动切换条，←/→ 键也能切。
//
//   A · 暗夜档案：深底琥珀（取自 favicon 配色），列表是账簿式索引行，
//       详情是档案卷宗（元数据格子 + 批注式摘要栏）。
//   B · 杂志特稿：冷调纸面 + 海军蓝，列表是「头条 + 双栏编号」的报纸版式，
//       详情是居中长文（饰线 kicker + 首字下沉）。
//
// 生命周期：整套原型（本文件 + assets/prototype.css + server.js 里的
// uiPrototype 接线）活在 prototype/display-styles 分支上，胜出风格重写进
// render.js 后本文件删除。
// ===========================================================================

import { esc, truncate, layout } from './render.js'

// ---------------------------------------------------------------------------
// 浮动切换条：三个状态循环（现行 → A → B），写 URL search param，
// 刷新与分享链接都能停在当前风格上。样式在 assets/prototype.css。
// ---------------------------------------------------------------------------

const PROTOTYPE_VARIANTS = [
  { key: '', label: '现行 · 纸感手稿' },
  { key: 'a', label: 'A · 暗夜档案' },
  { key: 'b', label: 'B · 杂志特稿' },
]

const SWITCHER_SCRIPT = `<script>
(function () {
  var KEYS = ${JSON.stringify(PROTOTYPE_VARIANTS.map((v) => v.key))}
  function go(dir) {
    var q = new URLSearchParams(location.search)
    var i = KEYS.indexOf(q.get('variant') || '')
    if (i < 0) i = 0
    var next = KEYS[(i + dir + KEYS.length) % KEYS.length]
    if (next) q.set('variant', next)
    else q.delete('variant')
    location.search = q.toString()
  }
  var prev = document.querySelector('[data-proto-prev]')
  if (!prev) return
  prev.addEventListener('click', function () { go(-1) })
  document.querySelector('[data-proto-next]').addEventListener('click', function () { go(1) })
  document.addEventListener('keydown', function (e) {
    var t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (e.key === 'ArrowLeft') go(-1)
    else if (e.key === 'ArrowRight') go(1)
  })
})()
</script>`

function switcherMarkup(currentKey) {
  const v = PROTOTYPE_VARIANTS.find((x) => x.key === currentKey) || PROTOTYPE_VARIANTS[0]
  return `<div class="proto-spacer" aria-hidden="true"></div>
<div class="proto-switch" role="group" aria-label="界面原型风格切换">
  <span class="proto-badge">原型</span>
  <button type="button" data-proto-prev aria-label="上一个风格">←</button>
  <span class="proto-label">${esc(v.label)}</span>
  <button type="button" data-proto-next aria-label="下一个风格">→</button>
</div>
${SWITCHER_SCRIPT}`
}

// 现行风格（render.js 的渲染结果）不动模板，在路由层外科手术式注入切换条
export function injectPrototypeSwitcher(html) {
  return html
    .replace(
      '<link rel="stylesheet" href="/assets/style.css">',
      '<link rel="stylesheet" href="/assets/style.css">\n<link rel="stylesheet" href="/assets/prototype.css">'
    )
    .replace('</body>', switcherMarkup('') + '</body>')
}

// 原型变体页：layout() 产出 OG/顶栏/页脚，本函数换 body、加原型样式与 data-variant
function wrapVariant(html, variant) {
  return html
    .replace(
      '<link rel="stylesheet" href="/assets/style.css">',
      '<link rel="stylesheet" href="/assets/style.css">\n<link rel="stylesheet" href="/assets/prototype.css">'
    )
    .replace('<body>', `<body data-variant="${variant}">`)
    .replace('</body>', switcherMarkup(variant) + '</body>')
}

// ---------------------------------------------------------------------------
// 与 render.js 同源的小工具（原型不反向依赖它的私有函数，抄一份最小的）
// ---------------------------------------------------------------------------

function fmtMD(date) {
  return date.length >= 10 ? date.slice(5) : date
}

function yearOf(date) {
  return date.slice(0, 4)
}

function byText(it) {
  return it.owner_name ? `整理：${it.owner_name}` : ''
}

const EMPTY = '<div class="empty"><h3>暂无研究成果</h3><p>从后台录入第一条成果后，这里会立即出现。</p></div>'

// ---------------------------------------------------------------------------
// 列表页 · 变体 A「暗夜档案」：账簿式索引行，无卡片
// ---------------------------------------------------------------------------

function listRowA(it) {
  return `<a class="pa-row" href="/item/${it.id}">
  <span class="pa-no">${esc(it.no)}</span>
  <span class="pa-main">
    <span class="pa-line1"><span class="pa-t">${esc(it.title)}</span><span class="pa-y">${esc(yearOf(it.date))}</span></span>
    <span class="pa-s">${esc(it.summary)}</span>
  </span>
  <span class="pa-date">${esc(fmtMD(it.date))}</span>
  <span class="pa-arrow">→</span>
</a>`
}

function renderListA(site, items) {
  const body = `<div class="pa-head">
  <div class="pa-kicker">INDEX · 档案索引</div>
  <div class="pa-title-row">
    <div class="pa-title">研究成果</div>
    <div class="pa-count">${items.length ? `共 ${items.length} 条 · 按日期倒序` : '持续更新'}</div>
  </div>
</div>
<div class="pa-ledger">
${items.length ? items.map(listRowA).join('\n') : EMPTY}
</div>`
  return wrapVariant(
    layout(site, { title: site.name + ' · 研究笔记', description: site.desc, canonical: site.url + '/', body }),
    'a'
  )
}

// ---------------------------------------------------------------------------
// 列表页 · 变体 B「杂志特稿」：最新一条做头条，其余双栏带大号序号
// ---------------------------------------------------------------------------

function renderListB(site, items) {
  if (!items.length) {
    return wrapVariant(
      layout(site, { title: site.name + ' · 研究笔记', description: site.desc, canonical: site.url + '/', body: EMPTY }),
      'b'
    )
  }
  // 刊头数据：从条目里物化「这个应用是什么、有多少、谁在写、何时更新」
  const latest = items[0] // 列表按日期倒序，第一条即最新
  const years = [...new Set(items.map((it) => yearOf(it.date)))].sort()
  const yearSpan = years.length > 1 ? `${years[0]}–${years[years.length - 1]}` : years[0]
  const owners = new Set(items.map((it) => it.owner_name).filter(Boolean)).size
  const [hero, ...rest] = items
  const cols = rest
    .map(
      (it, i) => `<a class="pb-item" href="/item/${it.id}">
  <span class="pb-idx">${String(i + 2).padStart(2, '0')}</span>
  <span class="pb-item-body">
    <span class="pb-item-title">${esc(it.title)}</span>
    <span class="pb-item-deck">${esc(it.summary)}</span>
    <span class="pb-item-meta">${esc(it.no)} · ${esc(it.date)}${it.owner_name ? ' · ' + esc(it.owner_name) : ''}</span>
  </span>
</a>`
    )
    .join('\n')
  const body = `<div class="pb-masthead">
  <div class="pb-mast-strip">
    <span>已刊至 ${esc(latest.no)}</span>
    <span class="pb-mast-seal">研</span>
    <span>${esc(yearSpan)} · 持续更新</span>
  </div>
  <h1 class="pb-title">研究成果</h1>
  <div class="pb-sub">${esc(site.desc)}</div>
  <div class="pb-facts">
    <div class="pb-fact"><span class="pb-fact-v">${items.length}</span><span class="pb-fact-k">收录成果</span></div>
    <div class="pb-fact"><span class="pb-fact-v">${owners || '—'}</span><span class="pb-fact-k">执笔作者</span></div>
    <div class="pb-fact"><span class="pb-fact-v">${esc(yearSpan)}</span><span class="pb-fact-k">时间跨度</span></div>
    <div class="pb-fact"><span class="pb-fact-v">${esc(fmtMD(latest.date))}</span><span class="pb-fact-k">最近更新</span></div>
  </div>
</div>
<a class="pb-hero" href="/item/${hero.id}">
  <div class="pb-hero-tag">最新成果 · Feature</div>
  <h2 class="pb-hero-title">${esc(hero.title)}</h2>
  <p class="pb-hero-deck">${esc(hero.summary)}</p>
  <div class="pb-hero-meta">${esc(hero.no)} · ${esc(hero.date)}${byText(hero) ? ' · ' + esc(byText(hero)) : ''} · 阅读全文 →</div>
</a>
<div class="pb-cols">
${cols}
</div>`
  return wrapVariant(
    layout(site, { title: site.name + ' · 研究笔记', description: site.desc, canonical: site.url + '/', body }),
    'b'
  )
}

// ---------------------------------------------------------------------------
// 详情页：分享条 DOM 与现行一致（assets/share.js 的 data-* 契约不变），
// 两个变体只重写正文 article 的结构，分享条外观由 CSS 改头换面。
// ---------------------------------------------------------------------------

// 分享面板的五个图标（抄自 render.js，原型存续期间需手动保持同步）
const shareIcon = (paths) => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>'
const ICON_LINK = shareIcon('<path d="M10.5 13.5a4.5 4.5 0 0 0 6.4.5l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.5"/><path d="M13.5 10.5a4.5 4.5 0 0 0-6.4-.5L4.5 12.6a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5"/>')
const ICON_EYE = shareIcon('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>')
const ICON_COPY_IMG = shareIcon('<rect x="3" y="3" width="13" height="13" rx="2"/><circle cx="7.4" cy="7.4" r="1.3"/><path d="m3 13 2.6-2.6a1.6 1.6 0 0 1 2.3 0L11 13.5"/><path d="M18 20.5h1.5a2 2 0 0 0 2-2V17"/><path d="M9 20.5h6"/>')
const ICON_IMG_TEXT = shareIcon('<rect x="3" y="2.5" width="18" height="13" rx="2"/><circle cx="8" cy="7.5" r="1.4"/><path d="m3.6 15.5 3.4-3.4a1.6 1.6 0 0 1 2.3 0l3.3 3.3"/><path d="M6 19.5h12"/><path d="M6 22h7"/>')
const ICON_TEXT = shareIcon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9.4 13h5.2"/><path d="M9.4 17h3.4"/>')

function shareBar(it) {
  const shareData = [
    `data-share`,
    `data-title="${esc(it.title)}"`,
    `data-summary="${esc(truncate(it.summary, 220))}"`,
    `data-overview="${esc(it.summary)}"`,
    `data-date="${esc(it.date)}"`,
    `data-by="${esc(it.owner_name || '')}"`,
    `data-no="${esc(it.no_num)}"`,
    `data-url="${esc(it.page_url)}"`,
    `data-src="${esc(it.url || '')}"`,
  ].join(' ')
  return `<div class="sharebar" ${shareData}>
  <div class="sharebar-head"><span class="sharebar-label">分享</span></div>
  <div class="share-actions">
    <button class="share-act" type="button" data-act="copy-link">
      <span class="share-act-ico">${ICON_LINK}</span>
      <span class="share-act-txt">
        <span class="share-act-name">复制本页链接</span>
        <span class="share-act-desc">粘贴到微信即可发送</span>
      </span>
    </button>
    <button class="share-act" type="button" data-act="copy-text">
      <span class="share-act-ico">${ICON_TEXT}</span>
      <span class="share-act-txt">
        <span class="share-act-name">复制文字+原文链接</span>
        <span class="share-act-desc">含标题、概览与链接</span>
      </span>
    </button>
    <button class="share-act" type="button" data-act="show-poster">
      <span class="share-act-ico">${ICON_EYE}</span>
      <span class="share-act-txt">
        <span class="share-act-name">显示海报图</span>
        <span class="share-act-desc">预览长图，可保存下载</span>
      </span>
    </button>
    <button class="share-act" type="button" data-act="copy-poster">
      <span class="share-act-ico">${ICON_COPY_IMG}</span>
      <span class="share-act-txt">
        <span class="share-act-name">复制海报图</span>
        <span class="share-act-desc">图片直接粘贴进聊天</span>
      </span>
    </button>
    <button class="share-act" type="button" data-act="copy-poster-link">
      <span class="share-act-ico">${ICON_IMG_TEXT}</span>
      <span class="share-act-txt">
        <span class="share-act-name">复制海报图+原文链接</span>
        <span class="share-act-desc">图片与原文链接一起复制</span>
      </span>
    </button>
  </div>
  <p class="share-note" data-note role="status" aria-live="polite"></p>
</div>
<div data-poster-mount></div>`
}

function detailLayout(site, it, body) {
  return layout(site, {
    title: it.title,
    description: truncate(it.summary, 80),
    ogType: 'article',
    canonical: it.page_url,
    ogImage: it.og_image,
    script: '<script src="/assets/share.js" defer></script>',
    body,
  })
}

// 详情 · 变体 A「暗夜档案」：卷宗——元数据格子 + 琥珀批注条
function renderDetailA(site, it) {
  const body = `<article class="pa-doc">
  <div class="pa-doc-meta">
    <div class="pa-cell"><span class="pa-k">编号</span><span class="pa-v">${esc(it.no)}</span></div>
    <div class="pa-cell"><span class="pa-k">日期</span><span class="pa-v">${esc(it.date)}</span></div>
    <div class="pa-cell"><span class="pa-k">年份</span><span class="pa-v">${esc(yearOf(it.date))}</span></div>
    <div class="pa-cell"><span class="pa-k">整理</span><span class="pa-v">${esc(it.owner_name || '—')}</span></div>
  </div>
  <h1 class="pa-doc-title">${esc(it.title)}</h1>
  <p class="pa-doc-summary">${esc(it.summary)}</p>
  <div class="pa-doc-actions">
    <a class="btn btn-primary" href="${esc(it.url)}" rel="noopener">查看原文 ↗</a>
    <a class="btn btn-ghost" href="/?variant=a">← 全部成果</a>
  </div>
  <div class="pa-doc-src">原文链接：<a href="${esc(it.url)}" rel="noopener">${esc(it.url)}</a></div>
</article>
${shareBar(it)}`
  return wrapVariant(detailLayout(site, it, body), 'a')
}

// 详情 · 变体 B「杂志特稿」：居中长文——饰线 kicker + 首字下沉
function renderDetailB(site, it) {
  const body = `<article class="pb-article">
  <div class="pb-art-kicker"><span>研究成果 · ${esc(yearOf(it.date))}</span></div>
  <h1 class="pb-art-title">${esc(it.title)}</h1>
  <div class="pb-art-meta">${esc(it.no)} · ${esc(it.date)}${byText(it) ? ' · ' + esc(byText(it)) : ''}</div>
  <p class="pb-art-summary">${esc(it.summary)}</p>
  <div class="pb-art-actions">
    <a class="btn btn-primary" href="${esc(it.url)}" rel="noopener">查看原文 ↗</a>
    <a class="btn btn-ghost" href="/?variant=b">← 全部成果</a>
  </div>
  <div class="pb-art-src">原文链接：<a href="${esc(it.url)}" rel="noopener">${esc(it.url)}</a></div>
</article>
${shareBar(it)}`
  return wrapVariant(detailLayout(site, it, body), 'b')
}

// ---------------------------------------------------------------------------
// 路由层入口
// ---------------------------------------------------------------------------

export function renderListVariant(site, items, variant) {
  return variant === 'a' ? renderListA(site, items) : renderListB(site, items)
}

export function renderDetailVariant(site, it, variant) {
  return variant === 'a' ? renderDetailA(site, it) : renderDetailB(site, it)
}
