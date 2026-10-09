#!/bin/bash
# R41 原生冒烟驱动（活动记录、连接详情与凭据设置 §6.6 / §5 / S09-S11；真机 sshd 容器 + 真 vault）：
#   r41a 连接详情：真连容器 → 详情展示连接参数（用户/地址/端口/认证/编码）+ 日期时区 + 会话 ID
#         → 复制有成功反馈 → 独立关闭不影响会话 → **真改主机库**（改名改址）后重开详情，
#         仍是连接当时身份（§6.1 快照，非按 host_id 现查）。
#   r41b 活动记录：真 exec_human 造事件 → 工作区视图（非对话框）→ 默认当前会话、行含主机名/会话 id
#         /日期/时区 → 切全部为超集 → 事件类型与人类/Agent 筛选 → **真审计库** seq 游标翻页
#         不重不漏、total 不缩水 → 关闭会话后记录仍在并保留主机身份。
#   r41c 凭据设置：真 vault。左分类单对话框 → 填表不落库、点「生成」才落库（显式提交）
#         → 未绑定态 → 未提交私钥草稿切分类先处置（留下/丢弃）→ 被主机引用时删除被拒并列出占用主机。
# 前置：tinyssh-e2e 容器在跑（22→127.0.0.1:2222）；屏幕已解锁（WKWebView 冻结闸）；
#       beacon 日志每阶段归档清空；口令走 env（钥匙串规避）。
set -u
APP=/Users/chenpu/workspace/claude-code/TinySSH/target/release/tinyssh-app
DIR=/tmp/smoke-r41
DB=$DIR/tinyssh.db
LOG=$DIR/beacon-r41.txt

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

launch() { # $1=run-id $2=mode
  # 每阶段全新库：r41a 会真改主机库（改名改址）以验证快照，跨阶段复用会污染后续阶段的主机表
  rm -f "$DB" "$DB"-shm "$DB"-wal
  env TINYSSH_SMOKE=1 TINYSSH_SMOKE_MODE=$2 TINYSSH_RUN_ID=$1 \
      TINYSSH_DB=$DB TINYSSH_MASTER_PASSPHRASE=r41-smoke-pass \
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

echo "[driver] ==== r41a 连接详情（连接时快照）===="
P1=$(launch r41a-r1 r41a)
if wait_mark "r41a-DONE" 360; then
  for m in "r41a-detail-ok" "r41a-copy-ok" "r41a-close-ok" "r41a-snapshot-hold"; do
    grep -q "$m" "$LOG" || { echo "[driver] R41A FAILED: 缺标记 $m"; exit 2; }
  done
  if grep -q "JS-ERROR\|JS-REJECT" "$LOG"; then
    echo "[driver] R41A FAILED: 页面报错"; grep -m3 "JS-ERROR\|JS-REJECT" "$LOG"; exit 2
  fi
  echo "[driver] r41a ALL PASS（完整身份/日期时区/会话 ID 复制；改主机库后仍是连接当时身份；独立关闭不影响会话）"
else
  echo "[driver] R41A FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
fi
stage_end r41a

echo "[driver] ==== r41b 活动记录（真审计库）===="
P1=$(launch r41b-r1 r41b)
if wait_mark "r41b-DONE" 360; then
  for m in "r41b-panel-ok" "r41b-identity-ok" "r41b-scope-ok" "r41b-filter-action-ok" "r41b-filter-actor-ok" "r41b-cursor-ok" "r41b-after-close-ok"; do
    grep -q "$m" "$LOG" || { echo "[driver] R41B FAILED: 缺标记 $m"; exit 2; }
  done
  if grep -q "JS-ERROR\|JS-REJECT" "$LOG"; then
    echo "[driver] R41B FAILED: 页面报错"; grep -m3 "JS-ERROR\|JS-REJECT" "$LOG"; exit 2
  fi
  echo "[driver] r41b ALL PASS（工作区视图/当前-全部/类型与人类-Agent 筛选/游标翻页连续/关闭后留痕带主机身份）"
else
  echo "[driver] R41B FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
fi
stage_end r41b

echo "[driver] ==== r41c 凭据设置（真 vault）===="
P1=$(launch r41c-r1 r41c)
if wait_mark "r41c-DONE" 360; then
  for m in "r41c-settings-ok" "r41c-explicit-submit" "r41c-created" "r41c-draft-guard" "r41c-draft-discard" "r41c-ref-block"; do
    grep -q "$m" "$LOG" || { echo "[driver] R41C FAILED: 缺标记 $m"; exit 2; }
  done
  if grep -q "JS-ERROR\|JS-REJECT" "$LOG"; then
    echo "[driver] R41C FAILED: 页面报错"; grep -m3 "JS-ERROR\|JS-REJECT" "$LOG"; exit 2
  fi
  echo "[driver] r41c ALL PASS（左分类单对话框/显式提交/未绑定态/草稿处置/引用检查删除被拒）"
else
  echo "[driver] R41C FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
fi
stage_end r41c

echo "[driver] ==== R41 原生冒烟全绿 ===="
