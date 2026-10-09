//! R43（C9 / D03 / D08）协作启用生命周期：admission 门、原子停用、会话转 Human、
//! 失败保持封闭、显式重启用。不建真 SSH：手装 SessionHandle + 恒败 Stub 通道
//! （同 r40/r41/r42 工艺）——只驱动 admission 门、审批卡与控制权三处状态。

use super::*;
use session_api::transport::{ChannelHandle, FreshOutcome, TransportSignal};

struct R43Channel;
#[async_trait::async_trait]
impl ChannelHandle for R43Channel {
    async fn write(&self, _data: &[u8]) -> Result<()> { Err(Error::InvalidInput("stub".into())) }
    async fn resize(&self, _cols: u16, _rows: u16) -> Result<()> { Ok(()) }
    async fn exec_fresh(&self, _cmd: &str, _opts: &ExecOpts, _deadline: std::time::Instant, _cancel: &session_api::transport::tokio_util_sync::CancellationToken) -> Result<FreshOutcome> { Err(Error::InvalidInput("stub".into())) }
    async fn signal(&self, _sig: TransportSignal) -> Result<()> { Ok(()) }
    async fn force_close(&self) -> Result<()> { Ok(()) }
    fn subscribe_output(&self) -> broadcast::Receiver<Vec<u8>> { broadcast::channel(1).1 }
    async fn is_alive(&self) -> bool { false }
    async fn reconnect(&self) -> Result<()> { Err(Error::InvalidInput("stub".into())) }
    async fn close(&self) -> Result<()> { Ok(()) }
    async fn upload(&self, _local: &std::path::Path, _remote: &str, _cancel: &session_api::transport::tokio_util_sync::CancellationToken, _progress: &(dyn Fn(u64, Option<u64>) + Send + Sync)) -> Result<u64> { Err(Error::InvalidInput("stub".into())) }
    async fn download(&self, _remote: &str, _local: &std::path::Path, _cancel: &session_api::transport::tokio_util_sync::CancellationToken, _progress: &(dyn Fn(u64, Option<u64>) + Send + Sync)) -> Result<u64> { Err(Error::InvalidInput("stub".into())) }
    async fn list_dir(&self, _path: &str) -> Result<Vec<DirEntryS>> { Err(Error::InvalidInput("stub".into())) }
    async fn resolve_path(&self, _path: Option<&str>) -> Result<PathResolved> { Ok(PathResolved { canonical: "/home/u".into() }) }
    async fn stat_entry(&self, path: &str) -> Result<EntryStat> {
        Ok(EntryStat { canonical: Some(path.into()), kind: Some(EntryKind::File), is_dir: false, size: Some(0), mtime: None, symlink_target: None })
    }
    async fn start_forward(&self, _spec: session_api::ForwardSpec) -> Result<session_api::ForwardId> { Err(Error::InvalidInput("stub".into())) }
    async fn stop_forward(&self, _id: &session_api::ForwardId) -> Result<()> { Err(Error::InvalidInput("stub".into())) }
    async fn list_forwards(&self) -> Result<Vec<session_api::ForwardInfo>> { Ok(vec![]) }
    fn set_forward_event_cb(&self, _cb: session_api::ForwardStateCb) {}
}

