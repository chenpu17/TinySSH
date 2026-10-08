#!/bin/bash
# R32 原生冒烟驱动（C5 传输注册表）：三阶段。
#   r32a 主链：建连 → 上传 2MB（注册/进度/终态/真机写穿）→ 下载 → 失败注入
#        → 400MB 取消（Cancelling→Cancelled）→ 未知取消 → UI 卡片面 → DONE
#   r32b 在途：大文件上传 bytes≥4MB 打标 → 驱动杀进程（制造「重启时中断」）
#   r32c 恢复：重启（同库同口令）→ list_transfers 出 Failed「应用重启时传输中断」
#        → 文件面板卡片可见 → DONE
# 前置：tinyssh-e2e 容器在跑；屏幕已解锁（锁屏 WKWebView 冻结）。
# cleanup 恒杀 app + 清容器/宿主测试文件。beacon 日志每轮清空。
set -u
APP=/Users/chenpu/workspace/claude-code/TinySSH/target/release/tinyssh-app
DIR=/tmp/smoke-r32
DB=$DIR/tinyssh.db
LOG=$DIR/beacon-r32.txt

lsof -ti :15199 | xargs kill 2>/dev/null
# 预置宿主测试文件（上传源）：2MB 实文件 + 400MB 稀疏文件
mkdir -p "$DIR"
rm -f /tmp/r32up.bin /tmp/r32big.bin ~/Downloads/up.bin
dd if=/dev/zero of=/tmp/r32up.bin bs=1024 count=2048 2>/dev/null
truncate -s 400M /tmp/r32big.bin
# 预置容器测试目录（cleanup 每轮删除，故每轮重建）
docker exec tinyssh-e2e sh -c 'rm -rf /tmp/r32dir && mkdir -p /tmp/r32dir' || { echo "precreate failed"; exit 2; }
rm -f "$DB" "$DB"-shm "$DB"-wal "$LOG"
cd "$DIR"
nohup python3 beacon.py x "$LOG" > /dev/null 2>&1 &
sleep 1

launch() {  # launch <run_id> <mode>
  TINYSSH_SMOKE=1 TINYSSH_SMOKE_MODE=$2 TINYSSH_RUN_ID=$1 \
  TINYSSH_DB=$DB TINYSSH_MASTER_PASSPHRASE=r32-smoke-pass \
  nohup "$APP" > "$DIR/app-$1.log" 2>&1 &
  echo $!
}

cleanup() {
  kill "${P1:-0}" "${P2:-0}" "${P3:-0}" 2>/dev/null
  rm -f /tmp/r32up.bin /tmp/r32big.bin ~/Downloads/up.bin
  docker exec tinyssh-e2e rm -rf /tmp/r32dir 2>/dev/null
  echo "[driver] cleanup done"
}
trap cleanup EXIT

for proc in tinyssh-app tinyssh; do
  osascript -e "tell application \"System Events\" to tell process \"$proc\" to set frontmost to true" 2>/dev/null && break
done

wait_mark() {  # wait_mark <pat> <timeout_s>
  local pat=$1 timeout=$2 elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if grep -q "$pat" "$LOG" 2>/dev/null; then return 0; fi
    if grep -q "FAIL" "$LOG" 2>/dev/null; then echo "FAIL-seen" >&2; return 1; fi
    sleep 1; elapsed=$((elapsed+1))
  done
  echo "timeout-waiting-$pat（最后标记: $(tail -1 "$LOG" 2>/dev/null)）" >&2
  return 1
}

lock_state() {  # 输出 locked|unlocked（loginwindow 主窗口=登录窗口即锁屏）
  local w
  w=$(osascript -e 'tell application "System Events" to tell process "loginwindow" to get value of attribute "AXMainWindow"' 2>/dev/null)
  case "$w" in *登录*|*login*) echo locked;; *) echo unlocked;; esac
}

echo "[driver] screen state: $(lock_state)"
if [ "$(lock_state)" = "locked" ]; then
  echo "[driver] 屏幕已锁定——WKWebView 冻结页面 JS，原生 GUI e2e 必须等解锁后重跑（tinyssh-e2e-needs-unlocked-screen 纪律）"
  exit 3
fi

# ---- 阶段 1：r32a 主链 ----
P1=$(launch r32a r32a)
echo "[driver] phase1 pid=$P1 run=r32a"
if wait_mark "r32a-DONE" 300 >/dev/null; then
  echo "[driver] phase1 DONE"
else
  echo "[driver] PHASE1 FAILED — beacon tail:"; tail -8 "$LOG"; exit 2
fi
kill $P1 2>/dev/null; sleep 2
cp "$LOG" "$DIR/beacon-r32a.txt"
if [ -f ~/Downloads/up.bin ]; then echo "[driver] download landed: $(stat -f %z ~/Downloads/up.bin) bytes"; else echo "[driver] WARN download file missing (journal 为证)"; fi

# ---- 阶段 2：r32b 在途 → 杀进程 ----
: > "$LOG"
P2=$(launch r32b r32b)
echo "[driver] phase2 pid=$P2 run=r32b"
if wait_mark "r32b-TRANSFERRING" 180 >/dev/null; then
  echo "[driver] phase2 TRANSFERRING — killing mid-flight"
else
  echo "[driver] PHASE2 FAILED — beacon tail:"; tail -8 "$LOG"; exit 2
fi
kill -9 $P2 2>/dev/null
sleep 2
cp "$LOG" "$DIR/beacon-r32b.txt"

# ---- 阶段 3：r32c 重启恢复 ----
: > "$LOG"
P3=$(launch r32c r32c)
echo "[driver] phase3 pid=$P3 run=r32c"
if wait_mark "r32c-DONE" 180 >/dev/null; then
  echo "[driver] phase3 DONE"
else
  echo "[driver] PHASE3 FAILED — beacon tail:"; tail -8 "$LOG"; exit 2
fi
kill $P3 2>/dev/null
cp "$LOG" "$DIR/beacon-r32c.txt"

echo "---- phase1 marks ----"
grep "r32a|" "$DIR/beacon-r32a.txt" | tail -25
echo "---- phase2 marks ----"
grep "r32b|" "$DIR/beacon-r32b.txt" | tail -6
echo "---- phase3 marks ----"
grep "r32c|" "$DIR/beacon-r32c.txt" | tail -10
echo "---- js errors per phase ----"
for p in a b c; do echo -n "r32$p: "; grep -c "JS-ERROR\|JS-REJECT" "$DIR/beacon-r32$p.txt" 2>/dev/null || true; done
echo "[driver] all phases DONE"
