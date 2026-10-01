#!/usr/bin/env bash
# PV 分发构建：vite build → cargo tauri build（.app + .dmg）→ 产物归档到 dist-pv/<日期>-<commit>/
# 产物未签名分发时需过 Gatekeeper：右键「打开」，或 xattr -cr /Applications/TinySSH.app
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/3 前端构建 =="
npm run build --prefix ui

echo "== 2/3 tauri 打包（release，首次 5-10 分钟）=="
cargo tauri build

echo "== 3/3 归档 =="
out="dist-pv/$(date +%Y%m%d)-$(git rev-parse --short HEAD)"
mkdir -p "$out"
# workspace 布局：bundle 产物在工作区根 target/，不在 src-tauri/target/
app="target/release/bundle/macos/TinySSH.app"
[ -d "$app" ] || { echo "未找到 $app" >&2; exit 1; }
ditto -c -k --keepParent "$app" "$out/TinySSH.app.zip"
for dmg in target/release/bundle/dmg/*.dmg; do
  [ -e "$dmg" ] && cp "$dmg" "$out/"
done
shasum -a 256 "$out"/* | sed "s|$out/||" > "$out/SHA256SUMS.txt"
git rev-parse HEAD > "$out/COMMIT.txt"
echo
echo "PV 分发产物（版本 = commit $(git rev-parse --short HEAD)）："
ls -lh "$out"
echo
echo "提示：产物未做 Apple 签名/公证，参与者首次打开需右键「打开」，或执行 xattr -cr /Applications/TinySSH.app"
