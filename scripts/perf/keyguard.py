"""键事件前置护栏（UX-R1 R04 事故后强制）。

每次向系统发送键/点击事件前必须调用 verify()：① 前台进程必须是 tinyssh-app
（osascript 返回值非空且精确匹配，杜绝 capture_output 吞错导致的静默失败——
2026-10-06 P2 事故根因）② tinyssh 1280x800 主窗口在屏。任一不满足即中止脚本，
不发送任何事件。测量计时窗口必须从护栏通过之后开始，护栏延迟不计入样本。
"""

import subprocess
import time

import Quartz

ACTIVATE = ('tell application "System Events" to set frontmost of process '
            '"tinyssh-app" to true')
FRONTMOST = ('tell application "System Events" to get name of first application '
             'process whose frontmost is true')


def _frontmost():
    r = subprocess.run(["osascript", "-e", FRONTMOST], capture_output=True, text=True)
    return r.stdout.strip()


def _window_onscreen():
    wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, 0)
    for w in wl:
        if "tinyssh" in (w.get("kCGWindowOwnerName") or "").lower():
            b = w.get("kCGWindowBounds")
            if b and int(b["Width"]) == 1280 and int(b["Height"]) == 800:
                return True
    return False


def verify():
    front = _frontmost()
    onscreen = _window_onscreen()
    if front != "tinyssh-app" or not onscreen:
        raise SystemExit(f"[keyguard] ABORT before key event: frontmost={front!r} "
                         f"(expected 'tinyssh-app'), window_onscreen={onscreen}")


def activate_and_verify():
    r = subprocess.run(["osascript", "-e", ACTIVATE], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"[keyguard] activate failed: {r.stderr.strip()}")
    time.sleep(0.5)
    verify()
