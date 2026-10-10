#!/usr/bin/env python3
"""E01 原生窗口尺寸原语：读/设目标进程窗口的 AX 尺寸与位置。

用途：R50 E01「多尺寸」场景需要把**被测应用窗口**精确设为 1280×800 / 960×640 /
320×… 等，再逐尺寸 `screencapture`。现有工具链（`ev.py` 全局 HID 投递、
`ev2.py` PID 定向键鼠、`beacon.py`）**没有任何 resize 能力**，本文件补上这一格。

实现选型：AX C API 经 ctypes 直调 `ApplicationServices.framework`。
- 不引入新依赖：本机 pyobjc 未装 `ApplicationServices` 框架（`import` 会
  ModuleNotFoundError），但系统框架本身在，ctypes 直调即可。
- 不装 pip 包、不需要 TCC 重新授权。

**验证状态（重要，勿据未验证部分取证）**：
- **已实测**（2026-10-10，**屏幕解锁**态，在**被测应用 tinyssh-app** 上、**非用户
  应用**；原始件 `docs/acceptance/ux-r1/g5/2026-10-10-primitives/winsize-{set,pos}-verify.log`）：
  只读路径（读出真实 size/pos/title/settable）；`set` **真实投递**——读回=请求，
  含 1280×800→960×640 的**实变**与带 `--x/--y` 的位置投递（1000×700@(300,200)
  读回一致）；**夹取 exit 5**——400×300 被夹到 960×600（因 `tauri.conf.json` 的
  `minWidth=960/minHeight=600`，即原生窗口**不可能**小于 960×600）；`AXValue`
  尺寸/点往返；四类守卫拒绝路径；selftest 负例。
- **位置相关夹取（实测，E01 必读）**：窗口管理器按窗口**当前**位置夹取请求尺寸——
  尺寸先于位置生效。主显示器 1512×982 上实测：窗口在 (300,200) 时请求 1280×800 被夹到
  **1212×782**（=1512−300 / 982−200）；同一请求在窗口位于 (100,71) 时**原样采纳**；
  带 `--x/--y` 时尺寸按**旧位置**夹取、随后才移动位置（故窗口可停在部分离屏处）。
  ⇒ **要把窗口设成某个尺寸，须先把它放到留得下该尺寸的位置**，否则 `set` 会 fail-closed
  exit 5（不会把夹取结果当成功，但调用方须知道这是位置问题而非尺寸不可设）。
- **未验证**：`ev2.py` 的 `drag` 真实投递（见该文件 docstring）；多显示器/全屏态
  下的行为。

**锁屏遮蔽（实测）**：屏幕锁定时（`CGSessionCopyCurrentDictionary` 的
`CGSSessionScreenIsLocked`=True、前台为 `loginwindow`），macOS 对非特权 AX 客户端
**遮蔽窗口树，且遮蔽不一致**：`AXWindows` 仍返回 err=0 与若干元素，**多数**元素
`AXRole` 读成 `AXApplication`、`AXSize` 为 (0,0) 或 -25205（不支持），但**有的元素
仍读到看似正常的值**（实测 Finder 某窗 `AXRole='AXScrollArea'`、`AXSize=(3432,1242)`
err=0）。正因遮蔽不一致、读数真伪难辨，**锁屏下任何读数都不可信**——故本脚本
`set` 一律 fail-closed 拒绝（exit 2），`list`/`get` 亦拒绝输出，selftest 第 ⑤ 项报
SKIP 而非 PASS/FAIL。取证前必须确认屏幕已解锁。

**已知残余（低危，登记不阻塞）**：selftest ⑤ 只读 `wins[0]`——若锁屏检测漏判
（`screen_locked()` 返 False/None 而实际锁屏）、而该窗恰可读，⑤ 理论上可能假绿
（本环境实测无此情况；主防线是 `set`/`list`/`get` 的锁屏闸门）。⑤ 在 `locked is None`
时走「尝试真读」分支，与 `set`/`list`/`get` 对 None 一律 fail-closed 的口径不一致
（该分支只更偏红，不产生假绿）。

**fail-closed**：`set` 在投递前核验 ① pid 存在 ② 屏幕已解锁 ③ AX 元素可取 ④ 目标
index 合法（**含负值**）且窗口在场 ⑤ `AXSize` 可写；任一不过即 exit 2 且**一个字节都
不改**。设置后**读回**比对，读回与请求不符（窗口管理器夹取/拒绝）即 exit 5——不许把
「设了但没生效」当成「设好了」写进证据。

**读回比对容差（±1px 盲带）**：比对用 `SIZE_TOLERANCE = 1.0`，即每维差 **≤1px** 判为
采纳（exit 0）。故上文「读回与请求不符即 exit 5」严格说是「**超出 1px** 才不符」：夹取
值落在请求 ±1px 内时**不会**被 exit 5 捕获（实测请求 1213×783 被夹到 1212×782 → exit 0）。
取证时若要求逐像素精确，须自行核对读回值而非只看退出码。

用法：
  winsize.py list --pid <PID>                      只读：列出窗口 index/size/pos/title/可写性
  winsize.py get  --pid <PID> [--index N]          只读：读单个窗口
  winsize.py set  --pid <PID> [--index N] --width W --height H [--x X --y Y]
  winsize.py selftest                              只读：拒绝路径与判定逻辑负例（不设任何窗口）

退出码：0 成功；2 守卫拒绝（未做任何修改）；3 目标进程不存在；5 尺寸未被采纳
（读回与请求不符）；6 selftest 失败。
"""

