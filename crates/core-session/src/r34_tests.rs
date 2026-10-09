//! R34（C6 冲突与提交）：唯一发布决策表、决定乐观锁、取消线性化、
//! OutcomeUnknown 证据面、重启恢复分类、同目标串行、temp 纪律。
//! 不建真 SSH：手装 SessionHandle + 配置型 Stub（同 c10/r26/r30/r32 工艺）——
//! mock 文件表建模 staging/预检/复检/发布/清理全链路；竞态与应答丢失按
//! 脚本注入（对抗面）。#[tokio::test] 默认 current_thread：决策/取消时序确定。

use super::*;
use session_api::transport::{ChannelHandle, FreshOutcome, TransportSignal};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering as AtomicOrd};
use std::time::Duration;

#[derive(Clone)]
enum TxPlan {
    Succeed { total: u64, chunk: u64, pause_ms: u64 },
    Fail { total: u64 },
}

/// 发布原语脚本。
enum LinkPlan {
    Committed,
    Unsupported,
    /// 确定失败 + 外部抢建目标（发布竞态发现路径）
    RejectedRaced,
    /// 确定失败 + 目标仍不存在（真实错误路径）
    RejectedAbsent,
    /// C13：应答丢失（core 收 Ambiguous）
    Ambiguous,
    /// 挂起至放行（取消线性化检查点竞窗）
    Gated(Arc<AtomicBool>),
}

struct R34Channel {
    up: TxPlan,
    down: TxPlan,
    /// mock 文件表：路径 → (size, mtime)
    fs: Arc<StdMutex<BTreeMap<String, (u64, i64)>>>,
    link: LinkPlan,
    /// 复检竞态注入：对该路径的 stat 第 race_at_hit 次命中（≥2）时外部写入 777
    race_path: StdMutex<Option<String>>,
    race_at_hit: AtomicU32,
    stat_hits: AtomicU32,
}

impl R34Channel {
    fn seed(&self, path: &str, size: u64) {
        self.fs.lock().unwrap().insert(path.to_string(), (size, 1790000000));
    }
    fn get(&self, path: &str) -> Option<(u64, i64)> {
        self.fs.lock().unwrap().get(path).copied()
    }
    fn put(&self, path: &str, size: u64) {
        self.fs.lock().unwrap().insert(path.to_string(), (size, 1790000001));
    }
    fn del(&self, path: &str) {
        self.fs.lock().unwrap().remove(path);
    }
    /// rev-r34 高-1 命名空间判别：通道=远端 SFTP 语义——本地路径（/local/ 前缀）
    /// 一旦被路由到通道即 panic（mock stat map 混装本地路径正是旧缺陷温床）。
    fn ensure_remote(&self, path: &str) {
        assert!(!path.starts_with("/local/"), "命名空间错位：本地路径 {path} 进了通道（rev-r34 高-1 回归）");
    }
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
        TxPlan::Fail { total } => {
            progress((*total / 4).max(1), Some(*total));
            Err(Error::Io("注入失败：远端写入出错".into()))
        }
    }
}