/// 全新库（自 user_version=0 建起）——默认**关闭**协作（D03 新装态）。
fn mgr() -> Arc<SessionManager> {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = std::env::temp_dir().join(format!("r43-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    SessionManager::open(&dir.join("t.db")).unwrap()
}

/// 已启用协作的既有安装（显式开 admission 门）。
fn mgr_enabled() -> Arc<SessionManager> {
    let m = mgr();
    *m.center.collab.lock().unwrap() = CollabGate::new(true);
    m
}

fn host() -> Host {
    Host {
        id: "h-1".into(), name: "prod-1".into(), address: "10.0.0.11".into(), port: 22,
        username: "ops".into(), auth_type: AuthType::Password, identity_id: None,
        tags: vec![], fingerprint: None, shell_integration: Some(true), charset: Charset::Utf8,
    }
}

fn mk_handle(sid: &str, owner: ControlOwner, center: Arc<ApprovalCenter>) -> Arc<SessionHandle> {
    let screen = term_core::Screen::new(term_core::ScreenConfig { cols: 80, rows: 24, scrollback: 100, lossless_cap: 1 << 20 });
    SessionHandle::new(sid.into(), host(), "ssh".into(), Arc::new(R43Channel), screen, center, owner)
}

fn register(m: &SessionManager, h: Arc<SessionHandle>) {
    m.sessions.lock().unwrap().insert(h.id.clone(), h.clone());
}

fn needs_approval(cmd: &str) -> tinyssh_approval::Evaluation {
    tinyssh_approval::Evaluation {
        verdict: tinyssh_approval::SegmentVerdict::NeedsApproval,
        segments: vec![SegmentReport { segment: cmd.into(), verdict: "pending: 未命中任何允许规则".into() }],
    }
}

fn agent() -> Actor { Actor::Agent { client_id: "opencode".into() } }

async fn wait_card(m: &SessionManager, sid: &str) -> ApprovalItem {
    for _ in 0..300 {
        let items = m.list_approvals(&Actor::Human, ApprovalFilter { session_id: Some(sid.into()), pending_only: true, ..Default::default() }).await.unwrap();
        if let Some(it) = items.into_iter().next() {
            return it;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("审批卡未在 3s 内出现");
}

/// 起一个 Agent 阻塞审批（返回 JoinHandle），并等其待审卡出现。
async fn spawn_pending(m: &Arc<SessionManager>, sid: &str, cmd: &str) -> (tokio::task::JoinHandle<Result<(ApprovalTrace, Option<String>)>>, ApprovalItem) {
    let h = m.sessions.lock().unwrap().get(sid).cloned().expect("session");
    let c = cmd.to_string();
    let j = tokio::spawn(async move {
        h.wait_approval(
            &Actor::Agent { client_id: "opencode".into() }, &"opencode".to_string(), &"e-1".to_string(),
            &c, &needs_approval(&c), true, false,
            session_api::transport::tokio_util_sync::CancellationToken::new(),
        ).await
    });
    let card = wait_card(m, sid).await;
    (j, card)
}

/// D03：新装未启用协作——无应用拥有的 MCP 端点；admission 关闭，Agent 请求被拒。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r43_fresh_install_no_endpoint_and_gate_closed() {
    let m = mgr();
    let st = m.collab_status(&Actor::Human).await.unwrap();
    assert_eq!(st.state, CollabState::Disabled, "新装默认停用协作");
    assert_eq!(st.endpoint, "", "新装未启用：应用不启动 MCP 端点（无自动监听）");
    assert_eq!(st.generation, 0);

    // admission 关闭：Agent 新建会话被拒（人类不受影响）
    let err = m.create_session(&agent(), CreateSessionReq { host_id: "local".into() }).await.unwrap_err();
    assert!(matches!(err, Error::CollabDisabled), "停用期间 Agent 请求被拒：{err:?}");
    assert!(m.create_session(&Actor::Human, CreateSessionReq { host_id: "local".into() }).await.is_ok(),
        "人类请求不经 admission 门");
}

/// D08：确认停用先**原子**封 admission，随后作废存量、Agent 会话转 Human（不终止任务）；
/// 核心 gate 关闭 + 端点停止两条件齐备后才 Disabled。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r43_disable_seals_admission_voids_and_converts() {
    let m = mgr_enabled();
    let h = mk_handle("s-1", ControlOwner::Agent, m.center.clone());
    register(&m, h.clone());
    let (j, card) = spawn_pending(&m, "s-1", "rm -rf /tmp/old-build").await;

    // 影响预览（确认前如实展示）
    let impact = m.collab_disable_preview(&Actor::Human).await.unwrap();
    assert_eq!(impact.agent_owned_sessions, 1);
    assert_eq!(impact.pending_approvals, 1);

    // 确认停用：立即封 admission（不等待逐个接管）+ 作废待审 + 会话转 Human
    let report = m.collab_disable(&Actor::Human).await.unwrap();
    assert_eq!(report.voided_approvals, 1, "待审批请求作废");
    assert_eq!(report.converted_sessions, 1, "Agent 会话转回 Human");

    // 阻塞中的 Agent 调用立即收到作废通知（不空等超时）
    assert!(matches!(j.await.unwrap(), Err(Error::VoidedByHandback { .. })), "作废唤醒等待方");

    // 封口后：admission 关闭（含无 session 的 create_session）
    assert!(m.center.admit_agent().is_err(), "停用后 admission 关闭");
    assert!(matches!(
        m.create_session(&agent(), CreateSessionReq { host_id: "local".into() }).await.unwrap_err(),
        Error::CollabDisabled
    ));

    // 会话已转 Human，但历史保留（曾被 Agent 持有）
    let info = m.list_sessions(&Actor::Human).await.unwrap().into_iter().find(|s| s.id == "s-1").unwrap();
    assert_eq!(info.control_owner, ControlOwner::Human, "停用不终止任务，仅转换控制权");

    // 旧作废卡不复活
    let old = m.list_approvals(&Actor::Human, ApprovalFilter::default()).await.unwrap()
        .into_iter().find(|it| it.id == card.id).unwrap();
    assert_eq!(old.status, ApprovalStatus::Voided);

    // 端点停止确认前仍为 Disabling（两层均需确认）
    let st = m.collab_status(&Actor::Human).await.unwrap();
    assert_eq!(st.state, CollabState::Disabling, "端点未确认停止前不得 Disabled");
    assert!(st.generation >= 1, "封口递增代际，供旧请求核对");
    m.collab_mark_endpoint_stopped(&Actor::Human).await.unwrap();
    let st = m.collab_status(&Actor::Human).await.unwrap();
    assert_eq!(st.state, CollabState::Disabled);
    assert_eq!(st.endpoint, "");
    assert_eq!(st.active_requests, 0);
}

/// D08：批准后、执行前复核 admission——停用期间「已批准未执行」的请求作废，
/// 不因旧审批决定继续执行（与停用的竞态由执行前复核兜住）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r43_approved_request_after_disable_is_voided_not_executed() {
    let m = mgr_enabled();
    let h = mk_handle("s-1", ControlOwner::Agent, m.center.clone());
    register(&m, h.clone());
    let (j, card) = spawn_pending(&m, "s-1", "systemctl restart nginx").await;

    // 人类点了批准，但此刻 admission 已封（模拟与停用竞态）
    m.center.collab.lock().unwrap().state = CollabState::Disabling;
    m.decide_approval(&Actor::Human, card.id.clone(), Decision::Approve).await.unwrap();

    let r = j.await.unwrap();
    assert!(matches!(r, Err(Error::CollabDisabled)), "停用期间已批准未执行的请求作废：{r:?}");
    let it = m.list_approvals(&Actor::Human, ApprovalFilter::default()).await.unwrap()
        .into_iter().find(|x| x.id == card.id).unwrap();
    assert_eq!(it.status, ApprovalStatus::Voided, "竞态下批准不得生效");
}

/// §9：停用未完成/失败保持 Disabling/DisableFailed 且 admission 继续关闭；允许重试收敛。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r43_disable_failed_keeps_gate_closed_and_can_retry() {
    let m = mgr_enabled();
    m.collab_disable(&Actor::Human).await.unwrap();
    m.collab_mark_disable_failed(&Actor::Human, "endpoint stop failed".into()).await.unwrap();
    assert_eq!(m.collab_status(&Actor::Human).await.unwrap().state, CollabState::DisableFailed);
    assert!(m.center.admit_agent().is_err(), "停用失败保持封闭，不得回退为可用");

    // 重试：再次封口（幂等）+ 端点停止确认 → Disabled
    m.collab_disable(&Actor::Human).await.unwrap();
    m.collab_mark_endpoint_stopped(&Actor::Human).await.unwrap();
    assert_eq!(m.collab_status(&Actor::Human).await.unwrap().state, CollabState::Disabled);
    assert!(m.center.admit_agent().is_err());
}

