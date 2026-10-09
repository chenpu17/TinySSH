#!/bin/bash
# R34 原生冒烟驱动（C6 冲突/并发/提交仲裁与恢复；C13 故障注入 + 真机 sshd）：
#   r34a 主链：新文件原子发布 → 冲突预检（真实 stat 1024）→ skip/keepboth/overwrite
#         /待决取消四裁决 → 容器对账（原文件内容不变/新名文件存在）。
#   r34b 丢响应（TINYSSH_FAULT_DROP_LINK_RESPONSE=1）：OutcomeUnknown + UI 重新核实
#         保持未知；容器对账 unk.txt 已存在（服务端已提交）+ temp .tinyssh-part 保留。
#   r34c1/c2 提交窗 kill -9（post_verified 暂停）：重启恢复 Succeeded{verified}（error 空）。
#   r34d1/d2 提交窗 kill -9（pre_publish 暂停）：重启恢复 OutcomeUnknown；
#         容器对账目标不存在 + temp 保留；复核保持未知。
#   r34e 暂停窗内取消（pre_publish + PAUSE_MS=15000）：Cancelled + 目标不存在 + temp 清。
# 前置：tinyssh-e2e 容器在跑；屏幕已解锁（loginwindow 闸）；beacon 日志每阶段归档清空。
# 同一 DB 贯穿 c1→c2、d1→d2（重启恢复同库同口令）；口令走 env（钥匙串规避）。
set -u
APP=/Users/chenpu/workspace/claude-code/TinySSH/target/release/tinyssh-app
DIR=/tmp/smoke-r34
DB=$DIR/tinyssh.db
LOG=$DIR/beacon-r34.txt
REMOTE_DIR=/tmp/r34dir
HOST_DIR=/tmp/r34dir-host

mkdir -p "$DIR"
cp /tmp/smoke-r32/beacon.py "$DIR/beacon.py" 2>/dev/null || cp /Users/chenpu/workspace/claude-code/TinySSH/scripts/native-smoke/beacon.py "$DIR/beacon.py"
lsof -ti :15199 | xargs kill 2>/dev/null || true
# 远端容器树：exist.txt 预置 1024B（冲突目标）；清历史产物
docker exec tinyssh-e2e sh -c "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR && head -c 1024 /dev/urandom > $REMOTE_DIR/exist.txt && chmod 644 $REMOTE_DIR/exist.txt" || { echo "precreate container failed"; exit 2; }
EXIST_MD5=$(docker exec tinyssh-e2e md5sum $REMOTE_DIR/exist.txt 2>/dev/null | awk '{print $1}')
# 宿主上传源（256KB payload，全部上传同一源文件）+ 下载冲突目标（512B，skip 后须原样）
rm -rf "$HOST_DIR" && mkdir -p "$HOST_DIR" && head -c 262144 /dev/urandom > "$HOST_DIR/payload.bin"
head -c 512 /dev/urandom > "$HOST_DIR/exist-local.bin"
EXIST_LOCAL_MD5=$(md5 -q "$HOST_DIR/exist-local.bin")
rm -f "$DB" "$DB"-shm "$DB"-wal "$LOG"
cd "$DIR"
nohup python3 beacon.py x "$LOG" > /dev/null 2>&1 &
sleep 1

cleanup() {
  kill "${P1:-0}" 2>/dev/null
  rm -rf "$HOST_DIR"
  docker exec tinyssh-e2e rm -rf "$REMOTE_DIR" 2>/dev/null
  echo "[driver] cleanup done"
}
trap cleanup EXIT

for proc in tinyssh-app tinyssh; do
  osascript -e "tell application \"System Events\" to tell process \"$proc\" to set frontmost to true" 2>/dev/null && break
done

wait_mark() {
  local pat=$1 timeout=${2:-240} elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if grep -q "$pat" "$LOG" 2>/dev/null; then return 0; fi
    if grep -q "FAIL" "$LOG" 2>/dev/null; then echo "FAIL-seen" >&2; return 1; fi
    sleep 1; elapsed=$((elapsed+1))
  done
  # bash 3.2 多字节解析 bug：中文括号紧跟 $var 会把后续并进变量名——回显全 ASCII
  echo "timeout-waiting-$pat last=[ $(tail -1 "$LOG" 2>/dev/null) ]" >&2
  return 1
}

