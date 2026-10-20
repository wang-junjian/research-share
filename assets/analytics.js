/* ============================================================
 * 研究成果 · 后台「数据看板」页签
 *
 * 数据全部来自一个 RPC：经浏览器数据面 App.data.dashboard 调
 * analytics_dashboard（GLOSSARY: 浏览器数据面）
 *   —— 服务端进程是 anon 身份，本来就没权限调它；鉴权只在数据库函数里的
 *      is_admin() 一处判定，不会出现「接口层放行了、函数层没拦住」的缝隙。
 *   —— 聚合在库里做，前端只发 1 个请求、只渲染一次（与本站零构建的风格一致）。
 *   —— rpc 名称/参数、res.error 翻译与 jsonb 字符串兜底都收口在数据面，
 *      本文件只调用不拼链；「排除本机」的 analytics_exclude 读写同此。
 *
 * 三条贯穿全文件的规矩（对应 DESIGN.md）：
 *   1. 每个百分比旁边都保留绝对数，样本 < 30 一律打「样本少」灰标
 *      —— 在 3 个访客上谈 50% 增长是自欺。
 *   2. 每个区块都有明确的空状态文案，上线第一天要「好看地空着」，
 *      而不是一整屏 0 或报错。
 *   3. 图表按容器实测宽度渲染（窄屏给窄图），不用 viewBox 缩放
 *      —— 那会把轴标签一起缩到 4px，等于没有标签。
 *
 * 对外接口：window.AnDash.{ setEnabled, activate, refresh }
 * ============================================================ */
