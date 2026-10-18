// ---------------------------------------------------------------------------
// 页面模板 module（视觉见 assets/style.css：浅色纸感 + 朱红批注）
//
// 纯函数群：不读环境变量、不碰网络，站点配置由调用方以 site 对象传入：
//   site = { name, desc, url, favicon }
// 因此可以在不启动 HTTP 的情况下直接快照测试（见 test/render.test.js）。
// ---------------------------------------------------------------------------

export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function truncate(s, n) {
  const t = String(s ?? '').trim()
  return t.length <= n ? t : t.slice(0, n).trimEnd() + '…'
}

// 日期归一化已由条目存储完成（GLOSSARY: 条目存储），render 只对物化的
// date 字符串（YYYY-MM-DD）做 slice 级截取，不再导出 fmtDate。

// 年份已在 tag 中，正文只显示 月-日
function fmtMD(date) {
  return date.length >= 10 ? date.slice(5) : date
}

function yearTag(date) {
  const y = date.slice(0, 4)
  const now = String(new Date().getFullYear())
  return `<span class="tag ${y === now ? 't-now' : 't-past'}">${esc(y)}</span>`
}

// 成果编号：物化字段 no（NO.007），稳定不随排序变化，像笔记的索引号
function itemNo(it) {
  return `<span class="entry-no">${esc(it.no)}</span>`
}

function byLine(it) {
  return it.owner_name ? `<span class="entry-by">${esc(it.owner_name)}</span>` : ''
}

// 视图状态在 <head> 里就写进 documentElement，首次绘制即生效，切换不闪
const VIEW_STATE_SCRIPT = `<script>try{if(localStorage.getItem('rs:view')==='list')document.documentElement.setAttribute('data-view','list')}catch(e){}</script>`

const ICON_GRID = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>'
const ICON_LIST = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>'
const ICON_EDIT = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'

// 分享面板的四个图标（20px，线性，与站内图标同一套笔法）
const shareIcon = (paths) => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>'
const ICON_LINK = shareIcon('<path d="M10.5 13.5a4.5 4.5 0 0 0 6.4.5l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.5"/><path d="M13.5 10.5a4.5 4.5 0 0 0-6.4-.5L4.5 12.6a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5"/>')
const ICON_EYE = shareIcon('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>')
const ICON_COPY_IMG = shareIcon('<rect x="3" y="3" width="13" height="13" rx="2"/><circle cx="7.4" cy="7.4" r="1.3"/><path d="m3 13 2.6-2.6a1.6 1.6 0 0 1 2.3 0L11 13.5"/><path d="M18 20.5h1.5a2 2 0 0 0 2-2V17"/><path d="M9 20.5h6"/>')
const ICON_IMG_TEXT = shareIcon('<rect x="3" y="2.5" width="18" height="13" rx="2"/><circle cx="8" cy="7.5" r="1.4"/><path d="m3.6 15.5 3.4-3.4a1.6 1.6 0 0 1 2.3 0l3.3 3.3"/><path d="M6 19.5h12"/><path d="M6 22h7"/>')
const ICON_TEXT = shareIcon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9.4 13h5.2"/><path d="M9.4 17h3.4"/>')

// 视图切换：只改 documentElement 上的 data-view，排布完全交给 CSS
const VIEW_SWITCH_SCRIPT = `<script>
(function () {
  var btns = document.querySelectorAll('.view-btn')
  if (!btns.length) return
  function current() {
    return document.documentElement.getAttribute('data-view') === 'list' ? 'list' : 'grid'
  }
  function apply(v) {
    if (v === 'list') document.documentElement.setAttribute('data-view', 'list')
    else document.documentElement.removeAttribute('data-view')
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-view') === v
      btns[i].classList.toggle('is-on', on)
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false')
    }
  }
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function () {
      var v = this.getAttribute('data-view')
      apply(v)
      try { localStorage.setItem('rs:view', v) } catch (e) {}
    })
  }
  apply(current())
})()
</script>`

// 页脚：隐私说明与「一键退出统计」入口。退出写 localStorage + cookie，
// assets/track.js 在每次入队前都会重读这个开关，点了立刻生效（不用刷新）。
function footNote(site) {
  return `<p class="foot-note"><span>${esc(site.name)} · 微信内转发本页即可分享卡片</span><span class="foot-dot">·</span><a class="foot-opt" href="#" data-optout title="本站只用随机 id 统计访问量：不记录 IP、不记录个人信息、不跨站追踪。点此可退出统计。">匿名统计 · 可退出</a></p>`
}

const OPTOUT_SCRIPT = `<script>
(function () {
  var a = document.querySelector('.foot-opt')
  if (!a) return
  function off() {
    try {
      return localStorage.getItem('rs:optout') === '1' || /(?:^|; )rs_optout=1/.test(document.cookie)
    } catch (e) { return false }
  }
  function paint() {
    var o = off()
    a.textContent = o ? '已退出统计 · 点此恢复' : '匿名统计 · 可退出'
    a.setAttribute('aria-pressed', o ? 'true' : 'false')
  }
  a.addEventListener('click', function (e) {
    e.preventDefault()
    var next = off() ? '0' : '1'
    try {
      localStorage.setItem('rs:optout', next)
      document.cookie = 'rs_optout=' + next + ';path=/;max-age=31536000;SameSite=Lax'
    } catch (err) {}
    paint()
  })
  paint()
})()
</script>`

