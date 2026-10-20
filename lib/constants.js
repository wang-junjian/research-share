// ---------------------------------------------------------------------------
// 共享常量 module（GLOSSARY: 共享常量）：跨服务端/浏览器双写常量的单一来源。
//
// 消费方与读取方式：
//   - SSR 埋点（lib/track.js）：直接 import APP_VERSION
//   - 客户端埋点（assets/track.js 壳与 assets/track-core.js 核心）与快速分享
//     （assets/quick-share.js）：读 window.RS_CONST —— 由静态资源模块
//     （lib/static-files.js）在请求时用 browserConstantsScript() 动态生成
//     /assets/constants.js（不落盘、演示模式可用），公开页布局无条件、
//     先于 track-core.js / track.js 加载
//
// 无法由代码生成的三处维持注释对照，改动时手工同步：
//   - db/06-doc-items.sql 的 CHECK 与函数内上限（1000000）
//   - 平台边缘 WAF 的禁脚本规则（ADR-0004）
//   - lib/render.js 的退出开关内联脚本 OPTOUT_SCRIPT（先于 deferred 的
//     constants.js 执行、读不到 RS_CONST，键名维持字面量 + 注释点名）
// ---------------------------------------------------------------------------

// 埋点口径版本：改口径必须递增，否则跨版本趋势不可比。
// v2：下线 change_view_mode，select_content 不再带 view_mode（视图切换功能已移除）。
// 客户端与 SSR 同版本，否则 versions 面板里同口径的事件会被拆成两个版本块。
export const APP_VERSION = 'v2'

// 文档型成果的字符上限：与 db/06 的 CHECK 同口径，1MB 按字符数计（char_length）。
// 浏览器预检（quick-share）读它给出超限提示，数据库 CHECK 兜底。
export const DOC_MAX_CHARS = 1000000

// 「退出统计」开关的存储键名：localStorage 键与 cookie 键。
// 判定逻辑因 seam 各留一份（render.js 内联脚本即时绘制开关态 vs 埋点采集核心
// 拦截入队与补发），键名以此文件为准；track.js 壳从 RS_CONST 读入传给核心，
// render.js 的 OPTOUT_SCRIPT 维持字面量 + 注释点名（见本文件头部对照清单）。
export const OPTOUT_LS_KEY = 'rs:optout'
export const OPTOUT_COOKIE_KEY = 'rs_optout'

// 浏览器侧常量脚本的生成：静态资源模块在请求时调用，挂 window 全局。
// 演示模式（无云服务配置）下公开页不加载 SDK，但 track.js 无条件加载——
// 所以常量脚本不依赖 cloud.js / window.App，独立挂 window.RS_CONST。
export function browserConstantsScript() {
  return `window.RS_CONST = Object.freeze(${JSON.stringify({ APP_VERSION, DOC_MAX_CHARS, OPTOUT_LS_KEY, OPTOUT_COOKIE_KEY })})\n`
}
