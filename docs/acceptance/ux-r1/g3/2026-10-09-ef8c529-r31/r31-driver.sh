#!/bin/bash
# R31 原生冒烟驱动（文件面板/完整视图/导航与选择）：单阶段 r31a ×2 轮。
#   r31a：双会话建连 → 面包屑/编辑路径框 → 返回/前进/上一级 → 隐藏项/筛选/排序
#        → 键盘 Enter 进目录 → 多选下载（真传输落盘）→ 目录明确信息 → 双击动作菜单
#        → 定位到终端目录（无 cwd 则登记 skip）→ 跨标签路径+选择恢复 → 分屏×面板完整视图
# 前置：tinyssh-e2e 容器在跑；屏幕已解锁（锁屏 WKWebView 冻结）。
# cleanup 恒杀 app + 清容器/宿主测试文件。beacon 日志每轮清空。
set -u
APP=/Users/chenpu/workspace/claude-code/TinySSH/target/release/tinyssh-app
DIR=/tmp/smoke-r31
DB=$DIR/tinyssh.db
LOG=$DIR/beacon-r31.txt

mkdir -p "$DIR"
# beacon.py 常驻仓库（scripts/native-smoke/beacon.py）；此前引用的 /tmp/smoke-r32/ 临时副本已随
# 系统清理消失，且旧写法带 `|| true` 会静默跳过 → 信标不启动、日志恒空、wait_mark 超时。
cp /Users/chenpu/workspace/claude-code/TinySSH/scripts/native-smoke/beacon.py "$DIR/beacon.py" || { echo "beacon.py 拷贝失败"; exit 2; }
lsof -ti :15199 | xargs kill 2>/dev/null
# 预置容器测试树：排序/隐藏/筛选/键盘/多选下载判别面
docker exec tinyssh-e2e sh -c 'rm -rf /tmp/r31dir && mkdir -p /tmp/r31dir/sub && printf hello > /tmp/r31dir/a.txt && head -c 2048 /dev/zero > /tmp/r31dir/b.txt && head -c 102400 /dev/urandom > /tmp/r31dir/big.txt && printf h > /tmp/r31dir/.hidden && printf inner > /tmp/r31dir/sub/inner.txt' || { echo "precreate failed"; exit 2; }
# 下载落盘判别面：先清
rm -f ~/Downloads/a.txt ~/Downloads/b.txt ~/Downloads/big.txt
rm -f "$DB" "$DB"-shm "$DB"-wal "$LOG"
cd "$DIR"
nohup python3 beacon.py x "$LOG" > /dev/null 2>&1 &
sleep 1

launch() {
  TINYSSH_SMOKE=1 TINYSSH_SMOKE_MODE=$2 TINYSSH_RUN_ID=$1 \
  TINYSSH_DB=$DB TINYSSH_MASTER_PASSPHRASE=r31-smoke-pass \
  nohup "$APP" > "$DIR/app-$1.log" 2>&1 &
  echo $!
}

cleanup() {
  kill "${P1:-0}" "${P2:-0}" 2>/dev/null
  rm -f ~/Downloads/a.txt ~/Downloads/b.txt ~/Downloads/big.txt
  docker exec tinyssh-e2e rm -rf /tmp/r31dir 2>/dev/null
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

for round in 1 2; do
  echo "[driver] ==== round $round ===="
  # 每轮清下载落盘面（R34 起已有冲突裁决：残留目标会让本轮首次「下载所选」落成决策卡
  # 而非直接落盘，脚本原按覆盖语义写就——R35 补档实测第 2 轮因此红，故按轮清）。
  rm -f ~/Downloads/a.txt ~/Downloads/b.txt ~/Downloads/big.txt
  P1=$(launch "r31a-r$round" r31a)
  echo "[driver] pid=$P1"
  if wait_mark "r31a-DONE" 300; then
    echo "[driver] round$round DONE"
    grep -q "r31a-locate-skip" "$LOG" && echo "[driver] locate=skip（无集成主机无可信 cwd，登记）" || echo "[driver] locate clicked"
    # 下载落盘对账：a.txt=hello、b.txt=2048B
    if [ -f ~/Downloads/a.txt ] && [ "$(cat ~/Downloads/a.txt)" = "hello" ] && [ "$(stat -f %z ~/Downloads/b.txt)" = "2048" ]; then
      echo "[driver] downloads-verified (a.txt=hello, b.txt=2048B)"
    else
      echo "[driver] DOWNLOAD-VERIFY FAILED"; ls -la ~/Downloads/a.txt ~/Downloads/b.txt 2>/dev/null; exit 2
    fi
  else
    echo "[driver] ROUND$round FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
  fi
  kill $P1 2>/dev/null; sleep 2
  cp "$LOG" "$DIR/beacon-r31a-r$round.txt"
  # 标记回显：beacon 以 URL 编码落盘（`|`→%7C、中文→%XX），须解码后再看。
  python3 -c "
import urllib.parse,sys
for line in open(sys.argv[1]):
    s = urllib.parse.unquote(line.strip())
    if s.startswith('/t/'): print(s[3:])
" "$DIR/beacon-r31a-r$round.txt"
  : > "$LOG"
done

echo "[driver] ALL ROUNDS DONE"
