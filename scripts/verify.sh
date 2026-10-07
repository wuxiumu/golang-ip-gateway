#!/usr/bin/env bash
# =============================================================================
# ip-gateway 一键验证脚本
#
# 作用：用一套固定的「默认参考测试数据」在隔离端口自起一个网关实例，
#       对三类规则（基础 / 随机固定 / 分段固定）+ 管理接口做全量断言，
#       全程输出并生成日志文件 logs/verify-<时间戳>.log，不影响你正在运行的网关。
#
# 用法：./scripts/verify.sh
# 退出码：0 = 全部通过；1 = 有失败项
# =============================================================================
set -u
BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$BASE_DIR/ip-gateway"
LOG_DIR="$BASE_DIR/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/verify-$(date +%Y%m%d-%H%M%S).log"
PASS=0
FAIL=0
GW_PID=""

say()  { echo -e "$@" | tee -a "$LOG"; }
pass() { say "  \033[32m[PASS]\033[0m $1"; PASS=$((PASS + 1)); }
fail() { say "  \033[31m[FAIL]\033[0m $1（期望: $2，实际: $3）"; FAIL=$((FAIL + 1)); }
check() { # 名称 期望 实际
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi
}

# ---- 测试目标域名的期望值（与下方 fixture 一一对应） ----
T_A="https://a.example.com";  T_DEFAULT="https://default.example.com"
T_S1="https://s1.example.com"; T_S2="https://s2.example.com"; T_S3="https://s3.example.com"
T_R1="https://r1.example.com"; T_R2="https://r2.example.com"; T_R3="https://r3.example.com"

# ---- 选一个空闲端口（18099 起） ----
PORT=""
for p in $(seq 18099 18109); do
  if [ "$(lsof -nP -iTCP:$p -sTCP:LISTEN 2>/dev/null | wc -l | tr -d ' ')" = "0" ]; then PORT=$p; break; fi
done
[ -z "$PORT" ] && { echo "18099-18109 全部被占用"; exit 1; }

TMPDIR_V="$(mktemp -d /tmp/ipgw-verify.XXXXXX)"
cleanup() {
  [ -n "$GW_PID" ] && kill "$GW_PID" 2>/dev/null
  rm -rf "$TMPDIR_V"
}
trap cleanup EXIT

# ---- 无二进制则现场编译 ----
if [ ! -x "$BIN" ]; then
  say "未找到 $BIN，尝试编译..."
  if [ -x /usr/local/go/bin/go ]; then
    (cd "$BASE_DIR" && /usr/local/go/bin/go build -o ip-gateway .) || { echo "编译失败"; exit 1; }
  elif command -v go >/dev/null; then
    (cd "$BASE_DIR" && go build -o ip-gateway .) || { echo "编译失败"; exit 1; }
  else
    echo "未找到二进制且本机无 go，请先编译"; exit 1
  fi
fi

# ---- 生成参考测试数据（fixture）配置 ----
cat > "$TMPDIR_V/config.yaml" <<EOF
listen: ":$PORT"
default_target: "$T_DEFAULT"
admin_token: ""
trusted_proxies: ["127.0.0.1", "::1"]
redis:
  addr: "127.0.0.1:6390"   # 故意指向不存在的 redis，同时验证文件兜底
  password: ""
  db: 0
  key: "ip_gateway:rules"
rules:
  - type: "basic"
    ip_cidr: "192.168.1.0/24"
    target: "$T_A"
    enable: true
    remark: "示例：该网段全部跳 a"
  - type: "segment"
    ip_cidr: "10.0.0.0/8"
    targets: ["$T_S1", "$T_S2", "$T_S3"]
    enable: true
    remark: "示例：网段三等分"
  - type: "random"
    ip_cidr: "100.64.0.0/10"
    targets: ["$T_R1", "$T_R2", "$T_R3"]
    enable: true
    remark: "示例：随机三选一，IP 固定"
EOF

say "=============================================================="
say " ip-gateway 验证日志  $(date '+%Y-%m-%d %H:%M:%S')"
say " 端口: $PORT   日志: $LOG"
say "=============================================================="

"$BIN" -config "$TMPDIR_V/config.yaml" >> "$LOG" 2>&1 &
GW_PID=$!

# ---- 等待就绪 ----
READY=""
for i in $(seq 1 20); do
  if curl -s -m 1 "http://127.0.0.1:$PORT/healthz" | grep -q '"ok"'; then READY=1; break; fi
  sleep 0.5
done
if [ -z "$READY" ]; then say "网关启动失败，见日志尾部"; tail -5 "$LOG"; exit 1; fi

