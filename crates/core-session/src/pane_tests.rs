//! tmux 面板（一标签多 tmux 会话）核心状态机：开格防呆矩阵、积压补放与输出分流、
//! 输入/尺寸直达格子通道、关格 detach、用户结束摘格（exited 臂）、掉线保留 dead +
//! 重建原位换装（新 pane_id、顺序不变）、Gone 摘除 / Transient 保留、反向 attach
//! 防呆、会话关闭连带收格。手装 handle + 可脚本化 mock 连接（同 r26 工艺）。

use super::*;
use session_api::transport::{ChannelHandle, FreshOutcome, InteractiveChannel, TransportSignal};
use session_api::{AuditFilter, AuthType, Charset, ControlOwner, Error, Host};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

fn mgr() -> Arc<SessionManager> {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = std::env::temp_dir().join(format!("pane-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    SessionManager::open(&dir.join("t.db")).unwrap()
}

fn ssh_host() -> Host {
    Host {
        id: "h-pane".into(),
        name: "pane-host".into(),
        address: "10.0.0.9".into(),
        port: 22,
        username: "ops".into(),
        auth_type: AuthType::Password,
        identity_id: None,
        tags: vec![],
        fingerprint: None,
        charset: Charset::Utf8,
        shell_integration: Some(false),
        jump_host_id: None,
        startup_command: None,
    }
}

/// mock 面板通道的共享状态（测试侧持有同一 Arc 驱动「远端」行为）。
struct PaneState {
    cmd: String,
    tx: StdMutex<Option<tokio::sync::broadcast::Sender<Vec<u8>>>>,
    alive: AtomicBool,
    exited: AtomicBool,
    closed: AtomicBool,
    writes: StdMutex<Vec<u8>>,
    size: StdMutex<(u16, u16)>,
}

impl PaneState {
    /// 远端输出一块字节（订阅者经 core 面板泵解码分发）。
    fn emit(&self, s: &str) {
        if let Some(tx) = self.tx.lock().unwrap().as_ref() {
            let _ = tx.send(s.as_bytes().to_vec());
        }
    }
    /// 通道消亡：exited=true 模拟远端进程自行结束（exit-status），false 模拟掉线。
    fn kill(&self, exited: bool) {
        self.exited.store(exited, Ordering::SeqCst);
        self.alive.store(false, Ordering::SeqCst);
        self.tx.lock().unwrap().take();
    }
}

struct MockPane(Arc<PaneState>);

#[async_trait::async_trait]
impl InteractiveChannel for MockPane {
    async fn write(&self, data: &[u8]) -> Result<()> {
        if !self.0.alive.load(Ordering::SeqCst) {
            return Err(Error::SessionClosed);
        }
        self.0.writes.lock().unwrap().extend_from_slice(data);
        Ok(())
    }
    async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        *self.0.size.lock().unwrap() = (cols, rows);
        Ok(())
    }
    fn subscribe_output(&self) -> tokio::sync::broadcast::Receiver<Vec<u8>> {
        match self.0.tx.lock().unwrap().as_ref() {
            Some(tx) => tx.subscribe(),
            None => tokio::sync::broadcast::channel(1).1,
        }
    }
    async fn is_alive(&self) -> bool {
        self.0.alive.load(Ordering::SeqCst)
    }
    fn exited(&self) -> bool {
        self.0.exited.load(Ordering::SeqCst)
    }
    async fn close(&self) -> Result<()> {
        self.0.closed.store(true, Ordering::SeqCst);
        self.0.alive.store(false, Ordering::SeqCst);
        Ok(())
    }
}

/// 可脚本化 mock 连接：has-session 按 `sessions` 判存在（unknown=true 时探测
/// 通道失败=无法判定）；open_interactive_channel 产出 MockPane 并登记到 `panes`。
struct PaneConn {
    tx: tokio::sync::broadcast::Sender<Vec<u8>>,
    sessions: StdMutex<Vec<String>>,
    unknown: AtomicBool,
    conn_alive: AtomicBool,
    panes: StdMutex<Vec<Arc<PaneState>>>,
}

impl PaneConn {
    fn new(sessions: &[&str]) -> Arc<Self> {
        let (tx, _) = tokio::sync::broadcast::channel(16);
        Arc::new(Self {
            tx,
            sessions: StdMutex::new(sessions.iter().map(|s| s.to_string()).collect()),
            unknown: AtomicBool::new(false),
            conn_alive: AtomicBool::new(true),
            panes: StdMutex::new(Vec::new()),
        })
    }
    fn pane(&self, i: usize) -> Arc<PaneState> {
        self.panes.lock().unwrap()[i].clone()
    }
    fn opened(&self) -> usize {
        self.panes.lock().unwrap().len()
    }
}

#[async_trait::async_trait]
impl ChannelHandle for PaneConn {
    async fn write(&self, _data: &[u8]) -> Result<()> {
        Ok(())
    }
    async fn resize(&self, _cols: u16, _rows: u16) -> Result<()> {
        Ok(())
    }
    async fn exec_fresh(
        &self,
        cmd: &str,
        _opts: &ExecOpts,
        _deadline: std::time::Instant,
        _cancel: &session_api::transport::tokio_util_sync::CancellationToken,
    ) -> Result<FreshOutcome> {
        if self.unknown.load(Ordering::SeqCst) {
            return Err(Error::Io("mock: 通道失败".into()));
        }
        let exit = match cmd.strip_prefix("tmux has-session -t '=") {
            Some(rest) => {
                let name = rest.trim_end_matches('\'');
                if self.sessions.lock().unwrap().iter().any(|s| s == name) {
                    0
                } else {
                    1
                }
            }
            None => 0,
        };
        Ok(FreshOutcome {
            exit_code: Some(exit),
            stdout: Vec::new(),
            stderr: Vec::new(),
            truncated: false,
            completed: true,
        })
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
        self.conn_alive.load(Ordering::SeqCst)
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
    async fn open_interactive_channel(
        &self,
        cmd: &str,
        cols: u16,
        rows: u16,
    ) -> Result<Box<dyn InteractiveChannel>> {
        let (tx, _) = tokio::sync::broadcast::channel(64);
        let st = Arc::new(PaneState {
            cmd: cmd.to_string(),
            tx: StdMutex::new(Some(tx)),
            alive: AtomicBool::new(true),
            exited: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            writes: StdMutex::new(Vec::new()),
            size: StdMutex::new((cols, rows)),
        });
        self.panes.lock().unwrap().push(st.clone());
        Ok(Box::new(MockPane(st)))
    }
}

fn install(m: &SessionManager, kind: &str, conn: Arc<PaneConn>) -> Arc<SessionHandle> {
    let screen = term_core::Screen::new(term_core::ScreenConfig {
        cols: 80,
        rows: 24,
        scrollback: 100,
        lossless_cap: 1 << 20,
    });
    let h = SessionHandle::new(
        format!("s-pane-{}", uuid::Uuid::new_v4()),
        ssh_host(),
        kind.into(),
        conn,
        screen,
        m.center.clone(),
        ControlOwner::Human,
    );
    m.sessions.lock().unwrap().insert(h.id.clone(), h.clone());
    h
}

async fn panes_of(m: &SessionManager, sid: &str) -> Vec<session_api::PaneInfo> {
    m.list_sessions(&Actor::Human)
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.id == sid)
        .map(|s| s.panes)
        .unwrap_or_default()
}

/// 轮询至谓词成立（面板泵 500ms tick + spawn 任务异步落地）。
async fn eventually<F, Fut>(mut f: F, what: &str)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..60 {
        if f().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("等待超时：{what}");
}

fn audit_has(m: &SessionManager, action: &str) -> bool {
    m.center
        .audit
        .query(&AuditFilter {
            limit: 500,
            ..Default::default()
        })
        .unwrap()
        .events
        .iter()
        .any(|e| e.action == action)
}

#[tokio::test]
async fn pane_open_snapshot_backlog_and_split_output() {
    let m = mgr();
    let conn = PaneConn::new(&["work", "logs"]);
    let h = install(&m, "ssh", conn.clone());
    let info = m.tmux_pane_open(&h.id, "logs", 80, 24).await.unwrap();
    assert_eq!(info.pane_id, 1);
    assert!(info.alive);
    // 命令即引导期启动项；-u 强制 UTF-8；=name 精确会话匹配（未探测=按新版处理）
    assert_eq!(conn.pane(0).cmd, "tmux -u attach -t '=logs'");
    let snap = panes_of(&m, &h.id).await;
    assert_eq!(snap.len(), 1);
    assert_eq!(snap[0].tmux_session, "logs");
    assert!(snap[0].alive);
    // 订阅前产出 → 积压；订阅即接走积压（attach 首屏不丢）
    conn.pane(0).emit("BOOT-FRAME");
    tokio::time::sleep(Duration::from_millis(150)).await;
    let mut rx = m.tmux_pane_subscribe(&h.id, 1).unwrap();
    let first = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first, b"BOOT-FRAME");
    // 订阅后直播
    conn.pane(0).emit("LIVE");
    let live = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(live, b"LIVE");
    // 输出分流：格子字节绝不进主屏
    let main = h.screen.lock().await.snapshot_text();
    assert!(!main.contains("BOOT-FRAME") && !main.contains("LIVE"));
    assert!(audit_has(&m, "tmux_pane_open"));
}

