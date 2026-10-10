#!/usr/bin/env python3
"""UX-R1 P1 启动采样（旧版基线，Q-04 列表就绪直打点版）。

可操作口径（联审 Q-04 修订）：SMOKE 注入脚本在**种子主机卡片（20 张）全部渲染**
时直接打点 `<run_id>|s2-list-ready`（main.rs 注入脚本 mark()，仅 TINYSSH_SMOKE=1
dev 门控），operable = 该信标行到达时刻 − spawn 时刻，无任何相减推断。
每轮带独立 TINYSSH_RUN_ID，共享信标日志按运行标识精确归因。

历史口径（已降级保留）：v1/v2 经表单阶段信标（s2-key-mode）相减推断，
只证明「添加主机表单」时序，不构成主机列表启动门证据——见 r04-baseline.md。

用法：
  python3 scripts/perf/p1_launch.py --mode cold --runs 10 --out /tmp/r4_p1/cold2.json
  python3 scripts/perf/p1_launch.py --mode warm --runs 10 --out /tmp/r4_p1/warm2.json

前置：beacon.py 已在 127.0.0.1:15199 运行；/tmp/t40_smoke/beacon.log 可写；
     /tmp/r4_p1/tinyssh.db 已含 20 主机种子；release 二进制已含列表打点注入。
口径：cold = 启动前静置 60s 的进程冷启动（OS 页缓存热，非重启冷）；warm = 退出后立即重启。
"""

import argparse
import hashlib
import json
import statistics
import subprocess
import time
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

BIN = REPO / "target/release/tinyssh-app"
LOG = "/tmp/t40_smoke/beacon.log"
ENV = {"TINYSSH_DB": "/tmp/r4_p1/tinyssh.db",
       "TINYSSH_MASTER_KEY": "07" * 32,
       "TINYSSH_SMOKE": "1"}


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def log_size():
    try:
        with open(LOG) as f:
            return f.tell(), f.read().count("\n")
    except FileNotFoundError:
        return 0, 0


def wait_marker(marker, deadline_s, pos0=0):
    """轮询日志新增行（自 pos0 起），返回 (单调秒, 新 pos)；超时返回 (None, pos)。"""
    with open(LOG) as f:
        f.seek(pos0)
        start = time.monotonic()
        while time.monotonic() - start < deadline_s:
            pos = f.tell()
            line = f.readline()
            if not line:
                time.sleep(0.005)
                f.seek(pos)
                continue
            if marker in line:
                return time.monotonic(), f.tell()
    return None, pos0


def run_once(idx):
    # Q-04：每轮独立运行标识，信标打点精确归因（共享日志不再依赖顺序推断）
    run_id = f"p1-{args.mode}-{idx}-{uuid.uuid4().hex[:8]}"
    _, n0 = log_size()
    with open(LOG, "a"):
        pass
    t0 = time.monotonic()
    proc = subprocess.Popen([BIN], env={**ENV, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                                        "TINYSSH_RUN_ID": run_id},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ready, _ = wait_marker(f"{run_id}%7Cs2-list-ready", 30)  # 信标行 URL 编码（|→%7C）
    result = {"idx": idx, "pid": proc.pid, "run_id": run_id}
    if ready is not None:
        # 直打点：列表就绪事件到达即操作口径，无任何相减推断
        result["list_ready_ms"] = round((ready - t0) * 1000)
        result["operable_ms"] = result["list_ready_ms"]
    else:
        result["fail"] = "list-ready timeout 30s"
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
        result["forcekill"] = True
    return result


def main():
    global args, BIN
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["cold", "warm"], required=True)
    ap.add_argument("--runs", type=int, default=10)
    ap.add_argument("--out", required=True)
    ap.add_argument("--bin", default=str(BIN),
                    help="被测二进制。默认=主树开发产物 target/release/tinyssh-app；"
                         "B1/B2 基线须显式传入打包产物（漏传会静默跑成主树产物）")
    args = ap.parse_args()
    BIN = Path(args.bin).resolve()
    if not BIN.is_file():
        raise SystemExit(f"被测二进制不存在或不是文件：{BIN}")
    if args.runs < 1:
        ap.error("--runs must be >= 1")
    runs = []
    for i in range(args.runs):
        if args.mode == "cold":
            time.sleep(60)
        r = run_once(i + 1)
        runs.append(r)
        print(f"[{args.mode} #{i+1}] {r}", flush=True)
    ok = [r["operable_ms"] for r in runs if "operable_ms" in r]
    summary = {
        "bin": str(BIN), "bin_sha256": sha256_file(BIN),
        "mode": args.mode, "runs": runs,
        "operable": {"n": len(ok), "median_ms": round(statistics.median(ok)) if ok else None,
                     "p95_ms": round(statistics.quantiles(ok, n=20, method="inclusive")[18]) if len(ok) >= 2 else None,
                     "min_ms": min(ok) if ok else None, "max_ms": max(ok) if ok else None},
        "protocol": ("Q-04 endpoint: operable = per-run beacon mark '<run_id>|s2-list-ready' "
                     "arrival - t0 (direct observation: 20 seeded host cards rendered; "
                     "no offset subtraction); run id isolates shared beacon log; "
                     "cold=idle 60s process-cold"),
    }
    with open(args.out, "w") as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)
    print(f"== {args.mode}: n={len(ok)} median={summary['operable']['median_ms']}ms "
          f"p95={summary['operable']['p95_ms']}ms -> {args.out}")


if __name__ == "__main__":
    main()
