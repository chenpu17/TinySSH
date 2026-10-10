#!/usr/bin/env python3
"""UX-R1 P5 压力同步观测采集器（签署 §3 增补 / 交付 §4「P5 压力观测增补」）。

职责：从预热贯穿到 E，与内存采样**同步**、**带时间戳**记录系统级内存压力证据，
供「归属或压力条件失效 → 整轮不可判」的判定使用。

**只读**：仅调用 `vm_stat` / `sysctl` / `memory_pressure` 的只读查询；**绝不**
主动 purge、绝不制造内存压力（签署 §3 明令禁止）。本文件不做任何写系统状态的
操作——代码面只有 subprocess 只读查询与文件落盘。

观测字段（每点）：
  phase      相位标签（P0/B/load/E）
  ts_wall    ISO8601（本地时区带偏移）
  ts_epoch   Unix 秒（**跨进程可比**，判据 I5/I6 用）
  ts_mono    单调时钟秒（仅同一采集进程内自洽，留档用）
  page_size  Mach 页大小（字节）
  pages      vm_stat 页计数（free/active/inactive/speculative/throttled/wired/
             purgeable/purged/file_backed/anonymous/stored_in_compressor/
             occupied_by_compressor）
  counters   compressions/decompressions/pageins/pageouts/swapins/swapouts/
             translation_faults（累计计数器，判据用差值）
  mb         由页计数换算的内存 MB（compressor/free/wired/active…）
  pressure   kern.memorystatus_vm_pressure_level（1 normal / 2 warn / 4 critical）
  swap       sysctl vm.swapusage 的 total/used/free MB
  free_pct   memory_pressure 报的「System-wide memory free percentage」（best-effort）

采样频率（**预登记，R51 冻结，不得事后调整**）：与 memsample 同频——每 5s 一点，
每相位连续 60s（=12 点）；预热首点作为压力基线 P0。频率写入每份输出的 protocol。

失效判据（**预登记，先于任何测量登记；不得看结果后放宽**）——任一成立则**整轮不可判**：
  I1 压力等级：任一点 pressure_level ≥ 4（critical）。字段缺失亦判失效（见 I8）。
  I2 swap 增长：**逐相位**相对基线（P0）的最大增量 > 256 MB。
  I3 压缩器增长：**逐相位**相对基线的最大增量 > 512 MB。
  I4 页回收：**逐相位**相对基线的最大增量 > 20000 页（≈312 MB @16K 页）。
     「逐相位」= 每相位取该相位内相对 P0 的**最大**值，任一相位超阈值即失效；
     相位末回落**不豁免**（签署 §3：任一阶段满足失效条件则整轮不可判）。
  I5 采样缺口：**相位内**相邻点间隔 > 2× 登记频率，或系列相位点数 < 登记点数 − 1
     （相位之间的静置间隔是协议性的，不计入）。
  I6 时序：ts_epoch 在**原始输入顺序**上非严格递增（先排序再判会把乱序洗掉）。
  I7 归属（外部喂入）：memsample 任一相位 voided=true。
  I8 数据完整性：任一必需字段（ts_epoch / pressure_level / swap.used_mb /
     mb.occupied_by_compressor / pages.purged）缺失，或缺 P0 基线相位 → 不可判
     （**缺数据不得当作「未超阈值」放过**）。
判据 I1–I4 是**外部压力**的提示性证据，不是「外压 purge」的证明（签署 §3：RSS 同步
下降只能提示回收，缺同期观测不能确诊）。应用自身引发的增长按签署 §3 须计入资源
问题调查，**不得**直接归为外部环境并豁免。原始点一律保留（含失效轮），供受控重测对账。

用法：
  # 相位序列（与 memsample record 同频同步）
  python3 scripts/perf/vmstat_probe.py series --phase B --interval 5 --duration 60 \
      --out /tmp/p5_B_pressure.json
  # 单点（预热压力基线 P0）
  python3 scripts/perf/vmstat_probe.py point --phase P0 --out /tmp/p5_P0_pressure.json
  # 整轮裁决（喂入 P0 + B + load + E 全部点，另可喂 memsample 输出查归属）
  python3 scripts/perf/vmstat_probe.py verdict \
      --points /tmp/p5_P0_pressure.json /tmp/p5_B_pressure.json ... \
      --memsample /tmp/p5_B.json /tmp/p5_E.json --out /tmp/p5_pressure_verdict.json
"""

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

