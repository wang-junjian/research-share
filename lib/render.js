// ---------------------------------------------------------------------------
// 页面模板 module（视觉见 assets/style.css：杂志特稿 —— 冷调纸面 + 海军蓝）
//
// 纯函数群：不读环境变量、不碰网络，站点配置由调用方以 site 对象传入：
//   site = { name, desc, url, favicon }
// 因此可以在不启动 HTTP 的情况下直接快照测试（见 test/render.test.js）。
//
// 公开页（列表/详情/错误）走 <body class="page-pub">，杂志特稿的调色板
// 与组件覆盖都收在这个作用域下；后台（admin.html）不进这个作用域，
// 沿用 :root 的纸感朱红。
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

function fmtMD(date) {
  return date.length >= 10 ? date.slice(5) : date
}

function yearOf(date) {
  return date.slice(0, 4)
}

// 顶栏「登录」入口的线性人物图标（13px，与顶栏同一套笔法）
const ICON_USER = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M5 20c1.2-3.2 4-4.8 7-4.8s5.8 1.6 7 4.8"/></svg>'

// 分享面板的六个图标（20px，线性，与站内图标同一套笔法）
const shareIcon = (paths) => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>'
const ICON_LINK = shareIcon('<path d="M10.5 13.5a4.5 4.5 0 0 0 6.4.5l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.5"/><path d="M13.5 10.5a4.5 4.5 0 0 0-6.4-.5L4.5 12.6a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5"/>')
const ICON_EXTERNAL = shareIcon('<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M19 13.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5.5"/>')
const ICON_EYE = shareIcon('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>')
const ICON_COPY_IMG = shareIcon('<rect x="3" y="3" width="13" height="13" rx="2"/><circle cx="7.4" cy="7.4" r="1.3"/><path d="m3 13 2.6-2.6a1.6 1.6 0 0 1 2.3 0L11 13.5"/><path d="M18 20.5h1.5a2 2 0 0 0 2-2V17"/><path d="M9 20.5h6"/>')
const ICON_IMG_TEXT = shareIcon('<rect x="3" y="2.5" width="18" height="13" rx="2"/><circle cx="8" cy="7.5" r="1.4"/><path d="m3.6 15.5 3.4-3.4a1.6 1.6 0 0 1 2.3 0l3.3 3.3"/><path d="M6 19.5h12"/><path d="M6 22h7"/>')
const ICON_TEXT = shareIcon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9.4 13h5.2"/><path d="M9.4 17h3.4"/>')

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

