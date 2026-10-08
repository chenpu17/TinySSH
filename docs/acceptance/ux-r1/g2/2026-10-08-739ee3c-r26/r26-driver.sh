#!/bin/bash
# R26 原生冒烟驱动：beacon + app 启动 + docker stop/start 协同。
# 链：drop-wait1 停容器（自动重连 3 次耗尽）→ start-wait 启容器（手动重连成功
# →Reconfirming）→ r26-b 命令框（脚本内完成）→ drop-wait2 停容器（停止重试提前落
# Disconnected）→ 断开标签直关（脚本内完成）。RUN_ID=r26a。
set -u
RUN=${1:-r26a}
LOG=/tmp/smoke-r26/beacon-$RUN.txt
APP=/Users/chenpu/workspace/claude-code/TinySSH/target/release/tinyssh-app
CTR=tinyssh-e2e

lsof -ti :15199 | xargs kill 2>/dev/null
rm -f /tmp/smoke-r26/tinyssh.db* "$LOG"
cd /tmp/smoke-r26
nohup python3 beacon.py x "$LOG" > /dev/null 2>&1 &
sleep 1

TINYSSH_SMOKE=1 TINYSSH_SMOKE_MODE=r26 TINYSSH_RUN_ID=$RUN \
TINYSSH_DB=/tmp/smoke-r26/tinyssh.db TINYSSH_MASTER_PASSPHRASE=r26-smoke-pass \
nohup "$APP" > /tmp/smoke-r26/app-$RUN.log 2>&1 &
APP_PID=$!
echo "app pid=$APP_PID"

sleep 2
for proc in tinyssh-app tinyssh; do
  osascript -e "tell application \"System Events\" to tell process \"$proc\" to set frontmost to true" 2>/dev/null && break
done

wait_mark() {
  local pat=$1 timeout=$2 elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if grep -q "$pat" "$LOG" 2>/dev/null; then return 0; fi
    if grep -q "FAIL" "$LOG" 2>/dev/null; then echo "FAIL-seen"; return 1; fi
    sleep 1; elapsed=$((elapsed+1))
  done
  echo "timeout-waiting-$pat"; return 1
}

cleanup() {
  docker start "$CTR" >/dev/null 2>&1
  kill "$APP_PID" 2>/dev/null
}
trap cleanup EXIT

if wait_mark "r26a-drop-wait1" 240 >/dev/null; then
  docker stop --time 2 "$CTR" >/dev/null && echo "[driver] container stopped #1"
else
  echo "[driver] never reached drop-wait1"; tail -5 "$LOG"; cleanup; exit 2
fi
if ! wait_mark "r26a-exhaust-ok" 120 >/dev/null; then
  echo "[driver] exhaust leg failed"; tail -5 "$LOG"; cleanup; exit 2
fi

if wait_mark "r26a-start-wait" 120 >/dev/null; then
  docker start "$CTR" >/dev/null && echo "[driver] container started"
else
  echo "[driver] never reached start-wait"; tail -5 "$LOG"; cleanup; exit 2
fi

if wait_mark "r26a-drop-wait2" 240 >/dev/null; then
  docker stop --time 2 "$CTR" >/dev/null && echo "[driver] container stopped #2"
else
  echo "[driver] never reached drop-wait2"; tail -5 "$LOG"; cleanup; exit 2
fi

if wait_mark "r26a-DONE" 120 >/dev/null; then
  echo "$RUN-DRIVER|DONE" >> "$LOG"
  echo "[driver] all legs done"
  cleanup
  trap - EXIT
  exit 0
else
  echo "[driver] DONE never seen"; tail -8 "$LOG"; cleanup; exit 2
fi