# ---------------------------------------------------------------- 预登记协议
PROTOCOL = {
    "name": "P5 压力同步观测 v1",
    "registered": "2026-10-10",
    "frozen_for": "R51",
    "interval_s": 5,
    "phase_duration_s": 60,
    "points_per_phase": 12,
    "baseline_phase": "P0",
    "sources": ["vm_stat", "sysctl kern.memorystatus_vm_pressure_level",
                "sysctl -n vm.swapusage", "memory_pressure"],
    "read_only": True,
    "no_purge": True,
    "invalidation": {
        "I1_pressure_critical": "任一点 pressure_level >= 4（字段缺失见 I8）",
        "I2_swap_growth_mb": "任一相位相对 P0 基线的最大增量 > 256",
        "I3_compressor_growth_mb": "任一相位相对 P0 基线的最大增量 > 512",
        "I4_pages_purged_growth": "任一相位相对 P0 基线的最大增量 > 20000 页",
        "I5_sampling_gap": "相位内相邻点 ts_epoch 间隔 > 2x interval，或系列相位点数 < points_per_phase-1（相位间静置间隔不计）",
        "I6_monotonic_time": "ts_epoch 在原始输入顺序上非严格递增",
        "I7_attribution_void": "memsample 任一相位 voided=true",
        "I8_data_completeness": "必需字段（ts_epoch/pressure_level/swap.used_mb/mb.occupied_by_compressor/pages.purged）缺失，或缺 P0 基线相位",
    },
    "note": ("判据为外部压力的提示性证据，非外压 purge 的证明；应用自身引发的增长"
             "计入资源问题调查，不得豁免。阈值先于测量登记，不得看结果后放宽。"),
}

PAGE_KEYS = {
    "Pages free": "free",
    "Pages active": "active",
    "Pages inactive": "inactive",
    "Pages speculative": "speculative",
    "Pages throttled": "throttled",
    "Pages wired down": "wired",
    "Pages purgeable": "purgeable",
    "Pages purged": "purged",
    "File-backed pages": "file_backed",
    "Anonymous pages": "anonymous",
    "Pages stored in compressor": "stored_in_compressor",
    "Pages occupied by compressor": "occupied_by_compressor",
}
COUNTER_KEYS = {
    "Compressions": "compressions",
    "Decompressions": "decompressions",
    "Pageins": "pageins",
    "Pageouts": "pageouts",
    "Swapins": "swapins",
    "Swapouts": "swapouts",
    "Translation faults": "translation_faults",
}


class ProbeError(Exception):
    """输入不可用（文件缺失/损坏/形状不对/字段不全）——干净报错，不抛裸 traceback。"""


def read_doc(path):
    """读一份采集/裁决 JSON。损坏或形状不对一律 ProbeError（fail-closed）。"""
    try:
        with open(path) as f:
            doc = json.load(f)
    except (OSError, ValueError, RecursionError) as e:
        raise ProbeError(f"无法读取 {path}：{type(e).__name__}: {e}") from e
    if not isinstance(doc, dict):
        raise ProbeError(f"{path} 不是 JSON 对象（得到 {type(doc).__name__}）")
    if not isinstance(doc.get("points", []), list):
        raise ProbeError(f"{path} 的 points 不是数组（得到 {type(doc['points']).__name__}）")
    return doc


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout


