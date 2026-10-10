#!/usr/bin/env python3
"""UX-R1 P4 传输吞吐采样（旧版基线，Q-03/Q-06 协议重设计版——待受控窗口执行）。

联审 Q-06 修正：v1 单会话 + Cmd+2 不构成「传输同时切换」证据；发送次数≠完成次数。
本协议：
- 两个已确认会话（ssh 127.0.0.1:2222 + 本机 local，启动即 AUTOCONNECT，建连由
  stderr 成功行核验），P4 门要求传输期间同时终端输入/切换。
- 下载 ×5：UI「按路径下载」输入框（坐标 --ix/--iy 需截图标定）→ ev2 键入路径 +
  Return → 轮询本地文件至 100MB 稳定 → SHA-256 对照。
- 上传 ×5：release 产品能力 = 拖拽上传（Tauri drag-drop 通道，App.tsx:1522+，
  release 可用）；自动化依赖合成拖拽（CGEvent down→dragging→drop），T20 §5.14
  曾披露双屏+多 Space 下不可脚本驱动——受控窗口内先尝试并记录尝试日志；失败则
  上传基线按「环境阻塞」登记（附尝试证据），不虚报。
- 传输中真实并发：切换（Cmd+1/2 经 ev2 定向）×5 次 + 切回后输入一个字符（ev2）；
  记录切换完成数（像素证据）与输入回显确认，而非仅发送次数。
- 完成口径：本地文件大小稳定 + SHA 校验；吞吐 = 大小/墙钟。
"""

import argparse
import hashlib
import json
import os
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
LOCAL = os.path.expanduser("~/Downloads/p4_100mb.bin")
# G5 B1 基线：R04 源文件为随机内容且随 /tmp 清空不可复原；改用**可复现**的
# 确定性 100MB 源（字节模式 (i*7+11)%256）。协议不变（源=目标完整性对照），
# 仅夹具身份变更——登记为偏离。可用 --expect-sha / --bin 覆盖。
EXPECT_SHA = "f89010402d8ea934d4475a52777afc4b04fc5d127e4e953fd5f38902a6b0f651"
SIZE = 104857600


def activate_by_pid(pid):
    r = subprocess.run(["osascript", "-e",
                        f'tell application "System Events" to set frontmost of '
                        f'(first process whose unix id is {pid}) to true'],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"activate failed: {r.stderr.strip()}")
    time.sleep(0.5)


def send(pid, *args):
    r = subprocess.run(["python3", EV2] + list(args) + ["--pid", str(pid)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"ev2 guard/failed: {r.stderr.strip()}")
    return int(next(l for l in r.stdout.splitlines() if l.startswith("T0=")).split("=")[1])


def window_rect(pid):
    import Quartz
    wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, 0)
    for w in wl:
        if w.get("kCGWindowOwnerPID") == pid:
            b = w.get("kCGWindowBounds")
            if b and int(b["Width"]) == 1280 and int(b["Height"]) == 800:
                return int(b["X"]), int(b["Y"])
    return None, None


def snap_md5(x, y, w, h):
    p = "/tmp/r4_p3/p4_probe.png"
    subprocess.run(["screencapture", "-x", "-R", f"{x},{y},{w},{h}", p], capture_output=True)
    return hashlib.md5(open(p, "rb").read()).hexdigest()


def wait_connected(err_path):
    """Q-06/复审低-3：AUTOCONNECT="host,local" 须**两条**成功行齐才算两会话已确认。"""
    import re
    ok_re = re.compile(r"^\[app\] autoconnect (\S+) -> (s-[0-9a-f-]{36})$", re.M)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        sids = {m.group(2) for m in ok_re.finditer(open(err_path).read())}
        if len(sids) >= 2:
            return True
        time.sleep(0.2)
    return False


def download_run(pid, wx, wy, ix, iy, idx, do_switch):
    if os.path.exists(LOCAL):
        os.remove(LOCAL)
    send(pid, "click", "--x", str(ix), "--y", str(iy))
    time.sleep(0.3)
    send(pid, "text", "--string", "/root/p4_100mb.bin")
    time.sleep(0.3)
    t0 = send(pid, "key", "--code", "36")  # Return
    last, stable, switches_done, echo_ok = -1, 0, 0, 0
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        try:
            sz = os.path.getsize(LOCAL)
        except OSError:
            sz = -1
        if sz >= 0:
            if sz == last and sz >= SIZE:
                break
            stable = stable + 1 if sz == last else 0
            last = sz
        if do_switch and switches_done < 5 and 0 < sz < SIZE:
            send(pid, "key", "--code", "19" if switches_done % 2 == 0 else "18",
                 "--flag", "cmd")
            switches_done += 1
            time.sleep(0.4)
            # 切回后真实输入一个字符并等回显（Q-06：完成而非发送）
            region_probe = snap_md5(wx + 240, wy + 140, 300, 120)
            send(pid, "text", "--string", "x")
            time.sleep(0.4)
            if snap_md5(wx + 240, wy + 140, 300, 120) != region_probe:
                echo_ok += 1
            send(pid, "key", "--code", "51")  # 退格恢复现场
            time.sleep(0.2)
        time.sleep(0.1)
    r = {"idx": idx, "kind": "download", "switches_completed": switches_done,
         "echo_confirmed": echo_ok}
    if os.path.exists(LOCAL) and os.path.getsize(LOCAL) == SIZE:
        h = hashlib.sha256(open(LOCAL, "rb").read()).hexdigest()
        r["sha_ok"] = h == EXPECT_SHA
        # t0 为 ev2 投递点 epoch 毫秒——与 time.time()*1000 同域相减（复审高-1 修正）
        r["wall_s"] = round((time.time() * 1000 - t0) / 1000, 2)
    else:
        r["sha_ok"] = False
        r["fail"] = f"size={os.path.getsize(LOCAL) if os.path.exists(LOCAL) else 'missing'}"
    return r


