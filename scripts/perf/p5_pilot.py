#!/usr/bin/env python3
"""UX-R1 P5 内存试点（旧版基线，缩时协议）。

与交付 §4 全量协议的差异（试点登记）：持续输出 5 分钟（非 30 分钟）、单会话
（非 10 会话）。B/E 采样口径一致：预热后静置 60s 取 60s 中位数 B；测试后静置
60s 取 60s 中位数 E；增长 = (E-B)/B。全量协议归 R51。

输出源：容器 /root/.bashrc 挂 /root/.spew 开关（存在即循环输出 ~80 字节行），
AUTOCONNECT 会话自动喷发——全程零键注入。归属：差分法（S0 → 候选 → 退出消失核验）。
"""

import json
import statistics
import subprocess
import time

BIN = "/Users/chenpu/workspace/claude-code/TinySSH/target/release/tinyssh-app"
ENV = {"TINYSSH_MASTER_KEY": "07" * 32, "TINYSSH_DB": "/tmp/r4_p3/tinyssh.db",
       "TINYSSH_AUTOCONNECT": "", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
DOCKER = ["docker", "exec", "tinyssh-e2e"]


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout


def app_rss_mb(pid):
    v = sh(f"ps -o rss= -p {pid}").strip()
    return int(v) if v else 0


def webkit_pids():
    out = {}
    for line in sh("ps axo pid=,rss=,comm=").splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and "com.apple.WebKit" in parts[2]:
            out[int(parts[0])] = int(parts[1])
    return out


def sample_mb(app_pid, cand):
    return (app_rss_mb(app_pid) + sum(webkit_pids().get(p, 0) for p in cand)) / 1024


def phase_median(app_pid, cand, label):
    """静置 60s 后采 60s、每 5s 一次的中位数。"""
    print(f"[{label}] 静置 60s…", flush=True)
    time.sleep(60)
    vals = []
    for i in range(12):
        vals.append(sample_mb(app_pid, cand))
        time.sleep(5)
    med = round(statistics.median(vals), 1)
    print(f"[{label}] 中位数 {med} MB（{len(vals)} 样本）", flush=True)
    return med, vals


def main():
    out = "/tmp/r4_p3/p5_pilot.json"
    import sqlite3
    conn = sqlite3.connect(ENV["TINYSSH_DB"])
    host_id = conn.execute(
        "SELECT id FROM hosts WHERE address='127.0.0.1' AND port=2222").fetchone()[0]
    conn.close()
    s0 = set(webkit_pids())
    proc = subprocess.Popen([BIN], env={**ENV, "TINYSSH_AUTOCONNECT": host_id},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(8)  # 建连 + 首个提示符
    cand = set(webkit_pids()) - s0
    if not cand:
        proc.kill()
        raise SystemExit("no candidate helpers — attribution failed")
    print(f"候选辅助进程 {sorted(cand)}", flush=True)
    # 预热：喷发 60s 填满 scrollback/lossless 缓存
    subprocess.run(DOCKER + ["touch", "/root/.spew"])
    print("[warmup] 喷发 60s…", flush=True)
    time.sleep(60)
    subprocess.run(DOCKER + ["rm", "-f", "/root/.spew"])
    b, bvals = phase_median(proc.pid, cand, "B")
    # 正式：5 分钟持续输出
    subprocess.run(DOCKER + ["touch", "/root/.spew"])
    print("[test] 持续输出 300s…", flush=True)
    curve = []
    t0 = time.monotonic()
    while time.monotonic() - t0 < 300:
        curve.append({"t": round(time.monotonic() - t0), "mb": round(sample_mb(proc.pid, cand), 1)})
        time.sleep(30)
    subprocess.run(DOCKER + ["rm", "-f", "/root/.spew"])
    e, evals = phase_median(proc.pid, cand, "E")
    growth = round((e - b) / b * 100, 1) if b else None
    # 退出核验
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
    time.sleep(3)
    residue = cand & set(webkit_pids())
    result = {"B_median_mb": b, "B_samples": bvals, "E_median_mb": e, "E_samples": evals,
              "growth_pct": growth, "curve_30s": curve,
              "attribution": {"candidates": sorted(cand), "residue_after_quit": sorted(residue)},
              "protocol": "PILOT: 5min sustained (full 30min at R51); single session; "
                          "B/E = 60s settle + 12x5s median; differential attribution",
              "verdict_note": "growth > 20% or residue non-empty → investigate; "
                              "末段持续上升另按 10 分钟窗口口径在 R51 判定"}
    with open(out, "w") as f:
        json.dump(result, f, indent=1, ensure_ascii=False)
    print(f"== P5 pilot: B={b}MB E={e}MB growth={growth}% residue={len(residue)} -> {out}")


if __name__ == "__main__":
    main()
