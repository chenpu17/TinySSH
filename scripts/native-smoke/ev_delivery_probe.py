#!/usr/bin/env python3
"""合成输入投递 A/B 对照探针：`CGEventPostToPid`（ev2 现行路径）vs 全局 HID 投递。

背景（2026-10-10 实测）：`scripts/perf/ev2.py` 的 `click`/`key`/`text` 走
`Quartz.CGEventPostToPid(pid, ev)`。在本机（Darwin 27.0.0）上该调用对 tinyssh-app
**静默失效**——事件投递返回成功、无报错、guard 全过，但 UI **零反应**（鼠标与键盘
皆然，新旧两棵树皆然）。同一坐标改用 `CGEventPost(kCGHIDEventTap, ev)`（全局 HID
投递）则**立即生效**。本探针把该对照做成**可复跑**的控制实验，供归档与复核。

方法（单变量：仅投递目标不同，坐标/应用/会话完全相同）：
1. 启动被测应用，等 1280×800 窗口，置前。
2. 记录「哨兵区域」基线像素 md5（左侧面板，面板默认收起）。
3. **鼠标对照**：分别以 pid / global 两种方式点击**同一哨兵点**（`＋` 按钮，点击后
   左侧面板展开），各记点击前后 md5 是否变化。
4. **键盘对照**：先以 global 点击聚焦文本框，再分别以 pid / global 注入同一字符串，
   各记前后 md5 是否变化。
5. 每个 mode 前用 global 点击把面板/输入框**复位到基线**，保证两者起点相同。

判定：若 `pid` 无变化而 `global` 有变化 → 复现「pid 投递失效」（exit 0）。
两者皆无变化 → 哨兵点/坐标不适用，结论**不确定**（exit 3，如实标注，不硬判）。
两者皆有变化 → 本机 pid 投递正常（exit 4，与归档结论不符，须复查）。

用法：
  ev_delivery_probe.py --out <dir> [--bin PATH] [--sentinel-dx N --sentinel-dy N]
                       [--field-dx N --field-dy N] [--region-dx N --region-dy N
                       --region-w N --region-h N]

坐标一律**相对窗口左上角**（探针自行取窗口原点），故与窗口摆放位置无关。
退出码：0 复现 pid 失效 / 3 结论不确定（哨兵无反应）/ 4 pid 投递正常（反常）/
        2 环境或参数问题（未启动、窗口尺寸不符等）。
"""

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
EV2 = REPO / "scripts/perf/ev2.py"
EXPECT_W, EXPECT_H = 1280, 800


def log(msg):
    print(msg, flush=True)


def window_origin(pid):
    import Quartz
    wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, 0)
    for w in wl:
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
    time.sleep(0.6)


def frontmost_pid():
    import Quartz
    for a in Quartz.NSWorkspace.sharedWorkspace().runningApplications():
        if a.isActive():
            return a.processIdentifier()
    return None


def snap(path, x, y, w, h):
    subprocess.run(["screencapture", "-x", "-R", f"{x},{y},{w},{h}", path],
                   capture_output=True)
    return hashlib.md5(Path(path).read_bytes()).hexdigest()


def post_mouse(pid, x, y, mode):
    """mode: 'pid' → CGEventPostToPid；'global' → CGEventPost(kCGHIDEventTap)。"""
    import Quartz
    src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    pt = Quartz.CGPointMake(x, y)
    for t in (Quartz.kCGEventMouseMoved, Quartz.kCGEventLeftMouseDown,
              Quartz.kCGEventLeftMouseUp):
        e = Quartz.CGEventCreateMouseEvent(src, t, pt, 0)
        if mode == "pid":
            Quartz.CGEventPostToPid(pid, e)
        else:
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)
        time.sleep(0.05)


def post_text(pid, s, mode):
    import Quartz
    src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    for ch in s:
        for down in (True, False):
            e = Quartz.CGEventCreateKeyboardEvent(src, 0, down)
            Quartz.CGEventKeyboardSetUnicodeString(e, len(ch), ch)
            if mode == "pid":
                Quartz.CGEventPostToPid(pid, e)
            else:
                Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)
            time.sleep(0.02)


