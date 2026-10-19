// ---------------------------------------------------------------------------
// 【原型 PROTOTYPE · 可整文件丢弃】首页「快速录入分享」入口 · 第二轮
//
// 第一轮结论：A（顶栏入口 + 居中模态）胜出；入口按钮定名「分享」。
// 本轮问题：发布后如何**一步完成分享**？两个结构互斥的变体，?variant=A1|A2：
//   A1 就地分享面板 —— 提交后模态原地切换为「已发布」成功态 + 分享按钮组
//      （复用详情页 sharebar 的样式与动作口径，零跳转）
//   A2 发布后直达详情 —— 提交后给「去详情页分享 →」，详情页本就有完整分享条
//      （零新组件，但多一次跳转；原型跳到当前最新一条模拟）
//
// 假设（待正式实现时验证）：
//   · 入口只对已登录用户可见 —— 原型恒显；正式实现复用 auth-chip 的会话读取门控
//   · 发布复用 admin 的浏览器 SDK 直写 research_items，拿到 id 后拼 page_url；
//     原型一律拦截，A1 的复制动作使用演示编号 /item/0
// ---------------------------------------------------------------------------

const VARIANTS = {
  A1: '就地分享面板',
  A2: '发布后直达详情',
}
const ORDER = ['A1', 'A2']

// 全部样式以 .pqe- 前缀隔离；分享按钮组直接复用全局 .share-* 类（与详情页一致）
const STYLE = `<style>
.pqe-kicker { font-size: 10.5px; letter-spacing: .26em; color: #8d8fa0; text-transform: uppercase; }
.pqe-field input, .pqe-field textarea {
  width: 100%; box-sizing: border-box; background: #fff;
  border: 1px solid var(--paper-line); border-radius: 2px;
  padding: 9px 12px; font: inherit; font-size: 13.5px; color: var(--ink);
}
.pqe-field input:focus, .pqe-field textarea:focus { outline: none; border-color: var(--pub-accent); }
.pqe-field textarea { min-height: 84px; resize: vertical; line-height: 1.65; }

.pqe-topbtn { cursor: pointer; font: inherit; }
.pqe-topbtn b { color: var(--pub-accent); font-weight: 600; }
.pqe-modal[hidden] { display: none; }
.pqe-modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 20px; }
.pqe-modal-mask { position: absolute; inset: 0; background: rgba(24, 33, 66, .38); }
.pqe-modal-card {
  position: relative; width: min(560px, 100%); background: #f4f2ec;
  border: 1px solid var(--ink); box-shadow: 0 4px 0 -1px var(--ink), 0 24px 60px rgba(24,33,66,.25);
  padding: 26px 28px 22px; max-height: calc(100vh - 60px); overflow: auto;
}
.pqe-modal-title { margin: 6px 0 16px; font-family: var(--font-display); font-weight: 400; font-size: 26px; color: var(--ink); }
.pqe-modal-card .pqe-field { margin-bottom: 10px; }
.pqe-row2 { display: grid; grid-template-columns: 1fr 150px; gap: 10px; }
.pqe-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
.pqe-actions .spacer { flex: 1; }
.pqe-close-x { position: absolute; top: 12px; right: 14px; border: 0; background: none; font-size: 18px; color: #8d8fa0; cursor: pointer; z-index: 1; }
.pqe-close-x:hover { color: var(--ink); }

/* 成功态（A1/A2 共用骨架） */
.pqe-done[hidden] { display: none; }
.pqe-done-no { font-family: var(--mono); font-size: 12px; color: var(--pub-accent); letter-spacing: .06em; }
.pqe-done-title { margin: 6px 0 4px; font-family: var(--font-display); font-weight: 400; font-size: 21px; color: var(--ink); word-break: break-word; }
.pqe-done-url { font-family: var(--mono); font-size: 11.5px; color: #8d8fa0; word-break: break-all; }
.pqe-done .sharebar { margin-top: 16px; padding-top: 4px; border: 0; }
.pqe-done-actions { display: flex; gap: 10px; margin-top: 16px; }
.pqe-done-actions .spacer { flex: 1; }
.pqe-note { margin: 10px 0 0; font-size: 12px; color: var(--ink-2); min-height: 1.4em; }
.pqe-note.is-ok { color: var(--pub-accent); }

/* 浮动切换栏（明显不属于被评估的设计） */
.pqe-switch {
  position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 99;
  display: flex; align-items: center; gap: 12px;
  background: #14161c; color: #f4f2ec; border-radius: 999px;
  padding: 8px 14px; font: 12.5px var(--mono); letter-spacing: .04em;
  box-shadow: 0 10px 30px rgba(0,0,0,.35); user-select: none;
}
.pqe-switch button {
  background: none; border: 1px solid #3a3f4d; color: #f4f2ec; border-radius: 999px;
  width: 26px; height: 26px; cursor: pointer; font: inherit; line-height: 1;
}
.pqe-switch button:hover { background: #2b4be0; border-color: #2b4be0; }
.pqe-switch .tag { opacity: .55; font-size: 10.5px; }
</style>`