lock_state() {
  local w
  w=$(osascript -e 'tell application "System Events" to tell process "loginwindow" to get value of attribute "AXMainWindow"' 2>/dev/null)
  case "$w" in *登录*|*login*) echo locked;; *) echo unlocked;; esac
}
if [ "$(lock_state)" = "locked" ]; then
  echo "[driver] 屏幕已锁定——WKWebView 冻结页面 JS，原生 GUI e2e 必须等解锁后重跑（tinyssh-e2e-needs-unlocked-screen 纪律）"
  exit 3
fi

launch() { # $1=run-id $2=mode [extra fault env via FAULTENV]
  # shellcheck disable=SC2086
  # env 前缀：FAULTENV 展开值在 bash 3.2 不被识别为赋值前缀（command not found）
  env TINYSSH_SMOKE=1 TINYSSH_SMOKE_MODE=$2 TINYSSH_RUN_ID=$1 \
      TINYSSH_DB=$DB TINYSSH_MASTER_PASSPHRASE=r34-smoke-pass ${FAULTENV:-} \
      nohup "$APP" > "$DIR/app-$1.log" 2>&1 &
  local pid=$!
  sleep 3
  for proc in tinyssh-app tinyssh; do
    osascript -e "tell application \"System Events\" to tell process \"$proc\" to set frontmost to true" 2>/dev/null && break
  done
  echo $pid
}
stage_end() { # 归档 beacon + 清空（每轮须清空纪律）
  kill $P1 2>/dev/null; sleep 2
  kill -9 $P1 2>/dev/null
  cp "$LOG" "$DIR/beacon-$1.txt" 2>/dev/null
  : > "$LOG"
}

echo "[driver] ==== r34a 主链（无注入）===="
P1=$(launch r34a-r1 r34a)
if wait_mark "r34a-DONE" 300; then
  V1=$(docker exec tinyssh-e2e md5sum $REMOTE_DIR/exist.txt 2>/dev/null | awk '{print $1}')
  V2=$(docker exec tinyssh-e2e stat -c %s $REMOTE_DIR/exist.tinyssh-1.txt 2>/dev/null)
  V3=$(docker exec tinyssh-e2e stat -c %s $REMOTE_DIR/new.txt 2>/dev/null)
  V4=$(stat -f %z "$HOST_DIR/dl-new.bin" 2>/dev/null)
  V5=$(md5 -q "$HOST_DIR/exist-local.bin" 2>/dev/null)
  if [ "$V1" = "$EXIST_MD5" ] && [ "$V2" = "262144" ] && [ "$V3" = "262144" ] && [ "$V4" = "262144" ] && [ "$V5" = "$EXIST_LOCAL_MD5" ]; then
    echo "[driver] r34a remote-verified（exist.txt 原样 / keepboth 262144 / new.txt 262144 / 下载落盘 262144 / 本地冲突原样 ${EXIST_LOCAL_MD5}）"
  else
    echo "[driver] R34A REMOTE-VERIFY FAILED: exist=$V1/$EXIST_MD5 keepboth=$V2 new=$V3 dl=$V4 local=$V5/$EXIST_LOCAL_MD5"; docker exec tinyssh-e2e ls -la $REMOTE_DIR; exit 2
  fi
else
  echo "[driver] R34A FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
fi
stage_end r34a

echo "[driver] ==== r34b 丢响应 → OutcomeUnknown ===="
export FAULTENV="TINYSSH_FAULT_DROP_LINK_RESPONSE=1"; P1=$(launch r34b-r1 r34b)
if wait_mark "r34b-DONE" 300; then
  V1=$(docker exec tinyssh-e2e stat -c %s $REMOTE_DIR/unk.txt 2>/dev/null)
  V2=$(docker exec tinyssh-e2e sh -c "ls $REMOTE_DIR/.tinyssh-part-*-unk.txt 2>/dev/null | wc -l")
  if [ "$V1" = "262144" ] && [ "$V2" -ge 1 ]; then
    echo "[driver] r34b remote-verified（unk.txt 已提交 262144 + temp 保留 x${V2}——真实模糊性实证）"
  else
    echo "[driver] R34B REMOTE-VERIFY FAILED: unk=$V1 temp=$V2"; docker exec tinyssh-e2e ls -la $REMOTE_DIR; exit 2
  fi
