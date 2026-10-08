#!/bin/bash
# R30 原生冒烟驱动：beacon + 单阶段（真机 sshd）。
# app 启动（新库）→ 脚本：建连 r30-a → invoke 契约面（resolve/stat/list C4）
# → UI 面（canonical 导航/行渲染 kind/symlink 点击进入/不存在错误）→ DONE。
# 前置：tinyssh-e2e 容器在跑且 /tmp/r30dir 已由驱动 docker exec 预置。
# cleanup 恒杀 app + 清容器内测试树。屏幕须已解锁（锁屏 WKWebView 冻结）。
set -u
APP=/Users/chenpu/workspace/claude-code/TinySSH/target/release/tinyssh-app
DIR=/tmp/smoke-r30
DB=$DIR/tinyssh.db
LOG=$DIR/beacon-r30a.txt

lsof -ti :15199 | xargs kill 2>/dev/null
# 预置真机测试树（cleanup 每轮删除，故每轮重建）
docker exec tinyssh-e2e sh -c 'rm -rf /tmp/r30dir && mkdir -p /tmp/r30dir/sub && echo world > /tmp/r30dir/a.txt && echo hello > /tmp/r30dir/b.txt && ln -s a.txt /tmp/r30dir/alink && ln -s sub /tmp/r30dir/slink && ln -s missing /tmp/r30dir/dangling' || { echo "precreate failed"; exit 2; }
rm -f "$DB" "$DB"-shm "$DB"-wal "$LOG"
cd "$DIR"
nohup python3 beacon.py x "$LOG" > /dev/null 2>&1 &
sleep 1

TINYSSH_SMOKE=1 TINYSSH_SMOKE_MODE=r30 TINYSSH_RUN_ID=r30a \
TINYSSH_DB=$DB TINYSSH_MASTER_PASSPHRASE=r30-smoke-pass \
nohup "$APP" > "$DIR/app-r30a.log" 2>&1 &
APP_PID=$!
echo "[driver] app pid=$APP_PID run=r30a"
sleep 2
for proc in tinyssh-app tinyssh; do
  osascript -e "tell application \"System Events\" to tell process \"$proc\" to set frontmost to true" 2>/dev/null && break
done

cleanup() {
  kill "${APP_PID:-0}" 2>/dev/null
  docker exec tinyssh-e2e rm -rf /tmp/r30dir 2>/dev/null
  echo "[driver] cleanup done"
}
trap cleanup EXIT

wait_mark() {
  local pat=$1 timeout=$2 elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if grep -q "$pat" "$LOG" 2>/dev/null; then return 0; fi
    if grep -q "FAIL" "$LOG" 2>/dev/null; then echo "FAIL-seen"; return 1; fi
    sleep 1; elapsed=$((elapsed+1))
  done
  echo "timeout-waiting-$pat"; return 1
}

if wait_mark "r30a-DONE" 300 >/dev/null; then
  echo "[driver] DONE reached"
else
  echo "[driver] FAILED — beacon tail:"; tail -8 "$LOG"; exit 2
fi
echo "---- beacon marks ----"
grep -v "^\[" "$LOG" | tail -20
echo "---- js errors ----"
grep -c "JS-ERROR\|JS-REJECT" "$LOG" || true
