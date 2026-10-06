#!/usr/bin/env python3
"""UX-R1 P5 内存采样器（R04 冻结口径，见 delivery §4 与 r04-environment.md §2.1）。

用法：
  # 归属验证（采样会话前置断言，失败即中止）
  python3 scripts/perf/memsample.py --app-pid <PID> --validate

  # 相位采样：--phase B（预热后基线）或 E（测试后末段）；各采 60s、每 5s 一次
  python3 scripts/perf/memsample.py --app-pid <PID> --phase B --out /tmp/p5_B.json

口径：应用进程 RSS + 专属 WebKit WebContent/GPU/Networking 辅助进程 RSS 合计（MB）。
归属两层验证：①采样前系统 WebKit 辅助进程计数与 --app-pid 归属集一致；
②--validate 结束时输出核对清单（计数/启动窗/名称），任何异常退出码 2。
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
    """返回 [(pid, rss_kb, comm)]：系统内全部 WebKit 辅助进程。"""
    out = sh("ps axo pid=,rss=,comm=").splitlines()
    helpers = []
    for line in out:
        parts = line.split(None, 2)
        if len(parts) == 3 and any(m in parts[2] for m in WEBKIT_MARKERS):
            helpers.append((int(parts[0]), int(parts[1]), parts[2].strip()))
    return helpers


def rss_kb(pid):
    out = sh(f"ps -o rss= -p {pid}").strip()
    return int(out) if out else 0


def sample_total(app_pid):
    return (rss_kb(app_pid) + sum(h[1] for h in webkit_helpers())) / 1024.0


def validate(app_pid, window_seconds=120):
    """两层归属验证：启动窗内出现的辅助进程，名称与计数核对。"""
    app_start = sh(f"ps -o lstart= -p {app_pid}").strip()
    if not app_start:
        print(f"FAIL: app pid {app_pid} 不存在")
        return 2
    before = {h[0] for h in webkit_helpers()}
    print(f"应用启动时间: {app_start}")
    print(f"采样前已有 WebKit 辅助进程 {len(before)} 个: {sorted(before)}")
    if before:
        print("FAIL: 基线不为零——请先退出全部浏览器/WebKit 宿主应用（含 Safari、"
              "Electron 应用、其他 Tauri dev 实例），再重跑 --validate")
        return 2
    print("等待辅助进程出现（应随目标应用窗口加载出现 3 个：WebContent/GPU/Networking）…")
    deadline = time.time() + window_seconds
    seen = {}
    while time.time() < deadline:
        for pid, _rss, comm in webkit_helpers():
            seen.setdefault(pid, comm)
        if len(seen) >= 3:
            break
        time.sleep(1)
    kinds = sorted(comm.split("/")[-1].split(".xpc")[0] for comm in seen.values())
    ok = len(seen) == 3 and all(k in ("WebContent", "GPU", "Networking") for k in kinds)
    print(f"出现 {len(seen)} 个: {kinds} → {'PASS' if ok else 'FAIL'}")
    if not ok:
        print("FAIL: 辅助进程数量或类型与 Tauri 应用预期不符，归属不可靠")
        return 2
    print(f"核对清单 OK：count=3 kinds={kinds}。退出应用后应随之消失（--validate-teardown 手动核对）")
    return 0


def record(app_pid, phase, out_path, duration=60, interval=5):
    samples = []
    t0 = time.time()
    while time.time() - t0 < duration:
        total = sample_total(app_pid)
        samples.append({"t": round(time.time() - t0, 1), "total_mb": round(total, 1),
                        "helpers": [h[0] for h in webkit_helpers()]})
        time.sleep(interval)
    med = statistics.median(s["total_mb"] for s in samples)
    result = {"phase": phase, "app_pid": app_pid, "median_mb": round(med, 1),
              "samples": samples, "protocol": "60s / 5s interval / median"}
    with open(out_path, "w") as f:
        json.dump(result, f, indent=1)
    print(f"{phase} 相位中位数 = {med:.1f} MB → {out_path}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-pid", type=int, required=True)
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--phase", choices=["B", "E"])
    ap.add_argument("--out", default="/tmp/p5_sample.json")
    ap.add_argument("--duration", type=int, default=60)
    ap.add_argument("--interval", type=int, default=5)
    args = ap.parse_args()
    if args.validate:
        sys.exit(validate(args.app_pid))
    if args.phase:
        sys.exit(record(args.app_pid, args.phase, args.out,
                        args.duration, args.interval))
    print("需要 --validate 或 --phase")
    sys.exit(1)


if __name__ == "__main__":
    main()