else
  echo "[driver] R34B FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
fi
stage_end r34b

echo "[driver] ==== r34c 提交窗 kill -9（post_verified）→ 重启 Succeeded{verified} ===="
export FAULTENV="TINYSSH_FAULT_COMMIT_PAUSE=post_verified"; P1=$(launch r34c1-r1 r34c1)
if wait_mark "r34c1-paused" 300; then
  sleep 2; kill -9 $P1 2>/dev/null; sleep 2
  echo "[driver] killed r34c1（verified 已落账后）"
else
  echo "[driver] R34C1 FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
fi
P1=$(launch r34c2-r1 r34c2)
if wait_mark "r34c-DONE" 300; then
  V1=$(docker exec tinyssh-e2e stat -c %s $REMOTE_DIR/ok.txt 2>/dev/null)
  [ "$V1" = "262144" ] && echo "[driver] r34c remote-verified（ok.txt 262144）" || { echo "[driver] R34C VERIFY FAILED ok=$V1"; exit 2; }
else
  echo "[driver] R34C2 FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
fi
stage_end r34c2

echo "[driver] ==== r34d 提交窗 kill -9（pre_publish）→ 重启 OutcomeUnknown ===="
export FAULTENV="TINYSSH_FAULT_COMMIT_PAUSE=pre_publish"; P1=$(launch r34d1-r1 r34d1)
if wait_mark "r34d1-paused" 300; then
  sleep 2; kill -9 $P1 2>/dev/null; sleep 2
  echo "[driver] killed r34d1（发布前）"
else
  echo "[driver] R34D1 FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
fi
P1=$(launch r34d2-r1 r34d2)
if wait_mark "r34d-DONE" 300; then
  V1=$(docker exec tinyssh-e2e stat -c %s $REMOTE_DIR/ux.txt 2>/dev/null)
  V2=$(docker exec tinyssh-e2e sh -c "ls $REMOTE_DIR/.tinyssh-part-*-ux.txt 2>/dev/null | wc -l")
  if [ -z "$V1" ] && [ "$V2" -ge 1 ]; then
    echo "[driver] r34d remote-verified（ux.txt 不存在 + temp 保留 x${V2}）"
  else
    echo "[driver] R34D REMOTE-VERIFY FAILED: ux=$V1 temp=$V2"; docker exec tinyssh-e2e ls -la $REMOTE_DIR; exit 2
  fi
else
  echo "[driver] R34D2 FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
fi
stage_end r34d2

echo "[driver] ==== r34e 暂停窗内取消（线性化在 publish 前）===="
export FAULTENV="TINYSSH_FAULT_COMMIT_PAUSE=pre_publish TINYSSH_FAULT_PAUSE_MS=15000"; P1=$(launch r34e-r1 r34e)
if wait_mark "r34e-DONE" 300; then
  V1=$(docker exec tinyssh-e2e stat -c %s $REMOTE_DIR/cc.txt 2>/dev/null)
  V2=$(docker exec tinyssh-e2e sh -c "ls $REMOTE_DIR/.tinyssh-part-*-cc.txt 2>/dev/null | wc -l")
  if [ -z "$V1" ] && [ "$V2" = "0" ]; then
    echo "[driver] r34e remote-verified（cc.txt 不存在 + temp 清）"
  else
    echo "[driver] R34E REMOTE-VERIFY FAILED: cc=$V1 temp=$V2"; docker exec tinyssh-e2e ls -la $REMOTE_DIR; exit 2
  fi
else
  echo "[driver] R34E FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
fi
stage_end r34e

echo "[driver] ALL STAGES DONE"
