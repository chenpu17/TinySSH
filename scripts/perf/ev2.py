#!/usr/bin/env python3
"""ev2.py — 定向键鼠注入驱动（UX-R1 R04 复测协议，Q-03 重设计）。

**投递路径（2026-10-10 重定，务必先读）**：
`--deliver` 选投递机制，两条：
- `pid`（**默认**）：`CGEventPostToPid(pid, ev)`——结构性只达目标进程。**这是 G0 签署
  §4 授权的唯一机制**（原文：「只用 ev2 PID 定向投递和逐事件守卫；**不得回退全局 HID
  注入**」）。但**本机实测该机制对 tinyssh-app 静默失效**：调用返回成功、guard 全过、
  无报错，被测应用**零反应**（鼠标与键盘皆然、新旧两棵树皆然、3/3 轮像素逐字不变）。
  证据：`docs/acceptance/ux-r1/g5/2026-10-10-ev-delivery/`。
- `global`：`CGEventPost(kCGHIDEventTap, ev)`——投给**当前前台应用**。每发一个事件前
  **重新核验前台仍是目标 pid**，不符即中止且不再投递其余事件（`DeliveryAbort`，exit 2）。
  **此路径正是签署 §4 明文禁止的「回退全局 HID 注入」**，故**默认关闭**：除非显式设
  `TINYSSH_EV2_ALLOW_GLOBAL=1`，`--deliver global` 一律 **exit 2 拒绝执行**（fail-closed）。
  该环境变量是**审计可见的授权凭据**——设它等于声明「签署范围已修订」。**在修订落地前，
  任何设该变量的运行都属未授权偏离，其产物不得作为门证据。**

⇒ **本机当前状态：签署授权的 pid 路径不可用，可用的 global 路径未获授权。**
这是 R51/C2 的**阻塞项**，须先取得签署范围修订（与「用本机」偏离一并登记），
不得自行降级处理。工具级验证见 `scripts/native-smoke/ev2_check.py`。

**修正记录**：本文件**工作树上一版（未提交）**的 docstring 称「`key`/`text`/`click`
投递路径为既有能力（R04 复测在用）」——该说法在本机**不成立**（pid 路径实测失效；
R04 的 P2/P4/P7 本身是「未测·环境阻塞」，从未真正跑过这些路径）。已按实测更正。
（注：该句在 `HEAD` 版中并不存在——drag 原语与这句声明都只存在于未提交的工作树改动里。）

**激活后首次点击会被吞**：目标窗口未成为 key 时，第一个全局点击被 macOS 吃掉用于
「转 key」，表现为**像素不变**——与「投递失效」症状相同，属**静默失判**温床。
实测静置 2.5s 后连续 14 次点击**全部落地**；静置约 1s 时首次点击被吞。调用方应在
测量前做一次**预热点击**并静置（`ev2_check.py` 即此模式）。

`drag` 补的是一处**缺失能力**（E07 50× 拖动所需）：原工具链只有 click（down+up 同点），
没有按下—移动—抬起的分离原语。中间移动用 `kCGEventLeftMouseDragged`（不是
`kCGEventMouseMoved`）——依据是 Apple 事件类型语义（接收端按事件类型区分拖拽），
**本机未做端到端投递复验**；若接收端仍不认，表现为观测端「拖动无位移」可见失败，
不会静默错判。`drag` 的 `global` 模式同样逐点核验前台。

用法：
  ev2.py key   --pid <PID> --code <keycode> [--flag cmd|shift|ctrl|alt]*
  ev2.py text  --pid <PID> --string <s>
  ev2.py click --pid <PID> --x <X> --y <Y>
  ev2.py drag  --pid <PID> --x <X> --y <Y> --dx <DX> --dy <DY> [--steps N] [--step-ms MS]
  ev2.py selftest            # 守卫/中止路径负例验证，不投递
  （key/text/click/drag 亦可加 --selftest 只跑守卫不投递，事件参数此时可省略；
    各命令均可加 --deliver pid|global，默认 pid=签署授权机制；global 需
    TINYSSH_EV2_ALLOW_GLOBAL=1，否则拒绝执行——理由见上）

**验证状态（重要，勿据未验证部分取证）**：
- **已验证**：`selftest` 五类独立断言（guard 三类拒绝路径 + 逐事件核验中止 + 中止途中
  补发抬起）；`global` 模式对 tinyssh-app 的**鼠标**投递真实生效（机制级 A/B 对照
  3/3 轮 + 工具级 6/6 轮，见 `ev2_check.py` 与上述证据目录）。
- **未验证**：`global` 模式的**键盘**投递（实测复跑不一致，一次生效一次无反应，
  根因未定）；`drag` 的真实投递；`pid` 模式在任何应用上是否可用（本机对 tinyssh-app
  失效，未做跨应用/跨版本对照）。

投递点时间戳：成功投递时向 stdout 打 `T0=<epoch_ms>`（父进程用于计时起点）。
退出码：0 投递 / selftest 通过；2 守卫拒绝、途中前台变化，或 global 未获授权；4 selftest 失败。
**exit 2 的两种子情形不要混为一谈**（stderr 可区分）：
  - `ABORT (nothing posted): …` —— guard 拒绝或 global 未授权，**一个事件都没发**；
  - `ABORT mid-sequence: …` —— 途中前台变化，**该序列中它之前的事件已经发出**（可能
    含已按下的鼠标键；`post_click`/`post_drag` 会尽力用 `CGEventPostToPid` 补发抬起，
    但本机该路径失效，故**抬起可能未生效**——目标应用可能留在按下态）。
（**exit 3「目标进程不存在」当前不可达**：guard 在 pid 不存在时即返回拒绝消息 → exit 2。
保留为将来区分用，代码中无分支产生。）
"""

