#!/usr/bin/env python3
"""R44（§10.2 回退演练）：旧 UI ↔ 当前核心的 **Tauri 命令契约**静态核对。

回退到旧界面的前提是：旧 UI 调用的每个命令在当前核心里仍然存在，且参数名仍能被
解析。本脚本对 `old-ui-baseline-g0` 工作树里的前端源码与 `src-tauri/src/main.rs`
的 `#[tauri::command]` 注册表做**名称层面**的集合核对：

  1. 旧 UI 调用的命令 ⊆ 当前 `generate_handler!` 注册的命令；
  2. 旧 UI 每个调用点传入的对象键（camelCase）都能对上一个 Rust 参数名（snake_case），
     注入参数（State/AppHandle/Window/Webview）与 Channel 重命名除外。

**能证明什么 / 不能证明什么**：名称与参数键层面的兼容是回退可行的必要条件，**不是**
充分条件——参数/返回值的**形状**（结构体字段）变化本脚本看不出，须由原生 e2e 复验。
故本脚本只主张「命令与参数名契约未破」，不主张「旧 UI 一定能跑」。

用法：scripts/check-old-ui-contract.py [--old-ui <dir>] [--core <main.rs>]
退出码：0 = 通过；1 = 发现缺口（列出明细）。
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# 由 Tauri 注入、前端不传的参数名
INJECTED = {"state", "app", "app_handle", "window", "webview", "webview_window", "window_"}


def snake_to_camel(s: str) -> str:
    head, *rest = s.split("_")
    return head + "".join(w.capitalize() for w in rest)


def parse_old_ui(root: Path) -> tuple[set[str], dict[str, set[str]]]:
    """返回（命令集合, {命令: 传入的对象键集合})。只统计对象字面量实参的调用点。"""
    cmds: set[str] = set()
    argkeys: dict[str, set[str]] = {}
    call_re = re.compile(r"""invoke\(\s*['"]([A-Za-z_0-9]+)['"]""")
    for src in root.rglob("*.ts*"):
        text = src.read_text(encoding="utf-8", errors="replace")
        for m in call_re.finditer(text):
            cmd = m.group(1)
            cmds.add(cmd)
            # 实参是否以对象字面量开始？
            k = m.end()
            while k < len(text) and text[k] in " \t\n":
                k += 1
            if k >= len(text) or text[k] != ",":
                continue
            k += 1
            while k < len(text) and text[k] in " \t\n":
                k += 1
            if k >= len(text) or text[k] != "{":
                continue  # 变量实参 / 无实参 —— 静态不可知，跳过
            depth = 0
            start = k
            for j in range(k, len(text)):
                if text[j] == "{":
                    depth += 1
                elif text[j] == "}":
                    depth -= 1
                    if depth == 0:
                        k = j
                        break
            body = text[start + 1 : k]
            # 取顶层键（depth==1）
            keys: set[str] = set()
            d = 0
            for km in re.finditer(r"[{}\[\]()]|([A-Za-z_$][\w$]*)\s*:", body):
                tok = km.group(0)
                if tok in "{[(":
                    d += 1
                elif tok in "}])":
                    d -= 1
                elif km.group(1) and d == 0:
                    # 排除三元 `a ? b : c` —— `b :` 会被误当键；前一个非空字符是 `?` 即跳过
                    p = km.start(1) - 1
                    while p >= 0 and body[p] in " \t\n":
                        p -= 1
                    if p >= 0 and body[p] == "?":
                        continue
                    keys.add(km.group(1))
            argkeys.setdefault(cmd, set()).update(keys)
    return cmds, argkeys


def parse_core(main_rs: Path) -> tuple[set[str], dict[str, set[str]]]:
    """返回（注册命令集合, {命令: Rust 参数名集合})。"""
    src = main_rs.read_text(encoding="utf-8", errors="replace")
    # 注册表
    i = src.index("generate_handler![")
    depth = 0
    j = i + len("generate_handler!")
    for k in range(j, len(src)):
        if src[k] == "[":
            depth += 1
        elif src[k] == "]":
            depth -= 1
            if depth == 0:
                j = k
                break
    block = src[i:j]
    registered = set(re.findall(r"\b([a-z][a-z_0-9]+)\b", block))
    registered -= {"tauri", "generate_handler", "core_session", "crate", "self"}

    # 每个命令的签名参数
    params: dict[str, set[str]] = {}
    decl_re = re.compile(r"#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-z_0-9]+)\s*\(", re.S)
    for m in decl_re.finditer(src):
        name = m.group(1)
        # 取参数列表（配平括号）
        k = m.end() - 1
        depth = 0
        for j in range(k, len(src)):
            if src[j] == "(":
                depth += 1
            elif src[j] == ")":
                depth -= 1
                if depth == 0:
                    k = j
                    break
        raw = src[m.end() : k]
        names: set[str] = set()
        d = 0
        for part in re.split(r",(?![^<>()\[\]]*[>)\]])", raw):
            p = part.strip()
            if not p:
                continue
            nm = p.split(":")[0].strip()
            if re.fullmatch(r"[a-z_0-9]+", nm):
                names.add(nm)
        params[name] = names
    return registered, params


def main() -> int:
    ap = argparse.ArgumentParser()
    here = Path(__file__).resolve().parent.parent
    ap.add_argument("--old-ui", default=str(here / ".worktrees" / "old-ui" / "ui" / "src"))
    ap.add_argument("--core", default=str(here / "src-tauri" / "src" / "main.rs"))
    args = ap.parse_args()

    old_root = Path(args.old_ui)
    if not old_root.exists():
        print(f"旧 UI 源码不存在：{old_root}\n（先 `git worktree add .worktrees/old-ui old-ui-baseline-g0`）")
        return 1

    old_cmds, old_args = parse_old_ui(old_root)
    reg, params = parse_core(Path(args.core))

    missing = sorted(old_cmds - reg)
    print(f"旧 UI 命令数：{len(old_cmds)}；核心注册命令数：{len(reg)}")
    if missing:
        print("❌ 核心缺少旧 UI 调用的命令：")
        for c in missing:
            print(f"   - {c}")
    else:
        print("✅ 命令名称：旧 UI ⊆ 核心")

    # 参数名核对
    bad: list[str] = []
    checked = 0
    for cmd, keys in sorted(old_args.items()):
        if cmd in missing:
            continue
        pnames = params.get(cmd)
        if pnames is None:
            bad.append(f"{cmd}: 核心无 #[tauri::command] 签名（可能非命令或解析失败）")
            continue
        allowed = {snake_to_camel(p) for p in pnames if p not in INJECTED} | pnames
        for key in sorted(keys):
            checked += 1
            if key not in allowed:
                bad.append(f"{cmd}: 旧 UI 传 `{key}`，核心参数为 {sorted(pnames)}")
    print(f"参数键核对：{checked} 个键")
    if bad:
        print("❌ 参数名对不上：")
        for b in bad:
            print(f"   - {b}")
    else:
        print("✅ 参数名：旧 UI 传入键均能对上核心参数")

    return 1 if (missing or bad) else 0


if __name__ == "__main__":
    sys.exit(main())