def parse_vm_stat(text):
    """→ (page_size_bytes, {pages…}, {counters…})。字段缺失不报错（版本差异容忍）。"""
    ps = re.search(r"page size of (\d+) bytes", text)
    page_size = int(ps.group(1)) if ps else 0
    pages, counters = {}, {}
    for line in text.splitlines():
        m = re.match(r'^"?([^":]+)"?:\s+(\d+)\.?\s*$', line.strip())
        if not m:
            continue
        name, val = m.group(1).strip(), int(m.group(2))
        if name in PAGE_KEYS:
            pages[PAGE_KEYS[name]] = val
        elif name in COUNTER_KEYS:
            counters[COUNTER_KEYS[name]] = val
    return page_size, pages, counters


def parse_swapusage(text):
    m = re.search(r"total = ([\d.]+)M\s+used = ([\d.]+)M\s+free = ([\d.]+)M", text)
    if not m:
        return None
    return {"total_mb": float(m.group(1)), "used_mb": float(m.group(2)),
            "free_mb": float(m.group(3))}


def parse_free_pct(text):
    m = re.search(r"memory free percentage:\s*(\d+)%", text)
    return int(m.group(1)) if m else None


def observe(phase, ts_mono=None):
    """一次只读观测。任何单项失败降级为 None，不抛异常（采集期不可中断）。"""
    page_size, pages, counters = parse_vm_stat(sh("vm_stat"))
    level = sh("sysctl -n kern.memorystatus_vm_pressure_level").strip()
    pressure_level = int(level) if level.isdigit() else None
    swap = parse_swapusage(sh("sysctl -n vm.swapusage"))
    free_pct = parse_free_pct(sh("memory_pressure"))
    mb = {}
    if page_size:
        for k in ("free", "active", "inactive", "wired", "purgeable",
                  "occupied_by_compressor", "anonymous", "file_backed"):
            if k in pages:
                mb[k] = round(pages[k] * page_size / (1024.0 * 1024.0), 2)
    return {
        "phase": phase,
        "ts_wall": datetime.now(timezone.utc).astimezone().isoformat(),
        "ts_epoch": round(time.time(), 3),
        "ts_mono": round(ts_mono if ts_mono is not None else time.monotonic(), 3),
        "page_size": page_size,
        "pages": pages,
        "counters": counters,
        "mb": mb,
        "pressure_level": pressure_level,
        "swap": swap,
        "free_pct": free_pct,
    }


def write_doc(path, kind, phase, points):
    doc = {"kind": kind, "phase": phase, "protocol": PROTOCOL, "points": points}
    try:
        with open(path, "w") as f:
            json.dump(doc, f, ensure_ascii=False, indent=1)
    except OSError as e:
        raise ProbeError(f"无法写入 {path}：{type(e).__name__}: {e}") from e
    return doc


def cmd_point(args):
    pts = [observe(args.phase)]
    write_doc(args.out, "point", args.phase, pts)
    p = pts[0]
    print(f"[{args.phase}] 单点压力基线：level={p['pressure_level']} "
          f"free_pct={p['free_pct']} compressor={p['mb'].get('occupied_by_compressor')}MB "
          f"swap_used={(p['swap'] or {}).get('used_mb')}MB → {args.out}")
    return 0


def cmd_series(args):
    if args.duration <= 0 or args.interval <= 0:
        print("FAIL: --duration/--interval 须为正整数", file=sys.stderr)
        return 2
    pts, t0 = [], time.monotonic()
    while time.monotonic() - t0 < args.duration:
        pts.append(observe(args.phase, ts_mono=time.monotonic() - t0))
        time.sleep(args.interval)
    if not pts:
        print("FAIL: 未采集到任何点", file=sys.stderr)
        return 2
    write_doc(args.out, "series", args.phase, pts)
    print(f"[{args.phase}] 压力序列 {len(pts)} 点 / {args.duration}s@{args.interval}s "
          f"（level 域 {sorted({p['pressure_level'] for p in pts})}）→ {args.out}")
    return 0


