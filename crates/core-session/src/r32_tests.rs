//! R32（C5 传输注册表）：注册/进度/终态/取消/作废/重启恢复的会话层契约。
//! 不建真 SSH：手装 SessionHandle + 配置型 Stub 通道（同 c10/r26/r30 工艺）——
//! 验证「完成/取消不靠审计猜测」（§547 查询+事件+revision 对账）、创建先注册再读写
//!（§560）、重启按提交前中断恢复（本轮无提交阶段，统一 Failed+说明）。

use super::*;
use session_api::transport::{ChannelHandle, FreshOutcome, TransportSignal};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrd};
use std::time::Duration;

/// 传输行为计划：Succeed=分片推进至 total（每片前 sleep 可测取消）；
/// HoldGate=等待外部放行再成功（供事件时序断言）；Fail=注入失败。
#[derive(Clone)]
enum TxPlan {
    Succeed { total: u64, chunk: u64, pause_ms: u64 },
    HoldGate { total: u64, gate: Arc<AtomicBool> },
    Fail { total: u64 },
}

struct R32Channel {
    up: TxPlan,
    down: TxPlan,
}

async fn run_plan(plan: &TxPlan, cancel: &CancellationToken, progress: &(dyn Fn(u64, Option<u64>) + Send + Sync)) -> Result<u64> {
    match plan {
        TxPlan::Succeed { total, chunk, pause_ms } => {
            let mut done = 0u64;
            while done < *total {
                tokio::time::sleep(Duration::from_millis(*pause_ms)).await;
                if cancel.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                done = (done + *chunk).min(*total);
                progress(done, Some(*total));
            }
            Ok(done)
        }
        TxPlan::HoldGate { total, gate } => {
            while !gate.load(AtomicOrd::SeqCst) {
                tokio::time::sleep(Duration::from_millis(10)).await;
                if cancel.is_cancelled() {
                    return Err(Error::Cancelled);
                }
            }
            let mut done = 0u64;
            while done < *total {
                done = (done + 262_144).min(*total);
                progress(done, Some(*total));
            }
            Ok(done)
        }
        TxPlan::Fail { total } => {
            progress((*total / 4).max(1), Some(*total));
            Err(Error::Io("注入失败：远端写入出错".into()))
        }
    }
}

#[async_trait::async_trait]
impl ChannelHandle for R32Channel {
    async fn write(&self, _data: &[u8]) -> Result<()> { Err(Error::InvalidInput("stub".into())) }
    async fn resize(&self, _cols: u16, _rows: u16) -> Result<()> { Ok(()) }
    async fn exec_fresh(&self, _cmd: &str, _opts: &ExecOpts, _deadline: std::time::Instant, _cancel: &session_api::transport::tokio_util_sync::CancellationToken) -> Result<FreshOutcome> { Err(Error::InvalidInput("stub".into())) }
    async fn signal(&self, _sig: TransportSignal) -> Result<()> { Ok(()) }
    async fn force_close(&self) -> Result<()> { Ok(()) }
    fn subscribe_output(&self) -> broadcast::Receiver<Vec<u8>> { broadcast::channel(1).1 }
    async fn is_alive(&self) -> bool { false }
    async fn reconnect(&self) -> Result<()> { Err(Error::InvalidInput("stub".into())) }
    async fn close(&self) -> Result<()> { Ok(()) }
    async fn upload(&self, _local: &std::path::Path, _remote: &str, cancel: &session_api::transport::tokio_util_sync::CancellationToken, progress: &(dyn Fn(u64, Option<u64>) + Send + Sync)) -> Result<u64> {
        run_plan(&self.up, cancel, progress).await
    }
    async fn download(&self, _remote: &str, _local: &std::path::Path, cancel: &session_api::transport::tokio_util_sync::CancellationToken, progress: &(dyn Fn(u64, Option<u64>) + Send + Sync)) -> Result<u64> {
        run_plan(&self.down, cancel, progress).await
    }
    async fn list_dir(&self, _path: &str) -> Result<Vec<DirEntryS>> { Err(Error::InvalidInput("stub".into())) }
}

