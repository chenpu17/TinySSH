#!/usr/bin/env bash
# CI 三档（CI 三档轮）：本地与 CI 共用的唯一门禁入口——档位定义以本脚本为准，
# 任何 provider（GitHub Actions / Gitee Go / 手动）都只是它的搬运。
#
#   scripts/ci/run.sh 1   快门：fmt + clippy(报告) + 单元测试 + tsc（目标 <5min）
#   scripts/ci/run.sh 2   集成：快门 + cargo 全量测试 + UI specs 全量
#   scripts/ci/run.sh 3   e2e：集成 + TINYSSH_E2E_SSHD=1 全量（需 docker sshd）
#
# 项目经验固化（勿删）：
# - cargo 必须 -j 4：默认并行会页面文件耗尽（os error 1455 假性编译错）。
# - UI specs 前必须冻结代码：HMR 时序抖动会产生假红（改完代码再跑全量）。
# - 时序假红仲裁：并行满载会崩个别测试的时间窗（如 queue_busy_backpressure
#   实测 6.6s 单跑绿 vs 1081s 并行红）——失败目标逐个单跑复核，单跑绿=假红
#   放行、单跑仍红=真红拦截。
set -uo pipefail
cd "$(dirname "$0")/../.."

TIER="${1:-}"
case "$TIER" in 1|2|3) ;; *) echo "用法: scripts/ci/run.sh <1|2|3>"; exit 2;; esac
FAIL=0
run() {
  local name="$1"; shift
  echo "── [tier$TIER] $name"
  if "$@"; then echo "   ✓ $name"; else echo "   ✗ $name"; FAIL=1; fi
}

# cargo 全量 + 时序假红仲裁（tier2/tier3 共用）：并行失败时按 cargo 报告的
# 复跑目标（`-p X --test Y`）逐个单跑，全绿放行。$@ = cargo 目标选择参数。
cargo_full() {
  local label="$1"; shift
  local log; log=$(mktemp)
  if cargo test -j 4 --no-fail-fast "$@" > "$log" 2>&1; then
    echo "   ✓ $label"
    rm -f "$log"
    return 0
  fi
  local reruns
  reruns=$(grep -oP '(?<=to rerun pass `)[^`]+' "$log" | sort -u)
  if [ -z "$reruns" ]; then
    echo "   ✗ $label（编译错或非测试失败）"
    tail -30 "$log"
    rm -f "$log"
    return 1
  fi
  echo "   ↻ 并行有红，逐个单跑复核（时序假红仲裁，每目标至多两跑）"
  local fail2=0 spec
  while IFS= read -r spec; do
    echo "      ↻ cargo test -j 4 $spec"
    local slog; slog=$(mktemp)
    if cargo test -j 4 $spec > "$slog" 2>&1; then
      echo "      ✓ 单跑绿（并行时序假红）：$spec"
    elif cargo test -j 4 $spec > "$slog" 2>&1; then
      echo "      ✓ 单跑复跑绿（残余负载，第二跑过）：$spec"
    else
      echo "      ✗ 两跑仍红（真红）：$spec"
      tail -20 "$slog"
      fail2=1
    fi
    rm -f "$slog"
  done <<< "$reruns"
  rm -f "$log"
  if [ "$fail2" = "0" ]; then
    echo "   ✓ $label（假红仲裁后全绿）"
    return 0
  fi
  return 1
}

# ---- tier1 快门（每次提交）----
run "cargo fmt --all --check" cargo fmt --all --check
# clippy 报告不设门：43 条历史余量已登记（九轮台账），新代码以 review 把关
run "cargo clippy（报告）" cargo clippy --workspace -j 4 --quiet
run "cargo 单元测试（lib+bins）" cargo test --workspace -j 4 --lib --bins
(cd ui && run "tsc 类型检查" npx tsc --noEmit)

if [ "$TIER" = "1" ]; then
  echo
  if [ "$FAIL" = "0" ]; then echo "tier1 快门：全绿"; else echo "tier1 快门：有红"; fi
  exit "$FAIL"
fi

# ---- tier2 集成门（PR / 每日）----
echo "── [tier2] cargo 全量测试（无 docker 时 e2e 自动 skip）"
# core-session 单独成档：core_local 13 测试全并行且 PTY 重，与全仓并行档互相
# 挤占时 spawn 时序崩、agent 动作级联进 120s 审批门（实测 1082s 假红、安静时
# 6.7s 绿）——单独跑 + 测试线程封顶；两跑仲裁留作残余噪声安全网
cargo_full "cargo 全量（主档）" --workspace --exclude core-session || FAIL=1
cargo_full "cargo 全量（core-session 档，test-threads=4）" -p core-session -- --test-threads=4 || FAIL=1

if [ -z "${TINYSSH_UI_CHROME:-}" ] && [ -f "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" ]; then
  export TINYSSH_UI_CHROME="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
fi
if [ -n "${TINYSSH_UI_CHROME:-}" ]; then
  # dev server：5183 已有实例（前轮遗留常驻）直接复用，否则拉起
  if ! curl -s -o /dev/null --max-time 3 http://localhost:5183/; then
    echo "── [tier2] 拉起 dev server（5183）"
    (cd ui && npm run dev > /tmp/tinyssh-dev.log 2>&1 &)
    sleep 5
  fi
  (cd ui && run "UI specs 全量" env TINYSSH_UI_CHROME="$TINYSSH_UI_CHROME" npm test)
else
  echo "── [tier2] UI specs 跳过（未设 TINYSSH_UI_CHROME）"
fi

if [ "$TIER" = "2" ]; then
  echo
  if [ "$FAIL" = "0" ]; then echo "tier2 集成门：全绿"; else echo "tier2 集成门：有红"; fi
  exit "$FAIL"
fi

# ---- tier3 e2e 门（发布前）----
if docker ps > /dev/null 2>&1; then
  bash scripts/dev-sshd.sh || true
  echo "── [tier3] cargo 全量含 docker sshd e2e"
  # e2e 用例走 env 门（TINYSSH_E2E_SSHD 早退），非 #[ignore]——设 env 即自然纳入
  cargo_full "cargo 全量含 docker sshd e2e（主档）" --workspace --exclude core-session || FAIL=1
  cargo_full "cargo 全量含 docker sshd e2e（core-session 档）" -p core-session -- --test-threads=4 || FAIL=1
else
  echo "── [tier3] docker 不可用，e2e 段跳过（core_local 余 2 例需 sshd 容器）"
fi

echo
if [ "$FAIL" = "0" ]; then echo "tier3 e2e 门：全绿"; else echo "tier3 e2e 门：有红"; fi
exit "$FAIL"
