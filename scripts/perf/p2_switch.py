#!/usr/bin/env python3
"""UX-R1 P2 会话切换采样（旧版基线）。

方法：AUTOCONNECT 建 2 个会话（SSH + 本机终端）→ ev.py 发 Cmd+1/Cmd+2 交替 →
轮询 CGWindowList 窗口标题（标题跟随会话主机，B20）直至翻转 → 键事件到标题
翻转的延迟即切换耗时，100 次。
前置：P3 bootstrap 已完成（DB 含 127.0.0.1:2222 受信主机）。
"""

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
       "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
K1, K2 = 18, 19  # keycode '1' '2'
CMD = "cmd"


def window_info():
    wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionAll, 0)
    for w in wl:
        if "tinyssh" in (w.get("kCGWindowOwnerName") or "").lower():
            b = w.get("kCGWindowBounds")
            if b and int(b["Width"]) == 1280 and int(b["Height"]) == 800:
                return int(w["kCGWindowNumber"]), w.get("kCGWindowName") or ""
    return None, None


def wait_title(win, needle, deadline_s):
    start = time.monotonic()
    while time.monotonic() - start < deadline_s:
        _, name = window_info()
        if name and needle in name:
            return time.monotonic()
        time.sleep(0.005)
    return None


def main():
    runs = 100
    out = "/tmp/r4_p3/p2_switch.json"
    import sqlite3
    conn = sqlite3.connect(ENV["TINYSSH_DB"])
    host_id = conn.execute(
        "SELECT id FROM hosts WHERE address='127.0.0.1' AND port=2222").fetchone()[0]
    conn.close()
    proc = subprocess.Popen([BIN], env={**ENV, "TINYSSH_AUTOCONNECT": f"{host_id},local"},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(8)  # 两个会话串行建连（每个 ≈1-3s）+ 终端渲染稳定；固定等待，不计入切换计时
    # 前置 + 找窗口（护栏：前台 + 在屏双核验，失败即中止）
    keyguard.activate_and_verify()
    win, title0 = window_info()
    if not win:
        raise SystemExit("main window not found")
    print(f"window {win} title0={title0!r}")
    t_ssh, t_local = "t40-真机密钥", "本机"
    results = []
    # 标题跟随活动会话：初始为后建者（local），先切到 ssh 再交替；按实测初始标题定向
    first = (K1, t_ssh) if t_local in (title0 or "") else (K2, t_local)
    cur_key, cur_target = first
    for i in range(runs):
        keyguard.verify()  # 每次键事件前双核验（R04 §5.1 事故护栏）
        ev_t = time.monotonic()
        subprocess.run(["python3", EV, "key", str(cur_key), CMD], capture_output=True)
        t = wait_title(win, cur_target, 10)
        r = {"idx": i + 1, "to": cur_target}
        if t is None:
            r["fail"] = "title not flipped in 10s"
        else:
            r["switch_ms"] = round((t - ev_t) * 1000)
        results.append(r)
        time.sleep(0.15)
        cur_key, cur_target = (K1, t_ssh) if cur_key == K2 else (K2, t_local)
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
    ok = [r["switch_ms"] for r in results if "switch_ms" in r]
    summary = {"window": win, "runs": results,
               "switch": {"n": len(ok),
                          "median_ms": round(statistics.median(ok)) if ok else None,
                          "p95_ms": round(statistics.quantiles(ok, n=20, method="inclusive")[18]) if len(ok) >= 2 else None,
                          "min_ms": min(ok) if ok else None, "max_ms": max(ok) if ok else None},
               "protocol": "CGEvent Cmd+1/2 -> CGWindowList title flip, 5ms poll; "
                           "keyguard (frontmost+on-screen) before every key event; "
                           "includes ev.py subprocess spawn overhead (~15-30ms) - documented instrument floor"}
    with open(out, "w") as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)
    print(f"== P2 switch: n={len(ok)} median={summary['switch']['median_ms']}ms "
          f"p95={summary['switch']['p95_ms']}ms -> {out}")


if __name__ == "__main__":
    main()
