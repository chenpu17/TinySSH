#!/usr/bin/env python3
"""vmstat_probe v1 纯数据正负探针（签署 §3「预先登记失效判据」验收件）。

零外部依赖：不调用 vm_stat/sysctl/memory_pressure，直接构造合成观测点驱动
`evaluate()`，对每条预登记判据 I1–I8 各验一正一反，外加口径回归（V11/V14/V15/
V16–V19）。夹具一律是**完整一轮**（P0/warmup/B/load/E 全在场）——相位完备本身
是 I8 的要求，残缺夹具会掩盖判据交互。

  V1  健康整轮（五相位齐、计数平稳）→ invalid=False
  V2  I1 压力等级 critical（level=4）→ 触发
  V3  I2 swap 增长 300MB（阈值 256）→ 触发
  V4  I3 压缩器增长 600MB（阈值 512）→ 触发
  V5  I4 页回收增长 30000 页（阈值 20000）→ 触发
  V6  I5 采样缺口 30s（阈值 2×interval=10s）→ 触发
  V7  I5 相位点数不足（B=10 < 12-1）→ 触发
  V8  I6 ts_epoch 非严格递增 → 触发
  V9  I7 memsample 归属失效（voided=true）→ 触发
  V10 空点集 → 不可判
  V11 相位间静置间隔（数百秒）**不得**触发 I5（回归：缺口只相位内判）
  V12 I8 必需字段缺失（pressure_level=None）→ 触发（缺数据不放过）
  V13 I8 缺 P0 基线相位 → 触发
  V14 I2 逐相位：load 相位尖峰 +300MB 且 E 回落至基线 → 仍触发
  V15 I6 在**排序前**判：原始顺序乱序、排序后单调 → 仍触发
  V16 I8 缺**整段相位**（无 load 无 E）→ 触发（回归：不校验相位集就是真洞）
  V17 I8 字段类型非法（pressure_level="4" 字符串）→ 触发且不抛裸 traceback
  V18 I8 点位非 JSON 对象（int）→ 触发且不抛裸 traceback
  V19 I7 未喂入 memsample → 触发（回归：缺归属不得按未触发放过）

用法：python3 scripts/perf/vmstat_selftest.py --out <results.json>
退出码：0 全 PASS / 1 有 FAIL。结果不构成压力数据，仅为判据有效性证据。
"""

import argparse
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]

# 完整一轮的相位集与起点（相位间留出协议性静置间隔；缺口只按相位内判）
PHASES = (("P0", 1, 0.0), ("warmup", 12, 5.0), ("B", 12, 70.0),
          ("load", 12, 135.0), ("E", 12, 440.0))


