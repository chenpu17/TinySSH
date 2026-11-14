#!/usr/bin/env bash
# Android 移动端开发助手：把 SDK 里的 adb 从任意 shell 调出来（PATH 里通常没有）。
# 用法：scripts/android.sh <adb 子命令与参数>   例：scripts/android.sh devices
set -euo pipefail
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
exec "$SDK/platform-tools/adb" "$@"
