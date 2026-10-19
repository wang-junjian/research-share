// ===========================================================================
// PROTOTYPE —— 详情页「上一条 / 下一条」导航的三个候选设计，用完即弃。
//
// 三个变体挂在既有 /item/:id 路由上，经 ?variant=A|B|C 切换（仅非
// production 环境，server.js 详情路由里有开关），底部浮动条循环切换。
//   A · 页缘边注：概览段左右两侧的竖排边注（用户直觉方案）
//   B · 视口箭轨：视口左右缘的固定箭头钉，悬停滑出标题卡（不进文档流）
//   C · 报章续读栏：概览正下方的通栏双格卡片（报纸上一版/下一版）
//
// 邻居语义：列表按日期倒序，「上一条」= 列表中排在前面（更新），
// 「下一条」= 排在后面（更早）。定稿后本文件删除，胜出的变体重写进
// render.js（render.js 里的 slots 参数是留给本文件的原型接缝）。
// ===========================================================================

import { esc, truncate, renderDetail } from './render.js'

const VARIANT_NAMES = { A: '页缘边注', B: '视口箭轨', C: '报章续读栏' }

const md = (date) => (date.length >= 10 ? date.slice(5) : date)

// ---------------------------------------------------------------------------
// 变体 A · 页缘边注：概览左右两侧的竖排条（中文竖排，杂志边注笔法）。
// 窄屏（<900px）竖条没有容身之处，退化为概览下方的横排签（.pna-mini）。
// ---------------------------------------------------------------------------
function variantA(prev, next) {
  const rail = (sib, dir, kick) =>
    `<a class="pna pna-${dir}" href="/item/${sib.id}">
  <span class="pna-kick">${kick}</span>
  <span class="pna-title">${esc(truncate(sib.title, 16))}</span>
  <span class="pna-date">${esc(md(sib.date))}</span>
</a>`
  const chip = (sib, kick, arrow) =>
    sib
      ? `<a href="/item/${sib.id}">${arrow} ${kick} · ${esc(truncate(sib.title, 18))}</a>`
      : `<span class="pna-mini-none">${arrow} ${kick} · 没有了</span>`
  return {
    summaryBefore: prev ? rail(prev, 'prev', '上一条') : '',
    summaryAfter:
      (next ? rail(next, 'next', '下一条') : '') +
      `<div class="pna-mini">${chip(prev, '上一条', '←')}${chip(next, '下一条', '→')}</div>`,
    bodyEnd: '',
  }
}

// ---------------------------------------------------------------------------
// 变体 B · 视口箭轨：视口左右缘垂直居中的墨块箭头，悬停/聚焦时滑出
// 邻居标题卡。不进文档流，滚动全程可达；窄屏挪到下方两角、只留箭头。
// ---------------------------------------------------------------------------
function variantB(prev, next) {
  const rail = (sib, dir, kick, arrow) =>
    `<a class="pnb pnb-${dir}" href="/item/${sib.id}">
  <span class="pnb-arrow">${arrow}</span>
  <span class="pnb-card">
    <span class="pnb-kick">${kick}</span>
    <span class="pnb-title">${esc(truncate(sib.title, 40))}</span>
    <span class="pnb-meta">${esc(sib.no)} · ${esc(md(sib.date))}</span>
  </span>
</a>`
  return {
    summaryBefore: '',
    summaryAfter: '',
    bodyEnd: (prev ? rail(prev, 'prev', '上一条 · 更新', '←') : '') + (next ? rail(next, 'next', '下一条 · 更早', '→') : ''),
  }
}

// ---------------------------------------------------------------------------
// 变体 C · 报章续读栏：概览正下方的通栏双格，报头双细线收口，
// 中间一道纸线分隔。到头的一侧给一句「没有了」，不放空格子。
// ---------------------------------------------------------------------------
function variantC(prev, next) {
  const cell = (sib, dir, kick, arrow) =>
    sib
      ? `<a class="pnc-cell pnc-${dir}" href="/item/${sib.id}">
  <span class="pnc-kick">${dir === 'prev' ? arrow + ' ' : ''}${kick}${dir === 'next' ? ' ' + arrow : ''}</span>
  <span class="pnc-title">${esc(truncate(sib.title, 30))}</span>
  <span class="pnc-meta">${esc(sib.no)} · ${esc(md(sib.date))}</span>
</a>`
      : `<span class="pnc-cell pnc-${dir} pnc-empty"><span class="pnc-kick">${kick}</span><span class="pnc-title">—— 没有了 ——</span></span>`
  return {
    summaryBefore: '',
    summaryAfter: `<nav class="pnc" aria-label="上一条 / 下一条">${cell(prev, 'prev', '上一条', '←')}${cell(next, 'next', '下一条', '→')}</nav>`,
    bodyEnd: '',
  }
}

