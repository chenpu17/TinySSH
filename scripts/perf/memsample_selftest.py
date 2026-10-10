#!/usr/bin/env python3
"""memsample v4.1 纯数据正负探针（G0 签署 §2「下次 P5 采样前」验收件）。

零外部依赖：不启动应用、不注入、不读真实 ps / 内存压力——monkeypatch
webkit_helpers / rss_kb / time，直接驱动 CLI 子命令。覆盖签署探针实证的
三类缺陷（候选集键类型、record 误判消失、app 双计）及作废/复用全路径：

  P1 candidates 排除 S0（s0 文件经磁盘 JSON 往返，str 键）
  P2 record 活候选不误判消失，total = app + helper 恰好一次
  P3 record 候选消失 → 作废 exit 2
  P4 record 候选在但 lstart 变化 → 作废 exit 2
  P5 record 出现未知新 helper（--s0 全封闭）→ 作废 exit 2
  P6 verify 应用退出后（当前表无候选）→ PASS exit 0
  P7 verify 候选仍在（同身份）→ FAIL exit 2
  P8 verify 同 PID 换身份复用 → FAIL exit 2
  P9 损坏 PID 映射（非数字键）→ 干净 SamplerError（不抛裸 ValueError）
  P10 零样本 --duration → 干净 SamplerError（不抛裸 StatisticsError）
  P11 CLI 端到端：损坏输入 → exit 2 + 单行 FAIL + 无 Traceback
  P12 非法 UTF-8 字节（UnicodeDecodeError）→ 干净 SamplerError

用法：python3 scripts/perf/memsample_selftest.py --out <results.json>
退出码：0 全 PASS / 1 有 FAIL。结果不构成性能数据，仅为仪表有效性证据。
"""

