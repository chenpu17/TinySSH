//! tmux 面板（一标签多 tmux 会话）核心状态机：开格防呆矩阵、积压补放与输出分流、
//! 输入/尺寸直达格子通道、关格 detach、用户结束摘格（exited 臂）、掉线保留 dead +
//! 重建原位换装（新 pane_id、顺序不变）、Gone 摘除 / Transient 保留、反向 attach
//! 防呆、会话关闭连带收格。手装 handle + 可脚本化 mock 连接（同 r26 工艺）。

use super::*;
use session_api::transport::{ChannelHandle, FreshOutcome, InteractiveChannel, TransportSignal};
use session_api::{AuditFilter, AuthType, Charset, ControlOwner, Error, Host};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
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

/// 可脚本化 mock 连接：会话解析按 `sessions` 判存在（`=名` 认名、`$N` 认 id——
/// id=序号+1，改名测试原地换名号不变；unknown=true 时解析通道失败=无法判定；
/// exit_override 强制退出码；delay_ms 拖慢解析以制造开格两次 await 之间的交错
/// 窗口）；open_interactive_channel 产出 MockPane 并登记到 `panes`。
struct PaneConn {
    tx: tokio::sync::broadcast::Sender<Vec<u8>>,
    sessions: StdMutex<Vec<String>>,
    unknown: AtomicBool,
    exit_override: StdMutex<Option<i32>>,
    delay_ms: std::sync::atomic::AtomicU64,
    conn_alive: AtomicBool,
    panes: StdMutex<Vec<Arc<PaneState>>>,
    /// 手工 id 表（非空时按序号应答，可喂空段/怪形状——形状闸与跳号用例）；
    /// 空=id 按序号 $1..$n
    ids: StdMutex<Vec<String>>,
    /// tmux 服务器 pid（纪元）：改它=模拟服务器重启，id 从头重排
    server_pid: AtomicU32,
    /// list-clients 应答（tmux_detach 客户端定位）：空=无客户端
    clients: StdMutex<Vec<String>>,
    /// 收到的 exec 命令（断言 detach-client 精确寻址）
    exec_cmds: StdMutex<Vec<String>>,
}

