#!/usr/bin/env python3
"""UX-R1 P2 会话切换采样（旧版基线，Q-03/Q-06 仪表重设计版——待受控窗口执行）。

与 v1 的差异（联审 Q-03/Q-06）：
- 投递：ev2.py PID 定向（CGEventPostToPid），落点结构性安全；投递前同进程守卫
  （前台 PID + 目标窗口在屏），拒绝即 abort 不投递（负例已自测，ev2 --selftest）。
- 计时起点 = ev2 stdout `T0=`（真实投递点毫秒时间戳），不再含 ev.py 子进程
  spawn + 2×50ms sleep 的仪表开销（v1 至少 100ms+，无法检验 P95≤100ms 门）。
- 完成端点 = **目标会话内容真实绘制**：终端区域像素证据（screencapture 区域
  md5 脱离预采集基线集合），不再把窗口标题翻转等同渲染。标题翻转另记为状态
  辅助信号。值为上限估计（截图周期为仪表下限，如实标注）。
- 激活：AppleScript 按 unix id 定位本实例（不按进程名，避免同名实例误激活）。

执行前提（Q-03 决议）：受控环境（独立测试登录会话/专用机）或经用户批准的本机
受控窗口；本脚本不改用户桌面状态，除 guard 通过后的定向键事件。
"""

import json
import statistics
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))

BIN = REPO / "target/release/tinyssh-app"
EV2 = REPO / "scripts/perf/ev2.py"
ENV = {"TINYSSH_MASTER_KEY": "07" * 32, "TINYSSH_DB": "/tmp/r4_p3/tinyssh.db",
       "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
K1, K2 = 18, 19  # keycode '1' '2'


def activate_by_pid(pid):
    r = subprocess.run(["osascript", "-e",
                        f'tell application "System Events" to set frontmost of '
                        f'(first process whose unix id is {pid}) to true'],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"activate failed: {r.stderr.strip()}")
    time.sleep(0.5)


def window_title(pid):
    import Quartz
    wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, 0)
    for w in wl:
        if w.get("kCGWindowOwnerPID") == pid:
            b = w.get("kCGWindowBounds")
            if b and int(b["Width"]) == 1280 and int(b["Height"]) == 800:
                return int(w["kCGWindowNumber"]), w.get("kCGWindowName") or ""
    return None, None


def window_rect(pid):
    import Quartz
    wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, 0)
    for w in wl:
        if w.get("kCGWindowOwnerPID") == pid:
            b = w.get("kCGWindowBounds")
            if b and int(b["Width"]) == 1280 and int(b["Height"]) == 800:
                return int(b["X"]), int(b["Y"])
    return None, None


def snap_md5(x, y, w, h, path):
    subprocess.run(["screencapture", "-x", "-R", f"{x},{y},{w},{h}", path],
                   capture_output=True)
    import hashlib
    return hashlib.md5(open(path, "rb").read()).hexdigest()


def send_key(pid, code, flags):
    """经 ev2 定向投递；返回投递点 epoch_ms。守卫拒绝抛 SystemExit。"""
    r = subprocess.run(["python3", EV2, "key", "--pid", str(pid),
                        "--code", str(code)] + sum([["--flag", f] for f in flags], []),
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"ev2 guard/failed: {r.stderr.strip()}")
    for line in r.stdout.splitlines():
        if line.startswith("T0="):
            return int(line.split("=")[1])
    raise SystemExit("ev2 produced no T0")


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
    time.sleep(8)  # 两会话串行建连 + 渲染稳定（固定等待，不计入切换计时）
    pid = proc.pid
    activate_by_pid(pid)
    win, title0 = window_title(pid)
    if not win:
        proc.kill()
        raise SystemExit("main window not found")
    wx, wy = window_rect(pid)
    region = (wx + 240, wy + 140, 500, 300)  # 终端区采样窗（复用 p2_echo 几何）
    print(f"window {win} title0={title0!r} region={region}")
    t_ssh, t_local = "t40-真机密钥", "本机"
    first = (K1, t_ssh) if t_local in (title0 or "") else (K2, t_local)
    cur_key, cur_target = first
    results = []
    for i in range(runs):
        # 预采集基线集合（含光标闪烁相位）：6 帧 / ~0.6s
        base = set()
        for j in range(6):
            base.add(snap_md5(*region, f"/tmp/r4_p3/sw_{i}_{j}.png"))
            time.sleep(0.1)
        t0_ms = send_key(pid, cur_key, ["cmd"])
        t_pixel = None
        deadline = time.time() + 10
        k = 0
        while time.time() < deadline:
            md5 = snap_md5(*region, f"/tmp/r4_p3/sw_{i}_p.png")
            if md5 not in base:
                t_pixel = time.time()
                break
            k += 1
            time.sleep(0.005)
        _, title_now = window_title(pid)
        r = {"idx": i + 1, "to": cur_target}
        if t_pixel is None:
            r["fail"] = "no pixel change in 10s (guard may have passed but render not observed)"
        else:
            r["render_ms_upper"] = round(time.time() * 1000 - t0_ms)  # 上限：含截图周期
            r["title_followed"] = (cur_target in (title_now or ""))
        results.append(r)
        print(r, flush=True)
        time.sleep(0.3)
        cur_key, cur_target = (K1, t_ssh) if cur_key == K2 else (K2, t_local)
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
    ok = [r["render_ms_upper"] for r in results if "render_ms_upper" in r]
    summary = {"window": win, "runs": results,
               "switch_render_upper": {"n": len(ok),
                                       "median_ms": round(statistics.median(ok)) if ok else None,
                                       "p95_ms": round(statistics.quantiles(ok, n=20, method="inclusive")[18]) if len(ok) >= 2 else None,
                                       "fails": runs - len(ok)},
               "protocol": ("ev2 pid-targeted delivery (T0 = real post point, no subprocess "
                            "overhead in measurement); completion = terminal-area pixel md5 "
                            "leaves pre-captured baseline set (includes blink phases); title "
                            "flip recorded as state aux signal only; values are UPPER BOUNDS "
                            "(screencapture period floor ~40-90ms); run in controlled env only"),
               "gate_note": "门 P95≤100ms 以本口径上限值对照，超门需以更细仪表复核"}
    with open(out, "w") as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)
    print(f"== P2 switch: n={len(ok)} median={summary['switch_render_upper']['median_ms']}ms "
          f"p95={summary['switch_render_upper']['p95_ms']}ms -> {out}")


if __name__ == "__main__":
    main()
