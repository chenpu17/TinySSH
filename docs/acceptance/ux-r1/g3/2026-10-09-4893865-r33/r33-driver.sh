#!/bin/bash
# R33 原生冒烟驱动（上传下载入口/原生选择器）：单阶段 r33a ×2 轮。
#   r33a：建连 → 面板「上传」→ NSOpenPanel（驱动 GoTo /tmp/r33dir + ⌘A + Return 多选确认）
#         → 3 文件真上传容器全 Succeeded → 动作菜单「另存为…」→ NSSavePanel
#         （驱动 GoTo /tmp/r33save + Return）→ 真落盘 + blob 目录记忆
#         → 普通下载 → 落上次下载目录真落盘。
# 原生拖拽通道无法诚实合成（Finder 拖入）——分区/确认卡判别归 demo 域（登记）。
# 前置：tinyssh-e2e 容器在跑；屏幕已解锁（锁屏 WKWebView 冻结）；Terminal 有 AX 权限。
# cleanup 恒杀 app + 清容器/宿主测试文件。beacon 日志每轮清空。
set -u
APP=/Users/chenpu/workspace/claude-code/TinySSH/target/release/tinyssh-app
DIR=/tmp/smoke-r33
DB=$DIR/tinyssh.db
LOG=$DIR/beacon-r33.txt

mkdir -p "$DIR"
# beacon.py 常驻仓库（scripts/native-smoke/beacon.py）；旧引用的 /tmp/smoke-r32/ 临时副本已消失，
# 且旧写法带 `|| true` 会静默跳过 → 信标不启动、日志恒空、wait_mark 超时。
cp /Users/chenpu/workspace/claude-code/TinySSH/scripts/native-smoke/beacon.py "$DIR/beacon.py" || { echo "beacon.py 拷贝失败"; exit 2; }
lsof -ti :15199 | xargs kill 2>/dev/null
# 远端容器树（上传目标）+ 宿主选择器源目录（NSOpenPanel GoTo 目标）
docker exec tinyssh-e2e sh -c 'rm -rf /tmp/r33dir && mkdir -p /tmp/r33dir && printf hello > /tmp/r33dir/app.txt && head -c 2048 /dev/zero > /tmp/r33dir/b.txt && head -c 65536 /dev/urandom > /tmp/r33dir/big.bin' || { echo "precreate container failed"; exit 2; }
rm -rf /tmp/r33dir-host && mkdir -p /tmp/r33dir-host && printf hello > /tmp/r33dir-host/app.txt && head -c 2048 /dev/zero > /tmp/r33dir-host/b.txt && head -c 65536 /dev/urandom > /tmp/r33dir-host/big.bin
# 另存为落盘判别面：先清
rm -rf /tmp/r33save && mkdir -p /tmp/r33save
rm -f "$DB" "$DB"-shm "$DB"-wal "$LOG"
cd "$DIR"
nohup python3 beacon.py x "$LOG" > /dev/null 2>&1 &
sleep 1

launch() {
  TINYSSH_SMOKE=1 TINYSSH_SMOKE_MODE=$2 TINYSSH_RUN_ID=$1 \
  TINYSSH_DB=$DB TINYSSH_MASTER_PASSPHRASE=r33-smoke-pass \
  nohup "$APP" > "$DIR/app-$1.log" 2>&1 &
  echo $!
}

cleanup() {
  kill "${P1:-0}" 2>/dev/null
  rm -rf /tmp/r33dir-host /tmp/r33save
  docker exec tinyssh-e2e rm -rf /tmp/r33dir 2>/dev/null
  echo "[driver] cleanup done"
}
trap cleanup EXIT

for proc in tinyssh-app tinyssh; do
  osascript -e "tell application \"System Events\" to tell process \"$proc\" to set frontmost to true" 2>/dev/null && break
done

wait_mark() {
  local pat=$1 timeout=$2 elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if grep -q "$pat" "$LOG" 2>/dev/null; then return 0; fi
    if grep -q "FAIL" "$LOG" 2>/dev/null; then echo "FAIL-seen" >&2; return 1; fi
    sleep 1; elapsed=$((elapsed+1))
  done
  echo "timeout-waiting-$pat（最后标记: $(tail -1 "$LOG" 2>/dev/null)）" >&2
  return 1
}