/// §9：重新启用须**显式**且核心确认旧停用已收敛；先前作废请求不复活；
/// Disabling 中不得重开。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r43_enable_requires_convergence_and_does_not_revive_voided() {
    let m = mgr_enabled();
    let h = mk_handle("s-1", ControlOwner::Agent, m.center.clone());
    register(&m, h.clone());
    let (j, card) = spawn_pending(&m, "s-1", "docker system prune -f").await;

    m.collab_disable(&Actor::Human).await.unwrap();
    assert!(matches!(j.await.unwrap(), Err(Error::VoidedByHandback { .. })));
    // Disabling 中不得重开（旧停用未收敛）
    assert!(m.collab_enable(&Actor::Human).await.is_err(), "停用处理未收敛不得重开");
    m.collab_mark_endpoint_stopped(&Actor::Human).await.unwrap();

    // 显式重新启用
    m.collab_enable(&Actor::Human).await.unwrap();
    let st = m.collab_status(&Actor::Human).await.unwrap();
    assert_eq!(st.state, CollabState::Enabled);
    assert!(m.center.admit_agent().is_ok(), "重新启用后 admission 开放");
    assert!(m.create_session(&agent(), CreateSessionReq { host_id: "local".into() }).await.is_ok());

    // 旧作废请求不复活
    let old = m.list_approvals(&Actor::Human, ApprovalFilter::default()).await.unwrap()
        .into_iter().find(|it| it.id == card.id).unwrap();
    assert_eq!(old.status, ApprovalStatus::Voided, "重新启用不复活已作废请求");
    assert!(m.decide_approval(&Actor::Human, card.id.clone(), Decision::Approve).await.is_err(),
        "已作废卡片不得再生效");
}

