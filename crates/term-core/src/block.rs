//! 命令块索引（L0 ADR-9）：{命令文本, 起止时间, exit_code, 输出区间, 来源}。
//! Shell 模式 exec 边界、现场简报、操作记录、审计同源于此。

use crate::osc::OscEvent;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// 块来源：人类键盘输入 / Agent {client}（键入归因）/ Fresh 镜像回放。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BlockSource {
    Human,
    Agent { client_id: String },
    /// Fresh 结果镜像回放（带 Agent 标注块）。
    Replay { client_id: Option<String> },
}

impl BlockSource {
    pub fn describe(&self) -> String {
        match self {
            BlockSource::Human => "human".into(),
            BlockSource::Agent { client_id } => format!("agent:{client_id}"),
            BlockSource::Replay { client_id } => match client_id {
                Some(c) => format!("replay:{c}"),
                None => "replay".into(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandBlock {
    /// B→C 区间内键入的字节（启发式/受管块模式下可能为空或由 core 填写）。
    pub command: String,
    pub start: Option<DateTime<Utc>>,
    pub end: Option<DateTime<Utc>>,
    /// OSC 133 D;exit 提供的退出码；断线强制收尾时可能缺失。
    pub exit_code: Option<i32>,
    /// 输出行区间（grid 绝对行号快照，仅供索引展示）。
    pub output_line_range: Option<(i32, i32)>,
    pub source: BlockSource,
    /// 关联的 exec（Shell 模式 exec 写入时登记）。
    pub exec_id: Option<String>,
}

/// 索引当前打开块的状态机位置。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BlockPhase {
    /// 上一个块已收尾，等待提示符（A）。
    #[default]
    Idle,
    /// A→B：提示符渲染中。
    Prompt,
    /// B→C：命令键入中。
    Typing,
    /// C→D：输出中（块已开）。
    Output,
}

/// 当前打开块的临时状态。
#[derive(Debug, Default)]
struct OpenState {
    start: Option<DateTime<Utc>>,
    /// C 之前键入的命令字节（B→C 之间 write 的内容）。
    typed: Vec<u8>,
    /// B→C 键入来源归因（Agent 提交命令时由 core 设置）。
    typed_source: Option<BlockSource>,
    /// C 时刻的 grid 绝对行号。
    output_start_line: Option<i32>,
    /// 打开块来源（受管块直接指定）。
    managed_source: Option<BlockSource>,
    managed_exec: Option<String>,
}

#[derive(Debug, Default)]
pub struct BlockIndex {
    pub blocks: Vec<CommandBlock>,
    pub phase: BlockPhase,
    open: OpenState,
}

impl BlockIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// 通路 write 的回调：捕获 B→C 之间的键入命令文本。
    pub fn on_write(&mut self, data: &[u8]) {
        if self.phase == BlockPhase::Typing {
            self.open.typed.extend_from_slice(data);
        }
    }

    /// 键入归因：Agent 在 B→C 阶段写入命令时调用。
    pub fn attribute_write(&mut self, source: BlockSource) {
        if self.phase == BlockPhase::Typing {
            self.open.typed_source = Some(source);
        }
    }

    pub fn on_osc(&mut self, ev: &OscEvent, now: DateTime<Utc>, current_line: i32) {
        match ev {
            OscEvent::PromptStart => {
                // A：块若仍开着（如交互程序中），不重复打开
                if self.phase == BlockPhase::Idle {
                    self.phase = BlockPhase::Prompt;
                }
            }
            OscEvent::CommandStart => {
                // B
                if matches!(self.phase, BlockPhase::Prompt | BlockPhase::Idle) {
                    self.phase = BlockPhase::Typing;
                    self.open.typed.clear();
                    self.open.typed_source = None;
                }
            }
            OscEvent::OutputStart => {
                // C：块正式开始（尚未打开才打开；受管块已在 Output 态则跳过）
                if matches!(self.phase, BlockPhase::Typing | BlockPhase::Prompt | BlockPhase::Idle) {
                    self.open.start = Some(now);
                    self.open.output_start_line = Some(current_line);
                    self.phase = BlockPhase::Output;
                }
            }
            OscEvent::CommandDone { exit } => {
                // D：收尾块
                if self.phase == BlockPhase::Output {
                    let source = self
                        .open
                        .managed_source
                        .take()
                        .or_else(|| self.open.typed_source.take())
                        .unwrap_or(BlockSource::Human);
                    let command = if self.open.managed_source.is_some() {
                        String::new() // 受管块命令文本由 core 在 open_managed 提供
                    } else {
                        String::from_utf8_lossy(&self.open.typed).trim().to_string()
                    };
                    self.blocks.push(CommandBlock {
                        command,
                        start: self.open.start.take(),
                        end: Some(now),
                        exit_code: *exit,
                        output_line_range: self.open.output_start_line.map(|s| (s, current_line)),
                        source,
                        exec_id: self.open.managed_exec.take(),
                    });
                    self.open.typed.clear();
                    self.phase = BlockPhase::Idle;
                }
            }
            // cwd 事件由 Screen 直接处理，不进块索引
            OscEvent::Cwd { .. } => {}
        }
    }

    /// 打开一个受管块（Shell 模式 exec / 镜像回放）：直接置 Output 态。
    pub fn open_managed(
        &mut self,
        command: &str,
        source: BlockSource,
        exec_id: Option<String>,
        now: DateTime<Utc>,
        current_line: i32,
    ) {
        self.open = OpenState {
            start: Some(now),
            typed: command.as_bytes().to_vec(),
            typed_source: None,
            output_start_line: Some(current_line),
            managed_source: Some(source),
            managed_exec: exec_id,
        };
        self.phase = BlockPhase::Output;
    }

    /// 断线等场景：强制收尾打开块（诚实标注 exit 未知）。
    pub fn force_close_open(&mut self, now: DateTime<Utc>) {
        if self.phase == BlockPhase::Output {
            let source = self
                .open
                .managed_source
                .take()
                .or_else(|| self.open.typed_source.take())
                .unwrap_or(BlockSource::Human);
            self.blocks.push(CommandBlock {
                command: String::from_utf8_lossy(&self.open.typed).trim().to_string(),
                start: self.open.start.take(),
                end: Some(now),
                exit_code: None,
                output_line_range: self
                    .open
                    .output_start_line
                    .map(|s| (s, self.open.output_start_line.unwrap_or(s))),
                source,
                exec_id: self.open.managed_exec.take(),
            });
        }
        self.open = OpenState::default();
        self.phase = BlockPhase::Idle;
    }

    pub fn has_open_block(&self) -> bool {
        self.phase == BlockPhase::Output
    }

    pub fn last_blocks(&self, n: usize) -> Vec<&CommandBlock> {
        self.blocks.iter().rev().take(n).rev().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::osc::OscScanner;

    /// OSC 133 全生命周期：A→B→（键入）→C→（输出）→D;exit
    #[test]
    fn full_block_lifecycle() {
        let mut idx = BlockIndex::new();
        let t0 = Utc::now();
        let mut scanner = OscScanner::new();

        // 提示符与 B 先到（shell 打印 PS1）
        let evs = scanner.feed(b"\x1b]133;A\x07$ \x1b]133;B\x07");
        for (ev, _) in evs {
            idx.on_osc(&ev, t0, 0);
        }
        // 人类键入命令（B→C 之间）
        idx.on_write(b"echo hi\r\n");
        // C、输出、D
        let evs = scanner.feed(b"\x1b]133;C\x07hi\n\x1b]133;D;0\x07$ ");
        for (i, (ev, _)) in evs.iter().enumerate() {
            idx.on_osc(ev, t0, i as i32);
        }

        assert_eq!(idx.blocks.len(), 1);
        let b = &idx.blocks[0];
        assert_eq!(b.command, "echo hi");
        assert_eq!(b.exit_code, Some(0));
        assert_eq!(b.source, BlockSource::Human);
    }

    #[test]
    fn agent_attribution() {
        let mut idx = BlockIndex::new();
        let t0 = Utc::now();
        let mut scanner = OscScanner::new();

        // 提示符与 B 来自 shell
        for (ev, _) in scanner.feed(b"\x1b]133;A\x07\x1b]133;B\x07") {
            idx.on_osc(&ev, t0, 0);
        }
        // Agent 键入
        idx.attribute_write(BlockSource::Agent { client_id: "cc".into() });
        idx.on_write(b"ls\r\n");
        for (ev, _) in scanner.feed(b"\x1b]133;C\x07out\x1b]133;D;2\x07") {
            idx.on_osc(&ev, t0, 1);
        }

        assert_eq!(idx.blocks.len(), 1);
        assert_eq!(idx.blocks[0].command, "ls");
        assert_eq!(idx.blocks[0].source, BlockSource::Agent { client_id: "cc".into() });
        assert_eq!(idx.blocks[0].exit_code, Some(2));
    }

    #[test]
    fn managed_block() {
        let mut idx = BlockIndex::new();
        let t0 = Utc::now();
        idx.open_managed("docker ps", BlockSource::Replay { client_id: Some("cc".into()) }, None, t0, 0);
        idx.on_osc(&crate::osc::OscEvent::CommandDone { exit: Some(0) }, t0, 5);
        assert_eq!(idx.blocks.len(), 1);
        assert_eq!(idx.blocks[0].command, "docker ps");
        assert_eq!(idx.blocks[0].source, BlockSource::Replay { client_id: Some("cc".into()) });
    }
}
