#!/usr/bin/env python3
"""UX-R1 P2 本地回显采样（旧版基线）。

方法：AUTOCONNECT(ssh,local) → 前置 → 对终端区域 screencapture 基准帧 →
ev2（PID 定向）键入 'x' / 退格（keycode 51）交替 → 轮询区域截图 md5 直至变化 →
键事件到像素变化延迟，100 次。
仪表下限：screencapture 周期（约 40-90ms）+ md5；报告为上限估计（≤该值如实说明）。
若连续 3 次超时（区域无变化），自动扩大区域一次；仍失败则登记环境阻塞。
"""

import hashlib
import json
import statistics
import subprocess
import sys
import time

import Quartz
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))

BIN = REPO / "target/release/tinyssh-app"
EV2 = REPO / "scripts/perf/ev2.py"


def activate_by_pid(pid):
    r = subprocess.run(["osascript", "-e",
                        f'tell application "System Events" to set frontmost of '
                        f'(first process whose unix id is {pid}) to true'],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"activate failed: {r.stderr.strip()}")
    time.sleep(0.5)
ENV = {"TINYSSH_MASTER_KEY": "07" * 32, "TINYSSH_DB": "/tmp/r4_p3/tinyssh.db",
       "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/usr/sbin"}


def main_window(pid):
    wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, 0)
    for w in wl:
        if w.get("kCGWindowOwnerPID") == pid:
            b = w.get("kCGWindowBounds")
            if b and int(b["Width"]) == 1280 and int(b["Height"]) == 800:
                return int(b["X"]), int(b["Y"])
    return None, None


def snap_md5(x, y, w, h):
    p = f"/tmp/r4_p3/echo_{x}_{y}_{w}_{h}.png"
    subprocess.run(["screencapture", "-x", "-R", f"{x},{y},{w},{h}", p],
                   capture_output=True)
    return hashlib.md5(open(p, "rb").read()).hexdigest()


def main():
    runs = 100
    out = "/tmp/r4_p3/p2_echo.json"
    import sqlite3
    conn = sqlite3.connect(ENV["TINYSSH_DB"])
    host_id = conn.execute(
        "SELECT id FROM hosts WHERE address='127.0.0.1' AND port=2222").fetchone()[0]
    conn.close()
    proc = subprocess.Popen([BIN], env={**ENV, "TINYSSH_AUTOCONNECT": f"{host_id},local"},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(8)
    activate_by_pid(proc.pid)  # Q-03：按 unix id 定位本实例
    r = subprocess.run(["python3", EV2, "key", "--pid", str(proc.pid),
                        "--code", "19", "--flag", "cmd"], capture_output=True, text=True)
    if r.returncode != 0:
        proc.kill(); raise SystemExit(f"ev2 guard: {r.stderr.strip()}")  # Cmd+2 = local
    time.sleep(1)
    wx, wy = main_window(proc.pid)
    if wx is None:
        proc.kill()
        raise SystemExit("main window not on screen")
    # 激活终端点击（中心列中部），确保焦点在 xterm（ev2 定向）
    r = subprocess.run(["python3", EV2, "click", "--pid", str(proc.pid),
                        "--x", str(wx + 500), "--y", str(wy + 300)], capture_output=True, text=True)
    if r.returncode != 0:
        proc.kill(); raise SystemExit(f"ev2 guard: {r.stderr.strip()}")
    time.sleep(0.5)
    region = [wx + 240, wy + 140, 500, 300]
    results = []
    timeouts = 0
    for i in range(runs):
        base = snap_md5(*region)
        if i % 2 == 0:
            args = ["text", "--string", "x"]
        else:
            args = ["key", "--code", "51"]
        r = subprocess.run(["python3", EV2] + args + ["--pid", str(proc.pid)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            results.append({"idx": i + 1, "fail": f"ev2 guard: {r.stderr.strip()}"})
            continue
        t0_ms = int(next(l for l in r.stdout.splitlines() if l.startswith("T0=")).split("=")[1])
        t_hit = None
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if snap_md5(*region) != base:
                t_hit = time.time()
                break
        r = {"idx": i + 1}
        if t_hit is None:
            r["fail"] = "no pixel change in 5s"
            timeouts += 1
            if timeouts >= 3 and region[2] < 900:
                region = [wx + 232, wy + 96, 1280 - 232 - 280 - 12, 600]
                r["region_expanded"] = True
        else:
            r["echo_ms_upper"] = round(time.time() * 1000 - t0_ms)  # 上限：含截图周期
            timeouts = 0
        results.append(r)
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
    ok = [r["echo_ms_upper"] for r in results if "echo_ms_upper" in r]
    summary = {"region": region, "runs": results,
               "echo_upper": {"n": len(ok),
                        "median_ms": round(statistics.median(ok)) if ok else None,
                        "p95_ms": round(statistics.quantiles(ok, n=20, method="inclusive")[18]) if len(ok) >= 2 else None,
                        "min_ms": min(ok) if ok else None, "max_ms": max(ok) if ok else None,
                        "fails": runs - len(ok)},
               "protocol": "CGEvent key -> screencapture region md5 change, serial captures; "
                           "ev2 pid-targeted delivery with same-process guard (frontmost + "
                           "on-screen window) before every key event; T0 = real post point; "
                           "instrument floor = screencapture period (~40-90ms); values are UPPER BOUNDS",
               "gate_note": "P2 回显门 P95≤50ms（r04-baseline §1）。本口径为上限值且仪表地板"
                            "（screencapture 周期 ~40-90ms）与门限同量级：上限值 ≤50ms 即门达标；"
                            "否则不可判（既非证过也非证负）——证实/证伪 50ms 门需更细仪表"
                            "（如应用内打点），本脚本用于上限数据采集与回归对照（复审中-3）",
               "note": "ev2 text/backspace alternate guarantees pixel delta; local zsh session"}
    with open(out, "w") as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)
    print(f"== P2 echo: n={len(ok)} median={summary['echo_upper']['median_ms']}ms "
          f"p95={summary['echo_upper']['p95_ms']}ms fails={runs - len(ok)} -> {out}")


if __name__ == "__main__":
    main()
