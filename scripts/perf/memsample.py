#!/usr/bin/env python3
"""UX-R1 P5 内存采样器 v2（差分归属法，见 r04-environment.md §2.1）。

v1 的零基线 --validate 要求退出全部浏览器应用，与用户约束冲突；且 sample_total
误将全系统 WebKit 辅助进程计入——2026-10-06 独立审核后整体重写为差分法：

  ① snapshot：启动目标应用前记录系统 WebKit 辅助进程全集 S0
     python3 scripts/perf/memsample.py snapshot --out /tmp/p5_s0.json
  ② candidates：应用就绪后计算并冻结候选集（= 当前 WebKit 集合 − S0）
     python3 scripts/perf/memsample.py candidates --s0 /tmp/p5_s0.json \
         --out /tmp/p5_cands.json
  ③ record：相位采样（应用 + 候选 RSS 合计，60s / 每 5s，中位数）
     python3 scripts/perf/memsample.py record --app-pid <PID> \
         --cands /tmp/p5_cands.json --phase B --out /tmp/p5_B.json
  ④ verify：应用退出后核验候选全部消失（有残留 → 本次采样作废）
     python3 scripts/perf/memsample.py verify --cands /tmp/p5_cands.json
"""

import argparse
import json
import statistics
import subprocess
import sys
import time

WEBKIT_MARKERS = ("com.apple.WebKit.WebContent", "com.apple.WebKit.GPU",
                   "com.apple.WebKit.Networking")


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout


def webkit_pids():
    """返回 {pid: rss_kb}：系统内全部 WebKit 辅助进程。"""
    out = {}
    for line in sh("ps axo pid=,rss=,comm=").splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and any(m in parts[2] for m in WEBKIT_MARKERS):
            out[int(parts[0])] = int(parts[1])
    return out


def rss_kb(pid):
    v = sh(f"ps -o rss= -p {pid}").strip()
    return int(v) if v else 0


def cmd_snapshot(args):
    s0 = webkit_pids()
    json.dump(sorted(s0), open(args.out, "w"))
    print(f"S0 = {len(s0)} 个系统 WebKit 辅助进程 → {args.out}")


def cmd_candidates(args):
    s0 = set(json.load(open(args.s0)))
    cand = sorted(set(webkit_pids()) - s0)
    json.dump(cand, open(args.out, "w"))
    print(f"候选 = {len(cand)} 个（S0 {len(s0)} 之外新增）: {cand} → {args.out}")
    if not cand:
        print("FAIL: 候选为空——应用未启动或归属失败", file=sys.stderr)
        return 2
    return 0


def cmd_record(args):
    cand = json.load(open(args.cands))
    samples = []
    t0 = time.monotonic()
    while time.monotonic() - t0 < args.duration:
        total = (rss_kb(args.app_pid) + sum(webkit_pids().get(p, 0) for p in cand)) / 1024.0
        samples.append({"t": round(time.monotonic() - t0, 1), "total_mb": round(total, 2)})
        time.sleep(args.interval)
    med = statistics.median(s["total_mb"] for s in samples)
    result = {"phase": args.phase, "app_pid": args.app_pid, "candidates": cand,
              "median_mb": round(med, 2), "samples": samples,
              "protocol": "differential attribution v2: app + frozen candidates only; "
                          f"{args.duration}s / {args.interval}s interval / median"}
    with open(args.out, "w") as f:
        json.dump(result, f, indent=1)
    print(f"{args.phase} 相位中位数 = {med:.2f} MB → {args.out}")


def cmd_verify(args):
    cand = json.load(open(args.cands))
    alive = [p for p in cand if p in webkit_pids()]
    if alive:
        print(f"FAIL: 候选残留 {alive}——本次采样作废重跑", file=sys.stderr)
        return 2
    print(f"PASS: 候选 {len(cand)} 个全部随应用退出消失")
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot"); s.add_argument("--out", required=True)
    c = sub.add_parser("candidates"); c.add_argument("--s0", required=True)
    c.add_argument("--out", required=True)
    r = sub.add_parser("record"); r.add_argument("--app-pid", type=int, required=True)
    r.add_argument("--cands", required=True)
    r.add_argument("--phase", choices=["B", "E"], required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--duration", type=int, default=60)
    r.add_argument("--interval", type=int, default=5)
    v = sub.add_parser("verify"); v.add_argument("--cands", required=True)
    args = ap.parse_args()
    sys.exit({"snapshot": cmd_snapshot, "candidates": cmd_candidates,
              "record": cmd_record, "verify": cmd_verify}[args.cmd](args))


if __name__ == "__main__":
    main()