# ---- 工具函数 ----
api_test() { # ip → 返回 target（整链 /admin/test）
  curl -s -m 3 "http://127.0.0.1:$PORT/admin/test?ip=$1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('target',''))" 2>/dev/null
}
api_test_host() { # ip host → 指定接入域名的整链匹配结果
  curl -s -m 3 "http://127.0.0.1:$PORT/admin/test?ip=$1&host=$2" | python3 -c "import sys,json;print(json.load(sys.stdin).get('target',''))" 2>/dev/null
}
stat_val() { # total | 域名 → 统计值
  curl -s -m 3 "http://127.0.0.1:$PORT/admin/stats" | python3 -c "
import sys,json
d=json.load(sys.stdin)
k='''$1'''
if k=='total': print(d['total'])
else: print(next((t['count'] for t in d['targets'] if t['target']==k),0))" 2>/dev/null
}
go_redirect() { # ip [rule] → "状态码 重定向地址"
  local url="http://127.0.0.1:$PORT/admin/go?ip=$1"
  [ -n "${2:-}" ] && url="$url&rule=$2"
  curl -s -m 3 -o /dev/null -w '%{http_code} %{redirect_url}' "$url"
}
rule_id() { # type → 该分类规则的 ID
  curl -s -m 3 "http://127.0.0.1:$PORT/admin/rules" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(next((r['id'] for r in d['rules'] if r.get('type')=='$1'),''))" 2>/dev/null
}

# ================= 1. 基础规则 =================
say ""
say "—— 1. 基础规则（192.168.1.0/24 → a.example.com）——"
check "192.168.1.55 命中"        "$T_A"       "$(api_test 192.168.1.55)"
check "192.168.1.200 命中"       "$T_A"       "$(api_test 192.168.1.200)"
check "192.168.2.10 不命中→默认" "$T_DEFAULT" "$(api_test 192.168.2.10)"
check "enable 开关外的网段→默认" "$T_DEFAULT" "$(api_test 172.16.5.5)"

# ================= 2. 分段固定（10.0.0.0/8 三等分） =================
say ""
say "—— 2. 分段固定（10.0.0.0/8 → s1/s2/s3 三等分）——"
check "10.0.0.1   → 第1段" "$T_S1" "$(api_test 10.0.0.1)"
check "10.100.0.1 → 第2段" "$T_S2" "$(api_test 10.100.0.1)"
check "10.200.0.1 → 第3段" "$T_S3" "$(api_test 10.200.0.1)"
check "段边界 10.85.85.84  → 第1段" "$T_S1" "$(api_test 10.85.85.84)"
check "段边界 10.85.85.85  → 第2段" "$T_S2" "$(api_test 10.85.85.85)"
check "段边界 10.170.170.170 → 第3段" "$T_S3" "$(api_test 10.170.170.170)"

# ================= 3. 随机固定（100.64.0.0/10 → r1/r2/r3） =================
say ""
say "—— 3. 随机固定（100.64.0.0/10 → r1/r2/r3，IP 哈希固定）——"
check "100.64.0.1 → r3（固定值）" "$T_R3" "$(api_test 100.64.0.1)"
check "100.64.0.2 → r1（固定值）" "$T_R1" "$(api_test 100.64.0.2)"
check "100.64.0.3 → r2（固定值）" "$T_R2" "$(api_test 100.64.0.3)"
X1="$(api_test 100.64.0.1)"; X2="$(api_test 100.64.0.1)"
check "同 IP 两次结果一致（粘性）" "$X1" "$X2"
D="$( { api_test 100.64.0.1; api_test 100.64.0.2; api_test 100.64.0.3; } | sort -u | wc -l | tr -d ' ')"
check "不同 IP 分布到 3 个域名" "3" "$D"

# ================= 4. 真实 302 跳转 /admin/go =================
say ""
say "—— 4. 真实 302 跳转（/admin/go，浏览器打开即可看到落点）——"
check "整链 10.200.0.1 → 302 s3" "302 $T_S3/" "$(go_redirect 10.200.0.1)"
check "整链 8.8.8.8   → 302 默认" "302 $T_DEFAULT/" "$(go_redirect 8.8.8.8)"
SEG_ID="$(rule_id segment)"
check "单规则 segment 10.0.0.1 → 302 s1" "302 $T_S1/" "$(go_redirect 10.0.0.1 "$SEG_ID")"
check "单规则 IP 不匹配 → 400 提示" "400" "$(go_redirect 8.8.8.8 "$SEG_ID" | cut -d' ' -f1)"
check "未知规则 ID → 404" "404" "$(go_redirect 8.8.8.8 rdeadbeef | cut -d' ' -f1)"