#[tokio::test]
async fn pane_guard_matrix() {
    let m = mgr();
    let conn = PaneConn::new(&["work", "a", "b", "c", "d", "e", "f"]);
    let h = install(&m, "ssh", conn.clone());
    // 非法名
    let e = m.tmux_pane_open(&h.id, "x'y", 80, 24).await.unwrap_err();
    assert!(format!("{e}").contains("非法"), "{e}");
    // 远端确认不存在
    let e = m.tmux_pane_open(&h.id, "ghost", 80, 24).await.unwrap_err();
    assert!(format!("{e}").contains("不存在"), "{e}");
    // 撞主视图
    *h.tmux_attached.lock().unwrap() = Some("work".into());
    let e = m.tmux_pane_open(&h.id, "work", 80, 24).await.unwrap_err();
    assert!(format!("{e}").contains("两路视图"), "{e}");
    // 同名格
    m.tmux_pane_open(&h.id, "a", 80, 24).await.unwrap();
    let e = m.tmux_pane_open(&h.id, "a", 80, 24).await.unwrap_err();
    assert!(format!("{e}").contains("面板已包含"), "{e}");
    // 上限（PANE_MAX=5）
    for n in ["b", "c", "d", "e"] {
        m.tmux_pane_open(&h.id, n, 80, 24).await.unwrap();
    }
    let e = m.tmux_pane_open(&h.id, "f", 80, 24).await.unwrap_err();
    assert!(format!("{e}").contains("最多"), "{e}");
    assert_eq!(conn.opened(), 5, "被拒的请求不得开通道");
    // 无法判定（探测通道失败）：如实报连接不稳，不开通道
    let m2 = mgr();
    let conn2 = PaneConn::new(&["x"]);
    let h2 = install(&m2, "ssh", conn2.clone());
    conn2.unknown.store(true, Ordering::SeqCst);
    let e = m2.tmux_pane_open(&h2.id, "x", 80, 24).await.unwrap_err();
    assert!(format!("{e}").contains("无法确认"), "{e}");
    assert_eq!(conn2.opened(), 0);
    // 本地会话不支持
    let m3 = mgr();
    let h3 = install(&m3, "local", PaneConn::new(&["x"]));
    assert!(m3.tmux_pane_open(&h3.id, "x", 80, 24).await.is_err());
    // 未连接状态门
    *h2.state.lock().await = SessionState::Disconnected;
    conn2.unknown.store(false, Ordering::SeqCst);
    let e = m2.tmux_pane_open(&h2.id, "x", 80, 24).await.unwrap_err();
    assert!(format!("{e}").contains("未连接"), "{e}");
}