def load_module():
    spec = importlib.util.spec_from_file_location(
        "vmstat_probe", ROOT / "scripts/perf/vmstat_probe.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def pt(phase, t, level=1, swap=0.0, comp=1000.0, purged=0):
    return {"phase": phase, "ts_epoch": t, "ts_mono": t, "pressure_level": level,
            "swap": {"used_mb": swap}, "mb": {"occupied_by_compressor": comp},
            "pages": {"purged": purged}, "counters": {}, "free_pct": 50}


def series(phase, n=12, t0=0.0, step=5.0, **kw):
    return [pt(phase, t0 + i * step, **kw) for i in range(n)]


def full(**over):
    """完整一轮。over[phase] = 该相位的点位 kwargs（dict）或整段点列表（list）。"""
    pts = []
    for ph, n, t0 in PHASES:
        spec = over.get(ph)
        if isinstance(spec, list):
            pts += spec
        else:
            pts += series(ph, n=n, t0=t0, **(spec or {}))
    return pts


def triggered(checks, cid):
    return next(c["triggered"] for c in checks if c["id"] == cid)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    m = load_module()
    checks = []

    def check(name, ok, detail):
        checks.append({"name": name, "pass": bool(ok), "detail": detail})
        print(("PASS" if ok else "FAIL"), name, "--", detail)

    # 健康 memsample 输出（I7 现在要求必须喂入，否则不可判）
    msdir = Path(tempfile.mkdtemp(prefix="vmstat-selftest-"))
    healthy_ms = msdir / "healthy.json"
    healthy_ms.write_text(json.dumps({"voided": False}))

    def ev(pts, memsample=None):
        return m.evaluate(pts, [str(healthy_ms)] if memsample is None else memsample,
                          m.PROTOCOL["interval_s"], m.PROTOCOL["points_per_phase"])

    # V1 健康整轮（I1–I8 全在场 = 8 条）
    inv, ck = ev(full())
    check("V1 healthy round is judgeable", inv is False and len(ck) == 8,
          f"invalid={inv} checks={len(ck)} (I1–I8)")

    # V2 I1 压力 critical
    inv, ck = ev(full(warmup={"level": 4}))
    check("V2 I1 pressure critical triggers", inv and triggered(ck, "I1"),
          f"invalid={inv}")

    # V3 I2 swap 增长 300MB
    inv, ck = ev(full(E={"swap": 300}))
    check("V3 I2 swap growth triggers", inv and triggered(ck, "I2"), f"invalid={inv}")

    # V4 I3 压缩器增长 600MB
    inv, ck = ev(full(E={"comp": 1600}))
    check("V4 I3 compressor growth triggers", inv and triggered(ck, "I3"), f"invalid={inv}")

    # V5 I4 页回收增长 30000
    inv, ck = ev(full(E={"purged": 30000}))
    check("V5 I4 pages purged triggers", inv and triggered(ck, "I4"), f"invalid={inv}")

    # V6 I5 采样缺口 30s（点数仍为 12）
    inv, ck = ev(full(B=series("B", n=11, t0=70.0) + [pt("B", 150.0)]))
    check("V6 I5 sampling gap triggers", inv and triggered(ck, "I5"), f"invalid={inv}")

    # V7 I5 相位点数不足
    inv, ck = ev(full(B=series("B", n=10, t0=70.0)))
    check("V7 I5 short phase triggers", inv and triggered(ck, "I5"), f"invalid={inv}")

    # V8 I6 ts_epoch 非严格递增（重复时间戳）
    bad_time = full()
    bad_time[3]["ts_epoch"] = bad_time[2]["ts_epoch"]
    inv, ck = ev(bad_time)
    check("V8 I6 non-monotonic triggers", inv and triggered(ck, "I6"), f"invalid={inv}")

    # V9 I7 memsample 归属失效
    with tempfile.TemporaryDirectory() as td:
        voided = Path(td) / "B.json"
        voided.write_text(json.dumps({"voided": True, "void_reason": "candidate 202 disappeared"}))
        inv, ck = ev(full(), memsample=[str(voided)])
    check("V9 I7 attribution void triggers", inv and triggered(ck, "I7"), f"invalid={inv}")

    # V10 空点集
    inv, ck = ev([])
    check("V10 empty points unjudgeable", inv and triggered(ck, "I5"), f"invalid={inv}")

    # V11 相位间静置间隔（数百秒）**不得**触发 I5（回归：缺口只相位内判）
    settle = full(load=series("load", n=12, t0=600.0), E=series("E", n=12, t0=900.0))
    inv, ck = ev(settle)
    check("V11 inter-phase settle gap does not trigger", not triggered(ck, "I5"),
          f"invalid={inv}, I5={triggered(ck, 'I5')}")

    # V12 I8 必需字段缺失（pressure_level=None）→ 不可判，不当作「未超阈值」放过
    broken = full()
    broken[6]["pressure_level"] = None
    inv, ck = ev(broken)
    check("V12 I8 missing field unjudgeable", inv and triggered(ck, "I8"), f"invalid={inv}")

    # V13 I8 缺 P0 基线相位 → 不可判
    inv, ck = ev([p for p in full() if p["phase"] != "P0"])
    check("V13 I8 missing baseline phase unjudgeable",
          inv and triggered(ck, "I8"), f"invalid={inv}")

    # V14 I2 逐相位：load 相位尖峰 +300MB、E 回落至基线 → 仍触发（全局末点差=0 会漏）
    inv, ck = ev(full(load={"swap": 300}))
    check("V14 I2 per-phase spike triggers", inv and triggered(ck, "I2"),
          f"invalid={inv}（全局末点 Δ=0，逐相位 Δ=300）")

    # V15 I6 在排序前判：原始顺序乱序、排序后单调 → 仍触发
    disordered = full()
    disordered[1], disordered[2] = disordered[2], disordered[1]
    inv, ck = ev(disordered)
    check("V15 I6 disorder before sort triggers", inv and triggered(ck, "I6"),
          f"invalid={inv}（排序后单调，仅原始顺序可判）")

    # V16 I8 缺整段相位（无 load 无 E）→ 触发（回归：不校验相位集就会静默判「可判」）
    inv, ck = ev([p for p in full() if p["phase"] not in ("load", "E")])
    check("V16 I8 missing whole phases unjudgeable", inv and triggered(ck, "I8"),
          f"invalid={inv}, I8={next(c['detail'] for c in ck if c['id'] == 'I8')[:60]}")

    # V17 I8 字段类型非法（字符串 pressure_level）→ 触发且不抛裸 traceback
    badtype = full()
    badtype[6]["pressure_level"] = "4"
    try:
        inv, ck = ev(badtype)
        err17 = None
    except Exception as e:
        inv, ck, err17 = None, [], f"<{type(e).__name__}> {e}"
    check("V17 I8 bad field type unjudgeable (no traceback)",
          err17 is None and inv and triggered(ck, "I8"),
          f"err={err17} invalid={inv}")

    # V18 I8 点位非 JSON 对象 → 触发且不抛裸 traceback
    try:
        inv, ck = ev(full() + [1, 2])
        err18 = None
    except Exception as e:
        inv, ck, err18 = None, [], f"<{type(e).__name__}> {e}"
    check("V18 I8 non-object point unjudgeable (no traceback)",
          err18 is None and inv and triggered(ck, "I8"), f"err={err18} invalid={inv}")

    # V19 I7 未喂入 memsample → 触发（回归：缺归属不得按未触发放过）
    inv, ck = ev(full(), [])
    check("V19 I7 missing attribution unjudgeable",
          inv and triggered(ck, "I7"), f"invalid={inv}")

    report = {"probe": "vmstat_probe v1", "scope": "synthetic data only; criteria validity evidence",
              "protocol": m.PROTOCOL, "checks": checks,
              "all_pass": all(c["pass"] for c in checks)}
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(f"== vmstat selftest: {sum(c['pass'] for c in checks)}/{len(checks)} PASS -> {args.out}")
    return 0 if report["all_pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
