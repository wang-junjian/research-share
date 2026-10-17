#!/usr/bin/env bash
# ===========================================================================
# 研究成果 · Agent 接口冒烟测试（可反复跑，跑完不留数据）
#
#   bash agent-api/smoke.sh                              # 打线上
#   BASE=http://127.0.0.1:3210 bash agent-api/smoke.sh   # 打本地
#
# 关于认证通道（线上实测）：
#   平台的边缘代理会把 `Authorization` 请求头吃掉，线上用它会得到 401
#   missing_token。可用的是 `X-Agent-Token: <token>`（推荐）与 `?token=<token>`。
#   本脚本默认用 X-Agent-Token，并在第 0 节把三条通道都探一遍。
#   可用 AUTH_HEADER=Authorization 覆盖。
#
# 依赖：curl、python3（解析 JSON）。脚本自己造的测试数据在结尾会删干净。
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${BASE:-http://127.0.0.1:3000}"
TOKEN="${TOKEN:-$(tr -d '[:space:]' < "$HERE/../.agent-token" 2>/dev/null)}"
AUTH_HEADER="${AUTH_HEADER:-X-Agent-Token}"
WRONG='rsa_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
KEY="smoke:$(date +%s)$RANDOM"

PASS=0; FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# jq 不一定装了，统一用 python3 取值
py() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(eval(sys.argv[2]))" "$1" "$2"; }

check() {  # check <说明> <期望> <实际>
  if [ "$2" = "$3" ]; then
    printf '  \033[32m✓\033[0m %-34s %s\n' "$1" "$3"; PASS=$((PASS+1))
  else
    printf '  \033[31m✗\033[0m %-34s 期望 %s，实际 %s\n' "$1" "$2" "$3"; FAIL=$((FAIL+1))
  fi
}

# req <方法> <路径> [数据] → $CODE 状态码，$TMP/r.json 响应体
req() {
  local m="$1" p="$2" d="${3:-}"
  local args=(-s -o "$TMP/r.json" -w '%{http_code}' -X "$m" "$BASE$p" -H "$AUTH_HEADER: $TOKEN")
  { [ "$m" = "POST" ] || [ "$m" = "PATCH" ]; } && args+=(-H 'Content-Type: application/json')
  [ -n "$d" ] && args+=(-d "$d")
  CODE=$(curl "${args[@]}")
}
req_wrong() {
  local m="$1" p="$2" d="${3:-}"
  local args=(-s -o "$TMP/r.json" -w '%{http_code}' -X "$m" "$BASE$p" -H "$AUTH_HEADER: $WRONG" -H 'Content-Type: application/json')
  [ -n "$d" ] && args+=(-d "$d")
  CODE=$(curl "${args[@]}")
}
req_noauth() {
  local m="$1" p="$2" d="${3:-}"
  local args=(-s -o "$TMP/r.json" -w '%{http_code}' -X "$m" "$BASE$p" -H 'Content-Type: application/json')
  [ -n "$d" ] && args+=(-d "$d")
  CODE=$(curl "${args[@]}")
}

echo "目标：$BASE"
echo "通道：$AUTH_HEADER"
[ -n "$TOKEN" ] || { echo "找不到 token：请设置 TOKEN 环境变量，或把令牌写入项目根目录的 .agent-token"; exit 1; }

echo
echo "── 0. 认证通道自检 ──"
PROBE='{"title":"通道自检","summary":"探针，随即删除。","url":"https://example.com/channel-probe"}'
probe() {  # probe <说明> <curl 参数...>
  local label="$1"; shift
  local code id
  code=$(curl -s -o "$TMP/r.json" -w '%{http_code}' "$@")
  if [ "$code" = "201" ]; then
    id=$(py "$TMP/r.json" "d['id']")
    curl -s -o /dev/null -X DELETE "$BASE/api/items/$id" -H "X-Agent-Token: $TOKEN"
    printf '  \033[32m✓\033[0m %-26s 可用\n' "$label"; PASS=$((PASS+1))
  else
    printf '  \033[33m—\033[0m %-26s 不可用（HTTP %s）\n' "$label" "$code"
  fi
}
probe "X-Agent-Token" -X POST "$BASE/api/items" -H "X-Agent-Token: $TOKEN" -H 'Content-Type: application/json' -d "$PROBE"
probe "?token=" -X POST "$BASE/api/items?token=$TOKEN" -H 'Content-Type: application/json' -d "$PROBE"
probe "Authorization: Bearer" -X POST "$BASE/api/items" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$PROBE"

echo
echo "── 1. 读（公开，不带凭证）──"
req_noauth GET /api/health
check "GET /api/health → 200" 200 "$CODE"
check "health.ok" True "$(py "$TMP/r.json" "d['ok']")"
req_noauth GET /api/items
check "GET /api/items → 200" 200 "$CODE"
BASE_COUNT="$(py "$TMP/r.json" "d['count']")"
echo "  基线：$BASE_COUNT 条"

echo
echo "── 2. 认证 ──"
req_noauth POST /api/items '{"title":"x","summary":"y","url":"https://e.com"}'
check "无凭证 → 401" 401 "$CODE"
req_wrong POST /api/items '{"title":"x","summary":"y","url":"https://e.com"}'
check "错 token → 401" 401 "$CODE"
check "错误类型" invalid_token "$(py "$TMP/r.json" "d['error']")"
req_noauth DELETE /api/items/1
check "DELETE 无凭证 → 401" 401 "$CODE"

echo
echo "── 3. 字段校验 ──"
req POST /api/items '{"title":"x","url":"https://e.com"}'
check "缺 summary → 400" 400 "$CODE"
check "错误类型" missing_field "$(py "$TMP/r.json" "d['error']")"
req POST /api/items '{"title":"x","summary":"y","url":"https://e.com","date":"2026/01/01"}'
check "date 格式错 → 400" 400 "$CODE"
req POST /api/items '[1,2]'
check "请求体非对象 → 400" 400 "$CODE"

echo
echo "── 4. 建 / 读 / 改 / 幂等 ──"
req POST /api/items "{\"title\":\"冒烟测试条目\",\"summary\":\"由 smoke.sh 写入，结尾会删掉。\",\"url\":\"https://example.com/smoke\",\"date\":\"2026-10-16\",\"source_key\":\"$KEY\"}"
check "POST 新建 → 201" 201 "$CODE"
check "action=created" created "$(py "$TMP/r.json" "d['action']")"
ID="$(py "$TMP/r.json" "d['id']")"
check "写入者被记录" main-agent "$(py "$TMP/r.json" "d['item']['source_agent']")"
check "owner 固定为军舰" "军舰" "$(py "$TMP/r.json" "d['item']['owner']")"

req GET "/api/items/$ID"
check "GET 单条 → 200" 200 "$CODE"
check "标题回读一致" "冒烟测试条目" "$(py "$TMP/r.json" "d['item']['title']")"
check "带 page_url" True "$(py "$TMP/r.json" "('$BASE/item/' + str(d['item']['id'])) in d['item']['page_url']")"

req POST /api/items "{\"title\":\"冒烟测试条目（改）\",\"summary\":\"由 smoke.sh 写入，结尾会删掉。\",\"url\":\"https://example.com/smoke\",\"source_key\":\"$KEY\"}"
check "同 source_key 再提交 → 200" 200 "$CODE"
check "action=updated" updated "$(py "$TMP/r.json" "d['action']")"
check "id 未变（幂等）" "$ID" "$(py "$TMP/r.json" "d['id']")"

req PATCH "/api/items/$ID" '{"summary":"只改摘要"}'
check "PATCH → 200" 200 "$CODE"
check "标题未被动" "冒烟测试条目（改）" "$(py "$TMP/r.json" "d['item']['title']")"
check "摘要已改" "只改摘要" "$(py "$TMP/r.json" "d['item']['summary']")"

echo
echo "── 5. 批量与原子性 ──"
req POST /api/items/batch "{\"items\":[{\"title\":\"批量一\",\"summary\":\"批量写入。\",\"url\":\"https://e.com/1\",\"source_key\":\"$KEY:1\"},{\"title\":\"批量二\",\"summary\":\"批量写入。\",\"url\":\"https://e.com/2\",\"source_key\":\"$KEY:2\"}]}"
check "批量 2 条 → 200" 200 "$CODE"
check "created=2" 2 "$(py "$TMP/r.json" "d['created']")"

BAD=$(python3 -c "print('长'*401)")
req POST /api/items/batch "{\"items\":[{\"title\":\"不该留下\",\"summary\":\"应回滚\",\"url\":\"https://e.com/a\",\"source_key\":\"$KEY:atomic\"},{\"title\":\"坏的\",\"summary\":\"$BAD\",\"url\":\"https://e.com/b\"}]}"
check "含非法条目 → 400" 400 "$CODE"
req GET /api/items
check "非法批未写入任何行" True "$(py "$TMP/r.json" "not any(i['source_key']=='$KEY:atomic' for i in d['items'])")"

echo
echo "── 6. 清理 ──"
req DELETE "/api/items/$ID"
check "DELETE → 200" 200 "$CODE"
req GET "/api/items/$ID"
check "删后 GET → 404" 404 "$CODE"
req DELETE "/api/items/$ID"
check "重复删 → 404" 404 "$CODE"

# 批量写进去的那两条也要清干净，否则反复跑会攒垃圾
req GET /api/items
LINGER="$(py "$TMP/r.json" "[i['id'] for i in d['items'] if (i['source_key'] or '').startswith('$KEY')]")"
CLEANED=0
for i in $(echo "$LINGER" | tr -d "[]',"); do
  req DELETE "/api/items/$i"
  [ "$CODE" = "200" ] && CLEANED=$((CLEANED+1))
done
check "批量残留已清理" 2 "$CLEANED"

req GET /api/items
check "条数回到基线" "$BASE_COUNT" "$(py "$TMP/r.json" "d['count']")"
check "无残留 source_key" "[]" "$(py "$TMP/r.json" "[i['source_key'] for i in d['items'] if (i['source_key'] or '').startswith('smoke:')]")"

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m全部通过：%d 项\033[0m\n' "$PASS"
else
  printf '\033[31m失败 %d 项 / 共 %d 项\033[0m\n' "$FAIL" "$((PASS+FAIL))"
fi
exit $((FAIL > 0 ? 1 : 0))
