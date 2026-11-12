#!/usr/bin/env bash
#
# 发布前自检。
#
# 为什么需要它：这个站点一旦缺了云服务配置，不会报错、不会 500，
# 而是静默进入「演示模式」—— 页面照常返回 200，只是内容变成
# data/sample-items.json 里的示例数据。线上那一侧看不出任何异常，
# 只有等你发现「数据怎么只剩几条了」才知道。所以发布前必须主动验。
#
# 用法：
#   ./scripts/preflight.sh
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
PORT="${PORT:-3999}"
BASE="http://127.0.0.1:${PORT}"

fail() { echo "✗ $*" >&2; exit 1; }
ok()   { echo "✓ $*"; }

echo "自检目录：$REPO_DIR"
echo

# 1. 配置：缺任何一项都会落到演示模式
[ -f .env ] || fail "没有 .env。cp .env.example .env 并填 CLOUD_ENDPOINT / CLOUD_PUBLISHABLE_KEY / SITE_URL"
for key in CLOUD_ENDPOINT CLOUD_PUBLISHABLE_KEY SITE_URL; do
  grep -qE "^${key}=.+" .env || fail ".env 里 ${key} 为空"
done
ok ".env 三项配置齐全"

# 1b. 顶栏外链：半配置是最坏的情况 —— 它不报错、也不渲染，
# 只会让人以为「改了没生效」，然后去查 CSS 和缓存。
LINK_URL="$(grep -E '^SITE_LINK_URL=' .env | cut -d= -f2- || true)"
LINK_TITLE="$(grep -E '^SITE_LINK_TITLE=' .env | cut -d= -f2- || true)"
if [ -n "${LINK_URL}" ] || [ -n "${LINK_TITLE}" ]; then
  [ -n "${LINK_URL}" ] && [ -n "${LINK_TITLE}" ] \
    || fail "SITE_LINK_URL 与 SITE_LINK_TITLE 必须同时配：只配一项时顶栏外链静默不渲染"
  ok "顶栏外链已配置：${LINK_TITLE}"
else
  ok "顶栏外链未配置（按设计不渲染）"
fi

# 2. 语法：沙箱里 npm start 之前不会有人替你发现这个
node --check server.js
node --check og-image.js
ok "server.js / og-image.js 语法通过"

# 3. 真的跑起来，确认读到的是真实数据而不是示例数据
PORT="${PORT:-3999}" node server.js >/tmp/research-share-preflight.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT

for _ in $(seq 1 20); do
  curl -sf -m 2 "$BASE/api/health" >/dev/null 2>&1 && break
  sleep 0.3
done

HEALTH="$(curl -sf -m 5 "$BASE/api/health")" || {
  echo "--- 服务日志 ---" >&2; cat /tmp/research-share-preflight.log >&2; fail "服务没起来"
}
COUNT="$(echo "$HEALTH" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.count??-1)})')"
[ "$COUNT" -gt 0 ] || fail "数据是 0 条（云服务没连上？）"
ok "读到 ${COUNT} 条数据"

# 4. 演示模式的兜底判定：首页注入的 PUBLIC_CONFIG 里 demo 为 true 就说明配置没生效
HOME_HTML="$(curl -sf -m 5 "$BASE/")"
echo "$HOME_HTML" | grep -q '"demo":true' && fail "服务处于演示模式，.env 没有生效"
ok "不是演示模式"

# 5. 顶栏外链配了就必须真渲染出来（配置生效了但模板没输出，同样是静默失败）
if [ -n "${LINK_URL}" ]; then
  echo "$HOME_HTML" | grep -q 'topbar-ext' || fail "配了 SITE_LINK_URL 但首页顶栏没有外链"
  # 标记错了不会报错，只会让看板的「外部入口」恒为 0 —— 而 0 次点击长得像
  # 「没人点」，是最容易被误读成结论的一种失败。
  echo "$HOME_HTML" | grep -qE 'topbar-ext[^>]*data-track-skip' \
    && fail "顶栏外链带 data-track-skip，ext_click 会被整条跳过（看板永远显示 0）"
  echo "$HOME_HTML" | grep -qE 'topbar-ext[^>]*data-ext="topbar"' \
    || fail "顶栏外链缺 data-ext=topbar，看板的「外部入口」会恒为 0"
  ok "首页顶栏外链已渲染，且带 data-ext=topbar（可统计）"
fi

# 6. 分享码：发布域名前面有一道防爬闸门，只认 ?sharecode=<码>。
# 漏了它不会报错 —— 站内点得开（自己浏览器已种 cookie），但复制出去的链接、
# 印成二维码的海报、微信抓取的封面图，对别人全都是平台的「链接不完整」拦截页。
# 这是本站最贵的一种静默失败：内容全对，只有别人打不开。
SHARE_CODE="$(grep -E '^SITE_SHARE_CODE=' .env | cut -d= -f2- || true)"
SITE_URL_VAL="$(grep -E '^SITE_URL=' .env | cut -d= -f2- || true)"
if [ -z "${SHARE_CODE}" ] && printf '%s' "${SITE_URL_VAL}" | grep -q '\.app\.workbuddy\.host'; then
  fail "SITE_URL 是 WorkBuddy 发布域名，但 SITE_SHARE_CODE 为空：
   平台闸门只认 ?sharecode=<码>，现在复制出去的链接/二维码对别人都是 403。
   把应用分享链接里的 sharecode 值填进 .env 的 SITE_SHARE_CODE 再发布。"
fi
if [ -n "${SHARE_CODE}" ]; then
  echo "$HOME_HTML" | grep -q "canonical\" href=\"${SITE_URL_VAL}/?sharecode=${SHARE_CODE}\"" \
    || fail "配了 SITE_SHARE_CODE 但首页 canonical 没带上它"
  # 取一条真实条目：详情页的 data-url 是「复制链接」与海报二维码的唯一来源
  ITEM_ID="$(printf '%s' "$HOME_HTML" | grep -oE '/item/[0-9]+' | head -1 | grep -oE '[0-9]+$' || true)"
  DETAIL="$(curl -sf -m 5 "$BASE/item/${ITEM_ID:-1}")" || DETAIL=""
  if [ -n "$DETAIL" ]; then
    echo "$DETAIL" | grep -q "data-url=\"[^\"]*?sharecode=${SHARE_CODE}\"" \
      || fail "详情页 data-url 没带分享码：复制链接与海报二维码都会指向打不开的地址"
    echo "$DETAIL" | grep -q "og:image\" content=\"[^\"]*?sharecode=${SHARE_CODE}\"" \
      || fail "og:image 没带分享码：微信抓取封面图会撞上平台的 403，卡片没有缩略图"
    ok "分享码已贯穿 canonical / data-url / og:image"
  else
    ok "分享码已配置（详情页取样跳过）"
  fi
else
  ok "未配置分享码（按设计当作没有闸门）"
fi

echo
echo "全部通过，可以发布。"