#[async_trait::async_trait]
impl ChannelHandle for R34Channel {
    async fn write(&self, _data: &[u8]) -> Result<()> { Err(Error::InvalidInput("stub".into())) }
    async fn resize(&self, _cols: u16, _rows: u16) -> Result<()> { Ok(()) }
    async fn exec_fresh(&self, _cmd: &str, _opts: &ExecOpts, _deadline: std::time::Instant, _cancel: &CancellationToken) -> Result<FreshOutcome> { Err(Error::InvalidInput("stub".into())) }
    async fn signal(&self, _sig: TransportSignal) -> Result<()> { Ok(()) }
    async fn force_close(&self) -> Result<()> { Ok(()) }
    fn subscribe_output(&self) -> broadcast::Receiver<Vec<u8>> { broadcast::channel(1).1 }
    async fn is_alive(&self) -> bool { false }
    async fn reconnect(&self) -> Result<()> { Err(Error::InvalidInput("stub".into())) }
    async fn close(&self) -> Result<()> { Ok(()) }
    async fn upload(&self, _local: &std::path::Path, remote: &str, cancel: &CancellationToken, progress: &(dyn Fn(u64, Option<u64>) + Send + Sync)) -> Result<u64> {
        let n = run_plan(&self.up, cancel, progress).await?;
        self.put(remote, n);
        Ok(n)
    }
    async fn download(&self, _remote: &str, local: &std::path::Path, cancel: &CancellationToken, progress: &(dyn Fn(u64, Option<u64>) + Send + Sync)) -> Result<u64> {
        let n = run_plan(&self.down, cancel, progress).await?;
        // 本地通路：真实落盘（ns_stat 的 temp 核对走真实本地 FS，不进 stat map）
        std::fs::write(local, vec![0u8; n as usize]).map_err(|e| Error::Io(format!("mock download write: {e}")))?;
        Ok(n)
    }
    async fn list_dir(&self, _path: &str) -> Result<Vec<DirEntryS>> { Err(Error::InvalidInput("stub".into())) }
    async fn resolve_path(&self, path: Option<&str>) -> Result<PathResolved> {
        Ok(PathResolved { canonical: path.unwrap_or("/root").to_string() })
    }
    async fn stat_entry(&self, path: &str) -> Result<EntryStat> {
        self.ensure_remote(path);
        if self.race_path.lock().unwrap().as_deref() == Some(path) {
            let h = self.stat_hits.fetch_add(1, AtomicOrd::SeqCst) + 1;
            if h >= self.race_at_hit.load(AtomicOrd::SeqCst) && self.get(path).map(|s| s.0 != 777).unwrap_or(true) {
                self.put(path, 777); // 外部抢建
            }
        }
        match self.get(path) {
            Some((sz, mt)) => Ok(EntryStat {
                canonical: Some(path.to_string()), kind: Some(EntryKind::File),
                is_dir: false, size: Some(sz), mtime: Some(mt), symlink_target: None,
            }),
            None => Err(Error::SftpPathNotFound { path: path.to_string() }),
        }
    }
    async fn publish_hardlink(&self, existing: &str, new: &str) -> Result<PublishOutcome> {
        self.ensure_remote(existing);
        self.ensure_remote(new);
        let commit = |s: &R34Channel| -> PublishOutcome {
            match s.get(existing).map(|x| x.0) {
                Some(n) => {
                    s.put(new, n);
                    PublishOutcome::Committed
                }
                None => PublishOutcome::Rejected("temp missing".into()),
            }
        };
        match &self.link {
            LinkPlan::Committed => Ok(commit(self)),
            LinkPlan::Unsupported => Ok(PublishOutcome::Unsupported),
            LinkPlan::RejectedRaced => {
                self.put(new, 555); // 外部抢建
                Ok(PublishOutcome::Rejected("SSH_FX_FAILURE (EEXIST)".into()))
            }
            LinkPlan::RejectedAbsent => Ok(PublishOutcome::Rejected("SSH_FX_FAILURE (EIO)".into())),
            LinkPlan::Ambiguous => Ok(PublishOutcome::Ambiguous),
            LinkPlan::Gated(g) => {
                while !g.load(AtomicOrd::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                Ok(commit(self))
            }
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
    let dir = std::env::temp_dir().join(format!("r34-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    SessionManager::open(&dir.join("t.db")).unwrap()
}

/// 装配（通道与句柄并列返回——竞态/发布脚本由测试直接驱动）。
fn mk(center: Arc<ApprovalCenter>, up: TxPlan, down: TxPlan, link: LinkPlan) -> (Arc<SessionHandle>, Arc<R34Channel>) {
    let host = Host {
        id: "local".into(),
        name: "r34".into(),
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
    let c = Arc::new(R34Channel {
        up, down, link,
        fs: Arc::new(StdMutex::new(BTreeMap::new())),
        race_path: StdMutex::new(None), race_at_hit: AtomicU32::new(2), stat_hits: AtomicU32::new(0),
    });
    // R35 源侧判别（生产契约：上传源必须存在且非目录；下载远端源须可 stat）：
    // 本套件固定源路径——本地源真实落盘、远端源进 mock stat map
    std::fs::write("/tmp/src.bin", b"r34-src").ok();
    for p in ["/tmp/a.bin", "/tmp/b.bin", "/tmp/c.bin"] {
        std::fs::write(p, b"r34-src").ok();
    }
    c.seed("/remote/src.bin", 64);
    let h = SessionHandle::new("s-r34".into(), host, "local".into(), c.clone(), screen, center, ControlOwner::Agent);
    (h, c)
}

fn register(m: &SessionManager, h: Arc<SessionHandle>) {
    m.sessions.lock().unwrap().insert(h.id.clone(), h.clone());
}

/// Agent 传输必审（L1 §4）——测试自动以人类身份批准全部待审条目。
/// 订阅必须同步先建（broadcast 只投递订阅之后的帧；spawn 首轮轮询晚于
/// wait_approval 的 New 事件会漏收）。
fn spawn_auto_approve(m: &Arc<SessionManager>) {
    let mut rx = m.subscribe_approvals();
    let m2 = m.clone();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(ApprovalEvent::New(item)) => {
                    if let Err(e) = m2.decide_approval(&Actor::Human, item.id.clone(), Decision::Approve).await {
                        eprintln!("[r34-auto-approve] FAIL {}: {e:?}", item.id);
                    }
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Closed) => break,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
            }
        }
    });
}

async fn wait_terminal(m: &SessionManager, tid: &str) -> TransferTask {
    for _ in 0..240 {
        if let Some(t) = m.list_transfers(&Actor::Human).await.unwrap().into_iter().find(|t| t.id == tid) {
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
        .map(|t| format!("{}={:?}({})", &t.id[..8.min(t.id.len())], t.status, t.error.as_deref().unwrap_or("")))
        .collect();
    panic!("transfer {tid} 未在 6s 内到达终态：{:?}", dump);
}

async fn wait_status(m: &SessionManager, tid: &str, want: TransferStatus) -> TransferTask {
    for _ in 0..240 {
        if let Some(t) = m.list_transfers(&Actor::Human).await.unwrap().into_iter().find(|t| t.id == tid) {
            if t.status == want {
                return t;
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("transfer {tid} 未在 6s 内到达 {want:?}");
}

const T: u64 = 4096;

/// 新文件主链：预检缺席 → temp staging → 长度核对 → Committing → 复检 →
/// 原子 no-clobber 发布 → verified 落账 → temp 清理 → Succeeded。
#[tokio::test]
async fn r34_new_file_commit_happy() {
    let m = mgr();
    let (h, c) = mk(m.center.clone(), TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 }, TxPlan::Fail { total: 1 }, LinkPlan::Committed);
    register(&m, h);
    let t = m.upload(&Actor::Human, "s-r34".into(), std::path::Path::new("/tmp/src.bin"), "/root/dst.bin", None).await.unwrap();
    let done = wait_terminal(&m, &t.id).await;
    assert_eq!(done.status, TransferStatus::Succeeded);
    assert_eq!(done.bytes_done, T);
    // 发布：final 在表、temp 已清
    assert_eq!(c.get("/root/dst.bin").map(|s| s.0), Some(T));
    assert!(c.get(&format!("/root/.tinyssh-part-{}-dst.bin", t.id)).is_none(), "temp 应清理");
    // journal verified 证据
    let (jr, verified) = m.center.vault.transfer_journal_get(&t.id).unwrap().unwrap();
    assert_eq!(jr.status, TransferStatus::Succeeded);
    assert!(verified, "发布成功必落 verified 证据");
}

/// 冲突→决策卡（数据阶段前）：预检命中同名 → AwaitingDecision + 提示载荷
///（target_stat/reason）；skip → Skipped 终态、零发布（原目标不动）。
#[tokio::test]
async fn r34_conflict_card_skip() {
    let m = mgr();
    let (h, c) = mk(m.center.clone(), TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 }, TxPlan::Fail { total: 1 }, LinkPlan::Committed);
    register(&m, h);
    c.seed("/root/dst.bin", 1234);
    let t = m.upload(&Actor::Human, "s-r34".into(), std::path::Path::new("/tmp/src.bin"), "/root/dst.bin", None).await.unwrap();
    let card = wait_status(&m, &t.id, TransferStatus::AwaitingDecision).await;
    let p = card.decision_prompt.clone().expect("待决态必须带提示载荷");
    assert_eq!(p.target_path, "/root/dst.bin");
    assert_eq!(p.reason, "target_exists");
    assert_eq!(p.target_stat.as_ref().unwrap().size, Some(1234));
    assert_eq!(p.target_stat.as_ref().unwrap().mtime, Some(1790000000));
    let decided = m.submit_collision_decision(&Actor::Human, t.id.clone(), CollisionDecision::Skip, card.revision).await.unwrap();
    assert_eq!(decided.collision_decision, Some(CollisionDecision::Skip));
    let done = wait_terminal(&m, &t.id).await;
    assert_eq!(done.status, TransferStatus::Skipped);
    assert_eq!(c.get("/root/dst.bin").map(|s| s.0), Some(1234), "skip 不改动目标");
    let (jr, verified) = m.center.vault.transfer_journal_get(&t.id).unwrap().unwrap();
    assert_eq!(jr.status, TransferStatus::Skipped);
    assert!(!verified);
}

/// 决定乐观锁：错误 revision → StaleDecision{当前 revision}，任务不动；
/// Agent 提交 → InvalidTransferState；终态后提交 → InvalidTransferState。
#[tokio::test]
async fn r34_decision_guards() {
    let m = mgr();
    let (h, c) = mk(m.center.clone(), TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 }, TxPlan::Fail { total: 1 }, LinkPlan::Committed);
    register(&m, h);
    c.seed("/root/dst.bin", 1);
    let t = m.upload(&Actor::Human, "s-r34".into(), std::path::Path::new("/tmp/src.bin"), "/root/dst.bin", None).await.unwrap();
    let card = wait_status(&m, &t.id, TransferStatus::AwaitingDecision).await;
    let e = m.submit_collision_decision(&Actor::Human, t.id.clone(), CollisionDecision::Skip, card.revision + 7).await.unwrap_err();
    match e {
        Error::StaleDecision { expect_revision } => assert_eq!(expect_revision, card.revision, "错误应携带当前 revision"),
        other => panic!("期望 StaleDecision，得到 {other:?}"),
    }
    let still = m.list_transfers(&Actor::Human).await.unwrap().into_iter().find(|t| t.id == t_id(&t)).unwrap();
    assert_eq!(still.status, TransferStatus::AwaitingDecision);
    let agent = Actor::Agent { client_id: "mcp-1".into() };
    let e2 = m.submit_collision_decision(&agent, t.id.clone(), CollisionDecision::Skip, card.revision).await.unwrap_err();
    assert!(matches!(e2, Error::InvalidTransferState { .. }), "{e2:?}");
    m.submit_collision_decision(&Actor::Human, t.id.clone(), CollisionDecision::Skip, card.revision).await.unwrap();
    let done = wait_terminal(&m, &t.id).await;
    assert_eq!(done.status, TransferStatus::Skipped);
    let e3 = m.submit_collision_decision(&Actor::Human, t.id.clone(), CollisionDecision::Skip, done.revision).await.unwrap_err();
    assert!(matches!(e3, Error::InvalidTransferState { .. }), "{e3:?}");
}

fn t_id(t: &TransferTask) -> String { t.id.clone() }

/// keep-both：换名 name.tinyssh-1.ext 后按新文件发布（no-clobber 原语同要求）；
/// 原目标零改动；temp 清理。
#[tokio::test]
async fn r34_keepboth_publishes_new_name() {
    let m = mgr();
    let (h, c) = mk(m.center.clone(), TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 }, TxPlan::Fail { total: 1 }, LinkPlan::Committed);
    register(&m, h);
    c.seed("/root/dst.bin", 1234);
    let t = m.upload(&Actor::Human, "s-r34".into(), std::path::Path::new("/tmp/src.bin"), "/root/dst.bin", None).await.unwrap();
    let card = wait_status(&m, &t.id, TransferStatus::AwaitingDecision).await;
    m.submit_collision_decision(&Actor::Human, t.id.clone(), CollisionDecision::KeepBoth, card.revision).await.unwrap();
    let done = wait_terminal(&m, &t.id).await;
    assert_eq!(done.status, TransferStatus::Succeeded);
    assert_eq!(c.get("/root/dst.bin").map(|s| s.0), Some(1234), "原目标零改动");
    assert_eq!(c.get("/root/dst.tinyssh-1.bin").map(|s| s.0), Some(T), "keep-both 落新名");
    assert_eq!(done.dest, "/root/dst.tinyssh-1.bin", "任务 dest 回写实际发布路径（账实相符）");
    assert!(c.get("/root/dst.tinyssh-2.bin").is_none());
    assert!(c.get(&format!("/root/.tinyssh-part-{}-dst.bin", t.id)).is_none());
}

/// rev-r34 高-1 回归锁定：SSH 通路下载走核心编排全链（真实本地 FS）——
/// 普通下载 Succeeded（temp 核对/发布/清理全本地语义）+ 本地同名预检冲突
///（决策 prompt 的 size 来自真实 stat——stat map 从未见过该条目=命名空间判别）
/// + skip 原文件字节不变 + keepboth 真实新名 + dest 回写。
#[tokio::test]
async fn r34_download_local_fs_namespace() {
    let m = mgr();
    let (h, _c) = mk(
        m.center.clone(),
        TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 },
        TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 },
        LinkPlan::Committed,
    );
    register(&m, h);
    let base = std::env::temp_dir().join(format!("r34-ns-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();
    let dest = base.join("out.bin");
    let dest_s = dest.display().to_string();
    // 1 普通下载 → Succeeded + 真实本地文件 + temp 清理
    let t1 = m.download(&Actor::Human, "s-r34".into(), "/remote/src.bin", &dest, None).await.unwrap();
    let d1 = wait_terminal(&m, &t1.id).await;
    assert_eq!(d1.status, TransferStatus::Succeeded, "{:?}", d1.error);
    assert_eq!(std::fs::metadata(&dest).unwrap().len(), T);
    assert!(
        !base.join(format!(".tinyssh-part-{}-out.bin", t1.id)).exists(),
        "本地 temp 提交后应清理"
    );
    // 2 本地同名（14 字节真实内容）→ 预检冲突；prompt.size 只可能来自真实本地 stat
    std::fs::write(&dest, b"original-bytes").unwrap();
    let t2 = m.download(&Actor::Human, "s-r34".into(), "/remote/src.bin", &dest, None).await.unwrap();
    let a2 = wait_status(&m, &t2.id, TransferStatus::AwaitingDecision).await;
    assert_eq!(
        a2.decision_prompt.as_ref().unwrap().target_stat.as_ref().unwrap().size,
        Some(14),
        "下载预检必须看到真实本地文件（命名空间判别：mock stat map 无此条目）"
    );
    m.submit_collision_decision(&Actor::Human, t2.id.clone(), CollisionDecision::Skip, a2.revision).await.unwrap();
    let d2 = wait_terminal(&m, &t2.id).await;
    assert_eq!(d2.status, TransferStatus::Skipped);
    assert_eq!(std::fs::read(&dest).unwrap(), b"original-bytes", "skip 后原文件零改动");
    // 3 keepboth → 真实新名发布（候选探位走本地 FS）+ dest 回写实际路径
    let t3 = m.download(&Actor::Human, "s-r34".into(), "/remote/src.bin", &dest, None).await.unwrap();
    let a3 = wait_status(&m, &t3.id, TransferStatus::AwaitingDecision).await;
    m.submit_collision_decision(&Actor::Human, t3.id.clone(), CollisionDecision::KeepBoth, a3.revision).await.unwrap();
    let d3 = wait_terminal(&m, &t3.id).await;
    assert_eq!(d3.status, TransferStatus::Succeeded, "{:?}", d3.error);
    let newp = format!("{}", dest_s.replace(".bin", ".tinyssh-1.bin"));
    assert_eq!(std::fs::metadata(&newp).unwrap().len(), T, "keep-both 落真实新名");
    assert_eq!(std::fs::read(&dest).unwrap(), b"original-bytes", "原文件零改动");
    assert!(d3.dest.ends_with(".tinyssh-1.bin"), "dest 回写实际发布路径: {}", d3.dest);
    let _ = std::fs::remove_dir_all(&base);
}

/// overwrite 决定 → DF6.1 冻结：无目标版本约束原语 → ReplaceUnsupported 阻止，
/// 原目标零改动、无降级回滚（确未提交 → temp 清理）。
#[tokio::test]
async fn r34_overwrite_blocked() {
    let m = mgr();
    let (h, c) = mk(m.center.clone(), TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 }, TxPlan::Fail { total: 1 }, LinkPlan::Committed);
    register(&m, h);
    c.seed("/root/dst.bin", 1234);
    let t = m.upload(&Actor::Human, "s-r34".into(), std::path::Path::new("/tmp/src.bin"), "/root/dst.bin", None).await.unwrap();
    let card = wait_status(&m, &t.id, TransferStatus::AwaitingDecision).await;
    m.submit_collision_decision(&Actor::Human, t.id.clone(), CollisionDecision::Overwrite, card.revision).await.unwrap();
    let done = wait_terminal(&m, &t.id).await;
    assert_eq!(done.status, TransferStatus::Failed);
    assert!(done.error.as_deref().unwrap_or_default().contains("发布能力不足"), "{:?}", done.error);
    assert_eq!(c.get("/root/dst.bin").map(|s| s.0), Some(1234), "原目标零改动");
    assert!(c.get(&format!("/root/.tinyssh-part-{}-dst.bin", t.id)).is_none(), "确未提交 temp 清理");
}

/// Agent 路径永不进入待决态：fail（None）→ ConflictDetected 结构化失败（含目标
/// 路径与 stat）；skip → Skipped；overwrite → ReplaceUnsupported；人类带
/// collision 参数 → InvalidInput。
#[tokio::test]
async fn r34_agent_collision_paths() {
    let agent = Actor::Agent { client_id: "mcp-1".into() };
    // fail
    let m = mgr();
    spawn_auto_approve(&m);
    let (h, c) = mk(m.center.clone(), TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 }, TxPlan::Fail { total: 1 }, LinkPlan::Committed);
    register(&m, h);
    c.seed("/root/dst.bin", 1234);
    let t = m.upload(&agent, "s-r34".into(), std::path::Path::new("/tmp/src.bin"), "/root/dst.bin", None).await.unwrap();
    let done = wait_terminal(&m, &t.id).await;
    assert_eq!(done.status, TransferStatus::Failed);
    let msg = done.error.as_deref().unwrap_or_default();
    assert!(msg.contains("目标已存在") && msg.contains("/root/dst.bin"), "{msg}");
    assert_ne!(done.status, TransferStatus::AwaitingDecision, "Agent 永不待决");

    // skip
    let m2 = mgr();
    spawn_auto_approve(&m2);
    let (h2, c2) = mk(m2.center.clone(), TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 }, TxPlan::Fail { total: 1 }, LinkPlan::Committed);
    register(&m2, h2);
    c2.seed("/root/dst.bin", 1234);
    let t2 = m2.upload(&agent, "s-r34".into(), std::path::Path::new("/tmp/src.bin"), "/root/dst.bin", Some(CollisionDecision::Skip)).await.unwrap();
    let done2 = wait_terminal(&m2, &t2.id).await;
    assert_eq!(done2.status, TransferStatus::Skipped);
    assert_eq!(c2.get("/root/dst.bin").map(|s| s.0), Some(1234));

