#!/usr/bin/env bash
# Windows 单一二进制（便携 exe）发布构建：vite build → cargo build --release
# → 单文件归档到 dist-portable/<日期>-<commit>/。
# 产物=单 exe：前端资源经 tauri generate_context 编期内嵌、SQLite bundled 编译
# 进二进制、TLS 用 rustls（无 openssl DLL）、CRT 静态链接（.cargo/config.toml）。
# 运行期仅依赖：系统 WebView2 Runtime（Win10/11 自带）+ 用户家目录 ~/.tinyssh。
# 安装器路线（nsis/msi）见 dist.sh 的桌面打包，与本脚本互不影响。
set -euo pipefail
cd "$(dirname "$0")/.."

# 前置：aws-lc-sys（rustls 默认加密后端）在 MSVC 目标要 NASM 汇编；
# 后台/CI shell 常不带机器级 PATH，缺了在编译半程才炸，先显式挡下
command -v nasm >/dev/null 2>&1 || {
  echo "缺少 NASM（aws-lc-sys 必需）：安装后将其目录加入 PATH（本机如 C:\\Program Files\\NASM）" >&2
  exit 1
}

echo "== 1/3 前端构建 =="
npm run build --prefix ui

echo "== 2/3 release 构建（首次 10-20 分钟）=="
cargo build --release -p tinyssh-app

echo "== 3/3 归档 =="
out="dist-portable/$(date +%Y%m%d)-$(git rev-parse --short HEAD)"
mkdir -p "$out"
exe="target/release/tinyssh-app.exe"
[ -f "$exe" ] || { echo "未找到 $exe" >&2; exit 1; }
ver=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
dst="$out/TinySSH_${ver}_windows_x64_portable.exe"
cp "$exe" "$dst"
sha256sum "$dst" | sed "s|$out/||" > "$out/SHA256SUMS.txt"
git rev-parse HEAD > "$out/COMMIT.txt"
echo
echo "便携产物（版本 $ver，commit $(git rev-parse --short HEAD)）："
ls -lh "$out"