(function () {
  'use strict'

  var SMALL = 30 // 样本量阈值：低于它就打灰标
  var TOP_N = 12 // 内容表现表默认展示多少条

  var state = {
    days: 30,
    data: null,
    loading: false,
    err: '',
    excl: [],        // analytics_exclude 的当前内容
    exclLoaded: false,
    active: false,
    // 默认 false = 先关着：管理员身份是异步查出来的，
    // 在查清楚之前不显示看板页签（fail-closed，页签隐藏 + 数据库 is_admin() 双保险）
    enabled: false
  }

  function $(id) { return document.getElementById(id) }
  function esc(s) { return App.esc(s) }
  function fmt(n) {
    return n === null || n === undefined ? '—' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }
  function pct(x, d) { return x === null || x === undefined || isNaN(x) ? '—' : (x * 100).toFixed(d == null ? 1 : d) + '%' }
  function avg(list) { return list.length ? list.reduce(function (a, b) { return a + b }, 0) / list.length : null }
  function mean1(v) { return v === null ? '—' : Math.round(v * 10) / 10 }

  function emptyBox(title, sub) {
    return '<div class="an-empty"><b>' + esc(title) + '</b>' + esc(sub || '') + '</div>'
  }

  /* 空态判据 —— 全站唯一实现，render() 与 resize 重绘都必须调它。
     窗口内既没有会话、也没有访客才算空。
     **不能**用 health.totalEvents：那个计数含机器人，只有爬虫来过的日子里它 > 0，
     于是会走「有数据」分支、画出 30 根 0 柱子，恰好是设计里明确要避免的「一整屏 0」。
     机器人流量仍由 F 区块的「机器人流量」如实报出，不会被藏起来。 */
  function isEmptyData(D) {
    return !D || !(D.overview.sessions || D.overview.visitors)
  }

  /* 环比徽标：红=涨（与站点强调色一致），绿=跌 */
  function delta(cur, prev, unit) {
    if (!prev) return '<span class="an-flat">— <span class="vs">无上周期数据</span></span>'
    var r = (cur - prev) / prev
    var flat = Math.abs(r) < 0.0005
    var up = r > 0
    var cls = flat ? 'an-flat' : (up ? 'an-up' : 'an-dn')
    var sym = flat ? '持平' : (up ? '↑' : '↓')
    var val = unit === 'pt' ? (Math.abs(cur - prev) * 100).toFixed(1) + 'pt' : (Math.abs(r) * 100).toFixed(1) + '%'
    return '<span class="' + cls + '">' + sym + ' ' + val + '</span> <span class="vs">较上周期</span>'
  }

  /* ---------- 迷你趋势线 ---------- */
  function spark(vals, w, h) {
    if (!vals || vals.length < 2) return '<div style="height:' + h + 'px"></div>'
    var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals)
    var span = (max - min) || 1
    var step = w / (vals.length - 1)
    var pts = vals.map(function (v, i) {
      return [i * step, h - 2 - (v - min) / span * (h - 8)]
    })
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1) }).join(' ')
    return '<svg class="an-chart" viewBox="0 0 ' + w + ' ' + h + '" height="' + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="' + line + ' L' + w + ' ' + h + ' L0 ' + h + ' Z" fill="rgba(230,57,70,.09)"/>' +
      '<path d="' + line + '" fill="none" stroke="var(--brand)" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>' +
      '</svg>'
  }

  /* ---------- 发布 vs 流量的对照 ---------- */
  function pubStats(trend) {
    var pubDays = [], nextDay = [], other = []
    trend.forEach(function (d, i) {
      if (d.published) pubDays.push(d.d)
      var dayAfter = i > 0 && trend[i - 1].published
      if (dayAfter) nextDay.push(d.visitors)
      else if (!d.published) other.push(d.visitors)
    })
    return { pubDays: pubDays, nextDay: avg(nextDay), nextDayN: nextDay.length, other: avg(other), otherN: other.length }
  }

  /* ===================== A 核心指标 ===================== */
  function drawKpis(D, isEmpty) {
    var o = D.overview, p = D.prev, t = D.trend
    var series = {
      visitors: t.map(function (d) { return d.visitors }),
      sessions: t.map(function (d) { return d.sessions }),
      pageviews: t.map(function (d) { return d.pageviews }),
      outbound: t.map(function (d) { return d.outbound }),
      shares: t.map(function (d) { return d.shares }),
      // 跳转率没有现成的按日序列，用当日的 outbound ÷ view_item 现算
      rate: t.map(function (d) { return d.view_item ? d.outbound / d.view_item : 0 })
    }
    var KPI = [
      { k: '访客数', tip: '按 visitor_id 去重的独立访客（已剔除自己人与机器人）', v: o.visitors, p: p.visitors, s: series.visitors },
      { k: '会话数', tip: '30 分钟不活动即切新会话', v: o.sessions, p: p.sessions, s: series.sessions },
      { k: '页面浏览', tip: '客户端与服务端各有记录，此处取客户端口径（服务端那批在 F 区块用来算覆盖率）', v: o.pageviews, p: p.pageviews, s: series.pageviews },
      { k: '原文跳转数', tip: '北极星指标：点击「查看原文 ↗」或详情页原文链接的次数', v: o.outboundClicks, p: p.outboundClicks, s: series.outbound, north: true },
      { k: '原文跳转率', tip: 'outbound_click ÷ view_item。本站的终极转化', v: o.outboundRate, p: p.outboundRate, s: series.rate, rate: true },
      { k: '分享次数', tip: '5 个分享按钮的点击合计', v: o.shares, p: p.shares, s: series.shares }
    ]
    var small = (o.sessions || 0) < SMALL
    $('kpis').innerHTML = KPI.map(function (c) {
      var has = c.v !== null && c.v !== undefined
      var val = !has ? '—' : (c.rate ? (c.v * 100).toFixed(1) : fmt(c.v))
      var d = isEmpty || !has
        ? '<span class="an-flat">' + (isEmpty ? '还没有数据' : '—') + '</span>'
        : (c.rate ? delta(c.v, c.p, 'pt') : delta(c.v, c.p))
      return '<div class="an-kpi' + (c.north ? ' is-north' : '') + '" title="' + esc(c.tip) + '">' +
        '<div class="k">' + (c.north ? '<span class="star">★</span>' : '') + esc(c.k) + '</div>' +
        '<div class="v">' + val + (c.rate && has ? '<span class="u">%</span>' : '') + '</div>' +
        '<div class="d">' + d +
        (small && !isEmpty ? ' <span class="an-tag is-warn">样本少</span>' : '') +
        (!isEmpty && has && !c.rate ? ' <span class="vs">n=' + fmt(c.v) + '</span>' : '') + '</div>' +
        '<div class="spk">' + (isEmpty ? '<div style="height:30px"></div>' : spark(c.s, 160, 30)) + '</div>' +
        '</div>'
    }).join('')
  }

  /* ===================== B 流量趋势 ===================== */
  function drawTrend(D) {
    var host = $('trend')
    var hs = pubStats(D.trend)
    $('trendNote').innerHTML = hs.pubDays.length
      ? '本期共发布 ' + hs.pubDays.length + ' 条新成果（' + hs.pubDays.join('、') + '）。' +
        '发布次日访客均值 <span class="an-num">' + mean1(hs.nextDay) + '</span>（' + hs.nextDayN + ' 天），' +
        '其余日均值 <span class="an-num">' + mean1(hs.other) + '</span>（' + hs.otherN + ' 天）' +
        (hs.nextDay !== null && hs.other !== null && hs.nextDayN >= 2
          ? ' —— 内容动作与流量的关系就摆在图上看。'
          : ' —— 发布天数太少，这个对照还不足以下结论。')
      : '本期没有新条目发布。'

    var w = Math.max(300, host.clientWidth || 600), h = 240
    var L = 38, R = 42, T = 14, B = 26
    var iw = w - L - R, ih = h - T - B
    var days = D.trend, n = days.length
    if (!n) { host.innerHTML = ''; return }
    // 双轴：左轴访客（柱），右轴页面浏览（线）。两者量级差数倍，同轴会把柱子压成方块。
    var topU = Math.ceil(Math.max.apply(null, days.map(function (d) { return d.visitors })) / 10) * 10 || 10
    var topV = Math.ceil(Math.max.apply(null, days.map(function (d) { return d.pageviews })) / 100) * 100 || 100
    var bw = iw / n
    var yU = function (v) { return T + ih - v / topU * ih }
    var yV = function (v) { return T + ih - v / topV * ih }
    var s = '<svg class="an-chart" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '">'
    days.forEach(function (d, i) {
      if (d.published) {
        s += '<rect x="' + (L + i * bw).toFixed(1) + '" y="' + T + '" width="' + bw.toFixed(1) + '" height="' + ih + '" fill="rgba(230,57,70,.06)"/>'
      }
    })
    for (var g = 0; g <= 4; g++) {
      var yy = T + ih - ih / 4 * g
      s += '<line x1="' + L + '" y1="' + yy.toFixed(1) + '" x2="' + (w - R) + '" y2="' + yy.toFixed(1) + '" stroke="var(--line)" stroke-width="1" stroke-dasharray="' + (g ? '3 4' : '0') + '"/>'
      s += '<text x="' + (L - 7) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="var(--brand)" font-family="Archivo, sans-serif" opacity=".75">' + Math.round(topU / 4 * g) + '</text>'
      s += '<text x="' + (w - R + 7) + '" y="' + (yy + 3.5).toFixed(1) + '" font-size="10" fill="var(--text-2)" font-family="Archivo, sans-serif" opacity=".65">' + Math.round(topV / 4 * g) + '</text>'
    }
    var bwid = Math.max(3, bw * 0.56)
    days.forEach(function (d, i) {
      var x = L + i * bw + (bw - bwid) / 2
      var yy = yU(d.visitors)
      s += '<rect x="' + x.toFixed(1) + '" y="' + yy.toFixed(1) + '" width="' + bwid.toFixed(1) + '" height="' + Math.max(0, T + ih - yy).toFixed(1) + '" fill="var(--brand)" opacity=".8" rx="1.5"><title>' + esc(d.d) + ' 访客 ' + d.visitors + '</title></rect>'
    })
    var pl = days.map(function (d, i) { return (i ? 'L' : 'M') + (L + i * bw + bw / 2).toFixed(1) + ' ' + yV(d.pageviews).toFixed(1) }).join(' ')
    s += '<path d="' + pl + '" fill="none" stroke="var(--text-2)" stroke-width="1.7" stroke-linejoin="round" opacity=".8"/>'
    var every = Math.max(1, Math.round(n / 8))
    days.forEach(function (d, i) {
      if (i % every) return
      s += '<text x="' + (L + i * bw + bw / 2).toFixed(1) + '" y="' + (h - 8) + '" text-anchor="middle" font-size="10" fill="var(--muted)" font-family="Archivo, sans-serif">' + esc(d.d) + '</text>'
    })
    s += '</svg>'
    host.innerHTML = s
  }

  /* ===================== C 漏斗 + 分享效力 ===================== */
  function drawFunnel(D) {
    // 后端返回的是「嵌套漏斗」：steps[] 的第 N 级会话集合 ⊆ 第 N-1 级，所以各级必然单调不增，
    // 「流失」永远非负。另有一个 direct 计数：直接从分享链接落在详情页、没经过首页的会话。
    var F = D.funnel || {}, f = F.steps || [], base = f.length ? (f[0].n || 0) : 0
    if (!base) { $('funnel').innerHTML = emptyBox('本窗口内还没有会话', '漏斗要等第一个真实会话进来才会有形状。'); return }
    // 最大流失点自己算：不要让它散落在渲染代码里，规则只有一条——相对流失率最大
    var worst = -1, worstRate = 0
    for (var i = 0; i < f.length - 1; i++) {
      if (!f[i].n) continue
      var r = 1 - f[i + 1].n / f[i].n
      if (r > worstRate) { worstRate = r; worst = i }
    }
    var html = '<div class="an-funnel">'
    f.forEach(function (s, i) {
      html += '<div class="an-fstep">' +
        '<div class="n">' + esc(s.label) + '<small>' + esc(s.hint || '') + '</small></div>' +
        '<div class="bar"><i style="width:' + (s.n / base * 100).toFixed(1) + '%"></i><span>' + fmt(s.n) + '</span></div>' +
        '<div class="r">' + (i === 0 ? '100%' : pct(f[i - 1].n ? s.n / f[i - 1].n : 0, 1)) + '</div>' +
        '</div>'
      if (i < f.length - 1) {
        var drop = f[i].n ? 1 - f[i + 1].n / f[i].n : 0
        html += '<div class="an-drop' + (i === worst ? ' is-worst' : '') + '">' +
          '流失 ' + fmt(f[i].n - f[i + 1].n) + ' 个会话 · <b>' + pct(drop, 0) + '</b>' +
          (i === worst ? ' ← 最大流失点，优先动这里' : '') + '</div>'
      }
    })
    html += '<div class="an-fork">分叉终点：<b>原文跳转</b> ' + fmt(f[f.length - 1].n) + ' 个会话 ＆ ' +
      '<b>分享</b> ' + fmt(D.overview.shares) + ' 次点击</div>'
    // 诚实性：这条链从「首页有交互」起算，天然漏掉直接落在详情页的会话。
    // 不把这批人说出来，「57% 流失在首页」就会被误读成首页劝退了他们。
    if (F.direct) {
      html += '<p class="an-note" style="margin:9px 0 0">另有 <b>' + fmt(F.direct) + '</b> 个会话是直接从分享链接落在详情页的，' +
        '没经过首页（上面这条链不含它们）。首页的流失率要跟这个数一起看。</p>'
    }
    html += '</div>'
    $('funnel').innerHTML = html
  }

  function drawShare(D) {
    var total = D.overview.shares
    $('shareTotal').textContent = fmt(total)
    if (!total) { $('share').innerHTML = emptyBox('还没有人点过分享', '5 个按钮谁在用、谁是摆设，点一次就能看出来。'); return }
    var max = Math.max.apply(null, D.share.map(function (x) { return x.n })) || 1
    $('share').innerHTML = '<div class="an-rows">' + D.share.map(function (x) {
      return '<div class="an-row' + (x.n === max && x.n > 0 ? ' is-hot' : '') + '">' +
        '<div class="lab"><span style="min-width:104px">' + esc(x.label) + '</span>' +
        '<span class="track"><i style="width:' + (x.n / max * 100).toFixed(0) + '%"></i></span></div>' +
        '<div class="num">' + fmt(x.n) + ' 次 <em>' + pct(x.n / total, 0) + '</em>' +
        (x.degrade ? ' <span class="an-tag is-warn">降级 ' + x.degrade + '</span>' : '') +
        (x.n && x.n < SMALL ? ' <span class="an-tag">样本少</span>' : '') + '</div>' +
        '</div>'
    }).join('') + '</div>'
  }

  /* ===================== D 内容表现 ===================== */
  function drawItems(D) {
    var all = D.items || []
    var totalViews = all.reduce(function (a, b) { return a + b.views }, 0)
    if (!all.length) {
      $('itemsTable').innerHTML = ''
      $('itemsMore').innerHTML = ''
      $('itemSummary').textContent = ''
      return
    }
    if (!totalViews) {
      $('itemsTable').innerHTML = '<tr><td colspan="7" style="padding:0">' +
        emptyBox('这 ' + all.length + ' 条在窗口内都没有被点开', '等第一条真实浏览进来，这里会排出「谁在被读、谁被划过去」。') +
        '</td></tr>'
      $('itemsMore').innerHTML = ''
      $('itemSummary').innerHTML = all.length + ' 条中 <span class="an-num">0</span> 条被读过'
      return
    }

    var max = Math.max.apply(null, all.map(function (x) { return x.views })) || 1
    var rate = function (x) { return x.views ? x.outbound / x.views : null }
    var rows = all.filter(function (x) { return x.views > 0 }).slice(0, TOP_N)
    var zeros = all.filter(function (x) { return x.views === 0 })

    $('itemsTable').innerHTML = rows.map(function (x) {
      var r = rate(x)
      var noJump = x.views >= 20 && r < 0.4
      return '<tr>' +
        '<td class="c-time" style="color:var(--brand)">' + App.itemNo(x.id) + '</td>' +
        '<td class="c-title">' + esc(x.title) +
        (noJump ? ' <span class="an-tag">点开不跳转</span>' : '') + '</td>' +
        '<td style="text-align:right"><div class="an-cellbar" style="justify-content:flex-end">' +
        '<span class="t"><i style="width:' + (x.views / max * 100).toFixed(0) + '%"></i></span>' +
        '<span class="n">' + fmt(x.views) + '</span></div></td>' +
        '<td class="an-num" style="text-align:right">' + (x.outbound ? fmt(x.outbound) : '<span class="an-zero">0</span>') + '</td>' +
        '<td class="an-num" style="text-align:right' + (r >= 0.5 ? ';color:var(--brand)' : '') + '">' + pct(r, 0) + '</td>' +
        '<td class="an-num hide-sm" style="text-align:right">' + (x.shares ? fmt(x.shares) : '<span class="an-zero">0</span>') + '</td>' +
        '<td class="c-time" style="text-align:right">' + (x.last ? esc(x.last) : '—') + '</td>' +
        '</tr>'
    }).join('')

    // 长尾诊断：零浏览的条目单独成段 —— 「有曝光没人点」是内容问题，不是流量问题。
    // 但要先把「刚发布、还没来得及被看到」的排除掉（exposed = 发布日早于窗口起点）。
    if (zeros.length) {
      var exposedZeros = zeros.filter(function (x) { return x.exposed })
      var freshZeros = zeros.length - exposedZeros.length
      var show = exposedZeros.concat(zeros.filter(function (x) { return !x.exposed })).slice(0, 3)
      $('itemsTable').innerHTML += '<tr><td colspan="7" class="an-tail">' +
        '以下 ' + zeros.length + ' 条在窗口内零浏览 · 其中 <b>' + exposedZeros.length + ' 条</b> 是发布已满整窗口、' +
        '首页一直挂着却没人点（标题/概览没抓住人）；另 ' + freshZeros + ' 条是窗口内刚发布，还没被看到，先不下结论' +
        '</td></tr>' +
        show.map(function (x) {
          return '<tr class="is-faded">' +
            '<td class="c-time" style="color:var(--brand)">' + App.itemNo(x.id) + '</td>' +
            '<td class="c-title">' + esc(x.title) +
            (x.exposed ? ' <span class="an-tag is-warn">有曝光无人点</span>' : ' <span class="an-tag">新发布</span>') + '</td>' +
            '<td class="an-num" style="text-align:right"><span class="an-zero">0</span></td>' +
            '<td class="an-num" style="text-align:right">—</td>' +
            '<td class="an-num" style="text-align:right">—</td>' +
            '<td class="an-num hide-sm" style="text-align:right"><span class="an-zero">0</span></td>' +
            '<td class="c-time" style="text-align:right">—</td>' +
            '</tr>'
        }).join('')
    }

    var read = all.filter(function (x) { return x.views > 0 }).length
    var sorted = all.slice().sort(function (a, b) { return b.views - a.views })
    var head3 = sorted.slice(0, 3).reduce(function (a, b) { return a + b.views }, 0) / totalViews
    $('itemSummary').innerHTML = all.length + ' 条中 <span class="an-num">' + read + '</span> 条被读过 · ' +
      '头部 3 条占全部阅读的 <span class="an-num">' + Math.round(head3 * 100) + '%</span>'
    $('itemsMore').innerHTML = '<div style="padding:11px 14px;background:var(--surface-2);border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)">' +
      '被读过的按浏览量排前 ' + Math.min(TOP_N, rows.length) + ' 条在此 · 零浏览的在下面单独列出 · 共 ' + all.length + ' 条</div>'
  }

  /* ===================== E 来源 / 设备 / 回访 ===================== */
  function bars(hostId, rows, total, hot) {
    var host = $(hostId)
    if (!rows || !rows.length || !total) { host.innerHTML = emptyBox('暂无数据', ''); return }
    var max = Math.max.apply(null, rows.map(function (r) { return r.n })) || 1
    host.innerHTML = '<div class="an-rows">' + rows.map(function (r, i) {
      return '<div class="an-row' + (hot && i === 0 && r.n > 0 ? ' is-hot' : '') + '">' +
        '<div class="lab"><span style="min-width:88px">' + esc(r.label) + '</span>' +
        '<span class="track"><i style="width:' + (r.n / max * 100).toFixed(0) + '%"></i></span></div>' +
        '<div class="num">' + fmt(r.n) + '<em>' + pct(r.n / total, 0) + '</em></div></div>'
    }).join('') + '</div>'
  }

  function drawE(D) {
    bars('sources', D.sources, D.overview.sessions, true)

    var dTot = D.devices.reduce(function (a, b) { return a + b.n }, 0)
    if (!dTot) {
      $('devices').innerHTML = emptyBox('暂无数据', '')
    } else {
      var w = 100, segs = '', x = 0
      var cols = ['var(--brand)', 'rgba(26,26,26,.55)', 'rgba(26,26,26,.22)']
      D.devices.forEach(function (d, i) {
        var ww = d.n / dTot * w
        segs += '<rect x="' + x.toFixed(2) + '" y="0" width="' + ww.toFixed(2) + '" height="9" fill="' + cols[i] + '" rx="1"/>'
        x += ww
      })
      $('devices').innerHTML = '<svg class="an-chart" viewBox="0 0 100 9" height="9" preserveAspectRatio="none" style="margin-bottom:9px">' + segs + '</svg>' +
        '<div class="an-legend" style="gap:14px">' + D.devices.map(function (d, i) {
          return '<span><i class="sq" style="background:' + cols[i] + '"></i>' + esc(d.label) + ' ' + pct(d.n / dTot, 0) + '</span>'
        }).join('') + '</div>' +
        (D.browsers.length
          ? '<div class="an-note" style="margin-top:6px">浏览器：' + D.browsers.map(function (b) { return esc(b.label) + ' ' + pct(b.n / dTot, 0) }).join(' · ') + '</div>'
          : '')
    }

    var r = D.retention, tot = r.new + r.returning
    if (!tot) {
      $('retention').innerHTML = emptyBox('还没有访客', '')
      $('retNote').textContent = '回访率要等有访客之后才算得出来。'
      $('retTrend').innerHTML = ''
      return
    }
    $('retention').innerHTML = '<div class="an-rows">' +
      [['新访客', r.new, 'var(--text-2)'], ['回访访客', r.returning, 'var(--brand)']].map(function (x) {
        return '<div class="an-row' + (x[0] === '回访访客' && x[1] > 0 ? ' is-hot' : '') + '">' +
          '<div class="lab"><span style="min-width:88px">' + x[0] + '</span><span class="track"><i style="width:' + (x[1] / tot * 100).toFixed(0) + '%"></i></span></div>' +
          '<div class="num">' + fmt(x[1]) + '<em>' + pct(x[1] / tot, 0) + '</em></div></div>'
      }).join('') + '</div>'
    var rate = r.returning / tot
    $('retNote').innerHTML = '回访率 <b>' + pct(rate, 1) + '</b>（' + fmt(r.returning) + ' / ' + fmt(tot) + '）。' +
      (tot < SMALL
        ? '样本还太少，先别急着下结论。'
        : (rate < 0.2
          ? '内容站常见区间是 20–35%，当前偏低 —— 多数人「点开一条就走」，把首页做得更像索引（而不是引导页）是可以试的方向。'
          : '落在内容站 20–35% 的常见区间内，说明首页的「还有别的可看」是成立的。'))

    var wk = r.weekly || []
    var wMax = Math.max.apply(null, wk.map(function (x) { return x.total })) || 1
    $('retTrend').innerHTML = wk.length
      ? wk.map(function (x) {
          return '<div class="an-row">' +
            '<div class="lab"><span style="min-width:52px">' + esc(x.label) + '</span>' +
            '<span class="track"><i style="width:' + (x.total / wMax * 100).toFixed(0) + '%"></i></span></div>' +
            '<div class="num">' + fmt(x.returning) + ' / ' + fmt(x.total) + ' 回访<em>' + pct(x.rate, 0) + '</em>' +
            (x.total < SMALL ? ' <span class="an-tag">样本少</span>' : '') + '</div></div>'
        }).join('')
      : emptyBox('窗口内还没有满一周的数据', '按周聚合至少要跨过一周才会出现第一行。')
  }

  /* ===================== F 实时与健康度 ===================== */
  var EVENT_LABEL = {
    session_start: '会话开始',
    page_view: '页面浏览',
    view_item: '看详情',
    select_content: '点卡片',
    change_view_mode: '切视图',
    outbound_click: '跳原文',
    share: '分享',
    error: '前端报错',
    content_publish: '发布新条目'
  }

  function streamDetail(e) {
    var p = e.props || {}
    if (p.method) return '方式 ' + p.method + (p.degrade ? '（降级）' : '')
    if (p.dest_host) return '去向 ' + p.dest_host
    if (p.position) return '第 ' + p.position + ' 张 · ' + (p.view_mode || '')
    if (p.to) return '→ ' + p.to
    if (p.landing) return '落地 ' + p.landing
    if (p.kind) return p.kind + (p.msg ? ' · ' + String(p.msg).slice(0, 40) : '')
    return ''
  }

  function drawF(D, isEmpty) {
    $('liveNow').textContent = isEmpty ? '0' : fmt(D.activeNow)
    var max = Math.max.apply(null, D.hourly) || 1
    if (isEmpty || !D.hourly.some(function (v) { return v > 0 })) {
      $('hourly').innerHTML = emptyBox('今天还没有访客', '')
    } else {
      // 注意：这个局部量不能叫 bars —— var 提升后会遮蔽模块级的 bars() 助手函数，
      // 导致本函数末尾的 bars('versions', ...) 报 "bars is not a function"。
      var n = D.hourly.length, bw = 100 / n, seg = ''
      D.hourly.forEach(function (v, i) {
        var hh = v / max * 34
        seg += '<rect x="' + (i * bw + bw * 0.15).toFixed(2) + '" y="' + (36 - hh).toFixed(2) + '" width="' + (bw * 0.7).toFixed(2) + '" height="' + hh.toFixed(2) + '" fill="var(--brand)" opacity="' + (i >= n - 2 ? '1' : '.35') + '" rx="0.8"><title>' + i + ':00 · ' + v + ' 人</title></rect>'
      })
      $('hourly').innerHTML = '<svg class="an-chart" viewBox="0 0 100 40" height="40" preserveAspectRatio="none">' + seg + '</svg>' +
        '<div class="an-legend" style="justify-content:space-between;font-size:11px"><span>00:00</span><span>今日分时访客</span><span>23:00</span></div>'
    }

    $('stream').innerHTML = D.recent.length
      ? D.recent.map(function (e) {
          return '<div class="ln">' +
            '<span class="t">' + esc(e.t) + '</span>' +
            '<span class="ev" title="' + esc(e.event) + '">' + esc(EVENT_LABEL[e.event] || e.event) + '</span>' +
            '<span class="no">' + (e.no ? App.itemNo(e.no) : '—') + '</span>' +
            '<span style="color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(streamDetail(e)) + '</span>' +
            '<span class="mt">' + esc([e.device === 'mobile' ? '手机' : e.device === 'tablet' ? '平板' : e.device === 'desktop' ? '桌面' : '', e.kind && e.kind !== 'other' ? e.kind : ''].filter(Boolean).join(' · ')) + '</span>' +
            '</div>'
        }).join('')
      : '<div class="an-empty" style="padding:14px 0">最近 20 条事件会实时出现在这里。</div>'

    var h = D.health
    var cov = h.serverPv ? h.clientPv / h.serverPv : null
    var versionSum = (h.versions || []).reduce(function (a, b) { return a + b.n }, 0)
    var drops = h.drops || {}
    var dropTotal = Object.keys(drops).reduce(function (a, k) { return a + drops[k] }, 0)
    var DROP_LABEL = { bad_event: '不认识的事件名', debounce: '3 秒内重复', session_cap: '超单会话上限' }
    var cells = [
      {
        k: '埋点覆盖率', tag: cov === null ? '无数据' : (cov >= 0.95 ? '正常' : '偏低'),
        v: cov === null ? '—' : pct(cov, 0),
        s: '客户端 page_view ' + fmt(h.clientPv) + ' ÷ 服务端 ' + fmt(h.serverPv),
        bad: cov !== null && cov < 0.95
      },
      {
        k: '被丢弃事件', tag: dropTotal ? '有' : '无',
        v: fmt(dropTotal), s: '频控 / 白名单 / 去抖合计', bad: false
      },
      {
        k: '机器人流量', tag: h.botEvents ? '已剔除' : '无',
        v: fmt(h.botEvents), s: '标记而不丢弃，不进任何指标', bad: false
      },
      {
        k: '事件总量', tag: '窗口内',
        v: fmt(h.totalEvents), s: D.range.days + ' 天累计', bad: false
      }
    ]
    $('health').innerHTML = cells.map(function (c) {
      return '<div class="an-hcell' + (c.bad ? ' is-bad' : '') + '">' +
        '<div class="k"><span>' + esc(c.k) + '</span><span class="an-tag' + (c.bad ? ' is-warn' : ' is-ok') + '">' + esc(c.tag) + '</span></div>' +
        '<div class="v">' + esc(c.v) + '</div>' +
        '<div class="s">' + esc(c.s) + '</div></div>'
    }).join('')
    $('healthNote').innerHTML = '覆盖率 = 客户端 page_view ÷ 服务端 page_view。低于 95% 说明有访客的 JS 没跑起来（广告拦截 / 内嵌浏览器 / 脚本报错），' +
      '此时以服务端事件为流量底盘、客户端事件为行为口径 —— 两者都已落库，随时可重算。' +
      '注意：同会话 3 秒内重复的客户端 page_view 会被去抖，连续快速刷新时覆盖率会短暂偏低，这不是数据丢失。' +
      (dropTotal ? '<br>本期丢弃明细：' + Object.keys(drops).map(function (k) {
        return esc(DROP_LABEL[k] || k) + ' ' + drops[k]
      }).join(' · ') : '')

    bars('versions', h.versions, versionSum, false)
    if (!versionSum) $('versions').innerHTML = emptyBox('还没有带版本号的事件', '')
  }

  /* ===================== 剔除自己人 ===================== */
  function myVisitorId() {
    var m = document.cookie.match(/(?:^|; )rs_vid=([^;]*)/)
    if (!m) return null
    var v = m[1]
    try { v = decodeURIComponent(v) } catch (e) { /* 按原文校验 */ }
    return /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null
  }

  function loadExcl() {
    return App.data.listExclusions()
      .then(function (rows) {
        state.excl = rows
        state.exclLoaded = true
      })
      .catch(function () { state.excl = [] })
  }

  function drawExcl() {
    var host = $('exclNote')
    var vid = myVisitorId()
    var mine = vid ? state.excl.some(function (x) { return x.visitor_id === vid }) : false
    var n = state.excl.length
    var txt = n ? '已剔除 ' + n + ' 个「自己人」标识' : '未剔除任何标识'
    if (!vid) {
      host.innerHTML = esc(txt) + ' · <span class="an-tag">先打开一次公开页面再来排除本机</span>'
      return
    }
    host.innerHTML = esc(txt) + ' · <button class="link-btn" type="button" id="exclBtn">' +
      (mine ? '取消排除本机' : '排除本机') + '</button>'
    $('exclBtn').addEventListener('click', function () { toggleExcl(vid, mine) })
  }

  function toggleExcl(vid, mine) {
    // 「排除本机」行为与文案不变（票 #11）：写动经数据面，并发移除的
    // 0 行是正常终态不抛错（数据面刻意不做 0 行检查，见其注释）
    var p = mine ? App.data.includeVisitor(vid) : App.data.excludeVisitor(vid, '后台「排除本机」')
    p.then(function () {
      App.toast(mine ? '已恢复统计本机' : '已把本机排除出统计', 'ok')
      return loadExcl().then(function () { drawExcl(); return load() })
    }).catch(function (e) {
      App.toast(App.msg(e), 'error')
    })
  }

  /* ===================== 装载与渲染 ===================== */
  function setStatus(html) {
    $('dashStatus').innerHTML = html
    $('dashBody').hidden = !!html
  }

  function render() {
    var D = state.data
    if (!D) return
    var isEmpty = isEmptyData(D)
    var from = D.range.from, to = D.range.to
    $('rangeSub').textContent = '近 ' + D.range.days + ' 天 · ' + from + ' ~ ' + to + ' · 对照上一周期'
    $('fresh').innerHTML = '<i class="an-dot"></i>' +
      (D.recent.length ? '最近事件 ' + esc(D.recent[0].t) + ' · ' : '') + '时区 Asia/Shanghai'

    drawKpis(D, isEmpty)
    if (isEmpty) {
      $('trend').innerHTML = emptyBox('埋点已经就位，只等第一个访客', '趋势图从今天开始积累，明早这里会有第一段完整曲线。')
      $('trendNote').textContent = ''
      drawFunnel(D)      // 内部会处理 base=0 的空状态
      drawShare(D)
      drawItems(D)
      drawE(D)
    } else {
      drawTrend(D)
      drawFunnel(D)
      drawShare(D)
      drawItems(D)
      drawE(D)
    }
    drawF(D, isEmpty)
    drawExcl()
  }

  function load() {
    if (state.loading) return Promise.resolve()
    state.loading = true
    state.err = ''
    if (!state.data) setStatus('<div class="an-empty"><b>正在读取数据…</b></div>')
    return App.data.dashboard(state.days).then(function (d) {
      state.loading = false
      state.data = d
      setStatus('')
      render()
    }).catch(function (e) {
      state.loading = false
      state.data = null
      var msg = String((e && e.message) || e)
      state.err = msg
      // 必须留痕：render() 里的异常也会落到这里，而 Promise 内的异常不会触发 window.onerror，
      // 静默吞掉的结果就是「一个写着数据读取出错的空面板 + 零线索」。
      console.error('[AnDash] 看板读取/渲染失败:', (e && e.stack) || e)
      setStatus('<div class="an-empty"><b>' +
        (/forbidden|仅管理员/.test(msg) ? '只有管理员能看数据看板' : '数据读取出错') + '</b>' +
        esc(App.msg(e)) + '</div>')
    })
  }

  /* ===================== 事件 ===================== */
  function bindOnce() {
    $('range').addEventListener('click', function (ev) {
      var b = ev.target.closest('button')
      if (!b) return
      var days = Number(b.getAttribute('data-d'))
      if (!days || days === state.days) return
      Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) { x.classList.remove('is-on') })
      b.classList.add('is-on')
      state.days = days
      state.data = null
      load()
    })

    var t = null
    window.addEventListener('resize', function () {
      clearTimeout(t)
      t = setTimeout(function () {
        // 只在看板可见时重绘：隐藏容器宽度为 0，画出来会是一张空图。
        // 这里直接复用 render() 而不另抄一份「重绘哪几块」的清单：
        // 抄一份就会漏分支 —— 曾经就是这样，空态下 resize 会无条件调 drawTrend()，
        // 把「埋点已就位」的空态框换成一整屏 0 柱子（设计里明确要避免的那个画面）。
        // render() 是纯粹的重绘、幂等、无副作用，重复调用安全；此处已 debounce。
        if (state.active && state.data) render()
      }, 160)
    })
  }

  var bound = false

  var AnDash = {
    // 只有管理员才看得到这个页签；数据库里还有一道 is_admin() 兜底
    setEnabled: function (on) {
      state.enabled = !!on
      var btn = document.querySelector('.an-tab[data-tab="dash"]')
      if (btn) btn.hidden = !on
    },

    isEnabled: function () { return state.enabled },

    activate: function () {
      state.active = true
      if (!bound) { bindOnce(); bound = true }
      if (state.data) { render(); return Promise.resolve() }  // 切回来：重画以拿到真实宽度
      setStatus('<div class="an-empty"><b>正在读取数据…</b></div>')
      return Promise.all([loadExcl(), load()])
    },

    deactivate: function () { state.active = false },

    refresh: function () {
      state.data = null
      return load()
    }
  }

  window.AnDash = AnDash
})()
