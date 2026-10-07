#!/usr/bin/env python3
"""UX-R1 P5 内存采样器 v4（差分归属法，见 r04-environment.md §2.1）。

v1 的零基线 --validate 要求退出全部浏览器应用，与用户约束冲突；且 sample_total
误将全系统 WebKit 辅助进程计入——2026-10-06 独立审核后整体重写为差分法。
v3→v4（受托签署 Q-05 重开）：JSON pid 键在装载边界统一转 int（json 往返会把
int 键写成字符串，导致 candidates 混入 S0、record 对活候选误判消失、verify
残留检测恒空）；record 的 total 不再把应用 RSS 计两次；verify 增加「同 PID
换启动身份」复用检测。修复依据：2026-10-06-e2ebdc4-signoff/memsample-probe.json。

  ① snapshot：启动目标应用前记录系统 WebKit 辅助进程全集 S0
     python3 scripts/perf/memsample.py snapshot --out /tmp/p5_s0.json
  ② candidates：应用就绪后计算并冻结候选集（= 当前 WebKit 集合 − S0）
     python3 scripts/perf/memsample.py candidates --s0 /tmp/p5_s0.json \
         --out /tmp/p5_cands.json
  ③ record：相位采样（应用 + 候选 RSS 合计，60s / 每 5s，中位数；逐候选曲线落盘；
     候选消失/换身份/**采样期出现未知新 WebKit 进程** → 采样作废 exit 2，fail-closed
     ——Q-05；提供 --s0 可全封闭新增进程）
     python3 scripts/perf/memsample.py record --app-pid <PID> \
         --cands /tmp/p5_cands.json --s0 /tmp/p5_s0.json --phase B --out /tmp/p5_B.json
  ④ verify：应用退出后核验候选全部消失且无 lstart 身份复用（PID 复用检测）
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


def webkit_helpers():
    """返回 {pid: {rss_kb, lstart, comm}}：系统内全部 WebKit 辅助进程（带启动身份）。"""
    lst = {int(l.split()[0]): l.split(None, 3)[2] + " " + l.split(None, 3)[3].strip()
           for l in sh("ps axo pid=,lstart=,comm=").splitlines() if l.strip()}
    out = {}
    for line in sh("ps axo pid=,rss=,comm=").splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and any(m in parts[2] for m in WEBKIT_MARKERS):
            pid = int(parts[0])
            out[pid] = {"rss_kb": int(parts[1]), "lstart": lst.get(pid, "?"),
                        "comm": parts[2].strip()}
    return out


def rss_kb(pid):
    """目标进程 RSS；进程不存在返回 None（调用方须作废采样，不可记 0）。"""
    v = sh(f"ps -o rss= -p {pid}").strip()
    return int(v) if v else None


def load_pid_map(path):
    """装载 {pid: …} JSON 并把 pid 键统一转 int。

    json.dump 会把 int 键序列化为字符串；不归一化则与 ps 采集的 int 键集合
    永不相交——candidates 混入 S0、record 对活候选误判消失、verify 残留检测
    恒空（签署探针实证的三处缺陷根源）。
    """
    return {int(k): v for k, v in json.load(open(path)).items()}


def cmd_snapshot(args):
    s0 = {pid: {"lstart": h["lstart"], "comm": h["comm"]} for pid, h in webkit_helpers().items()}
    json.dump(s0, open(args.out, "w"), indent=1)
    print(f"S0 = {len(s0)} 个系统 WebKit 辅助进程（含 lstart 身份）→ {args.out}")


def cmd_candidates(args):
    s0 = load_pid_map(args.s0)
    cur = webkit_helpers()
    cand = {pid: {"lstart": h["lstart"], "comm": h["comm"]}
            for pid, h in cur.items() if pid not in s0}
    json.dump(cand, open(args.out, "w"), indent=1)
    print(f"候选 = {len(cand)} 个（S0 {len(s0)} 之外新增，含 lstart 身份）: "
          f"{sorted(cand)} → {args.out}")
    if not cand:
        print("FAIL: 候选为空——应用未启动或归属失败", file=sys.stderr)
        return 2
    return 0


def cmd_record(args):
    """逐样本记录**每个候选的独立曲线**；候选消失/换身份 → 采样作废（fail-closed，
    不再静默记 0 或漏计——Q-05）。返回码 2 = 归属失效，数据不得作为门证据。"""
    cand = load_pid_map(args.cands)  # {pid: {lstart, comm}}，pid 键已归一 int
    s0 = set(load_pid_map(args.s0)) if getattr(args, "s0", None) else set()
    known = set(int(k) for k in cand) | s0
    samples, void_reason = [], None
    t0 = time.monotonic()
    while time.monotonic() - t0 < args.duration:
        cur = webkit_helpers()
        per = {}
        broken = None
        new_helpers = sorted(set(cur) - known)
        if new_helpers:
            broken = broken or f"new webkit helper(s) appeared mid-sample: {new_helpers}（Q-05 漏计封口）"
        app_kb = rss_kb(args.app_pid)
        if app_kb is None:
            broken = broken or f"app pid {args.app_pid} disappeared"
        for pid, ident in cand.items():
            h = cur.get(pid)
            if h is None:
                broken = broken or f"candidate pid {pid} disappeared mid-sample"
                per[str(pid)] = None
            elif h["lstart"] != ident["lstart"]:
                broken = broken or f"candidate pid {pid} lstart changed (PID reuse?)"
                per[str(pid)] = None
            else:
                per[str(pid)] = h["rss_kb"]
        per["app"] = app_kb  # 曲线含应用自身；helper 合计与 total 均只计一次（v4 修双计）
        helper_kb = sum(v for k2, v in per.items() if k2 != "app" and isinstance(v, int))
        app_total = app_kb if app_kb is not None else 0
        samples.append({"t": round(time.monotonic() - t0, 1),
                        "total_mb": round((helper_kb + app_total) / 1024.0, 2),
                        "per_candidate_kb": per,
                        "helper_total_mb": round(helper_kb / 1024.0, 2)})
        if broken and not void_reason:
            void_reason = broken
        time.sleep(args.interval)
    med = statistics.median(s["total_mb"] for s in samples)
    result = {"phase": args.phase, "app_pid": args.app_pid, "sampler_version": "v4",
              "candidates": {str(k): v for k, v in cand.items()},
              "voided": bool(void_reason),
              "void_reason": void_reason,
              "median_mb": round(med, 2) if not void_reason else None,
              "samples": samples,
              "protocol": "differential attribution v4 (fail-closed): app + frozen candidates "
                          "with lstart identity; JSON pid keys normalized to int at load "
                          "boundary; app RSS counted once; candidate disappearance/identity "
                          "change/unknown new webkit helper voids "
                          f"the sample. {args.duration}s/"
                          f"{args.interval}s interval"}
    with open(args.out, "w") as f:
        json.dump(result, f, indent=1)
    if void_reason:
        print(f"{args.phase} VOIDED: {void_reason} → {args.out}", file=sys.stderr)
        return 2
    print(f"{args.phase} 相位中位数 = {med:.2f} MB（归属完好，逐候选曲线已存）→ {args.out}")
    return 0


def cmd_verify(args):
    """退出后核验：候选 pid 不应存在于当前进程表；若存在且 lstart 变化即 PID 复用
    （v4：键类型归一 + 复用判定从「任意进程同 lstart」改为「同 pid 换身份」——
    旧实现 alive 检测因键错配恒空，复用检查恒 PASS）。"""
    cand = load_pid_map(args.cands)
    cur = webkit_helpers()
    alive = sorted(p for p in cand if p in cur)
    reused = sorted(p for p, ident in cand.items()
                    if p in cur and cur[p]["lstart"] != ident["lstart"])
    if alive or reused:
        print(f"FAIL: 候选残留 {alive} / 同 PID 换身份复用 {reused}——本次采样作废重跑", file=sys.stderr)
        return 2
    print(f"PASS: 候选 {len(cand)} 个全部随应用退出消失（无残留、无同 PID 身份复用）")
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot"); s.add_argument("--out", required=True)
    c = sub.add_parser("candidates"); c.add_argument("--s0", required=True)
    c.add_argument("--out", required=True)
    r = sub.add_parser("record"); r.add_argument("--app-pid", type=int, required=True)
    r.add_argument("--cands", required=True)
    r.add_argument("--s0", default=None, help="snapshot 文件；提供则采样期新增 helper 即作废（fail-closed 全封闭）")
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
