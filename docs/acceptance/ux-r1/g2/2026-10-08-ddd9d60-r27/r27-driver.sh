#!/bin/bash
# R27 原生冒烟驱动：beacon + 两阶段。
# 阶段1：app 启动（新库）→ 脚本标记 chrome0 → 驱动 osascript 切系统深浅（取反）→
#        脚本验实时跟随 → 三态/解耦/⌘= → 标记 relaunch-wait；
# 阶段2：驱动杀进程 → DB 回卷 user_version=4 + 删 workspace blob + 写旧键
#        ui.theme=solar-light → 重启（RUN_ID=r27a-p2）→ 脚本验迁移映射消费 → DONE。
# cleanup 恒恢复测试前系统外观 + 杀 app。无 docker 依赖（纯 UI/偏好面）。
set -u
APP=/Users/chenpu/workspace/claude-code/TinySSH/target/release/tinyssh-app
DIR=/tmp/smoke-r27
DB=$DIR/tinyssh.db
LOG=$DIR/beacon-r27a.txt

lsof -ti :15199 | xargs kill 2>/dev/null
rm -f "$DB" "$DB"-shm "$DB"-wal "$LOG"
cd "$DIR"
nohup python3 beacon.py x "$LOG" > /dev/null 2>&1 &
sleep 1

# 记录测试前系统外观（cleanup 恢复）
DM0=$(osascript -e 'tell application "System Events" to tell appearance preferences to get dark mode' 2>/dev/null)
echo "[driver] initial dark mode=$DM0"

launch_app() {
  local rid=$1
  TINYSSH_SMOKE=1 TINYSSH_SMOKE_MODE=r27 TINYSSH_RUN_ID=$rid \
  TINYSSH_DB=$DB TINYSSH_MASTER_PASSPHRASE=r27-smoke-pass \
  nohup "$APP" > "$DIR/app-$rid.log" 2>&1 &
  APP_PID=$!
  echo "[driver] app pid=$APP_PID run=$rid"
  sleep 2
  for proc in tinyssh-app tinyssh; do
    osascript -e "tell application \"System Events\" to tell process \"$proc\" to set frontmost to true" 2>/dev/null && break
  done
}

restore_and_exit() {
  osascript -e "tell application \"System Events\" to tell appearance preferences to set dark mode to $DM0" 2>/dev/null
  kill "${APP_PID:-0}" 2>/dev/null
  echo "[driver] restored dark mode=$DM0"
}
trap restore_and_exit EXIT

launch_app r27a

wait_mark() {
  local pat=$1 timeout=$2 elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if grep -q "$pat" "$LOG" 2>/dev/null; then return 0; fi
    if grep -q "FAIL" "$LOG" 2>/dev/null; then echo "FAIL-seen"; return 1; fi
    sleep 1; elapsed=$((elapsed+1))
  done
  echo "timeout-waiting-$pat"; return 1
}

# ---- 阶段1：系统深浅切换 ----
if ! wait_mark "r27a-sys-wait" 240 >/dev/null; then
  echo "[driver] never reached sys-wait"; tail -5 "$LOG"; exit 2
fi
CHROME0=$(grep -o 'r27a-chrome0=[a-z]*' "$LOG" | head -1 | cut -d= -f2)
if [ "$CHROME0" = "dark" ]; then TOGGLE=false; else TOGGLE=true; fi
osascript -e "tell application \"System Events\" to tell appearance preferences to set dark mode to $TOGGLE" >/dev/null
echo "[driver] system dark mode toggled to $TOGGLE (chrome0=$CHROME0)"
if ! wait_mark "r27a-sysfollow-ok" 120 >/dev/null; then
  echo "[driver] sys-follow leg failed"; tail -5 "$LOG"; exit 2
fi
if ! wait_mark "r27a-font-ok" 120 >/dev/null; then
  echo "[driver] settings legs failed"; tail -5 "$LOG"; exit 2
fi

# ---- 阶段2：杀进程 → DB 回卷 + 旧键 → 重启 ----
if ! wait_mark "r27a-relaunch-wait" 120 >/dev/null; then
  echo "[driver] never reached relaunch-wait"; tail -5 "$LOG"; exit 2
fi
kill "$APP_PID" 2>/dev/null
wait "$APP_PID" 2>/dev/null
sleep 2
# 完整回卷 V4 状态：DROP COLUMN（V6 的 ALTER 无幂等守卫，须手动摘列）+
# user_version=4 + 删 blob + 写旧键 → 重启后 V5（CREATE IF NOT EXISTS 幂等）
# 重跑：映射 ui.theme=solar-light → chrome=light，V6 重加列
sqlite3 "$DB" "ALTER TABLE hosts DROP COLUMN shell_integration; PRAGMA user_version=4; DELETE FROM settings WHERE key='ui.v2.workspace'; INSERT OR REPLACE INTO settings(key,value) VALUES('ui.theme','solar-light');" \
  && echo "[driver] DB rewound to V4 (column dropped) + legacy ui.theme=solar-light"
launch_app r27a-p2

if wait_mark "r27a-DONE" 240 >/dev/null; then
  echo "r27a-DRIVER|DONE" >> "$LOG"
  echo "[driver] all legs done"
  restore_and_exit
  trap - EXIT
  exit 0
else
  echo "[driver] DONE never seen"; tail -8 "$LOG"; exit 2
fi
