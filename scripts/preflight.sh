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
curl -sf -m 5 "$BASE/" | grep -q '"demo":true' && fail "服务处于演示模式，.env 没有生效"
ok "不是演示模式"

echo
echo "全部通过，可以发布。"
