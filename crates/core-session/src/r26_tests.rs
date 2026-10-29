//! R26（§6.4 断线/重试/重连）：session-state 事件序列、自动重连停止、
//! 手动重连失败/成功语义、local 重连无注入。
//! 手装 handle + Stub 通道（同 r24_tests 工艺）隔离传输面。

use super::*;
use session_api::transport::{ChannelHandle, FreshOutcome, TransportSignal};
use session_api::{AuditFilter, AuthType, Charset, ControlOwner, Error, Host, SessionState};
use std::sync::Arc;
use std::time::Duration;

fn mgr() -> Arc<SessionManager> {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = std::env::temp_dir().join(format!("r26-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    SessionManager::open(&dir.join("t.db")).unwrap()
}

fn ssh_host() -> Host {
    Host {
        id: "h-r26".into(),
        name: "r26-host".into(),
        address: "10.0.0.1".into(),
        port: 22,
        username: "ops".into(),
        auth_type: AuthType::Password,
        identity_id: None,
        tags: vec![],
        fingerprint: None,
        charset: Charset::Utf8,
        shell_integration: Some(true),
        jump_host_id: None,
        startup_command: None,
    }
}

/// 恒败通道：reconnect 恒败（断线且网络不可达的 stub）。
struct DeadChannel;
#[async_trait::async_trait]
impl ChannelHandle for DeadChannel {
    async fn write(&self, _data: &[u8]) -> Result<()> {
        Err(Error::SessionClosed)
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
        Err(Error::SessionClosed)
    }
    async fn signal(&self, _sig: TransportSignal) -> Result<()> {
        Ok(())
    }
    async fn force_close(&self) -> Result<()> {
        Ok(())
    }
    fn subscribe_output(&self) -> tokio::sync::broadcast::Receiver<Vec<u8>> {
        tokio::sync::broadcast::channel(1).1
    }
    async fn is_alive(&self) -> bool {
        false
    }
    async fn reconnect(&self) -> Result<()> {
        Err(Error::SessionClosed)
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
        Err(Error::SessionClosed)
    }
    async fn download(
        &self,
        _remote: &str,
        _local: &std::path::Path,
        _cancel: &session_api::transport::tokio_util_sync::CancellationToken,
        _progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<u64> {
        Err(Error::SessionClosed)
    }
    async fn list_dir(&self, _path: &str) -> Result<Vec<session_api::DirEntryS>> {
        Err(Error::SessionClosed)
    }
}

/// 重连即成功通道：订阅面活（sender 常驻 Arc 内，pump 空转不误判断线）。
struct OkReconnectChannel {
    tx: tokio::sync::broadcast::Sender<Vec<u8>>,
}
impl OkReconnectChannel {
    fn new() -> Arc<Self> {
        let (tx, _) = tokio::sync::broadcast::channel(16);
        Arc::new(Self { tx })
    }
}
#[async_trait::async_trait]
impl ChannelHandle for OkReconnectChannel {
    async fn write(&self, _data: &[u8]) -> Result<()> {
        Err(Error::SessionClosed)
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
        Err(Error::SessionClosed)
    }
    async fn signal(&self, _sig: TransportSignal) -> Result<()> {
        Ok(())
    }
    async fn force_close(&self) -> Result<()> {
        Ok(())
    }
    fn subscribe_output(&self) -> tokio::sync::broadcast::Receiver<Vec<u8>> {
        self.tx.subscribe()
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
        Err(Error::SessionClosed)
    }
    async fn download(
        &self,
        _remote: &str,
        _local: &std::path::Path,
        _cancel: &session_api::transport::tokio_util_sync::CancellationToken,
        _progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<u64> {
        Err(Error::SessionClosed)
    }
    async fn list_dir(&self, _path: &str) -> Result<Vec<session_api::DirEntryS>> {
        Err(Error::SessionClosed)
    }
}

fn hand_install(m: &SessionManager, kind: &str, ch: Arc<dyn ChannelHandle>) -> Arc<SessionHandle> {
    let screen = term_core::Screen::new(term_core::ScreenConfig {
        cols: 80,
        rows: 24,
        scrollback: 100,
        lossless_cap: 1 << 20,
    });
    let h = SessionHandle::new(
        format!("s-r26-{}", uuid::Uuid::new_v4()),
        ssh_host(),
        kind.into(),
        ch,
        screen,
        m.center.clone(),
        ControlOwner::Human,
    );
    m.sessions.lock().unwrap().insert(h.id.clone(), h.clone());
    h
}

/// 事件收集器：订阅 state_tx，按序拉取（带总超时防挂）。
async fn drain_events(
    rx: &mut tokio::sync::broadcast::Receiver<SessionStateEvent>,
    n: usize,
) -> Vec<SessionStateEvent> {
    let mut out = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while out.len() < n {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            panic!(
                "等待状态事件超时：已收 {}/{}（{:?}）",
                out.len(),
                n,
                out.iter()
                    .map(|e: &SessionStateEvent| (e.state, e.attempt))
                    .collect::<Vec<_>>()
            );
        }
        match tokio::time::timeout(left, rx.recv()).await {
            Ok(Ok(ev)) => out.push(ev),
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => panic!("state_tx 关闭"),
            Err(_) => panic!("等待状态事件超时：已收 {}/{}", out.len(), n),
        }
    }
    out
}

/// §6.4 自动重连：事件序列 Degraded → Reconnecting{1..3}（带次数）→ Disconnected，
/// 终态 Disconnected（pump 据此退出）。旧码无任何事件发射——本测试必红。
#[tokio::test(flavor = "multi_thread")]
async fn auto_reconnect_emits_full_sequence_then_disconnected() {
    let m = mgr();
    let h = hand_install(&m, "ssh", Arc::new(DeadChannel));
    let mut rx = m.center.state_tx.subscribe();
    h.on_transport_reconnect().await;
    let evs = drain_events(&mut rx, 5).await;
    let seq: Vec<(SessionState, Option<u32>, Option<u32>)> = evs
        .iter()
        .map(|e| (e.state, e.attempt, e.max_attempts))
        .collect();
    assert_eq!(
        seq,
        vec![
            (SessionState::Degraded, None, None),
            (SessionState::Reconnecting, Some(1), Some(3)),
            (SessionState::Reconnecting, Some(2), Some(3)),
            (SessionState::Reconnecting, Some(3), Some(3)),
            (SessionState::Disconnected, None, None),
        ],
        "自动重连事件序列（含实际重试次数）不符：{seq:?}"
    );
    assert_eq!(*h.state.lock().await, SessionState::Disconnected);
}

/// §6.4「可停止重试」：停止后不再发起新 attempt，落 Disconnected；
/// 停止动作留审计。旧码（无旗标）第二次 Reconnecting 必现——本测试必红。
#[tokio::test(flavor = "multi_thread")]
async fn stop_auto_reconnect_prevents_further_attempts() {
    let m = mgr();
    let h = hand_install(&m, "ssh", Arc::new(DeadChannel));
    // 先订阅、再跑重连（broadcast 只投递订阅之后的事件——订阅迟到会漏首个
    // Reconnecting，停止时机就漂了）；观察到首个 Reconnecting 即同步停止。
    let mut rx = m.center.state_tx.subscribe();
    let h2 = h.clone();
    let runner = tokio::spawn(async move {
        h2.on_transport_reconnect().await;
    });
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .unwrap()
            .unwrap();
        if ev.state == SessionState::Reconnecting {
            m.stop_auto_reconnect(&h.id).await.unwrap();
            break;
        }
    }
    runner.await.unwrap();
    let evs = drain_events(&mut rx, 1).await;
    let seq: Vec<(SessionState, Option<u32>)> = evs.iter().map(|e| (e.state, e.attempt)).collect();
    assert_eq!(
        seq,
        vec![(SessionState::Disconnected, None)],
        "停止后不得再有第二次 Reconnecting，只余 Disconnected：{seq:?}"
    );
    assert_eq!(*h.state.lock().await, SessionState::Disconnected);
    let audit = m
        .center
        .audit
        .query(&AuditFilter {
            limit: 200,
            ..Default::default()
        })
        .unwrap()
        .events;
    assert!(
        audit.iter().any(|e| e.action == "session_reconnect_stop"),
        "停止动作须留审计"
    );
}

/// 手动重连失败：Reconnecting×3 事件 + Disconnected 事件，终态保持 Disconnected，
/// 返回 Err（UI 保留标签与重连入口的依据）。
#[tokio::test(flavor = "multi_thread")]
async fn manual_reconnect_failure_keeps_disconnected() {
    let m = mgr();
    let h = hand_install(&m, "ssh", Arc::new(DeadChannel));
    *h.state.lock().await = SessionState::Disconnected;
    let mut rx = m.center.state_tx.subscribe();
    let r = m.reconnect_session(&h.id).await;
    assert!(r.is_err(), "恒败通道手动重连应失败");
    // 每次尝试前各发一次 Reconnecting（次数数据面），失败后 Disconnected
    let evs = drain_events(&mut rx, 4).await;
    let seq: Vec<(SessionState, Option<u32>)> = evs.iter().map(|e| (e.state, e.attempt)).collect();
    assert_eq!(
        seq,
        vec![
            (SessionState::Reconnecting, Some(1)),
            (SessionState::Reconnecting, Some(2)),
            (SessionState::Reconnecting, Some(3)),
            (SessionState::Disconnected, None),
        ],
        "手动重连失败事件序列不符：{seq:?}"
    );
    assert_eq!(*h.state.lock().await, SessionState::Disconnected);
}

/// 手动重连成功：进入 Reconfirming + 事件（「已重连；旧现场待核实」的数据面）；
/// 新 shell 提示符（B 标记）到场即放行（不等满 10s 窗）。
#[tokio::test(flavor = "multi_thread")]
async fn manual_reconnect_success_enters_reconfirming_with_event() {
    let m = mgr();
    let h = hand_install(&m, "ssh", OkReconnectChannel::new());
    *h.state.lock().await = SessionState::Disconnected;
    let mut rx = m.center.state_tx.subscribe();
    // 注入等待loop需要 B 标记放行：200ms 后喂 OSC133 B（新 shell 首提示符的 stub）
    let hx = h.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        hx.feed_output(b"\x1b]133;B\x07").await;
    });
    m.reconnect_session(&h.id).await.unwrap();
    // 首次尝试即成功：1 次 Reconnecting + Reconfirming（B 标记到场放行，不等满窗）
    let evs = drain_events(&mut rx, 2).await;
    let seq: Vec<(SessionState, Option<u32>)> = evs.iter().map(|e| (e.state, e.attempt)).collect();
    assert_eq!(
        seq,
        vec![
            (SessionState::Reconnecting, Some(1)),
            (SessionState::Reconfirming, None),
        ],
        "手动重连成功事件序列不符：{seq:?}"
    );
    assert_eq!(*h.state.lock().await, SessionState::Reconfirming);
}