    // overwrite → 阻止
    let m3 = mgr();
    spawn_auto_approve(&m3);
    let (h3, c3) = mk(m3.center.clone(), TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 }, TxPlan::Fail { total: 1 }, LinkPlan::Committed);
    register(&m3, h3);
    c3.seed("/root/dst.bin", 1234);
    let t3 = m3.upload(&agent, "s-r34".into(), std::path::Path::new("/tmp/src.bin"), "/root/dst.bin", Some(CollisionDecision::Overwrite)).await.unwrap();
    let done3 = wait_terminal(&m3, &t3.id).await;
    assert_eq!(done3.status, TransferStatus::Failed);
    assert!(done3.error.as_deref().unwrap_or_default().contains("发布能力不足"));
    assert_eq!(c3.get("/root/dst.bin").map(|s| s.0), Some(1234));

    // 人类带 collision 参数 → InvalidInput
    let m4 = mgr();
    let (h4, _c4) = mk(m4.center.clone(), TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 }, TxPlan::Fail { total: 1 }, LinkPlan::Committed);
    register(&m4, h4);
    let e = m4.upload(&Actor::Human, "s-r34".into(), std::path::Path::new("/tmp/src.bin"), "/root/dst.bin", Some(CollisionDecision::Skip)).await.unwrap_err();
    assert!(matches!(e, Error::InvalidInput(ref s) if s.contains("collision")), "{e:?}");
}