fn mgr() -> Arc<SessionManager> {
    // 主密钥走 env（同 c10/r30：规避钥匙串 ACL 弹窗阻塞测试进程）
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = std::env::temp_dir().join(format!("r32-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    SessionManager::open(&dir.join("t.db")).unwrap()
}

fn mk_handle(center: Arc<ApprovalCenter>, up: TxPlan, down: TxPlan) -> Arc<SessionHandle> {
    let host = Host {
        id: "local".into(),
        name: "r32".into(),
        address: "local".into(),
        port: 0,
        username: "t".into(),
        auth_type: AuthType::Key,
        identity_id: None,
        tags: vec![],
        fingerprint: None,
        charset: Charset::Utf8,
        shell_integration: None,
    };
    let screen = term_core::Screen::new(term_core::ScreenConfig {
        cols: 80, rows: 24, scrollback: 100, lossless_cap: 1 << 20,
    });
    SessionHandle::new("s-r32".into(), host, "local".into(), Arc::new(R32Channel { up, down }), screen, center, ControlOwner::Agent)
}

fn register(m: &SessionManager, h: Arc<SessionHandle>) {
    m.sessions.lock().unwrap().insert(h.id.clone(), h.clone());
}

/// 轮询注册表直至指定任务终态（超时 5s panic——测试不静默悬挂）。
async fn wait_terminal(m: &SessionManager, tid: &str) -> TransferTask {
    for _ in 0..100 {
        if let Some(t) = m.list_transfers(&Actor::Human).await.unwrap().into_iter().find(|t| t.id == tid) {
            if t.status.is_terminal() {
                return t;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("transfer {tid} 未在 5s 内到达终态");
}

/// C5 主链：创建先注册（Queued 即刻可查）→ Running 进度（bytes/total 推进、
/// revision 单调、事件含首帧 Queued）→ Succeeded 终态 + journal 落账。
#[tokio::test]
async fn r32_lifecycle_events_revision_journal() {
    let m = mgr();
    let gate = Arc::new(AtomicBool::new(false));
    register(&m, mk_handle(m.center.clone(), TxPlan::HoldGate { total: 1_048_576, gate: gate.clone() }, TxPlan::Fail { total: 1 }));
    let mut events = m.transfer_tx.subscribe();
    let human = Actor::Human;
    let h = m.upload(&human, "s-r32".into(), std::path::Path::new("/tmp/src.tar.gz"), "/root/src.tar.gz").await.unwrap();
    // 创建先注册：handle 返回即 Queued 可查（不等任何 I/O）
    let row = m.list_transfers(&human).await.unwrap().into_iter().find(|t| t.id == h.id).expect("注册表应有任务");
    assert_eq!(row.status, TransferStatus::Queued, "注册即 Queued");
    assert_eq!(row.kind, TransferKind::Upload);
    assert_eq!(row.source, "/tmp/src.tar.gz");
    assert_eq!(row.dest, "/root/src.tar.gz");
    // rev-r32 低-1：创建时 total 未知为 None（不以 0 冒充，§352 同口径）
    assert_eq!(row.total, None);
    assert!(row.finished_at.is_none());
    // 事件首帧（register 即发）：Queued，revision 从 1 起
    let first = events.recv().await.unwrap();
    assert_eq!(first.id, h.id);
    assert_eq!(first.status, TransferStatus::Queued);
    assert_eq!(first.revision, 1);
    // 放行 → 终态
    gate.store(true, AtomicOrd::SeqCst);
    let done = wait_terminal(&m, &h.id).await;
    assert_eq!(done.status, TransferStatus::Succeeded);
    assert_eq!(done.bytes_done, 1_048_576);
    assert_eq!(done.total, Some(1_048_576));
    assert!(done.finished_at.is_some());
    // 事件 revision 单调（同一任务）；流里至少含 Queued→Running→Succeeded 形状
    let mut last_rev = 0u64;
    let mut saw_running = false;
    let mut saw_succeeded = false;
    while let Ok(ev) = events.try_recv() {
        if ev.id != h.id { continue; }
        assert!(ev.revision > last_rev, "revision 必须单调：{}→{}", last_rev, ev.revision);
        last_rev = ev.revision;
        saw_running |= ev.status == TransferStatus::Running;
        saw_succeeded |= ev.status == TransferStatus::Succeeded;
    }
    assert!(saw_running && saw_succeeded, "事件流应含 Running 与 Succeeded 帧");
    // journal 落账（终态必写）
    let jr = m.center.vault.transfer_journal_list(10).unwrap();
    let jrow = jr.iter().find(|r| r.id == h.id).expect("journal 应有行");
    assert_eq!(jrow.status, TransferStatus::Succeeded);
    assert_eq!(jrow.bytes_done, 1_048_576);
}

/// C5 进度可见：Running 期间事件帧携带字节推进（不再等终态才知道传输发生）。
#[tokio::test]
async fn r32_running_progress_frames() {
    let m = mgr();
    register(&m, mk_handle(m.center.clone(), TxPlan::Succeed { total: 1_048_576, chunk: 262_144, pause_ms: 250 }, TxPlan::Fail { total: 1 }));
    let mut events = m.transfer_tx.subscribe();
    let human = Actor::Human;
    let h = m.upload(&human, "s-r32".into(), std::path::Path::new("/tmp/a.bin"), "/root/a.bin").await.unwrap();
    // 收帧直至终态（或超时），断言出现过 0 < bytes < total 的中间帧
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut saw_partial = false;
    loop {
        if std::time::Instant::now() > deadline { panic!("未在时限内收齐事件"); }
        match events.try_recv() {
            Ok(ev) if ev.id == h.id => {
                if ev.status == TransferStatus::Running && ev.bytes_done > 0 && ev.bytes_done < 1_048_576 {
                    saw_partial = true;
                }
                if ev.status.is_terminal() { break; }
            }
            Ok(_) => {}
            Err(broadcast::error::TryRecvError::Empty) => tokio::time::sleep(Duration::from_millis(15)).await,
            Err(_) => break,
        }
    }
    assert!(saw_partial, "应出现中间进度帧（0<bytes<total）");
}

/// C5 取消：cancel_transfer → Cancelling 可见 → Cancelled 终态（错误=已取消）；
/// 终态重复取消幂等 Ok；未知 id 报错。任何 Actor 可查（只读）。
#[tokio::test]
async fn r32_cancel_mid_flight() {
    let m = mgr();
    register(&m, mk_handle(m.center.clone(), TxPlan::Succeed { total: 1_048_576, chunk: 4096, pause_ms: 40 }, TxPlan::Fail { total: 1 }));
    let human = Actor::Human;
    let h = m.upload(&human, "s-r32".into(), std::path::Path::new("/tmp/big.bin"), "/root/big.bin").await.unwrap();
    // 等在途进度落地（bytes>0）再取消——保证「取消保留在途字节」断言可判别
    //（取消先于任何 progress 则字节本就 0，不构成抹账）
    for _ in 0..100 {
        let row = m.list_transfers(&human).await.unwrap().into_iter().find(|t| t.id == h.id).unwrap();
        if row.status == TransferStatus::Running && row.bytes_done > 0 { break; }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    m.cancel_transfer(&human, h.id.clone()).await.unwrap();
    // Cancelling 可见（进行中任务 → 取消请求即刻呈现，不等传输循环返回）
    let soon = m.list_transfers(&human).await.unwrap().into_iter().find(|t| t.id == h.id).unwrap();
    assert!(matches!(soon.status, TransferStatus::Cancelling | TransferStatus::Cancelled), "{:?}", soon.status);
    let done = wait_terminal(&m, &h.id).await;
    assert_eq!(done.status, TransferStatus::Cancelled);
    assert_eq!(done.error.as_deref(), Some("已取消"));
    // rev-r32 中-1：取消不抹账——在途进度字节如实保留（与恢复路径同纪律）
    assert!(done.bytes_done > 0, "取消终态应保留在途字节，实际 {}", done.bytes_done);
    assert!(done.bytes_done < 1_048_576, "取消终态不应是全量字节，实际 {}", done.bytes_done);
    // 终态幂等：重复取消 Ok；未知 id 报错
    m.cancel_transfer(&human, h.id.clone()).await.unwrap();
    let e = m.cancel_transfer(&human, "t-nope".into()).await.unwrap_err();
    assert!(matches!(e, Error::InvalidInput(ref s) if s.contains("not found")), "{e:?}");
    // Agent 也可查（只读，C5 查询不设 Actor 门）
    let agent = Actor::Agent { client_id: "mcp-1".into() };
    let via_agent = m.list_transfers(&agent).await.unwrap();
    assert!(via_agent.iter().any(|t| t.id == h.id));
}

/// C5 交接作废：spawn 前已注册的任务，generation 变更后按 Cancelled「接管作废」
/// 落账（人类主权——任务从未开始读写，不虚构任何字节数）。
/// #[tokio::test] 默认 current_thread：upload 返回后、首次 await 前 spawn 不会执行，
/// 先改 generation 再让位即确定性命中 gen 检查。
#[tokio::test]
async fn r32_voided_on_generation_bump() {
    let m = mgr();
    register(&m, mk_handle(m.center.clone(), TxPlan::Succeed { total: 1024, chunk: 1024, pause_ms: 1 }, TxPlan::Fail { total: 1 }));
    let h = register_session_get(m.clone()).await;
    let human = Actor::Human;
    let th = m.upload(&human, "s-r32".into(), std::path::Path::new("/tmp/v.bin"), "/root/v.bin").await.unwrap();
    // spawn 尚未运行（current_thread 单线程）——此刻 bump generation 即作废
    h.generation.store(99, AtomicOrd::SeqCst);
    tokio::time::sleep(Duration::from_millis(150)).await;
    let done = wait_terminal(&m, &th.id).await;
    assert_eq!(done.status, TransferStatus::Cancelled);
    assert_eq!(done.error.as_deref(), Some("接管作废"));
    assert_eq!(done.bytes_done, 0, "作废任务不虚构字节");
    // 会话级 cancel 索引同步清理
    let reg = m.transfers.lock().unwrap();
    assert!(reg.contains_key(&th.id), "注册表保留终态行（查询可见）");
}

async fn register_session_get(m: Arc<SessionManager>) -> Arc<SessionHandle> {
    Arc::clone(m.sessions.lock().unwrap().get("s-r32").unwrap())
}

/// C5 失败路径：通道错误 → Failed + 真实错误文本（不猜、不吞）。
#[tokio::test]
async fn r32_failed_with_real_error() {
    let m = mgr();
    register(&m, mk_handle(m.center.clone(), TxPlan::Fail { total: 4096 }, TxPlan::Fail { total: 4096 }));
    let human = Actor::Human;
    let h = m.download(&human, "s-r32".into(), "/root/gone.bin", std::path::Path::new("/tmp/gone.bin")).await.unwrap();
    let done = wait_terminal(&m, &h.id).await;
    assert_eq!(done.status, TransferStatus::Failed);
    assert!(done.error.as_deref().unwrap_or_default().contains("注入失败"), "{:?}", done.error);
    assert_eq!(done.kind, TransferKind::Download);
    assert_eq!(done.source, "/root/gone.bin");
    assert_eq!(done.dest, "/tmp/gone.bin");
    // rev-r32 中-1：失败不抹账——plan 已报 progress(total/4)=1024，终态如实保留
    assert_eq!(done.bytes_done, 1024, "失败终态应保留已报进度字节");
    // journal 同步不抹账
    let jr = m.center.vault.transfer_journal_list(10).unwrap();
    let jrow = jr.iter().find(|r| r.id == h.id).unwrap();
    assert_eq!(jrow.bytes_done, 1024);
}

/// C5 重启恢复：journal 活动行（Running）→ 重开进程 → 统一 Failed
/// 「应用重启时传输中断」落账并进注册表可见（不虚构成功、不静默消失）。
#[tokio::test]
async fn r32_restart_recovery_marks_interrupted() {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = std::env::temp_dir().join(format!("r32-rec-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("t.db");
    {
        let m = SessionManager::open(&db).unwrap();
        m.center.vault.transfer_journal_insert(&TransferTask {
            id: "t-orph".into(),
            session_id: "s-old".into(),
            kind: TransferKind::Upload,
            source: "/tmp/orph.bin".into(),
            dest: "/root/orph.bin".into(),
            status: TransferStatus::Running,
            bytes_done: 4096,
            total: Some(8192),
            revision: 5,
            created_at: 1790956800,
            finished_at: None,
            error: None,
            retry_of: None,
        })
        .unwrap();
        // manager drop 模拟进程退出（行仍处于活动阶段）
    }
    let m2 = SessionManager::open(&db).unwrap();
    let list = m2.list_transfers(&Actor::Human).await.unwrap();
    let row = list.iter().find(|t| t.id == "t-orph").expect("恢复行应进注册表");
    assert_eq!(row.status, TransferStatus::Failed);
    assert_eq!(row.error.as_deref(), Some("应用重启时传输中断"));
    assert!(row.finished_at.is_some());
    assert_eq!(row.bytes_done, 4096, "恢复不抹账（已传字节如实保留）");
    assert_eq!(row.total, Some(8192));
    // journal 同步落终态（下次重启不再重复恢复）
    let jr = m2.center.vault.transfer_journal_list(10).unwrap();
    let jrow = jr.iter().find(|r| r.id == "t-orph").unwrap();
    assert_eq!(jrow.status, TransferStatus::Failed);
    // 已是终态的行不进恢复面（Succeeded 历史保留原状）
    m2.center.vault.transfer_journal_insert(&TransferTask {
        id: "t-past".into(),
        session_id: "s-old".into(),
        kind: TransferKind::Download,
        source: "/a".into(),
        dest: "/b".into(),
        status: TransferStatus::Succeeded,
        bytes_done: 1,
        total: Some(1),
        revision: 2,
        created_at: 1790956801,
        finished_at: Some(1790956802),
        error: None,
        retry_of: None,
    })
    .unwrap();
    {
        drop(SessionManager::open(&db).unwrap());
    }
    let m3 = SessionManager::open(&db).unwrap();
    // 终态历史行不进重启后注册表（注册表=进程生命周期视图），但 journal 历史保留原状
    let j3 = m3.center.vault.transfer_journal_list(10).unwrap();
    let past = j3.iter().find(|t| t.id == "t-past").expect("终态历史行 journal 保留（重启恢复不碰）");
    assert_eq!(past.status, TransferStatus::Succeeded);
    assert_eq!(past.error, None);
}
