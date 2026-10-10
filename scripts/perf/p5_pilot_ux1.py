#!/usr/bin/env python3
"""UX-R1 G1 退出项：P5 有效归属试点（新框架，缩时协议登记）。

与交付 §4 全量协议的差异（试点登记，全量归 R51）：持续输出 5 分钟（非 30 分钟）、
单会话（非 10 会话）。B/E 口径一致：预热至缓存容量 → 停止输出 → 静置 60s →
60s 中位数 B；负载停止 → 静置 60s → 60s 中位数 E；增长 = (E-B)/B。
输出源：docker 容器 /root/.spew 开关（~1k 行/s × 80B），经真实 SSH 会话进
核心管线（终端模型/重放环/检查点）——全程零键注入、零 smoke 注入。
归属：memsample v4.1 差分法（S0 → 候选冻结 → 逐相位 fail-closed → 退出消失核验），
仪表有效性已经 rev-q05fix 签署关闭（2026-10-07-e2ebdc4-q05fix）；v4.1 = v4 + 两条
低危注记收口（干净报错，无测量语义变更）。
压力观测：vmstat_probe v1 与各相位**同频同步**采集（签署 §3 增补）——预热首点 P0 起，
warmup/B/load/E 各相位 5s/点；整轮裁决按预登记判据 I1–I8（增长类 I2/I3/I4 逐相位相对
P0 基线取最大增量；缺字段/缺基线/采集子进程非 0 一律不可判），任一触发则**整轮不可判**。
"""

import argparse
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BIN = REPO / "target/release/tinyssh-app"
MEMSAMPLE = REPO / "scripts/perf/memsample.py"
VMSTAT = REPO / "scripts/perf/vmstat_probe.py"
DOCKER = ["docker", "exec", "tinyssh-e2e", "sh", "-c"]


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw).stdout


def docker_sh(c):
    return subprocess.run(DOCKER + [c], capture_output=True, text=True).stdout


def spew(on: bool):
    docker_sh("touch /root/.spew" if on else "rm -f /root/.spew")


def sshd_banner_ready(timeout: int) -> bool:
    """预探共享 sshd：读到 SSH banner 才算就绪（TCP 可连不等于会话子系统可用，
    testbed::await_sshd_ready 同口径）。"""
    import socket
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        try:
            s = socket.create_connection(("127.0.0.1", 2222), timeout=2)
            s.settimeout(2)
            banner = s.recv(8)
            s.close()
            if banner.startswith(b"SSH-"):
                time.sleep(0.3)
                return True
        except OSError:
            pass
        time.sleep(0.5)
    return False