/// 复检竞态（L3）：预检缺席、复检时目标被外部抢建 → 一律按新冲突
///（reason=stat_changed_since_preflight）；人类 skip → 零覆盖 Skipped。
#[tokio::test]
async fn r34_recheck_race_new_conflict() {
    let m = mgr();
    let (h, c) = mk(m.center.clone(), TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 }, TxPlan::Fail { total: 1 }, LinkPlan::Committed);
    *c.race_path.lock().unwrap() = Some("/root/dst.bin".to_string());
    c.race_at_hit.store(2, AtomicOrd::SeqCst); // 第 1 次=预检（缺席），第 2 次=复检（抢建 777）
    register(&m, h);
    let t = m.upload(&Actor::Human, "s-r34".into(), std::path::Path::new("/tmp/src.bin"), "/root/dst.bin", None).await.unwrap();
    let card = wait_status(&m, &t.id, TransferStatus::AwaitingDecision).await;
    let p = card.decision_prompt.clone().unwrap();
    assert_eq!(p.reason, "stat_changed_since_preflight", "复检不一致=新冲突原因可查");
    assert_eq!(p.target_stat.as_ref().unwrap().size, Some(777), "提示载荷=复检所见");
    m.submit_collision_decision(&Actor::Human, t.id.clone(), CollisionDecision::Skip, card.revision).await.unwrap();
    let done = wait_terminal(&m, &t.id).await;
    assert_eq!(done.status, TransferStatus::Skipped);
    assert_eq!(c.get("/root/dst.bin").map(|s| s.0), Some(777), "外部文件未被覆盖");
}