import argparse
import ctypes
import sys

AS = ctypes.CDLL("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
CF = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")

AS.AXUIElementCreateApplication.restype = ctypes.c_void_p
AS.AXUIElementCreateApplication.argtypes = [ctypes.c_int]
AS.AXUIElementCopyAttributeValue.restype = ctypes.c_int
AS.AXUIElementCopyAttributeValue.argtypes = [
    ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
AS.AXUIElementIsAttributeSettable.restype = ctypes.c_int
AS.AXUIElementIsAttributeSettable.argtypes = [
    ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_ubyte)]
AS.AXUIElementSetAttributeValue.restype = ctypes.c_int
AS.AXUIElementSetAttributeValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
AS.AXValueCreate.restype = ctypes.c_void_p
AS.AXValueCreate.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
AS.AXValueGetValue.restype = ctypes.c_bool
AS.AXValueGetValue.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p]

CF.CFStringCreateWithCString.restype = ctypes.c_void_p
CF.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
CF.CFArrayGetCount.restype = ctypes.c_long
CF.CFArrayGetCount.argtypes = [ctypes.c_void_p]
CF.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
CF.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
CF.CFStringGetCString.restype = ctypes.c_bool
CF.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]

UTF8 = 0x08000100
K_CG_SIZE, K_CG_POINT = 2, 1
ERR_API_DISABLED = -25211  # 未授权辅助功能（TCC）
SIZE_TOLERANCE = 1.0       # 读回比对容差（像素）
# 内存约定：本脚本是短命 CLI，CF/AX 引用一律**不** release（每进程几十次调用、~KB 级，
# 可接受）。**不要**给 `windows()` 里的 arr 补 CFRelease——`CFArrayGetValueAtIndex`
# 返回的元素指针其生命周期依附于该数组，release 后即悬垂。


class CGSize(ctypes.Structure):
    _fields_ = [("width", ctypes.c_double), ("height", ctypes.c_double)]


class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


def cfstr(s):
    return ctypes.c_void_p(CF.CFStringCreateWithCString(None, s.encode(), UTF8))


def cfstr_value(ref):
    """CFStringRef → python str（失败返回 None）。"""
    if not ref:
        return None
    buf = ctypes.create_string_buffer(1024)
    if not CF.CFStringGetCString(ctypes.c_void_p(ref), buf, 1024, UTF8):
        return None
    return buf.value.decode("utf-8", "replace")


def pid_exists(pid):
    import os
    try:
        os.kill(pid, 0)  # 探活不发包；EPERM 也算存在
        return True
    except (ProcessLookupError, OverflowError):
        return False
    except PermissionError:
        return True


def screen_locked():
    """→ True/False；无法判定返回 None。锁屏时 AX 窗口树被系统遮蔽，读写都不可信。"""
    try:
        import Quartz
        d = Quartz.CGSessionCopyCurrentDictionary()
        if not d:
            return None
        return bool(d.get("CGSSessionScreenIsLocked"))
    except Exception:
        return None


