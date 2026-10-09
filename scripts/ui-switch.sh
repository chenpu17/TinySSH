#!/usr/bin/env bash
# R44（§10.2 开发期启动开关）：`TINYSSH_UI_V2` 切换新旧界面，**共用同一核心**。
#
#   TINYSSH_UI_V2=1（默认）→ 新 UI（`ui/`，dev 端口 5183）
#   TINYSSH_UI_V2=0         → 旧 UI（`old-ui-baseline-g0` 工作树，dev 端口 5184）
#
# 共用同一核心的落实：Tauri 后端（含 MCP 端点）始终是**同一个进程**；vault 单实例写锁
# （§10.2）保证不会有两个应用实例各起一套端点。本开关只决定窗口加载哪份前端。
#
# 这是**开发期**设施，不是面向用户的长期双模式；按 §10.2 与 G4 退出条件，在 G5
# 发布候选构建前移除（时机登记见 docs/ux/ux-r1-execution-status.md）。
#
# 用法：
#   scripts/ui-switch.sh dev        # 启动开发（tauri dev）
#   scripts/ui-switch.sh build      # 构建（tauri build，产物内嵌所选 UI）
#   scripts/ui-switch.sh ui-dist    # 仅准备并打印所选 UI 的 dist 目录（供脚本消费）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OLD_TAG="old-ui-baseline-g0"
OLD_WT="$ROOT/.worktrees/old-ui"
NEW_PORT=5183
OLD_PORT=5184
GIT=/usr/bin/git   # 见登记：conda git 缺 UTF-8-MAC 转换器，中文路径会静默出错

mode="${1:-dev}"
ui_v2="${TINYSSH_UI_V2:-1}"

case "$ui_v2" in
  1|true|yes|"") USE_OLD=0 ;;
  0|false|no)    USE_OLD=1 ;;
  *) echo "TINYSSH_UI_V2 取值非法：'$ui_v2'（用 1 或 0）" >&2; exit 2 ;;
esac

prepare_old_ui() {
  if [ ! -d "$OLD_WT/ui" ]; then
    echo "[ui-switch] 创建工作树 $OLD_WT @ $OLD_TAG" >&2
    "$GIT" worktree add --detach "$OLD_WT" "$OLD_TAG" >&2
  fi
  if [ ! -d "$OLD_WT/ui/node_modules" ]; then
    echo "[ui-switch] 安装旧 UI 依赖（首次较慢）" >&2
    npm install --prefix "$OLD_WT/ui" >&2
  fi
}

if [ "$USE_OLD" = 1 ]; then
  prepare_old_ui
  UI_DIR="$OLD_WT/ui"
  PORT="$OLD_PORT"
  LABEL="旧 UI (old-ui-baseline-g0)"
else
  UI_DIR="$ROOT/ui"
  PORT="$NEW_PORT"
  LABEL="新 UI (ui/)"
fi

echo "[ui-switch] 选用：$LABEL" >&2

case "$mode" in
  dev)
    if [ "$USE_OLD" = 1 ]; then
      # 旧 UI 由本脚本自己起 vite；Tauri 侧不再跑 beforeDevCommand（避免起第二份）
      ( cd "$UI_DIR" && npm run dev -- --port "$PORT" ) &
      VITE_PID=$!
      trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT
      cargo tauri dev --config "{\"build\":{\"devUrl\":\"http://localhost:$PORT\",\"beforeDevCommand\":\"\"}}"
    else
      cargo tauri dev
    fi
    ;;
  build)
    shift || true
    cargo tauri build --config "{\"build\":{\"frontendDist\":\"$UI_DIR/dist\",\"beforeBuildCommand\":\"npm run build --prefix $UI_DIR\"}}" "$@"
    ;;
  ui-dist)
    echo "$UI_DIR/dist"
    ;;
  *)
    echo "未知模式：$mode（用 dev | build | ui-dist）" >&2
    exit 2
    ;;
esac
