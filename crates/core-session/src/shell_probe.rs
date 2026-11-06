//! 远端 shell 家族探针与集成注入片段（bash/zsh/fish；OSC 133 + OSC 7）。
//!
//! 从 lib.rs 抽出（第二波结构拆分）。纯字符串/判型逻辑，便于单测；
//! `handle.rs` 通过 `crate::` 重导出继续使用。

/// SSH 远端 shell 集成注入片段（bash/zsh 自动探测；OSC 133 + OSC 7）。
pub fn ssh_integration_snippet() -> String {
    let bash = r#"if [ -n "$BASH_VERSION" ]; then
  __t_prompt(){ __rc=$?; printf '\033]7;file://%s%s\007' "$HOSTNAME" "$PWD"; printf '\033]133;D;%s\007' "$__rc"; printf '\033]133;A\007'; }
  __t_preexec(){ printf '\033]133;C\007'; }
  PROMPT_COMMAND="__t_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  PS1="\[\033]133;B\007\]$PS1"
  PS0="\[\033]133;C\007\]$PS0"
fi"#;
    let zsh = r#"if [ -n "$ZSH_VERSION" ]; then
  __t_precmd(){ __rc=$?; printf '\033]7;file://%s%s\007' "$HOST" "$PWD"; printf '\033]133;D;%s\007' "$__rc"; printf '\033]133;A\007'; printf '\033]133;B\007'; }
  __t_preexec(){ printf '\033]133;C\007'; }
  precmd_functions=(__t_precmd $precmd_functions)
  preexec_functions=(__t_preexec $preexec_functions)
fi"#;
    // 末尾清屏：抹掉上面几行在远端 PTY 的回显（否则用户首连看到满屏集成代码）；
    // printf 是 shell 内建，不依赖外部 clear 二进制。
    format!("{bash}\n{zsh}\nprintf '\\033[2J\\033[H'\n")
}

/// V2（snippets 盘点轮立案）shell 家族探针：polyglot printf——sh/zsh/fish 都能
/// 解析同一行（未定义变量在双引号内展开为空；fish 的 `$FISH_VERSION` 恒在）。
/// 随注入文本首发、先于钩子安装执行（不产生命令块），输出与片段回显一起被
/// 尾清屏抹掉。tcsh 对未定义变量报错 → 输出无有效标记 → 如实回落 sh-only。
/// 标记输出必须自带换行：交互 shell 的下一个输出（下一条命令的回显/解析报错）
/// 会直接粘在 printf 输出之后，无换行则字段白名单判型必然失败（审查轮 P0）。
pub const SSH_SHELL_PROBE: &str =
    r#"printf '__T=%s|%s|%s\n' "$BASH_VERSION" "$ZSH_VERSION" "$FISH_VERSION""#;

/// fish 登录 shell 集成片段（探针判型 Fish 后补写）。事件钩子制（fish_prompt /
/// fish_preexec / fish_postexec），不覆盖用户自定义 prompt 函数；字段对应 sh 版：
/// preexec→C、postexec→D、prompt→OSC7+A+B。尾清屏抹补写回显，末行
/// `commandline -f repaint` 在清屏后重画提示符并即刻触发 fish_prompt（首个标记）。
pub fn ssh_fish_integration_snippet() -> String {
    r#"function __t_fish_preexec --on-event fish_preexec
  printf '\033]133;C\007'
end
function __t_fish_postexec --on-event fish_postexec
  printf '\033]133;D;%s\007' $status
end
function __t_fish_prompt --on-event fish_prompt
  printf '\033]7;file://%s%s\007' $hostname $PWD
  printf '\033]133;A\007'
  printf '\033]133;B\007'
end
printf '\033[2J\033[H'
commandline -f repaint"#
        .to_string()
}

/// 找茬轮 F1：非 POSIX 远端（Windows OpenSSH 默认 shell=cmd/PowerShell）没有
/// printf——注入批次（探针行+片段+尾清屏）在其上只会逐行报错且**尾清屏自身
/// 也报错不执行**，呕吐物永留终端、每次重连再吐一遍。探针输出里出现「报错
/// 引用 printf」的签名即判定阻断。签名取高精度锚：cmd 中文（'printf' 不是…）、
/// cmd 英文（is not recognized as an internal…）、PowerShell 全 locale（异常
/// 类型名 CommandNotFoundException 不本地化）。其余 cmd 语种如实维持旧行为
/// （立案：TCP 层 banner 嗅探可做到零呕吐，russh 0.63 未暴露 remote_sshid）。
pub fn windows_probe_error(buf: &str) -> bool {
    if !buf.contains("printf") {
        return false;
    }
    buf.contains("不是内部或外部命令")
        || buf.contains("is not recognized as an internal")
        || buf.contains("CommandNotFoundException")
}

/// 远端登录 shell 家族（探针判型结果）。`Sh` = sh 族或未知（sh 片段的 if 块
/// 自守兜底；tcsh 等不兼容 shell 维持 V1 行为：报错被尾清屏抹掉、如实 Unavailable）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteShellFamily {
    Sh,
    Bash,
    Zsh,
    Fish,
}

/// 探针输出判型：找 `__T=` 标记取三个 `|` 分隔字段。注入行的**回显**含 `%s`/
/// 引号等，过不了字段字符白名单（版本号形态 `[0-9A-Za-z-.+_()]`），不会误判；
/// 多次出现（回显+真输出）取首个有效者。
pub fn classify_shell_probe(out: &str) -> RemoteShellFamily {
    let ok = |s: &str| {
        !s.contains('%')
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-.+_()".contains(&c))
    };
    let mut from = 0;
    while let Some(p) = out[from..].find("__T=") {
        let start = from + p + 4;
        let rest = &out[start..];
        // 80 字节窗口须落在 char 边界（输入来自 from_utf8_lossy，多字节 banner
        // 常见；截半切片会 panic 在探针任务里，静默丢判型——审查轮 P1）
        let mut end = rest.find(['\r', '\n']).unwrap_or(rest.len()).min(80);
        while end > 0 && !rest.is_char_boundary(end) {
            end -= 1;
        }
        let mut it = rest[..end].splitn(3, '|');
        let b = it.next().unwrap_or("");
        let z = it.next().unwrap_or("");
        let f = it.next().unwrap_or("");
        if ok(b) && ok(z) && ok(f) {
            return if !b.is_empty() {
                RemoteShellFamily::Bash
            } else if !z.is_empty() {
                RemoteShellFamily::Zsh
            } else if !f.is_empty() {
                RemoteShellFamily::Fish
            } else {
                RemoteShellFamily::Sh
            };
        }
        from = start;
    }
    RemoteShellFamily::Sh
}