def windows(pid):
    """→ (err, [AXUIElementRef, …])。err!=0 时列表为空（-25211=未授权）。"""
    ax = AS.AXUIElementCreateApplication(pid)
    if not ax:
        return -1, []
    arr = ctypes.c_void_p()
    err = AS.AXUIElementCopyAttributeValue(
        ctypes.c_void_p(ax), cfstr("AXWindows"), ctypes.byref(arr))
    if err != 0 or not arr.value:
        return err, []
    n = CF.CFArrayGetCount(arr)
    return 0, [ctypes.c_void_p(CF.CFArrayGetValueAtIndex(arr, i)) for i in range(n)]


def read_attr(win, name):
    v = ctypes.c_void_p()
    err = AS.AXUIElementCopyAttributeValue(win, cfstr(name), ctypes.byref(v))
    return err, v


def get_size(win):
    err, v = read_attr(win, "AXSize")
    if err != 0 or not v.value:
        return err, None
    sz = CGSize()
    if not AS.AXValueGetValue(v.value, K_CG_SIZE, ctypes.byref(sz)):
        return -1, None
    return 0, (sz.width, sz.height)


def get_pos(win):
    err, v = read_attr(win, "AXPosition")
    if err != 0 or not v.value:
        return err, None
    pt = CGPoint()
    if not AS.AXValueGetValue(v.value, K_CG_POINT, ctypes.byref(pt)):
        return -1, None
    return 0, (pt.x, pt.y)


def settable(win, name):
    st = ctypes.c_ubyte()  # AX 的 Boolean 是 unsigned char，非 C99 bool
    err = AS.AXUIElementIsAttributeSettable(win, cfstr(name), ctypes.byref(st))
    return err == 0 and bool(st.value)


def window_info(index, count, win):
    """从一个已解析的窗口元素取描述。不重复调 windows()，避免 O(n²) 与竞态。"""
    _, sz = get_size(win)
    _, pos = get_pos(win)
    _, title = read_attr(win, "AXTitle")
    return {"index": index, "count": count, "size": sz, "pos": pos,
            "title": cfstr_value(title.value), "size_settable": settable(win, "AXSize")}


def resolve_from(index, wins):
    """从已取到的窗口列表解析 index。负值/越界一律拒绝（否则负值会静默选中末窗）。"""
    if index < 0 or index >= len(wins):
        return f"窗口 index={index} 非法（合法范围 0..{len(wins) - 1}，共 {len(wins)} 个）", None
    return None, wins[index]


def resolve(pid, index):
    """→ (错误消息, 窗口元素, 窗口数)。一次 windows() 取全，调用方复用 count 免得再取一次。"""
    err, wins = windows(pid)
    if err == ERR_API_DISABLED:
        return f"未授权辅助功能（AX err={err}）", None, 0
    if err != 0:
        return f"读取 AXWindows 失败（err={err}）", None, 0
    msg, win = resolve_from(index, wins)
    return msg, win, len(wins)


def size_accepted(actual, want, tol=SIZE_TOLERANCE):
    """读回是否被采纳。抽出成纯函数以便单测（合成值对，不依赖真实窗口）。"""
    return actual is not None and all(abs(a - w) <= tol for a, w in zip(actual, want))


def locked_abort():
    """只读命令在锁屏时也拒绝——被遮蔽的读数会被误当真实数据，不如不给。"""
    locked = screen_locked()
    if locked is not False:
        print(f"FAIL: {'屏幕已锁定（AX 被遮蔽）' if locked else '无法判定屏幕锁定状态'}"
              f"——只读读数不可信，拒绝输出", file=sys.stderr)
        return True
    return False


def cmd_list(args):
    if locked_abort():
        return 2
    err, wins = windows(args.pid)
    if err == ERR_API_DISABLED:
        print(f"FAIL: 未授权辅助功能（AX err={err}）", file=sys.stderr)
        return 2
    if err != 0:
        print(f"FAIL: 读取 AXWindows 失败（err={err}）", file=sys.stderr)
        return 2
    print(f"pid={args.pid} 窗口数={len(wins)}")
    for i, win in enumerate(wins):
        d = window_info(i, len(wins), win)
        print(f"  [{i}] size={d['size']} pos={d['pos']} title={d['title']!r} "
              f"AXSize可写={d['size_settable']}")
    return 0