def load_points(paths):
    pts = []
    for path in paths:
        pts.extend(read_doc(path).get("points", []))
    return pts


# 判定所必需的字段：(标签, 取值函数)。缺任一 → I8（缺数据不得当作「未超阈值」放过）。
REQUIRED_FIELDS = (
    ("ts_epoch", lambda p: p.get("ts_epoch")),
    ("pressure_level", lambda p: p.get("pressure_level")),
    ("swap.used_mb", lambda p: (p.get("swap") or {}).get("used_mb")),
    ("mb.occupied_by_compressor", lambda p: (p.get("mb") or {}).get("occupied_by_compressor")),
    ("pages.purged", lambda p: (p.get("pages") or {}).get("purged")),
)


def evaluate(pts, memsample_paths, interval, points_per_phase, single_point_phases=("P0",),
             baseline_phase="P0"):
    """按预登记判据裁决。返回 (invalid, checks)。纯数据，可单测。

    跨进程排序/缺口一律用 ts_epoch（ts_mono 仅在同一采集进程内自洽，多个文件
    拼接后不可比——故只作留档，不参与判据）。缺字段/缺文件不放过，一律判失效。"""
    checks = []

    def add(cid, name, ok, detail):
        # ok=True 表示「判据未触发」（健康）；ok=False 表示触发失效
        checks.append({"id": cid, "name": name, "triggered": not ok, "detail": detail})

    if not pts:
        add("I5", "sampling gap", False, "无任何点")
        add("I8", "data completeness", False, "无任何点")
        return True, checks

    # I6 时序：必须在排序**之前**判——排序会把乱序洗成单调，等于放过。
    raw_epoch = [p.get("ts_epoch") for p in pts]
    inc = (all(e is not None for e in raw_epoch)
           and all(b > a for a, b in zip(raw_epoch, raw_epoch[1:])))
    add("I6", "monotonic time", inc, f"原始输入顺序 ts_epoch 严格递增={inc}")

    pts = sorted(pts, key=lambda p: (p.get("ts_epoch") is None, p.get("ts_epoch") or 0))

    # I8 数据完整性：必需字段齐全 + 基线相位在场
    missing = [f"#{i}({p.get('phase')}).{name}"
               for i, p in enumerate(pts) for name, get in REQUIRED_FIELDS if get(p) is None]
    if not any(p.get("phase") == baseline_phase for p in pts):
        missing.append(f"缺相位 {baseline_phase}（压力基线）")
    add("I8", "data completeness", not missing,
        "必需字段齐全且基线相位在场" if not missing
        else "缺失：" + ", ".join(missing[:8]) + ("…" if len(missing) > 8 else ""))

    levels = [p.get("pressure_level") for p in pts]
    worst = max([l for l in levels if l is not None], default=None)
    add("I1", "pressure critical", worst is not None and worst < 4,
        f"max pressure_level={worst}")

    base = next((p for p in pts if p.get("phase") == baseline_phase), pts[0])

    def growth_check(cid, name, get, limit, unit):
        """逐相位相对基线的**最大**增量。任一相位超阈值即失效——相位末回落不豁免。"""
        b = get(base)
        if b is None:
            add(cid, name, False, f"基线相位 {baseline_phase} 缺该字段——无法评估")
            return
        per_phase = {}
        for p in pts:
            v = get(p)
            if v is not None:
                per_phase.setdefault(p.get("phase"), []).append(v)
        if not per_phase:
            add(cid, name, False, "无任何点含该字段——无法评估")
            return
        ph, d = max(((ph, round(max(vals) - b, 2)) for ph, vals in per_phase.items()),
                    key=lambda t: t[1])
        add(cid, name, d <= limit,
            f"各相位相对 {baseline_phase} 基线最大增量 Δ={d} {unit} @相位 {ph}（阈值 {limit}）")

    growth_check("I2", "swap growth",
                 lambda p: (p.get("swap") or {}).get("used_mb"), 256, "MB")
    growth_check("I3", "compressor growth",
                 lambda p: (p.get("mb") or {}).get("occupied_by_compressor"), 512, "MB")
    growth_check("I4", "pages purged growth",
                 lambda p: (p.get("pages") or {}).get("purged"), 20000, "页")

    # 缺口只在**相位内**判：相位之间有协议性的静置间隔（如 B/E 前静置 60s），
    # 跨相位差值不是采样失败。
    by_phase = {}
    for p in pts:  # pts 已按 ts_epoch 排序
        by_phase.setdefault(p.get("phase"), []).append(p.get("ts_epoch"))
    gaps = []
    for e_ph in by_phase.values():
        gaps += [round(b - a, 3) for a, b in zip(e_ph, e_ph[1:])
                 if a is not None and b is not None]
    max_gap = max(gaps) if gaps else 0
    counts = {ph: len(e_ph) for ph, e_ph in by_phase.items()}
    # 单点相位（基线 P0）豁免点数检查，但仅当它**确实只有 1 点**——同名相位若收了
    # 多点却不足 11，仍判点数不足（fail-closed，不给「P0」这个名字开后门）。
    short = {ph: n for ph, n in counts.items()
             if not (ph in single_point_phases and n <= 1) and n < points_per_phase - 1}
    add("I5", "sampling gap", max_gap <= 2 * interval and not short,
        f"相位内 max gap={max_gap}s (阈值 {2 * interval}s), 点数={len(pts)}, "
        f"相位点数={counts}, 不足相位={short or '无'}")

    if memsample_paths:
        voided = []
        for path in memsample_paths:
            doc = read_doc(path)
            if doc.get("voided"):
                voided.append(f"{path}: {doc.get('void_reason')}")
        add("I7", "attribution void", not voided,
            "归属失效： " + "; ".join(voided) if voided else "memsample 全部相位归属完好")

    invalid = any(c["triggered"] for c in checks)
    return invalid, checks


