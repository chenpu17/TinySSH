//! R35（队列、重试与并行上限）：§366 每会话 2 / 全局 4 并行、其余排队；
//! §364 重试创建新任务（retry_of）且重新校验连接/源/冲突；§374 OutcomeUnknown
//! 绝不接受通用重试；目录明确不支持（源侧判别）。
//! 不建真 SSH：手装 SessionHandle + 配置型 Stub（同 c10/r26/r30/r32/r34 工艺）——
//! 并发闸以 HoldGate 冻结在途任务观察排队；重试「先败后成」以运行期失败开关判别。
//! #[tokio::test] 默认 current_thread：闸/排队时序确定。

use super::*;
use session_api::transport::{ChannelHandle, FreshOutcome, TransportSignal};
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrd};
use std::time::Duration;

#[derive(Clone)]
enum TxPlan {
    Succeed {
        total: u64,
        chunk: u64,
        pause_ms: u64,
    },
    /// 冻结在途任务（持闸，供并发上限/排队观察）
    HoldGate { total: u64, gate: Arc<AtomicBool> },
    /// 挂死模拟（cancel 即时性轮）：完全无视 cancel 的死 IO——真实域=死网络
    /// 上永不返回的 write_all；取消只能靠编排层 select 掉 future 生效
    Hang,
}

/// 发布原语脚本。
#[derive(Clone)]
enum LinkPlan {
    Committed,
    /// C13：应答丢失（core 收 Ambiguous → OutcomeUnknown）
    Ambiguous,
}

struct R35Channel {
    up: TxPlan,
    down: TxPlan,
    /// mock 文件表：路径 → (size, mtime)
    fs: Arc<StdMutex<BTreeMap<String, (u64, i64)>>>,
    /// 远端「目录」路径集合（stat_entry 报 is_dir=true）——下载目录判别面
    dir_paths: StdMutex<HashSet<String>>,
    link: LinkPlan,
    /// 运行期失败注入开关（供重试「先败后成」判别——同一通道两阶段行为可切）
    up_fail: AtomicBool,
    down_fail: AtomicBool,
}

impl R35Channel {
    fn seed(&self, path: &str, size: u64) {
        self.fs
            .lock()
            .unwrap()
            .insert(path.to_string(), (size, 1790000000));
    }
    fn dir(&self, path: &str) {
        self.dir_paths.lock().unwrap().insert(path.to_string());
    }
    fn get(&self, path: &str) -> Option<(u64, i64)> {
        self.fs.lock().unwrap().get(path).copied()
    }
    fn put(&self, path: &str, size: u64) {
        self.fs
            .lock()
            .unwrap()
            .insert(path.to_string(), (size, 1790000001));
    }
    fn del(&self, path: &str) {
        self.fs.lock().unwrap().remove(path);
    }
    /// rev-r34 高-1 命名空间判别：通道=远端 SFTP 语义——本地路径（/local/ 前缀）
    /// 一旦被路由到通道即 panic。
    fn ensure_remote(&self, path: &str) {
        assert!(
            !path.starts_with("/local/"),
            "命名空间错位：本地路径 {path} 进了通道（rev-r34 高-1 回归）"
        );
    }
}

