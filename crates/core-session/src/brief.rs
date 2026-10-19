//! 现场简报（SessionBrief）计算：交接核心工件，三层认知状态（L1 §2/§3.1）。

use crate::handle::SessionHandle;
use session_api::{BriefFact, Epistemic, SessionBrief, SessionState};

/// 本地 Windows 会话的 cwd 归一（P1 shell 集成扩面）：OSC 7 的 path 段按
/// `file://host/path` 取，于是两种形态都不是本地文件 API 认得的路径——
/// PowerShell 注入发 `file:///C:/…`（file URI 惯例）→ 解析得 `/C:/…`；
/// Git Bash/MSYS 的 `$PWD` 是 `/c/…`。brief.cwd 会被文件面板当初始目录、
/// 被 Agent 当现场目录，归一到原生 `C:/…`（Windows 文件 API 认正斜杠）。
/// 只在 windows + kind=="local" 生效：SSH（含 linux 本地）路径原样放行。
/// 已知边界：MSYS 虚拟根路径（`/usr`、`/tmp` 等无盘符形态）不做映射——
/// 它们没有原生对应物（cygpath 才能解），如实保留原串。
fn native_local_cwd(kind: &str, cwd: Option<String>) -> Option<String> {
    let cwd = cwd?;
    #[cfg(windows)]
    {
        let b = cwd.as_bytes();
        if kind == "local" && b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() {
            // `/C:/…`（file URI 形态）→ `C:/…`
            if b[2] == b':' {
                return Some(cwd[1..].to_string());
            }
            // `/c/…`（MSYS 盘符惯例）→ `C:/…`：首段单字母 + 紧随分隔符，才当盘符
            if b[2] == b'/' {
                let drive = (b[1] as char).to_ascii_uppercase();
                return Some(format!("{drive}:{}", &cwd[2..]));
            }
        }
    }
    let _ = kind;
    Some(cwd)
}

pub async fn compute(h: &SessionHandle) -> SessionBrief {
    let state = *h.state.lock().await;
    let transitions = h.transitions.lock().await.clone();
    let screen = h.screen.lock().await;

    // cwd：SSH 重连/重确认后降级 NeedsRecheck（显示历史 ≠ 现场延续）
    let cwd = native_local_cwd(&h.kind, screen.cwd().cloned());
    let cwd_status = match state {
        SessionState::Connected | SessionState::Degraded => Epistemic::Confirmed,
        SessionState::Reconnecting | SessionState::Reconfirming | SessionState::Disconnected => {
            Epistemic::NeedsRecheck
        }
        SessionState::Closed => Epistemic::Unobservable,
    };

    let mut facts: Vec<BriefFact> = Vec::new();

    // cwd 事实
    if let Some(c) = &cwd {
        facts.push(BriefFact {
            subject: "cwd".into(),
            detail: c.clone(),
            status: cwd_status,
        });
    }

    // 最近命令块（人类与 Agent 同源；Fresh 回放块也在此）
    for b in screen.blocks.last_blocks(6) {
        let exit = b
            .exit_code
            .map(|c| format!("exit {c}"))
            .unwrap_or_else(|| "exit 未知".into());
        facts.push(BriefFact {
            subject: format!("命令（{}）", b.source.describe()),
            detail: format!("{} → {exit}", truncate(&b.command, 80)),
            status: Epistemic::Confirmed,
        });
    }

    // 控制权变迁（本地时区：操作记录 HH:MM:SS 用本地渲染，同一事件两个视图
    // 不得差时区——五人走查·阿紫实锤的 8 小时裂缝）
    for (ts, what) in transitions.iter().rev().take(3).rev() {
        facts.push(BriefFact {
            subject: "控制权".into(),
            detail: format!(
                "{} · {}",
                ts.with_timezone(&chrono::Local).format("%H:%M:%S"),
                what
            ),
            status: Epistemic::Confirmed,
        });
    }

    let running_ids: Vec<String> = h.running.lock().unwrap().keys().cloned().collect();

    // 断线：运行中任务状态未知（nohup/systemd 可能仍在跑）——不得当作已结束或自动重试
    if matches!(
        state,
        SessionState::Degraded | SessionState::Reconnecting | SessionState::Disconnected
    ) {
        facts.push(BriefFact {
            subject: "运行中任务".into(),
            detail: "状态未知：屏幕之外的任务（nohup/systemd 等）可能仍在运行，须核实，不得当作已结束或自动重试".into(),
            status: Epistemic::Unobservable,
        });
    }
    if state == SessionState::Reconfirming {
        facts.push(BriefFact {
            subject: "SSH 现场".into(),
            detail: "重连后进入重确认：普通动作被拒，仅内置只读核实白名单（pwd/printenv/which/ps/systemctl status）可用，核实完成后恢复".into(),
            status: Epistemic::NeedsRecheck,
        });
        if cwd.is_some() {
            // cwd 事实已在上面降级
        }
    }

    // 待审批（该会话、pending）
    let pending: Vec<String> = {
        let items = h.center.items.lock().unwrap();
        items
            .iter()
            .filter(|(_, it)| {
                it.session_id == h.id && it.status == session_api::ApprovalStatus::Pending
            })
            .map(|(id, _)| id.clone())
            .collect()
    };

    let env_summary = "TERM=xterm-256color；env 变更未追踪（V0）——printenv 核实".to_string();

    SessionBrief {
        cwd,
        env_summary,
        facts,
        running: running_ids,
        pending_approvals: pending,
        screen_summary: screen.screen_tail_summary(4),
        goal: h.goal.lock().unwrap().clone(),
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let t: String = s.chars().take(n).collect();
        format!("{t}…")
    }
}

#[cfg(test)]
mod brief_cwd_tests {
    use super::native_local_cwd;

    /// 归一只在 windows + local 生效（本组在两平台都成立）：
    /// ssh 会话同形态不归一（远端 Linux 恰有 /c 目录是合法路径）、无盘符形态原样。
    #[test]
    fn cwd_passthrough_shapes() {
        assert_eq!(
            native_local_cwd("local", Some("/tmp/build".into())).as_deref(),
            Some("/tmp/build")
        );
        assert_eq!(
            native_local_cwd("local", Some("/usr/bin".into())).as_deref(),
            Some("/usr/bin")
        );
        assert_eq!(
            native_local_cwd("ssh", Some("/c/data".into())).as_deref(),
            Some("/c/data")
        );
        assert_eq!(
            native_local_cwd("ssh", Some("/C:/x".into())).as_deref(),
            Some("/C:/x")
        );
        assert!(native_local_cwd("local", None).is_none());
    }

    /// 本地 Windows 会话的两种 OSC 7 形态都归一为原生盘符路径
    /// （PowerShell 注入的 file URI 形态 `/C:/…` 与 Git Bash/MSYS 的 `/c/…`）。
    #[cfg(windows)]
    #[test]
    fn local_windows_cwd_normalized() {
        assert_eq!(
            native_local_cwd("local", Some("/C:/Users/Administrator".into())).as_deref(),
            Some("C:/Users/Administrator")
        );
        assert_eq!(
            native_local_cwd("local", Some("/c/Users/Administrator".into())).as_deref(),
            Some("C:/Users/Administrator")
        );
        // 精确长度：单字母 + 分隔符才当盘符，/ab/x 不是
        assert_eq!(
            native_local_cwd("local", Some("/ab/x".into())).as_deref(),
            Some("/ab/x")
        );
    }
}
