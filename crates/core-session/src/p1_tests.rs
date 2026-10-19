//! P1 shell 集成扩面（终端品质轮）：本地会话的通路先验门。
//! cmd/WSL/dash 等无法注入的 shell 是**构造性**不可用——run_shell 入口立即如实拒绝，
//! 不白等 10s 观测窗口（此前超时路径还把「本地 shell 不支持」误报成
//! host_setting=false 的「主机未启用集成」）。

use super::*;
use session_api::transport::{ChannelHandle, FreshOutcome, TransportSignal};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 先验可配置的桩通道：只有 hint 有语义，其余恒败（门放行后的失败面与本测试无关）。
struct HintChannel(Option<bool>);
#[async_trait::async_trait]
impl ChannelHandle for HintChannel {
    fn shell_integration_hint(&self) -> Option<bool> {
        self.0
    }
    fn subscribe_output(&self) -> tokio::sync::broadcast::Receiver<Vec<u8>> {
        let (_tx, rx) = tokio::sync::broadcast::channel(1);
        rx
    }
    async fn write(&self, _data: &[u8]) -> Result<()> {
        Err(Error::InvalidInput("stub".into()))
    }
    async fn resize(&self, _cols: u16, _rows: u16) -> Result<()> {
        Ok(())
    }
    async fn exec_fresh(
        &self,
        _cmd: &str,
        _opts: &ExecOpts,
        _deadline: std::time::Instant,
        _cancel: &session_api::transport::tokio_util_sync::CancellationToken,
    ) -> Result<FreshOutcome> {
        Err(Error::InvalidInput("stub".into()))
    }
    async fn signal(&self, _sig: TransportSignal) -> Result<()> {
        Ok(())
    }
    async fn force_close(&self) -> Result<()> {
        Ok(())
    }
    async fn is_alive(&self) -> bool {
        true
    }
    async fn reconnect(&self) -> Result<()> {
        Ok(())
    }
    async fn close(&self) -> Result<()> {
        Ok(())
    }
    async fn upload(
        &self,
        _local: &std::path::Path,
        _remote: &str,
        _cancel: &session_api::transport::tokio_util_sync::CancellationToken,
        _progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<u64> {
        Err(Error::InvalidInput("stub".into()))
    }
    async fn download(
        &self,
        _remote: &str,
        _local: &std::path::Path,
        _cancel: &session_api::transport::tokio_util_sync::CancellationToken,
        _progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<u64> {
        Err(Error::InvalidInput("stub".into()))
    }
    async fn list_dir(&self, _path: &str) -> Result<Vec<session_api::DirEntryS>> {
        Err(Error::InvalidInput("stub".into()))
    }
}

fn local_host() -> Host {
    Host {
        id: "local".into(),
        name: "本机".into(),
        address: "local".into(),
        port: 0,
        username: "ops".into(),
        auth_type: AuthType::Password,
        identity_id: None,
        tags: vec![],
        fingerprint: None,
        charset: Charset::Utf8,
        shell_integration: None,
    }
}

fn screen() -> term_core::Screen {
    term_core::Screen::new(term_core::ScreenConfig {
        cols: 80,
        rows: 24,
        scrollback: 100,
        lossless_cap: 1 << 20,
    })
}

/// local + hint=Some(false)：立即拒绝（显著小于 10s 观测窗），载荷如实。
#[tokio::test(flavor = "multi_thread")]
async fn local_shell_mode_rejected_immediately_on_constructional_prior() {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = std::env::temp_dir().join(format!("p1-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let m = SessionManager::open(&dir.join("t.db")).unwrap();

    let h = SessionHandle::new(
        "s-p1".into(),
        local_host(),
        "local".into(),
        Arc::new(HintChannel(Some(false))),
        screen(),
        m.center.clone(),
        ControlOwner::Human,
    );
    m.sessions.lock().unwrap().insert(h.id.clone(), h.clone());

    let started = Instant::now();
    let x = m
        .exec(&Actor::Human, "s-p1".into(), "ls", ExecOpts::default())
        .await;
    let elapsed = started.elapsed();
    match x {
        Err(Error::ShellIntegrationUnavailable { available }) => {
            assert!(!available.integration_present);
            assert!(
                !available.host_setting,
                "local 无 host_setting 语义，恒 false"
            );
        }
        other => panic!("构造性不可用应拒绝 Shell 模式，得 {other:?}"),
    }
    assert!(
        elapsed < Duration::from_secs(2),
        "先验 false 应立即拒绝（不白等 10s 观测窗），实际 {elapsed:?}"
    );

    // 先验 true（注入成功）但标记未回流 = 启动竞态 → 必须仍走有界等待路径而不是
    // 构造性拒绝。便宜地验证「不误拒」：标记一回流（OSC133 A+B）门即放行，
    // 后续败于桩通道写（InvalidInput）而非 ShellIntegrationUnavailable。
    let h2 = SessionHandle::new(
        "s-p1b".into(),
        local_host(),
        "local".into(),
        Arc::new(HintChannel(Some(true))),
        screen(),
        m.center.clone(),
        ControlOwner::Human,
    );
    m.sessions.lock().unwrap().insert(h2.id.clone(), h2.clone());
    h2.feed_output(b"\x1b]133;A\x07\x1b]133;B\x07").await;
    let x = m
        .exec(&Actor::Human, "s-p1b".into(), "ls", ExecOpts::default())
        .await;
    assert!(
        !matches!(x, Err(Error::ShellIntegrationUnavailable { .. })),
        "先验 true + 标记在场门应放行，得 {x:?}"
    );
}