import argparse
import os
import subprocess
import sys
import time

import Quartz

DELIVER = "pid"   # 由 main() 依 --deliver 覆盖；默认=G0 签署 §4 授权的 PID 定向机制
GLOBAL_ENV = "TINYSSH_EV2_ALLOW_GLOBAL"   # 设为 "1" 才允许 global（=声明签署范围已修订）


class DeliveryAbort(Exception):
    """投递途中前台不再等于目标 pid —— 立即停止，避免全局事件误投他应用。"""


def frontmost_pid():
    app = Quartz.NSWorkspace.sharedWorkspace().frontmostApplication()
    return app.processIdentifier() if app else None


def window_onscreen(pid):
    wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, 0)
    for w in wl:
        if w.get("kCGWindowOwnerPID") == pid:
            b = w.get("kCGWindowBounds")
            if b and int(b["Width"]) > 0:
                return True
    return False


def pid_exists(pid):
    try:
        import os
        os.kill(pid, 0)  # 探活不发包；权限不足(EPERM)也算存在
        return True
    except (ProcessLookupError, OverflowError):
        return False
    except PermissionError:
        return True


def guard(pid):
    """返回错误消息或 None（通过）。"""
    if not pid_exists(pid):
        return f"target pid {pid} does not exist"
    front = frontmost_pid()
    if front != pid:
        return f"frontmost pid {front} != target pid {pid}"
    if not window_onscreen(pid):
        return f"target pid {pid} has no on-screen window"
    return None


def check_front(pid):
    """逐事件核验（仅 global 模式需要）：核验不过即抛 DeliveryAbort。

    与 guard 的区别：guard 在序列**开始前**跑一次；本函数在每个事件**投递前**跑，
    把「核验→投递」窗口压到单次事件（R04 事故的形状正是序列途中焦点漂走）。
    """
    f = frontmost_pid()
    if f != pid:
        raise DeliveryAbort(f"投递途中前台变为 pid {f}（目标 {pid}）")


def post(pid, ev):
    """按 DELIVER 投递单个事件；global 模式投递前逐事件核验前台。"""
    if DELIVER == "global":
        check_front(pid)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
    else:
        Quartz.CGEventPostToPid(pid, ev)


FLAGS = {"cmd": Quartz.kCGEventFlagMaskCommand, "shift": Quartz.kCGEventFlagMaskShift,
         "ctrl": Quartz.kCGEventFlagMaskControl, "alt": Quartz.kCGEventFlagMaskAlternate}


def post_key(pid, code, flags):
    src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    down = Quartz.CGEventCreateKeyboardEvent(src, code, True)
    up = Quartz.CGEventCreateKeyboardEvent(src, code, False)
    if flags:
        mask = 0
        for f in flags:
            mask |= FLAGS[f]
        Quartz.CGEventSetFlags(down, mask)
        Quartz.CGEventSetFlags(up, mask)
    post(pid, down)
    post(pid, up)


def post_text(pid, string):
    src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    for ch in string:
        down = Quartz.CGEventCreateKeyboardEvent(src, 0, True)
        up = Quartz.CGEventCreateKeyboardEvent(src, 0, False)
        Quartz.CGEventKeyboardSetUnicodeString(down, len(ch), ch)
        Quartz.CGEventKeyboardSetUnicodeString(up, len(ch), ch)
        post(pid, down)
        post(pid, up)