#[tokio::test]
async fn pane_input_resize_and_close_detach() {
    let m = mgr();
    let conn = PaneConn::new(&["logs"]);
    let h = install(&m, "ssh", conn.clone());
    let p = m.tmux_pane_open(&h.id, "logs", 80, 24).await.unwrap();
    m.tmux_pane_input(&h.id, p.pane_id, "ls\r").await.unwrap();
    assert_eq!(&*conn.pane(0).writes.lock().unwrap(), b"ls\r");
    m.tmux_pane_resize(&h.id, p.pane_id, 100, 40).await.unwrap();
    assert_eq!(*conn.pane(0).size.lock().unwrap(), (100, 40));
    // 关格：通道关闭（detach 语义）+ 清单摘除 + 审计；远端会话不受影响（mock 无 kill）
    m.tmux_pane_close(&h.id, p.pane_id).await.unwrap();
    assert!(conn.pane(0).closed.load(Ordering::SeqCst));
    assert!(panes_of(&m, &h.id).await.is_empty());
    assert!(h.pane_wishlist.lock().unwrap().is_empty());
    assert!(audit_has(&m, "tmux_pane_close"));
    // 关闭后的旧泵迟到死亡不得触发重建（未在册即静默退出）
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(conn.opened(), 1, "关格后不得被重建");
    // 不存在的格子
    assert!(m.tmux_pane_input(&h.id, 99, "x").await.is_err());
}