/// local 重连：不注入不等标记，直接 Reconfirming + 事件；integration 保持 Disabled
/// （§6.4「未启用 shell 集成的重连不得注入或等待 OSC 标记」的 local 面）。
#[tokio::test(flavor = "multi_thread")]
async fn local_reconnect_enters_reconfirming_without_injection() {
    let m = mgr();
    let h = hand_install(&m, "local", OkReconnectChannel::new());
    *h.state.lock().await = SessionState::Disconnected;
    let mut rx = m.center.state_tx.subscribe();
    m.reconnect_session(&h.id).await.unwrap();
    // local 也走同一 3 次尝试循环（Reconnecting 次数事件同源），成功后不注入直接 Reconfirming
    let evs = drain_events(&mut rx, 2).await;
    let seq: Vec<(SessionState, Option<u32>)> = evs.iter().map(|e| (e.state, e.attempt)).collect();
    assert_eq!(
        seq,
        vec![
            (SessionState::Reconnecting, Some(1)),
            (SessionState::Reconfirming, None),
        ],
        "local 重连事件序列不符：{seq:?}"
    );
    assert_eq!(*h.state.lock().await, SessionState::Reconfirming);
    assert_eq!(
        *h.integration.lock().unwrap(),
        session_api::IntegrationState::Disabled,
        "local 重连不得注入集成"
    );
    // 幂等 no-op：非重连期 stop_auto_reconnect 合法返回
    m.stop_auto_reconnect(&h.id).await.unwrap();
}

