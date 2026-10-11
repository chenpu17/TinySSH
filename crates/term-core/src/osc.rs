//! OSC 扫描器：从字节流中提取 OSC 133（shell integration）与 OSC 7（cwd）事件。
//! 独立于 alacritty 的 vte 处理器（alacritty 不外露这些 OSC），
//! 以旁路状态机实现，不消费原始流。

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OscEvent {
    /// OSC 133;A — 提示符开始。
    PromptStart,
    /// OSC 133;B — 提示符结束 / 命令键入开始。
    CommandStart,
    /// OSC 133;C — 命令输出开始。
    OutputStart,
    /// OSC 133;D;exit — 命令结束（exit 可缺失）。
    CommandDone { exit: Option<i32> },
    /// OSC 7;file://host/path — cwd 报告。
    Cwd { path: String },
}

#[derive(Debug, Default)]
pub struct OscScanner {
    state: State,
    buf: Vec<u8>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
enum State {
    #[default]
    Ground,
    /// 收到 ESC，等待 [ 或 ]
    Esc,
    /// OSC 已开始（ESC ]），等待终止符
    Osc,
    /// OSC 终止符一半（ESC \ 中的 ESC）
    OscEsc,
}

impl OscScanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂入字节，返回本轮提取到的完整 OSC 事件及其终止符后的字节偏移。
    pub fn feed(&mut self, data: &[u8]) -> Vec<(OscEvent, usize)> {
        let mut events: Vec<(OscEvent, usize)> = Vec::new();
        for (i, &b) in data.iter().enumerate() {
            match std::mem::replace(&mut self.state, State::Ground) {
                State::Ground => {
                    if b == 0x1b {
                        self.state = State::Esc;
                    }
                }
                State::Esc => {
                    if b == b']' {
                        self.state = State::Osc;
                        self.buf.clear();
                    } else if b == 0x1b {
                        self.state = State::Esc;
                    }
                }
                State::Osc => {
                    if b == 0x07 {
                        // BEL 终止
                        if let Some(ev) = Self::parse(&self.buf) {
                            events.push((ev, i + 1));
                        }
                        self.buf.clear();
                    } else if b == 0x1b {
                        self.state = State::OscEsc;
                    } else if self.buf.len() < 4096 {
                        self.buf.push(b);
                        self.state = State::Osc;
                    } else {
                        // 异常长的 OSC：丢弃保护
                        self.buf.clear();
                        self.state = State::Ground;
                    }
                }
                State::OscEsc => {
                    if b == b'\\' {
                        if let Some(ev) = Self::parse(&self.buf) {
                            events.push((ev, i + 1));
                        }
                        self.buf.clear();
                        self.state = State::Ground;
                    } else {
                        // 非 ST：把 ESC 和当前字节当普通数据放回（近似处理）
                        if self.buf.len() < 4090 {
                            self.buf.push(0x1b);
                            self.buf.push(b);
                        }
                        self.state = State::Osc;
                    }
                }
            }
        }
        events
    }

    fn parse(payload: &[u8]) -> Option<OscEvent> {
        let s = String::from_utf8_lossy(payload);
        let mut parts = s.splitn(2, ';');
        let code = parts.next()?;
        let rest = parts.next().unwrap_or("");
        match code {
            "133" => {
                let mut sub = rest.splitn(2, ';');
                let kind = sub.next()?;
                let arg = sub.next().unwrap_or("");
                match kind {
                    "A" => Some(OscEvent::PromptStart),
                    "B" => Some(OscEvent::CommandStart),
                    "C" => Some(OscEvent::OutputStart),
                    "D" => {
                        let exit = arg.trim().parse::<i32>().ok();
                        Some(OscEvent::CommandDone { exit })
                    }
                    _ => None,
                }
            }
            "7" => {
                // file://host/path → 取 path 部分
                if let Some(idx) = rest.find("file://") {
                    let after = &rest[idx + 7..];
                    let path = match after.find('/') {
                        Some(p) => &after[p..],
                        None => "/",
                    };
                    let path = percent_decode(path);
                    return Some(OscEvent::Cwd { path });
                }
                None
            }
            _ => None,
        }
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() + 1 && i + 2 < bytes.len() + 1
            && i + 2 < bytes.len() {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    out.push((hi * 16 + lo) as u8);
                    i += 3;
                    continue;
                }
            }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_133_sequence() {
        let mut sc = OscScanner::new();
        let evs = sc.feed(b"hello\x1b]133;D;0\x07world");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].0, OscEvent::CommandDone { exit: Some(0) });
    }

    #[test]
    fn parses_st_terminated() {
        let mut sc = OscScanner::new();
        let evs = sc.feed(b"\x1b]133;C\x1b\\");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].0, OscEvent::OutputStart);
    }

    #[test]
    fn parses_cwd() {
        let mut sc = OscScanner::new();
        let evs = sc.feed(b"\x1b]7;file://myhost/tmp/a%20b\x07");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].0, OscEvent::Cwd { path: "/tmp/a b".into() });
    }

    #[test]
    fn split_across_feeds() {
        let mut sc = OscScanner::new();
        assert!(sc.feed(b"\x1b]133;").is_empty());
        // 跨 feed 边界：分片续喂后事件应产出（原 `== false || true` 恒真，clippy E0）
        assert!(!sc.feed(b"A\x07").is_empty());
        // 重新构造：事件应跨 feed 边界依然产出
        let mut sc = OscScanner::new();
        assert!(sc.feed(b"\x1b]13").is_empty());
        let evs = sc.feed(b"3;B\x07");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].0, OscEvent::CommandStart);
    }
}