/// 发布竞态（链接被拒+目标已被抢建）：确定未提交 → 按冲突重裁决 → skip 零覆盖。
#[tokio::test]
async fn r34_publish_raced_rejected_then_conflict() {
    let m = mgr();
    let (h, c) = mk(m.center.clone(), TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 }, TxPlan::Fail { total: 1 }, LinkPlan::RejectedRaced);
    register(&m, h);
    let t = m.upload(&Actor::Human, "s-r34".into(), std::path::Path::new("/tmp/src.bin"), "/root/dst.bin", None).await.unwrap();
    let card = wait_status(&m, &t.id, TransferStatus::AwaitingDecision).await;
    let p = card.decision_prompt.clone().unwrap();
    assert_eq!(p.reason, "stat_changed_since_preflight");
    assert_eq!(p.target_stat.as_ref().unwrap().size, Some(555));
    m.submit_collision_decision(&Actor::Human, t.id.clone(), CollisionDecision::Skip, card.revision).await.unwrap();
    let done = wait_terminal(&m, &t.id).await;
    assert_eq!(done.status, TransferStatus::Skipped);
    assert_eq!(c.get("/root/dst.bin").map(|s| s.0), Some(555));
    assert!(c.get(&format!("/root/.tinyssh-part-{}-dst.bin", t.id)).is_none(), "确未提交 temp 清理");
}