def wait_connected(db: str, hid: str, since_ms: int, timeout: int) -> bool:
    """只认本 run 新建（created_at > 启动前快照）的 connected 行。
    被杀 app 会留僵尸 connected 行（不写 closed），绝对计数会跳变不可用。"""
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        out = sh(f"sqlite3 {db} \"SELECT COUNT(*) FROM sessions WHERE host_id='{hid}' AND state='connected' AND created_at > {since_ms};\"").strip()
        if out and int(out) >= 1:
            return True
        time.sleep(2)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True, help="已播种可信主机的 DB（host 经 wire 建档、指纹已信任）")
    ap.add_argument("--host-id", required=True)
    ap.add_argument("--workdir", default="/tmp/p5ux1")
    ap.add_argument("--warm-sec", type=int, default=150)
    ap.add_argument("--load-sec", type=int, default=300)
    args = ap.parse_args()
    work = Path(args.workdir)
    work.mkdir(parents=True, exist_ok=True)
    env_prefix = f"TINYSSH_MASTER_KEY=$(python3 -c \"print('07'*32)\") TINYSSH_DB={args.db} TINYSSH_AUTOCONNECT={args.host_id}"

    def run(cmd):
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        return r.returncode, r.stdout.strip(), r.stderr.strip()

    log = []
    press_rcs = {}  # 各相位压力采集子进程退出码——非 0 即该相位无观测，整轮不可判

    def note(msg):
        print(msg, flush=True)
        log.append(msg)

    spew(False)
    note(f"[0] .spew 关闭确认: {docker_sh('ls /root/.spew 2>/dev/null || echo off').strip()}")
    since_ms = int(sh(f"sqlite3 {args.db} \"SELECT COALESCE(MAX(created_at),0) FROM sessions;\"").strip() or 0)

    # ① S0 快照（应用启动前系统 WebKit 全集）
    pre = sh("pgrep -x tinyssh-app").strip()
    if pre:
        note(f"FAIL: 启动前已有 tinyssh-app 实例存活 pid={pre.split()}——先清理再跑，避免 pgrep 绑定错实例")
        return finish(work, log, 2)
    code, out, err = run(f"python3 {MEMSAMPLE} snapshot --out {work}/s0.json")
    note(f"[1] snapshot rc={code} {out} {err}")
    if code != 0:
        return finish(work, log, 2)

    # ② 启动应用（纯 AUTOCONNECT，零注入）+ 候选冻结
    if not sshd_banner_ready(30):
        note("FAIL: 共享 sshd banner 30s 未就绪")
        return finish(work, log, 2)
    subprocess.Popen(f"{env_prefix} {BIN} > {work}/app-stderr.log 2>&1", shell=True,
                     env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(Path.home())})
    time.sleep(3)
    app_pid = sh("pgrep -x tinyssh-app | head -1").strip()
    if not app_pid:
        note("FAIL: 应用未启动")
        return finish(work, log, 2)
    note(f"[2] 应用 pid={app_pid}")
    if not wait_connected(args.db, args.host_id, since_ms, 150):
        note("FAIL: SSH 会话 150s 未 Connected")
        subprocess.run(f"kill -TERM {app_pid}", shell=True)
        return finish(work, log, 2)
    note("[3] 会话 Connected（真实 sshd，指纹已信任直连）")
    code, out, err = run(f"python3 {MEMSAMPLE} candidates --s0 {work}/s0.json --out {work}/cands.json")
    note(f"[4] candidates rc={code} {out} {err}")
    if code != 0:
        subprocess.run(f"kill -TERM {app_pid}", shell=True)
        return finish(work, log, 2)

    # ③ 预热（输出进管线填满重放环等缓存）→ 停 → 静置 60s → B
    #    压力观测自预热首点起，与各相位同频同步（P0 = 预热前基线）
    code, out, err = run(f"python3 {VMSTAT} point --phase P0 --out {work}/press_P0.json")
    note(f"[5a] 压力基线 P0 rc={code} {out} {err}")
    press_warm = subprocess.Popen(
        f"python3 {VMSTAT} series --phase warmup --interval 5 --duration {args.warm_sec} "
        f"--out {work}/press_warmup.json", shell=True)
    spew(True)
    note(f"[5] 预热输出 {args.warm_sec}s")
    time.sleep(args.warm_sec)
    spew(False)
    press_warm.wait()
    press_rcs["warmup"] = press_warm.returncode
    note(f"[5b] 预热压力序列 rc={press_warm.returncode}")
    note("[6] 停止预热输出，静置 60s")
    time.sleep(60)
    press_B = subprocess.Popen(
        f"python3 {VMSTAT} series --phase B --interval 5 --duration 60 "
        f"--out {work}/press_B.json", shell=True)
    code, out, err = run(f"python3 {MEMSAMPLE} record --app-pid {app_pid} --cands {work}/cands.json "
                         f"--s0 {work}/s0.json --phase B --duration 60 --interval 5 --out {work}/B.json")
    press_B.wait()
    press_rcs["B"] = press_B.returncode
    note(f"[7] B rc={code} {out} {err}（压力序列 rc={press_B.returncode}）")
    if code != 0:
        subprocess.run(f"kill -TERM {app_pid}", shell=True)
        return finish(work, log, 2)

    # ④ 正式负载 5min → 停 → 静置 60s → E
    press_load = subprocess.Popen(
        f"python3 {VMSTAT} series --phase load --interval 5 --duration {args.load_sec} "
        f"--out {work}/press_load.json", shell=True)
    spew(True)
    note(f"[8] 正式负载 {args.load_sec}s")
    time.sleep(args.load_sec)
    spew(False)
    press_load.wait()
    press_rcs["load"] = press_load.returncode
    note(f"[8b] 负载压力序列 rc={press_load.returncode}")
    note("[9] 停止负载，静置 60s")
    time.sleep(60)
    press_E = subprocess.Popen(
        f"python3 {VMSTAT} series --phase E --interval 5 --duration 60 "
        f"--out {work}/press_E.json", shell=True)
    code, out, err = run(f"python3 {MEMSAMPLE} record --app-pid {app_pid} --cands {work}/cands.json "
                         f"--s0 {work}/s0.json --phase E --duration 60 --interval 5 --out {work}/E.json")
    press_E.wait()
    press_rcs["E"] = press_E.returncode
    note(f"[10] E rc={code} {out} {err}（压力序列 rc={press_E.returncode}）")
    if code != 0:
        subprocess.run(f"kill -TERM {app_pid}", shell=True)
        return finish(work, log, 2)

    # ⑤ 应用退出 + 归属核验（PID 精确杀——按名 pkill 可能误杀非本 run 实例）
    subprocess.run(f"kill -TERM {app_pid}", shell=True)
    for _ in range(30):
        if not sh("pgrep -x tinyssh-app").strip():
            break
        time.sleep(1)
    time.sleep(3)
    code, out, err = run(f"python3 {MEMSAMPLE} verify --cands {work}/cands.json")
    note(f"[11] verify rc={code} {out} {err}")

    # ⑥ 压力观测整轮裁决（预登记判据 I1–I8；任一触发 → 整轮不可判）
    #    workdir 跨轮复用，先删旧裁决文件——否则裁决崩溃时会读到上一轮的陈旧「可判」。
    (work / "pressure-verdict.json").unlink(missing_ok=True)
    code_p, out_p, err_p = run(
        f"python3 {VMSTAT} verdict "
        f"--points {work}/press_P0.json {work}/press_warmup.json {work}/press_B.json "
        f"{work}/press_load.json {work}/press_E.json "
        f"--memsample {work}/B.json {work}/E.json --out {work}/pressure-verdict.json")
    note(f"[12] 压力裁决 rc={code_p} {out_p} {err_p}")
    try:
        pressure = json.load(open(work / "pressure-verdict.json"))
    except (OSError, ValueError) as e:
        note(f"FAIL: 压力裁决产物不可读（{type(e).__name__}: {e}）——整轮不可判")
        return finish(work, log, 2)

    B = json.load(open(work / "B.json"))
    E = json.load(open(work / "E.json"))
    b, e = B.get("median_mb"), E.get("median_mb")
    growth = round((e - b) / b, 4) if b and e else None
    attribution_valid = B["voided"] is False and E["voided"] is False and code == 0
    # 压力序列子进程退出码非 0 = 该相位无观测；裁决进程非 0 且非「判为不可判」的 2
    # 之外一律按不可判处理（此处 code_p 只可能为 0/2，2 已被 invalid 覆盖）。
    pressure_rc_ok = all(rc == 0 for rc in press_rcs.values())
    pressure_valid = (not pressure["invalid"]) and pressure_rc_ok
    result = {
        "sampler": "memsample v4.1 (differential attribution, fail-closed)",
        "pressure_probe": "vmstat_probe v1 (read-only, synchronized; I1–I8)",
        "pilot": "UX-R1 new-framework P5 attribution pilot (reduced protocol: 5min load, 1 session; full protocol deferred to R51)",
        "app_pid": app_pid,
        "candidates": json.load(open(work / "cands.json")),
        "B_median_mb": b, "E_median_mb": e,
        "growth_ratio": growth,
        "B_voided": B["voided"], "E_voided": E["voided"],
        "verify_exit": code, "verify_output": out or err,
        "attribution_valid": attribution_valid,
        "pressure_valid": pressure_valid,
        "pressure_series_rc": press_rcs,
        "pressure_verdict": pressure,
        "round_valid": attribution_valid and pressure_valid,
        "protocol_log": log,
        "note": "试点主张=归属有效性（候选全生命周期存活/身份一致/退出消失/无未知进程）"
                f"+压力条件{pressure['verdict']}"
                f"（预登记判据 I1–I8；各相位压力采集 rc={press_rcs}）；"
                "growth 为观测量非门限判定（≤20% 与末段趋势归 R51 全量协议）",
    }
    (work / "pilot-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: result[k] for k in ("B_median_mb", "E_median_mb", "growth_ratio",
                                             "attribution_valid", "pressure_valid",
                                             "round_valid", "verify_exit")}, ensure_ascii=False))
    return 0 if result["round_valid"] else 2


def finish(work, log, code):
    (work / "pilot-result.json").write_text(json.dumps(
        {"log": log, "attribution_valid": False, "pressure_valid": False,
         "round_valid": False}, ensure_ascii=False, indent=1) + "\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