// ---------------------------------------------------------------------------
// 样式：全部收在原型文件里（base style.css 一行不动），bodyEnd 内联输出。
// ---------------------------------------------------------------------------
const CSS = `<style>
/* ---- 公共：概览定位容器（变体 A 的边注挂点） ---- */
.summary-zone { position: relative; }

/* ---- 变体 A · 页缘边注 ---- */
.pna {
  position: absolute; top: 2px; bottom: 2px; width: 44px;
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  padding: 12px 6px; box-sizing: border-box;
  border: 1px solid var(--paper-line); background: #faf8f2;
  text-decoration: none;
}
.pna-prev { right: calc(100% + 24px); }
.pna-next { left: calc(100% + 24px); }
.pna:hover { border-color: var(--pub-accent); background: var(--pub-accent-soft); }
.pna-kick {
  writing-mode: vertical-rl; font-size: 10.5px; letter-spacing: .32em;
  color: #8d8fa0;
}
.pna-title {
  writing-mode: vertical-rl; flex: 1; min-height: 0; overflow: hidden;
  font-family: var(--font-display); font-size: 15px; letter-spacing: .06em;
  color: var(--ink);
}
.pna-date { writing-mode: vertical-rl; font-family: var(--mono); font-size: 10px; color: #8d8fa0; }
.pna-mini { display: none; }
@media (max-width: 900px) {
  .pna { display: none; }
  .pna-mini { display: flex; gap: 10px; margin-top: 20px; }
  .pna-mini a, .pna-mini-none {
    flex: 1; min-width: 0; padding: 10px 12px; box-sizing: border-box;
    border: 1px solid var(--paper-line); background: #faf8f2;
    font-size: 13px; color: var(--ink-2); text-decoration: none;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pna-mini a:last-child, .pna-mini-none:last-child { text-align: right; }
  .pna-mini a:hover { border-color: var(--pub-accent); color: var(--pub-accent); }
}

/* ---- 变体 B · 视口箭轨 ---- */
.pnb {
  position: fixed; top: 50%; transform: translateY(-50%); z-index: 60;
  display: flex; align-items: stretch;
  text-decoration: none;
}
.pnb-prev { left: 0; }
.pnb-next { right: 0; flex-direction: row-reverse; }
.pnb-arrow {
  display: flex; align-items: center; justify-content: center;
  width: 42px; height: 62px;
  background: var(--ink); color: #f4f2ec; font-size: 19px;
}
.pnb-prev .pnb-arrow { border-radius: 0 8px 8px 0; }
.pnb-next .pnb-arrow { border-radius: 8px 0 0 8px; }
.pnb:hover .pnb-arrow, .pnb:focus-visible .pnb-arrow { background: var(--pub-accent); }
.pnb-card {
  display: block; max-width: 0; overflow: hidden; opacity: 0;
  padding: 10px 0; box-sizing: border-box;
  background: #fff; border: 1px solid var(--paper-line);
  transition: max-width .28s ease, opacity .28s ease, padding .28s ease;
}
.pnb:hover .pnb-card, .pnb:focus-visible .pnb-card { max-width: 250px; opacity: 1; padding: 10px 14px; }
.pnb-kick, .pnb-title, .pnb-meta { display: block; width: 218px; box-sizing: border-box; }
.pnb-kick { font-size: 11px; letter-spacing: .22em; color: #8d8fa0; }
.pnb-title {
  margin: 5px 0; font-family: var(--font-display); font-size: 15px;
  line-height: 1.5; color: var(--ink);
}
.pnb-meta { font-family: var(--mono); font-size: 11px; color: #8d8fa0; }
@media (max-width: 700px) {
  .pnb { top: auto; bottom: 86px; transform: none; }
  .pnb-arrow { width: 38px; height: 38px; border-radius: 50%; font-size: 16px; }
  .pnb-card { display: none; }
}

/* ---- 变体 C · 报章续读栏 ---- */
.pnc {
  display: grid; grid-template-columns: 1fr 1fr;
  margin-top: 36px;
  border-top: 1px solid var(--ink); border-bottom: 1px solid var(--ink);
  box-shadow:
    0 3px 0 -1.5px #f4f2ec, 0 4px 0 -1px var(--ink),
    0 -3px 0 -1.5px #f4f2ec, 0 -4px 0 -1px var(--ink);
}
.pnc-cell { display: block; padding: 16px 18px 15px; text-decoration: none; }
.pnc-prev { border-right: 1px solid var(--paper-line); }
.pnc-next { text-align: right; }
a.pnc-cell:hover { background: var(--pub-accent-soft); }
.pnc-kick { font-size: 11px; letter-spacing: .26em; color: #8d8fa0; }
a.pnc-cell:hover .pnc-kick { color: var(--pub-accent); }
.pnc-title {
  display: block; margin: 6px 0 5px;
  font-family: var(--font-display); font-size: 17px; line-height: 1.5;
  color: var(--ink);
}
.pnc-meta { font-family: var(--mono); font-size: 11px; color: #8d8fa0; }
.pnc-empty .pnc-title { color: var(--pub-idx); font-size: 14px; }
@media (max-width: 560px) {
  .pnc { grid-template-columns: 1fr; }
  .pnc-prev { border-right: none; border-bottom: 1px solid var(--paper-line); }
  .pnc-next { text-align: left; }
}

/* ---- 浮动切换条（原型设施，高对比墨块，不属于被评估的设计） ---- */
.pn-switch {
  position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 90;
  display: flex; align-items: center; gap: 10px;
  padding: 6px 8px; border-radius: 999px;
  background: #182142; color: #f4f2ec;
  box-shadow: 0 6px 24px rgba(24, 33, 66, .4);
  font-family: var(--mono); font-size: 12.5px;
}
.pn-switch-tag {
  padding: 2px 7px; border-radius: 999px;
  background: var(--pub-accent); color: #fff;
  font-size: 10px; letter-spacing: .18em;
}
.pn-switch button {
  width: 30px; height: 30px; border-radius: 50%; cursor: pointer;
  border: 1px solid rgba(244, 242, 236, .4); background: transparent; color: inherit;
  font-size: 14px; line-height: 1;
}
.pn-switch button:hover { background: rgba(244, 242, 236, .14); }
.pn-switch-label { min-width: 132px; text-align: center; }
</style>`