export function layout(site, { title, description, ogType = 'website', canonical = '', ogImage = '', body, script = '', viewScript = false }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="${site.favicon}">
<meta property="og:site_name" content="${esc(site.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="${esc(ogType)}">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:image" content="${esc(ogImage)}">` : ''}
${canonical ? `<meta property="og:url" content="${esc(canonical)}">\n<link rel="canonical" href="${esc(canonical)}">` : ''}
<link rel="stylesheet" href="/assets/style.css">
${viewScript ? VIEW_STATE_SCRIPT : ''}
<script src="/assets/track.js" defer></script>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <div class="brand">
      <a href="/">
        <span class="logo-mark">研</span>
        <span class="brand-name">${esc(site.name)}</span>
      </a>
      <span class="brand-tag">RESEARCH NOTES</span>
    </div>
    <div class="topbar-spacer"></div>
    <nav class="topbar-nav">
      <a class="topbar-link" href="/admin">${ICON_EDIT}<span>管理</span></a>
    </nav>
  </div>
</header>
<main class="page">
${body}
</main>
${footNote(site)}
${OPTOUT_SCRIPT}
${script}
<script>
(function () {
  var q = new URLSearchParams(location.search)
  if (q.has('code') || q.has('error')) {
    location.replace('/admin' + location.search + location.hash)
  }
})()
</script>
</body>
</html>`
}

export function renderList(site, items) {
  const cards = items.length
    ? items
        .map(
          // 站内导航用相对路径（同源页面跳转）；对外的公共身份 URL 由条目存储
          // 物化为 page_url，此处不消费
          (it) => `<a class="entry" href="/item/${it.id}">
  <div class="entry-body">
    <div class="entry-top">
      ${itemNo(it)}
      ${yearTag(it.date)}
    </div>
    <div class="entry-title">${esc(it.title)}</div>
    <div class="entry-summary">${esc(it.summary)}</div>
    <div class="entry-foot">
      <span class="entry-date">${esc(fmtMD(it.date))}</span>
      ${byLine(it)}
    </div>
  </div>
  <div class="entry-arrow">→</div>
</a>`
        )
        .join('\n')
    : '<div class="empty"><h3>暂无研究成果</h3><p>从后台录入第一条成果后，这里会立即出现。</p></div>'

  const viewSwitch = `<div class="view-switch" role="group" aria-label="切换视图">
    <button type="button" class="view-btn" data-view="grid" aria-pressed="true" title="网格视图" aria-label="网格视图">${ICON_GRID}</button>
    <button type="button" class="view-btn" data-view="list" aria-pressed="false" title="列表视图" aria-label="列表视图">${ICON_LIST}</button>
  </div>`

  return layout(site, {
    title: site.name + ' · 研究笔记',
    description: site.desc,
    canonical: site.url + '/',
    viewScript: true,
    // fit.js 不加 defer：它紧跟在卡片后面解析，在首绘之前就把摘要行数算好，
    // 因此看不到「先按 fallback 行数画一帧、再跳成正确行数」的闪烁。
    script: '<script src="/assets/fit.js"></script>' + VIEW_SWITCH_SCRIPT,
    body: `<div class="page-head">
  <div class="page-title">研究成果</div>
  <div class="page-sub">${items.length ? `共 ${items.length} 条 · 按日期倒序` : '研究笔记 · 持续更新'}</div>
  ${items.length ? viewSwitch : ''}
</div>
<div class="entry-list">
${cards}
</div>`,
  })
}

export function renderDetail(site, it) {
  const desc = truncate(it.summary, 80)
  // 条目公共身份（页面 URL / OG 封面 URL）由条目存储物化，这里只消费
  const canonical = it.page_url
  const ogImage = it.og_image
  // 分享条把数据挂在 data-* 上，由 assets/share.js 读取，避免重复请求
  const shareData = [
    `data-share`,
    `data-title="${esc(it.title)}"`,
    // data-summary 给海报用（限 220 字，免得版面被撑爆）；data-overview 是纯文字分享
    // 要用的完整概览 —— 两者口径不同，别合并
    `data-summary="${esc(truncate(it.summary, 220))}"`,
    `data-overview="${esc(it.summary)}"`,
    `data-date="${esc(it.date)}"`,
    `data-by="${esc(it.owner_name || '')}"`,
    // data-no 是分享条的数字编号契约（assets/share.js 拼 'NO.' 前缀与文件名），
    // 直接读物化字段 no_num，不反向解析 no
    `data-no="${esc(it.no_num)}"`,
    `data-url="${esc(canonical)}"`,
    `data-src="${esc(it.url || '')}"`,
  ].join(' ')

  return layout(site, {
    title: it.title,
    description: desc,
    ogType: 'article',
    canonical,
    ogImage,
    script: '<script src="/assets/share.js" defer></script>',
    body: `<article class="detail card-panel">
  <div class="entry-top">
    ${itemNo(it)}
    ${yearTag(it.date)}
    <span class="entry-date">${esc(it.date)}</span>
    ${byLine(it)}
  </div>
  <h1 class="detail-title">${esc(it.title)}</h1>
  <p class="detail-summary">${esc(it.summary)}</p>
  <hr class="detail-rule">
  <div class="detail-foot">
    <a class="btn btn-primary" href="${esc(it.url)}" rel="noopener">查看原文 ↗</a>
    <a class="btn btn-ghost" href="/">← 全部成果</a>
  </div>
  <div class="detail-src">原文链接：<a href="${esc(it.url)}" rel="noopener">${esc(it.url)}</a></div>
</article>

<div class="sharebar" ${shareData}>
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
<div data-poster-mount></div>`,
  })
}

export function renderError(site, msg) {
  return layout(site, {
    title: '出错了 · ' + site.name,
    description: '页面暂时不可用',
    body: `<div class="empty" style="margin-top:48px"><h3>${esc(msg)}</h3><p><a href="/">返回研究成果列表</a></p></div>`,
  })
}
