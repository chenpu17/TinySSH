#!/bin/bash
# R43 原生冒烟驱动（新装启用、原子停用与旧 Agent 配置迁移，实现 C9；§9 line 551/562-568 / §6.7 line 391 / §10.1 item6；真机 sshd 容器 + 真 vault + 真核心）：
#   r43a 新装默认停用（D03）：全新库 → collab_status=Disabled、collab 端点与 mcp 端点均为空串、Agent 列表为空
#         （无自动 MCP 监听）；无协作徽标、无委托入口；协作面板 = 一次性停用指引（无空审批区）；
#         「设置 → Agent 接入」停用态无 MCP 配置/端点，仅启用钮；显式启用 → 端点真绑定（/^http:\/\/127\.0\.0\.1:\d+\/mcp$/）
#         且状态转「已启用」；真命令 issue_agent 落库。
#   r43a 续（D08）：连真容器 → 关协作面板不改变控制权；真核心 delegate_session → owner=Agent；
#         设置里「已配置 1」「有活动请求 1」分别显示；停用预览事实齐备（受影响会话 1 / 已配置 Agent 1）且取消不改状态；
#         确认停用 → 原子封 admission：状态转 Disabled、collab 与 mcp 端点皆空、**Token 保留**、Agent 会话转 Human 且保留 ever_agent_owned；
#         重新启用 → 端点回来、旧会话不复活为 Agent。
#   r43b 升级路径（V7 迁移 / §10.1 item6）：驱动先把 r43a 的库改回 V6 并删 collab.enabled 行（模拟旧版安装），
#         再以「不重建库」启动 → 迁移后 collab 默认开启、端点自启；已配置 Agent/Token 跨升级保留；协作徽标出现；委托入口可用。
# 前置：tinyssh-e2e 容器在跑（22→127.0.0.1:2222）；屏幕已解锁（WKWebView 冻结闸）；
#       beacon 日志每阶段归档清空；口令走 env（钥匙串规避）；sqlite3 用于模拟旧版库。
set -u
APP=/Users/chenpu/workspace/claude-code/TinySSH/target/release/tinyssh-app
DIR=/tmp/smoke-r43
DB=$DIR/tinyssh.db
LOG=$DIR/beacon-r43.txt

mkdir -p "$DIR"
cp /Users/chenpu/workspace/claude-code/TinySSH/scripts/native-smoke/beacon.py "$DIR/beacon.py"
lsof -ti :15199 | xargs kill 2>/dev/null || true
rm -f "$DB" "$DB"-shm "$DB"-wal "$LOG"
cd "$DIR"
nohup python3 beacon.py x "$LOG" > /dev/null 2>&1 &
sleep 1

cleanup() {
  kill "${P1:-0}" 2>/dev/null
  echo "[driver] cleanup done"
}
trap cleanup EXIT

lock_state() {
  local w
  w=$(osascript -e 'tell application "System Events" to tell process "loginwindow" to get value of attribute "AXMainWindow"' 2>/dev/null)
  case "$w" in *登录*|*login*) echo locked;; *) echo unlocked;; esac
}
if [ "$(lock_state)" = "locked" ]; then
  echo "[driver] 屏幕已锁定——WKWebView 冻结页面 JS，原生 GUI e2e 必须等解锁后重跑"
  exit 3
fi

launch() { # $1=run-id $2=mode $3=fresh(1=重建库)
  if [ "${3:-1}" = "1" ]; then rm -f "$DB" "$DB"-shm "$DB"-wal; fi
  env TINYSSH_SMOKE=1 TINYSSH_SMOKE_MODE=$2 TINYSSH_RUN_ID=$1 \
      TINYSSH_DB=$DB TINYSSH_MASTER_PASSPHRASE=r43-smoke-pass \
      nohup "$APP" > "$DIR/app-$1.log" 2>&1 &
  local pid=$!
  sleep 3
  for proc in tinyssh-app tinyssh; do
    osascript -e "tell application \"System Events\" to tell process \"$proc\" to set frontmost to true" 2>/dev/null && break
  done
  echo $pid
}

wait_mark() {
  local pat=$1 timeout=${2:-240} elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if grep -q "$pat" "$LOG" 2>/dev/null; then return 0; fi
    if grep -q "FAIL-" "$LOG" 2>/dev/null; then echo "FAIL-seen" >&2; return 1; fi
    sleep 1; elapsed=$((elapsed+1))
  done
  echo "timeout-waiting-$pat last=[ $(tail -1 "$LOG" 2>/dev/null) ]" >&2
  return 1
}
stage_end() {
  kill $P1 2>/dev/null; sleep 2; kill -9 $P1 2>/dev/null
  cp "$LOG" "$DIR/beacon-$1.txt" 2>/dev/null
  : > "$LOG"
}

echo "[driver] ==== r43a 新装默认停用 + 原子停用/重新启用（真 vault 全新库）===="
P1=$(launch r43a-r1 r43a 1)
if wait_mark "r43a-DONE" 420; then
  for m in "r43a-fresh-ok" "r43a-disabled-guidance-ok" "r43a-settings-disabled-ok" \
           "r43a-enable-ok" "r43a-issue-ok" "r43a-panel-close-ok" "r43a-delegate-ok" \
           "r43a-indicators-ok" "r43a-preview-ok" "r43a-cancel-ok" "r43a-disable-ok" \
           "r43a-reenable-ok"; do
    grep -q "$m" "$LOG" || { echo "[driver] R43A FAILED: 缺标记 $m"; exit 2; }
  done
  if grep -q "JS-ERROR\|JS-REJECT" "$LOG"; then
    echo "[driver] R43A FAILED: 页面报错"; grep -m3 "JS-ERROR\|JS-REJECT" "$LOG"; exit 2
  fi
  echo "[driver] r43a ALL PASS（新装停用无端点/停用态指引/显式启用端点运行/关面板不改权/委托/双指标/预览取消/确认停用原子封+转 Human+Token 保留/重启用不复活）"
else
  echo "[driver] R43A FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
fi
stage_end r43a

echo "[driver] ==== 模拟旧版安装：把库改回 V6 并删 collab.enabled 行 ===="
# 注意：先关掉 app 再改库（stage_end 已 kill）。user_version=6 + 删行 → 重开触发 V7 迁移，version!=0 → 默认启用。
sqlite3 "$DB" "PRAGMA user_version=6; DELETE FROM settings WHERE key='collab.enabled';"
echo "[driver] after-rewrite: user_version=$(sqlite3 "$DB" 'PRAGMA user_version;') collab.enabled=[$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='collab.enabled';")]"

echo "[driver] ==== r43b 升级路径（复用 r43a 的库，不重建）===="
P1=$(launch r43b-r1 r43b 0)
if wait_mark "r43b-DONE" 360; then
  for m in "r43b-upgrade-enabled-ok" "r43b-agent-preserved-ok" "r43b-badge-ok" \
           "r43b-delegate-entry-ok"; do
    grep -q "$m" "$LOG" || { echo "[driver] R43B FAILED: 缺标记 $m"; exit 2; }
  done
  if grep -q "JS-ERROR\|JS-REJECT" "$LOG"; then
    echo "[driver] R43B FAILED: 页面报错"; grep -m3 "JS-ERROR\|JS-REJECT" "$LOG"; exit 2
  fi
  echo "[driver] r43b ALL PASS（旧版库升级保留 MCP 默认开启/端点自启/Agent+Token 保留/徽标出现/委托入口可用）"
else
  echo "[driver] R43B FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
fi
stage_end r43b

echo "[driver] ==== R43 原生冒烟全绿 ===="
