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
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

BIN = REPO / "target/release/tinyssh-app"
ENV = {"TINYSSH_MASTER_KEY": "07" * 32, "TINYSSH_DB": "/tmp/r4_p3/tinyssh.db",
       "TINYSSH_AUTOCONNECT": "", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
DOCKER = ["docker", "exec", "tinyssh-e2e"]


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout


def app_rss_mb(pid):
    """应用 RSS；进程不存在返回 None（fail-closed：与候选同等待遇，Q-05 补全）。"""
    v = sh(f"ps -o rss= -p {pid}").strip()
    return int(v) if v else None


def lstart_map():
    return {int(l.split()[0]): l.split(None, 3)[2] + " " + l.split(None, 3)[3].strip()
            for l in sh("ps axo pid=,lstart=,comm=").splitlines() if l.strip()}


def webkit_pids():
    out = {}
    lst = lstart_map()
    for line in sh("ps axo pid=,rss=,comm=").splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and "com.apple.WebKit" in parts[2]:
            pid = int(parts[0])
            out[pid] = {"rss_kb": int(parts[1]), "lstart": lst.get(pid, "?")}
    return out


def sample(app_pid, cand, known=frozenset()):
    """返回 (total_mb, per_candidate_kb, broken_reason)。候选/应用消失、换身份或
    出现未知新 WebKit 进程 → broken（Q-05 漏计封口，known = S0 ∪ 候选）。"""
    cur = webkit_pids()
    per, broken = {}, None
    new_helpers = sorted(set(cur) - set(known))
    if new_helpers:
        broken = broken or f"new webkit helper(s) appeared mid-sample: {new_helpers}"
    app_kb = app_rss_mb(app_pid)
    if app_kb is None:
        broken = broken or f"app pid {app_pid} disappeared"
    for pid, ident in cand.items():
        h = cur.get(pid)
        if h is None:
            broken = broken or f"candidate {pid} disappeared"
            per[pid] = None
        elif h["lstart"] != ident["lstart"]:
            broken = broken or f"candidate {pid} lstart changed (PID reuse?)"
            per[pid] = None
        else:
            per[pid] = h["rss_kb"]
    if app_kb is None:
        return None, per, broken
    total = (app_kb + sum(v for v in per.values() if v)) / 1024
    return round(total, 2), per, broken


def phase_median(app_pid, cand, known, label):
    """静置 60s 后采 60s、每 5s 一次的中位数；逐样本记录每候选曲线；归属失效即作废。"""
    print(f"[{label}] 静置 60s…", flush=True)
    time.sleep(60)
    samples = []
    for i in range(12):
        total, per, broken = sample(app_pid, cand, known)
        samples.append({"t": i * 5, "total_mb": total, "per_candidate_kb": per,
                        "broken": broken})
        time.sleep(5)
    voided = next((s["broken"] for s in samples if s["broken"]), None)
    med = None if voided else round(statistics.median(s["total_mb"] for s in samples), 2)
    print(f"[{label}] " + (f"VOIDED: {voided}" if voided else f"中位数 {med} MB（{len(samples)} 样本）"),
          flush=True)
    return med, samples, voided


def main():
    out = "/tmp/r4_p3/p5_pilot.json"
    import sqlite3
    conn = sqlite3.connect(ENV["TINYSSH_DB"])
    host_id = conn.execute(
        "SELECT id FROM hosts WHERE address='127.0.0.1' AND port=2222").fetchone()[0]
    conn.close()
    s0 = webkit_pids()
    proc = subprocess.Popen([BIN], env={**ENV, "TINYSSH_AUTOCONNECT": host_id},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(8)  # 建连 + 首个提示符
    cand = {pid: h for pid, h in webkit_pids().items() if pid not in s0}
    known = frozenset(set(s0) | set(cand))
    if not cand:
        proc.kill()
        raise SystemExit("no candidate helpers — attribution failed")
    print(f"候选辅助进程 {sorted(cand)}（含 lstart 身份）", flush=True)
    # 预热：喷发 60s 填满 scrollback/lossless 缓存
    subprocess.run(DOCKER + ["touch", "/root/.spew"])
    print("[warmup] 喷发 60s…", flush=True)
    time.sleep(60)
    subprocess.run(DOCKER + ["rm", "-f", "/root/.spew"])
    b, bsamples, bvoid = phase_median(proc.pid, cand, known, "B")
    # 正式：5 分钟持续输出
    subprocess.run(DOCKER + ["touch", "/root/.spew"])
    print("[test] 持续输出 300s…", flush=True)
    curve = []
    curve_void = None
    t0 = time.monotonic()
    while time.monotonic() - t0 < 300:
        total, per, broken = sample(proc.pid, cand, known)
        curve_void = curve_void or broken
        curve.append({"t": round(time.monotonic() - t0), "mb": total,
                      "per_candidate_kb": per, "broken": broken})
        time.sleep(30)
    subprocess.run(DOCKER + ["rm", "-f", "/root/.spew"])
    e, esamples, evoid = phase_median(proc.pid, cand, known, "E")
    voided = bvoid or evoid or curve_void
    growth = round((e - b) / b * 100, 2) if (b and e and not voided) else None
    # 退出核验（含 lstart 身份/PID 复用检查）
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
    time.sleep(3)
    cur = webkit_pids()
    residue = sorted(p for p in cand if p in cur)
    reused = sorted(p for p, ident in cand.items()
                    for _pid, h in cur.items() if h["lstart"] == ident["lstart"])
    result = {"B_median_mb": b, "B_samples": bsamples, "E_median_mb": e, "E_samples": esamples,
              "growth_pct": growth, "voided": bool(voided), "void_reason": voided,
              "curve_30s": curve,
              "attribution": {"candidates": {str(p): v for p, v in cand.items()},
                              "residue_after_quit": residue, "identity_reuse": reused},
              "protocol": "PILOT (fail-closed attribution v3, Q-05): 5min sustained (full 30min "
                          "at R51); single session; B/E = 60s settle + 12x5s median; per-candidate "
                          "curves with lstart identity; disappearance/identity change/new webkit helper voids sample",
              "verdict_note": "voided=Any → 数据不作门证据; growth > 20% or residue/reuse → investigate; "
                              "末段持续上升另按 10 分钟窗口口径在 R51 判定"}
    with open(out, "w") as f:
        json.dump(result, f, indent=1, ensure_ascii=False)
    verdict = "VOIDED" if voided else f"residue={len(residue)}"
    print(f"== P5 pilot: B={b}MB E={e}MB growth={growth}% {verdict} -> {out}")


if __name__ == "__main__":
    main()
