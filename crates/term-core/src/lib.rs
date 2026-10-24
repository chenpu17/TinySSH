//! term-core：屏幕网格 + 命令块双真源（L0 ADR-9，L1 §3.2）。
//!
//! 字节流同时进入三个消费端：
//! 1. alacritty_terminal `Term` 网格（渲染快照的真源）；
//! 2. OSC 133 / OSC 7 扫描器 → `BlockIndex`（命令边界、退出码、cwd）；
//! 3. 可丢 broadcast 流（UI 渲染）+ 无损环形缓冲（wait_output / 审批卡片）。

mod block;
mod osc;
mod render;
mod screen;
mod wait;

pub use block::{BlockIndex, BlockSource, CommandBlock};
pub use osc::{OscEvent, OscScanner};
pub use screen::{Screen, ScreenConfig};
pub use wait::{ScreenWaitErr, ScreenWaitOk};

/// 剥离 ANSI 转义序列（渲染后文本域，wait_output 匹配与 ExecResult 输出用）。
pub fn strip_ansi(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let n = input.len();
    while i < n {
        let b = input[i];
        if b == 0x1b {
            // ESC [ ... 终符 @-~ ；ESC ] ... BEL/ST ；DCS/SOS/PM/APC 直到 ST
            if i + 1 < n && input[i + 1] == b'[' {
                i += 2;
                while i < n && !(0x40..=0x7e).contains(&input[i]) {
                    i += 1;
                }
                i = (i + 1).min(n);
            } else if i + 1 < n && input[i + 1] == b']' {
                i += 2;
                while i < n {
                    if input[i] == 0x07 {
                        i += 1;
                        break;
                    }
                    if input[i] == 0x1b && i + 1 < n && input[i + 1] == b'\\' {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
            } else if i + 1 < n
                && (input[i + 1] == b'P'
                    || input[i + 1] == b'X'
                    || input[i + 1] == b'^'
                    || input[i + 1] == b'_')
            {
                i += 2;
                while i < n {
                    if input[i] == 0x1b && i + 1 < n && input[i + 1] == b'\\' {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
            } else {
                i += 2;
            }
        } else if b == 0x07 {
            i += 1;
        } else if b == b'\r' {
            if i + 1 < n && input[i + 1] == b'\n' {
                out.push('\n');
                i += 1;
            }
            i += 1;
        } else if b == 0x08 {
            i += 1;
        } else {
            // 单字符增量解码。原实现在此对「剩余整片」做 from_utf8_lossy 且每
            // 字节一次——O(n²)：8KB chunk 平均 4000 万次字节校验，`cat` 大文件
            // 时泵消费速率被压到几百 KB/s。窗口限 4 字节（UTF-8 单字符上限）
            // 后单字符成本恒定；非法/不完整序列一律 U+FFFD 且只前进 1 字节
            // （多吐一个替换符无害，绝不吞掉后续字节）。
            let win = &input[i..(i + 4).min(n)];
            let s = String::from_utf8_lossy(win);
            let ch = s.chars().next().unwrap_or('\u{fffd}');
            if ch == '\u{fffd}' {
                out.push(ch);
                i += 1;
            } else {
                out.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::strip_ansi;

    #[test]
    fn strips_basic_sequences() {
        assert_eq!(strip_ansi(b"\x1b[31mred\x1b[0m plain"), "red plain");
        assert_eq!(strip_ansi(b"\x1b]0;title\x07after"), "after");
        assert_eq!(strip_ansi(b"a\r\nb\rc"), "a\nbc");
    }

    /// 稳定轮（P1-1）：多字节文本照保——增量解码不改变正常路径语义。
    #[test]
    fn keeps_multibyte_text() {
        assert_eq!(strip_ansi("中文abc✓".as_bytes()), "中文abc✓");
        assert_eq!(strip_ansi("\x1b[31m中文\x1b[0m".as_bytes()), "中文");
    }

    /// 非法字节逐个替换且不吞后续文本（旧实现 FFFD 前进 3 字节会吃掉后面内容）。
    #[test]
    fn invalid_bytes_dont_swallow_text() {
        let out = strip_ansi(&[0x80, b'a', b'b', 0xFF, b'c']);
        assert_eq!(
            out.chars().filter(|&c| c != '\u{fffd}').collect::<String>(),
            "abc"
        );
    }

    /// 大输入必须线性：旧实现对每字节校验整个剩余切片（O(n²)），1MB 要跑
    /// 分钟级；本用例在旧实现下等价于挂死，作为性能回归的哨兵。
    #[test]
    fn plain_megabyte_is_linear() {
        let chunk = "hello world, 你好世界\r\n".repeat(40_000);
        let out = strip_ansi(chunk.as_bytes());
        assert_eq!(out.lines().count(), 40_000);
    }
}