def post_key(pid, code, flags, mode):
    import Quartz
    src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    for down in (True, False):
        e = Quartz.CGEventCreateKeyboardEvent(src, code, down)
        if flags:
            Quartz.CGEventSetFlags(e, flags)
        if mode == "pid":
            Quartz.CGEventPostToPid(pid, e)
        else:
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)
        time.sleep(0.02)


def guard(pid, mode):
    """fail-closed：投递前核验前台仍是目标。全局投递下这条尤其关键（否则误投他应用）。"""
    if mode == "pid":
        r = subprocess.run(["python3", str(EV2), "selftest"], capture_output=True)
        return None  # ev2 自带 guard；此处不重复
    f = frontmost_pid()
    if f != pid:
        return f"frontmost pid {f} != target {pid}（全局投递会误投，拒绝）"
    return None


def reset_ui_state(out):
    """把被测二进制的 webview localStorage **移走**（可逆），使 UI 布局回到默认。

    背景（2026-10-10 实测）：dev 二进制把 UI 状态（`ui.hostbar` 等）持久化在
    `~/Library/WebKit/<bundle>/WebsiteData/**/LocalStorage/`。上一轮交互把
    `ui.hostbar` 置 0（隐藏主机栏）后，**下一轮启动仍是该布局**，于是同一套坐标
    在两次运行里指向不同控件——探针会以「两种投递都无变化」静默失判。
    ⇒ 每轮取证前必须把该状态复位（本函数用 mv 而非 rm，原状态留在 out/ 下可还原）。

    **修正（2026-10-10，独立复核发现）**：原实现用 4 段 glob
    `*/WebsiteData/*/*/LocalStorage`，实测 `matches: 0`——**两型真实布局都不匹配**：

      - `<bundle>/WebsiteData/LocalStorage`                       （tinyssh-app 即此型）
      - `<bundle>/WebsiteData/Default/<hash>/<hash>/LocalStorage` （多数 Tauri/WebKit 应用）

    故 `--reset-ui-state` **一直在静默空转**，README §5 的「复位生效」主张**当时无据**
    （归档 `run.log` 首行那句 `moved 0 LocalStorage dir(s)` 即是证据，当时未被察觉）。
    现改为**递归 glob 覆盖任意深度**，并**只认 bundle 段恰为 `tinyssh-app` 的那一支**
    ——`com.tinyssh.app` 可能是用户已安装的应用，用户长期指令禁止打扰用户应用。
    匹配 0 个时**大声告警**（不再静默），因为「本轮未复位」与「glob 又写错」症状相同。
    """
    import glob
    import shutil
    base = Path.home() / "Library/WebKit"
    pat = str(base / "*" / "WebsiteData" / "**" / "LocalStorage")
    moved = []
    for d in glob.glob(pat, recursive=True):
        parts = Path(d).parts
        if "WebsiteData" not in parts:
            continue
        bundle = parts[parts.index("WebsiteData") - 1]
        if bundle != "tinyssh-app":
            continue
        dst = out / "ui-state-backup" / d.replace("/", "_")
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(d, dst)
        moved.append(d)
    if not moved:
        log(f"WARN: --reset-ui-state 匹配 0 个 LocalStorage 目录（搜索式 {pat}，仅认 "
            f"bundle=tinyssh-app）——**本轮 UI 状态未复位**；若上一轮遗留 ui.hostbar 等，"
            f"坐标可能指向别的控件，本轮结果不可信。")
    return moved


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="证据输出目录")
    ap.add_argument("--bin", default=str(REPO / "target/release/tinyssh-app"))
    ap.add_argument("--reset-ui-state", action="store_true",
                    help="启动前把 webview localStorage 移走（可逆，备份在 out/ui-state-backup/）"
                         "——不重置则上一轮遗留的 ui.hostbar 等会让坐标指向别的控件")
    ap.add_argument("--sentinel-dx", type=int, default=197, help="＋ 按钮相对窗口左上 x")
    ap.add_argument("--sentinel-dy", type=int, default=53, help="＋ 按钮相对窗口左上 y")
    ap.add_argument("--field-dx", type=int, default=88, help="名称文本框相对窗口左上 x（面板展开态）")
    ap.add_argument("--field-dy", type=int, default=144, help="名称文本框相对窗口左上 y（面板展开态）")
    ap.add_argument("--region-dx", type=int, default=12)
    ap.add_argument("--region-dy", type=int, default=105)
    ap.add_argument("--region-w", type=int, default=270)
    ap.add_argument("--region-h", type=int, default=320)
    ap.add_argument("--field-region-dx", type=int, default=54)
    ap.add_argument("--field-region-dy", type=int, default=131)
    ap.add_argument("--field-region-w", type=int, default=70)
    ap.add_argument("--field-region-h", type=int, default=26)
    ap.add_argument("--repeat", type=int, default=2, help="鼠标 A/B 重复轮数（每轮两 mode 各一次）")
    ap.add_argument("--with-keyboard", action="store_true",
                    help="附加键盘 A/B 段（默认关闭：该段受焦点/面板状态影响，"
                         "本机复跑不稳定，不宜作为裁决依据）")
    ap.add_argument("--keep-running", action="store_true", help="结束后不杀被测应用")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    if args.reset_ui_state:
        moved = reset_ui_state(out)
        log(f"reset ui state: moved {len(moved)} LocalStorage dir(s) -> {out}/ui-state-backup/")
    BIN = Path(args.bin)
    if not BIN.is_file():
        log(f"FAIL: 被测二进制不存在或不是文件：{BIN}")
        return 2

    # DB 路径按 `--out` 派生（而非固定 `/tmp/ev_delivery_probe/tinyssh.db`）：否则两个
    # 并发探针（**哪怕 --out 不同**）会互抢同一写锁，后到者 panic 退出——复核实测过这种
    # 互扰（同一现象也污染过 ev2_check 的归档）。派生后不同 --out 天然隔离。
    run_key = hashlib.sha1(str(out.resolve()).encode()).hexdigest()[:10]
    dbdir = Path("/tmp") / f"ev_delivery_probe-{run_key}"
    dbpath = dbdir / "tinyssh.db"
    env = {"TINYSSH_MASTER_KEY": "07" * 32,
           "TINYSSH_DB": str(dbpath),
           "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
    dbdir.mkdir(parents=True, exist_ok=True)
    # 含 `.lock`：上一轮若留下活着的实例，它会持写锁 → 本轮应用 panic 退出（症状是
    # 「20s 内无窗口」，与真实故障难以区分）。清掉陈旧锁文件。
    for suf in ("", "-wal", "-shm", ".lock"):
        p = Path(str(dbpath) + suf)
        if p.exists():
            p.unlink()
    errf = open(out / "app.err", "wb")
    proc = subprocess.Popen([BIN], env=env, stdout=subprocess.DEVNULL, stderr=errf)
    try:
        wx = wy = None
        for _ in range(40):
            time.sleep(0.5)
            if proc.poll() is not None:
                break   # 应用已退出（如 DB 写锁被占）——别白等 20s
            wx, wy = window_origin(proc.pid)
            if wx is not None:
                break
        if wx is None:
            errf.flush()
            tail = (out / "app.err").read_text(errors="replace").strip().splitlines()[-6:]
            why = ("被测应用已退出（见 app.err）" if proc.poll() is not None
                   else f"未在 20s 内取得 {EXPECT_W}×{EXPECT_H} 窗口")
            log(f"FAIL: {why}；app.err 末尾：")
            for l in tail:
                log("    " + l)
            return 2
        activate(proc.pid)
        log(f"app pid={proc.pid} window origin=({wx},{wy})")

        sx, sy = wx + args.sentinel_dx, wy + args.sentinel_dy
        fx, fy = wx + args.field_dx, wy + args.field_dy
        rx, ry = wx + args.region_dx, wy + args.region_dy
        rw, rh = args.region_w, args.region_h
        frx, fry = wx + args.field_region_dx, wy + args.field_region_dy
        frw, frh = args.field_region_w, args.field_region_h
        shot = lambda name: snap(str(out / name), rx, ry, rw, rh)

        baseline = shot("00_baseline.png")
        log(f"baseline md5={baseline[:12]}")

        def ensure_baseline(tag, max_iter=4):
            """用 global 点击哨兵点把面板复位到基线（面板是 toggle）。"""
            for i in range(max_iter):
                if shot(f"reset_{tag}_{i}.png") == baseline:
                    return True
                post_mouse(proc.pid, sx, sy, "global")
                time.sleep(0.7)
            return shot(f"reset_{tag}_final.png") == baseline

        result = {"app_pid": proc.pid, "window_origin": [wx, wy],
                  "bin": str(BIN),
                  "bin_sha256": hashlib.sha256(BIN.read_bytes()).hexdigest(),
                  "baseline_md5": baseline,
                  "sentinel": [sx, sy], "field": [fx, fy],
                  "region": [rx, ry, rw, rh], "mouse": {}, "keyboard": {}}

        # ---- 鼠标对照（裁决依据）----
        open_md5 = None
        rounds = []
        for r in range(args.repeat):
            row = {}
            for mode in ("pid", "global"):
                if not ensure_baseline(f"m{r}_{mode}"):
                    log(f"WARN: 复位到基线失败（round={r} mode={mode}），该轮不可判")
                    row[mode] = {"error": "reset_to_baseline_failed"}
                    continue
                before = shot(f"m{r}_{mode}_before.png")
                post_mouse(proc.pid, sx, sy, mode)
                time.sleep(0.8)
                after = shot(f"m{r}_{mode}_after.png")
                changed = before != after
                row[mode] = {"before": before, "after": after, "changed": changed}
                log(f"round {r} mouse[{mode}] changed={changed}  ({before[:10]} -> {after[:10]})")
                if mode == "global" and changed:
                    open_md5 = after   # 面板展开、文本框为空的参考态
            rounds.append(row)
        result["mouse_rounds"] = rounds
        result["open_md5"] = open_md5
        # 逐轮汇总：某 mode 全部轮次一致才算该 mode 的结论
        def mode_verdict(mode):
            vals = [r[mode].get("changed") for r in rounds if mode in r and "changed" in r[mode]]
            if not vals:
                return None
            return vals[0] if all(v == vals[0] for v in vals) else "mixed"
        m_pid, m_glb = mode_verdict("pid"), mode_verdict("global")
        result["mouse"] = {"pid": m_pid, "global": m_glb,
                           "pid_values": [r.get("pid", {}).get("changed") for r in rounds],
                           "global_values": [r.get("global", {}).get("changed") for r in rounds]}
        result["keyboard"] = {}

        # ---- 键盘对照（可选；本机复跑不稳定，仅作观察，不参与裁决）----
        if args.with_keyboard:
            fshot = lambda name: snap(str(out / name), frx, fry, frw, frh)
            if open_md5 is None:
                log("WARN: 未取得面板展开参考态，跳过键盘段")
                result["keyboard"] = {"error": "no_open_reference"}
            else:
                post_mouse(proc.pid, sx, sy, "global")
                time.sleep(0.6)
                if shot("k_precheck.png") != open_md5:
                    post_mouse(proc.pid, sx, sy, "global")
                    time.sleep(0.6)
                for mode in ("pid", "global"):
                    post_mouse(proc.pid, fx, fy, "global")       # 聚焦文本框
                    time.sleep(0.4)
                    post_key(proc.pid, 0, 0x00100000, "global")  # Cmd+A
                    time.sleep(0.2)
                    post_key(proc.pid, 51, 0, "global")          # Delete
                    time.sleep(0.5)
                    before = fshot(f"k_{mode}_before.png")
                    post_text(proc.pid, "PROBEKEY", mode)
                    time.sleep(0.8)
                    after = fshot(f"k_{mode}_after.png")
                    changed = before != after
                    result["keyboard"][mode] = {"before": before, "after": after,
                                                "changed": changed}
                    log(f"keyboard[{mode}] changed={changed}  ({before[:10]} -> {after[:10]})")

        if m_glb is None:
            verdict, code = "inconclusive", 3
        elif m_pid is False and m_glb is True:
            verdict, code = "pid_delivery_broken", 0
        elif m_pid is True and m_glb is True:
            verdict, code = "pid_delivery_works", 4
        else:
            verdict, code = "inconclusive", 3
        result["verdict"] = verdict
        result["summary"] = {"mouse": {"pid": m_pid, "global": m_glb}}
        (out / "ev-delivery-probe.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2))
        log(f"VERDICT: {verdict} (exit {code})")
        return code
    finally:
        errf.close()
        if not args.keep_running:
            proc.terminate()
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    sys.exit(main())