def cmd_get(args):
    if locked_abort():
        return 2
    msg, win, n = resolve(args.pid, args.index)
    if msg:
        print(f"FAIL: {msg}", file=sys.stderr)
        return 2
    d = window_info(args.index, n, win)
    print(f"pid={args.pid} index={d['index']} size={d['size']} "
          f"pos={d['pos']} title={d['title']!r} AXSize可写={d['size_settable']}")
    return 0


def guard_set(pid, index):
    """投递前核验。返回 (错误消息, win) —— 消息非 None 即拒绝且未做任何修改。"""
    if not pid_exists(pid):
        return f"目标 pid {pid} 不存在", None
    locked = screen_locked()
    if locked is not False:  # True=锁屏；None=无法判定（fail-closed 一律拒绝）
        return ("屏幕已锁定——AX 窗口树被遮蔽，尺寸读写不可信"
                if locked else "无法判定屏幕锁定状态——fail-closed 拒绝"), None
    msg, win, _ = resolve(pid, index)
    if msg:
        return msg, None
    if not settable(win, "AXSize"):
        return f"窗口 [{index}] 的 AXSize 不可写（应用可能固定了尺寸）", None
    return None, win


def cmd_set(args):
    msg, win = guard_set(args.pid, args.index)
    if msg:
        print(f"[winsize] ABORT (未做任何修改): {msg}", file=sys.stderr)
        return 2
    sz = CGSize(float(args.width), float(args.height))
    ref = AS.AXValueCreate(K_CG_SIZE, ctypes.byref(sz))
    if not ref:
        print("[winsize] ABORT: AXValueCreate 返回 NULL（尺寸值构造失败）", file=sys.stderr)
        return 2
    err = AS.AXUIElementSetAttributeValue(win, cfstr("AXSize"), ctypes.c_void_p(ref))
    if err != 0:
        print(f"[winsize] ABORT: 设置 AXSize 失败（err={err}）", file=sys.stderr)
        return 2
    if args.x is not None and args.y is not None:
        pt = CGPoint(float(args.x), float(args.y))
        refp = AS.AXValueCreate(K_CG_POINT, ctypes.byref(pt))
        if not refp:
            print("[winsize] 警告: AXValueCreate(CGPoint) 返回 NULL，位置未设", file=sys.stderr)
        else:
            err_p = AS.AXUIElementSetAttributeValue(
                win, cfstr("AXPosition"), ctypes.c_void_p(refp))
            if err_p != 0:
                print(f"[winsize] 警告: AXPosition 设置失败（err={err_p}），尺寸已设",
                      file=sys.stderr)
    # 读回比对：夹取/拒绝不得当成「设好了」
    _, actual = get_size(win)
    _, pos = get_pos(win)
    want = (float(args.width), float(args.height))
    ok = size_accepted(actual, want)
    print(f"请求 size={want} → 读回 size={actual} pos={pos}")
    if not ok:
        print(f"[winsize] FAIL: 读回尺寸与请求不符（窗口被夹取或拒绝）——"
              f"该尺寸不得作为证据", file=sys.stderr)
        return 5
    return 0


