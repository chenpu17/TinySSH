#!/usr/bin/env python3
"""UX-R1 P2 本地回显采样（旧版基线）。

方法：AUTOCONNECT(ssh,local) → 前置 → 对终端区域 screencapture 基准帧 →
ev.py 键入 'x' / 退格（keycode 51）交替 → 轮询区域截图 md5 直至变化 →
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

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
import keyguard

BIN = "/Users/chenpu/workspace/claude-code/TinySSH/target/release/tinyssh-app"
EV = "/Users/chenpu/workspace/claude-code/TinySSH/scripts/native-smoke/ev.py"
ENV = {"TINYSSH_MASTER_KEY": "07" * 32, "TINYSSH_DB": "/tmp/r4_p3/tinyssh.db",
       "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/usr/sbin"}


def main_window():
    wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, 0)
    for w in wl:
        if "tinyssh" in (w.get("kCGWindowOwnerName") or "").lower():
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
    keyguard.activate_and_verify()
    subprocess.run(["python3", EV, "key", "19", "cmd"], capture_output=True)  # Cmd+2 = local
    time.sleep(1)
    wx, wy = main_window()
    if wx is None:
        proc.kill()
        raise SystemExit("main window not on screen")
    # 激活终端点击（中心列中部），确保焦点在 xterm
    keyguard.verify()
    subprocess.run(["python3", EV, "click", str(wx + 500), str(wy + 300)], capture_output=True)
    time.sleep(0.5)
    region = [wx + 240, wy + 140, 500, 300]
    results = []
    timeouts = 0
    for i in range(runs):
        base = snap_md5(*region)
        key = ["text", "x"] if i % 2 == 0 else ["key", "51"]
        keyguard.verify()  # 每次键事件前双核验（R04 §5.1 事故护栏）
        t0 = time.monotonic()
        subprocess.run(["python3", EV] + key, capture_output=True)
        t_hit = None
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if snap_md5(*region) != base:
                t_hit = time.monotonic()
                break
        r = {"idx": i + 1}
        if t_hit is None:
            r["fail"] = "no pixel change in 5s"
            timeouts += 1
            if timeouts >= 3 and region[2] < 900:
                region = [wx + 232, wy + 96, 1280 - 232 - 280 - 12, 600]
                r["region_expanded"] = True
        else:
            r["echo_ms"] = round((t_hit - t0) * 1000)
            timeouts = 0
        results.append(r)
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
    ok = [r["echo_ms"] for r in results if "echo_ms" in r]
    summary = {"region": region, "runs": results,
               "echo": {"n": len(ok),
                        "median_ms": round(statistics.median(ok)) if ok else None,
                        "p95_ms": round(statistics.quantiles(ok, n=20, method="inclusive")[18]) if len(ok) >= 2 else None,
                        "min_ms": min(ok) if ok else None, "max_ms": max(ok) if ok else None,
                        "fails": runs - len(ok)},
               "protocol": "CGEvent key -> screencapture region md5 change, serial captures; "
                           "keyguard (frontmost+on-screen) before every key event; "
                           "instrument floor = screencapture period (~40-90ms); values are UPPER BOUNDS",
               "note": "ev.py text/backspace alternate guarantees pixel delta; local zsh session"}
    with open(out, "w") as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)
    print(f"== P2 echo: n={len(ok)} median={summary['echo']['median_ms']}ms "
          f"p95={summary['echo']['p95_ms']}ms fails={runs - len(ok)} -> {out}")


if __name__ == "__main__":
    main()
