#!/bin/bash
# R40 原生冒烟驱动（端口转发表单、列表与生命周期 §6.6；真机 sshd 容器 + 真流量）：
#   r40a 主链 -L：UI 建本地转发 127.0.0.1:18080 → 127.0.0.1:22（容器侧解析）→
#         外部经隧道连 127.0.0.1:18080 读到容器 sshd banner（SSH-2.0-…）→ 写 DRV-TRAFFIC-OK
#         → 应用停止转发 → 断言 18080 已关闭（停止等待核心结果、端口交还）。
#   r40b -D：UI 建 SOCKS5 127.0.0.1:18081 → 外部走 SOCKS5 CONNECT 127.0.0.1:22 读 banner
#         → 写 DRV-SOCKS-OK → 停止 → 断言 18081 关闭。
#   r40c 非回环 + 冲突 + 生命周期（全应用内）：0.0.0.0:18082 真监听（暴露范围确认行 +
#         未勾选被拦）→ 端口冲突就地高亮监听字段（forward_listen_failed/listen）→ 停止移除。
# 前置：tinyssh-e2e 容器在跑（22→127.0.0.1:2222）；屏幕已解锁（WKWebView 冻结闸）；
#       beacon 日志每阶段归档清空；口令走 env（钥匙串规避）。
set -u
APP=/Users/chenpu/workspace/claude-code/TinySSH/target/release/tinyssh-app
DIR=/tmp/smoke-r40
DB=$DIR/tinyssh.db
LOG=$DIR/beacon-r40.txt
LPORT=18080
DPORT=18081
NPORT=18082

mkdir -p "$DIR"
cp /Users/chenpu/workspace/claude-code/TinySSH/scripts/native-smoke/beacon.py "$DIR/beacon.py"
lsof -ti :15199 | xargs kill 2>/dev/null || true
# 清历史监听残留
for p in $LPORT $DPORT $NPORT; do lsof -ti :$p | xargs kill 2>/dev/null || true; done
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
  env TINYSSH_SMOKE=1 TINYSSH_SMOKE_MODE=$2 TINYSSH_RUN_ID=$1 \
      TINYSSH_DB=$DB TINYSSH_MASTER_PASSPHRASE=r40-smoke-pass \
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
drv() { curl -s "http://127.0.0.1:15199/t/$1" > /dev/null; }
port_closed() { ! lsof -ti :$1 >/dev/null 2>&1; }
stage_end() {
  kill $P1 2>/dev/null; sleep 2; kill -9 $P1 2>/dev/null
  cp "$LOG" "$DIR/beacon-$1.txt" 2>/dev/null
  : > "$LOG"
}

echo "[driver] ==== r40a 本地转发主链（-L 真流量）===="
P1=$(launch r40a-r1 r40a)
if wait_mark "r40a-listening" 300; then
  # 外部经隧道连 127.0.0.1:18080，读容器 sshd banner（远端侧解析 127.0.0.1:22）
  BANNER=$(python3 - <<PY
import socket
try:
    s=socket.create_connection(('127.0.0.1',$LPORT),6); s.settimeout(6)
    print(s.recv(64).decode('utf-8','replace').strip()); s.close()
except Exception as e:
    print('ERR:'+str(e))
PY
)
  if printf '%s' "$BANNER" | grep -q '^SSH-2.0-'; then
    drv DRV-TRAFFIC-OK
    if wait_mark "r40a-DONE" 200; then
      if port_closed $LPORT; then
        echo "[driver] r40a ALL PASS（经隧道读到容器 banner: ${BANNER}；停止后 $LPORT 已关闭）"
      else
        echo "[driver] R40A FAILED: 停止后 $LPORT 仍监听"; exit 2
      fi
    else
      echo "[driver] R40A FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
    fi
  else
    echo "[driver] R40A FAILED: 隧道未读到容器 banner（got=$BANNER）"; exit 2
  fi
else
  echo "[driver] R40A FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
fi
stage_end r40a

echo "[driver] ==== r40b SOCKS5（-D 真流量）===="
P1=$(launch r40b-r1 r40b)
if wait_mark "r40b-listening" 300; then
  SOCKS=$(python3 - <<PY
import socket, struct
try:
    s=socket.create_connection(('127.0.0.1',$DPORT),6); s.settimeout(6)
    s.sendall(b'\x05\x01\x00'); rep=s.recv(2)
    if rep != b'\x05\x00': print('ERR:greet='+repr(rep)); raise SystemExit
    s.sendall(b'\x05\x01\x00\x01'+socket.inet_aton('127.0.0.1')+struct.pack('>H',22))
    r=s.recv(10)
    if len(r)<2 or r[1]!=0x00: print('ERR:connect='+repr(r)); raise SystemExit
    print(s.recv(64).decode('utf-8','replace').strip()); s.close()
except Exception as e:
    print('ERR:'+str(e))
PY
)
  if printf '%s' "$SOCKS" | grep -q '^SSH-2.0-'; then
    drv DRV-SOCKS-OK
    if wait_mark "r40b-DONE" 200; then
      if port_closed $DPORT; then
        echo "[driver] r40b ALL PASS（SOCKS5 CONNECT 127.0.0.1:22 读到 banner: ${SOCKS}；停止后 $DPORT 已关闭）"
      else
        echo "[driver] R40B FAILED: 停止后 $DPORT 仍监听"; exit 2
      fi
    else
      echo "[driver] R40B FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
    fi
  else
    echo "[driver] R40B FAILED: SOCKS5 未读到容器 banner（got=$SOCKS）"; exit 2
  fi
else
  echo "[driver] R40B FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
fi
stage_end r40b

echo "[driver] ==== r40c 非回环 + 冲突 + 生命周期 ===="
P1=$(launch r40c-r1 r40c)
if wait_mark "r40c-DONE" 300; then
  # 非回环 0.0.0.0:18083 在监听期已真监听并已在应用内停止——此处只对账标记齐备（查活日志）
  for m in "r40c-expose-notice" "r40c-nonloopback-ok" "r40c-conflict-field" "r40c-stop-ok"; do
    grep -q "$m" "$LOG" || { echo "[driver] R40C FAILED: 缺标记 $m"; exit 2; }
  done
  echo "[driver] r40c ALL PASS（暴露范围确认行 / 未勾选被拦 / 0.0.0.0 真监听 / 端口冲突字段定位 / 停止移除）"
else
  echo "[driver] R40C FAILED — beacon tail:"; tail -12 "$LOG"; exit 2
fi
stage_end r40c

echo "[driver] ==== R40 原生冒烟全绿 ===="