/// §9：仅有登记身份 ≠ Agent 在线——「已配置」与「有活动请求」分别统计。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r43_status_separates_configured_from_active() {
    let m = mgr_enabled();
    m.center.vault.create_agent("opencode", "OpenCode").unwrap();
    m.center.vault.create_agent("helper", "Helper").unwrap();

    let st = m.collab_status(&Actor::Human).await.unwrap();
    assert_eq!(st.configured_agents, 2, "已配置 Agent 数");
    assert_eq!(st.active_requests, 0, "无待审批/无 Agent 持有会话 → 无活动请求");

    let h = mk_handle("s-1", ControlOwner::Agent, m.center.clone());
    register(&m, h.clone());
    let st = m.collab_status(&Actor::Human).await.unwrap();
    assert_eq!(st.active_requests, 1, "Agent 持有会话计入活动请求");
    assert_eq!(st.configured_agents, 2, "配置数不因活动变化");
}

// ---------------------------------------------------------------------------
// 独立审核 rev-r43 处置（F1/F2/F3）：补齐「排队/未启动动作作废」与「收敛前置」的回归护栏。

/// D08 / §9「覆盖…排队传输及…待启动动作」：停用转换控制权时须**推进会话代际**
/// （与接管同口径）。代际是排队 exec / 排队传输在执行开始前的唯一作废判定点；
/// 不推进则这类**无审批卡**的动作会在停用后照常开跑（审核 F1）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r43_disable_advances_session_generation() {
    let m = mgr_enabled();
    let h = mk_handle("s-1", ControlOwner::Agent, m.center.clone());
    register(&m, h.clone());
    let g0 = h.generation.load(std::sync::atomic::Ordering::SeqCst);
    m.collab_disable(&Actor::Human).await.unwrap();
    assert!(
        h.generation.load(std::sync::atomic::Ordering::SeqCst) > g0,
        "停用须推进会话代际——否则排队动作不被作废"
    );
}