// 浮动切换条：←/→ 按钮与方向键循环（输入框聚焦时不劫持方向键），
// 改写 ?variant= 参数跳转，变体可分享、刷新不丢。
const SWITCHER_JS = `<script>
(function () {
  var order = ['A', 'B', 'C']
  var q = new URLSearchParams(location.search)
  var cur = (q.get('variant') || 'A').toUpperCase()
  function go(d) {
    var i = (order.indexOf(cur) + d + order.length) % order.length
    q.set('variant', order[i])
    location.search = q.toString()
  }
  var btns = document.querySelectorAll('[data-pn-dir]')
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function () { go(Number(this.getAttribute('data-pn-dir'))) })
  }
  document.addEventListener('keydown', function (e) {
    var t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (e.key === 'ArrowLeft') go(-1)
    else if (e.key === 'ArrowRight') go(1)
  })
})()
</script>`

function switcher(variant) {
  return `<div class="pn-switch" role="group" aria-label="原型变体切换">
  <span class="pn-switch-tag">PROTO</span>
  <button type="button" data-pn-dir="-1" aria-label="上一个变体">←</button>
  <span class="pn-switch-label">${variant} · ${VARIANT_NAMES[variant]}</span>
  <button type="button" data-pn-dir="1" aria-label="下一个变体">→</button>
</div>
${SWITCHER_JS}`
}

const VARIANTS = { A: variantA, B: variantB, C: variantC }

export function renderDetailProto(site, it, { variant, prev, next }) {
  const build = VARIANTS[variant] || variantA
  const slots = build(prev, next)
  return renderDetail(site, it, {
    ...slots,
    bodyEnd: CSS + slots.bodyEnd + switcher(VARIANTS[variant] ? variant : 'A'),
  })
}