# ================= 5. 管理接口（保存热生效 / 降级 / 开关） =================
say ""
say "—— 5. 管理接口（保存热生效 / reload 降级 / enable 开关）——"
post_rules() { curl -s -m 3 -X POST "http://127.0.0.1:$PORT/admin/rules" -H 'Content-Type: application/json' -d "$1" > /dev/null; }
RULES_TMPL='{"default_target":"%s","rules":[{"type":"basic","ip_cidr":"192.168.1.0/24","target":"https://a.example.com","enable":%s},{"type":"segment","ip_cidr":"10.0.0.0/8","targets":["https://s1.example.com","https://s2.example.com","https://s3.example.com"],"enable":true},{"type":"random","ip_cidr":"100.64.0.0/10","targets":["https://r1.example.com","https://r2.example.com","https://r3.example.com"],"enable":true}]}'

post_rules "$(printf "$RULES_TMPL" "https://changed.example.com" "true")"
check "保存新默认目标后立即生效" "https://changed.example.com" "$(api_test 8.8.8.8)"
curl -s -m 3 -X POST "http://127.0.0.1:$PORT/admin/reload" > /dev/null
check "reload（redis 挂→文件兜底）后仍生效" "https://changed.example.com" "$(api_test 8.8.8.8)"

post_rules "$(printf "$RULES_TMPL" "https://changed.example.com" "false")"
check "enable=false 后规则被跳过" "https://changed.example.com" "$(api_test 192.168.1.55)"

post_rules "$(printf "$RULES_TMPL" "$T_DEFAULT" "true")"
check "恢复默认目标" "$T_DEFAULT" "$(api_test 8.8.8.8)"

# ================= 6. 规则 ID 重启稳定 =================
say ""
say "—— 6. 规则 ID 稳定性（重启后旧测试链接仍可用）——"
SEG_ID_1="$(rule_id segment)"
kill "$GW_PID" 2>/dev/null; wait "$GW_PID" 2>/dev/null; GW_PID=""
"$BIN" -config "$TMPDIR_V/config.yaml" >> "$LOG" 2>&1 &
GW_PID=$!
for i in $(seq 1 20); do curl -s -m 1 "http://127.0.0.1:$PORT/healthz" | grep -q '"ok"' && break; sleep 0.5; done
SEG_ID_2="$(rule_id segment)"
check "重启前后 segment 规则 ID 一致" "$SEG_ID_1" "$SEG_ID_2"
check "旧 ID 的测试链接仍可用" "302 $T_S1/" "$(go_redirect 10.0.0.1 "$SEG_ID_2")"

# ================= 7. 接入域名维度（host 隔离） =================
say ""
say "—— 7. 接入域名维度（host 隔离，支持 *.example.com 通配）——"
post_rules '{"default_target":"https://default.example.com","rules":[{"type":"random","ip_cidr":"0.0.0.0/0","host":"abc.example.com","targets":["https://r1.example.com","https://r2.example.com"],"enable":true}]}'
check "host 不匹配 → 规则跳过走默认" "$T_DEFAULT" "$(api_test_host 8.8.8.8 other.example.com)"
H1="$(api_test_host 8.8.8.8 abc.example.com)"
H2="$(api_test_host 8.8.8.8 abc.example.com)"
check "host 匹配 → 随机分配生效" "ok" "$({ [ "$H1" = "$T_R1" ] || [ "$H1" = "$T_R2" ]; } && echo ok || echo bad)"
check "同 IP 同 host 粘性一致" "$H1" "$H2"
post_rules "$(printf "$RULES_TMPL" "$T_DEFAULT" "true")"
check "恢复标准 fixture" "$T_S2" "$(api_test 10.100.0.1)"

# ================= 8. 流量统计 =================
say ""
say "—— 8. 流量统计（仅真实请求计数，XFF 模拟来源 IP）——"
for i in 1 2; do curl -s -o /dev/null -m 3 -H "X-Forwarded-For: 8.8.4.4" "http://127.0.0.1:$PORT/some-path"; done
curl -s -o /dev/null -m 3 -H "X-Forwarded-For: 10.0.0.1" "http://127.0.0.1:$PORT/some-path"
curl -s -o /dev/null -m 3 -H "X-Forwarded-For: 100.64.0.1" "http://127.0.0.1:$PORT/some-path"
check "总命中 = 4" "4" "$(stat_val total)"
check "默认目标命中 = 2" "2" "$(stat_val "$T_DEFAULT")"
check "s1 命中 = 1" "1" "$(stat_val "$T_S1")"
check "r3 命中 = 1" "1" "$(stat_val "$T_R3")"
curl -s -m 3 -X POST "http://127.0.0.1:$PORT/admin/stats/reset" > /dev/null
check "清零后 total = 0" "0" "$(stat_val total)"