#[tokio::test]
async fn pane_user_exit_removes_without_rebuild() {
    let m = mgr();
    let conn = PaneConn::new(&["logs"]);
    let h = install(&m, "ssh", conn.clone());
    m.tmux_pane_open(&h.id, "logs", 80, 24).await.unwrap();
    conn.pane(0).kill(true); // 用户在格子里 exit / C-b d
    let (mm, sid) = (m.clone(), h.id.clone());
    eventually(
        || {
            let (mm, sid) = (mm.clone(), sid.clone());
            async move { panes_of(&mm, &sid).await.is_empty() }
        },
        "用户结束后格子摘除",
    )
    .await;
    assert!(h.pane_wishlist.lock().unwrap().is_empty(), "清单同步摘除");
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(conn.opened(), 1, "用户结束不得被强行拉回");
    assert!(audit_has(&m, "tmux_pane_ended"));
}

#[tokio::test]
async fn pane_connection_death_keeps_dead_then_rebuilds_in_place() {
    let m = mgr();
    let conn = PaneConn::new(&["logs", "build"]);
    let h = install(&m, "ssh", conn.clone());
    m.tmux_pane_open(&h.id, "logs", 80, 24).await.unwrap();
    m.tmux_pane_open(&h.id, "build", 90, 30).await.unwrap();
    // 掉线：连接判死 + 两格通道无 exit-status 消亡
    conn.conn_alive.store(false, Ordering::SeqCst);
    conn.pane(0).kill(false);
    conn.pane(1).kill(false);
    let (mm, sid) = (m.clone(), h.id.clone());
    eventually(
        || {
            let (mm, sid) = (mm.clone(), sid.clone());
            async move {
                let s = panes_of(&mm, &sid).await;
                s.len() == 2 && s.iter().all(|p| !p.alive)
            }
        },
        "掉线后两格保留且 alive=false",
    )
    .await;
    assert_eq!(conn.opened(), 2, "连接已死不得原地重开");
    // 重连成功（重注入尾触发重建）：原位换装，新号、顺序不变、尺寸沿用
    conn.conn_alive.store(true, Ordering::SeqCst);
    h.spawn_pane_rebuild();
    let (mm, sid) = (m.clone(), h.id.clone());
    eventually(
        || {
            let (mm, sid) = (mm.clone(), sid.clone());
            async move {
                let s = panes_of(&mm, &sid).await;
                s.len() == 2 && s.iter().all(|p| p.alive)
            }
        },
        "重建后两格复活",
    )
    .await;
    let snap = panes_of(&m, &h.id).await;
    assert_eq!(
        snap.iter()
            .map(|p| p.tmux_session.as_str())
            .collect::<Vec<_>>(),
        vec!["logs", "build"],
        "格子顺序=愿望清单顺序"
    );
    assert!(snap.iter().all(|p| p.pane_id > 2), "重建换新号：{snap:?}");
    assert_eq!(conn.opened(), 4);
    assert_eq!(
        *conn.pane(3).size.lock().unwrap(),
        (90, 30),
        "重建沿用旧尺寸"
    );
    assert_eq!(h.panes.lock().unwrap().len(), 2, "死条目已让位");
}