impl PaneConn {
    fn new(sessions: &[&str]) -> Arc<Self> {
        let (tx, _) = tokio::sync::broadcast::channel(16);
        Arc::new(Self {
            tx,
            sessions: StdMutex::new(sessions.iter().map(|s| s.to_string()).collect()),
            unknown: AtomicBool::new(false),
            exit_override: StdMutex::new(None),
            delay_ms: std::sync::atomic::AtomicU64::new(0),
            conn_alive: AtomicBool::new(true),
            panes: StdMutex::new(Vec::new()),
            ids: StdMutex::new(Vec::new()),
            server_pid: AtomicU32::new(4242),
            clients: StdMutex::new(Vec::new()),
            exec_cmds: StdMutex::new(Vec::new()),
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
        self.exec_cmds.lock().unwrap().push(cmd.to_string());
        let delay = self.delay_ms.load(Ordering::SeqCst);
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        if self.unknown.load(Ordering::SeqCst) {
            return Err(Error::Io("mock: 通道失败".into()));
        }
        // 存在性/解析（pane_open_inner）：`display-message -p -t '<sel>:' '格式'`。
        // 选择器 `=名` 按名认（id=序号+1，$1 起）；`$N` 按 id 认（重建走 id——id 在
        // 改名后不变，测试里改名=原地换名，号不变）。命中回 stdout「id|名」。
        let mut stdout: Vec<u8> = Vec::new();
        let exit = if let Some(rest) = cmd.strip_prefix("tmux display-message -p -t '") {
            // 目标段止于 `:' <格式>`；`=名` 是 tmux ≥3.1 精确匹配（此处语义等同裸名），
            // `$N` 按 id 认（重建走 id——id 在改名后不变，测试里改名=原地换名，号不变）
            let target_end = rest.find(":' ").unwrap_or(rest.len());
            let sel = &rest[..target_end];
            let sel = sel.strip_prefix('=').unwrap_or(sel);
            // 命令串里的名字经 sq 转义（shell 视角）——mock 按「tmux 收到的参数」
            // 认名，先还原 '\'' 转义再比对（普通名无转义段，还原是无操作）
            let sel = sel.replace("'\\''", "'");
            let override_code = *self.exit_override.lock().unwrap();
            let sess = self.sessions.lock().unwrap();
            let ids = self.ids.lock().unwrap().clone();
            let id_of = |idx: usize| {
                if ids.is_empty() {
                    format!("${idx}")
                } else {
                    ids.get(idx - 1).cloned().unwrap_or_default()
                }
            };
            let hit = match sel.strip_prefix('$') {
                Some(_) if !ids.is_empty() => {
                    ids.iter().position(|x| x.as_str() == sel).map(|i| i + 1)
                }
                Some(num) => num
                    .parse::<usize>()
                    .ok()
                    .filter(|i| (1..=sess.len()).contains(i)),
                None => sess.iter().position(|s| s.as_str() == sel).map(|i| i + 1),
            };
            match (override_code, hit) {
                (Some(code), _) => code,
                (None, Some(idx)) => {
                    let pid = self.server_pid.load(Ordering::SeqCst);
                    stdout = format!("{}|{pid}|{}", id_of(idx), sess[idx - 1]).into_bytes();
                    0
                }
                (None, None) => 1,
            }
        } else if cmd.starts_with("tmux list-clients -t '") {
            let clients = self.clients.lock().unwrap();
            stdout = clients.join("\n").into_bytes();
            0
        } else {
            0
        };
        Ok(FreshOutcome {
            exit_code: Some(exit),
            stdout,
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
    // 命令即引导期启动项；-u 强制 UTF-8；解析带回 id → attach 直接按 id 认会话
    //（$2=清单第 2 项 logs——改名不换 id，重建/去重全跟 id 走）
    assert_eq!(conn.pane(0).cmd, "tmux -u attach -t '$2'");
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
    // 非法名（闸只拒控制字符——引号/反斜杠是合法 tmux 名，命令构造侧 sq 兜住）
    let e = m.tmux_pane_open(&h.id, "x\ny", 80, 24).await.unwrap_err();
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

/// 审查轮 C2：去重与上限的前置检查在 has-session/开通道两次 await 之前，并发开格
/// 双方都会放行——登记必须在同一临界区复核，落败一路已开的通道必须关掉。
#[tokio::test]
async fn pane_concurrent_open_respects_dedup_and_cap() {
    let m = mgr();
    let conn = PaneConn::new(&["a", "b", "c", "d", "e", "f"]);
    let h = install(&m, "ssh", conn.clone());
    conn.delay_ms.store(200, Ordering::SeqCst);
    let (r1, r2) = tokio::join!(
        m.tmux_pane_open(&h.id, "a", 80, 24),
        m.tmux_pane_open(&h.id, "a", 80, 24)
    );
    assert!(
        r1.is_ok() != r2.is_ok(),
        "同名并发只能成一路：{r1:?} / {r2:?}"
    );
    assert_eq!(panes_of(&m, &h.id).await.len(), 1);
    assert_eq!(h.panes.lock().unwrap().len(), 1, "表内不得出现清单外条目");
    let closed = (0..conn.opened())
        .filter(|&i| conn.pane(i).closed.load(Ordering::SeqCst))
        .count();
    assert_eq!(closed, 1, "落败一路开出的通道必须关掉（远端不留 client）");

    conn.delay_ms.store(0, Ordering::SeqCst);
    for n in ["b", "c", "d"] {
        m.tmux_pane_open(&h.id, n, 80, 24).await.unwrap();
    }
    conn.delay_ms.store(200, Ordering::SeqCst);
    let (r5, r6) = tokio::join!(
        m.tmux_pane_open(&h.id, "e", 80, 24),
        m.tmux_pane_open(&h.id, "f", 80, 24)
    );
    assert!(
        r5.is_ok() != r6.is_ok(),
        "冲上限只能成一路：{r5:?} / {r6:?}"
    );
    let err = format!("{}", r5.err().or(r6.err()).unwrap());
    assert!(err.contains("最多"), "{err}");
    assert_eq!(panes_of(&m, &h.id).await.len(), crate::handle::PANE_MAX);
    assert_eq!(h.panes.lock().unwrap().len(), crate::handle::PANE_MAX);
}

/// 审查轮二 P2：开格（has-session 途中）与主视图 attach 同名会话并发——两道防呆此前
/// 各自在 await 前核验、await 后登记/置位，可被同时穿过（同一会话主视图 + 格子两路
/// 视图）。修后「核验 + 登记/预占」在同序临界区：只能成一路，落败的开格通道要关掉。
#[tokio::test]
async fn pane_open_racing_main_attach_one_view_only() {
    let m = mgr();
    let conn = PaneConn::new(&["work"]);
    let h = install(&m, "ssh", conn.clone());
    conn.delay_ms.store(200, Ordering::SeqCst);
    let (r_open, r_att) = tokio::join!(
        m.tmux_pane_open(&h.id, "work", 80, 24),
        m.tmux_attach(&h.id, "work", false)
    );
    assert!(
        r_open.is_ok() != r_att.is_ok(),
        "同名只能成一路：{r_open:?} / {r_att:?}"
    );
    let attached = h.tmux_attached.lock().unwrap().clone();
    if r_open.is_ok() {
        assert_eq!(attached, None, "格子赢：主视图不得记为已 attach");
    } else {
        assert_eq!(attached.as_deref(), Some("work"));
        assert!(
            h.panes.lock().unwrap().is_empty(),
            "主视图赢：不得留格子条目"
        );
        assert!(
            h.pane_wishlist.lock().unwrap().is_empty(),
            "主视图赢：清单不得登记"
        );
        let closed = (0..conn.opened())
            .filter(|&i| conn.pane(i).closed.load(Ordering::SeqCst))
            .count();
        assert_eq!(closed, conn.opened(), "落败一路开出的通道必须关掉");
    }
}

/// 审查轮 C1：重建在 has-session 途中用户关掉了这个死格——重建开出的新通道
/// 不得以清单外条目登记（界面看不见、关不掉的孤儿），且要关掉。
#[tokio::test]
async fn pane_rebuild_abandons_when_closed_meanwhile() {
    let m = mgr();
    let conn = PaneConn::new(&["logs"]);
    let h = install(&m, "ssh", conn.clone());
    let p = m.tmux_pane_open(&h.id, "logs", 80, 24).await.unwrap();
    conn.delay_ms.store(400, Ordering::SeqCst);
    conn.pane(0).kill(false); // 连接健康 → 单格掉线即触发重建
    let (mm, sid) = (m.clone(), h.id.clone());
    eventually(
        || {
            let (mm, sid) = (mm.clone(), sid.clone());
            async move { panes_of(&mm, &sid).await.first().is_some_and(|x| !x.alive) }
        },
        "掉线后格子 dead",
    )
    .await;
    m.tmux_pane_close(&h.id, p.pane_id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert!(panes_of(&m, &h.id).await.is_empty());
    assert!(
        h.panes.lock().unwrap().is_empty(),
        "重建不得留下清单外的孤儿条目"
    );
    assert_eq!(conn.opened(), 2, "重建确实开过新通道");
    assert!(
        conn.pane(1).closed.load(Ordering::SeqCst),
        "放弃的重建通道必须关掉"
    );
}

/// 审查轮：开格途中会话被关闭——close_session 先置 Closed 再收格，登记落在收格
/// 之后的那一路必须撤回并关通道，不能在已关会话里留活条目。
#[tokio::test]
async fn pane_open_racing_session_close_leaves_nothing() {
    let m = mgr();
    let conn = PaneConn::new(&["logs"]);
    let h = install(&m, "ssh", conn.clone());
    conn.delay_ms.store(300, Ordering::SeqCst);
    let closer = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        m.close_session(&Actor::Human, h.id.clone()).await
    };
    let (r, c) = tokio::join!(m.tmux_pane_open(&h.id, "logs", 80, 24), closer);
    c.unwrap();
    assert!(r.is_err(), "关闭途中的开格必须失败：{r:?}");
    assert!(h.panes.lock().unwrap().is_empty());
    assert!(h.pane_wishlist.lock().unwrap().is_empty());
    assert!(
        conn.pane(0).closed.load(Ordering::SeqCst),
        "已开出的通道必须关掉"
    );
}

/// 审查轮 C4：has-session 退出 127（shell 找不到 tmux——PATH 变化/被卸载）说明不了
/// 会话在不在，不能按「确认不存在」摘清单。
#[tokio::test]
async fn pane_has_session_127_is_unknown_not_gone() {
    let m = mgr();
    let conn = PaneConn::new(&["logs"]);
    let h = install(&m, "ssh", conn.clone());
    m.tmux_pane_open(&h.id, "logs", 80, 24).await.unwrap();
    *conn.exit_override.lock().unwrap() = Some(127);
    conn.conn_alive.store(false, Ordering::SeqCst);
    conn.pane(0).kill(false);
    let (mm, sid) = (m.clone(), h.id.clone());
    eventually(
        || {
            let (mm, sid) = (mm.clone(), sid.clone());
            async move { panes_of(&mm, &sid).await.first().is_some_and(|x| !x.alive) }
        },
        "掉线后格子 dead",
    )
    .await;
    conn.conn_alive.store(true, Ordering::SeqCst);
    h.spawn_pane_rebuild();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(*h.pane_wishlist.lock().unwrap(), vec!["logs".to_string()]);
    let snap = panes_of(&m, &h.id).await;
    assert_eq!(snap.len(), 1, "127 不得摘格");
    assert!(!snap[0].alive);
    // 新开同样不把 127 误报成「会话不存在」
    let e = m.tmux_pane_open(&h.id, "other", 80, 24).await.unwrap_err();
    assert!(!format!("{e}").contains("不存在"), "{e}");
}

/// 审查轮 S3：重建遇瞬时失败不能只等下一次断线——限次退避重试，恢复后原位换装。
#[tokio::test]
async fn pane_rebuild_retries_after_transient_failure() {
    let m = mgr();
    let conn = PaneConn::new(&["logs"]);
    let h = install(&m, "ssh", conn.clone());
    let first = m
        .tmux_pane_open(&h.id, "logs", 80, 24)
        .await
        .unwrap()
        .pane_id;
    conn.unknown.store(true, Ordering::SeqCst); // 探测通道失败 → 无法判定 → Transient
    conn.pane(0).kill(false); // 连接健康 → 立即触发重建（首轮必失败）
    tokio::time::sleep(Duration::from_millis(250)).await;
    let snap = panes_of(&m, &h.id).await;
    assert!(
        snap.len() == 1 && !snap[0].alive,
        "首轮瞬时失败保持 dead：{snap:?}"
    );
    conn.unknown.store(false, Ordering::SeqCst);
    let (mm, sid) = (m.clone(), h.id.clone());
    eventually(
        || {
            let (mm, sid) = (mm.clone(), sid.clone());
            async move {
                let s = panes_of(&mm, &sid).await;
                s.len() == 1 && s[0].alive && s[0].pane_id != first
            }
        },
        "退避重试后原位换装",
    )
    .await;
}

/// 审查轮 S5：主视图在 tmux 里手动 detach 后，「注入过 attach」的记录残留会误拦
/// 「＋面板」并让快接切换去找不存在的客户端——探针按客户端数校正，但刚注入
/// （client 未连上）与仍有客户端（可能是他机）时不动。
#[tokio::test]
async fn tmux_reconcile_attached_clears_stale_only() {
    let m = mgr();
    let conn = PaneConn::new(&[]);
    let h = install(&m, "ssh", conn);
    let status = |name: &str, attached: u32| session_api::TmuxStatus {
        available: true,
        version: Some("3.4".into()),
        sessions: vec![session_api::TmuxSession {
            name: name.into(),
            windows: 1,
            attached,
            id: "$1".into(),
            server_pid: 0,
        }],
    };
    fn att(h: &SessionHandle) -> Option<String> {
        h.tmux_attached.lock().unwrap().clone()
    }
    // 探针发出时刻（默认「此刻」）：校正只认快照请求之前已稳定的 attach
    let now = std::time::Instant::now;
    *h.tmux_attached.lock().unwrap() = Some("work".into());
    SessionManager::tmux_reconcile_attached(&h, &status("work", 1), now());
    assert_eq!(att(&h).as_deref(), Some("work"), "仍有客户端：不动");
    *h.tmux_attached_at.lock().unwrap() = Some(now());
    SessionManager::tmux_reconcile_attached(&h, &status("work", 0), now());
    assert_eq!(att(&h).as_deref(), Some("work"), "刚注入：不动");
    // 审查轮二 P2：探针 T0 发出、T0+1s 注入 attach、exec 慢回到 T0+6.5s——按返回时刻算
    // 年龄（5.5s）会误判已稳定、拿注入前的旧快照把合法 attach 清掉；按发出时刻比则不动
    *h.tmux_attached_at.lock().unwrap() = now().checked_sub(Duration::from_millis(5500));
    SessionManager::tmux_reconcile_attached(
        &h,
        &status("work", 0),
        now().checked_sub(Duration::from_millis(6500)).unwrap(),
    );
    assert_eq!(att(&h).as_deref(), Some("work"), "快照请求早于注入：不动");
    *h.tmux_attached_at.lock().unwrap() = now().checked_sub(Duration::from_secs(10));
    // 找茬四轮 A5：零客户端是歧义（client 注册可晚于 fresh 窗任意久，单拍误清
    // 后「已在主视图」防呆失效、可二次明文注入）——双拍确认。
    SessionManager::tmux_reconcile_attached(&h, &status("work", 0), now());
    assert_eq!(
        att(&h).as_deref(),
        Some("work"),
        "零客户端第一拍：只武装不清"
    );
    SessionManager::tmux_reconcile_attached(&h, &status("work", 0), now());
    assert_eq!(att(&h), None, "零客户端第二拍：判残留清掉");
    // 中间见到客户端即解除武装：重起两拍
    *h.tmux_attached.lock().unwrap() = Some("work".into());
    SessionManager::tmux_reconcile_attached(&h, &status("work", 0), now());
    SessionManager::tmux_reconcile_attached(&h, &status("work", 1), now());
    SessionManager::tmux_reconcile_attached(&h, &status("work", 0), now());
    assert_eq!(
        att(&h).as_deref(),
        Some("work"),
        "中间见到客户端：武装解除，重起两拍"
    );
    SessionManager::tmux_reconcile_attached(&h, &status("work", 0), now());
    assert_eq!(att(&h), None, "重起后的第二拍：清掉");
    *h.tmux_attached.lock().unwrap() = Some("gone".into());
    SessionManager::tmux_reconcile_attached(&h, &status("work", 1), now());
    assert_eq!(att(&h), None, "会话已不存在：清掉");
    // 改名跟随（id 对账）：id 对上、名字已变——不当残留清（旧版按名找会误清，
    // 主视图前缀武装随之停用）；id 缺失退化按名（下面 work-old 仍按名清）
    *h.tmux_attached_id.lock().unwrap() = Some("$1".into());
    *h.tmux_attached.lock().unwrap() = Some("work-old".into());
    SessionManager::tmux_reconcile_attached(&h, &status("work", 1), now());
    assert_eq!(
        att(&h).as_deref(),
        Some("work-old"),
        "id 对上：改名不当残留清"
    );
    *h.tmux_attached_id.lock().unwrap() = None;
    SessionManager::tmux_reconcile_attached(&h, &status("renamed", 1), now());
    assert_eq!(att(&h), None, "id 缺失：退化按名，找不到仍清");
    *h.tmux_attached.lock().unwrap() = Some("work".into());
    let unavailable = session_api::TmuxStatus {
        available: false,
        version: None,
        sessions: vec![],
    };
    SessionManager::tmux_reconcile_attached(&h, &unavailable, now());
    assert_eq!(att(&h).as_deref(), Some("work"), "探测不可用：不动");
    // 清掉之后同名会话可以并入面板（不再被「已在主视图」误拦）
    let conn2 = PaneConn::new(&["work"]);
    let h2 = install(&m, "ssh", conn2);
    *h2.tmux_attached.lock().unwrap() = Some("work".into());
    SessionManager::tmux_reconcile_attached(&h2, &status("work", 0), now());
    // A5 双拍：第一拍武装，第二拍清。
    SessionManager::tmux_reconcile_attached(&h2, &status("work", 0), now());
    m.tmux_pane_open(&h2.id, "work", 80, 24).await.unwrap();
}

/// 改名跟随：探针按不可变 session_id（$N，改名不换）对账——格子名/愿望清单/
/// 主视图名牌原位刷新（保序）；快照里没有该 id、或 id 缺失（极老 tmux 空段）
/// 时名字不动（重建/摘除另有人管，退化按名认）。
#[tokio::test]
async fn tmux_reconcile_names_follows_rename_by_id() {
    let m = mgr();
    let conn = PaneConn::new(&["work", "logs"]);
    let h = install(&m, "ssh", conn);
    m.tmux_pane_open(&h.id, "logs", 80, 24).await.unwrap();
    // 主视图正挂着 logs（id 落账——真实侧 tmux_attach 同口径）
    *h.tmux_attached_id.lock().unwrap() = Some("$2".into());
    *h.tmux_attached.lock().unwrap() = Some("logs".into());
    let st = |sess: Vec<(&str, &str, u32)>| session_api::TmuxStatus {
        available: true,
        version: Some("3.4".into()),
        sessions: sess
            .into_iter()
            .map(|(name, id, attached)| session_api::TmuxSession {
                name: name.into(),
                windows: 1,
                attached,
                id: id.into(),
                server_pid: 0,
            })
            .collect(),
    };
    // 远端把 logs 改成 prod（id $2 不换）
    SessionManager::tmux_reconcile_names(&h, &st(vec![("work", "$1", 1), ("prod", "$2", 1)]));
    let snap = panes_of(&m, &h.id).await;
    assert_eq!(snap[0].tmux_session, "prod", "格子名随 id 刷新");
    assert_eq!(
        *h.pane_wishlist.lock().unwrap(),
        vec!["prod".to_string()],
        "清单原位换名、保序"
    );
    assert_eq!(
        h.tmux_attached.lock().unwrap().as_deref(),
        Some("prod"),
        "主视图名牌跟随（id 对上才动）"
    );
    // 别的会话改名不误伤；快照里没有本格 id（比如刚掉线）名字不动
    SessionManager::tmux_reconcile_names(&h, &st(vec![("prod2", "$1", 0)]));
    assert_eq!(panes_of(&m, &h.id).await[0].tmux_session, "prod");
    // id 缺失（极老 tmux 空段）：退化按名认，一律不动
    let legacy = session_api::TmuxStatus {
        available: true,
        version: Some("2.6".into()),
        sessions: vec![session_api::TmuxSession {
            name: "zzz".into(),
            windows: 1,
            attached: 1,
            id: String::new(),
            server_pid: 0,
        }],
    };
    SessionManager::tmux_reconcile_names(&h, &legacy);
    assert_eq!(panes_of(&m, &h.id).await[0].tmux_session, "prod");
}

/// 纯主视图（attach 的会话不在任何格子里）改名跟随：格子循环覆盖不到它——
/// 对账按 id 直接刷新 tmux_attached（此前停旧名：名牌/快接钮面/切换全跟着错）。
#[tokio::test]
async fn tmux_reconcile_names_follows_main_view_only_rename() {
    let m = mgr();
    let conn = PaneConn::new(&["work"]);
    let h = install(&m, "ssh", conn);
    // 主视图挂 work（$1），面板空——没有任何格子看着它
    *h.tmux_attached_id.lock().unwrap() = Some("$1".into());
    *h.tmux_attached.lock().unwrap() = Some("work".into());
    let st = session_api::TmuxStatus {
        available: true,
        version: Some("3.4".into()),
        sessions: vec![session_api::TmuxSession {
            name: "prod".into(),
            windows: 2,
            attached: 1,
            id: "$1".into(),
            server_pid: 0,
        }],
    };
    SessionManager::tmux_reconcile_names(&h, &st);
    assert_eq!(
        h.tmux_attached.lock().unwrap().as_deref(),
        Some("prod"),
        "纯主视图 attach 记录按 id 跟随改名"
    );
    // id 对不上（别的会话改名）不动；id 缺失不动
    *h.tmux_attached_id.lock().unwrap() = Some("$9".into());
    *h.tmux_attached.lock().unwrap() = Some("prod".into());
    let other = session_api::TmuxStatus {
        available: true,
        version: Some("3.4".into()),
        sessions: vec![session_api::TmuxSession {
            name: "zzz".into(),
            windows: 1,
            attached: 1,
            id: "$2".into(),
            server_pid: 0,
        }],
    };
    SessionManager::tmux_reconcile_names(&h, &other);
    assert_eq!(h.tmux_attached.lock().unwrap().as_deref(), Some("prod"));
}

/// 掉线期间远端改名：重建按死条目记下的 id 解析（`ls -t '$N'`），原位换名重建、
/// 清单跟随；id 失效（tmux 服务器重启重排）回落按名。
#[tokio::test]
async fn pane_rebuild_follows_rename_by_dead_pane_id() {
    let m = mgr();
    let conn = PaneConn::new(&["logs"]);
    let h = install(&m, "ssh", conn.clone());
    m.tmux_pane_open(&h.id, "logs", 80, 24).await.unwrap();
    // 掉线：连接判死 + 格子通道无 exit-status 消亡（同 pane_connection_death 范式——
    // 连接活着时泵会立即原地重建，制造不出「掉线死亡保留」）
    conn.conn_alive.store(false, Ordering::SeqCst);
    conn.pane(0).kill(false);
    let (mm, sid) = (m.clone(), h.id.clone());
    eventually(
        || {
            let (mm, sid) = (mm.clone(), sid.clone());
            async move {
                panes_of(&mm, &sid)
                    .await
                    .first()
                    .map_or(false, |p| !p.alive)
            }
        },
        "掉线死亡保留",
    )
    .await;
    // 掉线期间远端改名（探针没跑过、清单还是旧名）→ 重连重建
    *conn.sessions.lock().unwrap() = vec!["prod".to_string()];
    conn.conn_alive.store(true, Ordering::SeqCst);
    h.spawn_pane_rebuild();
    let (mm, sid) = (m.clone(), h.id.clone());
    eventually(
        || {
            let (mm, sid) = (mm.clone(), sid.clone());
            async move { panes_of(&mm, &sid).await.first().map_or(false, |p| p.alive) }
        },
        "重建复活",
    )
    .await;
    let snap = panes_of(&m, &h.id).await;
    assert_eq!(snap[0].tmux_session, "prod", "按 id 重建并跟随新名");
    assert_eq!(*h.pane_wishlist.lock().unwrap(), vec!["prod".to_string()]);
    // 换装后的新格再掉线、远端再改名：重建仍按 id 跟随（死条目 id 随对账保持最新）
    conn.conn_alive.store(false, Ordering::SeqCst);
    conn.pane(1).kill(false);
    let (mm, sid) = (m.clone(), h.id.clone());
    eventually(
        || {
            let (mm, sid) = (mm.clone(), sid.clone());
            async move {
                panes_of(&mm, &sid)
                    .await
                    .first()
                    .map_or(false, |p| !p.alive)
            }
        },
        "再次掉线死亡",
    )
    .await;
    *conn.sessions.lock().unwrap() = vec!["prod2".to_string()];
    conn.conn_alive.store(true, Ordering::SeqCst);
    h.spawn_pane_rebuild();
    eventually(
        || {
            let (mm, sid) = (mm.clone(), sid.clone());
            async move {
                panes_of(&mm, &sid)
                    .await
                    .first()
                    .map_or(false, |p| p.alive && p.tmux_session == "prod2")
            }
        },
        "id 重建再次跟随改名",
    )
    .await;
}
/// 连环改名（P1 审查修复）：b→c 且 a→b 同轮（快照 b($1)/c($2)）——清单**二段式**
/// 替换（每个条目至多消费一个改名对），逐条 find 会把后处理格子的旧名命中先处理
/// 格子刚写入的条目（清单错绑 → 关格误删别人的项 → 死后不重建、格子静默丢失）。
/// HashMap 迭代顺序不定，8 个新 handle 覆盖两种处理顺序。
#[tokio::test]
async fn tmux_reconcile_names_chain_rename_no_wishlist_crossbind() {
    let m = mgr();
    for round in 0..8 {
        let conn = PaneConn::new(&["a", "b"]);
        let h = install(&m, "ssh", conn);
        m.tmux_pane_open(&h.id, "a", 80, 24).await.unwrap();
        m.tmux_pane_open(&h.id, "b", 80, 24).await.unwrap();
        let st = session_api::TmuxStatus {
            available: true,
            version: Some("3.4".into()),
            sessions: vec![
                session_api::TmuxSession {
                    name: "b".into(),
                    windows: 1,
                    attached: 1,
                    id: "$1".into(),
                    server_pid: 0,
                },
                session_api::TmuxSession {
                    name: "c".into(),
                    windows: 1,
                    attached: 1,
                    id: "$2".into(),
                    server_pid: 0,
                },
            ],
        };
        SessionManager::tmux_reconcile_names(&h, &st);
        let snap = panes_of(&m, &h.id).await;
        assert_eq!(
            snap.iter()
                .map(|p| p.tmux_session.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "c"],
            "round {round}: 格子名随各自 id 刷新"
        );
        assert_eq!(
            *h.pane_wishlist.lock().unwrap(),
            vec!["b".to_string(), "c".to_string()],
            "round {round}: 清单与格子逐位对应（不错绑）"
        );
    }
}

/// tmux 服务器重启纪元（P1 审查修复）：id 只在服务器一生内唯一，重启后从 $0 重排——
/// 旧 id 会**成功**解析成新纪元的别的会话。①对账跨纪元不跟改名；②重建按死条目 id 解析
/// 后比 server_pid，对不上回落按名（绑回真身而不是同名冒充者）。
#[tokio::test]
async fn pane_rebuild_epoch_guard_falls_back_by_name() {
    let m = mgr();
    let conn = PaneConn::new(&["logs"]);
    let h = install(&m, "ssh", conn.clone());
    m.tmux_pane_open(&h.id, "logs", 80, 24).await.unwrap();
    // ①跨纪元对账：格子 born pid=4242，快照 pid=5151 同 id 改名——名字不动
    let cross = session_api::TmuxStatus {
        available: true,
        version: Some("3.4".into()),
        sessions: vec![session_api::TmuxSession {
            name: "imposter".into(),
            windows: 1,
            attached: 1,
            id: "$1".into(),
            server_pid: 5151,
        }],
    };
    SessionManager::tmux_reconcile_names(&h, &cross);
    assert_eq!(
        panes_of(&m, &h.id).await[0].tmux_session,
        "logs",
        "跨纪元同 id 是别的会话：不跟改名"
    );
    // ②掉线死亡 + 服务器重启（pid 变、会话重排：$1 现在叫 other，logs 变 $2）
    conn.conn_alive.store(false, Ordering::SeqCst);
    conn.pane(0).kill(false);
    let (mm, sid) = (m.clone(), h.id.clone());
    eventually(
        || {
            let (mm, sid) = (mm.clone(), sid.clone());
            async move {
                panes_of(&mm, &sid)
                    .await
                    .first()
                    .map_or(false, |p| !p.alive)
            }
        },
        "掉线死亡保留",
    )
    .await;
    conn.server_pid.store(5151, Ordering::SeqCst);
    *conn.sessions.lock().unwrap() = vec!["other".to_string(), "logs".to_string()];
    conn.conn_alive.store(true, Ordering::SeqCst);
    h.spawn_pane_rebuild();
    let (mm, sid) = (m.clone(), h.id.clone());
    eventually(
        || {
            let (mm, sid) = (mm.clone(), sid.clone());
            async move {
                panes_of(&mm, &sid)
                    .await
                    .first()
                    .map_or(false, |p| p.alive && p.tmux_session == "logs")
            }
        },
        "id 跨纪元回落按名：重建绑回 logs 而非 $1 的冒充者 other",
    )
    .await;
    assert_eq!(
        *h.pane_wishlist.lock().unwrap(),
        vec!["logs".to_string()],
        "清单不被改写成冒充者名字"
    );
}

/// id 形状闸/跳号（P2 审查修复）：手工 id 表喂怪形状（$0 跳号 + x9 非法）——
/// 开格按名解析带回非法 id 时形状闸置空，attach 退化按名（=名），格子无 id
/// （改名跟随对其停用，行为同极老 tmux）。
#[tokio::test]
async fn pane_open_with_odd_id_table_degrades_to_by_name() {
    let m = mgr();
    let conn = PaneConn::new(&["x", "logs"]);
    *conn.ids.lock().unwrap() = vec!["$0".to_string(), "x9".to_string()];
    let h = install(&m, "ssh", conn.clone());
    m.tmux_pane_open(&h.id, "logs", 80, 24).await.unwrap();
    assert_eq!(
        conn.pane(0).cmd,
        "tmux -u attach -t '=logs'",
        "id 形状不合 → attach 退化按名"
    );
    let snap = panes_of(&m, &h.id).await;
    assert_eq!(snap[0].tmux_session, "logs");
    // 名字照常解析（探测数据过期被改名也以此为准），仅 id 缺失
}

// 审查轮 P2：开格闸与命令构造面语义对齐——闸只拒控制字符，引号/反斜杠是合法
// tmux 名（远端改名跟随会把这类名字写进愿望清单，闸过严=重建时格子无声蒸发）；
// 注入由命令构造侧 tmux_sq 全覆盖兜住（pane cmd 形状见下）。
#[tokio::test]
async fn pane_quote_name_allowed() {
    let m = mgr();
    let conn = PaneConn::new(&["work", "it's", "c", "d", "e", "f"]);
    let h = install(&m, "ssh", conn.clone());
    m.tmux_pane_open(&h.id, "it's", 80, 24).await.unwrap();
    let opened = conn.pane(0).cmd.clone();
    assert!(
        opened.contains("attach -t ") && opened.starts_with("tmux -u attach -t '"),
        "引号名经 sq 包裹进开格命令: {opened}"
    );
}

/// 统一视图语义：主视图 × = 只分离 tmux 客户端回 shell。标签、面板格子与远端
/// tmux 会话都不动；唯一客户端按 client 名精确 detach（不误伤别处终端）。
#[tokio::test]
async fn tmux_detach_clears_attach_and_targets_client() {
    let m = mgr();
    let conn = PaneConn::new(&["work"]);
    let h = install(&m, "ssh", conn.clone());
    // 未挂 tmux：幂等 no-op
    m.tmux_detach(&h.id).await.unwrap();
    assert!(h.tmux_attached.lock().unwrap().is_none());

    // 主视图挂着 work（id/pid 与真实 tmux_attach 同口径落账）
    *h.tmux_attached.lock().unwrap() = Some("work".into());
    *h.tmux_attached_id.lock().unwrap() = Some("$1".into());
    *h.tmux_attached_server_pid.lock().unwrap() = 4242;
    *conn.clients.lock().unwrap() = vec!["/dev/pts/7".into()];
    m.tmux_detach(&h.id).await.unwrap();
    assert!(h.tmux_attached.lock().unwrap().is_none());
    assert!(h.tmux_attached_id.lock().unwrap().is_none());
    assert_eq!(*h.tmux_attached_server_pid.lock().unwrap(), 0);
    let cmds = conn.exec_cmds.lock().unwrap().clone();
    assert!(
        cmds.iter()
            .any(|c| c == "tmux list-clients -t '=work' -F '#{client_name}'"),
        "{cmds:?}"
    );
    assert!(
        cmds.iter()
            .any(|c| c == "tmux detach-client -s '/dev/pts/7'"),
        "{cmds:?}"
    );
    assert!(audit_has(&m, "tmux_detach"));
}