async fn run_plan(
    plan: &TxPlan,
    cancel: &CancellationToken,
    progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
) -> Result<u64> {
    match plan {
        TxPlan::Succeed {
            total,
            chunk,
            pause_ms,
        } => {
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
                tokio::time::sleep(Duration::from_millis(5)).await;
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
        TxPlan::Hang => {
            // 无视 cancel：永不返回、永不检查（外层 select 是唯一出口）
            loop {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

#[async_trait::async_trait]
impl ChannelHandle for R35Channel {
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
        _cancel: &CancellationToken,
    ) -> Result<FreshOutcome> {
        Err(Error::InvalidInput("stub".into()))
    }
    async fn signal(&self, _sig: TransportSignal) -> Result<()> {
        Ok(())
    }
    async fn force_close(&self) -> Result<()> {
        Ok(())
    }
    fn subscribe_output(&self) -> broadcast::Receiver<Vec<u8>> {
        broadcast::channel(1).1
    }
    async fn is_alive(&self) -> bool {
        false
    }
    async fn reconnect(&self) -> Result<()> {
        Err(Error::InvalidInput("stub".into()))
    }
    async fn close(&self) -> Result<()> {
        Ok(())
    }
    async fn upload(
        &self,
        _local: &std::path::Path,
        remote: &str,
        cancel: &CancellationToken,
        progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<u64> {
        if self.up_fail.load(AtomicOrd::SeqCst) {
            progress(1024, Some(4096));
            return Err(Error::Io("注入失败：远端写入出错".into()));
        }
        let n = run_plan(&self.up, cancel, progress).await?;
        self.put(remote, n);
        Ok(n)
    }
    async fn download(
        &self,
        _remote: &str,
        local: &std::path::Path,
        cancel: &CancellationToken,
        progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<u64> {
        if self.down_fail.load(AtomicOrd::SeqCst) {
            progress(1024, Some(4096));
            return Err(Error::Io("注入失败：远端写入出错".into()));
        }
        let n = run_plan(&self.down, cancel, progress).await?;
        // 本地通路：真实落盘（ns_stat 的 temp 核对走真实本地 FS，不进 stat map）
        std::fs::write(local, vec![0u8; n as usize])
            .map_err(|e| Error::Io(format!("mock download write: {e}")))?;
        Ok(n)
    }
    async fn list_dir(&self, _path: &str) -> Result<Vec<DirEntryS>> {
        Err(Error::InvalidInput("stub".into()))
    }
    async fn resolve_path(&self, path: Option<&str>) -> Result<PathResolved> {
        Ok(PathResolved {
            canonical: path.unwrap_or("/root").to_string(),
        })
    }
    async fn stat_entry(&self, path: &str) -> Result<EntryStat> {
        self.ensure_remote(path);
        if self.dir_paths.lock().unwrap().contains(path) {
            return Ok(EntryStat {
                canonical: Some(path.to_string()),
                kind: Some(EntryKind::Dir),
                is_dir: true,
                size: Some(0),
                mtime: Some(1790000000),
                symlink_target: None,
            });
        }
        match self.get(path) {
            Some((sz, mt)) => Ok(EntryStat {
                canonical: Some(path.to_string()),
                kind: Some(EntryKind::File),
                is_dir: false,
                size: Some(sz),
                mtime: Some(mt),
                symlink_target: None,
            }),
            None => Err(Error::SftpPathNotFound {
                path: path.to_string(),
            }),
        }
    }
    async fn publish_hardlink(&self, existing: &str, new: &str) -> Result<PublishOutcome> {
        self.ensure_remote(existing);
        self.ensure_remote(new);
        match &self.link {
            LinkPlan::Committed => match self.get(existing).map(|x| x.0) {
                Some(n) => {
                    self.put(new, n);
                    Ok(PublishOutcome::Committed)
                }
                None => Ok(PublishOutcome::Rejected("temp missing".into())),
            },
            LinkPlan::Ambiguous => Ok(PublishOutcome::Ambiguous),
        }
    }
    async fn remove_file(&self, path: &str) -> Result<()> {
        self.ensure_remote(path);
        self.del(path);
        Ok(())
    }
}

fn mgr() -> Arc<SessionManager> {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = std::env::temp_dir().join(format!("r35-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    SessionManager::open(&dir.join("t.db")).unwrap()
}

/// 装配（通道与句柄并列返回——闸/发布脚本由测试直接驱动）。
fn mk_sess(
    center: Arc<ApprovalCenter>,
    sid: &str,
    up: TxPlan,
    down: TxPlan,
    link: LinkPlan,
) -> (Arc<SessionHandle>, Arc<R35Channel>) {
    let host = Host {
        id: sid.into(),
        name: sid.into(),
        address: "local".into(),
        port: 0,
        username: "t".into(),
        auth_type: AuthType::Key,
        identity_id: None,
        tags: vec![],
        fingerprint: None,
        charset: Charset::Utf8,
        shell_integration: None,
        jump_host_id: None,
        startup_command: None,
    };
    let screen = term_core::Screen::new(term_core::ScreenConfig {
        cols: 80,
        rows: 24,
        scrollback: 100,
        lossless_cap: 1 << 20,
    });
    let c = Arc::new(R35Channel {
        up,
        down,
        link,
        fs: Arc::new(StdMutex::new(BTreeMap::new())),
        dir_paths: StdMutex::new(HashSet::new()),
        up_fail: AtomicBool::new(false),
        down_fail: AtomicBool::new(false),
    });
    // R35 源侧判别（生产契约：上传源必须存在且非目录）：本套件固定本地源落真实文件。
    // 父目录先建 + 硬失败（.ok() 吞错在干净机上 = 源静默缺席，见 r32 夹具注）
    std::fs::create_dir_all("/tmp").unwrap();
    for p in ["/tmp/r35-a.bin", "/tmp/r35-b.bin", "/tmp/r35-c.bin"] {
        std::fs::write(p, b"r35-src").unwrap();
    }
    let h = SessionHandle::new(
        sid.into(),
        host,
        "local".into(),
        c.clone(),
        screen,
        center,
        ControlOwner::Agent,
    );
    (h, c)
}

fn register(m: &SessionManager, h: Arc<SessionHandle>) {
    m.sessions.lock().unwrap().insert(h.id.clone(), h.clone());
}

async fn wait_terminal(m: &SessionManager, tid: &str) -> TransferTask {
    for _ in 0..240 {
        if let Some(t) = m
            .list_transfers(&Actor::Human)
            .await
            .unwrap()
            .into_iter()
            .find(|t| t.id == tid)
        {
            if t.status.is_terminal() {
                return t;
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let dump: Vec<String> = m
        .list_transfers(&Actor::Human)
        .await
        .unwrap()
        .into_iter()
        .map(|t| {
            format!(
                "{}={:?}({})",
                &t.id[..8.min(t.id.len())],
                t.status,
                t.error.as_deref().unwrap_or("")
            )
        })
        .collect();
    panic!("transfer {tid} 未在 6s 内到达终态：{:?}", dump);
}

async fn wait_status(m: &SessionManager, tid: &str, want: TransferStatus) -> TransferTask {
    for _ in 0..240 {
        if let Some(t) = m
            .list_transfers(&Actor::Human)
            .await
            .unwrap()
            .into_iter()
            .find(|t| t.id == tid)
        {
            if t.status == want {
                return t;
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("transfer {tid} 未在 6s 内到达 {want:?}");
}

async fn count_running(m: &SessionManager) -> usize {
    m.list_transfers(&Actor::Human)
        .await
        .unwrap()
        .iter()
        .filter(|t| t.status == TransferStatus::Running)
        .count()
}

const T: u64 = 4096;

/// cancel 即时性轮（挂死 IO）：完全无视 cancel 的死 IO（TxPlan::Hang）上，
/// cancel_transfer 必须秒级收敛 Cancelled——编排层 select 掉传输 future 是
/// 唯一出口（真实域=死网络 write_all 挂死，传输环内 is_cancelled 检查永不可达；
/// 此前裸 await 时本用例只能等 wait_terminal 6s 超时 panic）。
#[tokio::test]
async fn r35_cancel_cuts_hung_io() {
    let m = mgr();
    let (h, _c) = mk_sess(
        m.center.clone(),
        "s-r35",
        TxPlan::Hang,
        TxPlan::Succeed {
            total: T,
            chunk: T,
            pause_ms: 1,
        },
        LinkPlan::Committed,
    );
    register(&m, h);
    let t = m
        .upload(
            &Actor::Human,
            "s-r35".into(),
            std::path::Path::new("/tmp/r35-a.bin"),
            "/root/hang.bin",
            None,
        )
        .await
        .unwrap();
    wait_status(&m, &t.id, TransferStatus::Running).await;
    m.cancel_transfer(&Actor::Human, t.id.clone())
        .await
        .unwrap();
    let start = std::time::Instant::now();
    let done = wait_terminal(&m, &t.id).await;
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "挂死 IO 上取消必须即时（实测 {:?}）",
        start.elapsed()
    );
    assert_eq!(done.status, TransferStatus::Cancelled);
    let (jr, verified) = m.center.vault.transfer_journal_get(&t.id).unwrap().unwrap();
    assert_eq!(jr.status, TransferStatus::Cancelled);
    assert!(!verified, "确未提交 → 无发布证据");
}

/// §366 每会话并行上限 2：同会话 3 个不同目标上传，2 个在途 Running、第 3 个
/// 保持 Queued 排队；放行后在途完成、排队者接续并全部 Succeeded。
#[tokio::test]
async fn r35_session_parallel_limit_and_queue() {
    let m = mgr();
    let gate = Arc::new(AtomicBool::new(false));
    let (h, _c) = mk_sess(
        m.center.clone(),
        "s-r35",
        TxPlan::HoldGate {
            total: T,
            gate: gate.clone(),
        },
        TxPlan::Succeed {
            total: T,
            chunk: T,
            pause_ms: 1,
        },
        LinkPlan::Committed,
    );
    register(&m, h);
    let a = m
        .upload(
            &Actor::Human,
            "s-r35".into(),
            std::path::Path::new("/tmp/r35-a.bin"),
            "/root/q1.bin",
            None,
        )
        .await
        .unwrap();
    let b = m
        .upload(
            &Actor::Human,
            "s-r35".into(),
            std::path::Path::new("/tmp/r35-b.bin"),
            "/root/q2.bin",
            None,
        )
        .await
        .unwrap();
    let c = m
        .upload(
            &Actor::Human,
            "s-r35".into(),
            std::path::Path::new("/tmp/r35-c.bin"),
            "/root/q3.bin",
            None,
        )
        .await
        .unwrap();
    // 等到 2 个在途（持闸）——第 3 个不得越过闸
    for _ in 0..240 {
        if count_running(&m).await >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(
        count_running(&m).await,
        2,
        "每会话并行上限 2，不得有第 3 个 Running"
    );
    let third = m
        .list_transfers(&Actor::Human)
        .await
        .unwrap()
        .into_iter()
        .find(|t| t.id == c.id)
        .unwrap();
    assert_eq!(
        third.status,
        TransferStatus::Queued,
        "第 3 个任务保持 Queued 排队（§366）"
    );
    // 放行 → 在途完成、排队者接续
    gate.store(true, AtomicOrd::SeqCst);
    for tid in [&a.id, &b.id, &c.id] {
        let done = wait_terminal(&m, tid).await;
        assert_eq!(done.status, TransferStatus::Succeeded, "{tid} 应最终成功");
        // G3 退出「文件结果不能只观察 UI 标签」：排队放行者必须真传满字节。
        assert_eq!(
            done.bytes_done, T,
            "{tid} 排队放行后应完整传完（真结果，非仅状态）"
        );
    }
}

/// §366 窗口全局并行上限 4：三会话（A×2、B×2、C×1）共 5 个在途请求，
/// 全局仅放行 4——第 5 个即便所在会话未达每会话上限也必须排队。
#[tokio::test]
async fn r35_global_parallel_limit() {
    let m = mgr();
    let gate = Arc::new(AtomicBool::new(false));
    let hold = TxPlan::HoldGate {
        total: T,
        gate: gate.clone(),
    };
    let ok = TxPlan::Succeed {
        total: T,
        chunk: T,
        pause_ms: 1,
    };
    let (ha, _) = mk_sess(
        m.center.clone(),
        "s-A",
        hold.clone(),
        ok.clone(),
        LinkPlan::Committed,
    );
    let (hb, _) = mk_sess(
        m.center.clone(),
        "s-B",
        hold.clone(),
        ok.clone(),
        LinkPlan::Committed,
    );
    let (hc, _) = mk_sess(
        m.center.clone(),
        "s-C",
        hold.clone(),
        ok.clone(),
        LinkPlan::Committed,
    );
    register(&m, ha);
    register(&m, hb);
    register(&m, hc);
    let mut ids = vec![];
    for (sid, n) in [("s-A", "a"), ("s-B", "b"), ("s-C", "c")] {
        let cnt = if sid == "s-C" { 1 } else { 2 };
        for i in 0..cnt {
            let t = m
                .upload(
                    &Actor::Human,
                    sid.into(),
                    std::path::Path::new(&format!("/tmp/r35-{n}.bin")),
                    &format!("/root/{n}{i}.bin"),
                    None,
                )
                .await
                .unwrap();
            ids.push(t.id);
        }
    }
    for _ in 0..240 {
        if count_running(&m).await >= 4 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(
        count_running(&m).await,
        4,
        "窗口全局并行上限 4，不得有第 5 个 Running"
    );
    // 第 5 个（s-C 的唯一任务）所在会话未达每会话上限，仍因全局满而排队
    let queued = m
        .list_transfers(&Actor::Human)
        .await
        .unwrap()
        .into_iter()
        .filter(|t| t.status == TransferStatus::Queued)
        .count();
    assert_eq!(queued, 1, "全局闸满时第 5 个保持 Queued");
    gate.store(true, AtomicOrd::SeqCst);
    for tid in &ids {
        let done = wait_terminal(&m, tid).await;
        assert_eq!(done.status, TransferStatus::Succeeded, "{tid} 应最终成功");
        assert_eq!(done.bytes_done, T, "{tid} 排队放行后应完整传完");
    }
}

/// §366 队首不阻塞全局：单会话排队任务不得白占全局许可（否则饿死他会话）。
/// 会话 A 排 3 个（2 在途 + 1 排队）、会话 B 排 2 个——全局 4 许可应全给「已持
/// 会话槽、即将开跑」的任务：A×2 + B×2 全在途，仅 A 的第 3 个排队。
/// （若先取全局再取会话，A 的排队任务会占掉 1 个全局许可 → 仅 3 在途，本测试即红。）
#[tokio::test]
async fn r35_queued_task_does_not_starve_global() {
    let m = mgr();
    let gate = Arc::new(AtomicBool::new(false));
    let hold = TxPlan::HoldGate {
        total: T,
        gate: gate.clone(),
    };
    let ok = TxPlan::Succeed {
        total: T,
        chunk: T,
        pause_ms: 1,
    };
    let (ha, _) = mk_sess(
        m.center.clone(),
        "s-A",
        hold.clone(),
        ok.clone(),
        LinkPlan::Committed,
    );
    let (hb, _) = mk_sess(
        m.center.clone(),
        "s-B",
        hold.clone(),
        ok.clone(),
        LinkPlan::Committed,
    );
    register(&m, ha);
    register(&m, hb);
    let mut ids = vec![];
    for (sid, n, cnt) in [("s-A", "a", 3usize), ("s-B", "b", 2usize)] {
        for i in 0..cnt {
            let t = m
                .upload(
                    &Actor::Human,
                    sid.into(),
                    std::path::Path::new(&format!("/tmp/r35-{n}.bin")),
                    &format!("/root/{n}s{i}.bin"),
                    None,
                )
                .await
                .unwrap();
            ids.push(t.id);
        }
    }
    for _ in 0..240 {
        if count_running(&m).await >= 4 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(
        count_running(&m).await,
        4,
        "全局 4 许可应全用于在途任务（排队任务不占全局）"
    );
    let queued = m
        .list_transfers(&Actor::Human)
        .await
        .unwrap()
        .into_iter()
        .filter(|t| t.status == TransferStatus::Queued)
        .count();
    assert_eq!(queued, 1, "仅会话 A 的第 3 个排队");
    gate.store(true, AtomicOrd::SeqCst);
    for tid in &ids {
        let done = wait_terminal(&m, tid).await;
        assert_eq!(done.status, TransferStatus::Succeeded, "{tid} 应最终成功");
        assert_eq!(done.bytes_done, T, "{tid} 排队放行后应完整传完");
    }
}

/// §364 重试创建新任务：失败任务重试产出**不同 id** 的新任务且 retry_of 指向旧任务；
/// 新任务重新走完整链路（先败后成——同一通道运行期切开关即证不续传旧态）。
#[tokio::test]
async fn r35_retry_creates_new_task() {
    let m = mgr();
    let (h, c) = mk_sess(
        m.center.clone(),
        "s-r35",
        TxPlan::Succeed {
            total: T,
            chunk: T,
            pause_ms: 1,
        },
        TxPlan::Succeed {
            total: T,
            chunk: T,
            pause_ms: 1,
        },
        LinkPlan::Committed,
    );
    register(&m, h);
    c.up_fail.store(true, AtomicOrd::SeqCst);
    let old = m
        .upload(
            &Actor::Human,
            "s-r35".into(),
            std::path::Path::new("/tmp/r35-a.bin"),
            "/root/rt.bin",
            None,
        )
        .await
        .unwrap();
    let done = wait_terminal(&m, &old.id).await;
    assert_eq!(done.status, TransferStatus::Failed);
    assert!(done.retry_of.is_none(), "首任务无 retry_of");
    // 放行数据阶段 → 重试应真正重跑并成功（非复用旧终态）
    c.up_fail.store(false, AtomicOrd::SeqCst);
    let newh = m.retry_transfer(&Actor::Human, &old.id).await.unwrap();
    assert_ne!(newh.id, old.id, "重试必须创建新任务（新 id）");
    let newdone = wait_terminal(&m, &newh.id).await;
    assert_eq!(
        newdone.status,
        TransferStatus::Succeeded,
        "重试重新执行并成功"
    );
    assert_eq!(
        newdone.retry_of.as_deref(),
        Some(old.id.as_str()),
        "新任务 retry_of 指向旧任务"
    );
    assert_eq!(newdone.source, "/tmp/r35-a.bin");
    assert_eq!(newdone.dest, "/root/rt.bin");
    // 旧任务终态不被改写（重试是并列新任务，不复活旧行）
    let oldrow = m
        .list_transfers(&Actor::Human)
        .await
        .unwrap()
        .into_iter()
        .find(|t| t.id == old.id)
        .unwrap();
    assert_eq!(oldrow.status, TransferStatus::Failed);
}

/// §364 重试重新校验源文件：源已消失时重试必须以「源文件不存在」如实失败，
/// 证明重试重新走源侧判别而非沿用旧态。
#[tokio::test]
async fn r35_retry_revalidates_source() {
    let m = mgr();
    let (h, c) = mk_sess(
        m.center.clone(),
        "s-r35",
        TxPlan::Succeed {
            total: T,
            chunk: T,
            pause_ms: 1,
        },
        TxPlan::Succeed {
            total: T,
            chunk: T,
            pause_ms: 1,
        },
        LinkPlan::Committed,
    );
    register(&m, h);
    // 硬失败同夹具注：吞错会让「重试换名」用例静默缺源
    std::fs::write("/tmp/r35-gone.bin", b"r35").unwrap();
    c.up_fail.store(true, AtomicOrd::SeqCst);
    let old = m
        .upload(
            &Actor::Human,
            "s-r35".into(),
            std::path::Path::new("/tmp/r35-gone.bin"),
            "/root/rg.bin",
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        wait_terminal(&m, &old.id).await.status,
        TransferStatus::Failed
    );
    // 源消失 → 重试重新校验即失败
    std::fs::remove_file("/tmp/r35-gone.bin").ok();
    c.up_fail.store(false, AtomicOrd::SeqCst);
    let newh = m.retry_transfer(&Actor::Human, &old.id).await.unwrap();
    let newdone = wait_terminal(&m, &newh.id).await;
    assert_eq!(newdone.status, TransferStatus::Failed);
    assert!(
        newdone
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("源文件不存在"),
        "{:?}",
        newdone.error
    );
    assert_eq!(newdone.retry_of.as_deref(), Some(old.id.as_str()));
}

/// §374 OutcomeUnknown 不接受通用重试：重试必须被拒（InvalidTransferState），
/// 只能走「重新核实」。判别为硬门，非静默降级。
#[tokio::test]
async fn r35_retry_refuses_outcome_unknown() {
    let m = mgr();
    let (h, _c) = mk_sess(
        m.center.clone(),
        "s-r35",
        TxPlan::Succeed {
            total: T,
            chunk: T,
            pause_ms: 1,
        },
        TxPlan::Succeed {
            total: T,
            chunk: T,
            pause_ms: 1,
        },
        LinkPlan::Ambiguous,
    );
    register(&m, h);
    let t = m
        .upload(
            &Actor::Human,
            "s-r35".into(),
            std::path::Path::new("/tmp/r35-a.bin"),
            "/root/unk.bin",
            None,
        )
        .await
        .unwrap();
    let done = wait_terminal(&m, &t.id).await;
    assert_eq!(done.status, TransferStatus::OutcomeUnknown);
    let e = m.retry_transfer(&Actor::Human, &t.id).await.unwrap_err();
    match e {
        Error::InvalidTransferState { state, .. } => {
            assert_eq!(state, TransferStatus::OutcomeUnknown)
        }
        other => panic!("OutcomeUnknown 重试应报 InvalidTransferState，实际 {other:?}"),
    }
    // 无新任务被创建（重试被拒 = 零副作用）
    let n = m.list_transfers(&Actor::Human).await.unwrap().len();
    assert_eq!(n, 1, "被拒的重试不产生新任务");
}

/// §364 仅终态可重试：在途（Running）任务的通用重试必须被拒。
#[tokio::test]
async fn r35_retry_refuses_running() {
    let m = mgr();
    let gate = Arc::new(AtomicBool::new(false));
    let (h, _c) = mk_sess(
        m.center.clone(),
        "s-r35",
        TxPlan::HoldGate {
            total: T,
            gate: gate.clone(),
        },
        TxPlan::Succeed {
            total: T,
            chunk: T,
            pause_ms: 1,
        },
        LinkPlan::Committed,
    );
    register(&m, h);
    let t = m
        .upload(
            &Actor::Human,
            "s-r35".into(),
            std::path::Path::new("/tmp/r35-a.bin"),
            "/root/run.bin",
            None,
        )
        .await
        .unwrap();
    wait_status(&m, &t.id, TransferStatus::Running).await;
    let e = m.retry_transfer(&Actor::Human, &t.id).await.unwrap_err();
    match e {
        Error::InvalidTransferState { state, .. } => assert_eq!(state, TransferStatus::Running),
        other => panic!("Running 重试应报 InvalidTransferState，实际 {other:?}"),
    }
    gate.store(true, AtomicOrd::SeqCst);
    assert_eq!(
        wait_terminal(&m, &t.id).await.status,
        TransferStatus::Succeeded
    );
}

/// §364 重试重新校验冲突：预检命中同名 → 决策卡（人类跳过）→ Skipped；重试是
/// **新任务**重新预检，仍命中同名 → 再次进入决策卡（不自动重试已授权覆盖、不静默放行）。
#[tokio::test]
async fn r35_retry_rechecks_collision() {
    let m = mgr();
    let (h, c) = mk_sess(
        m.center.clone(),
        "s-r35",
        TxPlan::Succeed {
            total: T,
            chunk: T,
            pause_ms: 1,
        },
        TxPlan::Succeed {
            total: T,
            chunk: T,
            pause_ms: 1,
        },
        LinkPlan::Committed,
    );
    register(&m, h);
    c.seed("/root/col.bin", 512); // 目标已存在
    let old = m
        .upload(
            &Actor::Human,
            "s-r35".into(),
            std::path::Path::new("/tmp/r35-a.bin"),
            "/root/col.bin",
            None,
        )
        .await
        .unwrap();
    let card = wait_status(&m, &old.id, TransferStatus::AwaitingDecision).await;
    m.submit_collision_decision(
        &Actor::Human,
        old.id.clone(),
        CollisionDecision::Skip,
        card.revision,
    )
    .await
    .unwrap();
    assert_eq!(
        wait_terminal(&m, &old.id).await.status,
        TransferStatus::Skipped
    );
    // 重试 → 新任务重新预检 → 再次进入决策卡（不自动沿用旧决定）
    let newh = m.retry_transfer(&Actor::Human, &old.id).await.unwrap();
    let card2 = wait_status(&m, &newh.id, TransferStatus::AwaitingDecision).await;
    assert_eq!(card2.retry_of.as_deref(), Some(old.id.as_str()));
    assert_eq!(
        card2.decision_prompt.as_ref().unwrap().reason,
        "target_exists"
    );
    m.submit_collision_decision(
        &Actor::Human,
        newh.id.clone(),
        CollisionDecision::Skip,
        card2.revision,
    )
    .await
    .unwrap();
    let newdone = wait_terminal(&m, &newh.id).await;
    assert_eq!(newdone.status, TransferStatus::Skipped);
    assert_eq!(
        c.get("/root/col.bin").map(|s| s.0),
        Some(512),
        "原目标未被任务替换"
    );
}

/// 目录明确不支持（上传侧）：真实本地目录作为源 → Failed + 明确文案，零 staging。
#[tokio::test]
async fn r35_directory_upload_rejected() {
    let m = mgr();
    let (h, c) = mk_sess(
        m.center.clone(),
        "s-r35",
        TxPlan::Succeed {
            total: T,
            chunk: T,
            pause_ms: 1,
        },
        TxPlan::Succeed {
            total: T,
            chunk: T,
            pause_ms: 1,
        },
        LinkPlan::Committed,
    );
    register(&m, h);
    let d = std::env::temp_dir().join(format!("r35-dir-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    let t = m
        .upload(&Actor::Human, "s-r35".into(), &d, "/root/dir.bin", None)
        .await
        .unwrap();
    let done = wait_terminal(&m, &t.id).await;
    assert_eq!(done.status, TransferStatus::Failed);
    assert!(
        done.error
            .as_deref()
            .unwrap_or_default()
            .contains("目录传输不支持"),
        "{:?}",
        done.error
    );
    assert_eq!(done.bytes_done, 0, "目录拒绝不产生字节");
    // 零 staging：目标目录无 temp 残留
    assert!(c.get("/root/dir.bin").is_none());
}

/// 目录明确不支持（下载侧）：远端源 stat 报 is_dir → Failed + 明确文案。
#[tokio::test]
async fn r35_directory_download_rejected() {
    let m = mgr();
    let (h, c) = mk_sess(
        m.center.clone(),
        "s-r35",
        TxPlan::Succeed {
            total: T,
            chunk: T,
            pause_ms: 1,
        },
        TxPlan::Succeed {
            total: T,
            chunk: T,
            pause_ms: 1,
        },
        LinkPlan::Committed,
    );
    register(&m, h);
    c.dir("/remote/adir");
    let dst = std::env::temp_dir().join(format!("r35-dl-{}", uuid::Uuid::new_v4()));
    let t = m
        .download(&Actor::Human, "s-r35".into(), "/remote/adir", &dst, None)
        .await
        .unwrap();
    let done = wait_terminal(&m, &t.id).await;
    assert_eq!(done.status, TransferStatus::Failed);
    assert!(
        done.error
            .as_deref()
            .unwrap_or_default()
            .contains("目录传输不支持"),
        "{:?}",
        done.error
    );
    assert_eq!(done.bytes_done, 0);
}
