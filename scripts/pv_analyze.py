#!/usr/bin/env python3
"""PV 数据分析脚本 —— validation-plan §5/§6 的工程实现（辅助计算；最终判定归 §6 决策评审）。

输入：每位参与者一个目录（默认 pv-data/P01 …），内含
  audit.db          ~ /.tinyssh/tinyssh.db 的拷贝（audit_events 表）
  coding.csv        编码表（段窗口/任务完成/复述/反模式/上下文搬运），模板: --init-templates
  questionnaire.csv 当场问卷（注意力投入 ×3 + 偏好）
  followup.csv      一周回访（回用 + 任务清单 + 新任务中是否交接）

输出：每人系统日志指标 + 汇总 + 对照预登记阈值（--n）的 gate 判据矩阵与出口建议。
审计哈希链校验：--verify-chain（sha256(prev_hash|ts|actor|agent|action|sid|cmd|payload|approval_id)，
与 crates/audit 的实现一致，用于证明回收数据未被事后改动）。

仅用 Python 标准库。
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

AUDIT_ACTIONS_SESSION = {"session_created", "session_reconnect", "session_closed"}

CODING_HEADER = [
    "pid", "s1_start", "s1_end", "s2_start", "s2_end", "s3_start", "s3_end",
    "task_a_done", "task_b_done", "task_c_done",          # 0/1，判据见 session-kit §7
    "retell_accurate",                                     # 0/1 复述准确（对照审计）
    "context_copy_s1", "context_copy_s23",                 # 上下文搬运次数（录屏编码）
    "s3_handoff_used", "s3_handoff_step", "s3_handoff_timing",  # 编码员判定（audit 数字为佐证）
    "anti_full_approve", "anti_interrupt_complaint", "anti_avoid_handoff",  # 0/1 反模式
    "notes",
]
QUESTIONNAIRE_HEADER = ["pid", "q1_attention", "q2_attention", "q3_control", "preference"]
FOLLOWUP_HEADER = ["pid", "reused", "reuse_tasks", "reuse_handoff", "no_use_reason"]


def parse_ts(s: str) -> int | None:
    """ISO 时间 → epoch 毫秒；空值返回 None。"""
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"):
        try:
            return int(datetime.strptime(s, fmt).timestamp() * 1000)
        except ValueError:
            continue
    raise SystemExit(f"无法解析时间: {s!r}（支持 ISO YYYY-MM-DD HH:MM[:SS]）")


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        return [dict(r) for r in csv.DictReader(f)]


def init_templates(d: Path) -> None:
    d.mkdir(parents=True, exist_ok=True)
    for name, header in (("coding.csv", CODING_HEADER), ("questionnaire.csv", QUESTIONNAIRE_HEADER), ("followup.csv", FOLLOWUP_HEADER)):
        (d / name).write_text(",".join(header) + "\n", encoding="utf-8")
    print(f"已生成模板到 {d}/：coding.csv / questionnaire.csv / followup.csv（列名勿改）")


def verify_chain(conn: sqlite3.Connection) -> list[str]:
    """重算哈希链；与 crates/audit/src/lib.rs append() 的哈希输入逐字段一致。返回错误列表。"""
    errors: list[str] = []
    prev = ""
    rows = conn.execute(
        "SELECT seq, ts, actor_kind, agent_id, action, session_id, command, payload_json, approval_id, prev_hash, hash"
        " FROM audit_events ORDER BY seq ASC"
    ).fetchall()
    for seq, ts, actor, agent, action, sid, cmd, payload, approval_id, prev_hash, h in rows:
        if (prev_hash or "") != prev:
            errors.append(f"seq={seq}: prev_hash 与上一行不符")
        material = "".join([
            prev_hash or "", str(ts), actor, agent or "", action, sid or "",
            cmd or "", payload or "", approval_id or "",
        ])
        expect = hashlib.sha256(material.encode()).hexdigest()
        if expect != (h or ""):
            errors.append(f"seq={seq}: 哈希不匹配（数据被改动？）")
        prev = h or ""
    return errors


class PhaseWindows:
    """按 coding.csv 的段起止时间把审计事件归入 S1/S2/S3。"""

    def __init__(self, row: dict):
        self.spans = {}
        for seg in ("s1", "s2", "s3"):
            a, b = parse_ts(row.get(f"{seg}_start", "")), parse_ts(row.get(f"{seg}_end", ""))
            if a is not None and b is not None:
                self.spans[seg.upper()] = (a, b)

    def of(self, ts_ms: int) -> str | None:
        for seg, (a, b) in self.spans.items():
            if a <= ts_ms <= b:
                return seg
        return None


def norm_decision(action: str, payload: dict) -> str | None:
    # v1.18 的前缀表（approved/denied/edited）与 core 审计的 Debug 串（"Approve"/
    # "ApproveEdited(\"…\")"/"Deny"）一个都对不上——真实沙箱数据 approved/edited
    # 恒为 0。core 改为小写 {"decision": "approve"|"approve_edited"|"deny"} 后，
    # 这里显式映射两种格式（新串精确、旧 Debug 串按前缀兼容，PV R1 配套）。
    d = str(payload.get("decision", "")).lower()
    if d.startswith("approve_edited") or d.startswith("approveedited"):
        return "edited"
    if d.startswith("approve"):
        return "approved"
    if d.startswith("deny"):
        return "denied"
    if action == "approval_denied":
        return "denied"
    return None


def audit_metrics(db: Path, windows: PhaseWindows) -> dict:
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    out: dict = {}
    try:
        rows = conn.execute(
            "SELECT ts, actor_kind, action, session_id, command, payload_json, approval_id FROM audit_events ORDER BY seq"
        ).fetchall()
    finally:
        conn.close()

    def bucket(seg: str | None) -> dict:
        return out.setdefault(seg, {"exec_human": 0, "exec_agent": 0, "send_keys": 0,
                                    "approval_requested": 0, "approval_decided": 0,
                                    "approved": 0, "denied": 0, "edited": 0,
                                    "takeover": 0, "handback": 0, "exec_cancel": 0})

    pending_req: dict[str, int] = {}
    latencies: list[int] = []
    for ts, actor, action, sid, cmd, payload_s, approval_id in rows:
        try:
            payload = json.loads(payload_s) if payload_s else {}
        except json.JSONDecodeError:
            payload = {}
        seg = windows.of(ts)
        b = bucket(seg)
        if action == "exec":
            key = "exec_human" if actor == "human" else "exec_agent"
            b[key] += 1
        elif action == "send_keys":
            b["send_keys"] += 1
        elif action == "approval_requested" and approval_id:
            b["approval_requested"] += 1
            pending_req[approval_id] = ts
        elif action == "approval_decision":
            b["approval_decided"] += 1
            d = norm_decision(action, payload)
            if d:
                b[d] += 1
            if approval_id and approval_id in pending_req:
                latencies.append((seg, ts - pending_req.pop(approval_id)))
        elif action == "approval_denied":
            b["approval_decided"] += 1
            b["denied"] += 1
        elif action == "takeover":
            b["takeover"] += 1
        elif action == "handback":
            b["handback"] += 1
        elif action == "exec_cancel":
            b["exec_cancel"] += 1

    lat = [ms for _, ms in latencies]
    out["approval_latency_ms_median"] = int(sorted(lat)[len(lat) // 2]) if lat else None
    out["s3_handoff_signal"] = (
        out.get("S3", {}).get("takeover", 0) > 0
        or out.get("S3", {}).get("approval_decided", 0) > 0
        or out.get("S3", {}).get("handback", 0) > 0
    )
    return out


def to_int(row: dict, key: str, default: int = 0) -> int:
    v = (row.get(key) or "").strip()
    return int(v) if v else default


def analyze_participant(pdir: Path) -> dict:
    r: dict = {"pid": pdir.name, "dir": pdir}
    coding_rows = read_csv(pdir / "coding.csv") if (pdir / "coding.csv").exists() else []
    row = coding_rows[0] if coding_rows else {}
    r["coding"] = row
    r["windows"] = PhaseWindows(row)
    if (pdir / "audit.db").exists():
        r["audit"] = audit_metrics(pdir / "audit.db", r["windows"])
    else:
        r["audit"] = None
    if (pdir / "questionnaire.csv").exists():
        qs = read_csv(pdir / "questionnaire.csv")
        r["questionnaire"] = qs[0] if qs else {}
    if (pdir / "followup.csv").exists():
        fs = read_csv(pdir / "followup.csv")
        r["followup"] = fs[0] if fs else {}
    return r


def gate_report(parts: list[dict], n: int, verbose: bool) -> str:
    lines: list[str] = []
    def c(x):  # ⌈x⌉
        return math.ceil(x)

    n_done_prefer = sum(
        1 for p in parts
        if to_int(p["coding"], "task_a_done") and to_int(p["coding"], "task_b_done")
        and to_int(p["coding"], "task_c_done")
        and (p.get("questionnaire", {}).get("preference", "").strip() == "prototype")
    )
    n_retell = sum(1 for p in parts if to_int(p["coding"], "retell_accurate"))
    n_reuse = sum(1 for p in parts if (p.get("followup", {}).get("reused", "").strip() == "1"))
    n_reuse_handoff = sum(1 for p in parts if (p.get("followup", {}).get("reuse_handoff", "").strip() == "1"))
    n_s3_handoff = sum(1 for p in parts if to_int(p["coding"], "s3_handoff_used"))
    anti = {
        "全批": sum(1 for p in parts if to_int(p["coding"], "anti_full_approve")),
        "抱怨打断": sum(1 for p in parts if to_int(p["coding"], "anti_interrupt_complaint")),
        "回避交接": sum(1 for p in parts if to_int(p["coding"], "anti_avoid_handoff")),
    }
    n_context_s1 = sum(to_int(p["coding"], "context_copy_s1") for p in parts)
    n_context_s23 = sum(to_int(p["coding"], "context_copy_s23") for p in parts)

    lines.append("== gate 判据矩阵（validation-plan §6，阈值随 N 预登记）==")
    lines.append(f"N={n}  ⌈0.6N⌉={c(0.6*n)}  N/2={n/2:g}  ⌈0.4N⌉={c(0.4*n)}")
    lines.append(f"① 完成全部任务且总体偏好原型 : {n_done_prefer}/{n}  (需 ≥ {c(0.6*n)})  {'✓' if n_done_prefer >= c(0.6*n) else '✗'}")
    lines.append(f"② 复述准确                   : {n_retell}/{n}  (需 > {n/2:g})  {'✓' if n_retell > n/2 else '✗'}")
    lines.append(f"③ 一周回用                   : {n_reuse}/{n}  (需 ≥ {c(0.4*n)})  {'✓' if n_reuse >= c(0.4*n) else '✗'}")
    lines.append(f"④ 其中新任务自发使用交接闭环 : {n_reuse_handoff}  (需 ≥ 2)  {'✓' if n_reuse_handoff >= 2 else '✗'}")
    lines.append(f"⑤ S3 自发交接（编码判定）    : {n_s3_handoff}/{n}")
    lines.append(f"⑥ 上下文搬运次数 S1 vs S2/S3 : {n_context_s1} vs {n_context_s23}")
    anti_any = [k for k, v in anti.items() if v > 0]
    lines.append(f"⑦ 反模式信号                 : " + ("、".join(f"{k}×{anti[k]}" for k in anti) + (" ← ⚠ 反模式优先" if anti_any else " 无")))

    lines.append("")
    lines.append("== 出口建议（辅助计算，最终判定归决策评审会）==")
    if anti_any:
        lines.append("→ 调整交互再测：出现反模式信号，按判据优先级否决偏好判据（§6）。")
    elif (n_done_prefer >= c(0.6 * n) and n_retell > n / 2 and n_reuse >= c(0.4 * n) and n_reuse_handoff >= 2):
        lines.append("→ 进入 V1：①②③④ 全部达标且无反模式。")
    elif n_s3_handoff * 2 <= n and n_retell > n / 2:
        lines.append("→ 倾向「调整交互再测」：自发使用率低但理解与完成度好；或「重新评估假设」——需访谈确认不采用是否非交互原因（脚本无法判定）。")
    else:
        lines.append("→ 判据不足或存在缺口：请结合逐人指标与访谈记录人工归口到 §6 三出口。")

    if verbose:
        lines.append("")
        lines.append("== 逐人指标 ==")
        for p in parts:
            lines.append(f"--- {p['pid']} ---")
            a = p.get("audit")
            if a:
                for seg in ("S1", "S2", "S3"):
                    b = a.get(seg)
                    if b:
                        lines.append(
                            f"  {seg}: exec(人/Agent)={b['exec_human']}/{b['exec_agent']}"
                            f" 键入={b['send_keys']} 审批(请/决)={b['approval_requested']}/{b['approval_decided']}"
                            f" (批/拒/编)={b['approved']}/{b['denied']}/{b['edited']}"
                            f" 接管/交还={b['takeover']}/{b['handback']} 打断={b['exec_cancel']}"
                        )
                lat = a.get("approval_latency_ms_median")
                if lat is not None:
                    lines.append(f"  审批延迟中位: {lat} ms")
                lines.append(f"  S3 系统日志交接佐证: {'有' if a.get('s3_handoff_signal') else '无'}（判定以编码为准）")
            else:
                lines.append("  （无 audit.db）")
            q = p.get("questionnaire", {})
            if q:
                lines.append(f"  问卷: 注意力 {q.get('q1_attention','?')}/{q.get('q2_attention','?')}/{q.get('q3_control','?')}  偏好={q.get('preference','?')}")
            f = p.get("followup", {})
            if f:
                lines.append(f"  回访: 回用={f.get('reused','?')} 新任务交接={f.get('reuse_handoff','?')} 未用原因={f.get('no_use_reason','')}")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", default="pv-data", help="参与者数据根目录（含 P01/…）")
    ap.add_argument("--n", type=int, help="预登记的参与者数 N")
    ap.add_argument("--verify-chain", action="store_true", help="校验各 audit.db 的哈希链")
    ap.add_argument("--init-templates", action="store_true", help="在 --data-dir 下生成三张 CSV 模板后退出")
    ap.add_argument("--verbose", action="store_true", help="输出逐人系统日志指标")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    if args.init_templates:
        init_templates(data_dir)
        return 0

    pdirs = sorted(d for d in data_dir.iterdir() if d.is_dir()) if data_dir.exists() else []
    if not pdirs:
        ap.error(f"{data_dir}/ 下没有参与者目录（每个参与者一个子目录，内含 audit.db 与三张 CSV）")
    if not args.n:
        ap.error("必须提供 --n（开测前锁定的 N）——gate 阈值依赖它")

    chain_errors: dict[str, list[str]] = {}
    if args.verify_chain:
        for d in pdirs:
            db = d / "audit.db"
            if db.exists():
                conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
                try:
                    errs = verify_chain(conn)
                finally:
                    conn.close()
                if errs:
                    chain_errors[d.name] = errs
        if chain_errors:
            print("⚠ 审计哈希链校验失败（数据可能被事后改动）：", file=sys.stderr)
            for pid, errs in chain_errors.items():
                for e in errs:
                    print(f"  {pid}: {e}", file=sys.stderr)
            return 2
        print(f"哈希链校验通过（{len(pdirs)} 份 audit.db，逐行 sha256 重算一致）")

    parts = [analyze_participant(d) for d in pdirs]
    print(f"参与者：{len(parts)} 人（N={args.n}）")
    if len(parts) < 6:
        print(f"⚠ 实到 {len(parts)} < 最少开测 6 人（validation-plan §2）", file=sys.stderr)
    print()
    print(gate_report(parts, args.n, args.verbose))
    return 0


if __name__ == "__main__":
    sys.exit(main())