import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load_module():
    spec = importlib.util.spec_from_file_location("memsample", ROOT / "scripts/perf/memsample.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def helper(identity, rss=1024):
    return {"rss_kb": rss, "lstart": identity, "comm": "test-WebKit"}


def drive_record(module, work, cur, rss, s0=True):
    """跑一轮 record（1 样本）；cur/rss 为合成进程表与目标 RSS。"""
    cands = work / "cands.json"
    cands.write_text(json.dumps({202: helper("new")}))  # 磁盘 JSON 往返 → str 键
    out = work / "sample.json"
    ns = SimpleNamespace(cands=str(cands), s0=str(work / "s0.json") if s0 else None,
                         app_pid=303, duration=1, interval=1, phase="B", out=str(out))
    with patch.object(module, "webkit_helpers", return_value=cur), \
         patch.object(module, "rss_kb", return_value=rss), \
         patch.object(module.time, "monotonic", side_effect=[0, 0, 0, 2]), \
         patch.object(module.time, "sleep"):
        code = module.cmd_record(ns)
    return code, json.loads(out.read_text())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    module = load_module()
    checks = []

    def check(name, ok, detail):
        checks.append({"name": name, "pass": bool(ok), "detail": detail})
        print(("PASS" if ok else "FAIL"), name, "--", detail)

    with tempfile.TemporaryDirectory() as td, \
         contextlib.redirect_stdout(io.StringIO()), \
         contextlib.redirect_stderr(io.StringIO()):
        work = Path(td)
        # P1 候选集排除 S0（s0 文件真实经磁盘往返）
        (work / "s0.json").write_text(json.dumps({101: helper("old")}))
        cands_out = work / "cands_cli.json"
        with patch.object(module, "webkit_helpers",
                          return_value={101: helper("old"), 202: helper("new")}):
            module.cmd_candidates(SimpleNamespace(s0=str(work / "s0.json"), out=str(cands_out)))
        got = sorted(int(k) for k in json.loads(cands_out.read_text()))
        check("P1 candidates excludes S0", got == [202], f"got {got}, expect [202]")

        # P2 活候选不误判消失 + app 只计一次
        code, res = drive_record(module, work, {101: helper("old"), 202: helper("new")},
                                 rss=1024, s0=True)
        s0p = res["samples"][0]
        check("P2a record keeps live candidate",
              code == 0 and not res["voided"],
              f"exit={code} voided={res['voided']} reason={res['void_reason']}")
        check("P2b app counted once", s0p["total_mb"] == 2.0,
              f"total_mb={s0p['total_mb']} expect 2.0 (app 1MiB + helper 1MiB)")

        # P3 候选消失
        code, res = drive_record(module, work, {101: helper("old")}, rss=1024)
        check("P3 record voids disappeared candidate",
              code == 2 and res["voided"] and "disappeared" in (res["void_reason"] or ""),
              f"exit={code} reason={res['void_reason']}")

        # P4 候选在但换身份
        code, res = drive_record(module, work, {101: helper("old"), 202: helper("reused-identity")},
                                 rss=1024)
        check("P4 record voids identity change",
              code == 2 and res["voided"] and "lstart" in (res["void_reason"] or ""),
              f"exit={code} reason={res['void_reason']}")

        # P5 未知新 helper（--s0 全封闭）
        code, res = drive_record(module, work, {101: helper("old"), 202: helper("new"),
                                                999: helper("intruder")}, rss=1024)
        check("P5 record voids unknown new helper",
              code == 2 and res["voided"] and "new webkit helper" in (res["void_reason"] or ""),
              f"exit={code} reason={res['void_reason']}")

        cands = work / "cands.json"
        # P6 应用退出后核验通过
        with patch.object(module, "webkit_helpers", return_value={101: helper("old")}):
            code = module.cmd_verify(SimpleNamespace(cands=str(cands)))
        check("P6 verify passes after clean exit", code == 0, f"exit={code} expect 0")

        # P7 候选仍在（同身份）
        with patch.object(module, "webkit_helpers", return_value={202: helper("new")}):
            code = module.cmd_verify(SimpleNamespace(cands=str(cands)))
        check("P7 verify fails on live residue", code == 2, f"exit={code} expect 2")

        # P8 同 PID 换身份复用
        with patch.object(module, "webkit_helpers",
                          return_value={202: helper("different-start")}):
            code = module.cmd_verify(SimpleNamespace(cands=str(cands)))
        check("P8 verify fails on pid reuse", code == 2, f"exit={code} expect 2")

        # P9 损坏的 PID 映射（非数字键）→ 干净 SamplerError，不抛裸 ValueError
        bad = work / "bad_keys.json"
        bad.write_text(json.dumps({"not-a-pid": helper("x")}))
        try:
            module.load_pid_map(str(bad))
            err9 = None
        except module.SamplerError as e:
            err9 = str(e)
        except Exception as e:  # 裸 ValueError 等 → 未收口
            err9 = f"<{type(e).__name__}> {e}"
        check("P9 malformed pid-map key -> SamplerError",
              err9 is not None and "非数字键" in err9, f"err={err9}")

        # P10 零样本 duration → 干净 SamplerError，不抛裸 StatisticsError
        ns0 = SimpleNamespace(cands=str(cands), s0=None, app_pid=303,
                              duration=0, interval=1, phase="B", out=str(work / "z.json"))
        try:
            with patch.object(module.time, "monotonic", return_value=0), \
                 patch.object(module.time, "sleep"):
                module.cmd_record(ns0)
            err10 = None
        except module.SamplerError as e:
            err10 = str(e)
        except Exception as e:  # 裸 StatisticsError 等 → 未收口
            err10 = f"<{type(e).__name__}> {e}"
        check("P10 zero-sample duration -> SamplerError",
              err10 is not None and "未产生任何样本" in err10, f"err={err10}")

        # P12 非法 UTF-8 字节 → UnicodeDecodeError（ValueError 子类，非 JSONDecodeError）
        badenc = work / "bad_enc.json"
        badenc.write_bytes(b"\xff\xfe\x00garbage")
        try:
            module.load_pid_map(str(badenc))
            err12 = None
        except module.SamplerError as e:
            err12 = str(e)
        except Exception as e:  # 裸 UnicodeDecodeError → 未收口
            err12 = f"<{type(e).__name__}> {e}"
        check("P12 bad-encoding pid map -> SamplerError",
              err12 is not None and "无法读取 PID 映射" in err12, f"err={err12}")

    # P11 CLI 端到端：损坏输入 → exit 2 + stderr 单行 FAIL + 无 Traceback
    with tempfile.TemporaryDirectory() as td:
        bad = Path(td) / "bad.json"
        bad.write_text("{ not json")
        r = subprocess.run([sys.executable, str(ROOT / "scripts/perf/memsample.py"),
                            "record", "--app-pid", "1", "--cands", str(bad),
                            "--phase", "B", "--out", str(Path(td) / "o.json")],
                           capture_output=True, text=True)
    check("P11 CLI malformed input exits 2 cleanly",
          r.returncode == 2 and "Traceback" not in r.stderr
          and r.stderr.strip().startswith("FAIL:"),
          f"rc={r.returncode} stderr={r.stderr.strip()[:80]!r}")

    report = {"sampler": "memsample v4.1", "scope": "mocked data only; instrument validity evidence",
              "checks": checks, "all_pass": all(c["pass"] for c in checks)}
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(f"== memsample selftest: {sum(c['pass'] for c in checks)}/{len(checks)} PASS -> {args.out}")
    return 0 if report["all_pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
