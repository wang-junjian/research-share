// ---------------------------------------------------------------------------
// 分享链接修饰（GLOSSARY: 分享码）
//
// 平台的发布域名前置了一道防爬闸门：只有带 `?sharecode=<码>` 的请求才能进去，
// 通过的请求会被种一个 30 天的 __wb_rsc cookie，之后同浏览器内一路放行。
// 代价是「干净域名 + 任意路径」这种链接对外部访客一律 403（平台拦截页
// 「链接不完整」），连 /og/:id.png 封面图、/api/* 都不例外 —— 闸门在应用之前。
//
// 所以凡是「会被别人拿去打开」的地址，都必须带上这个码：
//   · 页面 canonical / og:url / og:image（微信抓取器不会自己补参数）
//   · 详情页 data-url（复制链接、海报二维码都以它为源）
//   · 后台与速记弹层里展示的托管地址
// 只在「本站共享出去」的场景加，不动站内相对链接与埋点用的路径 —— 那些不出站。
//
// 码本身不是密码（它是发给外部读者的），所以进源码、进页面都无妨；没配就当
// 没有这道闸门（别人的 clone 不该被迫带一个不属于自己的参数）。
// ---------------------------------------------------------------------------

export function withShare(url, code) {
  if (!url || !code) return url
  const sep = url.includes('?') ? '&' : '?'
  return url + sep + 'sharecode=' + encodeURIComponent(code)
}

// 站内路径 → 完整可分享地址。给浏览器侧用（assets/cloud.js 的 App.shareUrl 同口径）。
export function shareUrlOf(origin, path, code) {
  return withShare(String(origin || '').replace(/\/+$/, '') + (path || '/'), code)
}