def selftest():
    """只读负例验证：拒绝路径必须拒绝，判定逻辑必须能区分正反，且**不修改任何窗口**。"""
    import subprocess
    results = []

    def check(name, ok, detail=""):
        results.append((name, ok))
        print(("PASS" if ok else "FAIL"), name, "--", detail)

    # ① 不存在的 PID：guard 拒绝
    msg, _ = guard_set(999999999, 0)
    check("reject nonexistent pid", msg is not None and "不存在" in msg, str(msg))

    # ② AXWindows 不可读的进程（sleep 无该属性，err=-25204）→ 拒绝。
    #    直接打 resolve() 的 AXWindows 分支（不经 guard_set 的锁屏前置检查，
    #    否则锁屏时会因别的原因拒绝、标签与实测不符）。锁屏不改变该分支。
    sleeper = subprocess.Popen(["sleep", "30"])
    try:
        msg2, _, _ = resolve(sleeper.pid, 0)
        check("resolve rejects pid whose AXWindows is unreadable", msg2 is not None, str(msg2))
        _, wins = windows(sleeper.pid)
        check("no windows resolved for that process", wins == [], f"n={len(wins)}")
    finally:
        sleeper.terminate()
        sleeper.wait(5)

    # ③ 负 index 必须拒绝（负值曾静默选中末窗）。用**合成窗口列表**打到真实分支，
    #    不依赖环境里是否真有窗口——否则锁屏/无窗时这条会绕过被测分支。
    msg3, _ = resolve_from(-1, [object(), object()])
    check("reject negative index", msg3 is not None and "非法" in msg3, str(msg3))
    msg3b, win3b = resolve_from(1, [object(), object()])
    check("accept in-range index", msg3b is None and win3b is not None, str(msg3b))
    msg3c, _ = resolve_from(2, [object(), object()])
    check("reject out-of-range index", msg3c is not None and "非法" in msg3c, str(msg3c))

    # ④ 读回判定逻辑：用**合成值对**验正反（自比较是恒真伪断言）
    cases = [(((1280.0, 800.0), (1280.0, 800.0)), True),
             (((1280.0, 800.0), (1281.0, 800.5)), True),
             (((1280.0, 800.0), (1282.0, 800.0)), False),
             ((None, (1280.0, 800.0)), False)]
    bad = [(a, w) for ((a, w), exp) in cases if size_accepted(a, w) is not exp]
    check("size_accepted distinguishes accept/clamp", not bad,
          f"4 例全对" if not bad else f"不符预期：{bad}")

    # ⑤ 只读路径真能读到真实窗口（不依赖窗口是否可写）。锁屏时 AX 被遮蔽，此项
    #    **无法评估**——报 SKIP，既不冒认通过也不误报失败（锁屏非本脚本缺陷）。
    locked = screen_locked()
    if locked is True:
        print("SKIP read-only size read from a live window -- 屏幕已锁定（AX 被遮蔽），无法评估")
    else:
        import Quartz
        read_ok = False
        for a in Quartz.NSWorkspace.sharedWorkspace().runningApplications():
            if a.activationPolicy() != 0 or a.processIdentifier() <= 0:
                continue
            err, wins = windows(a.processIdentifier())
            if err == 0 and wins:
                _, sz = get_size(wins[0])
                read_ok = sz is not None and sz[0] > 0 and sz[1] > 0
                if read_ok:
                    check("read-only size read from a live window", True,
                          f"{a.localizedName()} size={sz}")
                    break
        if not read_ok:
            check("read-only size read from a live window", False,
                  "找不到可只读的窗口——未覆盖，如实标注")

    # ⑥ 锁屏时 set 必须 fail-closed 拒绝（该分支只在锁屏时可达，故条件式）
    if locked is True:
        msg6, _ = guard_set(__import__("os").getpid(), 0)
        check("locked screen blocks set (fail-closed)", msg6 is not None and "锁定" in msg6,
              str(msg6))
    else:
        print("SKIP locked screen blocks set -- 当前未锁屏，该分支不可达")

    ok = all(v for _, v in results)
    print(f"selftest {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 6


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("list", "get", "set"):
        p = sub.add_parser(name)
        p.add_argument("--pid", type=int, required=True)
        p.add_argument("--index", type=int, default=0)
    s = sub.choices["set"]
    s.add_argument("--width", type=int, required=True)
    s.add_argument("--height", type=int, required=True)
    s.add_argument("--x", type=int, default=None)
    s.add_argument("--y", type=int, default=None)
    sub.add_parser("selftest")
    args = ap.parse_args()
    if args.cmd == "selftest":
        sys.exit(selftest())
    if not pid_exists(args.pid):
        print(f"FAIL: 目标 pid {args.pid} 不存在", file=sys.stderr)
        sys.exit(3)
    if args.cmd == "set" and ((args.x is None) != (args.y is None)):
        ap.error("--x 与 --y 必须同时给出（只给一个会静默不设位置）")
    if args.cmd == "list":
        sys.exit(cmd_list(args))
    if args.cmd == "get":
        sys.exit(cmd_get(args))
    sys.exit(cmd_set(args))


if __name__ == "__main__":
    main()
