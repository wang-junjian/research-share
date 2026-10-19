/* ============================================================
 * 研究成果分享 · 后台管理页
 * 录入 / 全量浏览 / 检索筛选 / 单条与批量管理 / 导出 / 管理员设置
 * 权限：录入者可管理自己录入的，管理员可管理全部（数据库 RLS 强制）
 * 任命权：仅初始管理员可任命 / 移除管理员（db/05 的 is_founder() 强制，UI 只是不挑逗）
 * 设计模式借鉴自「英文随手记」的 assets/admin.js
 * ============================================================ */
(function () {
  'use strict'

  var PAGE_SIZE = 50
  var EXPORT_MAX = 5000

  var ICON = {
    edit: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>',
    del: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M6 6l1 14h10l1-14"></path></svg>',
    open: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"></path><path d="M20 4 10 14"></path><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path></svg>'
  }

  var state = {
    filter: 'all',      // all | 年份 | mine
    search: '',
    page: 0,
    rows: [],
    total: 0,
    selected: {},
    allItems: [],       // 统计与筛选用（全量，量小直接前端算）
    adminRows: [],
    isAdmin: false,
    isFounder: false,
    booted: false,
    loading: false
  }

  var el = {}
  function $(id) { return document.getElementById(id) }
  function byId(id) { return state.allItems.find(function (r) { return r.id === id }) }

  function meId() { return App.auth.user && App.auth.user.id ? App.auth.user.id : null }
  function canManage(row) {
    // 仅用于 UI 提示；真正的边界在数据库 RLS
    return state.isAdmin || (row.owner_id && row.owner_id === meId())
  }
  function byLabel(row) {
    if (!row.owner_id) return '未署名'
    if (row.owner_id === meId()) return (row.owner_name || '我') + '（我）'
    return row.owner_name || '用户 ' + String(row.owner_id).slice(0, 6) + '…'
  }

  /* ---------------- 数据加载 ---------------- */
  function loadItems() {
    var q = cloud.database.from('research_items')
      .select('id, title, summary, url, kind, item_date, owner_id, owner_name, created_at')
      .order('item_date', { ascending: false })
      .order('created_at', { ascending: false })
    return q.then(function (res) {
      if (res && res.error) throw res.error
      return res.data || []
    })
  }

  function loadAdmins() {
    return cloud.database.from('admins').select('user_id, added_at, is_founder').then(function (res) {
      if (res && res.error) throw res.error
      return res.data || []
    })
  }

  /* ---------------- 渲染 ---------------- */
  function yearOf(row) { return String(row.item_date || '').slice(0, 4) }

  function renderStats() {
    var all = state.allItems
    var thisYear = String(new Date().getFullYear())
    var yearCount = all.filter(function (r) { return yearOf(r) === thisYear }).length
    var owners = {}
    all.forEach(function (r) { if (r.owner_id) owners[r.owner_id] = 1 })
    el.sAll.textContent = String(all.length)
    el.sYear.textContent = String(yearCount)
    el.sOwner.textContent = String(Object.keys(owners).length)
    el.sAdmin.textContent = state.adminRows.length ? String(state.adminRows.length) : '—'
    el.pageSub.textContent = all.length ? ('共 ' + all.length + ' 条 · 今年 ' + yearCount + ' 条') : '暂无成果'
  }

  function renderChips() {
    var years = {}
    state.allItems.forEach(function (r) {
      var y = yearOf(r)
      if (y) years[y] = (years[y] || 0) + 1
    })
    var sorted = Object.keys(years).sort().reverse()
    var html = '<button class="chip' + (state.filter === 'all' ? ' is-on' : '') + '" type="button" data-filter="all">全部</button>' +
      '<button class="chip' + (state.filter === 'mine' ? ' is-on' : '') + '" type="button" data-filter="mine">我录入的</button>'
    sorted.forEach(function (y) {
      html += '<button class="chip' + (state.filter === y ? ' is-on' : '') + '" type="button" data-filter="' + App.esc(y) + '">' +
        App.esc(y) + '<span class="n">' + years[y] + '</span></button>'
    })
    el.adminFilter.innerHTML = html
  }

  function filtered() {
    var kw = state.search.trim().toLowerCase()
    return state.allItems.filter(function (r) {
      if (state.filter === 'mine') {
        if (!(r.owner_id && r.owner_id === meId())) return false
      } else if (state.filter !== 'all') {
        if (yearOf(r) !== state.filter) return false
      }
      if (!kw) return true
      return (String(r.title || '') + ' ' + String(r.summary || '') + ' ' + String(r.url || '') + ' ' + String(r.owner_name || ''))
        .toLowerCase().indexOf(kw) >= 0
    })
  }

  function rowHtml(row) {
    var isSel = !!state.selected[row.id]
    var manageable = canManage(row)
    return '' +
      '<tr data-id="' + row.id + '"' + (isSel ? ' class="is-selected"' : '') + '>' +
      '  <td>' + (manageable
        ? '<input class="cbx" type="checkbox" data-role="row-check"' + (isSel ? ' checked' : '') + '>'
        : '') + '</td>' +
      '  <td class="c-time">' + App.esc(row.item_date) + '</td>' +
      '  <td class="c-title">' + App.esc(row.title) + '</td>' +
      '  <td class="c-summary hide-sm">' + App.esc(App.truncate(row.summary, 90)) + '</td>' +
      '  <td class="c-by hide-sm">' + App.esc(byLabel(row)) + '</td>' +
      '  <td class="c-act">' +
      '    <button class="btn btn-icon" data-act="open" type="button" title="打开公开页">' + ICON.open + '</button>' +
      (manageable
        ? '<button class="btn btn-icon" data-act="edit" type="button" title="编辑">' + ICON.edit + '</button>' +
          '<button class="btn btn-icon is-danger" data-act="del" type="button" title="删除">' + ICON.del + '</button>'
        : '') +
      '  </td>' +
      '</tr>'
  }

  function renderTable() {
    var list = filtered()
    state.total = list.length
    var totalPages = Math.max(1, Math.ceil(state.total / PAGE_SIZE))
    if (state.page >= totalPages) state.page = totalPages - 1
    var from = state.page * PAGE_SIZE
    state.rows = list.slice(from, from + PAGE_SIZE)

    if (!state.rows.length) {
      el.tbody.innerHTML = ''
      el.tableEmpty.innerHTML = '<div class="empty" style="border:0;border-radius:0"><h3>' +
        (state.search || state.filter !== 'all' ? '没有匹配的成果' : '还没有任何成果') +
        '</h3><p>' +
        (state.search || state.filter !== 'all' ? '换个筛选条件，或清空搜索框。' : '用上方表单录入第一条研究成果。') +
        '</p></div>'
    } else {
      el.tableEmpty.innerHTML = ''
      el.tbody.innerHTML = state.rows.map(rowHtml).join('')
    }
    el.checkAll.checked = false
    syncBulkbar()
    el.pageNote.textContent = '第 ' + (state.page + 1) + ' / ' + totalPages + ' 页 · 共 ' + state.total + ' 条' +
      (state.total !== state.allItems.length ? '（筛选后 / 全部 ' + state.allItems.length + '）' : '')
    el.prevPage.disabled = state.page <= 0
    el.nextPage.disabled = state.page >= totalPages - 1
  }

  function syncBulkbar() {
    var ids = Object.keys(state.selected)
    el.bulkbar.hidden = ids.length === 0
    el.bulkCount.textContent = '已选 ' + ids.length + ' 条'
  }

  function renderUser() {
    var u = App.auth.user || {}
    el.userName.textContent = App.auth.displayName()
    var initial = u.name ? u.name.trim().charAt(0) : '·'
    if (u.avatarUrl) el.userAvatar.innerHTML = '<img alt="" src="' + App.esc(u.avatarUrl) + '">'
    else el.userAvatar.textContent = initial
  }

  function roleLabel() {
    return state.isFounder ? '初始管理员' : state.isAdmin ? '管理员' : '录入者'
  }

  function renderAdminPanel() {
    el.adminCard.hidden = !state.isAdmin
    // 「数据看板」页签只对管理员显示；真正的边界在数据库函数里的 is_admin()
    if (window.AnDash) window.AnDash.setEnabled(state.isAdmin)
    if (!state.isAdmin) return

    // 任命权独占（ADR-0003）：普通管理员看不到任命入口，副标题说明边界
    el.adminCardSub.textContent = '管理员可修改 / 删除所有人的成果' +
      (state.isFounder ? '' : ' · 任命与移除管理员归初始管理员')
    el.promoteBox.hidden = !state.isFounder

    var nameOf = {}
    state.allItems.forEach(function (r) { if (r.owner_id && r.owner_name && !nameOf[r.owner_id]) nameOf[r.owner_id] = r.owner_name })

    el.adminList.innerHTML = state.adminRows.map(function (r) {
      var self = r.user_id === meId()
      // founder 行不渲染「移除」：RLS 本来就删不掉（db/05），UI 不提供注定失败的按钮
      var removable = state.isFounder && !r.is_founder
      return '<div class="admin-row">' +
        '<span>' + App.esc(nameOf[r.user_id] || '用户 ' + String(r.user_id).slice(0, 8) + '…') +
        (self ? '<span class="self-flag">我</span>' : '') +
        (r.is_founder ? '<span class="self-flag">初始</span>' : '') + '</span>' +
        (removable
          ? '<button class="btn btn-sm btn-danger" data-uid="' + App.esc(r.user_id) + '" data-act="rm-admin" type="button">移除</button>'
          : '') +
        '</div>'
    }).join('') || '<p class="auth-hint">暂无管理员记录。</p>'

    var adminSet = {}
    state.adminRows.forEach(function (r) { adminSet[r.user_id] = 1 })
    var owners = {}
    state.allItems.forEach(function (r) { if (r.owner_id && !owners[r.owner_id]) owners[r.owner_id] = r.owner_name })
    var promote = Object.keys(owners).filter(function (uid) { return !adminSet[uid] })
    el.ownerList.innerHTML = promote.map(function (uid) {
      return '<div class="owner-row">' +
        '<span>' + App.esc(owners[uid] || '用户 ' + String(uid).slice(0, 8) + '…') +
        (uid === meId() ? '<span class="self-flag">我</span>' : '') + '</span>' +
        '<button class="btn btn-sm" data-uid="' + App.esc(uid) + '" data-act="add-admin" type="button">设为管理员</button>' +
        '</div>'
    }).join('') || '<p class="auth-hint">暂无可提升的录入者。</p>'

    el.myUid.textContent = meId() || '(未获取)'
  }

  /* ---------------- 加载全量 ---------------- */
  function reloadAll() {
    if (state.loading) return
    state.loading = true
    el.tbody.innerHTML = '<tr><td colspan="6"><div class="loading"><span class="spinner"></span>加载中…</div></td></tr>'
    el.tableEmpty.innerHTML = ''
    el.pageSub.textContent = '加载中…'

    Promise.all([loadItems(), loadAdmins()]).then(function (out) {
      state.loading = false
      state.allItems = out[0]
      state.adminRows = out[1]
      state.isAdmin = state.adminRows.some(function (r) { return r.user_id === meId() })
      state.isFounder = state.adminRows.some(function (r) { return r.user_id === meId() && r.is_founder })
      el.roleTag.textContent = roleLabel()
      renderStats()
      renderChips()
      renderTable()
      renderAdminPanel()
      // 管理员身份确定之后再落页签：刷新前停在「数据看板」的话，回到同一处
      showTab(currentTab)
    }).catch(function (e) {
      state.loading = false
      el.tbody.innerHTML = '<tr><td colspan="6"><div class="empty" style="border:0"><h3>加载失败</h3><p>' +
        App.esc(App.msg(e)) + '</p></div></td></tr>'
      el.pageSub.textContent = '加载失败'
    })
  }

  /* ---------------- 导出 ---------------- */
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' })
    var url = URL.createObjectURL(blob)
    var a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
  }

  function stamp() {
    var d = new Date()
    var p = function (n) { return n < 10 ? '0' + n : '' + n }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes())
  }

  function exportJson() {
    var rows = filtered().slice(0, EXPORT_MAX).map(function (r) {
      return {
        title: r.title, summary: r.summary, url: r.url, item_date: r.item_date,
        owner_name: r.owner_name || '', created_at: r.created_at
      }
    })
    download('research-items-' + stamp() + '.json', JSON.stringify(rows, null, 2), 'application/json;charset=utf-8')
    App.toast('已导出 ' + rows.length + ' 条', 'ok')
  }

  function csvCell(v) {
    return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'
  }

  function exportCsv() {
    var rows = filtered().slice(0, EXPORT_MAX)
    var lines = [['日期', '标题', '概览', '链接', '录入者', '创建时间'].map(csvCell).join(',')]
    rows.forEach(function (r) {
      lines.push([r.item_date, r.title, r.summary, r.url, r.owner_name || '', r.created_at].map(csvCell).join(','))
    })
    download('research-items-' + stamp() + '.csv', '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8')
    App.toast('已导出 ' + rows.length + ' 条', 'ok')
  }

  /* ---------------- 编辑弹窗 ---------------- */
  function openEditor(row) {
    // 文档型成果（GLOSSARY: 文档型成果）的原文不落库，url 恒为空；
    // 链接位置只读展示派生托管地址（GLOSSARY: 托管地址），表单不能创建/替换文档（第一期）。
    // admin 与站点同源，托管地址直接由 origin 拼出。
    var isDoc = row.kind === 'doc' || !row.url
    var docUrl = location.origin + '/item/' + row.id + '/doc'
    var m = App.mountModal(
      '<div class="modal" style="max-width:560px">' +
      '  <div class="modal-head">' +
      '    <h3>编辑成果</h3>' +
      '    <button class="btn btn-icon modal-close" data-act="cancel" type="button" title="关闭">✕</button>' +
      '  </div>' +
      '  <div class="modal-body">' +
      '    <label class="modal-field"><span>标题</span><input id="edTitle" type="text" maxlength="120"></label>' +
      '    <label class="modal-field"><span>概览（约 200 字）</span><textarea id="edSummary" maxlength="400"></textarea></label>' +
      (isDoc
        ? '    <label class="modal-field"><span>托管地址（文档内容不可修改）</span><input id="edUrl" type="url" readonly></label>'
        : '    <label class="modal-field"><span>原文链接</span><input id="edUrl" type="url"></label>') +
      '    <label class="modal-field"><span>日期</span><input id="edDate" type="date"></label>' +
      '    <p class="auth-hint" id="edError"></p>' +
      '  </div>' +
      '  <div class="modal-foot">' +
      '    <button class="btn" data-act="cancel" type="button">取消</button>' +
      '    <button class="btn btn-primary" id="edSave" type="button">保存修改</button>' +
      '  </div>' +
      '</div>'
    )

    var titleEl = m.el.querySelector('#edTitle')
    var summaryEl = m.el.querySelector('#edSummary')
    var urlEl = m.el.querySelector('#edUrl')
    var dateEl = m.el.querySelector('#edDate')
    var errEl = m.el.querySelector('#edError')
    var saveBtn = m.el.querySelector('#edSave')

    titleEl.value = row.title || ''
    summaryEl.value = row.summary || ''
    urlEl.value = isDoc ? docUrl : (row.url || '')
    dateEl.value = row.item_date || App.today()
    setTimeout(function () { titleEl.focus() }, 30)

    saveBtn.addEventListener('click', function () {
      var payload = {
        title: titleEl.value.trim(),
        summary: summaryEl.value.trim(),
        item_date: dateEl.value
      }
      // 文档型不提交 url：内容不可变（docs/adr/0004），标元照常可改
      if (!isDoc) payload.url = urlEl.value.trim()
      if (!payload.title || !payload.summary || (!isDoc && !payload.url) || !payload.item_date) {
        errEl.textContent = isDoc ? '标题、概览、日期都不能为空。' : '标题、概览、链接、日期都不能为空。'
        errEl.className = 'auth-hint is-error'
        return
      }
      saveBtn.disabled = true
      saveBtn.textContent = '保存中…'
      cloud.database.from('research_items').update(payload).eq('id', row.id).select().then(function (res) {
        saveBtn.disabled = false
        saveBtn.textContent = '保存修改'
        if (res && res.error) {
          errEl.textContent = App.msg(res.error)
          errEl.className = 'auth-hint is-error'
          return
        }
        var affected = Array.isArray(res.data) ? res.data : []
        if (affected.length === 0) {
          errEl.textContent = '没有改动生效：该成果可能不存在，或你没有权限（仅录入者本人或管理员可修改）。'
          errEl.className = 'auth-hint is-error'
          return
        }
        m.close()
        App.toast('已保存', 'ok')
        reloadAll()
      }).catch(function (e) {
        saveBtn.disabled = false
        saveBtn.textContent = '保存修改'
        errEl.textContent = App.msg(e)
        errEl.className = 'auth-hint is-error'
      })
    })
  }

  /* ---------------- 增删 ---------------- */
  function deleteOne(row) {
    App.confirm({
      title: '删除这条成果？',
      message: '「' + App.truncate(row.title, 50) + '」将被永久删除，无法恢复。',
      okText: '确认删除'
    }).then(function (ok) {
      if (!ok) return
      cloud.database.from('research_items').delete().eq('id', row.id).select().then(function (res) {
        if (res && res.error) { App.toast(App.msg(res.error), 'error'); return }
        var removed = Array.isArray(res.data) ? res.data : []
        if (removed.length === 0) { App.toast('删除未生效：仅录入者本人或管理员可删除', 'error'); return }
        App.toast('已删除', 'ok')
        reloadAll()
      }).catch(function (e) { App.toast(App.msg(e), 'error') })
    })
  }

  function bulkDelete() {
    var ids = Object.keys(state.selected).map(Number)
    if (!ids.length) return
    App.confirm({
      title: '删除选中的 ' + ids.length + ' 条成果？',
      message: '这些成果将被永久删除，无法恢复。建议先导出备份。',
      okText: '确认删除 ' + ids.length + ' 条'
    }).then(function (ok) {
      if (!ok) return
      cloud.database.from('research_items').delete().in('id', ids).select().then(function (res) {
        if (res && res.error) { App.toast(App.msg(res.error), 'error'); return }
        var removed = Array.isArray(res.data) ? res.data : []
        if (removed.length === 0) { App.toast('删除未生效：这些成果不在你的管理范围内', 'error'); return }
        state.selected = {}
        App.toast('已删除 ' + removed.length + ' 条' + (removed.length < ids.length ? '（部分无权限，已跳过）' : ''), 'ok')
        reloadAll()
      }).catch(function (e) { App.toast(App.msg(e), 'error') })
    })
  }

  function submitNew(e) {
    if (e) e.preventDefault()
    var payload = {
      title: el.fTitle.value.trim(),
      summary: el.fSummary.value.trim(),
      url: el.fUrl.value.trim(),
      item_date: el.fDate.value || App.today(),
      owner_name: App.auth.nickname()
    }
    if (!payload.title || !payload.summary || !payload.url) {
      App.toast('请填写标题、概览与原文链接', 'error')
      return
    }
    el.btnSave.disabled = true
    el.btnSave.textContent = '保存中…'
    cloud.database.from('research_items').insert(payload).select().then(function (res) {
      el.btnSave.disabled = false
      el.btnSave.textContent = '录入成果'
      if (res && res.error) { App.toast(App.msg(res.error), 'error'); return }
      App.toast('已录入，公开页面立即可见', 'ok')
      el.fTitle.value = ''
      el.fSummary.value = ''
      el.fUrl.value = ''
      el.fDate.value = App.today()
      reloadAll()
    }).catch(function (err) {
      el.btnSave.disabled = false
      el.btnSave.textContent = '录入成果'
      App.toast(App.msg(err), 'error')
    })
  }

  /* ---------------- 管理员操作 ---------------- */
  function addAdmin(uid) {
    uid = String(uid || '').trim()
    if (!uid) return
    cloud.database.from('admins').insert({ user_id: uid }).select().then(function (res) {
      if (res && res.error) { App.toast(App.msg(res.error), 'error'); return }
      App.toast('已添加为管理员', 'ok')
      reloadAll()
    }).catch(function (e) { App.toast(App.msg(e), 'error') })
  }

  function removeAdmin(uid) {
    var self = uid === meId()
    App.confirm({
      title: self ? '移除你自己的管理员权限？' : '移除该管理员？',
      message: self
        ? '移除后你将失去管理全部成果的权限（包括无法自行恢复）。请确保还有其他管理员。'
        : '该用户将只能管理自己录入的成果。',
      okText: self ? '确认移除我自己' : '确认移除'
    }).then(function (ok) {
      if (!ok) return
      cloud.database.from('admins').delete().eq('user_id', uid).select().then(function (res) {
        if (res && res.error) { App.toast(App.msg(res.error), 'error'); return }
        var removed = Array.isArray(res.data) ? res.data : []
        if (removed.length === 0) { App.toast('移除未生效：你可能已不是管理员', 'error'); return }
        App.toast(self ? '已移除你的管理员权限' : '已移除该管理员', 'ok')
        reloadAll()
      }).catch(function (e) { App.toast(App.msg(e), 'error') })
    })
  }

  /* ---------------- 登录门切换 ---------------- */
  function showLogin() {
    el.appRoot.hidden = true
    el.gate.hidden = false
    App.renderLogin(el.gate, { next: 'admin' })
  }

  /* ---------------- 页签：成果管理 / 数据看板 ---------------- */
  // 页签记在 localStorage：刷新或从看板跳出去再回来，还停在原处
  var TAB_KEY = 'rs:admintab'
  var currentTab = 'manage'
  try { currentTab = localStorage.getItem(TAB_KEY) || 'manage' } catch (e) { currentTab = 'manage' }

  function showTab(name) {
    // 非管理员点不进来；即使硬改 localStorage 也会被这里挡回，数据库还有第二道
    if (name === 'dash' && !(window.AnDash && window.AnDash.isEnabled())) name = 'manage'
    currentTab = name
    try { localStorage.setItem(TAB_KEY, name) } catch (e) { /* 无痕模式忽略 */ }

    el.tabManage.hidden = name !== 'manage'
    el.tabDash.hidden = name !== 'dash'
    el.adminPage.classList.toggle('is-wide', name === 'dash')
    Array.prototype.forEach.call(el.tabs.querySelectorAll('.an-tab'), function (b) {
      var on = b.getAttribute('data-tab') === name
      b.classList.toggle('is-on', on)
      b.setAttribute('aria-selected', on ? 'true' : 'false')
    })
    if (window.AnDash) {
      if (name === 'dash') window.AnDash.activate()
      else window.AnDash.deactivate()
    }
  }

  function showAdmin() {
    el.gate.hidden = true
    el.appRoot.hidden = false
    renderUser()
    reloadAll()
  }

  /* ---------------- 事件 ---------------- */
  function debounce(fn, ms) {
    var t = null
    return function () {
      var args = arguments, self = this
      clearTimeout(t)
      t = setTimeout(function () { fn.apply(self, args) }, ms)
    }
  }

  function bind() {
    el.tabs.addEventListener('click', function (ev) {
      var b = ev.target.closest('.an-tab')
      if (!b || b.hidden) return
      showTab(b.getAttribute('data-tab'))
      window.scrollTo({ top: 0 })
    })

    el.itemForm.addEventListener('submit', submitNew)
    el.btnCancelEdit.addEventListener('click', function () {
      el.fTitle.value = ''
      el.fSummary.value = ''
      el.fUrl.value = ''
      el.fDate.value = App.today()
    })

    el.adminSearch.addEventListener('input', debounce(function () {
      state.search = el.adminSearch.value.trim()
      el.searchWrap.classList.toggle('has-value', !!el.adminSearch.value)
      state.page = 0
      renderTable()
    }, 260))
    el.adminSearchClear.addEventListener('click', function () {
      el.adminSearch.value = ''
      state.search = ''
      el.searchWrap.classList.remove('has-value')
      state.page = 0
      renderTable()
    })

    el.adminFilter.addEventListener('click', function (ev) {
      var chip = ev.target.closest('.chip')
      if (!chip) return
      state.filter = chip.getAttribute('data-filter')
      state.page = 0
      Array.prototype.forEach.call(el.adminFilter.querySelectorAll('.chip'), function (c) {
        c.classList.toggle('is-on', c === chip)
      })
      renderTable()
    })

    el.checkAll.addEventListener('change', function () {
      var on = el.checkAll.checked
      state.rows.forEach(function (r) { if (on && canManage(r)) state.selected[r.id] = true; else delete state.selected[r.id] })
      Array.prototype.forEach.call(el.tbody.querySelectorAll('[data-role="row-check"]'), function (cb) {
        cb.checked = on
        var tr = cb.closest('tr')
        if (tr) tr.classList.toggle('is-selected', on)
      })
      syncBulkbar()
    })

    el.tbody.addEventListener('change', function (ev) {
      var cb = ev.target.closest('[data-role="row-check"]')
      if (!cb) return
      var tr = cb.closest('tr')
      var id = Number(tr.getAttribute('data-id'))
      if (cb.checked) state.selected[id] = true
      else delete state.selected[id]
      tr.classList.toggle('is-selected', cb.checked)
      syncBulkbar()
    })

    el.tbody.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-act]')
      if (!btn) return
      var tr = ev.target.closest('tr')
      var id = Number(tr.getAttribute('data-id'))
      var row = byId(id) || state.rows.find(function (r) { return r.id === id })
      if (!row) return
      var act = btn.getAttribute('data-act')
      if (act === 'open') window.open('/item/' + row.id, '_blank')
      else if (act === 'edit') openEditor(row)
      else if (act === 'del') deleteOne(row)
    })

    el.bulkDelete.addEventListener('click', bulkDelete)
    el.bulkClear.addEventListener('click', function () {
      state.selected = {}
      renderTable()
    })

    el.prevPage.addEventListener('click', function () {
      if (state.page <= 0) return
      state.page--
      renderTable()
      window.scrollTo({ top: 0, behavior: 'smooth' })
    })
    el.nextPage.addEventListener('click', function () {
      state.page++
      renderTable()
      window.scrollTo({ top: 0, behavior: 'smooth' })
    })

    el.exportJson.addEventListener('click', exportJson)
    el.exportCsv.addEventListener('click', exportCsv)

    el.adminList.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-act="rm-admin"]')
      if (btn) removeAdmin(btn.getAttribute('data-uid'))
    })
    el.ownerList.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-act="add-admin"]')
      if (btn) addAdmin(btn.getAttribute('data-uid'))
    })
    el.btnAddAdmin.addEventListener('click', function () {
      addAdmin(el.manualUid.value)
      el.manualUid.value = ''
    })
    el.btnCopyUid.addEventListener('click', function () {
      var uid = meId() || ''
      if (!uid) return
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(uid).then(function () { App.toast('已复制用户 ID', 'ok') },
          function () { App.toast('复制失败，请手动选择复制', 'error') })
      } else {
        App.toast('当前环境不支持自动复制，请手动选择复制')
      }
    })

    el.userChip.addEventListener('click', function () {
      var pop = document.querySelector('.user-pop')
      if (pop) { pop.remove(); return }
      pop = document.createElement('div')
      pop.className = 'speech-pop user-pop'
      pop.innerHTML = '<div class="row"><label style="width:auto">' + App.esc(App.auth.displayName()) +
        '（' + roleLabel() + '）</label></div>' +
        '<div class="row"><button class="btn btn-sm btn-block" id="signOutBtn" type="button">退出登录</button></div>'
      el.userChip.parentElement.style.position = 'relative'
      el.userChip.parentElement.appendChild(pop)
      pop.querySelector('#signOutBtn').addEventListener('click', function () {
        pop.remove()
        App.auth.signOut().then(function () { App.toast('已退出登录') })
      })
      setTimeout(function () {
        document.addEventListener('mousedown', function onDoc(ev) {
          if (!pop.contains(ev.target) && !el.userChip.contains(ev.target)) {
            pop.remove()
            document.removeEventListener('mousedown', onDoc)
          }
        })
      }, 0)
    })
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    el.gate = $('authGate')
    el.appRoot = $('appRoot')
    el.adminPage = $('adminPage')
    el.tabs = $('tabs')
    el.tabManage = $('tabManage')
    el.tabDash = $('tabDash')
    el.pageSub = $('pageSub')
    el.roleTag = $('roleTag')
    el.sAll = $('sAll'); el.sYear = $('sYear'); el.sOwner = $('sOwner'); el.sAdmin = $('sAdmin')
    el.searchWrap = $('searchWrap')
    el.adminSearch = $('adminSearch')
    el.adminSearchClear = $('adminSearchClear')
    el.adminFilter = $('adminFilter')
    el.tbody = $('tbody')
    el.tableEmpty = $('tableEmpty')
    el.checkAll = $('checkAll')
    el.bulkbar = $('bulkbar')
    el.bulkCount = $('bulkCount')
    el.bulkDelete = $('bulkDelete')
    el.bulkClear = $('bulkClear')
    el.pageNote = $('pageNote')
    el.prevPage = $('prevPage')
    el.nextPage = $('nextPage')
    el.exportJson = $('exportJson')
    el.exportCsv = $('exportCsv')
    el.userChip = $('userChip')
    el.userName = $('userName')
    el.userAvatar = $('userAvatar')
    el.itemForm = $('itemForm')
    el.fTitle = $('fTitle')
    el.fSummary = $('fSummary')
    el.fUrl = $('fUrl')
    el.fDate = $('fDate')
    el.btnSave = $('btnSave')
    el.btnCancelEdit = $('btnCancelEdit')
    el.adminCard = $('adminCard')
    el.adminCardSub = $('adminCardSub')
    el.promoteBox = $('promoteBox')
    el.adminList = $('adminList')
    el.ownerList = $('ownerList')
    el.manualUid = $('manualUid')
    el.btnAddAdmin = $('btnAddAdmin')
    el.myUid = $('myUid')
    el.btnCopyUid = $('btnCopyUid')

    el.fDate.value = App.today()
    bind()

    App.bootstrap().then(function (session) {
      state.booted = true
      if (session && session.user) showAdmin()
      else showLogin()
    })

    App.auth.onChange(function (session) {
      if (!state.booted) return
      var signedIn = !!(session && session.user)
      if (signedIn && el.appRoot.hidden) showAdmin()
      else if (!signedIn && !el.appRoot.hidden) showLogin()
      else if (signedIn) renderUser()
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