#[tokio::test]
async fn pane_rebuild_drops_gone_keeps_transient() {
    let m = mgr();
    let conn = PaneConn::new(&["logs", "build"]);
    let h = install(&m, "ssh", conn.clone());
    m.tmux_pane_open(&h.id, "logs", 80, 24).await.unwrap();
    m.tmux_pane_open(&h.id, "build", 80, 24).await.unwrap();
    conn.conn_alive.store(false, Ordering::SeqCst);
    conn.pane(0).kill(false);
    conn.pane(1).kill(false);
    let hh = h.clone();
    eventually(
        || {
            let hh = hh.clone();
            async move {
                hh.panes
                    .lock()
                    .unwrap()
                    .values()
                    .all(|p| p.dead.load(Ordering::SeqCst))
            }
        },
        "两格判死",
    )
    .await;
    // 重连期间 build 会话已在远端结束（Gone）→ 摘除；logs 仍在 → 重建
    conn.sessions.lock().unwrap().retain(|s| s != "build");
    conn.conn_alive.store(true, Ordering::SeqCst);
    h.spawn_pane_rebuild();
    let (mm, sid) = (m.clone(), h.id.clone());
    eventually(
        || {
            let (mm, sid) = (mm.clone(), sid.clone());
            async move {
                let s = panes_of(&mm, &sid).await;
                s.len() == 1 && s[0].tmux_session == "logs" && s[0].alive
            }
        },
        "Gone 摘除、存活者重建",
    )
    .await;
    assert_eq!(*h.pane_wishlist.lock().unwrap(), vec!["logs".to_string()]);
    // Transient：探测通道失败时死格保留在清单（等下一次触发），绝不误摘
    let live = conn.opened() - 1;
    conn.conn_alive.store(false, Ordering::SeqCst);
    conn.pane(live).kill(false);
    let hh = h.clone();
    eventually(
        || {
            let hh = hh.clone();
            async move {
                hh.panes
                    .lock()
                    .unwrap()
                    .values()
                    .all(|p| p.dead.load(Ordering::SeqCst))
            }
        },
        "logs 再次判死",
    )
    .await;
    conn.unknown.store(true, Ordering::SeqCst);
    conn.conn_alive.store(true, Ordering::SeqCst);
    h.spawn_pane_rebuild();
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(
        *h.pane_wishlist.lock().unwrap(),
        vec!["logs".to_string()],
        "瞬时失败不得摘清单"
    );
    let snap = panes_of(&m, &h.id).await;
    assert_eq!(snap.len(), 1);
    assert!(!snap[0].alive, "瞬时失败保持 dead 待下次触发");
}

#[tokio::test]
async fn pane_reverse_attach_guard_and_session_close_cleanup() {
    let m = mgr();
    let conn = PaneConn::new(&["logs"]);
    let h = install(&m, "ssh", conn.clone());
    m.tmux_pane_open(&h.id, "logs", 80, 24).await.unwrap();
    let e = m.tmux_attach(&h.id, "logs", false).await.unwrap_err();
    assert!(format!("{e}").contains("已在面板窗格中"), "{e}");
    // 会话关闭：格子通道全部关闭、清单清空、之后不重建
    m.close_session(&Actor::Human, h.id.clone()).await.unwrap();
    assert!(conn.pane(0).closed.load(Ordering::SeqCst));
    assert!(h.pane_wishlist.lock().unwrap().is_empty());
    assert!(h.panes.lock().unwrap().is_empty());
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(conn.opened(), 1, "关会话后不得重建");
}
