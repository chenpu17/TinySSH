//! C2/C3（R24）：owner 构造期确定（B01）、delegate_session 语义与审计、
//! run_shell 无集成拒绝（B12/DC3.1）、shell_capability 只读（DC3.3）。
//! local 会话走真 PTY（core 无门快路径）；B12 用手装 handle（Stub 通道）
//! 隔离传输面，只驱动屏幕集成标记与门判定。

use super::*;
use session_api::{
    Actor, AuditFilter, AuthType, Charset, ControlOwner, CreateSessionReq, Error, ExecMode, ExecOpts,
    Host, IntegrationState,
};
use session_api::transport::{ChannelHandle, FreshOutcome, TransportSignal};
use std::sync::Arc;

fn mgr() -> Arc<SessionManager> {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = std::env::temp_dir().join(format!("r24-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    SessionManager::open(&dir.join("t.db")).unwrap()
}

fn audit_events(m: &SessionManager) -> Vec<session_api::AuditEvent> {
    m.center
        .audit
        .query(&AuditFilter { limit: 200, ..Default::default() })
        .map(|p| p.events)
        .unwrap_or_default()
}

/// 恒败通道：写/fresh 即 InvalidInput——门放行后的失败面与本测试无关。
struct DeadChannel;
#[async_trait::async_trait]
impl ChannelHandle for DeadChannel {
    async fn write(&self, _data: &[u8]) -> Result<()> { Err(Error::InvalidInput("stub".into())) }
    async fn resize(&self, _cols: u16, _rows: u16) -> Result<()> { Ok(()) }
    async fn exec_fresh(&self, _cmd: &str, _opts: &ExecOpts, _deadline: std::time::Instant, _cancel: &session_api::transport::tokio_util_sync::CancellationToken) -> Result<FreshOutcome> { Err(Error::InvalidInput("stub".into())) }
    async fn signal(&self, _sig: TransportSignal) -> Result<()> { Ok(()) }
    async fn force_close(&self) -> Result<()> { Ok(()) }
    fn subscribe_output(&self) -> tokio::sync::broadcast::Receiver<Vec<u8>> { tokio::sync::broadcast::channel(1).1 }
    async fn is_alive(&self) -> bool { false }
    async fn reconnect(&self) -> Result<()> { Err(Error::InvalidInput("stub".into())) }
    async fn close(&self) -> Result<()> { Ok(()) }
    async fn upload(&self, _local: &std::path::Path, _remote: &str, _cancel: &session_api::transport::tokio_util_sync::CancellationToken, _progress: &(dyn Fn(u64, Option<u64>) + Send + Sync)) -> Result<u64> { Err(Error::InvalidInput("stub".into())) }
    async fn download(&self, _remote: &str, _local: &std::path::Path, _cancel: &session_api::transport::tokio_util_sync::CancellationToken, _progress: &(dyn Fn(u64, Option<u64>) + Send + Sync)) -> Result<u64> { Err(Error::InvalidInput("stub".into())) }
    async fn list_dir(&self, _path: &str) -> Result<Vec<session_api::DirEntryS>> { Err(Error::InvalidInput("stub".into())) }
}

/// B01：owner 构造期确定——Human 建 → Human；Agent 建 → Agent（无「先建后夺」窗口，
/// 由构造参数保证）；审计 session_created 携带 owner。
#[tokio::test(flavor = "multi_thread")]
async fn b01_owner_at_construction() {
    let m = mgr();
    let human_sid = m.create_session(&Actor::Human, CreateSessionReq { host_id: "local".into() }).await.unwrap();
    let agent = Actor::Agent { client_id: "r24-agent".into() };
    let agent_sid = m.create_session(&agent, CreateSessionReq { host_id: "local".into() }).await.unwrap();

    let sess = m.list_sessions(&Actor::Human).await.unwrap();
    let h_info = sess.iter().find(|s| s.id == human_sid).unwrap();
    let a_info = sess.iter().find(|s| s.id == agent_sid).unwrap();
    assert_eq!(h_info.control_owner, ControlOwner::Human, "人类建会话 owner=Human");
    assert_eq!(a_info.control_owner, ControlOwner::Agent, "Agent 建会话 owner=Agent");

    let created: Vec<_> = audit_events(&m).into_iter().filter(|e| e.action == "session_created").collect();
    assert_eq!(created.len(), 2, "session_created 审计每会话一条");
    let mut owners = vec![];
    for e in &created {
        let owner = e.payload_json.get("owner").and_then(|v| v.as_str()).unwrap_or("").to_string();
        assert!(!owner.is_empty(), "session_created 载荷须携带 owner：{}", e.payload_json);
        owners.push(owner);
    }
    assert!(owners.contains(&"Human".to_string()) && owners.contains(&"Agent".to_string()), "owner 载荷 {owners:?}");

    let _ = m.close_session(&Actor::Human, human_sid).await;
    let _ = m.close_session(&agent, agent_sid).await;
}

/// delegate_session：Human 移交 → 内部走 handback 受控转换（owner 翻 Agent）+
/// 审计 session_delegated（goal_present 载荷）+ goal 落位简报；Agent 调用 →
/// InvalidActor（移交是 Human 动作）。
#[tokio::test(flavor = "multi_thread")]
async fn delegate_flips_owner_and_audits() {
    let m = mgr();
    let sid = m.create_session(&Actor::Human, CreateSessionReq { host_id: "local".into() }).await.unwrap();

    let agent = Actor::Agent { client_id: "r24-agent".into() };
    let x = m.delegate_session(&agent, sid.clone(), None).await;
    assert!(matches!(x, Err(Error::InvalidActor)), "Agent 不得调用移交，得 {x:?}");

    m.delegate_session(&Actor::Human, sid.clone(), Some("整理 /var/log 并汇总错误".into())).await.unwrap();

    let sess = m.list_sessions(&Actor::Human).await.unwrap();
    let info = sess.iter().find(|s| s.id == sid).unwrap();
    assert_eq!(info.control_owner, ControlOwner::Agent, "移交后 owner=Agent");

    let ev = audit_events(&m).into_iter().find(|e| e.action == "session_delegated").expect("session_delegated 审计");
    assert_eq!(ev.session_id.as_deref(), Some(sid.as_str()));
    assert_eq!(ev.payload_json.get("goal_present"), Some(&serde_json::json!(true)), "载荷 {}", ev.payload_json);

    // goal 落位（Agent 接手后的任务说明，经简报读取）
    let brief = m.get_session_brief(&Actor::Human, sid.clone()).await.unwrap();
    assert!(brief.goal.as_deref().unwrap_or("").contains("整理"), "brief.goal 应携带移交说明：{:?}", brief.goal);

    // 二次移交：已属 Agent → handback 拒绝（幂等保护）
    let x = m.delegate_session(&Actor::Human, sid.clone(), None).await;
    assert!(x.is_err(), "已移交会话不得二次移交");

    let _ = m.close_session(&Actor::Human, sid).await;
}

/// B12/DC3.1：SSH 会话无集成 → Shell 模式副作用前拒绝 ShellIntegrationUnavailable
/// （载荷 host_setting 如实）；显式 Fresh 不受门拦（走原授权/审批路径）；集成标记
/// 在场（OSC133）后 Shell 门放行。DC3.3：capability 只读查询。
#[tokio::test(flavor = "multi_thread")]
async fn run_shell_gate_rejects_without_integration() {
    let m = mgr();
    let host = Host {
        id: "h-r24".into(),
        name: "r24-ssh".into(),
        address: "10.0.0.1".into(),
        port: 22,
        username: "ops".into(),
        auth_type: AuthType::Password,
        identity_id: None,
        tags: vec![],
        fingerprint: None,
        charset: Charset::Utf8,
        shell_integration: None,
    };
    let screen = term_core::Screen::new(term_core::ScreenConfig {
        cols: 80, rows: 24, scrollback: 100, lossless_cap: 1 << 20,
    });
    let h = SessionHandle::new(
        "s-r24".into(), host, "ssh".into(),
        Arc::new(DeadChannel), screen, m.center.clone(), ControlOwner::Human,
    );
    m.sessions.lock().unwrap().insert(h.id.clone(), h.clone());
    assert_eq!(*h.integration.lock().unwrap(), IntegrationState::Disabled);

    let human = Actor::Human;
    // 无集成：Shell 模式拒绝，载荷如实（host_setting=false）
    let x = m.exec(&human, "s-r24".into(), "ls".into(), ExecOpts::default()).await;
    match x {
        Err(Error::ShellIntegrationUnavailable { available }) => {
            assert!(!available.integration_present);
            assert!(!available.host_setting, "host 未启用集成时 host_setting=false");
        }
        other => panic!("无集成 Shell 应拒绝，得 {other:?}"),
    }
    // 显式 Fresh：不受 Shell 门拦（Stub 通道恒败=InvalidInput，非 ShellIntegrationUnavailable）
    let x = m
        .exec(&human, "s-r24".into(), "ls".into(), ExecOpts { mode: ExecMode::Fresh, ..Default::default() })
        .await;
    assert!(
        !matches!(x, Err(Error::ShellIntegrationUnavailable { .. })),
        "Fresh 不得被 Shell 集成门拦截，得 {x:?}"
    );
    // 集成标记在场（真实路径=注入后远端 OSC133 回显）：门放行（后续败于 Stub 写）
    h.feed_output(b"\x1b]133;A\x07").await;
    let x = m.exec(&human, "s-r24".into(), "ls".into(), ExecOpts::default()).await;
    assert!(!matches!(x, Err(Error::ShellIntegrationUnavailable { .. })), "集成在场后门应放行，得 {x:?}");

    // DC3.3：能力只读查询（任何 Actor 可查，不产生副作用）
    let agent = Actor::Agent { client_id: "r24-agent".into() };
    let cap = m.shell_capability(&human, "s-r24".into()).await.unwrap();
    assert!(cap.integration_present, "OSC133 后 capability 如实");
    assert!(!cap.host_setting);
    let cap2 = m.shell_capability(&agent, "s-r24".into()).await.unwrap();
    assert_eq!(cap2.integration_present, cap.integration_present);
}

/// DC3.5：shell-integration-event 经订阅面可收；local 会话建连即 Ready（PTY 启动
/// 已注入，不经片段注入路径）；Ready 判据=通道建立，与集成状态独立表达。
#[tokio::test(flavor = "multi_thread")]
async fn local_session_integration_ready_and_event() {
    let m = mgr();
    let mut rx = m.subscribe_shell_integration();
    let sid = m.create_session(&Actor::Human, CreateSessionReq { host_id: "local".into() }).await.unwrap();

    let ev = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
        .await
        .expect("local 建连应发集成事件")
        .expect("通道不应关闭");
    assert_eq!(ev.session_id, sid);
    assert_eq!(ev.state, IntegrationState::Ready, "local=Ready（无片段注入路径）");

    let sess = m.list_sessions(&Actor::Human).await.unwrap();
    let info = sess.iter().find(|s| s.id == sid).unwrap();
    assert_eq!(info.integration, IntegrationState::Ready, "SessionInfo.integration 镜像");
    assert_eq!(info.state, session_api::SessionState::Connected, "Ready 判据=通道建立（DC3.5）");

    let _ = m.close_session(&Actor::Human, sid).await;
}
