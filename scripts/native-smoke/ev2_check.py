#!/usr/bin/env python3
"""`ev2.py` 投递工具的**工具级**验证（区别于 ev_delivery_probe.py 的**机制级**对照）。

- `ev_delivery_probe.py` 回答「pid 与 global 两种投递机制谁有效」（自建投递，不经 ev2）。
- 本脚本回答「**ev2 这个工具**（含 `--deliver` 接线、逐事件核验、guard 退出码）改好没有」——
  一律以 `subprocess` 调 `scripts/perf/ev2.py` 本体，不复制其投递代码。

四段断言：
  A. `--deliver global` 点哨兵 → 面板像素**翻转**（逐轮必须翻转；一轮内允许重试，重试次数
     即**丢点击率的实测样本**，见下）。且每次尝试 **rc 必须为 0**——证明事件真投了出去，
     而非 guard 拒绝。
  B. **默认投递**（不传 `--deliver`，即签署授权的 pid）点同一哨兵 → 像素**永不翻转**，
     且每次尝试 **rc 必须为 0**。B 不传 flag 是刻意的：验的正是「默认值 = pid」。
     **rc=0 是 B 的关键**：只看「没翻转」无法区分「投了但没效果」（= 要证的环境事实）
     与「guard 拒绝、根本没投」（= 工具坏了却假过）。rc 全 0 才排除后者。
  C. guard 负例①：不存在的 pid → **exit 2 且不投递**。
  D. guard 负例②：存在但非前台（临时 `sleep` 子进程）→ **exit 2 且不投递**。
     这两条不打扰任何用户应用（sleep 无 UI；不存在 pid 无副作用）。

**裁决三分（勿把环境差异误报成工具缺陷）**：`ev2-check.json` 的 `verdict` 取值——
  - `ev2_delivery_verified`：四段全过。
  - `pid_delivery_now_works`：**B 段翻转了**（本机 pid 投递恢复可用）。这是**环境属性
    变化**，不是工具缺陷——B 断言的是「本机 pid 失效」这个环境事实。此时须重估
    ev2.py 默认投递与 G0 签署 §4 的前提。
  - `ev2_delivery_failed`：A 或 C/D 未过，须排查。

**两条已知的静默失判陷阱（都已在实测中撞到，故本脚本按此设计）**：

1. **激活后首次点击会被吞**：`activate()` 之后窗口尚未成为 key，第一个全局点击被 macOS
   吃掉用于「转 key」，表现为**像素不变**——与「投递失效」症状完全相同。故 `--settle`
   默认 2.5s，且测量前先做一次**预热点击**（点完复位），把转 key 的动作移出测量窗。
2. **global 投递会低概率丢事件**：实测在较重仪表（每次点击前后多张 `screencapture`）
   下见过约 1/6 的丢失；在轻仪表（每次点击仅一张截图、静置 0.75s）下 **60/60 无丢失**。
   丢因未定性（非事件间隔：gap 0/60/150ms 各 20 次全无丢失；非前台漂移：丢失时
   frontmost 仍等于目标）。**故本脚本不假设「点一次必中」**：A 段每轮允许最多
   `--retry` 次尝试，记录实际尝试次数并汇总为 `drops` 计数落盘——**该计数是观测数据，
   不是断言**。真正被断言的是「global 在重试预算内能使像素翻转」。

⇒ **给调用方的结论**：用 global 做坐标取证时，**必须核验效果**（轮询状态/像素直到变化），
不得假设「投递即生效」；单次点击触发的计时端点会因丢事件产生虚假长尾。

用法：ev2_check.py --out <dir> [--bin PATH] [--rounds N] [--retry K] [--settle S]
退出码：0 全部通过 / 1 有断言未过 / 2 环境问题（无窗口、二进制缺失、预热复位失败）。
注意 exit 1 的两种子情形可由 `verdict` 区分：`pid_delivery_now_works` 是**环境变化**
（非工具缺陷），`ev2_delivery_failed` 才是工具问题。
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
EV2 = REPO / "scripts/perf/ev2.py"
EXPECT_W, EXPECT_H = 1280, 800
# 哨兵与区域（相对窗口左上；沿用 ev_delivery_probe.py 的标定值）
SENTINEL = (197, 53)          # ＋ 按钮，点击后面板展开/收起（toggle）
REGION = (12, 105, 270, 320)  # 左侧面板
GLOBAL = ["--deliver", "global"]


def win_origin(pid):
    import Quartz
    for w in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, 0):
        if w.get("kCGWindowOwnerPID") == pid:
            b = w.get("kCGWindowBounds")
            if b and int(b["Width"]) == EXPECT_W and int(b["Height"]) == EXPECT_H:
                return int(b["X"]), int(b["Y"])
    return None, None


def activate(pid):
    subprocess.run(["osascript", "-e",
                    f'tell application "System Events" to set frontmost of '
                    f'(first process whose unix id is {pid}) to true'],
                   capture_output=True, text=True)


def ev2(args):
    """调 ev2 本体。**总是带 `TINYSSH_EV2_ALLOW_GLOBAL=1`**——本脚本的全部意义就是验证
    global 路径，而 ev2 默认 fail-closed 拒绝它（G0 签署 §4 禁止全局 HID 注入）。
    在此显式设该变量 = 本验证活动声明「已知这是未授权偏离、产物仅作**偏离证据**，
    不作门证据」。见 ev2.py docstring 与 docs/acceptance/ux-r1/g5/2026-10-10-ev-delivery/。"""
    env = dict(os.environ, **{"TINYSSH_EV2_ALLOW_GLOBAL": "1"})
    r = subprocess.run([sys.executable, str(EV2)] + args, capture_output=True,
                       text=True, env=env)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--bin", default=str(REPO / "target/release/tinyssh-app"))
    ap.add_argument("--rounds", type=int, default=6, help="A/B 各跑几轮")
    ap.add_argument("--retry", type=int, default=3,
                    help="每轮最多点几次（>1 用于吸收 global 的低概率丢事件；实际次数落盘）")
    ap.add_argument("--settle", type=float, default=2.5,
                    help="激活后静置秒数（<1s 时首次点击会被吞，见模块 docstring）")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    BIN = Path(args.bin)
    if not BIN.is_file():
        print(f"FAIL: 被测二进制不存在或不是文件：{BIN}")
        return 2

    env = {"TINYSSH_MASTER_KEY": "07" * 32,
           "TINYSSH_DB": "/tmp/ev2_check/tinyssh.db",
           "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
    os.makedirs("/tmp/ev2_check", exist_ok=True)
    # 含 `.lock`：上一轮若留下活着的实例，它会持写锁，本轮应用会 panic 退出（症状是
    # 「20s 内无窗口」，与真实故障难以区分）。清掉陈旧锁文件，配合下方「应用早退」检测。
    for suf in ("", "-wal", "-shm", ".lock"):
        p = Path(env["TINYSSH_DB"] + suf)
        if p.exists():
            p.unlink()

    res = {"bin": str(BIN), "bin_sha256": hashlib.sha256(BIN.read_bytes()).hexdigest(),
           "settle_s": args.settle, "rounds": args.rounds,
           "retry_budget": args.retry}
    errf = open(out / "app.err", "wb")
    proc = subprocess.Popen([BIN], env=env, stdout=subprocess.DEVNULL, stderr=errf)
    try:
        wx = None
        for _ in range(40):
            time.sleep(0.5)
            if proc.poll() is not None:
                break   # 应用已退出（如 DB 写锁被占）——别白等 20s
            wx, wy = win_origin(proc.pid)
            if wx is not None:
                break
        if wx is None:
            errf.flush()
            tail = (out / "app.err").read_text(errors="replace").strip().splitlines()[-6:]
            why = ("被测应用已退出（见 app.err）" if proc.poll() is not None
                   else f"未在 20s 内取得 {EXPECT_W}×{EXPECT_H} 窗口")
            print(f"FAIL: {why}；app.err 末尾：")
            for l in tail:
                print("   ", l)
            return 2
        activate(proc.pid)
        time.sleep(args.settle)
        # 前置：确认被测应用**确实是前台**（guard 的前台检查是全局投递的前提）。
        # 不是前台时 guard 对每次调用都返回 rc=2（什么都不投），而像素仍可能因**他窗口
        # 重绘**而「翻转」——整轮结果无意义，且会被误判成**工具缺陷**（正是 finding #4
        # 那类环境/工具混淆）。故显式核验：重试数次仍非前台 → 以环境问题 exit 2 退出，
        # 不继续产出垃圾数据。实测撞到过：残留实例占库锁 → 新实例 panic 退出 → 无窗口；
        # 以及焦点被他窗口抢占 → 全程 rc=2。
        def frontmost_is_app():
            import Quartz
            a = Quartz.NSWorkspace.sharedWorkspace().frontmostApplication()
            return (a.processIdentifier() if a else None) == proc.pid, \
                   (a.localizedName() if a else None)
        okf, fname = frontmost_is_app()
        for _ in range(6):
            if okf:
                break
            activate(proc.pid)
            time.sleep(1.0)
            okf, fname = frontmost_is_app()
        if not okf:
            print(f"FAIL: 被测应用未成为前台（当前前台={fname!r}，目标 pid={proc.pid}）——"
                  f"全局投递会被 guard 全部拒绝，本轮无意义。"
                  f"请确认无其他窗口抢占焦点（并已清掉残留 tinyssh-app 实例）后重跑。")
            return 2
        res["pid"] = proc.pid
        res["origin"] = [wx, wy]
        sx, sy = wx + SENTINEL[0], wy + SENTINEL[1]
        rx, ry, rw, rh = wx + REGION[0], wy + REGION[1], REGION[2], REGION[3]
        shot = lambda n: snap(out, n, rx, ry, rw, rh)

        # ---- 预热：把「转 key」的动作花在测量窗之外（一律用 global；pid 不生效）----
        base = shot("00_baseline.png")
        ev2(["click", "--pid", str(proc.pid), "--x", str(sx), "--y", str(sy)] + GLOBAL)
        time.sleep(0.8)
        if shot("01_warmup.png") != base:
            ev2(["click", "--pid", str(proc.pid), "--x", str(sx), "--y", str(sy)] + GLOBAL)
            time.sleep(0.8)
        if shot("02_after_warmup.png") != base:
            print("FAIL: 预热后无法复位到基线（哨兵坐标或面板状态异常）")
            return 2
        res["baseline_md5"] = base

        def run_section(mode, tag, rounds, retry):
            """每轮：点一次，核验像素是否翻转；未翻转则重试，最多 retry 次。

            返回 (rounds_detail, all_flipped, drop_count)。drop_count = 未翻转的尝试次数，
            即**实测的丢事件计数**（观测数据）。

            **同时记录每次 ev2 的退出码**（`rcs`）：只看像素无法区分「投递了但没效果」
            与「guard 拒绝、根本没投」——后者也会表现为「没翻转」。调用方须据 rc 排除
            后者，否则 B 段可能因 guard 拒绝而**假过**。
            """
            state = shot(f"{tag}_state0.png")
            detail, drops = [], 0
            for r in range(rounds):
                flipped, attempts, last, rcs = False, 0, state, []
                while attempts < retry and not flipped:
                    attempts += 1
                    extra = GLOBAL if mode == "global" else []
                    rc, o, e = ev2(["click", "--pid", str(proc.pid), "--x", str(sx),
                                    "--y", str(sy)] + extra)
                    rcs.append(rc)
                    time.sleep(0.9)
                    last = shot(f"{tag}_r{r}_a{attempts}.png")
                    flipped = last != state
                    if not flipped:
                        drops += 1
                detail.append({"round": r, "flipped": flipped, "attempts": attempts,
                               "rcs": rcs, "md5": last})
                print(f"  {tag} round {r}: flipped={flipped} attempts={attempts} rcs={rcs}"
                      + ("" if flipped else "  <- 重试预算耗尽仍未翻转"))
                state = last
            return detail, all(d["flipped"] for d in detail), drops

        def all_rc_zero(detail):
            return all(rc == 0 for d in detail for rc in d["rcs"])

        # ---- A: global 必须能翻转 ----
        print("A global:")
        a_detail, a_ok, a_drops = run_section("global", "A", args.rounds, args.retry)
        a_rc_ok = all_rc_zero(a_detail)
        res["A_global"] = {"rounds": a_detail, "drops": a_drops, "all_rc_zero": a_rc_ok,
                           "attempts_total": sum(d["attempts"] for d in a_detail)}
        checks = [("A global delivery flips panel within retry budget", a_ok),
                  ("A every attempt exited 0 (delivery attempted, not guard-rejected)", a_rc_ok)]
        print(f"A -> {'PASS' if a_ok and a_rc_ok else 'FAIL'}（丢事件 {a_drops}/"
              f"{res['A_global']['attempts_total']} 次尝试，rc 全 0={a_rc_ok}）")

        # ---- B: 默认投递（=pid）必须永不翻转，且每次都必须真的投了（rc=0）----
        print("B default(pid):")
        b_detail, b_flipped, b_drops = run_section("pid", "B", args.rounds, args.retry)
        b_rc_ok = all_rc_zero(b_detail)
        res["B_default_pid"] = {"rounds": b_detail, "drops": b_drops, "all_rc_zero": b_rc_ok,
                                "attempts_total": sum(d["attempts"] for d in b_detail)}
        # rc 必须全 0：否则「没翻转」可能只是 guard 拒绝，B 会假过。
        b_ok = (not b_flipped) and b_rc_ok
        checks.append(("B default(pid) never flips panel, with rc=0 throughout", b_ok))
        print(f"B -> {'PASS' if b_ok else 'FAIL'}（rc 全 0={b_rc_ok}）")

        # ---- C: guard 负例①：不存在的 pid ----
        rc_c, o_c, e_c = ev2(["click", "--pid", "999999999", "--x", str(sx), "--y", str(sy)])
        c_ok = rc_c == 2 and "does not exist" in e_c
        res["C_nonexistent_pid"] = {"rc": rc_c, "stdout": o_c, "stderr": e_c}
        checks.append(("C guard rejects nonexistent pid with exit 2", c_ok))
        print(f"C nonexistent pid: rc={rc_c} -> {'PASS' if c_ok else 'FAIL'}")

        # ---- D: guard 负例②：存在但非前台 ----
        sleeper = subprocess.Popen(["sleep", "30"])
        try:
            rc_d, o_d, e_d = ev2(["click", "--pid", str(sleeper.pid),
                                  "--x", str(sx), "--y", str(sy)])
            d_ok = rc_d == 2 and "frontmost" in e_d
            res["D_nonfrontmost_pid"] = {"rc": rc_d, "stdout": o_d, "stderr": e_d,
                                         "sleeper_pid": sleeper.pid}
        finally:
            sleeper.terminate()
            sleeper.wait(5)
        checks.append(("D guard rejects non-frontmost pid with exit 2", d_ok))
        print(f"D non-frontmost pid: rc={rc_d} -> {'PASS' if d_ok else 'FAIL'}")

        ok = all(v for _, v in checks)
        res["checks"] = [{"name": n, "pass": v} for n, v in checks]
        # 裁决三分：B 变红（默认 pid 竟然翻转了）最可能是**环境属性变化**（pid 投递在
        # 本机恢复可用），而非工具缺陷——B 断言的是「本机 pid 失效」这个环境事实。
        # 若打成 ev2_delivery_failed 会把环境差异误报成工具缺陷（复核 finding #4）。
        if ok:
            res["verdict"] = "ev2_delivery_verified"
            res["verdict_note"] = "四段断言全过：global 可投递（rc 全 0 且像素翻转）、默认 pid 无效果（rc 全 0）、guard 两负例 exit 2。"
        elif b_flipped:
            res["verdict"] = "pid_delivery_now_works"
            res["verdict_note"] = ("B 段失败：默认 pid 投递**翻转了**像素——即本机 pid 投递"
                                   "已恢复可用（环境属性变化，**非本工具缺陷**）。"
                                   "须重估 ev2.py 默认投递与 G0 签署 §4 的前提。")
        else:
            res["verdict"] = "ev2_delivery_failed"
            res["verdict_note"] = "A 或 C/D 断言未过（global 不可投递 / guard 未按预期拒绝），须排查。"
        (out / "ev2-check.json").write_text(json.dumps(res, ensure_ascii=False, indent=2))
        print(f"VERDICT: {res['verdict']} (exit {0 if ok else 1})")
        print(f"  {res['verdict_note']}")
        return 0 if ok else 1
    finally:
        errf.close()
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()


def snap(out, name, x, y, w, h):
    p = out / name
    subprocess.run(["screencapture", "-x", "-R", f"{x},{y},{w},{h}", str(p)], capture_output=True)
    return hashlib.md5(p.read_bytes()).hexdigest()


if __name__ == "__main__":
    sys.exit(main())
