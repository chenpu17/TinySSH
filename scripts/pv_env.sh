#!/usr/bin/env bash
# PV 沙箱环境：预置故障模板的隔离测试机（[validation-plan.md](../docs/validation-plan.md) §3「隔离测试机」的工程实现）。
# 只允许操作 tinyssh-e2e 容器（127.0.0.1:2222，root/testpass）；guard() 校验容器指纹，防误操作其他容器。
#
# 用法：
#   pv_env.sh up          启动沙箱（复用 scripts/dev-sshd.sh，已运行则跳过）
#   pv_env.sh reset       重建沙箱并注入全部故障模板（每位参与者开始前必跑）
#   pv_env.sh fault A|B|C 单独重置某任务故障（任务间切换 / 演练重放）
#   pv_env.sh check A|B|C|all  校验故障态就位（SSH banner 探测，不作 TCP 连通判据）
#   pv_env.sh solve A|B|C 输出该任务的参考修复路径（仅主持人可见，勿透露参与者）
#
# 实现注记：注入走 `docker exec -i sh <<'EOS'`（引号 heredoc，容器内所见即所得，
# 无需 shell 转义）；杀旧实例用 PID 文件或锚定行首的 pkill -f（无锚点的 -f 模式会自匹配本
# 脚本写入容器的文件内容曾把注入 shell 自身杀掉；busybox -x 不做 basename 归一）。
set -euo pipefail
cd "$(dirname "$0")/.."
C=tinyssh-e2e

guard() {
  docker inspect "$C" >/dev/null 2>&1 || { echo "容器 $C 不存在——先运行 $0 up" >&2; exit 1; }
  # 指纹校验：必须是我们自己的 alpine 沙箱、端口必须绑定在 127.0.0.1
  local img port
  img=$(docker inspect -f '{{.Config.Image}}' "$C")
  port=$(docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{$p}}={{(index $b 0).HostIp}}:{{(index $b 0).HostPort}}{{end}}' "$C")
  case "$img" in *alpine*) ;; *) echo "拒绝操作：$C 镜像是 ${img}，不是 alpine 沙箱" >&2; exit 1;; esac
  # 注意：macOS 自带 bash 3.2 下 $var 后紧跟全角字符会把多字节首字节并进变量名，必须用 ${var} 定界
  case "$port" in 22/tcp=127.0.0.1:2222) ;; *) echo "拒绝操作：$C 端口映射异常（${port}），期望 22/tcp=127.0.0.1:2222" >&2; exit 1;; esac
}

banner_ok() {
  # 走查教训：docker 端口代理下 TCP 连通 ≠ sshd 就绪，必须读到 SSH banner 才算就绪
  printf '' | nc -w 3 127.0.0.1 2222 2>/dev/null | head -c 4 | grep -q "SSH-"
}

