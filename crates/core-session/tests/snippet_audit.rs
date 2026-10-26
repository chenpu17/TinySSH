//! snippets 盘点轮（2026-10-26）：远端 shell 集成注入片段的契约锁。
//!
//! `ssh_integration_snippet()` 是写进用户远端登录 shell 的代码——改动必须谨慎，
//! 本测试把安全/契约要点钉死：
//! 1. bash/zsh 两分支各自自守（`$BASH_VERSION`/`$ZSH_VERSION` 哨兵），互不误触；
//! 2. 尾部清屏恒在（抹掉片段回显；fish/tcsh 等不兼容 shell 的解析报错也靠它抹掉）；
//! 3. 片段是 POSIX sh 语法（`if ...; then ... fi`）——**只兼容 sh 族登录 shell**；
//! 4. V2 探针（`SSH_SHELL_PROBE`）polyglot：sh/zsh/fish 同行可解析，判型后 fish
//!    补写 `ssh_fish_integration_snippet()`（事件钩子制）。

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

#[test]
fn probe_contract() {
    let p = core_session::SSH_SHELL_PROBE;

    // polyglot 面：单引号格式体 + 双引号变量——sh/zsh/fish 同一行都可解析
    //（未定义变量在双引号内展开为空）。探针无任何 shell 专属语法。
    assert!(
        p.starts_with("printf '__T="),
        "探针须是 printf '__T=…' 形态"
    );
    assert!(p.contains(r#""$BASH_VERSION""#), "缺 bash 字段");
    assert!(p.contains(r#""$ZSH_VERSION""#), "缺 zsh 字段");
    assert!(p.contains(r#""$FISH_VERSION""#), "缺 fish 字段");
    assert!(
        !p.contains("; then") && !p.contains("fi "),
        "探针不得带 sh 语法面"
    );
    assert!(!p.contains('\r'), "探针混入 CR");
    // 探针常量本身单行（\n 是格式串内的两字符转义，输出侧换行由 printf 展开）
    assert!(!p.contains('\n'), "探针须是单行");
    // 审查轮 P0：格式串必须以 \n 收尾——交互 shell 的下一个输出会直接粘在
    // printf 输出之后，无换行则三字段白名单判型在真实主机上必然失败
    assert!(
        p.contains(r"%s\n'"),
        "printf 格式串缺结尾 \\n（真实流粘连会导致判型全回落 Sh）"
    );
}

#[test]
fn fish_snippet_contract() {
    let s = core_session::ssh_fish_integration_snippet();

    // OSC 全配齐（与 sh 版同字段：preexec→C、postexec→D、prompt→OSC7+A+B）
    for osc in ["133;A", "133;B", "133;C", "133;D", "]7;file://"] {
        assert!(s.contains(osc), "缺 OSC 标记 {osc}");
    }
    // fish 语法面：事件钩子制，不覆盖用户 prompt 函数；不得混入 sh 语法
    for ev in [
        "--on-event fish_preexec",
        "--on-event fish_postexec",
        "--on-event fish_prompt",
    ] {
        assert!(s.contains(ev), "缺事件钩子 {ev}");
    }
    assert!(
        !s.contains("; then") && !s.contains("\nfi"),
        "fish 片段混入 sh if/fi 语法"
    );
    // 尾清屏抹补写回显；repaint 恒最后（清屏后重画提示符并触发首个 fish_prompt）
    assert!(s.contains(r"\033[2J\033[H"), "缺尾清屏");
    let last = s.lines().last().unwrap_or("");
    assert!(
        last.contains("commandline -f repaint"),
        "repaint 必须是最后一行"
    );
    assert!(!s.contains('\r'), "片段混入 CR");
}

#[test]
fn probe_classify() {
    use core_session::{classify_shell_probe, RemoteShellFamily as F};
    // 真实输出形态（字段=版本号或空）
    assert_eq!(classify_shell_probe("__T=5.2.21(1)-release||"), F::Bash);
    assert_eq!(classify_shell_probe("__T=|5.9|"), F::Zsh);
    assert_eq!(classify_shell_probe("__T=||3.7.1"), F::Fish);
    assert_eq!(classify_shell_probe("__T=||"), F::Sh);
    // 无标记 / 空输入 → Sh（如实回落，行为同 V1）
    assert_eq!(classify_shell_probe(""), F::Sh);
    assert_eq!(classify_shell_probe("motd line\r\n$ "), F::Sh);
    // 回显行（%s/引号/空格）不得判型成功；真输出在后 → 取首个有效者
    //（回显文本 = 新探针行原文，含格式串里的 \n 两字面字符）
    let echoed = concat!(
        r#"printf '__T=%s|%s|%s\n' "$BASH_VERSION" "$ZSH_VERSION" "$FISH_VERSION""#,
        "\r\n__T=||3.7.1\r\n",
    );
    assert_eq!(classify_shell_probe(echoed), F::Fish);
    // 回显先行且无真输出 → Sh
    let echo_only = concat!(r#"printf '__T=%s|%s|%s\n' "$BASH_VERSION""#, "\r\n",);
    assert_eq!(classify_shell_probe(echo_only), F::Sh);
    // 标记跨块边界（分片到达）也能判出：整段扫描不依赖单 chunk
    assert_eq!(classify_shell_probe("…__T=||3."), F::Fish);
    // 真实 PTY 流：marker 以 CRLF 收尾，紧随片段回显/解析报错（各自成行）
    assert_eq!(
        classify_shell_probe("echo\r\n__T=||3.7.1\r\nfish: Unsupported use of '='\r\n"),
        F::Fish
    );
    assert_eq!(
        classify_shell_probe("__T=5.2.21(1)-release||\r\nif [ -n \"$BASH_VERSION\" ]; then\r\n"),
        F::Bash
    );
    // 审查轮 P0 回归：无换行的粘连流（旧探针的现实形态）——字段吞进后续输出
    // 的空格/冒号，须整体拒绝而不是误判，也不得 panic
    assert_eq!(
        classify_shell_probe("__T=||3.7.1fish: Unsupported\r\n"),
        F::Sh
    );
    assert_eq!(
        classify_shell_probe("__T=||3.7.1> printf '\\033]133;C\\007'\r\n"),
        F::Sh
    );
    // 审查轮 P1 回归：marker 后 ≥80 字节无换行的多字节文本——窗口截断须落在
    // char 边界（不 panic），非 ASCII 判无效 → Sh
    let cjk: String = "汉".repeat(40);
    assert_eq!(classify_shell_probe(&format!("__T=||3.7.1{cjk}")), F::Sh);
}