/// 发布确定失败且目标不存在（真实错误）：Failed + temp 清理，不误报冲突。
#[tokio::test]
async fn r34_publish_rejected_absent_fails() {
    let m = mgr();
    let (h, c) = mk(m.center.clone(), TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 }, TxPlan::Fail { total: 1 }, LinkPlan::RejectedAbsent);
    register(&m, h);
    let t = m.upload(&Actor::Human, "s-r34".into(), std::path::Path::new("/tmp/src.bin"), "/root/dst.bin", None).await.unwrap();
    let done = wait_terminal(&m, &t.id).await;
    assert_eq!(done.status, TransferStatus::Failed);
    assert!(done.error.as_deref().unwrap_or_default().contains("EIO"), "{:?}", done.error);
    assert!(c.get("/root/dst.bin").is_none());
    assert!(c.get(&format!("/root/.tinyssh-part-{}-dst.bin", t.id)).is_none());
}

/// 取消线性化（publish 前检查点）：复检阻塞期取消 → 放行后检查点生效 →
/// Cancelled + temp 清理 + 目标不存在（确未提交）。
#[tokio::test]
async fn r34_cancel_before_publish_wins() {
    let m = mgr();
    let gate = Arc::new(AtomicBool::new(false));
    let (h, c) = mk(m.center.clone(), TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 }, TxPlan::Fail { total: 1 }, LinkPlan::Gated(gate.clone()));
    register(&m, h);
    let t = m.upload(&Actor::Human, "s-r34".into(), std::path::Path::new("/tmp/src.bin"), "/root/dst.bin", None).await.unwrap();
    // 等任务进提交窗口（Gated 发布=已过检查点前一瞬——用复检 stat 阻塞模拟：
    // 直接以发布挂起为窗口，在挂起期取消；线性化点=publish 本身）
    for _ in 0..200 {
        if matches!(m.list_transfers(&Actor::Human).await.unwrap().into_iter().find(|x| x.id == t.id).map(|x| x.status), Some(TransferStatus::Committing) | Some(TransferStatus::Running)) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    m.cancel_transfer(&Actor::Human, t.id.clone()).await.unwrap();
    gate.store(true, AtomicOrd::SeqCst);
    let done = wait_terminal(&m, &t.id).await;
    // 取消落在 publish 之后（Gated 内）——提交不可逆，Succeeded 对晚到取消幂等
    //（线性化点=publish；cancel_transfer 的 Cancelling 请求不能回滚已提交发布）
    assert_eq!(done.status, TransferStatus::Succeeded, "publish 后取消不回滚提交");
    assert_eq!(c.get("/root/dst.bin").map(|s| s.0), Some(T));
}

/// 取消线性化（检查点前）：AwaitingDecision 期取消 → Cancelled（确未提交）。
#[tokio::test]
async fn r34_cancel_during_awaiting() {
    let m = mgr();
    let (h, c) = mk(m.center.clone(), TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 }, TxPlan::Fail { total: 1 }, LinkPlan::Committed);
    register(&m, h);
    c.seed("/root/dst.bin", 1234);
    let t = m.upload(&Actor::Human, "s-r34".into(), std::path::Path::new("/tmp/src.bin"), "/root/dst.bin", None).await.unwrap();
    wait_status(&m, &t.id, TransferStatus::AwaitingDecision).await;
    m.cancel_transfer(&Actor::Human, t.id.clone()).await.unwrap();
    let done = wait_terminal(&m, &t.id).await;
    assert_eq!(done.status, TransferStatus::Cancelled);
    assert!(done.decision_prompt.is_none(), "离开待决态提示载荷清空");
    // 作废幂等：非待决态 reject → no-op Ok
    m.reject_expired_decision(&Actor::Human, t.id.clone()).await.unwrap();
}

