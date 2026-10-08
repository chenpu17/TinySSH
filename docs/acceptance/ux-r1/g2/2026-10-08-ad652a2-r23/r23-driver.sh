#!/bin/bash
# R23 原生冒烟驱动：beacon + app 启动 + 退出段协同（osascript 真实窗口关闭 ×2）
# + 进程零残留核验。RUN_ID=r23a。
set -u
RUN=${1:-r23a}
LOG=/tmp/smoke-r23/beacon-$RUN.txt
APP=/Users/chenpu/workspace/claude-code/TinySSH/target/release/tinyssh-app

lsof -ti :15199 | xargs kill 2>/dev/null
rm -f /tmp/smoke-r23/tinyssh.db* "$LOG"
cd /tmp/smoke-r23
nohup python3 beacon.py x "$LOG" > /dev/null 2>&1 &
sleep 1

TINYSSH_SMOKE=1 TINYSSH_SMOKE_MODE=r23 TINYSSH_RUN_ID=$RUN \
TINYSSH_DB=/tmp/smoke-r23/tinyssh.db TINYSSH_MASTER_PASSPHRASE=r23-smoke-pass \
nohup "$APP" > /tmp/smoke-r23/app-$RUN.log 2>&1 &
APP_PID=$!
echo "app pid=$APP_PID"

# 激活窗口（等价用户点进 app）：hasFocus 契约下 A2 前台 attach 需窗口在前台
sleep 2
for proc in tinyssh-app tinyssh; do
  osascript -e "tell application \"System Events\" to tell process \"$proc\" to set frontmost to true" 2>/dev/null && break
done

close_window() {
  for proc in tinyssh-app tinyssh; do
    osascript -e "tell application \"System Events\" to tell process \"$proc\" to click (first button whose subrole is \"AXCloseButton\") of window 1" 2>/dev/null && return 0
  done
  return 1
}

wait_mark() {
  local pat=$1 timeout=$2 elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if grep -q "$pat" "$LOG" 2>/dev/null; then return 0; fi
    if grep -q "FAIL" "$LOG" 2>/dev/null; then echo "FAIL-seen"; return 1; fi
    sleep 1; elapsed=$((elapsed+1))
  done
  echo "timeout-waiting-$pat"; return 1
}

# C 段：等 blur-wait 标记 → 激活 Finder 夺走焦点（真实失焦）
if wait_mark "r23a-blur-wait" 180 >/dev/null; then
  sleep 1
  osascript -e 'tell application "Finder" to activate' 2>/dev/null || echo "[driver] finder-activate-FAILED"
else
  echo "[driver] never reached blur-wait"; tail -5 "$LOG"; kill "$APP_PID" 2>/dev/null; exit 2
fi

# 等 quit-wait 标记 → 真实关闭窗口（osascript）
if wait_mark "r23a-quit-wait" 180 >/dev/null; then
  sleep 1
  if close_window; then echo "[driver] closed window #1"; else echo "[driver] osascript-close-FAILED"; kill "$APP_PID" 2>/dev/null; exit 2; fi
else
  echo "[driver] never reached quit-wait"; tail -5 "$LOG"; kill "$APP_PID" 2>/dev/null; exit 2
fi

# 取消腿：等 quit-cancel-ok → 再关一次
if wait_mark "r23a-quit-cancel-ok" 60 >/dev/null; then
  if wait_mark "r23a-quit-wait2" 60 >/dev/null; then
    sleep 1
    if close_window; then echo "[driver] closed window #2"; else echo "[driver] osascript-close2-FAILED"; kill "$APP_PID" 2>/dev/null; exit 2; fi
  else
    echo "[driver] never reached quit-wait2"; kill "$APP_PID" 2>/dev/null; exit 2
  fi
else
  echo "[driver] quit-cancel leg failed"; tail -5 "$LOG"; kill "$APP_PID" 2>/dev/null; exit 2
fi

# 等 DONE（quit confirm 点击后 mark 先于进程退出写盘）
if wait_mark "r23a-DONE" 60 >/dev/null; then
  # 等进程退出（quit_app 生效），至多 15s
  for i in $(seq 1 15); do
    pgrep -f "target/release/tinyssh-app" > /dev/null || break
    sleep 1
  done
  if pgrep -f "target/release/tinyssh-app" > /dev/null; then
    echo "[driver] APP-STILL-RUNNING after quit"; echo "$RUN-DRIVER|FAIL-still-running" >> "$LOG"
    pkill -f "target/release/tinyssh-app"; exit 3
  fi
  echo "$RUN-DRIVER|app-exited-clean" >> "$LOG"
  echo "[driver] app exited clean"
  exit 0
else
  echo "[driver] DONE never seen"; tail -5 "$LOG"; kill "$APP_PID" 2>/dev/null; exit 2
fi