// 表单字段四件套：与 admin 录入表单同口径（标题/概览/链接/日期）
const FORM_FIELDS = `
  <div class="pqe-field"><input name="title" type="text" maxlength="120" required placeholder="标题：一句话说清这项研究" autocomplete="off"></div>
  <div class="pqe-field"><textarea name="summary" maxlength="400" placeholder="概览（约 200 字）：研究内容、方法、结论"></textarea></div>
  <div class="pqe-row2">
    <div class="pqe-field"><input name="url" type="url" placeholder="原文链接 https://" autocomplete="off"></div>
    <div class="pqe-field"><input name="date" type="date"></div>
  </div>`

// 分享按钮图标（与 render.js 详情页同一套笔法）
const sIcon = (paths) => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>'
const ICO_LINK = sIcon('<path d="M10.5 13.5a4.5 4.5 0 0 0 6.4.5l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.5"/><path d="M13.5 10.5a4.5 4.5 0 0 0-6.4-.5L4.5 12.6a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5"/>')
const ICO_TEXT = sIcon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9.4 13h5.2"/><path d="M9.4 17h3.4"/>')
const ICO_IMG_TEXT = sIcon('<rect x="3" y="2.5" width="18" height="13" rx="2"/><circle cx="8" cy="7.5" r="1.4"/><path d="m3.6 15.5 3.4-3.4a1.6 1.6 0 0 1 2.3 0l3.3 3.3"/><path d="M6 19.5h12"/><path d="M6 22h7"/>')

// 模态骨架：表单视图 + 成功视图（提交后原地切换）
function modal({ doneHtml }) {
  return `
<div class="pqe-modal" data-pqe-modal hidden>
  <div class="pqe-modal-mask" data-pqe-close></div>
  <div class="pqe-modal-card" role="dialog" aria-modal="true" aria-label="分享新成果">
    <button class="pqe-close-x" type="button" data-pqe-close aria-label="关闭">✕</button>
    <div data-pqe-formview>
      <div class="pqe-kicker">Share · 快速分享</div>
      <h3 class="pqe-modal-title">分享新成果</h3>
      <form data-pqe-form>
        ${FORM_FIELDS}
        <div class="pqe-actions">
          <span class="pqe-note" data-pqe-note></span>
          <span class="spacer"></span>
          <button class="btn btn-ghost" type="button" data-pqe-close>取消</button>
          <button class="btn btn-primary" type="submit">发布</button>
        </div>
      </form>
    </div>
    <div class="pqe-done" data-pqe-done hidden>
      ${doneHtml}
    </div>
  </div>
</div>`
}

// A1：提交后就地出现分享按钮组（复用详情页 sharebar 的动作口径）
function variantA1() {
  return modal({
    doneHtml: `
      <div class="pqe-kicker">已发布 · 立即分享</div>
      <div style="margin-top:14px">
        <span class="pqe-done-no" data-pqe-no>NO.000 · 演示</span>
        <h3 class="pqe-done-title" data-pqe-title></h3>
        <span class="pqe-done-url" data-pqe-url></span>
      </div>
      <div class="sharebar">
        <div class="share-actions">
          <button class="share-act" type="button" data-pqe-copy="link">
            <span class="share-act-ico">${ICO_LINK}</span>
            <span class="share-act-txt">
              <span class="share-act-name">复制本页链接</span>
              <span class="share-act-desc">粘贴到微信即可发送</span>
            </span>
          </button>
          <button class="share-act" type="button" data-pqe-copy="text">
            <span class="share-act-ico">${ICO_TEXT}</span>
            <span class="share-act-txt">
              <span class="share-act-name">复制文字+原文链接</span>
              <span class="share-act-desc">含标题、概览与链接</span>
            </span>
          </button>
          <button class="share-act" type="button" data-pqe-copy="poster">
            <span class="share-act-ico">${ICO_IMG_TEXT}</span>
            <span class="share-act-txt">
              <span class="share-act-name">复制海报图+原文链接</span>
              <span class="share-act-desc">原型不含海报，仅演示位置</span>
            </span>
          </button>
        </div>
      </div>
      <div class="pqe-done-actions">
        <span class="pqe-note" data-pqe-done-note></span>
        <span class="spacer"></span>
        <button class="btn btn-ghost" type="button" data-pqe-again>再分享一条</button>
        <button class="btn btn-primary" type="button" data-pqe-close>完成</button>
      </div>`,
  })
}

// A2：提交后引导去详情页（那里已有完整分享条），零新组件
function variantA2({ latestUrl }) {
  return modal({
    doneHtml: `
      <div class="pqe-kicker">已发布</div>
      <div style="margin-top:14px">
        <span class="pqe-done-no" data-pqe-no>NO.000 · 演示</span>
        <h3 class="pqe-done-title" data-pqe-title></h3>
        <span class="pqe-done-url" data-pqe-url></span>
      </div>
      <p class="pqe-note" style="margin-top:14px">详情页已生成，内含完整分享条（链接 / 文字 / 海报）。<br>原型中此按钮跳到当前最新一条作为演示。</p>
      <div class="pqe-done-actions">
        <span class="spacer"></span>
        <button class="btn btn-ghost" type="button" data-pqe-again>再分享一条</button>
        <a class="btn btn-primary" href="${latestUrl}">去详情页分享 →</a>
      </div>`,
  })
}

