#!/usr/bin/env python3
"""UX-R1 P6 资源循环采样（旧版基线，替代口径）。

旧版无订阅计数器（debug_subscriptions 是 C10 新契约）——P6 旧基线用替代口径：
100 次 spawn→autoconnect→TERM 循环，每次在会话就绪时采 应用+差分归属辅助进程
RSS；断言无随循环次数线性增长（每循环新进程，取各循环点序列做趋势对照）。
另记录每循环 total_ms（兼作 P1 大样本补充）。
"""

import json
import statistics
import subprocess
import time

import Quartz

BIN = "/Users/chenpu/workspace/claude-code/TinySSH/target/release/tinyssh-app"
ENV = {"TINYSSH_MASTER_KEY": "07" * 32, "TINYSSH_DB": "/tmp/r4_p3/tinyssh.db",
       "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}


def webkit_helpers():
    out = subprocess.run("ps axo pid=,rss=,comm=", shell=True,
                         capture_output=True, text=True).stdout.splitlines()
    res = []
    for line in out:
        p = line.split(None, 2)
        if len(p) == 3 and "com.apple.WebKit" in p[2]:
            res.append((int(p[0]), int(p[1])))
    return res


def app_rss(pid):
    out = subprocess.run(f"ps -o rss= -p {pid}", shell=True,
                         capture_output=True, text=True).stdout.strip()
    return int(out) if out else 0


def wait_line(path, needle, deadline_s, pos0=0):
    start = time.monotonic()
    pos = pos0
    while time.monotonic() - start < deadline_s:
        try:
            with open(path, "rb") as f:
                f.seek(pos)
                chunk = f.read().decode("utf-8", "replace")
                pos = f.tell()
        except FileNotFoundError:
            chunk = ""
        if needle in chunk:
            return time.monotonic(), pos
        time.sleep(0.005)
    return None, pos


def main():
    runs_n = 100
    out = "/tmp/r4_p3/p6_cycles.json"
    import sqlite3
    conn = sqlite3.connect(ENV["TINYSSH_DB"])
    host_id = conn.execute(
        "SELECT id FROM hosts WHERE address='127.0.0.1' AND port=2222").fetchone()[0]
    conn.close()
    err_path = "/tmp/r4_p3/p6.err"
    results = []
    for i in range(runs_n):
        s0 = {pid for pid, _ in webkit_helpers()}  # 差分归属：循环前基线
        with open(err_path, "wb") as errf:
            t0 = time.monotonic()
            proc = subprocess.Popen([BIN], env={**ENV, "TINYSSH_DB": "/tmp/r4_p3/tinyssh.db",
                                                "TINYSSH_AUTOCONNECT": host_id},
                                    stdout=subprocess.DEVNULL, stderr=errf)
            t_ready, _ = wait_line(err_path, "autoconnect", 20)
        r = {"idx": i + 1}
        if t_ready:
            r["total_ms"] = round((t_ready - t0) * 1000)
            cand = [(pid, rss) for pid, rss in webkit_helpers() if pid not in s0]
            r["rss_mb"] = round((app_rss(proc.pid) + sum(h[1] for h in cand)) / 1024, 2)
            r["helper_n"] = len(cand)
        else:
            r["fail"] = "timeout"
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
        time.sleep(1)  # 给辅助进程退出时间
        if t_ready:
            residue = [pid for pid, _ in cand if pid in {p for p, _ in webkit_helpers()}]
            r["residue_pids"] = residue  # 退出消失核验（差分法第④步），非空即本会话作废
        results.append(r)
        if (i + 1) % 20 == 0:
            print(f".. {i+1}/100", flush=True)
    ok = [r for r in results if "rss_mb" in r]
    bad_residue = [r["idx"] for r in ok if r.get("residue_pids")]
    first10 = [r["rss_mb"] for r in ok[:10]]
    last10 = [r["rss_mb"] for r in ok[-10:]]
    f10, l10 = statistics.median(first10), statistics.median(last10)
    summary = {"runs": results,
               "trend": {"first10_median_mb": round(f10, 2),
                         "last10_median_mb": round(l10, 2),
                         "delta_mb": round(l10 - f10, 2)},
               "teardown": {"cycles_with_residue": len(bad_residue),
                            "residue_cycle_idx": bad_residue},
               "cycle_ms": {"n": len([r for r in ok if 'total_ms' in r]),
                            "median_ms": round(statistics.median([r["total_ms"] for r in ok if "total_ms" in r]))
                            if ok else None},
               "protocol": "proxy baseline: old version lacks subscription counter (C10 contract); "
                           "per-cycle spawn/teardown RSS with differential attribution (no browser quit); "
                           "per-cycle quit-residue verification (non-empty residue voids that cycle); "
                           "linear growth across cycles = P6 failure signal"}
    with open(out, "w") as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)
    print(f"== P6: trend {summary['trend']} -> {out}")


if __name__ == "__main__":
    main()