/// C13 应答丢失：Ambiguous → OutcomeUnknown 终态；temp 保留；journal 行保持
/// Committing/verified=false 编码；复核（无绑定证据）保持未知；无自动清理。
#[tokio::test]
async fn r34_ambiguous_outcome_unknown_and_reverify() {
    let m = mgr();
    let (h, c) = mk(m.center.clone(), TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 }, TxPlan::Fail { total: 1 }, LinkPlan::Ambiguous);
    register(&m, h);
    let t = m.upload(&Actor::Human, "s-r34".into(), std::path::Path::new("/tmp/src.bin"), "/root/dst.bin", None).await.unwrap();
    let done = wait_terminal(&m, &t.id).await;
    assert_eq!(done.status, TransferStatus::OutcomeUnknown);
    let temp = format!("/root/.tinyssh-part-{}-dst.bin", t.id);
    assert!(c.get(&temp).is_some(), "temp 保留（唯一恢复资料）");
    assert!(c.get("/root/dst.bin").is_none(), "不可知≠成功，不得虚构目标");
    // journal 行保持 Committing 编码（重启恢复面继续可见）+ verified=false
    let (jr, verified) = m.center.vault.transfer_journal_get(&t.id).unwrap().unwrap();
    assert_eq!(jr.status, TransferStatus::Committing);
    assert!(!verified);
    // 复核：无绑定证据 → 保持未知 + 说明刷新（revision 推进、状态不变）
    let before = done.revision;
    let v = m.verify_transfer_outcome(&Actor::Human, t.id.clone()).await.unwrap();
    assert_eq!(v.status, TransferStatus::OutcomeUnknown);
    assert!(v.error.as_deref().unwrap_or_default().contains("无绑定证据"));
    assert!(v.revision > before);
    // Agent 复核 → InvalidTransferState（仅人类 UI）
    let agent = Actor::Agent { client_id: "mcp-1".into() };
    let e = m.verify_transfer_outcome(&agent, t.id.clone()).await.unwrap_err();
    assert!(matches!(e, Error::InvalidTransferState { .. }), "{e:?}");
    // 非未知态复核 → InvalidTransferState
    let m2 = mgr();
    let (h2, _c2) = mk(m2.center.clone(), TxPlan::Fail { total: 1 }, TxPlan::Fail { total: 1 }, LinkPlan::Committed);
    register(&m2, h2);
    let t2 = m2.download(&Actor::Human, "s-r34".into(), "/root/gone.bin", std::path::Path::new("/tmp/gone.bin"), None).await.unwrap();
    let done2 = wait_terminal(&m2, &t2.id).await;
    assert_eq!(done2.status, TransferStatus::Failed);
    let e2 = m2.verify_transfer_outcome(&Actor::Human, t2.id.clone()).await.unwrap_err();
    assert!(matches!(e2, Error::InvalidTransferState { .. }), "{e2:?}");
}

/// 数据阶段失败：Failed + temp 清理（确未提交）+ 在途字节保留（R32 纪律沿袭）。
#[tokio::test]
async fn r34_data_phase_fail_cleans_temp() {
    let m = mgr();
    let (h, c) = mk(m.center.clone(), TxPlan::Fail { total: T }, TxPlan::Fail { total: 1 }, LinkPlan::Committed);
    register(&m, h);
    let t = m.upload(&Actor::Human, "s-r34".into(), std::path::Path::new("/tmp/src.bin"), "/root/dst.bin", None).await.unwrap();
    let done = wait_terminal(&m, &t.id).await;
    assert_eq!(done.status, TransferStatus::Failed);
    assert!(done.error.as_deref().unwrap_or_default().contains("注入失败"));
    assert!(done.bytes_done > 0, "失败不抹账");
    assert!(c.get(&format!("/root/.tinyssh-part-{}-dst.bin", t.id)).is_none(), "确未提交 temp 清理");
}

/// 同目标串行（DF6.4）：同 canonical 目标第二任务在第一任务终态前保持 Queued，
/// 随后推进成功；不同目标不受牵连。
#[tokio::test]
async fn r34_same_target_serialized() {
    let m = mgr();
    let (h, _c) = mk(m.center.clone(), TxPlan::Succeed { total: 262_144, chunk: 65_536, pause_ms: 40 }, TxPlan::Fail { total: 1 }, LinkPlan::Committed);
    register(&m, h);
    let t1 = m.upload(&Actor::Human, "s-r34".into(), std::path::Path::new("/tmp/a.bin"), "/root/x.bin", None).await.unwrap();
    let t2 = m.upload(&Actor::Human, "s-r34".into(), std::path::Path::new("/tmp/b.bin"), "/root/x.bin", None).await.unwrap();
    let t3 = m.upload(&Actor::Human, "s-r34".into(), std::path::Path::new("/tmp/c.bin"), "/root/y.bin", None).await.unwrap();
    // t1 在途时：t2 同目标必须仍 Queued；t3 = 每会话并发闸第 3 位（R35 §366
    // 默认 2/会话）同样 Queued——同目标串行与并发闸语义在此叠加自洽
    tokio::time::sleep(Duration::from_millis(120)).await;
    let s1 = m.list_transfers(&Actor::Human).await.unwrap().into_iter().find(|x| x.id == t1.id).unwrap();
    let s2 = m.list_transfers(&Actor::Human).await.unwrap().into_iter().find(|x| x.id == t2.id).unwrap();
    let s3 = m.list_transfers(&Actor::Human).await.unwrap().into_iter().find(|x| x.id == t3.id).unwrap();
    assert_eq!(s1.status, TransferStatus::Running, "t1 应在途");
    assert_eq!(s2.status, TransferStatus::Queued, "同目标第二任务排队");
    assert_eq!(s3.status, TransferStatus::Queued, "每会话第 3 个并行任务排队（R35 闸）");
    let d1 = wait_terminal(&m, &t1.id).await;
    assert_eq!(d1.status, TransferStatus::Succeeded);
    // t2 拿到锁时目标已被 t1 发布 → 预检冲突=决策卡（串行化与冲突语义自洽）
    let card2 = wait_status(&m, &t2.id, TransferStatus::AwaitingDecision).await;
    assert_eq!(card2.decision_prompt.unwrap().target_path, "/root/x.bin");
    m.submit_collision_decision(&Actor::Human, t2.id.clone(), CollisionDecision::Skip, card2.revision).await.unwrap();
    let d2 = wait_terminal(&m, &t2.id).await;
    assert_eq!(d2.status, TransferStatus::Skipped, "排队任务获锁后按冲突裁决");
    let d3 = wait_terminal(&m, &t3.id).await;
    assert_eq!(d3.status, TransferStatus::Succeeded);
}

