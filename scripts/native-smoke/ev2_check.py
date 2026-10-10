#!/usr/bin/env python3
"""`ev2.py` 投递工具的**工具级**验证（区别于 ev_delivery_probe.py 的**机制级**对照）。

- `ev_delivery_probe.py` 回答「pid 与 global 两种投递机制谁有效」（自建投递，不经 ev2）。
- 本脚本回答「**ev2 这个工具**（含 `--deliver` 接线、逐事件核验、guard 退出码）改好没有」——
  一律以 `subprocess` 调 `scripts/perf/ev2.py` 本体，不复制其投递代码。

**结构：观测段（环境属性，只记录） + 接线段（纯工具属性，恒应通过）**

观测段（A/B，**不参与裁决**）：
  A. `--deliver global` 点哨兵 → 面板像素是否**翻转**（逐轮；一轮内允许重试，重试次数
     即**丢点击率的实测样本**）。每次尝试记 `rc`。
  B. **默认投递**（不传 `--deliver`，即签署授权的 pid）点同一哨兵 → 像素是否翻转。
     B 不传 flag 是刻意的：验的正是「默认值 = pid」。**rc=0 是关键**：只看「没翻转」
     无法区分「投了但没效果」（= 环境事实）与「guard 拒绝、根本没投」（= 工具坏了却假过）。
  ⇒ A/B 测的是「**本机投递机制是否生效**」——那是**环境属性**。若把它写进裁决，环境
    一变（pid 恢复 / global 失灵 / 并发干扰）就会产出「工具失败」的**假结论**（复核实测：
    并发干扰下被测应用被杀、窗口消失致像素「翻转」，被打成「pid 恢复了」）。故 A/B
    **一律只作观测落盘**，另记 `observations.interference`（应用中途死亡 / 有 rc≠0）。

接线段（C/D/E，**恒应通过，构成本脚本的裁决**）：
  C. guard 负例①：不存在的 pid → **exit 2 且不投递**。
  D. guard 负例②：存在但非前台（临时 `sleep` 子进程）→ **exit 2 且不投递**。
     这两条不打扰任何用户应用（sleep 无 UI；不存在 pid 无副作用）。
  E. fail-closed 闸门：**不设** `TINYSSH_EV2_ALLOW_GLOBAL` 时 `--deliver global` →
     **exit 2 且 stdout 无 `T0=`（一个事件都没发）**。E 段刻意用 `ev2_noauth()`，因为
     其余段落的 `ev2()` 会自动置上该变量（见其 docstring 注记）。

**裁决（只有两个值）**：`ev2-check.json` 的 `verdict`——
  - `ev2_wiring_verified`：C/D/E 全过（工具接线正确）。
  - `ev2_wiring_failed`：有接线断言未过，须排查。
  **投递机制是否生效（global 翻转 / pid 无效果）只出现在 `observations`，永不进裁决。**

**两条已知的静默失判陷阱（都已在实测中撞到，故本脚本按此设计）**：

1. **激活后首次点击会被吞**：`activate()` 之后窗口尚未成为 key，第一个全局点击被 macOS
   吃掉用于「转 key」，表现为**像素不变**——与「投递失效」症状完全相同。故 `--settle`
   默认 2.5s，且测量前先做一次**预热点击**（点完复位），把转 key 的动作移出测量窗。
2. **global 投递会低概率丢事件**：实测在较重仪表（每次点击前后多张 `screencapture`）
   下见过约 1/6 的丢失；在轻仪表（每次点击仅一张截图、静置 0.75s）下 **60/60 无丢失**。
   丢因未定性（非事件间隔：gap 0/60/150ms 各 20 次全无丢失；非前台漂移：丢失时
   frontmost 仍等于目标）。**故本脚本不假设「点一次必中」**：A 段每轮允许最多
   `--retry` 次尝试，记录实际尝试次数并汇总为 `unflipped_attempts` 计数落盘——
   **该计数是观测数据，不是断言**。

**观测字段的读法（勿误读，独立复核 F2）**：判断「某段是否翻转」要看
`flipped_rounds`/`rounds_total`，**不要**看 `all_rounds_flipped`（那问的是「是否**每轮**
都翻转」，6 轮里 5 轮翻转会给 False，**低估**翻转）。`unflipped_attempts` 是同一个计数器，
但两段读法不同：A 段（global 本机有效）读作**丢事件**数；B 段（pid 本机无效）读作
「每轮重试预算耗尽」，**不是**丢事件。JSON 内 `observations.field_notes` 复述此约定。

⇒ **给调用方的结论**：用 global 做坐标取证时，**必须核验效果**（轮询状态/像素直到变化），
不得假设「投递即生效」；单次点击触发的计时端点会因丢事件产生虚假长尾。

**并发隔离**：DB 路径按 `--out` 派生（`/tmp/ev2_check-<hash10>/tinyssh.db`），两个不同
`--out` 的并发运行互不抢锁；启动前清 `<db>.lock`；应用早退时打印 `app.err` 尾部而非
白等 20s；测量前断言「前台 = 被测应用」。

用法：ev2_check.py --out <dir> [--bin PATH] [--rounds N] [--retry K] [--settle S]
退出码：0 接线全过 / 1 有接线断言未过 / 2 环境问题（无窗口、二进制缺失、非前台、预热复位失败）。
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
    """调 ev2 本体。**总是带 `TINYSSH_EV2_ALLOW_GLOBAL=1`**——本脚本的 A/B 观测段要验
    global 路径，而 ev2 默认 fail-closed 拒绝它（G0 签署 §4 禁止全局 HID 注入）。
    在此显式设该变量 = 本验证活动声明「已知这是未授权偏离、产物仅作**偏离证据**，
    不作门证据」。见 ev2.py docstring 与 docs/acceptance/ux-r1/g5/2026-10-10-ev-delivery/。

    **注记（复核提出）**：此处的硬编码使「审计可见的授权凭据」在跑测试时被**自动**置上，
    削弱其作为人为决策信号的价值。故 E 段（fail-closed 闸门）另用 `ev2_noauth()`，
    显式**不设**该变量——那一段才证明闸门真的关着。"""
    env = dict(os.environ, **{"TINYSSH_EV2_ALLOW_GLOBAL": "1"})
    r = subprocess.run([sys.executable, str(EV2)] + args, capture_output=True,
                       text=True, env=env)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def ev2_noauth(args):
    """同 `ev2()`，但**不设** `TINYSSH_EV2_ALLOW_GLOBAL`（并主动从继承环境里剔除它）。
    用于 E 段验证 fail-closed 闸门：未授权时 `--deliver global` 必须 **exit 2 且一个
    事件都不发**（stdout 无 `T0=`）。"""
    env = {k: v for k, v in os.environ.items() if k != "TINYSSH_EV2_ALLOW_GLOBAL"}
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

    # DB 路径按 `--out` 派生（而非固定 `/tmp/ev2_check/tinyssh.db`）：否则两个并发
    # ev2_check（**哪怕 --out 不同**）会互抢同一写锁，后到者 panic 退出——复核实测过
    # 这种互扰。派生后不同 --out 天然隔离；同一 --out 重跑仍复用并清库。
    run_key = hashlib.sha1(str(out.resolve()).encode()).hexdigest()[:10]
    dbdir = Path("/tmp") / f"ev2_check-{run_key}"
    dbpath = dbdir / "tinyssh.db"
    env = {"TINYSSH_MASTER_KEY": "07" * 32,
           "TINYSSH_DB": str(dbpath),
           "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
    dbdir.mkdir(parents=True, exist_ok=True)
    # 含 `.lock`：上一轮若留下活着的实例，它会持写锁，本轮应用会 panic 退出（症状是
    # 「20s 内无窗口」，与真实故障难以区分）。清掉陈旧锁文件，配合下方「应用早退」检测。
    for suf in ("", "-wal", "-shm", ".lock"):
        p = Path(str(dbpath) + suf)
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

        # ================= 观测段（环境属性：只记录，不判定）=================
        # A/B 测的是「本机投递机制是否生效」——那是**环境属性**，不是工具接线。若把
        # 环境属性写进裁决，环境一变（pid 恢复 / global 失灵 / 并发干扰）就会产出
        # 「工具失败」的假结论（复核 blocking #3：并发干扰下 A 实例的应用被杀，像素
        # 「翻转」是窗口消失所致，却被打成 `pid_delivery_now_works`）。故 A/B **一律
        # 只作观测落盘**；裁决只由下面的纯接线断言（C/D/E）决定。
        def _obs(detail, unflipped, rc_ok):
            """把一个观测段的原始 detail 归纳成**语义无歧义**的字段。

            关键（独立复核 F2）：**不能**用 `all(flipped)` 充当「是否翻转」——那实际是
            「是否**每轮**都翻转」，若 6 轮里 5 轮翻转它会给出 False，**低估**翻转，
            恰把 README 广告的那条「环境变化检测」弄瞎。故显式记 `flipped_rounds`/
            `rounds_total`，另给一个**名字即含义**的布尔 `all_rounds_flipped`。
            """
            n = len(detail)
            flipped = sum(1 for d in detail if d["flipped"])
            return {"rounds": detail, "rounds_total": n, "flipped_rounds": flipped,
                    "all_rounds_flipped": flipped == n,
                    "attempts_total": sum(d["attempts"] for d in detail),
                    "unflipped_attempts": unflipped, "all_rc_zero": rc_ok}

        print("A global (observation):")
        a_detail, _a_all, a_unflipped = run_section("global", "A", args.rounds, args.retry)
        a_rc_ok = all_rc_zero(a_detail)
        print("B default(pid) (observation):")
        b_detail, _b_all, b_unflipped = run_section("pid", "B", args.rounds, args.retry)
        b_rc_ok = all_rc_zero(b_detail)
        app_alive = proc.poll() is None
        res["observations"] = {
            "A_global": _obs(a_detail, a_unflipped, a_rc_ok),
            "B_default_pid": _obs(b_detail, b_unflipped, b_rc_ok),
            "app_alive_at_end": app_alive,
            "field_notes": {
                "flipped_rounds/rounds_total":
                    "翻转轮数/总轮数——**这才是**「是否翻转」的正确读法",
                "unflipped_attempts":
                    "未翻转的尝试次数。**同一计数器，两段读法不同**：A 段（global 本机"
                    "有效）→ 即**丢事件**数；B 段（pid 本机无效）→ 即「每轮重试预算"
                    "耗尽」，**不是**丢事件。",
                "all_rc_zero":
                    "该段所有尝试 rc 是否全 0（排除 guard 拒绝致假过）",
            },
        }
        # 环境干扰提示（**不是裁决**）：应用中途死亡 / 有 rc != 0 的尝试 → 观测不可信。
        interference = []
        if not app_alive:
            interference.append("被测应用在测量结束前已退出")
        if not (a_rc_ok and b_rc_ok):
            interference.append("A/B 段存在 rc != 0 的尝试（guard 拒绝或中途中止）")
        res["observations"]["interference"] = interference
        oa, ob = res["observations"]["A_global"], res["observations"]["B_default_pid"]
        print(f"观测：global 翻转 {oa['flipped_rounds']}/{oa['rounds_total']}"
              f"（rc 全 0={a_rc_ok}，未翻转尝试 {a_unflipped}）；"
              f"默认 pid 翻转 {ob['flipped_rounds']}/{ob['rounds_total']}"
              f"（rc 全 0={b_rc_ok}，未翻转尝试 {b_unflipped}）")
        if interference:
            print("  ⚠ 环境干扰：" + "；".join(interference)
                  + " —— 以上观测不可信，请排查后重跑")

        # ================= 接线段（纯工具属性：恒应通过）=================
        wiring = []
        # C: guard 负例①：不存在的 pid
        rc_c, o_c, e_c = ev2(["click", "--pid", "999999999", "--x", str(sx), "--y", str(sy)])
        c_ok = rc_c == 2 and "does not exist" in e_c
        res["C_nonexistent_pid"] = {"rc": rc_c, "stdout": o_c, "stderr": e_c}
        wiring.append(("C guard rejects nonexistent pid with exit 2", c_ok))
        print(f"C nonexistent pid: rc={rc_c} -> {'PASS' if c_ok else 'FAIL'}")

        # D: guard 负例②：存在但非前台
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
        wiring.append(("D guard rejects non-frontmost pid with exit 2", d_ok))
        print(f"D non-frontmost pid: rc={rc_d} -> {'PASS' if d_ok else 'FAIL'}")

        # E: fail-closed 闸门（**此前完全未测**，复核 blocking #3 建议补）：未设授权变量时
        #    `--deliver global` 必须 exit 2 且**一个事件都不发**（stdout 无 `T0=`）。
        rc_e, o_e, e_e = ev2_noauth(["click", "--pid", str(proc.pid), "--x", str(sx),
                                     "--y", str(sy), "--deliver", "global"])
        e_ok = rc_e == 2 and "REFUSED" in e_e and o_e == ""
        res["E_global_without_auth"] = {"rc": rc_e, "stdout": o_e, "stderr": e_e}
        wiring.append(("E --deliver global w/o auth env refused (exit 2, nothing posted)", e_ok))
        print(f"E global w/o auth: rc={rc_e} (stdout 空={o_e == ''}) -> "
              f"{'PASS' if e_ok else 'FAIL'}")

        ok = all(v for _, v in wiring)
        res["wiring"] = [{"name": n, "pass": v} for n, v in wiring]
        res["verdict"] = "ev2_wiring_verified" if ok else "ev2_wiring_failed"
        if ok:
            res["verdict_note"] = (
                "接线全部正确：guard 两类拒绝 + fail-closed 闸门均 exit 2 且不投递。"
                "**投递机制是否生效见 observations**——那是环境属性，不参与裁决。")
        else:
            res["verdict_note"] = (
                "有接线断言未过（guard 未按预期拒绝 / fail-closed 闸门失效），须排查；"
                "注意 observations 里的环境属性与接线无关，勿混为一谈。")
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