in_ctr() {
  # 带参数：sh -c 执行；无参数：从 stdin 读脚本（供 inject_* 的 heredoc 用）
  if [ $# -gt 0 ]; then docker exec "$C" sh -c "$1"; else docker exec -i "$C" sh; fi
}

wait_sshd() {
  for _ in $(seq 1 30); do banner_ok && return 0; sleep 1; done
  echo "sshd 30s 内未就绪" >&2; exit 1
}

cmd_up() { scripts/dev-sshd.sh; wait_sshd; echo "沙箱就绪（127.0.0.1:2222）"; }

# ---------- 故障模板注入 ----------
inject_common() {
  in_ctr <<'EOS'
apk add --no-cache busybox-extras curl >/dev/null
mkdir -p /var/log
EOS
}

inject_A() {
  # 任务 A：webapp 无限重启（配置格式错误，日志指向解析失败但不点名键名）
  in_ctr <<'EOS'
mkdir -p /srv/webapp/www
cat > /srv/webapp/www/index.html <<'EOF'
<html><body>webapp OK</body></html>
EOF
cat > /srv/webapp/app.conf <<'EOF'
# webapp 运行配置（格式：KEY="value"）
LISTEN_PORT="8080"
WEBROOT="/srv/webapp/www"
MODE="production"
MAX_CONN = 64
EOF
cat > /srv/webapp/app.sh <<'EOF'
#!/bin/sh
LOG=/var/log/webapp.log
CONF=/srv/webapp/app.conf
log(){ echo "$(date '+%F %T') $*" >>"$LOG"; }
if ! . "$CONF" >/dev/null 2>>"$LOG"; then log "ERROR: 无法加载配置 $CONF，退出"; exit 1; fi
log "config loaded: LISTEN_PORT=${LISTEN_PORT:-unset} WEBROOT=${WEBROOT:-unset} MODE=${MODE:-unset} MAX_CONN=${MAX_CONN:-unset}"
[ "$MODE" = "production" ] || { log "ERROR: MODE 必须为 production，当前为 [$MODE]"; exit 1; }
[ -f "$WEBROOT/index.html" ] || { log "ERROR: webroot 无效：$WEBROOT"; exit 1; }
log "starting httpd on :${LISTEN_PORT}"
exec /usr/sbin/httpd -f -p "${LISTEN_PORT}" -h "${WEBROOT}"
EOF
cat > /srv/webapp/supervisor.sh <<'EOF'
#!/bin/sh
LOG=/var/log/webapp.log
echo $$ > /run/webapp-supervisor.pid
N=0
while :; do
  N=$((N+1))
  echo "$(date '+%F %T') supervisor: 启动 webapp（第 $N 次）" >>"$LOG"
  /srv/webapp/app.sh
  echo "$(date '+%F %T') supervisor: webapp 退出，3 秒后重启" >>"$LOG"
  sleep 3
done
EOF
chmod +x /srv/webapp/app.sh /srv/webapp/supervisor.sh
: > /var/log/webapp.log
# 杀旧实例：supervisor 用 PID 文件，httpd 用锚定 argv[0] 的 pkill -f（-x 匹配的是完整 argv[0]，脚本文本）
[ -f /run/webapp-supervisor.pid ] && kill "$(cat /run/webapp-supervisor.pid)" 2>/dev/null
pkill -f "^/usr/sbin/httpd" 2>/dev/null || true
nohup /srv/webapp/supervisor.sh >/dev/null 2>&1 &
EOS
  sleep 2
}

inject_A2() {
  # 任务 A′（S2 引导段变体，与 A 同构不同例）：MODE 值带尾随空格，服务起不来
  in_ctr <<'EOS'
mkdir -p /srv/webapp/www
cat > /srv/webapp/www/index.html <<'EOF'
<html><body>webapp OK</body></html>
EOF
cat > /srv/webapp/app.conf <<'EOF'
# webapp 运行配置（格式：KEY="value"）
LISTEN_PORT="8080"
WEBROOT="/srv/webapp/www"
MODE="production "
MAX_CONN="64"
EOF
cat > /srv/webapp/app.sh <<'EOF'
#!/bin/sh
LOG=/var/log/webapp.log
CONF=/srv/webapp/app.conf
log(){ echo "$(date '+%F %T') $*" >>"$LOG"; }
if ! . "$CONF" >/dev/null 2>>"$LOG"; then log "ERROR: 无法加载配置 $CONF，退出"; exit 1; fi
log "config loaded: LISTEN_PORT=${LISTEN_PORT:-unset} WEBROOT=${WEBROOT:-unset} MODE=${MODE:-unset} MAX_CONN=${MAX_CONN:-unset}"
[ "$MODE" = "production" ] || { log "ERROR: MODE 必须为 production，当前为 [$MODE]"; exit 1; }
[ -f "$WEBROOT/index.html" ] || { log "ERROR: webroot 无效：$WEBROOT"; exit 1; }
log "starting httpd on :${LISTEN_PORT}"
exec /usr/sbin/httpd -f -p "${LISTEN_PORT}" -h "${WEBROOT}"
EOF
cat > /srv/webapp/supervisor.sh <<'EOF'
#!/bin/sh
LOG=/var/log/webapp.log
echo $$ > /run/webapp-supervisor.pid
N=0
while :; do
  N=$((N+1))
  echo "$(date '+%F %T') supervisor: 启动 webapp（第 $N 次）" >>"$LOG"
  /srv/webapp/app.sh
  echo "$(date '+%F %T') supervisor: webapp 退出，3 秒后重启" >>"$LOG"
  sleep 3
done
EOF
chmod +x /srv/webapp/app.sh /srv/webapp/supervisor.sh
: > /var/log/webapp.log
[ -f /run/webapp-supervisor.pid ] && kill "$(cat /run/webapp-supervisor.pid)" 2>/dev/null
pkill -f "^/usr/sbin/httpd" 2>/dev/null || true
nohup /srv/webapp/supervisor.sh >/dev/null 2>&1 &
EOS
  sleep 2
}

inject_B() {
  # 任务 B：每分钟定时备份持续失败（DEST_DIR 指向不存在的 /backup，规范要求落 /srv/backup/archive）
  in_ctr <<'EOS'
mkdir -p /srv/backup/archive /etc/crontabs
cat > /srv/backup/README.md <<'EOF'
# 备份规范
- 备份归档必须落在 /srv/backup/archive/（便于挂载备份盘）
- 保留最近 7 份，超出由运维脚本清理（非本任务范围）
EOF
cat > /srv/backup/backup.conf <<'EOF'
# 备份配置
SRC_DIR="/srv/webapp/www"
DEST_DIR="/backup"
KEEP_DAYS="7"
EOF
cat > /srv/backup/backup.sh <<'EOF'
#!/bin/sh
CONF=/srv/backup/backup.conf
LOG=/var/log/backup.log
. "$CONF"
STAMP=$(date +%F_%H%M)
DEST="$DEST_DIR/www_$STAMP.tar.gz"
echo "$(date '+%F %T') backup: 开始 $SRC_DIR -> $DEST" >>"$LOG"
tar czf "$DEST" -C "$(dirname "$SRC_DIR")" "$(basename "$SRC_DIR")" 2>>"$LOG" || { echo "$(date '+%F %T') backup: FAILED tar 失败" >>"$LOG"; exit 1; }
echo "$(date '+%F %T') backup: OK $DEST" >>"$LOG"
EOF
chmod +x /srv/backup/backup.sh
grep -q backup.sh /etc/crontabs/root 2>/dev/null || echo "*/1 * * * * /srv/backup/backup.sh >> /var/log/backup.log 2>&1" >> /etc/crontabs/root
rm -rf /backup
rm -f /srv/backup/archive/*
: > /var/log/backup.log
pgrep -x crond >/dev/null || (crond -b -l 8 >/dev/null 2>&1 &)
(sleep 2; /srv/backup/backup.sh >/dev/null 2>&1) &
EOS
  sleep 4
}

inject_B2() {
  # 任务 B′（S2 引导段变体，与 B 同构不同例）：SRC_DIR 指向已下线的 staging-www 目录（对 cwd 不敏感）
  in_ctr <<'EOS'
mkdir -p /srv/backup/archive /etc/crontabs
cat > /srv/backup/README.md <<'EOF'
# 备份规范
- 备份源：/srv/webapp/www（webapp 静态站点目录）
- 备份归档必须落在 /srv/backup/archive/（便于挂载备份盘）
- 保留最近 7 份，超出由运维脚本清理（非本任务范围）
EOF
cat > /srv/backup/backup.conf <<'EOF'
# 备份配置
SRC_DIR="/srv/webapp/staging-www"
DEST_DIR="/srv/backup/archive"
KEEP_DAYS="7"
EOF
cat > /srv/backup/backup.sh <<'EOF'
#!/bin/sh
CONF=/srv/backup/backup.conf
LOG=/var/log/backup.log
. "$CONF"
STAMP=$(date +%F_%H%M)
DEST="$DEST_DIR/www_$STAMP.tar.gz"
echo "$(date '+%F %T') backup: 开始 $SRC_DIR -> $DEST" >>"$LOG"
tar czf "$DEST" -C "$(dirname "$SRC_DIR")" "$(basename "$SRC_DIR")" 2>>"$LOG" || { echo "$(date '+%F %T') backup: FAILED tar 失败" >>"$LOG"; exit 1; }
echo "$(date '+%F %T') backup: OK $DEST" >>"$LOG"
EOF
chmod +x /srv/backup/backup.sh
grep -q backup.sh /etc/crontabs/root 2>/dev/null || echo "*/1 * * * * /srv/backup/backup.sh >> /var/log/backup.log 2>&1" >> /etc/crontabs/root
rm -f /srv/backup/archive/*
: > /var/log/backup.log
pgrep -x crond >/dev/null || (crond -b -l 8 >/dev/null 2>&1 &)
(sleep 2; /srv/backup/backup.sh >/dev/null 2>&1) &
EOS
  sleep 4
}

inject_C() {
  # 任务 C：报告生成失败（数据含坏行）+ 待归档积压（需要人工判断，策略见 ARCHIVE_POLICY.md）
  in_ctr <<'EOS'
mkdir -p /srv/dbapp/data
cat > /srv/dbapp/ARCHIVE_POLICY.md <<'EOF'
# 归档政策（人工判断依据）
仅同时满足以下全部条件的记录可归档：
1. status = done
2. created_at 早于 2026-09-01
3. 用户不在 VIP 名单（/srv/dbapp/vip.list）中
归档操作会修改数据；对无法确定是否满足政策的记录，默认保留并记录原因。
EOF
cat > /srv/dbapp/vip.list <<'EOF'
u1002
u1007
EOF
cat > /srv/dbapp/data/records.csv <<'EOF'
id,user,status,created_at,amount
r001,u1001,done,2026-07-15,120
r002,u1002,done,2026-07-20,80
r003,u1003,open,2026-07-22,40
r004,u1004,done,2026-08-30,200
r005,u1005,done,2026-09-15,60
r006,u1003,done,2026-06-10,90
r007,u1006,done,2026-08-01,15
r008,u1007,done,2026-05-05,300
r009,u1008,done,2026-08-20,45
r010,u1001,open,2026-08-25,70
r011,u1003,done,2026-08-28,130
r012,u1004,done,2026-07-01,25
r013,u1009,done,2026-08-18
EOF
cat > /srv/dbapp/report.sh <<'EOF'
#!/bin/sh
DATA=/srv/dbapp/data/records.csv
awk -F, 'NR>1 && NF==5 { n++; sum+=$5; s[$3]++ } NR>1 && NF!=5 { print "report: 第 " NR " 行字段数异常（" NF " 列），中止"; bad=1; exit 1 } END { if (!bad && NR>1) { print "report: 共 " n " 条有效记录，总金额 " sum; print "report: status=open : " s["open"]+0 " 条"; print "report: status=done : " s["done"]+0 " 条" } }' "$DATA" || exit 1
EOF
chmod +x /srv/dbapp/report.sh
cat > /srv/dbapp/migrate.sh <<'EOF'
#!/bin/sh
PENDING=/srv/dbapp/pending_archive.csv
ARCHIVE=/srv/dbapp/data/archive.csv
echo "待归档记录："
cat "$PENDING"
echo
echo "将按 /srv/dbapp/ARCHIVE_POLICY.md 执行归档，输入 YES 继续（其他输入取消）："
read -r ANS
[ "$ANS" = "YES" ] || { echo "已取消，未做任何修改"; exit 0; }
touch "$ARCHIVE"
while IFS=, read -r id user status ts amount; do
  echo "$id,$user,$status,$ts,$amount" >>"$ARCHIVE"
  echo "archived: $id"
done < "$PENDING"
echo "完成。归档结果见 $ARCHIVE"
EOF
chmod +x /srv/dbapp/migrate.sh
cat > /srv/dbapp/pending_archive.csv <<'EOF'
r002,u1002,done,2026-07-20,80
r004,u1004,done,2026-08-30,200
r006,u1003,done,2026-06-10,90
r008,u1007,done,2026-05-05,300
r012,u1004,done,2026-07-01,25
EOF
rm -f /srv/dbapp/data/archive.csv
EOS
}

# ---------- 校验 ----------
check_A() {
  in_ctr 'grep -q "无法加载配置" /var/log/webapp.log' 2>/dev/null || { echo "A: ✗ 日志无解析失败记录"; return 1; }
  if in_ctr 'wget -qO- -T 2 http://127.0.0.1:8080/ >/dev/null 2>&1'; then echo "A: ✗ webapp 在服务（应为 crash-loop）"; return 1; fi
  echo "A: ✓ crash-loop 就位（config 解析失败，端口 8080 无服务）"
}
check_A2() {
  in_ctr 'grep -q "MODE 必须为 production" /var/log/webapp.log' 2>/dev/null || { echo "A2: ✗ 日志无 MODE 校验失败记录"; return 1; }
  if in_ctr 'wget -qO- -T 2 http://127.0.0.1:8080/ >/dev/null 2>&1'; then echo "A2: ✗ webapp 在服务（应 crash-loop）"; return 1; fi
  echo "A2: ✓ crash-loop 就位（MODE 值尾随空格，端口 8080 无服务）"
}
check_B() {
  in_ctr 'grep -q "FAILED" /var/log/backup.log' 2>/dev/null || { echo "B: ✗ 备份日志无失败记录"; return 1; }
  in_ctr 'test -d /srv/backup/archive && pgrep -x crond >/dev/null' || { echo "B: ✗ archive 目录缺失或 crond 未运行"; return 1; }
  echo "B: ✓ 备份失败就位（DEST_DIR 无效，crond 运行中）"
}
check_C() {
  if in_ctr '/srv/dbapp/report.sh >/dev/null 2>&1'; then echo "C: ✗ report 成功（应失败）"; return 1; fi
  in_ctr 'test -f /srv/dbapp/pending_archive.csv && test ! -f /srv/dbapp/data/archive.csv' || { echo "C: ✗ 归档积压未就位"; return 1; }
  echo "C: ✓ 报告失败 + 归档积压就位"
}

cmd_check() {
  guard; banner_ok || { echo "sshd banner 未就绪"; exit 1; }
  case "${1:-all}" in
    A) check_A ;; B) check_B ;; C) check_C ;;
    all) check_A; check_B; check_C ;;
    *) echo "用法: $0 check A|B|C|all" >&2; exit 1 ;;
  esac
}

cmd_solve() {
  case "$1" in
    A) echo "A 参考路径：tail -f /var/log/webapp.log → 发现配置解析错误 → 修 /srv/webapp/app.conf 第 5 行（MAX_CONN = 64 → MAX_CONN=\"64\"）→ supervisor 自动拉起 → curl localhost:8080 返回 webapp OK" ;;
    A2) echo "A2 参考路径：tail -f /var/log/webapp.log → 发现 [production ]（方括号内尾随空格）→ 修 app.conf 第 4 行 MODE=\"production \" → MODE=\"production\" → supervisor 自动拉起 → curl localhost:8080 返回 webapp OK" ;;
    B) echo "B 参考路径：cat /var/log/backup.log → tar 失败 /backup 不存在 → 对照 /srv/backup/README.md 规范 → backup.conf 的 DEST_DIR 改为 /srv/backup/archive（或创建 /backup）→ 验证日志出现 OK 且归档文件存在" ;;
    B2) echo "B2 参考路径：cat /var/log/backup.log → tar 失败找不到源目录 → 对照 README 备份源规范 → backup.conf 的 SRC_DIR 由已下线的 /srv/webapp/staging-www 改回 /srv/webapp/www → 验证日志出现 OK 且归档文件存在" ;;
    C) echo "C 参考路径：report.sh 失败因 r013 行缺 amount 列——修复可改数据（需判断该记录去留）或改脚本容错；归档步骤按 ARCHIVE_POLICY.md 逐条核对（r008 是 VIP 不可归档，r004 晚于 2026-09-01 不可归档），migrate.sh 为交互式需输入 YES——这是天然的人工处理点" ;;
  esac
}

cmd_reset() {
  docker rm -f "$C" >/dev/null 2>&1 || true
  cmd_up
  inject_common
  inject_A; inject_B; inject_C
  echo "--- 就位校验 ---"
  check_A; check_B; check_C
  echo "reset 完成：三位任务故障全部就位"
}

cmd_fault() {
  guard; banner_ok
  inject_common
  case "$1" in
    A) inject_A; check_A ;; A2) inject_A2; check_A2 ;; B) inject_B; check_B ;; B2) inject_B2; check_B ;; C) inject_C; check_C ;;
    *) echo "用法: $0 fault A|A2|B|B2|C" >&2; exit 1 ;;
  esac
}

case "${1:-}" in
  up) cmd_up ;;
  reset) cmd_reset ;;
  fault) cmd_fault "${2:?用法: $0 fault A|B|C}" ;;
  check) cmd_check "${2:-all}" ;;
  solve) cmd_solve "${2:?用法: $0 solve A|B|C}" ;;
  *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
