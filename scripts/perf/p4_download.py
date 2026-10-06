#!/usr/bin/env python3
"""UX-R1 P4 下载吞吐采样（旧版基线）。

方法：AUTOCONNECT(ssh) → 前置 → ev.py 点击「按路径下载」输入框（坐标由
--ix/--iy 给出，需先截图标定）→ 键入远端路径 + Return → 轮询本地
~/Downloads/p4_100mb.bin 尺寸至稳定 → 墙钟吞吐；传输中插入 5 次 Cmd+1/2 切换
（P4 门「同时终端切换」）；完成后 SHA-256 对照容器侧校验和。×5 次。

口径：UI 驱动的**下载**路径。旧版 release 无上传按钮（拖拽上传是 dev 门控
TEST_DRAG 专属，T20），上传基线不可 UI 驱动——登记为限制；G5 对比采用同协议下载。
仪表下限：文件尺寸轮询 100ms；吞吐为估计值。
"""

import argparse
import hashlib
import json
import os
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
LOCAL = os.path.expanduser("~/Downloads/p4_100mb.bin")
EXPECT_SHA = "125af9fabbe7bbb690cc253e68341794ece9e92dfedb994611c32c606e69e7ce"
SIZE = 104857600


def main_window():
    wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, 0)
    for w in wl:
        if "tinyssh" in (w.get("kCGWindowOwnerName") or "").lower():
            b = w.get("kCGWindowBounds")
            if b and int(b["Width"]) == 1280 and int(b["Height"]) == 800:
                return int(b["X"]), int(b["Y"])
    return None, None


def one_run(ix, iy, idx, switch=False):
    if os.path.exists(LOCAL):
        os.remove(LOCAL)
    keyguard.verify()  # 每次键/点击事件前双核验（R04 §5.1 事故护栏）
    subprocess.run(["python3", EV, "click", str(ix), str(iy)], capture_output=True)
    time.sleep(0.3)
    keyguard.verify()
    subprocess.run(["python3", EV, "text", "/root/p4_100mb.bin"], capture_output=True)
    time.sleep(0.3)
    t0 = time.monotonic()
    keyguard.verify()
    subprocess.run(["python3", EV, "key", "36"], capture_output=True)  # Return
    # 轮询本地文件直至稳定
    last, stable, t_first = -1, 0, None
    deadline = time.monotonic() + 300
    switched = 0
    while time.monotonic() < deadline:
        try:
            sz = os.path.getsize(LOCAL)
        except OSError:
            sz = -1
        if sz >= 0:
            if t_first is None:
                t_first = time.monotonic()
            if sz == last and sz >= SIZE:
                break
            stable = stable + 1 if sz == last else 0
            last = sz
        if switch and switched < 5 and t_first is not None and sz > 0 and sz < SIZE:
            keyguard.verify()
            subprocess.run(["python3", EV, "key", "19" if switched % 2 == 0 else "18", "cmd"],
                           capture_output=True)
            switched += 1
        time.sleep(0.1)
    dur = time.monotonic() - t0
    r = {"idx": idx, "wall_s": round(dur, 2),
         "throughput_mbs": round(SIZE / 1048576 / dur, 1) if dur > 0 else None,
         "switches_during": switched}
    if os.path.exists(LOCAL) and os.path.getsize(LOCAL) == SIZE:
        h = hashlib.sha256(open(LOCAL, "rb").read()).hexdigest()
        r["sha_ok"] = h == EXPECT_SHA
    else:
        r["sha_ok"] = False
        r["fail"] = f"size={os.path.getsize(LOCAL) if os.path.exists(LOCAL) else 'missing'}"
    if switch and switched:
        # 传完切回 ssh 标签，保证下一轮焦点正确
        keyguard.verify()
        subprocess.run(["python3", EV, "key", "18", "cmd"], capture_output=True)
        time.sleep(0.5)
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ix", type=int, required=True, help="按路径下载输入框 屏幕X")
    ap.add_argument("--iy", type=int, required=True, help="按路径下载输入框 屏幕Y")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--out", default="/tmp/r4_p3/p4_download.json")
    args = ap.parse_args()
    import sqlite3
    conn = sqlite3.connect(ENV["TINYSSH_DB"])
    host_id = conn.execute(
        "SELECT id FROM hosts WHERE address='127.0.0.1' AND port=2222").fetchone()[0]
    conn.close()
    proc = subprocess.Popen([BIN], env={**ENV, "TINYSSH_AUTOCONNECT": host_id},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(6)
    keyguard.activate_and_verify()
    runs = [one_run(args.ix, args.iy, i + 1, switch=(i >= 1)) for i in range(args.runs)]
    for r in runs:
        print(r, flush=True)
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
    ok = [r["throughput_mbs"] for r in runs if r.get("sha_ok")]
    summary = {"runs": runs,
               "throughput_mbs": {"n": len(ok),
                                  "median": round(statistics.median(ok), 1) if ok else None,
                                  "min": min(ok) if ok else None, "max": max(ok) if ok else None},
               "expect_sha256": EXPECT_SHA,
               "protocol": "UI path-download input -> local file size stable at 104857600; "
                           "keyguard (frontmost+on-screen) before every key/click event; "
                           "runs 2-5 include 5 Cmd+1/2 switches mid-transfer (P4 gate); "
                           "old release upload not UI-drivable (TEST_DRAG dev-gated) - registered limitation"}
    with open(args.out, "w") as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)
    print(f"== P4 download: n={len(ok)} median={summary['throughput_mbs']['median']}MB/s -> {args.out}")


if __name__ == "__main__":
    main()
