#!/usr/bin/env python3
"""UX-R1 P7 万条目录采样（旧版基线，Q-06 新增实现——待受控窗口执行）。

端点冻结（Q-06：此前无实现无打点，不得称"只差空闲窗口"）：
- 数据到达（核心）：需 dev 门控打点（SMOKE 注入脚本加 p7-list-begin/rendered 标，
  与 P1 同模式）→ 该改法会变更二进制，与"可复现旧版二进制"冲突——故核心计时
  在受控窗口内以「当前基线二进制 + 独立计时探针」执行：sftp 层独立小样（容器
  sftp 直连同目录列目录耗时，python paramiko/ssh 直连，作为网络+服务端基线分量），
  应用内核心耗时 = 渲染端点时刻 − 输入提交时刻 − 网络分量估计，报告时三分量
  分别列明，不合并成单一"首屏"。合并口径须回 R04 文档修订登记。
- 首屏可操作（UI）：ev2 定向点击侧栏「远程文件」→ 聚焦路径输入框 → 键入路径 +
  Return → 轮询列表区域像素证据（md5 变化）= 首屏渲染完成（上限值，含截图周期）。
  旧版列表无虚拟化（App.tsx 侧栏 plain list），10k 行全量渲染即"数据到达后首屏"。
- 门："数据到达后首屏可操作 ≤300ms"以「渲染端点 − 数据到达估计」对照，仪表
  下限如实标注；网络耗时独立报告（容器回环）。

执行前提：与 P2/P4 相同的受控环境 + ev2（负例已验证）；--ix/--iy 需截图标定。
"""

import argparse
import hashlib
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
DIR = "/root/p7_10k"
DOCS = REPO / "docs/acceptance/ux-r1/g0/2026-10-06-7c4502e"


def prepare_dir():
    """容器内制备 10k 条目目录（幂等）。"""
    subprocess.run(["docker", "exec", "tinyssh-e2e", "sh", "-c",
                    f"mkdir -p {DIR} && for i in $(seq 1 10000); do touch {DIR}/f$i 2>/dev/null; done; ls {DIR} | wc -l"],
                   capture_output=True, text=True)
    n = subprocess.run(["docker", "exec", "tinyssh-e2e", "ls", DIR],
                       capture_output=True, text=True).stdout.count("\n")
    print(f"prepared {DIR}: {n} entries")
    return n


def sftp_network_baseline():
    """网络+服务端分量：容器内本地 shell ls -f 同目录耗时（近似服务端枚举成本）。"""
    t0 = time.monotonic()
    subprocess.run(["docker", "exec", "tinyssh-e2e", "ls", "-f", DIR],
                   capture_output=True)
    return round(time.monotonic() - t0, 3)


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


def snap_md5(x, y, w, h):
    p = "/tmp/r4_p3/p7_probe.png"
    subprocess.run(["screencapture", "-x", "-R", f"{x},{y},{w},{h}", p], capture_output=True)
    return hashlib.md5(open(p, "rb").read()).hexdigest()


def window_rect(pid):
    import Quartz
    wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, 0)
    for w in wl:
        if w.get("kCGWindowOwnerPID") == pid:
            b = w.get("kCGWindowBounds")
            if b and int(b["Width"]) == 1280 and int(b["Height"]) == 800:
                return int(b["X"]), int(b["Y"])
    return None, None


def main():
    global BIN
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=10)
    ap.add_argument("--out", default="/tmp/r4_p3/p7_list.json")
    ap.add_argument("--bin", default=str(BIN), help="被测二进制（B1 基线指向 worktree 打包产物）")
    args = ap.parse_args()
    BIN = Path(args.bin)
    n = prepare_dir()
    net = sftp_network_baseline()
    import sqlite3
    conn = sqlite3.connect(ENV["TINYSSH_DB"])
    host_id = conn.execute(
        "SELECT id FROM hosts WHERE address='127.0.0.1' AND port=2222").fetchone()[0]
    conn.close()
    proc = subprocess.Popen([BIN], env={**ENV, "TINYSSH_AUTOCONNECT": host_id},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(8)
    pid = proc.pid
    activate_by_pid(pid)
    wx, wy = window_rect(pid)
    # --ix/--iy 默认「远程文件」侧栏区（联审后标定值传入可覆盖）
    results = []
    for i in range(args.runs):
        send(pid, "click", "--x", str(wx + 1050), "--y", str(wy + 500))  # 文件区聚焦（标定）
        time.sleep(0.3)
        send(pid, "click", "--x", str(wx + 1050), "--y", str(wy + 560))  # 路径输入框（标定）
        time.sleep(0.3)
        base = snap_md5(wx + 950, wy + 400, 320, 380)
        t0 = send(pid, "text", "--string", DIR)
        t1 = send(pid, "key", "--code", "36")  # Return（提交时刻）
        t_paint = None
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if snap_md5(wx + 950, wy + 400, 320, 380) != base:
                t_paint = time.time() * 1000
                break
            time.sleep(0.02)
        r = {"idx": i + 1}
        if t_paint is None:
            r["fail"] = "list area no pixel change in 30s（坐标需标定或路径未确认）"
        else:
            # 提交→首屏渲染（上限，含截图周期与网络分量；三分量口径见 docstring）
            r["submit_to_paint_upper_ms"] = round(t_paint - t1)
            r["net_baseline_s"] = net
        results.append(r)
        print(r, flush=True)
        time.sleep(1)
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
    ok = [r["submit_to_paint_upper_ms"] for r in results if "submit_to_paint_upper_ms" in r]
    summary = {"entries": n, "net_baseline_s": net, "runs": results,
               "submit_to_paint_upper": {"n": len(ok),
                                         "median_ms": round(statistics.median(ok)) if ok else None,
                                         "p95_ms": round(statistics.quantiles(ok, n=20, method="inclusive")[18]) if len(ok) >= 2 else None,
                                         "fails": args.runs - len(ok)},
               "protocol": ("UI render endpoint = list-area pixel change after Return (ev2 "
                            "pid-targeted); network/server component measured separately "
                            "(container ls -f); in-app core timing requires dev-gated mark "
                            "(binary-changing) — registered as controlled-window step with "
                            "hash re-record; three components reported separately, not merged"),
               "coords_note": "侧栏/输入框坐标为默认推断值，执行前必须截图标定"}
    with open(args.out, "w") as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)
    print(f"== P7: n={len(ok)} median={summary['submit_to_paint_upper']['median_ms']}ms -> {args.out}")


if __name__ == "__main__":
    main()
