//! C1 建连尝试（R19）：冻结契约的竞态序列与不变量。
//! local 会话走真 PTY（核心无门、快速路径）；窗口竞态经 test_hooks 暂停驱动
//! （契约序列 2/3）；跨域/幂等合并直接断言注册表行为。

use super::*;
use session_api::{Actor, AttemptPhase, AuditFilter, AuthDraft, BeginConnectionOpts, CancelOutcome, Charset, CreateSessionReq, HostDraft, HostId};
use std::sync::atomic::{AtomicU32, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::Duration;

fn mgr() -> Arc<SessionManager> {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = std::env::temp_dir().join(format!("c1-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    SessionManager::open(&dir.join("t.db")).unwrap()
}

static SEQ: AtomicU32 = AtomicU32::new(0);

/// 造一个不可路由 SSH 主机（connect 长挂——驱动「受理取消」路径，不依赖门）。
fn seed_unreachable(mgr: &SessionManager) -> HostId {
    let n = SEQ.fetch_add(1, AtomicOrdering::SeqCst);
    mgr.center
        .vault
        .upsert_host(&HostDraft {
            id: None,
            name: format!("c1-unreachable-{n}"),
            address: "10.255.255.1".into(),
            port: Some(2222),
            username: "root".into(),
            auth: AuthDraft::Password { password: "testpass".into() },
            tags: vec![],
            charset: Charset::Utf8,
            shell_integration: None,
        })
        .expect("seed host")
}

async fn status(mgr: &SessionManager, aid: &str) -> AttemptInfo {
    mgr.connection_status(&Actor::Human, aid.to_string()).await.unwrap()
}

async fn wait_phase(mgr: &SessionManager, aid: &str, want: fn(&AttemptPhase) -> bool, tries: usize) -> AttemptInfo {
    for _ in 0..tries {
        let info = status(mgr, aid).await;
        if want(&info.phase) {
            return info;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("attempt {aid} 未达目标相位（当前 {:?}）", status(mgr, aid).await.phase);
}

/// 契约：begin(local) → Connecting 起步 → Ready 终态；Ready 后 cancel → NotFound
/// 无副作用（契约序列 4；迟到取消不得关闭已投递会话）。
#[tokio::test(flavor = "multi_thread")]
async fn ready_then_cancel_is_not_found_and_session_survives() {
    let m = mgr();
    let info = m.begin_connection(&Actor::Human, "local".into(), BeginConnectionOpts::default()).await.unwrap();
    let fin = wait_phase(&m, &info.attempt_id, |p| *p == AttemptPhase::Ready, 200).await;
    let sid = fin.session_id.clone().unwrap();
    // Ready 后迟到取消：NotFound、无副作用
    let out = m.cancel_connection(&Actor::Human, info.attempt_id.clone()).await.unwrap();
    assert!(matches!(out, CancelOutcome::NotFound), "迟到取消应 NotFound，得 {out:?}");
    let sess = m.list_sessions(&Actor::Human).await.unwrap();
    assert!(sess.iter().any(|s| s.id == sid), "已投递会话必须存活");
    // connection_status 恒返回终态
    assert_eq!(status(&m, &info.attempt_id).await.phase, AttemptPhase::Ready);
    // 清理
    let _ = m.close_session(&Actor::Human, sid).await;
}

/// DC1.5 幂等合并：同 (host, actor) 活跃 attempt 合并返回同 id；new_session 绕过。
#[tokio::test(flavor = "multi_thread")]
async fn merge_index_idempotent_and_new_session_bypass() {
    let m = mgr();
    let hid = seed_unreachable(&m);
    let a = m.begin_connection(&Actor::Human, hid.clone(), BeginConnectionOpts::default()).await.unwrap();
    let b = m.begin_connection(&Actor::Human, hid.clone(), BeginConnectionOpts::default()).await.unwrap();
    assert_eq!(a.attempt_id, b.attempt_id, "同 (host, actor) 活跃 attempt 应幂等合并");
    let c = m.begin_connection(&Actor::Human, hid.clone(), BeginConnectionOpts { new_session: true }).await.unwrap();
    assert_ne!(a.attempt_id, c.attempt_id, "new_session 显式绕过合并");
    // 双双受理取消 + 等终态（合并索引清理）
    assert!(matches!(m.cancel_connection(&Actor::Human, a.attempt_id.clone()).await.unwrap(), CancelOutcome::Cancelled));
    assert!(matches!(m.cancel_connection(&Actor::Human, c.attempt_id.clone()).await.unwrap(), CancelOutcome::Cancelled));
    wait_phase(&m, &a.attempt_id, |p| *p == AttemptPhase::Cancelled, 200).await;
    wait_phase(&m, &c.attempt_id, |p| *p == AttemptPhase::Cancelled, 200).await;
    // 终态后合并索引已清：再次 begin 得到全新 attempt
    let d = m.begin_connection(&Actor::Human, hid.clone(), BeginConnectionOpts::default()).await.unwrap();
    assert_ne!(d.attempt_id, a.attempt_id, "终态清理后 begin 应产生新 attempt");
    assert!(matches!(m.cancel_connection(&Actor::Human, d.attempt_id.clone()).await.unwrap(), CancelOutcome::Cancelled));
    wait_phase(&m, &d.attempt_id, |p| *p == AttemptPhase::Cancelled, 200).await;
}

/// 契约序列 1：受理取消（建连中）→ Cancelled 无 session 遗留；二次 cancel → NotFound（序列 6）。
#[tokio::test(flavor = "multi_thread")]
async fn cancel_while_connecting_leaves_no_session_and_second_cancel_is_not_found() {
    let m = mgr();
    let hid = seed_unreachable(&m);
    let info = m.begin_connection(&Actor::Human, hid, BeginConnectionOpts::default()).await.unwrap();
    assert_eq!(info.phase, AttemptPhase::Connecting);
    let out = m.cancel_connection(&Actor::Human, info.attempt_id.clone()).await.unwrap();
    assert!(matches!(out, CancelOutcome::Cancelled), "建连中取消应受理 Cancelled，得 {out:?}");
    let fin = wait_phase(&m, &info.attempt_id, |p| *p == AttemptPhase::Cancelled, 200).await;
    assert!(fin.session_id.is_none(), "取消终态不得携带会话");
    // select 兜底后 inner 已中断：无会话遗留
    let sess = m.list_sessions(&Actor::Human).await.unwrap();
    assert!(sess.is_empty(), "取消后不得有隐藏会话，实得 {}", sess.len());
    // 序列 6：终态后重复 cancel → NotFound
    let out2 = m.cancel_connection(&Actor::Human, info.attempt_id.clone()).await.unwrap();
    assert!(matches!(out2, CancelOutcome::NotFound));
}

/// 契约序列 5：跨 Actor 域取消 → NotFound 不泄露存在性 + 审计留痕。
#[tokio::test(flavor = "multi_thread")]
async fn cross_actor_cancel_denied() {
    let m = mgr();
    let hid = seed_unreachable(&m);
    let info = m.begin_connection(&Actor::Human, hid, BeginConnectionOpts::default()).await.unwrap();
    let agent = Actor::Agent { client_id: "c1-agent".into() };
    let out = m.cancel_connection(&agent, info.attempt_id.clone()).await.unwrap();
    assert!(matches!(out, CancelOutcome::NotFound), "跨域取消应 NotFound，得 {out:?}");
    // attempt 不受影响（仍在建连）
    assert!(!status(&m, &info.attempt_id).await.phase.is_terminal());
    // M2（DC1.5 互不可见）：跨域 status 同样不可见，不泄露 phase/session/error
    let x = m.connection_status(&agent, info.attempt_id.clone()).await;
    assert!(matches!(x, Err(session_api::Error::SessionNotFound)), "跨域 status 应不可见，得 {x:?}");
    // 审计留痕
    let evs = m.center.audit.query(&AuditFilter { limit: 50, ..Default::default() }).map(|p| p.events).unwrap_or_default();
    assert!(evs.iter().any(|e| e.action == "cross_actor_cancel_denied"), "跨域拒绝须审计留痕");
    assert!(matches!(m.cancel_connection(&Actor::Human, info.attempt_id.clone()).await.unwrap(), CancelOutcome::Cancelled));
    wait_phase(&m, &info.attempt_id, |p| *p == AttemptPhase::Cancelled, 200).await;
}

/// 契约序列 2：已提交未投递窗口取消 → AlreadyReady{sid} + 核心立即关闭 +
/// 终态 Cancelled（session 清空）+ 审计 connection_cancelled_closed + 事件 Cancelled。
#[tokio::test(flavor = "multi_thread")]
async fn window_cancel_already_ready_closes_session() {
    let m = mgr();
    let arrived = Arc::new(tokio::sync::Notify::new());
    let pause = Arc::new(tokio::sync::Notify::new());
    {
        let mut h = m.test_hooks.lock().unwrap();
        h.arrived_after_submit = Some(arrived.clone());
        h.pause_after_submit = Some(pause.clone());
    }
    let mut rx = m.subscribe_connections();
    let info = m.begin_connection(&Actor::Human, "local".into(), BeginConnectionOpts::default()).await.unwrap();
    // 任务到达「已提交未投递」暂停点
    tokio::time::timeout(Duration::from_secs(10), arrived.notified()).await.expect("未到达提交点");
    let out = m.cancel_connection(&Actor::Human, info.attempt_id.clone()).await.unwrap();
    match &out {
        CancelOutcome::AlreadyReady { session_id } => {
            let sess = m.list_sessions(&Actor::Human).await.unwrap();
            assert!(!sess.iter().any(|s| s.id == *session_id), "窗口取消必须立即关闭刚创建会话");
        }
        other => panic!("窗口取消应 AlreadyReady，得 {other:?}"),
    }
    pause.notify_one(); // 放行任务：应发现已终态而退出，不发 Ready
    let fin = wait_phase(&m, &info.attempt_id, |p| *p == AttemptPhase::Cancelled, 200).await;
    assert!(fin.session_id.is_none(), "关闭成功后终态 Cancelled session 清空");
    // 事件序列：终态事件 = Cancelled（不得出现 Ready——未投递）
    let mut phases = vec![];
    while let Ok(ev) = rx.try_recv() {
        if ev.attempt_id == info.attempt_id {
            phases.push(ev.phase);
        }
    }
    assert!(!phases.contains(&AttemptPhase::Ready), "窗口取消不得投递 Ready，事件序列 {phases:?}");
    assert!(phases.contains(&AttemptPhase::Cancelled));
    let evs = m.center.audit.query(&AuditFilter { limit: 50, ..Default::default() }).map(|p| p.events).unwrap_or_default();
    assert!(evs.iter().any(|e| e.action == "connection_cancelled_closed"), "窗口关闭成功须审计");
}

/// 契约序列 3：窗口取消 + 关闭失败 → 终态 CancelCloseFailed{sid}、会话保留、重复 cancel NotFound。
#[tokio::test(flavor = "multi_thread")]
async fn window_cancel_close_failed_keeps_session() {
    let m = mgr();
    let arrived = Arc::new(tokio::sync::Notify::new());
    let pause = Arc::new(tokio::sync::Notify::new());
    {
        let mut h = m.test_hooks.lock().unwrap();
        h.arrived_after_submit = Some(arrived.clone());
        h.pause_after_submit = Some(pause.clone());
        h.force_close_fail = true;
    }
    let info = m.begin_connection(&Actor::Human, "local".into(), BeginConnectionOpts::default()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), arrived.notified()).await.expect("未到达提交点");
    // 先记下窗口内已建会话（提交点已过：sessions 表有行）
    let sess_before = m.list_sessions(&Actor::Human).await.unwrap();
    assert_eq!(sess_before.len(), 1, "已提交：会话已在表");
    let sid = sess_before[0].id.clone();
    let out = m.cancel_connection(&Actor::Human, info.attempt_id.clone()).await.unwrap();
    match &out {
        CancelOutcome::CancelCloseFailed { session_id } => {
            assert_eq!(*session_id, sid);
            let sess = m.list_sessions(&Actor::Human).await.unwrap();
            assert!(sess.iter().any(|s| s.id == sid), "关闭失败会话必须保留（恢复入口）");
        }
        other => panic!("关闭失败应 CancelCloseFailed，得 {other:?}"),
    }
    pause.notify_one();
    let fin = wait_phase(&m, &info.attempt_id, |p| *p == AttemptPhase::CancelCloseFailed, 200).await;
    assert_eq!(fin.session_id.as_deref(), Some(sid.as_str()), "CancelCloseFailed 保留 session_id");
    assert!(fin.error.is_some(), "CancelCloseFailed 须携带错误载荷");
    // 终态后重复 cancel → NotFound（契约：关闭失败后 attempt 已终态）
    let out2 = m.cancel_connection(&Actor::Human, info.attempt_id.clone()).await.unwrap();
    assert!(matches!(out2, CancelOutcome::NotFound));
    // 清理
    {
        let mut h = m.test_hooks.lock().unwrap();
        h.force_close_fail = false;
    }
    let _ = m.close_session(&Actor::Human, sid).await;
}

/// v1 兼容：create_session 同步路径不经 attempt 注册表、行为不变。
#[tokio::test(flavor = "multi_thread")]
async fn create_session_compat_path_untouched() {
    let m = mgr();
    let sid = m.create_session(&Actor::Human, CreateSessionReq { host_id: "local".into() }).await.unwrap();
    let attempts = m.attempts.lock().unwrap();
    assert!(attempts.is_empty(), "v1 兼容路径不得产生 attempt");
    let _ = m.close_session(&Actor::Human, sid).await;
}

/// 取消事件以终态为准（DC1.2）：受理路径的 Cancelled 事件仅在终态结算后发出。
#[tokio::test(flavor = "multi_thread")]
async fn cancel_events_carry_terminal_phase_only() {
    let m = mgr();
    let hid = seed_unreachable(&m);
    let mut rx = m.subscribe_connections();
    let info = m.begin_connection(&Actor::Human, hid, BeginConnectionOpts::default()).await.unwrap();
    assert!(matches!(m.cancel_connection(&Actor::Human, info.attempt_id.clone()).await.unwrap(), CancelOutcome::Cancelled));
    wait_phase(&m, &info.attempt_id, |p| *p == AttemptPhase::Cancelled, 200).await;
    let mut phases = vec![];
    while let Ok(ev) = rx.try_recv() {
        if ev.attempt_id == info.attempt_id {
            phases.push(ev.phase);
        }
    }
    assert!(phases.contains(&AttemptPhase::Cancelled), "终态事件必须存在：{phases:?}");
    assert!(!phases.contains(&AttemptPhase::Failed), "取消不得以 Failed 收场：{phases:?}");
}

/// fabricate：直接登记一个 attempt 条目（白盒——驱动受理/清扫路径，不依赖网络时序）。
    fn fabricate_entry(m: &SessionManager, host_id: &str, pending_sid: Option<SessionId>) -> Arc<AttemptEntry> {
        let attempt_id = format!("at-fab-{}", uuid::Uuid::new_v4());
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let entry = Arc::new(AttemptEntry {
            info: AttemptInfo {
                attempt_id: attempt_id.clone(),
                host_id: host_id.into(),
                actor: "human".into(),
                phase: AttemptPhase::Connecting,
                session_id: None,
                created_at: chrono::Utc::now(),
                error: None,
            },
            st: tokio::sync::Mutex::new(AttemptState {
                phase: AttemptPhase::Connecting,
                session_id: None,
                pending_sid,
                error: None,
                submitted: false,
                delivered: false,
                cancel_requested: false,
            }),
            cancel_tx,
            cancel_rx,
            term: std::sync::atomic::AtomicBool::new(false),
        });
        m.attempts
            .lock().unwrap()
            .insert(attempt_id.clone(), entry.clone());
        m.merge_index
            .lock().unwrap()
            .insert((host_id.into(), "human".into()), attempt_id);
        entry
    }

    /// M1（取消作废 TOFU 卡）：待决卡被移除（查询面无死卡）+ 门以拒绝结算 + 终态 Cancelled。
    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_while_gate_pending_clears_cards() {
        let m = mgr();
        let entry = fabricate_entry(&m, "h-ssh-x", None);
        let aid = entry.info.attempt_id.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        m.center.hk_pending.lock().unwrap().insert(
            "hk-t1".into(),
            PendingHostKey {
                id: "hk-t1".into(),
                host_id: "h-ssh-x".into(),
                host_name: "x".into(),
                address: "10.255.255.1".into(),
                port: 2222,
                issue: HostKeyIssue::FirstSeen,
                fingerprint: "SHA256:t".into(),
                previous_fingerprint: None,
                created_at: chrono::Utc::now(),
                attempt_id: Some(aid.clone()),
            },
        );
        m.center.hk_decisions.lock().unwrap().insert("hk-t1".into(), tx);
        let out = m.cancel_connection(&Actor::Human, aid.clone()).await.unwrap();
        assert!(matches!(out, CancelOutcome::Cancelled), "受理取消得 {out:?}");
        assert!(m.center.hk_pending.lock().unwrap().is_empty(), "待决卡必须移除（M1 幽灵卡）");
        assert!(!rx.await.unwrap(), "门以拒绝结算");
        // fabricated 条目无 run_attempt 任务——终态由本测试代任务结算（任务侧结算
        // 已由 cancel_while_connecting 等真路径测试覆盖）
        let mut st = entry.st.lock().await;
        entry.settle(&mut st, AttemptPhase::Cancelled);
        assert!(st.session_id.is_none());
    }

    /// H2（幽灵清扫）：inner 已过 insert 点（pending_sid 在案）被取消 drop——
    /// settle_cancel_with_ghost 关闭幽灵会话；关闭失败改判 CancelCloseFailed（会话保留）。
    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_ghost_sweep_closes_never_delivered_session() {
        let m = mgr();
        // 真实本地会话当幽灵（inner insert 后、返回前被 drop 的等价物）
        let sid = m.create_session(&Actor::Human, CreateSessionReq { host_id: "local".into() }).await.unwrap();
        let entry = fabricate_entry(&m, "local", Some(sid.clone()));
        let aid = entry.info.attempt_id.clone();
        let settled_ccf = m.settle_cancel_with_ghost(&entry, &Actor::Human, &aid).await;
        assert!(!settled_ccf, "正常关闭应继续常规 Cancelled 结算");
        let sess = m.list_sessions(&Actor::Human).await.unwrap();
        assert!(!sess.iter().any(|x| x.id == sid), "幽灵会话必须被清扫（H2）");
        let evs = m.center.audit.query(&AuditFilter { limit: 50, ..Default::default() }).map(|p| p.events).unwrap_or_default();
        assert!(evs.iter().any(|e| e.action == "connection_cancelled_closed"), "幽灵关闭须审计");
        // 关闭失败分支：sid 不存在 → close 必败 → helper 结算 CCF 并返回 true（跳过常规结算）
        let sid2 = "s-ghost-missing".to_string();
        let entry2 = fabricate_entry(&m, "local", Some(sid2.clone()));
        let settled_ccf2 = m.settle_cancel_with_ghost(&entry2, &Actor::Human, &entry2.info.attempt_id).await;
        assert!(settled_ccf2, "关闭失败应结算 CCF 并让调用方跳过常规结算");
        let st = entry2.st.lock().await;
        assert_eq!(st.phase, AttemptPhase::CancelCloseFailed);
        assert_eq!(st.session_id.as_deref(), Some(sid2.as_str()), "CCF 保留会话（恢复入口）");
        assert!(st.error.is_some(), "CCF 须携带错误载荷");
    }

    /// M3（并发 begin 幂等）：同 (host, actor) 并发 begin——合并临界区保证单 attempt。
    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_begin_merges_to_one_attempt() {
        let m = mgr();
        let hid = seed_unreachable(&m);
        let (a, b) = tokio::join!(
            m.begin_connection(&Actor::Human, hid.clone(), BeginConnectionOpts::default()),
            m.begin_connection(&Actor::Human, hid.clone(), BeginConnectionOpts::default()),
        );
        let a = a.unwrap();
        let b = b.unwrap();
        assert_eq!(a.attempt_id, b.attempt_id, "并发 begin 必须幂等合并（M3），得 {} != {}", a.attempt_id, b.attempt_id);
        assert_eq!(m.attempts.lock().unwrap().len(), 1, "只应有一个 attempt 条目");
        assert!(matches!(m.cancel_connection(&Actor::Human, a.attempt_id.clone()).await.unwrap(), CancelOutcome::Cancelled));
        wait_phase(&m, &a.attempt_id, |p| p.is_terminal(), 200).await;
    }

    /// M4（并发取消）：双 cancel 并发——不得产生假 CancelCloseFailed（「会话保留」误报）。
    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_cancel_never_reports_cancel_close_failed() {
        let m = mgr();
        let hid = seed_unreachable(&m);
        let info = m.begin_connection(&Actor::Human, hid, BeginConnectionOpts::default()).await.unwrap();
        let (r1, r2) = tokio::join!(
            m.cancel_connection(&Actor::Human, info.attempt_id.clone()),
            m.cancel_connection(&Actor::Human, info.attempt_id.clone()),
        );
        for r in [r1, r2] {
            let out = r.unwrap();
            assert!(!matches!(out, CancelOutcome::CancelCloseFailed { .. }), "并发取消不得产出 CCF，得 {out:?}");
            assert!(
                matches!(out, CancelOutcome::Cancelled | CancelOutcome::NotFound),
                "并发取消只允许 Cancelled/NotFound，得 {out:?}"
            );
        }
        wait_phase(&m, &info.attempt_id, |p| *p == AttemptPhase::Cancelled, 200).await;
    }

    /// DC1.4（建连审批卡作废）：取消受理作废 Pending 审批卡——Voided 留痕 + 决策通道 Voided。
    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_voids_pending_approval_card() {
        let m = mgr();
        let entry = fabricate_entry(&m, "h-ssh-y", None);
        let aid = entry.info.attempt_id.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let item = session_api::ApprovalItem {
            id: "ap-t1".into(),
            session_id: "s-none".into(),
            agent_id: "agent-t".into(),
            command: "ls /tmp".into(),
            edited_command: None,
            target_summary: String::new(),
            segment_report: vec![],
            session_busy: false,
            editable: false,
            created_at: chrono::Utc::now(),
            status: ApprovalStatus::Pending,
            attempt_id: Some(aid.clone()),
            purpose: None,
        };
        m.center.items.lock().unwrap().insert("ap-t1".into(), item);
        m.center.decisions.lock().unwrap().insert("ap-t1".into(), tx);
        let out = m.cancel_connection(&Actor::Human, aid.clone()).await.unwrap();
        assert!(matches!(out, CancelOutcome::Cancelled));
        let st_item = m.center.items.lock().unwrap().get("ap-t1").cloned();
        assert_eq!(st_item.map(|i| i.status), Some(ApprovalStatus::Voided), "审批卡必须作废（DC1.4）");
        assert!(matches!(rx.await, Ok(DecisionMsg::Voided)), "决策通道以 Voided 结算");
        let evs = m.center.audit.query(&AuditFilter { limit: 50, ..Default::default() }).map(|p| p.events).unwrap_or_default();
        assert!(evs.iter().any(|e| e.action == "approval_voided"), "作废须审计留痕");
    }

    /// Failed 终态与审计：连接快速被拒（127.0.0.1:1）→ Failed + error 载荷 + connection_failed 审计。
    #[tokio::test(flavor = "multi_thread")]
    async fn failed_attempt_carries_error_and_audit() {
        let m = mgr();
        let hid = m.center.vault.upsert_host(&HostDraft {
            id: None,
            name: "c1-refused".into(),
            address: "127.0.0.1".into(),
            port: Some(1),
            username: "root".into(),
            auth: AuthDraft::Password { password: "x".into() },
            tags: vec![],
            charset: Charset::Utf8,
            shell_integration: None,
        }).expect("seed refused host");
        let info = m.begin_connection(&Actor::Human, hid, BeginConnectionOpts::default()).await.unwrap();
        let fin = wait_phase(&m, &info.attempt_id, |p| *p == AttemptPhase::Failed, 200).await;
        assert!(fin.session_id.is_none(), "Failed 不得携带会话");
        assert!(fin.error.is_some(), "Failed 须携带错误载荷");
        let evs = m.center.audit.query(&AuditFilter { limit: 50, ..Default::default() }).map(|p| p.events).unwrap_or_default();
        assert!(evs.iter().any(|e| e.action == "connection_failed"), "失败须审计");
    }

// ---- R23 前置清单（rev-r19 登记四条回归网缺口）----

/// H1 让渡分支变体：窗口取消后第二次 cancel → NotFound，不重复关闭、事件序列无
/// 双终态（首次已结算 Cancelled；重复取消走终态 NotFound 口径）。
#[tokio::test(flavor = "multi_thread")]
async fn window_double_cancel_second_is_not_found_single_close() {
    let m = mgr();
    let arrived = Arc::new(tokio::sync::Notify::new());
    let pause = Arc::new(tokio::sync::Notify::new());
    {
        let mut h = m.test_hooks.lock().unwrap();
        h.arrived_after_submit = Some(arrived.clone());
        h.pause_after_submit = Some(pause.clone());
    }
    let mut rx = m.subscribe_connections();
    let info = m.begin_connection(&Actor::Human, "local".into(), BeginConnectionOpts::default()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), arrived.notified()).await.expect("未到达提交点");
    let out1 = m.cancel_connection(&Actor::Human, info.attempt_id.clone()).await.unwrap();
    assert!(matches!(out1, CancelOutcome::AlreadyReady { .. }), "首次窗口取消 AlreadyReady，得 {out1:?}");
    // 暂停期内二次取消：任务尚未结算终态（Cancelled）——按「提交后已受理」走
    // Cancelled/NotFound 之一，但绝不产生 CancelCloseFailed 或第二次关闭
    let out2 = m.cancel_connection(&Actor::Human, info.attempt_id.clone()).await.unwrap();
    assert!(
        matches!(out2, CancelOutcome::NotFound | CancelOutcome::Cancelled),
        "二次取消不得报 CancelCloseFailed/AlreadyReady，得 {out2:?}"
    );
    pause.notify_one();
    let fin = wait_phase(&m, &info.attempt_id, |p| *p == AttemptPhase::Cancelled, 200).await;
    assert!(fin.session_id.is_none());
    let sess = m.list_sessions(&Actor::Human).await.unwrap();
    assert!(sess.is_empty(), "会话恰好关闭一次，无遗留");
    let mut phases = vec![];
    while let Ok(ev) = rx.try_recv() {
        if ev.attempt_id == info.attempt_id {
            phases.push(ev.phase);
        }
    }
    assert_eq!(phases.iter().filter(|p| **p == AttemptPhase::Cancelled).count(), 1, "终态事件恰一次 {phases:?}");
}

/// H2 端到端（inner 中段取消全链）：建连中受理取消 → 事件序 Connecting…Cancelled
/// 无 Ready + 合并索引清理（后续 begin 全新 id）+ 审计 connection_cancelled。
#[tokio::test(flavor = "multi_thread")]
async fn mid_connect_cancel_end_to_end_chain() {
    let m = mgr();
    let hid = seed_unreachable(&m);
    let mut rx = m.subscribe_connections();
    let info = m.begin_connection(&Actor::Human, hid.clone(), BeginConnectionOpts::default()).await.unwrap();
    wait_phase(&m, &info.attempt_id, |p| *p == AttemptPhase::Connecting, 100).await;
    assert!(matches!(m.cancel_connection(&Actor::Human, info.attempt_id.clone()).await.unwrap(), CancelOutcome::Cancelled));
    let fin = wait_phase(&m, &info.attempt_id, |p| *p == AttemptPhase::Cancelled, 200).await;
    assert!(fin.session_id.is_none() && fin.error.is_none(), "Cancelled 无会话无错误载荷");
    let mut phases = vec![];
    while let Ok(ev) = rx.try_recv() {
        if ev.attempt_id == info.attempt_id {
            phases.push(ev.phase);
        }
    }
    // 事件契约（R19）：起步相位随 begin 应答携带、事件只载转换/终态——取消链
    // 事件序恰为 [Cancelled]，不得出现 Ready
    assert!(phases.contains(&AttemptPhase::Cancelled), "事件序应含终态 {phases:?}");
    assert!(!phases.contains(&AttemptPhase::Ready), "取消链不得出现 Ready {phases:?}");
    // 合并索引已清：后续 begin 是全新 attempt（终态条目保留但合并不复用）
    let again = m.begin_connection(&Actor::Human, hid, BeginConnectionOpts::default()).await.unwrap();
    assert_ne!(again.attempt_id, info.attempt_id);
    assert!(matches!(m.cancel_connection(&Actor::Human, again.attempt_id.clone()).await.unwrap(), CancelOutcome::Cancelled));
    wait_phase(&m, &again.attempt_id, |p| *p == AttemptPhase::Cancelled, 200).await;
    let evs = m.center.audit.query(&AuditFilter { limit: 80, ..Default::default() }).map(|p| p.events).unwrap_or_default();
    assert!(evs.iter().any(|e| e.action == "connection_cancelled"), "取消须审计");
}

/// 窗口态并发双 cancel：两路 cancel 同时打向暂停中的 attempt——恰一次 AlreadyReady、
/// 恰一次会话关闭、无 CancelCloseFailed、终态唯一。
#[tokio::test(flavor = "multi_thread")]
async fn window_concurrent_double_cancel_single_settlement() {
    let m = mgr();
    let arrived = Arc::new(tokio::sync::Notify::new());
    let pause = Arc::new(tokio::sync::Notify::new());
    {
        let mut h = m.test_hooks.lock().unwrap();
        h.arrived_after_submit = Some(arrived.clone());
        h.pause_after_submit = Some(pause.clone());
    }
    let info = m.begin_connection(&Actor::Human, "local".into(), BeginConnectionOpts::default()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), arrived.notified()).await.expect("未到达提交点");
    let aid1 = info.attempt_id.clone();
    let aid2 = info.attempt_id.clone();
    let (r1, r2) = tokio::join!(
        m.cancel_connection(&Actor::Human, aid1),
        m.cancel_connection(&Actor::Human, aid2),
    );
    let outs = [r1.unwrap(), r2.unwrap()];
    let already = outs.iter().filter(|o| matches!(o, CancelOutcome::AlreadyReady { .. })).count();
    let not_found = outs.iter().filter(|o| matches!(o, CancelOutcome::NotFound)).count();
    assert!(
        already + not_found == 2 && already >= 1,
        "并发双取消应一次 AlreadyReady + 一次 NotFound（或受理序差异），得 {outs:?}"
    );
    assert!(!outs.iter().any(|o| matches!(o, CancelOutcome::CancelCloseFailed { .. })), "不得报关闭失败 {outs:?}");
    pause.notify_one();
    let fin = wait_phase(&m, &info.attempt_id, |p| *p == AttemptPhase::Cancelled, 200).await;
    assert!(fin.session_id.is_none(), "终态会话清空");
    let sess = m.list_sessions(&Actor::Human).await.unwrap();
    assert!(sess.is_empty(), "恰好一次关闭，无遗留");
}

/// v1 create_session 幽灵面（R23 闭环）：record_session 失败 → Err 上抛且半会话被
/// 清扫（sessions 表无遗留——旧代码此处插入后直接 return Err，幽灵留存）。
#[tokio::test(flavor = "multi_thread")]
async fn v1_record_failure_sweeps_half_session() {
    let m = mgr();
    m.test_hooks.lock().unwrap().force_record_fail = true;
    let r = m.create_session(&Actor::Human, CreateSessionReq { host_id: "local".into() }).await;
    assert!(r.is_err(), "注入失败必须上抛");
    let sess = m.list_sessions(&Actor::Human).await.unwrap();
    assert!(sess.is_empty(), "半会话必须被清扫，实得 {}", sess.len());
    m.test_hooks.lock().unwrap().force_record_fail = false;
    // 恢复后 v1 路径照常工作
    let sid = m.create_session(&Actor::Human, CreateSessionReq { host_id: "local".into() }).await.unwrap();
    assert!(sid.starts_with("s-"));
    let _ = m.close_session(&Actor::Human, sid).await;
}