def release_buttons(pid, src, pt):
    """尽力抬起鼠标左键，避免中止时把目标应用留在按下态。

    **只用 `CGEventPostToPid`**——此刻前台已不是目标，若改用全局投递，这个 mouseUp
    会落进**用户正在用的应用**（正是 R04 那次事故的形状）。post-to-pid 结构性只达
    目标进程，即便本机对它失效（见模块 docstring），也**不可能误投**。
    故这是「安全但可能无效」的尽力而为：**不保证**目标真的抬起。
    """
    try:
        Quartz.CGEventPostToPid(pid, Quartz.CGEventCreateMouseEvent(
            src, Quartz.kCGEventLeftMouseUp, pt, 0))
    except Exception:
        pass


def post_click(pid, x, y):
    src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    pt = Quartz.CGPointMake(x, y)
    move = Quartz.CGEventCreateMouseEvent(src, Quartz.kCGEventMouseMoved, pt, 0)
    post(pid, move)
    down = Quartz.CGEventCreateMouseEvent(src, Quartz.kCGEventLeftMouseDown, pt, 0)
    post(pid, down)
    up = Quartz.CGEventCreateMouseEvent(src, Quartz.kCGEventLeftMouseUp, pt, 0)
    try:
        post(pid, up)
    except DeliveryAbort:
        release_buttons(pid, src, pt)   # 已按下 → 尽力抬起再冒泡
        raise


def post_drag(pid, x, y, dx, dy, steps, step_ms):
    """按下—插值移动—抬起。中间移动用 LeftMouseDragged（依 Apple 事件类型语义；本机未端到端复验，见模块 docstring）。"""
    src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    start = Quartz.CGPointMake(x, y)
    end = Quartz.CGPointMake(x + dx, y + dy)
    post(pid, Quartz.CGEventCreateMouseEvent(src, Quartz.kCGEventMouseMoved, start, 0))
    post(pid, Quartz.CGEventCreateMouseEvent(src, Quartz.kCGEventLeftMouseDown, start, 0))
    try:
        for i in range(1, steps + 1):
            pt = Quartz.CGPointMake(x + dx * i / steps, y + dy * i / steps)
            post(pid, Quartz.CGEventCreateMouseEvent(src, Quartz.kCGEventLeftMouseDragged, pt, 0))
            if step_ms:
                time.sleep(step_ms / 1000.0)
        post(pid, Quartz.CGEventCreateMouseEvent(src, Quartz.kCGEventLeftMouseUp, end, 0))
    except DeliveryAbort:
        release_buttons(pid, src, end)  # 拖动中途中止 → 尽力抬起再冒泡
        raise