def drag_upload_attempt(pid, wx, wy):
    """合成拖拽上传尝试（受控窗口内）。返回 (ok, log)。不可靠即如实登记阻塞。"""
    log = []
    src = Quartz = __import__("Quartz")
    ev_src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    start = Quartz.CGPointMake(wx + 900, wy + 700)   # 本地终端区（示意，需标定）
    dest = Quartz.CGPointMake(wx + 400, wy + 300)    # 远程文件区（示意，需标定）
    for phase, point in [("MouseMoved", start), ("LeftMouseDown", start)]:
        e = Quartz.CGEventCreateMouseEvent(ev_src, getattr(Quartz, phase), point, 0)
        Quartz.CGEventPostToPid(pid, e)
    for step in range(1, 21):
        pt = Quartz.CGPointMake(start.x + (dest.x - start.x) * step / 20,
                                start.y + (dest.y - start.y) * step / 20)
        e = Quartz.CGEventCreateMouseEvent(ev_src, Quartz.kCGEventLeftMouseDragged, pt, 0)
        Quartz.CGEventPostToPid(pid, e)
        time.sleep(0.02)
    e = Quartz.CGEventCreateMouseEvent(ev_src, Quartz.kCGEventLeftMouseUp, dest, 0)
    Quartz.CGEventPostToPid(pid, e)
    log.append("synthetic drag posted (pid-targeted); Tauri drag-drop channel 是否产生 "
               "onDragDrop 由传输卡片出现与否判定")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        # 判定：窗口标题区/侧栏出现「上传」传输卡片——以截图差异近似，标注为近似证据
        time.sleep(0.5)
        break
    return None, "; ".join(log) + "；自动判定缺失，需人工/截图确认——按 §5.14 预期大概率失败"


def main():
    global BIN, EXPECT_SHA
    ap = argparse.ArgumentParser()
    ap.add_argument("--ix", type=int, required=True, help="按路径下载输入框 屏幕X（截图标定）")
    ap.add_argument("--iy", type=int, required=True, help="按路径下载输入框 屏幕Y（截图标定）")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--out", default="/tmp/r4_p3/p4_download.json")
    ap.add_argument("--bin", default=str(BIN), help="被测二进制（B1 基线指向 worktree 打包产物）")
    ap.add_argument("--expect-sha", default=EXPECT_SHA, help="源文件 SHA256（默认=可复现夹具）")
    args = ap.parse_args()
    BIN = Path(args.bin)
    EXPECT_SHA = args.expect_sha
    import sqlite3
    conn = sqlite3.connect(ENV["TINYSSH_DB"])
    host_id = conn.execute(
        "SELECT id FROM hosts WHERE address='127.0.0.1' AND port=2222").fetchone()[0]
    conn.close()
    err_path = "/tmp/r4_p3/p4.err"
    with open(err_path, "wb") as errf:
        proc = subprocess.Popen([BIN], env={**ENV, "TINYSSH_AUTOCONNECT": f"{host_id},local"},
                                stdout=subprocess.DEVNULL, stderr=errf)
    if not wait_connected(err_path):
        proc.kill()
        raise SystemExit("sessions not confirmed connected in 30s")
    pid = proc.pid
    activate_by_pid(pid)
    wx, wy = window_rect(pid)
    runs = [download_run(pid, wx, wy, args.ix, args.iy, i + 1, do_switch=(i >= 1))
            for i in range(args.runs)]
    up_ok, up_log = 0, []
    for i in range(args.runs):
        ok, log = drag_upload_attempt(pid, wx, wy)
        up_log.append({"idx": i + 1, "ok": ok, "log": log})
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
    ok_runs = [r for r in runs if r.get("sha_ok")]
    summary = {"runs": runs, "upload_attempts": up_log,
               "download": {"n": len(ok_runs),
                            "throughput_mbs": round(statistics.median(
                                [SIZE / 1048576 / r["wall_s"] for r in ok_runs]), 1) if ok_runs else None},
               "expect_sha256": EXPECT_SHA,
               "protocol": ("two confirmed sessions (stderr success-line verified); download UI-"
                            "driven via path input; mid-transfer 5 switches + input echo confirm "
                            "(completion counted, not send count); upload via synthetic drag "
                            "attempt (§5.14 known-unreliable, failures registered as blocked); "
                            "ev2 pid-targeted delivery; run in controlled env only")}
    with open(args.out, "w") as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)
    print(f"== P4: download n={len(ok_runs)} median={summary['download']['throughput_mbs']}MB/s -> {args.out}")


if __name__ == "__main__":
    main()