// 共享行为：顶栏注入「分享」按钮、模态开合、表单拦截提交 → 成功视图、切换栏
function sharedScript(variant) {
  return `<script>
(function () {
  var nav = document.querySelector('.topbar-nav')
  var modal = document.querySelector('[data-pqe-modal]')
  if (!nav || !modal) return
  var formView = modal.querySelector('[data-pqe-formview]')
  var doneView = modal.querySelector('[data-pqe-done]')
  var form = modal.querySelector('[data-pqe-form]')

  var btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'topbar-link pqe-topbtn'
  btn.innerHTML = '<b>＋</b> 分享'
  nav.prepend(btn)

  function open() {
    formView.hidden = false; doneView.hidden = true
    modal.hidden = false
    var t = form.querySelector('input[name=title]'); if (t) t.focus()
  }
  function close() { modal.hidden = true }
  btn.addEventListener('click', open)
  modal.querySelectorAll('[data-pqe-close]').forEach(function (el) { el.addEventListener('click', close) })
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.hidden) close() })

  var d = form.querySelector('input[name=date]')
  if (d && !d.value) d.value = new Date().toISOString().slice(0, 10)

  // 原型不真正发布：拦截后切到成功视图，编号/链接用演示值
  var MOCK_URL = location.origin + '/item/0'
  form.addEventListener('submit', function (e) {
    e.preventDefault()
    var title = form.querySelector('input[name=title]').value.trim() || '（未命名成果）'
    var summary = form.querySelector('textarea[name=summary]').value.trim()
    var src = form.querySelector('input[name=url]').value.trim()
    doneView.querySelector('[data-pqe-title]').textContent = title
    doneView.querySelector('[data-pqe-url]').textContent = MOCK_URL
    doneView.dataset.title = title
    doneView.dataset.summary = summary
    doneView.dataset.src = src
    formView.hidden = true; doneView.hidden = false
  })
  var again = modal.querySelector('[data-pqe-again]')
  if (again) again.addEventListener('click', function () {
    form.reset()
    var dd = form.querySelector('input[name=date]')
    if (dd) dd.value = new Date().toISOString().slice(0, 10)
    formView.hidden = false; doneView.hidden = true
  })

  // A1 的复制动作：真实写剪贴板（演示编号），海报按钮只提示
  function doneNote(msg, ok) {
    var n = modal.querySelector('[data-pqe-done-note]')
    if (n) { n.textContent = msg; n.className = 'pqe-note' + (ok ? ' is-ok' : '') }
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text)
    return Promise.reject(new Error('no clipboard'))
  }
  modal.querySelectorAll('[data-pqe-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var kind = b.getAttribute('data-pqe-copy')
      if (kind === 'poster') { doneNote('原型演示：海报图在正式实现中由详情页分享条生成。'); return }
      var text = kind === 'link'
        ? MOCK_URL
        : doneView.dataset.title + '\\n' + (doneView.dataset.summary ? doneView.dataset.summary + '\\n' : '') + '原文：' + (doneView.dataset.src || MOCK_URL) + '\\n' + MOCK_URL
      copy(text).then(function () { doneNote('已复制，去微信粘贴即可。', true) }, function () { doneNote('复制失败：浏览器未授权剪贴板。') })
    })
  })

  // 切换栏：←/→ 与点击循环，写回 ?variant= 并刷新（SSR，重载即切换）
  var order = ${JSON.stringify(ORDER)}
  var names = ${JSON.stringify(VARIANTS)}
  var cur = ${JSON.stringify(variant)}
  function go(v) {
    var q = new URLSearchParams(location.search)
    q.set('variant', v)
    location.search = q.toString()
  }
  function step(d) { go(order[(order.indexOf(cur) + d + order.length) % order.length]) }
  var bar = document.createElement('div')
  bar.className = 'pqe-switch'
  bar.innerHTML = '<span class="tag">PROTOTYPE</span><button type="button" data-p="prev" aria-label="上一个变体">←</button>' +
    '<span>' + cur + ' · ' + names[cur] + '</span>' +
    '<button type="button" data-p="next" aria-label="下一个变体">→</button>'
  document.body.appendChild(bar)
  bar.querySelector('[data-p=prev]').addEventListener('click', function () { step(-1) })
  bar.querySelector('[data-p=next]').addEventListener('click', function () { step(1) })
  document.addEventListener('keydown', function (e) {
    var t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (e.key === 'ArrowLeft') step(-1)
    if (e.key === 'ArrowRight') step(1)
  })
})()
</script>`
}

export function renderQuickEntryProto(rawVariant, { latestUrl = '/' } = {}) {
  const variant = ORDER.includes(rawVariant) ? rawVariant : 'A1'
  const body = variant === 'A1' ? variantA1() : variantA2({ latestUrl })
  return STYLE + body + sharedScript(variant)
}