def selftest():
    """守卫/中止路径负例验证（不投递）——五类独立断言：
    ①目标不存在（全链 guard）②前台不符（全链：存在的非前台进程）③无在屏窗口
    （分支级：window_onscreen 对无窗进程为 False；全链无法在 headless 下构造
    「前台但无窗」，如实标注覆盖级别）④global 模式的逐事件核验在 pid 不符时抛
    DeliveryAbort（合成负例：直接把一个必然非前台的 pid 喂给 check_front）
    ⑤中止途中补发抬起（合成负例：post 在第 3 次调用抛 DeliveryAbort，断言
    post_click 冒泡且经 CGEventPostToPid 补发一次抬起）。"""
    results = []
    fake_pid = 999999999  # ① 不存在的 PID
    err = guard(fake_pid)
    results.append(("reject nonexistent pid (full guard)", err is not None and "does not exist" in err))
    # ② 存在但必然非前台：临时子进程（sleep），guard 须在 frontmost 分支拒绝
    sleeper = subprocess.Popen(["sleep", "30"])
    try:
        err2 = guard(sleeper.pid)
        results.append(("reject non-frontmost existing pid (full guard)",
                        err2 is not None and "frontmost" in err2))
        # ③ 无在屏窗口（分支级断言）
        results.append(("window branch: sleep pid has no on-screen window",
                        window_onscreen(sleeper.pid) is False))
        # ④ 逐事件核验：sleep 进程必然不是前台 → check_front 必须抛 DeliveryAbort
        raised = False
        try:
            check_front(sleeper.pid)
        except DeliveryAbort:
            raised = True
        results.append(("per-event front check aborts on non-frontmost pid", raised))
    finally:
        sleeper.terminate()
        sleeper.wait(5)
    # ⑤ 中止途中补发抬起（复核 finding #2 的修复验证）。合成：让 post 在第 3 次调用
    #    （= LeftMouseUp）抛 DeliveryAbort，断言 post_click ①冒泡 ②用 CGEventPostToPid
    #    **补发了一次抬起**（结构性只达目标进程，不会误投用户应用）。只记录不真投。
    _orig_post = globals()["post"]
    _orig_pid_post = Quartz.CGEventPostToPid
    seq = {"n": 0}
    released = []
    def _boom_post(pid, ev):
        seq["n"] += 1
        if seq["n"] >= 3:
            raise DeliveryAbort("synthetic mid-sequence abort")
    try:
        globals()["post"] = _boom_post
        Quartz.CGEventPostToPid = lambda pid, ev: released.append(ev)
        raised = False
        try:
            post_click(1, 10, 10)
        except DeliveryAbort:
            raised = True
    finally:
        globals()["post"] = _orig_post
        Quartz.CGEventPostToPid = _orig_pid_post
    results.append(("post_click aborts mid-sequence AND best-effort releases button",
                    raised and len(released) == 1))
    ok = all(v for _, v in results)
    for name, v in results:
        print(("PASS" if v else "FAIL"), name)
    print(f"selftest {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 4


def main():
    global DELIVER
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("key", "text", "click", "drag"):
        p = sub.add_parser(name)
        p.add_argument("--pid", type=int, required=True)
        p.add_argument("--selftest", action="store_true")
        p.add_argument("--deliver", choices=("pid", "global"), default="pid",
                       help="投递机制：pid=CGEventPostToPid（默认，G0 签署 §4 授权机制，"
                            "本机对 tinyssh-app 静默失效）；global=全局 HID（签署明文禁止，"
                            f"须设 {GLOBAL_ENV}=1 才执行）")
    k = sub.choices["key"]; k.add_argument("--code", type=int, default=None)
    k.add_argument("--flag", action="append", choices=list(FLAGS))
    t = sub.choices["text"]; t.add_argument("--string", default=None)
    c = sub.choices["click"]; c.add_argument("--x", type=int, default=None)
    c.add_argument("--y", type=int, default=None)
    d = sub.choices["drag"]; d.add_argument("--x", type=int, default=None)
    d.add_argument("--y", type=int, default=None)
    d.add_argument("--dx", type=int, default=None)
    d.add_argument("--dy", type=int, default=None)
    d.add_argument("--steps", type=int, default=20)
    d.add_argument("--step-ms", type=int, default=20)
    sub.add_parser("selftest")
    a = ap.parse_args()
    if a.cmd == "selftest" or getattr(a, "selftest", False):
        sys.exit(selftest())
    if a.cmd == "key" and a.code is None:
        ap.error("key requires --code")
    if a.cmd == "text" and not a.string:
        ap.error("text requires --string")
    if a.cmd == "click" and (a.x is None or a.y is None):
        ap.error("click requires --x --y")
    if a.cmd == "drag" and None in (a.x, a.y, a.dx, a.dy):
        ap.error("drag requires --x --y --dx --dy")
    if a.cmd == "drag" and a.steps < 1:
        ap.error("drag --steps must be >= 1")
    if a.cmd == "drag" and a.step_ms < 0:
        # 负值会在 time.sleep() 抛 ValueError——且是在 down+首个 dragged **已投递之后**，
        # 目标应用会卡在按下态。必须在投递前拦住。
        ap.error("drag --step-ms must be >= 0")
    # global = G0 签署 §4 明文禁止的「回退全局 HID 注入」。fail-closed：未显式授权即拒绝，
    # 且**在 guard 之前**拒绝（连核验都不做，杜绝任何事件出网的可能）。
    if a.deliver == "global" and os.environ.get(GLOBAL_ENV) != "1":
        print(
            f"[ev2] REFUSED (nothing posted): --deliver global 属 G0 签署 §4 明文禁止的"
            f"「回退全局 HID 注入」。\n"
            f"  改用 global 的**唯一**理由是：签署授权的 pid 定向投递在本机对 tinyssh-app\n"
            f"  静默失效（证据 docs/acceptance/ux-r1/g5/2026-10-10-ev-delivery/）。\n"
            f"  该偏离须先取得**签署范围修订**，并与其产物一并登记。\n"
            f"  确已获授权时：{GLOBAL_ENV}=1 重跑（该变量是审计可见的授权凭据）。",
            file=sys.stderr)
        sys.exit(2)
    err = guard(a.pid)
    if err:
        print(f"[ev2] ABORT (nothing posted): {err}", file=sys.stderr)
        sys.exit(2)
    DELIVER = a.deliver
    t0 = time.time_ns() // 1_000_000
    try:
        if a.cmd == "key":
            post_key(a.pid, a.code, a.flag)
        elif a.cmd == "text":
            post_text(a.pid, a.string)
        elif a.cmd == "click":
            post_click(a.pid, a.x, a.y)
        else:
            post_drag(a.pid, a.x, a.y, a.dx, a.dy, a.steps, a.step_ms)
    except DeliveryAbort as e:
        print(f"[ev2] ABORT mid-sequence: {e}——已停止投递其余事件", file=sys.stderr)
        sys.exit(2)
    print(f"T0={t0}")


if __name__ == "__main__":
    main()

