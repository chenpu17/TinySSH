#!/bin/bash
# R42 原生冒烟驱动（协作入口、首次委托、审批、接管/交还 §3.2 / §4.2 / §5 迁移表 / §6.7；真机 sshd 容器 + 真 vault + 真核心）：
#   r42a 新装未启用：真 vault 无 Agent → 无协作徽标、不显示委托入口；工具菜单按 §3.2 精确枚举
#         （连接详情/端口转发/活动记录/关闭会话，无「审批与记录」）；协作面板改一次性引导
#         （不渲染空审批区/空白委托表单）；「设置 → Agent 接入」为空且 MCP 端点为真绑定地址；
#         末尾用真命令 issue_agent 签发 Agent 并落库（真 vault 持久化，供 r42b 复用同库）。
#   r42b 已登记 Agent（复用 r42a 的库，**不重建**）：挂载即读真 vault → 协作徽标出现；连接真容器；
#         首次委托对话框事实齐全（主机/会话/能力/现有授权范围，无持久 Shell 如实告知）；
#         取消不改控制权；明确提交才切 Agent 持有（真核心 delegate_session 且落 goal）；工具栏转
#         「接管」；接管收回 Human 且保留「曾被 Agent 持有」印记（入口措辞转「交还 Agent」）。
# 前置：tinyssh-e2e 容器在跑（22→127.0.0.1:2222）；屏幕已解锁（WKWebView 冻结闸）；
#       beacon 日志每阶段归档清空；口令走 env（钥匙串规避）。
set -u
APP=/Users/chenpu/workspace/claude-code/TinySSH/target/release/tinyssh-app
DIR=/tmp/smoke-r42
DB=$DIR/tinyssh.db
LOG=$DIR/beacon-r42.txt

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
      TINYSSH_DB=$DB TINYSSH_MASTER_PASSPHRASE=r42-smoke-pass \
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

echo "[driver] ==== r42a 新装未启用（真 vault 无 Agent）===="
P1=$(launch r42a-r1 r42a 1)
if wait_mark "r42a-DONE" 360; then
  for m in "r42a-precondition-ok" "r42a-no-badge" "r42a-no-delegate" "r42a-menu-ok" \
           "r42a-guidance-ok" "r42a-settings-ok" "r42a-issue-ok"; do
    grep -q "$m" "$LOG" || { echo "[driver] R42A FAILED: 缺标记 $m"; exit 2; }
  done
  if grep -q "JS-ERROR\|JS-REJECT" "$LOG"; then
    echo "[driver] R42A FAILED: 页面报错"; grep -m3 "JS-ERROR\|JS-REJECT" "$LOG"; exit 2
  fi
  echo "[driver] r42a ALL PASS（无徽标/无委托入口/菜单精确枚举/一次性引导/设置空+真端点/签发落库）"
else
  echo "[driver] R42A FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
fi
stage_end r42a

echo "[driver] ==== r42b 已登记 Agent（复用 r42a 的库）===="
P1=$(launch r42b-r1 r42b 0)
if wait_mark "r42b-DONE" 360; then
  for m in "r42b-badge-ok" "r42b-dialog-ok" "r42b-cancel-ok" "r42b-delegate-ok" \
           "r42b-takeover-entry" "r42b-takeover-ok" "r42b-handback-label"; do
    grep -q "$m" "$LOG" || { echo "[driver] R42B FAILED: 缺标记 $m"; exit 2; }
  done
  if grep -q "JS-ERROR\|JS-REJECT" "$LOG"; then
    echo "[driver] R42B FAILED: 页面报错"; grep -m3 "JS-ERROR\|JS-REJECT" "$LOG"; exit 2
  fi
  echo "[driver] r42b ALL PASS（徽标出现/对话框事实齐全/取消不改权/提交切 Agent 并落 goal/接管收回并保留印记）"
else
  echo "[driver] R42B FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
fi
stage_end r42b

echo "[driver] ==== R42 原生冒烟全绿 ===="
