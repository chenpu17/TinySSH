//! snippets 盘点轮（2026-10-26）：远端 shell 集成注入片段的契约锁。
//!
//! `ssh_integration_snippet()` 是写进用户远端登录 shell 的代码——改动必须谨慎，
//! 本测试把安全/契约要点钉死：
//! 1. bash/zsh 两分支各自自守（`$BASH_VERSION`/`$ZSH_VERSION` 哨兵），互不误触；
//! 2. 尾部清屏恒在（抹掉片段回显；fish/tcsh 等不兼容 shell 的解析报错也靠它抹掉）；
//! 3. 片段是 POSIX sh 语法（`if ...; then ... fi`）——**只兼容 sh 族登录 shell**；
//!    fish 登录主机：报错被尾清屏抹掉、集成状态如实 Unavailable（V2 立案探针预检）。

#[test]
fn remote_snippet_contract() {
    let s = core_session::ssh_integration_snippet();

    // 自守哨兵：bash 分支只在 bash 下生效，zsh 分支只在 zsh 下生效
    assert!(s.contains(r#"[ -n "$BASH_VERSION" ]"#), "缺 bash 哨兵");
    assert!(s.contains(r#"[ -n "$ZSH_VERSION" ]"#), "缺 zsh 哨兵");
    // POSIX sh 语法面（盘点结论：fish/csh 登录 shell 不兼容，靠尾清屏兜住观感）
    assert!(
        s.contains("; then") && s.contains("\nfi"),
        "非 POSIX if/fi 结构"
    );

    // OSC 133 块标记 A/B/C/D 与 OSC 7 cwd 全配齐（命令块面板数据源）
    for osc in ["133;A", "133;B", "133;C", "133;D", "]7;file://"] {
        assert!(s.contains(osc), "缺 OSC 标记 {osc}");
    }

    // 尾部清屏：printf 内建（不依赖外部 clear 二进制）；恒在且在最后一行
    assert!(s.contains(r"\033[2J\033[H"), "缺尾清屏");
    let last = s.lines().last().unwrap_or("");
    assert!(last.contains(r"\033[2J\033[H"), "尾清屏必须是最后一行");
}

#[test]
fn remote_snippet_echo_gate_lines_stay_aligned() {
    // handle.rs 回显自门控按「行 trim 后与片段行逐字一致」剥离（两侧都 trim，
    // 行首缩进无害）——真正的断点风险是 CRLF：\r 混进片段行，trim 不掉会
    // 让比对恒失败。这里锁：全片段无 \r。
    let s = core_session::ssh_integration_snippet();
    assert!(
        !s.contains('\r'),
        "片段混入 CR（CRLF 写入会废掉回显自门控）"
    );
}
