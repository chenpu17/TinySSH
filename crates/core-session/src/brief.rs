//! 现场简报（SessionBrief）计算：交接核心工件，三层认知状态（L1 §2/§3.1）。

use crate::handle::SessionHandle;
use session_api::{BriefFact, Epistemic, SessionBrief, SessionState};
use std::sync::Arc;

pub async fn compute(h: &SessionHandle) -> SessionBrief {
    let state = *h.state.lock().await;
    let transitions = h.transitions.lock().await.clone();
    let screen = h.screen.lock().await;

    // cwd：SSH 重连/重确认后降级 NeedsRecheck（显示历史 ≠ 现场延续）
    let cwd = screen.cwd().cloned();
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
            detail: format!("{} · {}", ts.with_timezone(&chrono::Local).format("%H:%M:%S"), what),
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
        if let Some(_) = &cwd {
            // cwd 事实已在上面降级
        }
    }

    // 待审批（该会话、pending）
    let pending: Vec<String> = {
        let items = h.center.items.lock().unwrap();
        items
            .iter()
            .filter(|(_, it)| it.session_id == h.id && it.status == session_api::ApprovalStatus::Pending)
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
