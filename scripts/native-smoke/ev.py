#!/usr/bin/env python3
"""T40 真机冒烟驱动：CGEvent 点击/键入/快捷键 + screencapture 验证。
用法：
  ev.py click X Y          左键单击（屏幕绝对坐标）
  ev.py move X Y           悬停
  ev.py text "whoami"      键入 ASCII 文本（含 \n 转义）
  ev.py key <keycode> [cmd|shift|ctrl|opt]   按键码
依赖 pyobjc Quartz；需宿主进程具备辅助功能权限（T28 同通道）。"""
import sys
import time
import Quartz

FLAGS = {"cmd": Quartz.kCGEventFlagMaskCommand, "shift": Quartz.kCGEventFlagMaskShift,
         "ctrl": Quartz.kCGEventFlagMaskControl, "opt": Quartz.kCGEventFlagMaskAlternate}


def post(ev):
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)


def click(x, y):
    for typ in (Quartz.kCGEventLeftMouseDown, Quartz.kCGEventLeftMouseUp):
        ev = Quartz.CGEventCreateMouseEvent(None, typ, (x, y), Quartz.kCGMouseButtonLeft)
        post(ev)
        time.sleep(0.05)


def move(x, y):
    ev = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (x, y), 0)
    post(ev)


def text(s):
    s = s.replace("\\n", "\n")
    for chunk_start in range(0, len(s), 20):  # CGEvent unicode 上限约 20 字符/事件
        chunk = s[chunk_start:chunk_start + 20]
        for down in (True, False):
            ev = Quartz.CGEventCreateKeyboardEvent(None, 0, down)
            Quartz.CGEventKeyboardSetUnicodeString(ev, len(chunk), chunk)
            post(ev)
            time.sleep(0.01)


def key(code, mods):
    flags = 0
    for m in mods:
        flags |= FLAGS[m]
    for down in (True, False):
        ev = Quartz.CGEventCreateKeyboardEvent(None, int(code), down)
        Quartz.CGEventSetFlags(ev, flags)
        post(ev)
        time.sleep(0.05)


def main():
    a = sys.argv[1:]
    if a[0] == "click":
        click(float(a[1]), float(a[2]))
    elif a[0] == "move":
        move(float(a[1]), float(a[2]))
    elif a[0] == "text":
        text(a[1])
    elif a[0] == "key":
        key(a[1], a[2:])
    else:
        sys.exit(f"unknown: {a}")


if __name__ == "__main__":
    main()
