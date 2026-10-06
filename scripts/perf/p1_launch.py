#!/usr/bin/env python3
"""UX-R1 P1 启动采样（旧版基线）。口径见 r04-environment.md。

可操作判定：SMOKE 注入脚本的 s2-key-mode 信标到达时刻 − 700ms 固定偏移
（main.rs SMOKE 流程：点击「添加主机」后 sleep(400)，waitFor(select) 后再
sleep(300) 才打 s2 标）＝ s2 语义为「添加主机表单进入 key 模式」，隐含列表
视图已渲染可点击（openBtn 找到并点击成功），对「列表可操作」是保守（偏晚）
代理。审计修正：原 400ms 口径漏计第二个 sleep(300)，2026-10-06 独立审核后统一
改为 700ms 并对已采数据从 s2_ms 重算。
同时记录 s1-opening（页面加载完成、注入脚本启动）供分解。

用法：
  python3 scripts/perf/p1_launch.py --mode cold --runs 10 --out /tmp/r4_p1/cold.json
  python3 scripts/perf/p1_launch.py --mode warm --runs 10 --out /tmp/r4_p1/warm.json

前置：beacon.py 已在 127.0.0.1:15199 运行；/tmp/t40_smoke/beacon.log 可写；
     /tmp/r4_p1/tinyssh.db 已含 20 主机种子。
口径：cold = 启动前静置 60s 的进程冷启动（OS 页缓存热，非重启冷）；warm = 退出后立即重启。
"""

import argparse
import json
import statistics
import subprocess
import time

BIN = "/Users/chenpu/workspace/claude-code/TinySSH/target/release/tinyssh-app"
LOG = "/tmp/t40_smoke/beacon.log"
ENV = {"TINYSSH_DB": "/tmp/r4_p1/tinyssh.db",
       "TINYSSH_MASTER_KEY": "07" * 32,
       "TINYSSH_SMOKE": "1"}
OPERABLE_OFFSET_MS = 700  # 点按钮→sleep(400)→waitFor(select)→sleep(300)→s2 标


def log_size():
    try:
        with open(LOG) as f:
            return f.tell(), f.read().count("\n")
    except FileNotFoundError:
        return 0, 0


def wait_marker(marker, deadline_s):
    """轮询日志新增行，返回该行出现时的单调时钟秒数；超时返回 None。"""
    with open(LOG) as f:
        f.seek(0, 2)
        start = time.monotonic()
        while time.monotonic() - start < deadline_s:
            pos = f.tell()
            line = f.readline()
            if not line:
                time.sleep(0.005)
                f.seek(pos)
                continue
            if marker in line:
                return time.monotonic()
    return None


def run_once(idx):
    _, n0 = log_size()
    with open(LOG, "a"):
        pass
    t0 = time.monotonic()
    proc = subprocess.Popen([BIN], env={**ENV, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    s1 = wait_marker("s1-opening", 30)
    s2 = wait_marker("s2-key-mode", 30)
    result = {"idx": idx, "pid": proc.pid}
    if s1 is not None:
        result["s1_ms"] = round((s1 - t0) * 1000)
    if s2 is not None:
        result["s2_ms"] = round((s2 - t0) * 1000)
        result["operable_ms"] = round((s2 - t0) * 1000 - OPERABLE_OFFSET_MS)
    else:
        result["fail"] = "s2 timeout 30s"
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
        result["forcekill"] = True
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["cold", "warm"], required=True)
    ap.add_argument("--runs", type=int, default=10)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    runs = []
    for i in range(args.runs):
        if args.mode == "cold":
            time.sleep(60)
        r = run_once(i + 1)
        runs.append(r)
        print(f"[{args.mode} #{i+1}] {r}", flush=True)
    ok = [r["operable_ms"] for r in runs if "operable_ms" in r]
    summary = {
        "mode": args.mode, "runs": runs,
        "operable": {"n": len(ok), "median_ms": round(statistics.median(ok)) if ok else None,
                     "p95_ms": round(statistics.quantiles(ok, n=20, method="inclusive")[18]) if len(ok) >= 2 else None,
                     "min_ms": min(ok) if ok else None, "max_ms": max(ok) if ok else None},
        "protocol": "operable = s2 beacon - 700ms fixed offset (sleep400+sleep300 in SMOKE "
                    "flow; s2=add-host form key-mode ready, conservative proxy for list-operable); "
                    "cold=idle 60s process-cold",
    }
    with open(args.out, "w") as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)
    print(f"== {args.mode}: n={len(ok)} median={summary['operable']['median_ms']}ms "
          f"p95={summary['operable']['p95_ms']}ms -> {args.out}")


if __name__ == "__main__":
    main()