export function layout(site, { title, description, ogType = 'website', canonical = '', ogImage = '', body, script = '', shareEntry = false }) {
  // 登录态（GLOSSARY: 登录态）只存在于浏览器 localStorage，SSR 不感知身份：
  // 顶栏默认渲染「登录」，由登录态门控（cloud.js 的 App.authGate，GLOSSARY:
  // 登录态门控）在客户端读一次会话后分发：auth-chip 挂件把顶栏替换为
  // 头像+用户名。site.publicConfigJson 缺失时（演示模式）不加载 SDK，
  // 顶栏保持默认入口。配置串已在装配层转义（< → \u003c），这里原样内联。
  // shareEntry（首页与详情页开启）：顶栏输出「＋ 分享」挂载点（SSR 默认 hidden），
  // quick-share 挂件在门控确认会话后显示并接管点击。挂载点放在
  // [data-auth-chip] 之外 —— auth-chip 会整体替换 nav 的 innerHTML。
  // data.js（浏览器数据面，GLOSSARY: 浏览器数据面）在 cloud.js 之后、消费方之前加载。
  const authScripts = site.publicConfigJson
    ? `<script>window.PUBLIC_CONFIG = ${site.publicConfigJson}</script>
<script src="/assets/vendor/workbuddy-cloud-sdk.global.js" defer></script>
<script src="/assets/cloud.js" defer></script>
<script src="/assets/data.js" defer></script>
<script src="/assets/auth-chip.js" defer></script>${shareEntry ? '\n<script src="/assets/quick-share.js" defer></script>' : ''}`
    : ''
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
<script src="/assets/constants.js" defer></script>
<script src="/assets/track.js" defer></script>
</head>
<body class="page-pub">
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
    ${shareEntry ? '<button class="topbar-link topbar-share" type="button" data-share-entry hidden><b>＋</b>&nbsp;分享</button>' : ''}
    <nav class="topbar-nav" data-auth-chip>
      <a class="topbar-link" href="/admin">${ICON_USER}<span>登录</span></a>
    </nav>
  </div>
</header>
<main class="page">
${body}
</main>
${footNote(site)}
${OPTOUT_SCRIPT}
${authScripts}
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

// 刊头核心指标：从条目列表物化「这个应用有多少内容、谁在写、何时更新」。
// 全部由既有字段算出，不需要任何新数据。
function mastFacts(items) {
  const years = [...new Set(items.map((it) => yearOf(it.date)))].sort()
  const yearSpan = years.length > 1 ? `${years[0]}–${years[years.length - 1]}` : years[0]
  const owners = new Set(items.map((it) => it.owner_name).filter(Boolean)).size
  const latest = items[0] // 列表按日期倒序，第一条即最新
  const cell = (v, k) => `<div class="mast-fact"><span class="fv">${esc(v)}</span><span class="fk">${esc(k)}</span></div>`
  return `<div class="mast-facts">
    ${cell(items.length, '收录成果')}
    ${cell(owners || '—', '执笔作者')}
    ${cell(yearSpan, '时间跨度')}
    ${cell(fmtMD(latest.date), '最近更新')}
  </div>`
}

export function renderList(site, items) {
  if (!items.length) {
    return layout(site, {
      title: site.name + ' · 研究笔记',
      description: site.desc,
      canonical: site.url + '/',
      shareEntry: true,
      body: '<div class="empty"><h3>暂无研究成果</h3><p>点击顶栏「分享」录入第一条成果，或从后台录入。</p></div>',
    })
  }

  const [hero, ...rest] = items
  // 站内导航用相对路径（同源页面跳转）；对外的公共身份 URL 由条目存储
  // 物化为 page_url，此处不消费
  const cols = rest
    .map(
      (it, i) => `<a class="col-item" href="/item/${it.id}">
  <span class="col-idx">${String(i + 2).padStart(2, '0')}</span>
  <span class="col-body">
    <span class="col-title">${esc(it.title)}</span>
    <span class="col-deck">${esc(it.summary)}</span>
    <span class="col-meta">${esc(it.no)} · ${esc(it.date)}${it.owner_name ? ' · ' + esc(it.owner_name) : ''}</span>
  </span>
</a>`
    )
    .join('\n')

  return layout(site, {
    title: site.name + ' · 研究笔记',
    description: site.desc,
    canonical: site.url + '/',
    shareEntry: true,
    body: `<div class="masthead">
  <h1 class="mast-title">研究成果</h1>
  <div class="mast-sub">${esc(site.desc)}</div>
  ${mastFacts(items)}
</div>
<a class="feat" href="/item/${hero.id}">
  <div class="feat-tag">最新成果 · Feature</div>
  <h2 class="feat-title">${esc(hero.title)}</h2>
  <p class="feat-deck">${esc(hero.summary)}</p>
  <div class="feat-meta">${esc(hero.no)} · ${esc(hero.date)}${hero.owner_name ? ' · 整理：' + esc(hero.owner_name) : ''} · 阅读全文 →</div>
</a>
<div class="cols">
${cols}
</div>`,
  })
}

// 详情页底部片段（链接型/文档型同一形态）：主按钮「查看原文 ↗」+「← 全部成果」，
// 下挂原文链接行。url 已由条目存储物化（文档型即托管地址），这里只消费。
// 文档型不再内嵌 iframe：读者经「查看原文」直达托管地址，隔离由托管路由的
// CSP sandbox 响应头独力承担（见 docs/adr/0004 修订二）。
function detailFoot(it) {
  return `<div class="detail-foot">
    <a class="btn btn-primary" href="${esc(it.url)}" rel="noopener">查看原文 ↗</a>
    <a class="btn btn-ghost" href="/">← 全部成果</a>
  </div>
  <div class="detail-src">原文链接：<a href="${esc(it.url)}" rel="noopener">${esc(it.url)}</a></div>`
}

// 相邻条目导航（路由按列表序注入：prev = 更新的一篇，next = 更早的一篇）。
// 桌面端：概览两侧的墨色箭头页签，悬停/聚焦滑出邻居标题卡（样式见
// style.css「相邻条目导航」）；窄屏页缘没有页签的容身之处，退化为概览
// 下方的横排签（.sibnav-mini）。到头的一侧不渲染页签，只留「没有了」签。
function sibRail(sib, dir, kick, arrow) {
  if (!sib) return ''
  return `<a class="sibnav sibnav-${dir}" href="/item/${sib.id}">
  <span class="sibnav-arrow" aria-hidden="true">${arrow}</span>
  <span class="sibnav-card">
    <span class="sibnav-kick">${kick}</span>
    <span class="sibnav-title">${esc(truncate(sib.title, 40))}</span>
    <span class="sibnav-meta">${esc(sib.no)} · ${esc(fmtMD(sib.date))}</span>
  </span>
</a>`
}

function sibChip(sib, kick, arrow) {
  return sib
    ? `<a href="/item/${sib.id}">${arrow} ${kick} · ${esc(truncate(sib.title, 18))}</a>`
    : `<span class="sibnav-mini-none">${arrow} ${kick} · 没有了</span>`
}

export function renderDetail(site, it, nav = {}) {
  const { prev = null, next = null } = nav
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

  // 两种形态（链接型/文档型）的详情页主体完全一致：url 都由条目存储物化好
  // （文档型即托管地址），这里只消费。
  const main = detailFoot(it)

  // 有相邻条目时，概览段外套相对定位容器，左右页签挂在容器两缘
  const summary = prev || next
    ? `<div class="summary-zone">${sibRail(prev, 'prev', '上一条 · 更新', '←')}<p class="detail-summary">${esc(it.summary)}</p>${sibRail(next, 'next', '下一条 · 更早', '→')}<div class="sibnav-mini">${sibChip(prev, '上一条', '←')}${sibChip(next, '下一条', '→')}</div></div>`
    : `<p class="detail-summary">${esc(it.summary)}</p>`

  return layout(site, {
    title: it.title,
    description: desc,
    ogType: 'article',
    canonical,
    ogImage,
    shareEntry: true,
    script: '<script src="/assets/share.js" defer></script>',
    body: `<article class="article">
  <div class="art-kicker"><span>研究成果 · ${esc(yearOf(it.date))}</span></div>
  <h1 class="detail-title">${esc(it.title)}</h1>
  <div class="art-meta">${esc(it.no)} · ${esc(it.date)}${it.owner_name ? ' · 整理：' + esc(it.owner_name) : ''}</div>
  ${summary}
  ${main}
</article>

<div class="sharebar" ${shareData}>
  <div class="sharebar-head"><span class="sharebar-label">分享</span></div>
  <div class="share-actions">
    <button class="share-act" type="button" data-act="copy-poster">
      <span class="share-act-ico">${ICON_COPY_IMG}</span>
      <span class="share-act-txt">
        <span class="share-act-name">复制海报图</span>
        <span class="share-act-desc">图片直接粘贴进聊天</span>
      </span>
    </button>
    <button class="share-act" type="button" data-act="show-poster">
      <span class="share-act-ico">${ICON_EYE}</span>
      <span class="share-act-txt">
        <span class="share-act-name">显示海报图</span>
        <span class="share-act-desc">预览长图，可保存下载</span>
      </span>
    </button>
    <button class="share-act" type="button" data-act="copy-src">
      <span class="share-act-ico">${ICON_EXTERNAL}</span>
      <span class="share-act-txt">
        <span class="share-act-name">复制原文链接</span>
        <span class="share-act-desc">原始出处的地址</span>
      </span>
    </button>
    <button class="share-act" type="button" data-act="copy-link">
      <span class="share-act-ico">${ICON_LINK}</span>
      <span class="share-act-txt">
        <span class="share-act-name">复制本页链接</span>
        <span class="share-act-desc">粘贴到微信即可发送</span>
      </span>
    </button>
    <button class="share-act" type="button" data-act="copy-poster-link">
      <span class="share-act-ico">${ICON_IMG_TEXT}</span>
      <span class="share-act-txt">
        <span class="share-act-name">复制海报图+原文链接</span>
        <span class="share-act-desc">图片与原文链接一起复制</span>
      </span>
    </button>
    <button class="share-act" type="button" data-act="copy-text">
      <span class="share-act-ico">${ICON_TEXT}</span>
      <span class="share-act-txt">
        <span class="share-act-name">复制文字+原文链接</span>
        <span class="share-act-desc">含标题、概览与链接</span>
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
