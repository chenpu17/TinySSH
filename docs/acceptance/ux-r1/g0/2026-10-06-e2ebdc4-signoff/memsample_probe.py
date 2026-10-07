#!/usr/bin/env python3
"""Pure mocked-data probes; no native app, input, ps, or memory-pressure commands.

Run from repo root: python3 <this-file> --out /tmp/memsample-probe.json
Reports observations rather than treating known defects as passing acceptance.
"""
import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[5]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    spec = importlib.util.spec_from_file_location("memsample", ROOT / "scripts/perf/memsample.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    helper = lambda identity: {"rss_kb": 1024, "lstart": identity, "comm": "test-WebKit"}
    report = {"source_commit": "e2ebdc4401e6828bb00eb1dc75826a6707262146",
              "scope": "mocked data only; findings, not acceptance PASS"}
    with tempfile.TemporaryDirectory() as td, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        work = Path(td)
        s0, cands, sample = (work / name for name in ("s0.json", "cands.json", "sample.json"))
        s0.write_text(json.dumps({101: helper("old")}))
        with patch.object(module, "webkit_helpers", return_value={101: helper("old"), 202: helper("new")}):
            module.cmd_candidates(SimpleNamespace(s0=str(s0), out=str(cands)))
        report["candidate_set"] = {"actual": sorted(json.loads(cands.read_text())), "expected": ["202"]}
        cands.write_text(json.dumps({202: helper("new")}))
        record_args = SimpleNamespace(cands=str(cands), s0=str(s0), app_pid=303,
                                      duration=1, interval=1, phase="B", out=str(sample))
        with patch.object(module, "webkit_helpers", return_value={101: helper("old"), 202: helper("new")}), patch.object(module, "rss_kb", return_value=1024), patch.object(module.time, "monotonic", side_effect=[0, 0, 0, 2]), patch.object(module.time, "sleep"):
            code = module.cmd_record(record_args)
        result = json.loads(sample.read_text())
        report["valid_candidate"] = {"return_code": code, "voided": result["voided"], "reason": result["void_reason"], "expected_voided": False}
        with patch.object(module, "webkit_helpers", return_value={202: helper("different-start")}):
            code = module.cmd_verify(SimpleNamespace(cands=str(cands)))
        report["reused_pid_at_exit"] = {"return_code": code, "expected_return_code": 2}
        # Normalize only JSON input keys in the harness to expose independent total arithmetic.
        load_json = json.load
        def normalized_load(stream):
            return {int(k): v for k, v in load_json(stream).items()}
        with patch.object(module.json, "load", side_effect=normalized_load), patch.object(module, "webkit_helpers", return_value={101: helper("old"), 202: helper("new")}), patch.object(module, "rss_kb", return_value=1024), patch.object(module.time, "monotonic", side_effect=[0, 0, 0, 2]), patch.object(module.time, "sleep"):
            module.cmd_record(record_args)
        result = json.loads(sample.read_text())
        report["rss_sum_after_key_normalization_in_harness"] = {"actual_mb": result["samples"][0]["total_mb"], "expected_mb": 2.0, "note": "app 1 MiB + helper 1 MiB; app counted twice"}
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