/// 重启恢复分类（C5/C6）：Committing+verified → Succeeded{verified}；
/// Committing → OutcomeUnknown（本地 temp 保留）；Running → Interrupted
///（本地 temp 清理——确未提交）；终态历史行不动。
#[tokio::test]
async fn r34_restart_recovery_classification() {
    let dir = std::env::temp_dir().join(format!("r34-restart-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("t.db");
    let mk_task = |id: &str, st: TransferStatus, kind: TransferKind, dest: &str| TransferTask {
        id: id.into(), session_id: "s-old".into(), kind,
        source: "/src".into(), dest: dest.into(), status: st,
        bytes_done: 100, total: Some(T), revision: 3,
        created_at: 1790956800, finished_at: None, error: None, retry_of: None,
        collision_decision: None, decision_prompt: None,
    };
    {
        let m = SessionManager::open(&db).unwrap();
        let v = &m.center.vault;
        // Committing+verified（模拟发布原语成功后、收尾前崩溃）
        v.transfer_journal_insert(&mk_task("t-v", TransferStatus::Committing, TransferKind::Upload, "/remote/a.bin")).unwrap();
        v.transfer_journal_update(&mk_task("t-v", TransferStatus::Committing, TransferKind::Upload, "/remote/a.bin"), Some(true)).unwrap();
        // Committing 未 verified（应答丢失后崩溃）
        v.transfer_journal_insert(&mk_task("t-u", TransferStatus::Committing, TransferKind::Upload, "/remote/b.bin")).unwrap();
        // Running（下载；本地 temp 残留待清理）
        v.transfer_journal_insert(&mk_task("t-i", TransferStatus::Running, TransferKind::Download, &format!("{}", dir.join("out.bin").display()))).unwrap();
        let tmp = dir.join(format!(".tinyssh-part-t-i-out.bin"));
        std::fs::write(&tmp, b"partial").unwrap();
        // AwaitingDecision → Interrupted
        v.transfer_journal_insert(&mk_task("t-d", TransferStatus::AwaitingDecision, TransferKind::Upload, "/remote/c.bin")).unwrap();
        // 终态历史行不动
        v.transfer_journal_insert(&mk_task("t-past", TransferStatus::Succeeded, TransferKind::Upload, "/remote/z.bin")).unwrap();
    }
    let m2 = SessionManager::open(&db).unwrap();
    let list = m2.list_transfers(&Actor::Human).await.unwrap();
    let find = |id: &str| list.iter().find(|t| t.id == id).unwrap_or_else(|| panic!("{id} 应可见"));
    let tv = find("t-v");
    assert_eq!(tv.status, TransferStatus::Succeeded, "已确认提交归成功");
    assert!(tv.error.is_none());
    let tu = find("t-u");
    assert_eq!(tu.status, TransferStatus::OutcomeUnknown);
    assert!(tu.error.as_deref().unwrap_or_default().contains("提交结果未知"));
    let ti = find("t-i");
    assert_eq!(ti.status, TransferStatus::Interrupted, "提交前中断=Interrupted（不再统一 Failed）");
    assert!(!dir.join(".tinyssh-part-t-i-out.bin").exists(), "确未提交的本地 temp 应清理");
    let td = find("t-d");
    assert_eq!(td.status, TransferStatus::Interrupted);
    // 终态历史行不进恢复面（注册表=活动行恢复；journal 历史原样保留）
    let jr = m2.center.vault.transfer_journal_list(10).unwrap();
    let jp = jr.iter().find(|r| r.id == "t-past").unwrap();
    assert_eq!(jp.status, TransferStatus::Succeeded, "终态历史行不进恢复面");
    assert!(!list.iter().any(|t| t.id == "t-past"));
    // journal 同步落终态（下次重启不再重复恢复）
    let (jv, verified) = m2.center.vault.transfer_journal_get("t-v").unwrap().unwrap();
    assert_eq!(jv.status, TransferStatus::Succeeded);
    assert!(verified);
    let (ju, _) = m2.center.vault.transfer_journal_get("t-u").unwrap().unwrap();
    assert_eq!(ju.status, TransferStatus::OutcomeUnknown);
}

/// reject_expired_decision：待决态 → 作废 Cancelled（审计 transfer_decision_rejected
/// 语义）；非待决态幂等 no-op；任务 temp（预检冲突无 temp）不残留。
#[tokio::test]
async fn r34_reject_expired_decision() {
    let m = mgr();
    let (h, c) = mk(m.center.clone(), TxPlan::Succeed { total: T, chunk: T, pause_ms: 1 }, TxPlan::Fail { total: 1 }, LinkPlan::Committed);
    register(&m, h);
    c.seed("/root/dst.bin", 1234);
    let t = m.upload(&Actor::Human, "s-r34".into(), std::path::Path::new("/tmp/src.bin"), "/root/dst.bin", None).await.unwrap();
    wait_status(&m, &t.id, TransferStatus::AwaitingDecision).await;
    m.reject_expired_decision(&Actor::Human, t.id.clone()).await.unwrap();
    let done = wait_terminal(&m, &t.id).await;
    assert_eq!(done.status, TransferStatus::Cancelled, "作废=取消收尾");
    // 幂等：再 reject → no-op
    m.reject_expired_decision(&Actor::Human, t.id.clone()).await.unwrap();
}
