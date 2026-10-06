#!/usr/bin/env python3
"""UX-R1 P3 建连采样（旧版基线）。

主指标：spawn → "[app] autoconnect <host> -> <sid>"（stderr）总时长，30 次。
口径限制：应用内相位分解（TCP/认证/PTY/集成等待）在未修改的旧版上无日志点，
不可分解；新旧版本使用同一 spawn→connected 协议对比（P3 门公平性成立）。
前置：P3 DB 已由 bootstrap 完成密钥导入与 TOFU 信任（--bootstrap 一次）。
"""

import argparse
import json
import re
import statistics
import subprocess
import time

BIN = "/Users/chenpu/workspace/claude-code/TinySSH/target/release/tinyssh-app"
BASE_ENV = {"TINYSSH_MASTER_KEY": "07" * 32,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}


def wait_stderr_line(path, ok_re, fail_re, deadline_s):
    """轮询 stderr 文件（Popen stderr=FILE），自记录偏移起逐行匹配。

    返回 {"t": 单调秒, "sid": str, "raw": 原文行}（成功）或
    {"fail": True, "raw": 原文行}（失败行）；超时返回 None。
    成功与失败形态都显式识别（Q-01：两种形态都含 'autoconnect' 字样）。
    """
    start = time.monotonic()
    pos = 0
    tail = ""
    while time.monotonic() - start < deadline_s:
        try:
            with open(path, "rb") as f:
                f.seek(pos)
                chunk = f.read().decode("utf-8", "replace")
                pos = f.tell()
        except FileNotFoundError:
            chunk = ""
        tail += chunk
        while "\n" in tail:
            line, tail = tail.split("\n", 1)
            m = ok_re.match(line.strip())
            if m:
                return {"t": time.monotonic(), "sid": m.group(2), "raw": line.strip()}
            f = fail_re.match(line.strip())
            if f:
                return {"fail": True, "raw": line.strip()}
        time.sleep(0.005)
    return None


def bootstrap(db, key_path):
    """跑一次 T40 SMOKE 全流：导入密钥 → 信任 → 保存并连接。产物：已信任主机。"""
    import os
    env = {**BASE_ENV, "TINYSSH_DB": db, "TINYSSH_SMOKE": "1",
           "TINYSSH_SMOKE_KEY": key_path}
    with open("/tmp/r4_p3/boot_stderr.log", "wb") as errf:
        proc = subprocess.Popen([BIN], env=env, stdout=subprocess.DEVNULL, stderr=errf)
        try:
            rc = proc.wait(120)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(5)
            raise SystemExit("bootstrap smoke flow timed out; killed orphan")
    out = open("/tmp/r4_p3/boot_stderr.log").read()
    ok = "FAIL" not in out and "autoconnect" not in out  # SMOKE 流不走 autoconnect
    import sqlite3
    conn = sqlite3.connect(db)
    row = conn.execute(
        "SELECT id FROM hosts WHERE address='127.0.0.1' AND port=2222").fetchone()
    conn.close()
    print(f"bootstrap rc={rc} smoke_ok={ok} host_id={row[0] if row else None}")
    return row[0] if row else None


def run_once(host_id, idx):
    env = {**BASE_ENV, "TINYSSH_DB": "/tmp/r4_p3/tinyssh.db",
           "TINYSSH_AUTOCONNECT": host_id}
    err_path = f"/tmp/r4_p3/run_{idx}.err"
    # 成功判定（Q-01）：必须是「目标主机 -> 有效 sid」形态；失败行单独识别并保存原文。
    ok_re = re.compile(rf"^\[app\] autoconnect ({re.escape(host_id)}) -> (s-[0-9a-f-]{{36}})$")
    fail_re = re.compile(r"^\[app\] autoconnect (\S+) failed: (.+)$")
    with open(err_path, "wb") as errf:
        t0 = time.monotonic()
        proc = subprocess.Popen([BIN], env=env, stdout=subprocess.DEVNULL, stderr=errf)
        line = wait_stderr_line(err_path, ok_re, fail_re, 30)
        result = {"idx": idx, "pid": proc.pid}
        if line is None:
            result["fail"] = "timeout: no success/failure line in 30s"
        elif line.get("fail"):
            result["fail"] = f"autoconnect failed: {line['raw']}"
        else:
            result["total_ms"] = round((line["t"] - t0) * 1000)
            result["sid"] = line["sid"]
            result["matched_line"] = line["raw"]
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
            result["forcekill"] = True
        return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bootstrap", action="store_true")
    ap.add_argument("--runs", type=int, default=30)
    ap.add_argument("--out", default="/tmp/r4_p3/p3.json")
    args = ap.parse_args()
    subprocess.run(["mkdir", "-p", "/tmp/r4_p3"], check=True)
    db = "/tmp/r4_p3/tinyssh.db"
    if args.bootstrap:
        host_id = bootstrap(db, "/tmp/smoke_key")
        if not host_id:
            raise SystemExit("bootstrap failed")
        return
    import sqlite3
    conn = sqlite3.connect(db)
    row = conn.execute(
        "SELECT id FROM hosts WHERE address='127.0.0.1' AND port=2222").fetchone()
    conn.close()
    if not row:
        raise SystemExit("P3 host not found; run --bootstrap first")
    runs = [run_once(row[0], i + 1) for i in range(args.runs)]
    for r in runs:
        print(r, flush=True)
    ok = [r["total_ms"] for r in runs if "total_ms" in r]
    summary = {"runs": runs,
               "total": {"n": len(ok),
                         "median_ms": round(statistics.median(ok)) if ok else None,
                         "p95_ms": round(statistics.quantiles(ok, n=20, method="inclusive")[18]) if len(ok) >= 2 else None,
                         "min_ms": min(ok) if ok else None, "max_ms": max(ok) if ok else None},
               "protocol": "spawn -> stderr [app] autoconnect line; pre-trusted key host 127.0.0.1:2222; "
                           "in-app phases not decomposable in unmodified baseline (registered)"}
    with open(args.out, "w") as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)
    print(f"== P3: n={len(ok)} median={summary['total']['median_ms']}ms "
          f"p95={summary['total']['p95_ms']}ms -> {args.out}")


if __name__ == "__main__":
    main()