/// D08：停用须作废「排队中/未启动」的 Agent 动作——覆盖**无需审批**（AutoAllow，
/// 因而没有审批卡可作废）的那一类（审核 F1 的具体失败场景：占住串行槽使 exec 排队，
/// 排队期间确认停用，取槽后必须作废而非执行）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r43_queued_auto_allow_exec_voided_by_disable() {
    let m = mgr_enabled();
    // AutoAllow 规则 → 该 exec 不生成审批卡，只可能被「代际/admission」作废
    m.center.vault.create_agent("opencode", "OpenCode").unwrap();
    m.center.vault.add_allow_pattern("opencode", "echo *", "echo 放行").unwrap();
    let h = mk_handle("s-1", ControlOwner::Agent, m.center.clone());
    register(&m, h.clone());

    // 占住 exec 串行槽，迫使后续 exec 排队
    let hold = h.exec_slot.lock().await;
    let h2 = h.clone();
    let j = tokio::spawn(async move { h2.exec(&agent(), "echo queued-ok", ExecOpts::default()).await });
    for _ in 0..300 {
        if !h.pending.lock().unwrap().is_empty() { break; }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(!h.pending.lock().unwrap().is_empty(), "exec 应已进入排队");

    // 排队期间确认停用（封 admission + 推进代际）
    m.collab_disable(&Actor::Human).await.unwrap();
    drop(hold); // 释放槽位 → 排队的 exec 取槽后复核

    let r = j.await.unwrap();
    assert!(
        matches!(r, Err(Error::VoidedByHandback { .. }) | Err(Error::CollabDisabled)),
        "停用后排队动作必须作废，不得执行（Stub 通道执行会返回 stub 错）：{r:?}"
    );
}

/// D08：批准后复核 admission 须**两臂对称**——「编辑后批准」（ApproveEdited）是 UI
/// 可达路径（审批卡的「保存并批准」），漏掉它会绕过停用复核（审核 F2）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r43_approve_edited_after_disable_is_voided_not_executed() {
    let m = mgr_enabled();
    let h = mk_handle("s-1", ControlOwner::Agent, m.center.clone());
    register(&m, h.clone());
    let (j, card) = spawn_pending(&m, "s-1", "systemctl restart nginx").await;

    // 人类点了「保存并批准」，但此刻 admission 已封（模拟与停用竞态）
    m.center.collab.lock().unwrap().state = CollabState::Disabling;
    m.decide_approval(&Actor::Human, card.id.clone(), Decision::ApproveEdited("systemctl restart nginx --now".into()))
        .await
        .unwrap();

    let r = j.await.unwrap();
    assert!(matches!(r, Err(Error::CollabDisabled)), "停用期间编辑后批准同样作废：{r:?}");
    let it = m.list_approvals(&Actor::Human, ApprovalFilter::default()).await.unwrap()
        .into_iter().find(|x| x.id == card.id).unwrap();
    assert_eq!(it.status, ApprovalStatus::Voided, "竞态下编辑后批准不得生效");
}

/// §9：DisableFailed（未收敛）**不得**直接重新启用——须先「重试停用收敛」为 Disabled
/// 再启用；否则把「未收敛」当「可重开」（审核 F3）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r43_enable_rejected_until_disable_converged() {
    let m = mgr_enabled();
    m.collab_disable(&Actor::Human).await.unwrap();
    m.collab_mark_disable_failed(&Actor::Human, "endpoint stop unconfirmed".into()).await.unwrap();
    assert!(m.collab_enable(&Actor::Human).await.is_err(), "DisableFailed 未收敛不得重开");
    assert_eq!(m.collab_status(&Actor::Human).await.unwrap().state, CollabState::DisableFailed);
    assert!(m.center.admit_agent().is_err(), "重开被拒后仍保持封闭");

    // 重试收敛 → Disabled → 方可启用
    m.collab_disable(&Actor::Human).await.unwrap();
    m.collab_mark_endpoint_stopped(&Actor::Human).await.unwrap();
    assert_eq!(m.collab_status(&Actor::Human).await.unwrap().state, CollabState::Disabled);
    m.collab_enable(&Actor::Human).await.unwrap();
    assert_eq!(m.collab_status(&Actor::Human).await.unwrap().state, CollabState::Enabled);
    assert!(m.center.admit_agent().is_ok());
}
