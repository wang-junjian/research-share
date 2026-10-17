/* ============================================================
 * 卡片摘要自适应填充 —— 只作用于网格视图
 *
 * 问题：正方形大卡片的高度由宽度锁死，而标题占几行随内容变化，
 * 于是摘要能塞几行也跟着变。CSS 里写死的 -webkit-line-clamp
 * 只能取一个折中值 —— 标题短了就白白空出一大块，标题长了又在
 * 留白的中途把文字硬截断。
 *
 * 做法（两步缺一不可）：
 *  1. CSS 把 .entry-summary 设成卡内唯一的弹性项（flex: 1 1 auto;
 *     min-height: 0），它的盒子高度于是等于卡片剩余高度。量出该高度
 *     除以行高，反算「能放满几行」，写回 line-clamp，末行以省略号收尾。
 *  2. 再把盒子高度钉到「行数 × 行高」。只做第 1 步是不够的：Blink 把
 *     省略号画在第 N 行末尾，裁剪边界却仍取盒子自己的高度；而卡片剩余
 *     高度几乎不会是行高的整数倍（如 76px vs 3×22.95=68.85），第 N+1 行
 *     就会从那 7px 的缝里露出半截被削平的字。钉成整行才能对齐裁剪边界。
 *
 * 本脚本不加 defer，紧跟在卡片标记之后解析：实测行数写入发生在
 * 126ms、首次含内容绘制在 152ms，早 26ms 生效，看不到「先按 fallback
 * 行数画一帧再跳成正确行数」的闪烁。
 * ============================================================ */
(function () {
  var root = document.documentElement
  var MIN_LINES = 1

  // 减 1px 容差：line-height 是小数，floor 时留一点余量避免末行被顶出行框
  function fit(el) {
    // 先解除上一轮的约束。max-height 会参与 flex 的主轴尺寸计算，
    // 不清掉的话第二次测量量到的是上次钉死的高度，改窗口之后行数就再也算不对了。
    el.style.maxHeight = ''
    var cs = getComputedStyle(el)
    var lh = parseFloat(cs.lineHeight)
    if (!lh || isNaN(lh)) lh = parseFloat(cs.fontSize) * 1.7
    var h = el.clientHeight
    if (!h || !lh) return
    var lines = Math.max(MIN_LINES, Math.floor((h - 1) / lh))
    el.style.webkitLineClamp = String(lines)
    el.style.WebkitLineClamp = String(lines)
    // 只设 line-clamp 不够：Blink 把「省略号」画在第 N 行末尾，但裁剪边界仍取
    // 盒子自己的高度。卡片剩余高度几乎不会是行高的整数倍（例如 76px vs 3×22.95=68.85），
    // 于是第 N+1 行会从这 7px 的缝里露出半截字。把盒子高度钉到整行数即可对齐裁剪边界。
    el.style.maxHeight = Math.floor(lines * lh * 100) / 100 + 'px'
  }

  // 列表态由 CSS 自己管行数；此处必须清掉行内值，否则行内优先级更高会盖住 CSS
  function unfit(el) {
    el.style.webkitLineClamp = ''
    el.style.WebkitLineClamp = ''
    el.style.maxHeight = ''
  }

  function run() {
    var list = document.querySelectorAll('.entry-list .entry-summary')
    if (!list.length) return
    var grid = root.getAttribute('data-view') !== 'list'
    for (var i = 0; i < list.length; i++) {
      if (grid) fit(list[i])
      else unfit(list[i])
    }
  }

  var pending = false
  function schedule() {
    if (pending) return
    pending = true
    requestAnimationFrame(function () {
      pending = false
      run()
    })
  }

  run()

  window.addEventListener('resize', schedule, { passive: true })
  window.addEventListener('orientationchange', schedule)
  // 字体换进来会让标题目数变化，进而改变摘要可用高度
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule)
  // 网格 ⇄ 列表 切换：由 server.js 里的视图脚本改 documentElement 上的 data-view
  new MutationObserver(schedule).observe(root, {
    attributes: true,
    attributeFilter: ['data-view'],
  })
})()