check_ge() { # 下限 实际 名称
  if [ "$2" -ge "$1" ]; then pass "$3（实际 $2 ≥ 下限 $1）"; else fail "$3" "≥$1" "$2"; fi
}

# ================= 9. 权重分流（随机分类 50/30/20 加权） =================
say ""
say "—— 9. 权重分流（随机分类按 50/30/20 加权，IP 仍固定）——"
curl -s -m 3 -X POST "http://127.0.0.1:$PORT/admin/stats/reset" > /dev/null
post_rules '{"default_target":"https://default.example.com","rules":[{"type":"random","ip_cidr":"0.0.0.0/0","targets":["https://r1.example.com","https://r2.example.com","https://r3.example.com"],"weights":[50,30,20],"enable":true}]}'
for i in $(seq 1 60); do
  wip="$((RANDOM % 200 + 20)).$((RANDOM % 256)).$((RANDOM % 256)).$((RANDOM % 254 + 1))"
  curl -s -o /dev/null -m 3 "http://127.0.0.1:$PORT/admin/go?ip=$wip&count=1"
done
W1="$(stat_val "$T_R1")"; W2="$(stat_val "$T_R2")"; W3="$(stat_val "$T_R3")"
say "  实测分布：r1=${W1} r2=${W2} r3=${W3} （60 次，期望约 30/18/12）"
check_ge 15 "$W1" "r1 按权重约 50%"
check_ge 6  "$W2" "r2 按权重约 30%"
check_ge 2  "$W3" "r3 按权重约 20%"
S1="$(api_test 8.8.8.8)"; S2="$(api_test 8.8.8.8)"
check "加权后同 IP 仍粘性一致" "$S1" "$S2"
post_rules "$(printf "$RULES_TMPL" "$T_DEFAULT" "true")"
curl -s -m 3 -X POST "http://127.0.0.1:$PORT/admin/stats/reset" > /dev/null
check "恢复标准 fixture" "$T_S2" "$(api_test 10.100.0.1)"

# ================= 10. 区域分流（ip2region 归属地关键词匹配） =================
say ""
say "—— 10. 区域分流（归属地关键词：广东/北京/美国）——"
if curl -s -m 3 "http://127.0.0.1:$PORT/healthz" | grep -q '"geo":true'; then
  post_rules '{"default_target":"https://default.example.com","rules":[{"type":"region","country":"广东","target":"https://gd.example.com","enable":true},{"type":"region","country":"北京","target":"https://bj.example.com","enable":true},{"type":"region","country":"美国","target":"https://us.example.com","enable":true}]}'
  check "14.215.177.39（广州电信）→ 广东" "https://gd.example.com" "$(api_test 14.215.177.39)"
  check "202.96.134.33（深圳电信）→ 广东" "https://gd.example.com" "$(api_test 202.96.134.33)"
  check "61.135.169.121（北京联通）→ 北京" "https://bj.example.com" "$(api_test 61.135.169.121)"
  check "8.8.8.8（美国）→ 美国" "https://us.example.com" "$(api_test 8.8.8.8)"
  check "36.152.44.96（江苏，未配置）→ 默认" "$T_DEFAULT" "$(api_test 36.152.44.96)"
  check "校验：空关键词应 400" "400" "$(curl -s -o /dev/null -w '%{http_code}' -m 3 -X POST http://127.0.0.1:$PORT/admin/rules -H 'Content-Type: application/json' -d '{"default_target":"https://default.example.com","rules":[{"type":"region","country":"","target":"https://x.example.com","enable":true}]}')"
  post_rules "$(printf "$RULES_TMPL" "$T_DEFAULT" "true")"
  check "恢复标准 fixture" "$T_S2" "$(api_test 10.100.0.1)"
else
  say "  \033[33m[SKIP]\033[0m 网关未加载地理库（geo:false），区域分流用例跳过"
fi

# ================= 汇总 =================
say ""
say "=============================================================="
if [ "$FAIL" -eq 0 ]; then
  say " \033[32m验证完成：$PASS 项全部通过\033[0m"
else
  say " \033[31m验证完成：通过 $PASS 项，失败 $FAIL 项\033[0m"
fi
say " 日志已保存: $LOG"
say "=============================================================="
[ "$FAIL" -eq 0 ] || exit 1
