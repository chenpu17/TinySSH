#!/usr/bin/env python3
"""ev2.py — PID 定向键鼠注入驱动（UX-R1 R04 复测协议，Q-03 重设计）。

与 ev.py（全局 HID 投递）的区别——两类事故根因分别封闭：
1. 落点安全：CGEventPostToPid 直接投递到目标进程，焦点变化也不可能把事件送进
   其他应用（结构性保证，不依赖 guard 时序）。
2. 测量有效性：投递前在同一进程内核验 ①前台进程 = 目标 PID ②目标进程主窗口
   在屏；不满足即 abort 且不投递（键没到聚焦终端 → 计时无效，宁可失败）。
   guard 与投递同进程，消除 ev.py 方案「脚本验证→子进程投递」之间的 TOCTOU 窗口。
   残余窗口（核验→投递 ~1ms）只影响测量有效性（事件进后台窗口不渲染 → 观测端
   超时 → 该样本失败可见），不影响落点安全。

用法：
  ev2.py key   --pid <PID> --code <keycode> [--flag cmd|shift|ctrl|alt]*
  ev2.py text  --pid <PID> --string <s>
  ev2.py click --pid <PID> --x <X> --y <Y>
  ev2.py selftest            # 守卫拒绝路径负例验证，不投递（复审中-1：三类拒绝独立断言）
  （key/text/click 亦可加 --selftest 只跑守卫不投递，事件参数此时可省略）

投递点时间戳：成功投递时向 stdout 打 `T0=<epoch_ms>`（父进程用于计时起点）。
退出码：0 投递 / selftest 通过；2 守卫拒绝（未投递）；3 目标进程不存在；4 selftest 失败。
"""

import argparse
import subprocess
import sys
import time

import Quartz


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
    Quartz.CGEventPostToPid(pid, down)
    Quartz.CGEventPostToPid(pid, up)


def post_text(pid, string):
    src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    for ch in string:
        down = Quartz.CGEventCreateKeyboardEvent(src, 0, True)
        up = Quartz.CGEventCreateKeyboardEvent(src, 0, False)
        Quartz.CGEventKeyboardSetUnicodeString(down, len(ch), ch)
        Quartz.CGEventKeyboardSetUnicodeString(up, len(ch), ch)
        Quartz.CGEventPostToPid(pid, down)
        Quartz.CGEventPostToPid(pid, up)


def post_click(pid, x, y):
    src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    pt = Quartz.CGPointMake(x, y)
    move = Quartz.CGEventCreateMouseEvent(src, Quartz.kCGEventMouseMoved, pt, 0)
    Quartz.CGEventPostToPid(pid, move)
    down = Quartz.CGEventCreateMouseEvent(src, Quartz.kCGEventLeftMouseDown, pt, 0)
    up = Quartz.CGEventCreateMouseEvent(src, Quartz.kCGEventLeftMouseUp, pt, 0)
    Quartz.CGEventPostToPid(pid, down)
    Quartz.CGEventPostToPid(pid, up)


def selftest():
    """守卫拒绝路径负例验证（不投递）——三类拒绝独立断言（复审中-1）：
    ①目标不存在（全链 guard）②前台不符（全链：存在的非前台进程）③无在屏窗口
    （分支级：_window_onscreen 对无窗进程为 False；全链无法在 headless 下构造
    「前台但无窗」，如实标注覆盖级别）。"""
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
    finally:
        sleeper.terminate()
        sleeper.wait(5)
    ok = all(v for _, v in results)
    for name, v in results:
        print(("PASS" if v else "FAIL"), name)
    print(f"selftest {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 4


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("key", "text", "click"):
        p = sub.add_parser(name)
        p.add_argument("--pid", type=int, required=True)
        p.add_argument("--selftest", action="store_true")
    k = sub.choices["key"]; k.add_argument("--code", type=int, default=None)
    k.add_argument("--flag", action="append", choices=list(FLAGS))
    t = sub.choices["text"]; t.add_argument("--string", default=None)
    c = sub.choices["click"]; c.add_argument("--x", type=int, default=None)
    c.add_argument("--y", type=int, default=None)
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
    err = guard(a.pid)
    if err:
        print(f"[ev2] ABORT (nothing posted): {err}", file=sys.stderr)
        sys.exit(2)
    t0 = time.time_ns() // 1_000_000
    if a.cmd == "key":
        post_key(a.pid, a.code, a.flag)
    elif a.cmd == "text":
        post_text(a.pid, a.string)
    else:
        post_click(a.pid, a.x, a.y)
    print(f"T0={t0}")


if __name__ == "__main__":
    main()