def cmd_verdict(args):
    pts = load_points(args.points)
    invalid, checks = evaluate(pts, args.memsample or [],
                               PROTOCOL["interval_s"], PROTOCOL["points_per_phase"])
    doc = {"protocol": PROTOCOL, "invalid": invalid, "verdict": "整轮不可判" if invalid else "可判",
           "point_count": len(pts), "attribution_checked": bool(args.memsample),
           "checks": checks}
    try:
        with open(args.out, "w") as f:
            json.dump(doc, f, ensure_ascii=False, indent=1)
    except OSError as e:
        raise ProbeError(f"无法写入 {args.out}：{type(e).__name__}: {e}") from e
    for c in checks:
        print(("TRIGGERED" if c["triggered"] else "ok       "), c["id"], c["name"], "--", c["detail"])
    print(f"== 压力观测裁决：{doc['verdict']}（{len(pts)} 点）→ {args.out}")
    return 2 if invalid else 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("point"); p.add_argument("--phase", default="P0")
    p.add_argument("--out", required=True)
    s = sub.add_parser("series"); s.add_argument("--phase", required=True)
    s.add_argument("--interval", type=int, default=PROTOCOL["interval_s"])
    s.add_argument("--duration", type=int, default=PROTOCOL["phase_duration_s"])
    s.add_argument("--out", required=True)
    v = sub.add_parser("verdict"); v.add_argument("--points", nargs="+", required=True)
    v.add_argument("--memsample", nargs="*", default=None)
    v.add_argument("--out", required=True)
    args = ap.parse_args()
    try:
        rc = {"point": cmd_point, "series": cmd_series, "verdict": cmd_verdict}[args.cmd](args)
    except ProbeError as e:
        print(f"FAIL: {e}", file=sys.stderr)
        sys.exit(2)
    sys.exit(rc)


if __name__ == "__main__":
    main()