lock_state() {
  local w
  w=$(osascript -e 'tell application "System Events" to tell process "loginwindow" to get value of attribute "AXMainWindow"' 2>/dev/null)
  case "$w" in *登录*|*login*) echo locked;; *) echo unlocked;; esac
}

echo "[driver] screen state: $(lock_state)"
if [ "$(lock_state)" = "locked" ]; then
  echo "[driver] 屏幕已锁定——WKWebView 冻结页面 JS，原生 GUI e2e 必须等解锁后重跑（tinyssh-e2e-needs-unlocked-screen 纪律）"
  exit 3
fi

# NSPanel 键序守望者：脚本打点后 0.8s（等面板弹出）再发键。
#   pick：GoTo /tmp/r33dir-host → ⌘A 全选 → Return 确认打开
#   save：GoTo /tmp/r33save → Return 确认保存（默认文件名 app.txt）
watch_send() {
  local pat=$1
  for i in $(seq 1 400); do grep -q "$pat" "$LOG" 2>/dev/null && break; sleep 0.3; done
  sleep 0.8
  osascript <<OSA
tell application "System Events"
  keystroke "g" using {command down, shift down}
  delay 0.7
  keystroke "$2"
  delay 0.3
  key code 36
  delay 0.9
$( [ "$3" = "selectall" ] && echo '  keystroke "a" using {command down}
  delay 0.4'; )
  key code 36
end tell
OSA
}

for round in 1 2; do
  echo "[driver] ==== round $round ===="
  P1=$(launch "r33a-r$round" r33a)
  echo "[driver] pid=$P1"
  sleep 3
  for proc in tinyssh-app tinyssh; do
    osascript -e "tell application \"System Events\" to tell process \"$proc\" to set frontmost to true" 2>/dev/null && break
  done
  watch_send "r33a-pick-open" "/tmp/r33dir-host" "selectall" &
  W1=$!
  watch_send "r33a-save-open" "/tmp/r33save" "" &
  W2=$!
  if wait_mark "r33a-DONE" 300; then
    wait $W1 $W2 2>/dev/null
    echo "[driver] round$round DONE"
    # 落盘对账：另存为 + 普通下载两文件都在 /tmp/r33save，内容对（hello/2048B）
    if [ -f /tmp/r33save/app.txt ] && [ "$(cat /tmp/r33save/app.txt)" = "hello" ] \
       && [ "$(stat -f %z /tmp/r33save/b.txt 2>/dev/null)" = "2048" ]; then
      echo "[driver] disk-verified (/tmp/r33save/app.txt=hello, b.txt=2048B)"
    else
      echo "[driver] DISK-VERIFY FAILED"; ls -la /tmp/r33save/ 2>/dev/null; kill $P1; exit 2
    fi
    # 远端对账：上传 3 文件进容器（app.txt=hello、b.txt=2048、big.bin=65536）
    if [ "$(docker exec tinyssh-e2e stat -f %z /tmp/r33dir/big.bin 2>/dev/null || docker exec tinyssh-e2e stat -c %s /tmp/r33dir/big.bin 2>/dev/null)" = "65536" ] \
       && [ "$(docker exec tinyssh-e2e cat /tmp/r33dir/app.txt 2>/dev/null)" = "hello" ]; then
      echo "[driver] remote-upload-verified (3 files in container)"
    else
      echo "[driver] REMOTE-VERIFY FAILED"; docker exec tinyssh-e2e ls -la /tmp/r33dir/ 2>/dev/null; kill $P1; exit 2
    fi
  else
    echo "[driver] ROUND$round FAILED — beacon tail:"; tail -12 "$LOG"; kill $W1 $W2 2>/dev/null; kill $P1; exit 2
  fi
  kill $W1 $W2 2>/dev/null
  kill $P1 2>/dev/null; sleep 2
  cp "$LOG" "$DIR/beacon-r33a-r$round.txt"
  # 标记回显：beacon 以 URL 编码落盘（`|`→%7C、中文→%XX），须解码后再看。
  python3 -c "
import urllib.parse,sys
for line in open(sys.argv[1]):
    s = urllib.parse.unquote(line.strip())
    if s.startswith('/t/'): print(s[3:])
" "$DIR/beacon-r33a-r$round.txt"
  : > "$LOG"
  # 第二轮清落盘面（保证对账来自本轮）
  rm -rf /tmp/r33save && mkdir -p /tmp/r33save
done

echo "[driver] ALL ROUNDS DONE"
