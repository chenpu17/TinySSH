#!/usr/bin/env bash
# 启动 E2E 测试用 sshd 容器（127.0.0.1:2222，root/testpass，bash + sftp）。
# 端口转发 e2e（T42）：AllowTcpForwarding yes（Alpine 默认 no，会拒绝 direct-tcpip
# 与 tcpip-forward）；2223 映射给远程转发（-R）回程测试用。
set -euo pipefail
if docker ps --format '{{.Names}}' | grep -q '^tinyssh-e2e$'; then
  echo "tinyssh-e2e already running"
  exit 0
fi
docker rm -f tinyssh-e2e 2>/dev/null || true
# Docker Hub 不可达时使用 daocloud 镜像
IMAGE=$(docker pull -q docker.m.daocloud.io/library/alpine:3.20 2>/dev/null || echo alpine:3.20)
docker run -d --name tinyssh-e2e -p 127.0.0.1:2222:22 -p 127.0.0.1:2223:2223 "$IMAGE" sh -c '
sed -i "s|dl-cdn.alpinelinux.org|mirrors.tuna.tsinghua.edu.cn|g" /etc/apk/repositories 2>/dev/null || true
apk add --no-cache openssh-server openssh-server-pam openssh-sftp-server bash
ssh-keygen -A
echo "root:testpass" | chpasswd
sed -i "s/^root:\(.*\):\/bin\/sh$/root:\1:\/bin\/bash/" /etc/passwd
sed -i "s/^AllowTcpForwarding.*/AllowTcpForwarding yes/;s/^#\?GatewayPorts.*/GatewayPorts clientspecified/;s/#PermitRootLogin.*/PermitRootLogin yes/;s/#PasswordAuthentication.*/PasswordAuthentication yes/" /etc/ssh/sshd_config
mkdir -p /run/sshd
/usr/sbin/sshd -D'
echo "waiting for sshd…"
# docker 端口代理下 TCP 连通 ≠ sshd 就绪，读到 SSH banner 才算 ready（nc 探测）
for i in $(seq 1 30); do
  if printf '' | nc -w 3 127.0.0.1 2222 2>/dev/null | head -c 4 | grep -q "SSH-"; then
    echo "ready"; exit 0
  fi
  sleep 1
done
echo "sshd not ready after 30s" >&2; exit 1