/// 稳定轮（P0-2 僵尸会话）：close 置 Closed 后，重连链路不得把它改写回活着
/// 的状态——旧码 reinject_integration 无条件置 Reconfirming、泵外层出口只认
/// Disconnected，两处叠加让已从会话表移除的会话下一轮 tick 被「复活」并发起
/// 真实重连（可达主机留下带活连接的僵尸 + 永久任务）。
#[tokio::test(flavor = "multi_thread")]
async fn closed_session_not_resurrected_by_reconnect_path() {
    let m = mgr();
    let h = hand_install(&m, "ssh", Arc::new(DeadChannel));
    *h.state.lock().await = SessionState::Closed;
    // on_transport_reconnect 对 Closed 早退（既有守卫，状态原地不动）
    h.on_transport_reconnect().await;
    assert_eq!(*h.state.lock().await, SessionState::Closed);
    // reinject（泵重连出口的下一站）同样不得改写 Closed——修复前必红
    h.reinject_integration().await;
    assert_eq!(*h.state.lock().await, SessionState::Closed);
}

/// 稳定轮（余量清单·重连竞态）：on_transport_reconnect 置 Disconnected 与泵
/// 自检之间存在 await 空窗，手动重连可在此拉起新泵——旧泵若按「状态已不是
/// Disconnected」继续跑，就是双泵双写屏，其迟到的 is_alive=false 还会把健康
/// 会话重新打进重连（假断线）。泵代际守卫：代际不符 = 已被替换，立即退出。
/// 通道语义：is_alive 恒 false（泵每轮 500ms 静默 tick 判 lost）+ reconnect
/// 恒 Ok（on_transport_reconnect 成功返回，泵按旧码会无限续环）。
struct ZombieAliveChannel {
    tx: tokio::sync::broadcast::Sender<Vec<u8>>,
    reconnects: std::sync::atomic::AtomicUsize,
}
impl ZombieAliveChannel {
    fn new() -> Arc<Self> {
        let (tx, _) = tokio::sync::broadcast::channel(16);
        Arc::new(Self {
            tx,
            reconnects: std::sync::atomic::AtomicUsize::new(0),
        })
    }
}
#[async_trait::async_trait]
impl ChannelHandle for ZombieAliveChannel {
    async fn write(&self, _data: &[u8]) -> Result<()> {
        Err(Error::SessionClosed)
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
        Err(Error::SessionClosed)
    }
    async fn signal(&self, _sig: TransportSignal) -> Result<()> {
        Ok(())
    }
    async fn force_close(&self) -> Result<()> {
        Ok(())
    }
    fn subscribe_output(&self) -> tokio::sync::broadcast::Receiver<Vec<u8>> {
        self.tx.subscribe()
    }
    async fn is_alive(&self) -> bool {
        false
    }
    async fn reconnect(&self) -> Result<()> {
        self.reconnects
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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
        Err(Error::SessionClosed)
    }
    async fn download(
        &self,
        _remote: &str,
        _local: &std::path::Path,
        _cancel: &session_api::transport::tokio_util_sync::CancellationToken,
        _progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<u64> {
        Err(Error::SessionClosed)
    }
    async fn list_dir(&self, _path: &str) -> Result<Vec<session_api::DirEntryS>> {
        Err(Error::SessionClosed)
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn stale_pump_exits_when_generation_moves() {
    let m = mgr();
    let ch = ZombieAliveChannel::new();
    let h = hand_install(&m, "ssh", ch.clone());
    // 泵 A 上场（gen=1）：is_alive 恒 false，每个 500ms tick 走一轮
    // lost → on_transport_reconnect(Ok) → 旧码会无限续环
    spawn_pump(h.clone(), h.channel.subscribe_output());
    assert_eq!(h.pump_gen.load(std::sync::atomic::Ordering::SeqCst), 1);
    tokio::time::sleep(Duration::from_millis(900)).await;
    let after_a = ch.reconnects.load(std::sync::atomic::Ordering::SeqCst);
    assert!(after_a >= 1, "泵 A 应已在跑重连环（reconnects={after_a}）");

    // 手动重连路径：spawn_pump 递增代际（gen=2）
    spawn_pump(h.clone(), h.channel.subscribe_output());
    assert_eq!(h.pump_gen.load(std::sync::atomic::Ordering::SeqCst), 2);

    // 给泵 A ≥1 个 tick 醒来发现代际不符退出；随后 reconnects 不得再涨
    tokio::time::sleep(Duration::from_millis(900)).await;
    let snap = ch.reconnects.load(std::sync::atomic::Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(800)).await;
    let after_b = ch.reconnects.load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(
        snap, after_b,
        "代际更替后旧泵必须退场（还在续环=双泵假断线竞态回归）"
    );

    // 清场：代际再+1 让 gen=2 的泵也退（is_alive 恒 false 的通道上它同样在续环）
    h.pump_gen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    *h.state.lock().await = SessionState::Closed;
}

/// V2（snippets 盘点轮立案）探针接线测试①：远端 fish（探针标记 __T=||ver）
/// → 判型任务必须在窗口内补写 fish 片段；且首次注入文本含探针行 + sh 片段。
struct FishProbeChannel {
    tx: tokio::sync::broadcast::Sender<Vec<u8>>,
    writes: std::sync::Mutex<Vec<Vec<u8>>>,
    marker_sent: std::sync::atomic::AtomicBool,
    marker: String,
}
impl FishProbeChannel {
    fn new(marker: &str) -> Arc<Self> {
        let (tx, _) = tokio::sync::broadcast::channel(64);
        Arc::new(Self {
            tx,
            writes: std::sync::Mutex::new(Vec::new()),
            marker_sent: std::sync::atomic::AtomicBool::new(false),
            marker: marker.into(),
        })
    }
    fn all_writes(&self) -> String {
        String::from_utf8_lossy(&self.writes.lock().unwrap().concat()).to_string()
    }
}
#[async_trait::async_trait]
impl ChannelHandle for FishProbeChannel {
    async fn write(&self, data: &[u8]) -> Result<()> {
        self.writes.lock().unwrap().push(data.to_vec());
        // 模拟远端 shell：注入批次回显后输出探针标记（一次性）。真实 PTY 流里
        // marker 以 CRLF 收尾、紧随下一行输出（审查轮：干净假流会把判型缺陷遮绿）
        if !self
            .marker_sent
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            let _ = self.tx.send(format!("{}\r\n", self.marker).into_bytes());
        }
        Ok(())
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
        Err(Error::SessionClosed)
    }
    async fn signal(&self, _sig: TransportSignal) -> Result<()> {
        Ok(())
    }
    async fn force_close(&self) -> Result<()> {
        Ok(())
    }
    fn subscribe_output(&self) -> tokio::sync::broadcast::Receiver<Vec<u8>> {
        self.tx.subscribe()
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
        Err(Error::SessionClosed)
    }
    async fn download(
        &self,
        _remote: &str,
        _local: &std::path::Path,
        _cancel: &session_api::transport::tokio_util_sync::CancellationToken,
        _progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<u64> {
        Err(Error::SessionClosed)
    }
    async fn list_dir(&self, _path: &str) -> Result<Vec<session_api::DirEntryS>> {
        Err(Error::SessionClosed)
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn fish_host_gets_fish_snippet_topup() {
    let m = mgr();
    let ch = FishProbeChannel::new("__T=||3.7.1");
    let h = hand_install(&m, "ssh", ch.clone());
    assert!(h.inject_integration().await);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
    while !ch.all_writes().contains("fish_postexec") {
        assert!(
            tokio::time::Instant::now() < deadline,
            "fish 补写未在判型窗口内到达"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let all = ch.all_writes();
    assert!(all.contains("__T="), "注入文本缺探针行");
    assert!(all.contains("PROMPT_COMMAND"), "注入文本缺 sh 片段");
    assert!(
        all.contains("commandline -f repaint"),
        "fish 补写缺 repaint 尾"
    );
}

/// V2 探针接线测试②：bash 主机（标记 __T=bashver||）判型非 Fish——不补写，
/// 注入批次之后 writes 停在 1（探针窗口走完也保持沉默）。
#[tokio::test(flavor = "multi_thread")]
async fn bash_host_no_fish_topup() {
    let m = mgr();
    let ch = FishProbeChannel::new("__T=5.2.21(1)-release||");
    let h = hand_install(&m, "ssh", ch.clone());
    assert!(h.inject_integration().await);
    tokio::time::sleep(Duration::from_millis(3500)).await;
    let all = ch.all_writes();
    assert!(all.contains("__T=") && all.contains("PROMPT_COMMAND"));
    assert!(
        !all.contains("fish_postexec"),
        "bash 主机不得补写 fish 片段"
    );
}

/// 找茬轮接线通道：首次 write 后按场景回吐——延迟标记（重连交叠/慢回显）或
/// cmd printf 报错（非 POSIX 远端，无标记）。
struct ScenarioProbeChannel {
    tx: tokio::sync::broadcast::Sender<Vec<u8>>,
    writes: std::sync::Mutex<Vec<Vec<u8>>>,
    first_seen: std::sync::atomic::AtomicBool,
    payload: String,
    delay_ms: u64,
}
impl ScenarioProbeChannel {
    fn new_raw(payload: String, delay_ms: u64) -> Arc<Self> {
        let (tx, _) = tokio::sync::broadcast::channel(64);
        Arc::new(Self {
            tx,
            writes: std::sync::Mutex::new(Vec::new()),
            first_seen: std::sync::atomic::AtomicBool::new(false),
            payload,
            delay_ms,
        })
    }
    fn delayed_marker(marker: &str, delay_ms: u64) -> Arc<Self> {
        Self::new_raw(format!("{}\r\n", marker), delay_ms)
    }
    /// Windows Server 20348 cmd 实测形态：先回显探针行（含裸 | 与字面 \n），
    /// 再报「不是内部或外部命令」；无探针标记输出。
    fn windows_cmd_error() -> Arc<Self> {
        Self::new_raw(
            "D:\\work>printf '__T=%s|%s|%s\\n' \"$BASH_VERSION\" \"$ZSH_VERSION\" \"$FISH_VERSION\"\r\n'printf' 不是内部或外部命令，也不是可运行的程序\r\n或批处理文件。\r\n"
                .to_string(),
            0,
        )
    }
    fn all_writes(&self) -> String {
        String::from_utf8_lossy(&self.writes.lock().unwrap().concat()).to_string()
    }
}
#[async_trait::async_trait]
impl ChannelHandle for ScenarioProbeChannel {
    async fn write(&self, data: &[u8]) -> Result<()> {
        self.writes.lock().unwrap().push(data.to_vec());
        if !self
            .first_seen
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            let tx = self.tx.clone();
            let payload = self.payload.clone();
            let delay = self.delay_ms;
            tokio::spawn(async move {
                if delay > 0 {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                }
                let _ = tx.send(payload.into_bytes());
            });
        }
        Ok(())
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
        Err(Error::SessionClosed)
    }
    async fn signal(&self, _sig: TransportSignal) -> Result<()> {
        Ok(())
    }
    async fn force_close(&self) -> Result<()> {
        Ok(())
    }
    fn subscribe_output(&self) -> tokio::sync::broadcast::Receiver<Vec<u8>> {
        self.tx.subscribe()
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
        Err(Error::SessionClosed)
    }
    async fn download(
        &self,
        _remote: &str,
        _local: &std::path::Path,
        _cancel: &session_api::transport::tokio_util_sync::CancellationToken,
        _progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<u64> {
        Err(Error::SessionClosed)
    }
    async fn list_dir(&self, _path: &str) -> Result<Vec<session_api::DirEntryS>> {
        Err(Error::SessionClosed)
    }
}

/// 找茬轮 F1 接线：cmd 登录 shell（探针报错签名）→ 阻断旗标 + cls 自愈 +
/// 集成即刻 Unavailable；不补写 fish。
#[tokio::test(flavor = "multi_thread")]
async fn windows_cmd_host_blocked_and_healed() {
    let m = mgr();
    let ch = ScenarioProbeChannel::windows_cmd_error();
    let h = hand_install(&m, "ssh", ch.clone());
    assert!(h.inject_integration().await);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !h
        .remote_shell_blocked
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "阻断旗标未在判型窗口内置位"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(matches!(
        *h.integration.lock().unwrap(),
        session_api::IntegrationState::Unavailable
    ));
    let all = ch.all_writes();
    assert!(all.contains("cls"), "缺 cls 自愈写");
    assert!(!all.contains("fish_postexec"), "cmd 主机不得补写 fish 片段");
}

/// 找茬轮 F2 接线：快速连续两次注入（模拟断线即重连的 reinject），延迟回吐的
/// 标记只允许触发一份 fish 补写——旧探针任务必须被 abort（broadcast 跨重连
/// 存活，旧任务也收得到新连接的探针输出）。
#[tokio::test(flavor = "multi_thread")]
async fn reinject_aborts_stale_probe_no_double_topup() {
    let m = mgr();
    let ch = ScenarioProbeChannel::delayed_marker("__T=||3.7.1", 400);
    let h = hand_install(&m, "ssh", ch.clone());
    assert!(h.inject_integration().await);
    assert!(h.inject_integration().await);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
    while !ch.all_writes().contains("fish_postexec") {
        assert!(
            tokio::time::Instant::now() < deadline,
            "fish 补写未在判型窗口内到达"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // 多等 600ms：若旧任务未被 abort，第二份补写会在此期间追上来
    tokio::time::sleep(Duration::from_millis(600)).await;
    let topups = ch.all_writes().matches("commandline -f repaint").count();
    assert_eq!(topups, 1, "fish 补写双写：旧探针任务未被 abort");
}
