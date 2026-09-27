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
            let rest = &input[i..];
            let s = String::from_utf8_lossy(rest);
            let ch = s.chars().next().unwrap_or('\u{fffd}');
            out.push(ch);
            i += ch.len_utf8().max(1);
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
}
