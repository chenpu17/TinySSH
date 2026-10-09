//! core-session：SessionApi 实现（L1 §2/§3.1）。
//! 双前端（GUI/MCP）唯一核心；审批在门面之后强制挂接（L0 ADR-5）。

mod brief;
mod charset;
mod fault;
mod handle;

pub use handle::{is_whitelisted, DecisionMsg, SessionHandle};

use session_api::transport::tokio_util_sync::CancellationToken;
use session_api::transport::ChannelHandle;
use session_api::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex as StdMutex};
use tinyssh_approval::ApprovalEngine;
use tokio::sync::{broadcast, oneshot};
use transport_pty::LocalPtyChannel;
use transport_ssh::SshChannel;

/// C5（R32）：Unix 秒（TransferTask.created_at/finished_at 口径）。
fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 审批中心：跨会话共享的引擎、条目表、决策通道、持久化。
pub struct ApprovalCenter {
    pub engine: ApprovalEngine,
    pub items: StdMutex<HashMap<ApprovalId, ApprovalItem>>,
    pub decisions: StdMutex<HashMap<ApprovalId, oneshot::Sender<DecisionMsg>>>,
    pub approvals_tx: broadcast::Sender<ApprovalEvent>,
    /// 转发状态事件（T44 真机冒烟补口）：SessionHandle 构造时把 transport 写口
    /// 回调桥到本通道——UI 事件驱动刷新（WKWebView 节流 timer 时盲轮询会挂起）。
    pub forwards_tx: broadcast::Sender<ForwardEvent>,
    /// 主机指纹待决（路线图⑤ TOFU）：pending 表 + 决策通道 + 事件推送。
    pub hk_pending: StdMutex<HashMap<String, PendingHostKey>>,
    pub hk_decisions: StdMutex<HashMap<String, oneshot::Sender<bool>>>,
    pub hk_tx: broadcast::Sender<PendingHostKey>,
    /// 2FA 人工应答待决（路线图⑩）：pending 表（含应答通道）+ 事件推送。
    pub ap_pending: StdMutex<HashMap<String, (PendingAuthPrompt, oneshot::Sender<String>)>>,
    pub ap_tx: broadcast::Sender<PendingAuthPrompt>,
    /// C1 建连尝试事件（connection-event，沿 approval-event 桥模式）。
    pub conn_tx: broadcast::Sender<ConnectionEvent>,
    /// C3（R24）：shell 集成态事件（Ready/Unavailable；DC3.5）
    pub shell_tx: broadcast::Sender<ShellIntegrationEvent>,
    /// R26（§6.4）：会话状态事件（断线/自动重连次数/重确认）——UI 即时推送，
    /// 免 3s 列表轮询盲窗。
    pub state_tx: broadcast::Sender<SessionStateEvent>,
    pub vault: Arc<tinyssh_vault::Vault>,
    pub audit: Arc<tinyssh_audit::AuditStore>,
}

pub struct SessionManager {
    sessions: StdMutex<HashMap<SessionId, Arc<SessionHandle>>>,
    pub center: Arc<ApprovalCenter>,
    approvals_rx_gen: StdMutex<()>,
    /// C1 活跃 attempt 表（终态后保留至进程结束——connection_status 恒返回终态）。
    attempts: StdMutex<HashMap<AttemptId, Arc<AttemptEntry>>>,
    /// C1 幂等合并索引：(host_id, actor 域) → 活跃 attempt（DC1.5）。
    merge_index: StdMutex<HashMap<(HostId, String), AttemptId>>,
    /// 自引用（spawn attempt 任务需 'static Arc<Self>；open 装配时回填）。
    self_weak: StdMutex<Option<std::sync::Weak<SessionManager>>>,
    /// C1 契约测试钩子（仅测试构建存在；驱动「已提交未投递」窗口时序）。
    #[cfg(test)]
    test_hooks: StdMutex<AttemptTestHooks>,
    pub data_dir: PathBuf,
    /// MCP 端点实际地址（T43 §6-7 收口）：由装配层在 bind 后写入（GUI 进程内嵌
    /// 或 serve CLI）；未装配时为占位文案（L1 §3.5 端口递增，真实值以 bind 为准）。
    mcp_endpoint: StdMutex<String>,
    /// C5（R32）传输任务注册表：查询（list_transfers）/事件（transfer_tx）/
    /// journal 落库推进的唯一视图层。cancel 句柄索引仍挂 SessionHandle.transfers
    /// （接管/关闭的会话级取消路径沿用），此处只挂同一 token 的观察面。
    transfers: StdMutex<HashMap<TransferId, TransferRegEntry>>,
    /// C6/R34 DF6.4 同目标锁：canonical path（r:远端/l:本地前缀区分命名空间）→
    /// 任务级互斥。只串行本客户端任务（外部写入由预检/复检/发布原语防线兜底）。
    target_locks: StdMutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
    /// R35 §366 窗口全局并行传输闸（跨会话 4；每会话闸挂 SessionHandle.xfer_gate_session）。
    xfer_gate_global: std::sync::Arc<tokio::sync::Semaphore>,
    /// C5 事件通道（可丢 broadcast；漏收由 list_transfers 查询对账兜底——§547
    /// 「重挂 UI 后可对账」）。
    pub transfer_tx: broadcast::Sender<TransferTask>,
}

/// 注册表条目：任务快照 + cancel 句柄（与会话级 SessionHandle.transfers 同一
/// token 的第二索引）+ 节流水位（事件合并 ~5 次/秒/任务、journal ≥1s/行）。
/// R34：decision_tx=AwaitingDecision 决策通道（Some=等待人类裁决；决定/取消/
/// 拒绝即取走）；verified=提交窗口发布原语成功标记（journal 同步写，重启恢复
/// 与 OutcomeUnknown 复核的唯一绑定证据——DF5.2）。
struct TransferRegEntry {
    task: TransferTask,
    cancel: CancellationToken,
    last_emit: std::time::Instant,
    last_journal: std::time::Instant,
    decision_tx: Option<tokio::sync::oneshot::Sender<CollisionDecision>>,
    verified: bool,
}

/// C6/R34：staging 规划（canonical 目标 + 同目录 temp + 同目标锁键）。
struct StagePlan {
    /// canonical 目标目录（无尾 /）
    dir: String,
    /// 原始目标名
    name: String,
    /// canonical 完整目标路径（锁键与预检/复检/发布一律用它）
    target: String,
    /// 分片 temp（.tinyssh-part-<task_id>-<name>，与目标同目录同文件系统）
    temp: String,
    /// 同目标锁键（r:=远端命名空间 / l:=本地命名空间）
    lock_key: String,
}

impl SessionManager {
    pub fn open(db_path: &Path) -> Result<Arc<Self>> {
        let vault = Arc::new(tinyssh_vault::Vault::open(db_path)?);
        let audit = Arc::new(tinyssh_audit::AuditStore::open(db_path)?);
        let (approvals_tx, _) = broadcast::channel(256);
        let (forwards_tx, _) = broadcast::channel(256);
        let (hk_tx, _) = broadcast::channel(16);
        let (ap_tx, _) = broadcast::channel(16);
        let (conn_tx, _) = broadcast::channel(64);
        let (shell_tx, _) = broadcast::channel(64);
        let (state_tx, _) = broadcast::channel(64);
        let (transfer_tx, _) = broadcast::channel(128);
        let center = Arc::new(ApprovalCenter {
            engine: ApprovalEngine::new()?,
            items: StdMutex::new(HashMap::new()),
            decisions: StdMutex::new(HashMap::new()),
            approvals_tx,
            forwards_tx,
            hk_pending: StdMutex::new(HashMap::new()),
            hk_decisions: StdMutex::new(HashMap::new()),
            hk_tx,
            ap_pending: StdMutex::new(HashMap::new()),
            ap_tx,
            conn_tx,
            shell_tx,
            state_tx,
            vault,
            audit,
        });
        let arc = Arc::new(Self {
            sessions: StdMutex::new(HashMap::new()),
            center,
            approvals_rx_gen: StdMutex::new(()),
            attempts: StdMutex::new(HashMap::new()),
            merge_index: StdMutex::new(HashMap::new()),
            self_weak: StdMutex::new(None),
            #[cfg(test)]
            test_hooks: StdMutex::new(AttemptTestHooks::default()),
            data_dir: db_path.parent().unwrap_or(Path::new(".")).to_path_buf(),
            mcp_endpoint: StdMutex::new(
                "http://127.0.0.1:8722/mcp（被占递增；以端点装配方输出为准）".into(),
            ),
            transfers: StdMutex::new(HashMap::new()),
            target_locks: StdMutex::new(HashMap::new()),
            xfer_gate_global: Arc::new(tokio::sync::Semaphore::new(handle::TRANSFER_GLOBAL)),
            transfer_tx,
        });
        *arc.self_weak.lock().unwrap() = Some(Arc::downgrade(&arc));
        // C5（§560）+ C6（R34）重启恢复：journal 活动行按提交语义分类——
        // Committing+verified=true → Succeeded{verified}（发布原语成功已落账，
        // 「已确认提交归成功」）；Committing → OutcomeUnknown（提交与否不可知，
        // temp 保留、不自动重试/覆盖/清理）；Queued/Running/AwaitingDecision/
        // Cancelling → Interrupted（提交前确未提交；可新建重试，retry_of 归 R35）。
        // 本地 temp（下载侧）确未提交即删；远端 temp 清理需通道，登记延后。
        match arc.center.vault.transfer_journal_load_active() {
            Ok(rows) => {
                let now = now_unix();
                let mut reg = arc.transfers.lock().unwrap();
                for (mut t, verified) in rows {
                    match t.status {
                        TransferStatus::Committing if verified => {
                            t.status = TransferStatus::Succeeded;
                            t.error = None;
                            t.finished_at = Some(now);
                            // 已确认提交：本地 temp 残留可清（链接已建立，temp 冗余）
                            Self::cleanup_local_temp(&t);
                            let _ = arc.center.audit.append(
                                &Actor::Human, "transfer_recovered_succeeded", Some(&t.session_id), Some(&t.dest),
                                serde_json::json!({"transfer": t.id, "verified": true}), None);
                        }
                        TransferStatus::Committing => {
                            t.status = TransferStatus::OutcomeUnknown;
                            t.error = Some("应用重启时提交结果未知（temp 保留；可在卡片「重新核实」）".into());
                            t.finished_at = Some(now);
                            let _ = arc.center.audit.append(
                                &Actor::Human, "transfer_outcome_unknown", Some(&t.session_id), Some(&t.dest),
                                serde_json::json!({"transfer": t.id, "phase": "restart"}), None);
                        }
                        _ => {
                            t.status = TransferStatus::Interrupted;
                            t.error = Some("应用重启时传输中断".into());
                            t.finished_at = Some(now);
                            // 提交前中断=确未提交：本地 temp 清理（远端 temp 登记延后）
                            Self::cleanup_local_temp(&t);
                            let _ = arc.center.audit.append(
                                &Actor::Human, "transfer_interrupted", Some(&t.session_id), Some(&t.dest),
                                serde_json::json!({"transfer": t.id}), None);
                        }
                    }
                    t.revision += 1;
                    let _ = arc.center.vault.transfer_journal_update(&t, None);
                    reg.insert(
                        t.id.clone(),
                        TransferRegEntry {
                            task: t,
                            cancel: CancellationToken::new(),
                            last_emit: std::time::Instant::now(),
                            last_journal: std::time::Instant::now(),
                            decision_tx: None,
                            verified: false,
                        },
                    );
                }
            }
            Err(_) => {} // journal 不可读不炸启动（传输查询退化为空表）
        }
        Ok(arc)
    }

    pub fn audit(&self) -> &tinyssh_audit::AuditStore {
        &self.center.audit
    }

    /// create_session 主体（C1 抽取）：`attempt=None` 即 v1 同步兼容路径，
    /// 行为与抽 取前逐字节等价；`attempt=Some` 时相位经事件表达、门感知取消。
    async fn create_session_inner(
        &self,
        ctx: &Actor,
        req: CreateSessionReq,
        attempt: Option<&Arc<AttemptEntry>>,
    ) -> Result<SessionId> {
        let (host, kind) = if req.host_id == "local" {
            (self.ensure_local_host()?, "local".to_string())
        } else {
            let host = self
                .center
                .vault
                .list_hosts()?
                .into_iter()
                .find(|h| h.id == req.host_id)
                .ok_or(Error::SessionNotFound)?;
            (host, "ssh".to_string())
        };

        // Agent 建远程会话：默认必审（L1 §4）。审批期 attempt 保持笼统 Connecting（DC1.4）；
        // 批准后进入 Authenticating。审批中取消由 cancel_connection 作废卡（Voided 路径）。
        if let Actor::Agent { client_id } = ctx {
            if kind == "ssh" {
                self.wait_create_session_approval(ctx, client_id, &host, attempt).await?;
                if let Some(a) = attempt {
                    let mut st = a.st.lock().await;
                    if !st.terminal() {
                        st.phase = AttemptPhase::Authenticating;
                        emit_conn(&self.center, &a.info.attempt_id, AttemptPhase::Authenticating, None, None);
                    }
                }
            }
        }

        let sid = format!("s-{}", uuid::Uuid::new_v4());
        let cols = 120u16;
        let rows = 32u16;

        let channel: Arc<dyn ChannelHandle> = if kind == "local" {
            let (ch, _cleanup) = transport_pty::spawn_local_pty(cols, rows).await?;
            ch
        } else {
            let (auth_type, secret) = self.center.vault.host_secret(&host)?;
            // TOFU 指纹门（路线图⑤）：闭包只捕获 ApprovalCenter，避免回指 SessionManager
            let center = self.center.clone();
            let gate_host = host.clone();
            let gate_ctx = ctx.clone();
            let gate_attempt = attempt.cloned();
            let gate: transport_ssh::HostKeyCheck = Arc::new(move |fp| {
                let center = center.clone();
                let host = gate_host.clone();
                let ctx = gate_ctx.clone();
                let attempt = gate_attempt.clone();
                let fp = fp.to_string(); // owned 后再装箱：future 不借入参（HRTB 约束）
                Box::pin(async move { host_key_gate(&center, &ctx, &host, &fp, attempt.as_ref()).await })
            });
            // 2FA 人工应答门（路线图⑩）：kb 非密码提示 → 挂起等人类（同指纹门模式）
            let kb_center = self.center.clone();
            let kb_host = host.clone();
            let kb_ctx = ctx.clone();
            let kb_attempt = attempt.cloned();
            let kb_gate: transport_ssh::KbPromptCheck = Arc::new(move |prompt, echo| {
                let center = kb_center.clone();
                let host = kb_host.clone();
                let ctx = kb_ctx.clone();
                let attempt = kb_attempt.clone();
                let prompt = prompt.to_string(); // owned 后再装箱（HRTB 约束，同上）
                Box::pin(async move { auth_prompt_gate(&center, &ctx, &host, &prompt, echo, attempt.as_ref()).await })
            });
            let target = transport_ssh::SshTarget {
                address: host.address.clone(),
                port: host.port,
                username: host.username.clone(),
                auth_type,
                secret: secret.to_string(),
                host_key_check: Some(gate),
                kb_prompt_check: Some(kb_gate),
            };
            SshChannel::connect(target, cols, rows).await?
        };

        let screen = term_core::Screen::new(term_core::ScreenConfig::default());
        // C2（B01）：owner 构造期确定——Human 默认 Human、Agent 沿原规则（含必审）
        let owner = match ctx {
            Actor::Agent { .. } => ControlOwner::Agent,
            _ => ControlOwner::Human,
        };
        let handle = SessionHandle::new(sid.clone(), host.clone(), kind.clone(), channel, screen, self.center.clone(), owner);
        // 先订阅再注入：远端回显/首个标记提示符不得落入无订阅者窗口
        // （broadcast 无接收者即丢——并发回归中集成标记迟到 10s+ 的根因）
        let pump_rx = handle.channel.subscribe_output();
        spawn_pump(handle.clone(), pump_rx);
        // H2/N1：pending_sid 写入在 insert 之前（写入与 insert 间无 await 点）——
        // 取消 drop inner 只可能发生在写入完成前（insert 未发生=无幽灵可残留）
        // 或写入完成后（清扫必能拿到 sid），微窗完全关闭
        if let Some(a) = attempt {
            a.st.lock().await.pending_sid = Some(sid.clone());
        }
        self.sessions.lock().unwrap().insert(sid.clone(), handle.clone());

        // C3（R24）注入收敛单一入口（host_setting=false 不注入不等 OSC——P3/DC3.2）；
        // 注入后台化：create_session 不等集成（Ready 判据=通道建立），就绪经
        // shell-integration-event 表达（DC3.5）。注入失败（write Err）经 H2 幽灵清扫回收。
        // local 会话：PTY 启动时已注入，直接 Ready（不经片段注入路径）。
        if kind == "ssh" {
            if handle.inject_integration().await {
                let _ = self.center.audit.append(
                    ctx, "shell_integration_inject", Some(&sid), Some("OSC133+OSC7"), serde_json::json!({}), None);
                handle.spawn_integration_watcher(self.center.clone());
            }
        } else {
            // local：注入在 PTY 启动时同步完成（rcfile/ZDOTDIR），此处等的是 shell
            // 启动耗时——建连返回即可键入的既有不变量（旧 10s 窗，全量回归下首个
            // 提示符实测 5s+，50ms×200 保同口径）。失败不阻断（事件照发，run_shell
            // 门内有界重查兜底）。SSH 侧维持契约：不等 OSC，就绪走事件（DC3.5）。
            for _ in 0..200 {
                if handle.screen.lock().await.shell_integration_present() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            let state = if handle.screen.lock().await.shell_integration_present() {
                IntegrationState::Ready
            } else {
                IntegrationState::Unavailable
            };
            *handle.integration.lock().unwrap() = state;
            let _ = self.center.shell_tx.send(ShellIntegrationEvent {
                session_id: sid.clone(),
                state,
            });
        }

        // record_session 失败（vault Err）：v1 直调路径同样不留半会话（R23 前置清单
        // 「v1 create_session 幽灵面」闭环——与 attempt 路径 N2 清扫同语义）
        let recorded = {
            #[cfg(test)]
            if self.test_hooks.lock().unwrap().force_record_fail {
                let _ = self.close_session(ctx, sid.clone()).await;
                return Err(Error::Io("test-injected record failure".into()));
            }
            self.center.vault.record_session(&sid, &host.id, &kind).map_err(Error::from)
        };
        if let Err(e) = recorded {
            let _ = self.close_session(ctx, sid.clone()).await;
            return Err(e);
        }
        // C8：成功建连打点（host_metadata.last_connected_at；最近连接由 sessions
        // 表派生，此处只供元数据展示）
        let _ = self.center.vault.touch_host_connection(&host.id);
        let _ = self.center.audit.append(
            ctx, "session_created", Some(&sid), None,
            serde_json::json!({"host": host.id, "kind": kind, "owner": match owner { ControlOwner::Agent => "Agent", ControlOwner::Human => "Human" }}), None);
        Ok(sid)
    }

    /// C1：发起建连 attempt（立即返回，连接后台推进；相位经 connection-event）。
    async fn begin_connection_on(
        &self,
        ctx: &Actor,
        host_id: HostId,
        opts: BeginConnectionOpts,
    ) -> Result<AttemptInfo> {
        // 主机存在性前置校验（无效主机不产生 attempt；kind 与 v1 create_session 同口径）
        let known = host_id == "local"
            || self.center.vault.list_hosts()?.iter().any(|h| h.id == host_id);
        if !known {
            return Err(Error::SessionNotFound);
        }
        let domain = actor_domain(ctx);
        let key = (host_id.clone(), domain.clone());
        // 合并查询与登记同临界区（M3：并发 begin 幂等；term 原子位免 Std 锁跨 await）。
        // 命中后 snapshot 需 await，锁先落——命中条目此刻活跃（term 判定），快照相位即真相。
        let path: (bool, Arc<AttemptEntry>) = {
            // (merged?, entry)
            let mut mi = self.merge_index.lock().unwrap();
            let mut at = self.attempts.lock().unwrap();
            let merged = if !opts.new_session {
                mi.get(&key)
                    .and_then(|aid| at.get(aid))
                    .filter(|e| !e.term.load(AtomicOrdering::Acquire))
                    .cloned()
            } else {
                None
            };
            match merged {
                Some(e) => (true, e),
                None => {
                    let attempt_id = format!("at-{}", uuid::Uuid::new_v4());
                    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
                    let entry = Arc::new(AttemptEntry {
                        info: AttemptInfo {
                            attempt_id: attempt_id.clone(),
                            host_id: host_id.clone(),
                            actor: domain.clone(),
                            phase: AttemptPhase::Connecting,
                            session_id: None,
                            created_at: chrono::Utc::now(),
                            error: None,
                        },
                        st: tokio::sync::Mutex::new(AttemptState {
                            phase: AttemptPhase::Connecting,
                            session_id: None,
                            pending_sid: None,
                            error: None,
                            submitted: false,
                            delivered: false,
                            cancel_requested: false,
                        }),
                        cancel_tx,
                        cancel_rx,
                        term: AtomicBool::new(false),
                    });
                    at.insert(attempt_id.clone(), entry.clone());
                    mi.insert(key.clone(), attempt_id);
                    (false, entry)
                }
            }
        };
        if path.0 {
            // merged：命中活跃 attempt——快照返回，不重复 spawn
            let e = &path.1;
            let st = e.st.lock().await;
            return Ok(e.snapshot(&st));
        }
        let entry = path.1.clone();
        // created：spawn 尝试任务（merged 不 spawn——任务已在跑）
        let snap = entry.info.clone();
        let weak = self.self_weak.lock().unwrap().clone();
        let this = weak
            .and_then(|w| w.upgrade())
            .ok_or_else(|| Error::Storage("SessionManager 未装配 Arc".into()))?;
        let ctx2 = ctx.clone();
        tokio::spawn(async move {
            this.run_attempt(entry, ctx2).await;
        });
        Ok(snap)
    }

    /// 取消落点结算：inner 被 drop 时若已过 sessions.insert 点（pending_sid 在案），
    /// 关闭幽灵会话再结算 Cancelled（H2——否则 handle/channel/pump 全泄漏，内存表出
    /// Connected 幽灵，违背契约序列 1「无 session 遗留」）。关闭失败 → CancelCloseFailed
    /// （会话保留=恢复入口）。返回 true=终态已在此结算（调用方跳过常规结算）。
    async fn settle_cancel_with_ghost(
        self: &Arc<Self>,
        entry: &Arc<AttemptEntry>,
        ctx: &Actor,
        attempt_id: &str,
    ) -> bool {
        let ghost = entry.st.lock().await.pending_sid.take();
        let Some(gsid) = ghost else {
            return false;
        };
        match self.close_session(ctx, gsid.clone()).await {
            Ok(()) => {
                let _ = self.center.audit.append(
                    ctx, "connection_cancelled_closed", None, None,
                    serde_json::json!({"attempt_id": attempt_id, "session_id": gsid}), None);
            }
            Err(e) => {
                let payload = e.payload();
                let mut st = entry.st.lock().await;
                st.session_id = Some(gsid.clone());
                st.error = Some(payload.clone());
                entry.settle(&mut st, AttemptPhase::CancelCloseFailed);
                drop(st);
                let _ = self.center.audit.append(
                    ctx, "connection_cancel_close_failed", None, None,
                    serde_json::json!({"attempt_id": attempt_id, "session_id": gsid, "error": e.to_string()}), None);
                emit_conn(&self.center, attempt_id, AttemptPhase::CancelCloseFailed, Some(&gsid), Some(&payload));
                return true;
            }
        }
        false
    }

    /// 合并索引按键比较移除（M3：终态清理不得误删指向其他 attempt 的条目——
    /// 并发下 merge_index 可能已被更新的 attempt 覆盖）。
    fn merge_remove(&self, host_id: &HostId, domain: &str, attempt_id: &str) {
        let mut mi = self.merge_index.lock().unwrap();
        if mi.get(&(host_id.clone(), domain.to_string())).map(String::as_str) == Some(attempt_id) {
            mi.remove(&(host_id.clone(), domain.to_string()));
        }
    }

    /// C1 取消受理与竞态结算（DC1.2/DC1.5；调用方必须持 Arc<Self>——见 begin_connection_on）。
    async fn cancel_connection_on(
        self: &Arc<Self>,
        ctx: &Actor,
        attempt_id: AttemptId,
    ) -> Result<CancelOutcome> {
        let entry = self
            .attempts
            .lock()
            .unwrap()
            .get(&attempt_id)
            .cloned()
            .ok_or(Error::SessionNotFound)?;
        // 跨 Actor 身份域：NotFound 不泄露存在性 + 审计留痕（契约序列 5）
        if entry.info.actor != actor_domain(ctx) {
            let _ = self.center.audit.append(
                ctx, "cross_actor_cancel_denied", None, None,
                serde_json::json!({"attempt_id": attempt_id, "caller_actor": actor_domain(ctx)}), None);
            return Ok(CancelOutcome::NotFound);
        }
        let mut st = entry.st.lock().await;
        if st.terminal() || st.delivered {
            // 已投递（Ready 后迟到取消，无副作用）或已终态（含 CancelCloseFailed 后重复取消）
            return Ok(CancelOutcome::NotFound);
        }
        if st.cancel_requested {
            // 并发取消：首个受理者拥有结算权（M4——二次 close 会把「已关闭」误报成
            // CancelCloseFailed 的「会话保留」）；后续取消按 NotFound 处理，终态以事件为准
            return Ok(CancelOutcome::NotFound);
        }
        if st.submitted {
            // 已提交未投递窗口：核心立即关闭该刚创建且从未投递的会话（DC1.2）
            let sid = st.session_id.clone().ok_or(Error::SessionNotFound)?;
            st.cancel_requested = true;
            drop(st);
            entry.cancel_notify();
            #[cfg(test)]
            let close_result = if self.test_hooks.lock().unwrap().force_close_fail {
                Err(Error::Io("test-injected close failure".into()))
            } else {
                self.close_session(ctx, sid.clone()).await
            };
            #[cfg(not(test))]
            let close_result = self.close_session(ctx, sid.clone()).await;
            match close_result {
                Ok(()) => {
                    let mut st = entry.st.lock().await;
                    st.session_id = None;
                    st.error = None;
                    entry.settle(&mut st, AttemptPhase::Cancelled);
                    drop(st);
                    let _ = self.center.audit.append(
                        ctx, "connection_cancelled_closed", None, None,
                        serde_json::json!({"attempt_id": attempt_id, "session_id": sid}), None);
                    emit_conn(&self.center, &attempt_id, AttemptPhase::Cancelled, None, None);
                    Ok(CancelOutcome::AlreadyReady { session_id: sid })
                }
                Err(e) => {
                    let payload = e.payload();
                    let mut st = entry.st.lock().await;
                    st.error = Some(payload.clone());
                    entry.settle(&mut st, AttemptPhase::CancelCloseFailed);
                    drop(st);
                    let _ = self.center.audit.append(
                        ctx, "connection_cancel_close_failed", None, None,
                        serde_json::json!({"attempt_id": attempt_id, "session_id": sid, "error": e.to_string()}), None);
                    emit_conn(&self.center, &attempt_id, AttemptPhase::CancelCloseFailed, Some(&sid), Some(&payload));
                    Ok(CancelOutcome::CancelCloseFailed { session_id: sid })
                }
            }
        } else {
            // 提交前受理：置标志 + 作废门/审批卡（终态由 attempt 任务结算）
            st.cancel_requested = true;
            drop(st);
            entry.cancel_notify();
            // 作废该 attempt 的 TOFU/2FA 待决卡：移除待决表（UI 查询面不再返回死卡，
            // M1——hk_pending 不清会残留幽灵卡，decide 得 InvalidInput）+ 以拒绝结算门
            // （gate 收到 false/发送端丢弃走取消臂，attempt 终态由任务统一结算）
            let hk_ids: Vec<String> = {
                self.center
                    .hk_pending
                    .lock().unwrap()
                    .values()
                    .filter(|p| p.attempt_id.as_deref() == Some(&attempt_id))
                    .map(|p| p.id.clone())
                    .collect()
            };
            for id in hk_ids {
                self.center.hk_pending.lock().unwrap().remove(&id);
                if let Some(tx) = self.center.hk_decisions.lock().unwrap().remove(&id) {
                    let _ = tx.send(false);
                }
            }
            let ap_ids: Vec<String> = {
                self.center
                    .ap_pending
                    .lock().unwrap()
                    .values()
                    .filter(|(p, _)| p.attempt_id.as_deref() == Some(&attempt_id))
                    .map(|(p, _)| p.id.clone())
                    .collect()
            };
            for id in ap_ids {
                if let Some((_, tx)) = self.center.ap_pending.lock().unwrap().remove(&id) {
                    let _ = tx.send(String::new());
                }
            }
            // 作废该 attempt 的建连审批卡（复用 T44 voided 留痕先例）
            let appr_ids: Vec<ApprovalId> = {
                self.center
                    .items
                    .lock().unwrap()
                    .iter()
                    .filter(|(_, it)| {
                        it.attempt_id.as_deref() == Some(&attempt_id)
                            && it.status == ApprovalStatus::Pending
                    })
                    .map(|(id, _)| id.clone())
                    .collect()
            };
            for id in appr_ids {
                // 注意：快照先落 let——if let 守卫的 MutexGuard 临时活到块尾（2021 edition），
                // 块内再锁同锁会自死锁
                let snap = self.center.items.lock().unwrap().get(&id).cloned();
                if let Some(mut it) = snap {
                    it.status = ApprovalStatus::Voided;
                    let _ = self.center.vault.save_approval(&it);
                    // 内存表同步写回（mark_status 同口径）——只改快照不写回会让
                    // UI 列表与后续过滤器读到过期 Pending
                    if let Some(slot) = self.center.items.lock().unwrap().get_mut(&id) {
                        slot.status = ApprovalStatus::Voided;
                    }
                    let _ = self.center.audit.append(
                        ctx, "approval_voided", None, Some(&it.command),
                        serde_json::json!({"reason": "connection_cancelled", "agent": it.agent_id}),
                        Some(&id));
                    let _ = self.center.approvals_tx.send(ApprovalEvent::Updated(it));
                }
                if let Some(tx) = self.center.decisions.lock().unwrap().remove(&id) {
                    let _ = tx.send(DecisionMsg::Voided);
                }
            }
            Ok(CancelOutcome::Cancelled)
        }
    }

    /// C1 attempt 任务体：跑建连、结算提交点竞态窗口与终态（契约序列 1-6）。
    async fn run_attempt(self: Arc<Self>, entry: Arc<AttemptEntry>, ctx: Actor) {
        let attempt_id = entry.info.attempt_id.clone();
        let host_id = entry.info.host_id.clone();
        let domain = entry.info.actor.clone();
        let req = CreateSessionReq { host_id: host_id.clone() };
        // 取消兜底：非门 await 阶段（TCP/认证中）受理的取消经 select 即时结算——
        // drop inner 前门卡已由受理路径作废（hk/ap/审批结算），无表残留
        let r = tokio::select! {
            r = self.create_session_inner(&ctx, req, Some(&entry)) => r,
            _ = wait_cancelled(entry.cancel_rx.clone()) => Err(Error::Cancelled),
        };
        let mut st = entry.st.lock().await;
        if st.terminal() {
            // 取消受理路径已在窗口内结算终态（cancel_connection_on 持锁先到）
            drop(st);
            self.merge_remove(&host_id, &domain, &attempt_id);
            return;
        }
        match r {
            Ok(sid) => {
                // 提交点：create_session_inner 返回 Ok 即「已提交」——会话行已存在，
                // 状态从此刻携带 session_id（窗口取消依赖它定位待关闭会话）。
                st.pending_sid = None; // 提交点后幽灵清扫让位于 session_id 口径
                st.session_id = Some(sid.clone());
                st.submitted = true;
                if st.cancel_requested {
                    // 已提交未投递窗口：核心立即关闭刚创建且从未投递的会话
                    drop(st);
                    if let Err(e) = self.close_session(&ctx, sid.clone()).await {
                        // 关闭失败：CancelCloseFailed（会话保留=恢复入口），终态事件为准
                        let payload = e.payload();
                        let mut st = entry.st.lock().await;
                        st.session_id = Some(sid.clone());
                        st.error = Some(payload.clone());
                        entry.settle(&mut st, AttemptPhase::CancelCloseFailed);
                        drop(st);
                        let _ = self.center.audit.append(
                            &ctx, "connection_cancel_close_failed", None, None,
                            serde_json::json!({"attempt_id": attempt_id, "session_id": sid, "error": e.to_string()}), None);
                        emit_conn(&self.center, &attempt_id, AttemptPhase::CancelCloseFailed, Some(&sid), Some(&payload));
                        self.merge_remove(&host_id, &domain, &attempt_id);
                        return;
                    }
                    let mut st = entry.st.lock().await;
                    st.session_id = None;
                    entry.settle(&mut st, AttemptPhase::Cancelled);
                    drop(st);
                    let _ = self.center.audit.append(
                        &ctx, "connection_cancelled_closed", None, None,
                        serde_json::json!({"attempt_id": attempt_id, "session_id": sid}), None);
                    emit_conn(&self.center, &attempt_id, AttemptPhase::Cancelled, None, None);
                } else {
                    drop(st);
                    // 测试钩子：停在「已提交未投递」窗口，供 cancel_connection 驱动
                    // AlreadyReady/CancelCloseFailed 竞态（契约序列 2/3）
                    #[cfg(test)]
                    {
                        let (arrived, pause) = {
                            let h = self.test_hooks.lock().unwrap();
                            (h.arrived_after_submit.clone(), h.pause_after_submit.clone())
                        };
                        if let (Some(a), Some(p)) = (arrived, pause) {
                            a.notify_one();
                            p.notified().await;
                        }
                    }
                    let mut st = entry.st.lock().await;
                    if st.terminal() || st.cancel_requested {
                        // H1：取消已受理（窗口 close 进行中或已结算）——投递权让渡，
                        // 此处发出 Ready 会把已投递会话再被取消路径关闭、终态遭改写
                        drop(st);
                        self.merge_remove(&host_id, &domain, &attempt_id);
                        return;
                    }
                    // 投递点：Ready 事件广播即「已投递」；此后取消一律 NotFound
                    st.delivered = true;
                    st.session_id = Some(sid.clone());
                    entry.settle(&mut st, AttemptPhase::Ready);
                    drop(st);
                    emit_conn(&self.center, &attempt_id, AttemptPhase::Ready, Some(&sid), None);
                }
            }
            Err(e) => {
                let cancelled = st.cancel_requested || matches!(e, Error::Cancelled);
                drop(st);
                if cancelled {
                    // H2：inner 被 drop 时若已过 insert 点，先关幽灵会话（可能改判 CCF）
                    if self.settle_cancel_with_ghost(&entry, &ctx, &attempt_id).await {
                        self.merge_remove(&host_id, &domain, &attempt_id);
                        return;
                    }
                    let mut st = entry.st.lock().await;
                    if st.terminal() {
                        drop(st);
                        self.merge_remove(&host_id, &domain, &attempt_id);
                        return;
                    }
                    st.session_id = None;
                    st.error = None;
                    entry.settle(&mut st, AttemptPhase::Cancelled);
                    drop(st);
                    let _ = self.center.audit.append(
                        &ctx, "connection_cancelled", None, None,
                        serde_json::json!({"attempt_id": attempt_id}), None);
                    emit_conn(&self.center, &attempt_id, AttemptPhase::Cancelled, None, None);
                } else {
                    // N2：inner 失败（write/record_session Err）时若已过 insert 点，
                    // 半会话同样不留（attempt 路径；v1 直调同面缺陷另行登记）
                    let half = entry.st.lock().await.pending_sid.take();
                    if let Some(hsid) = half {
                        let _ = self.close_session(&ctx, hsid).await;
                    }
                    let payload = e.payload();
                    let mut st = entry.st.lock().await;
                    if st.terminal() {
                        drop(st);
                        self.merge_remove(&host_id, &domain, &attempt_id);
                        return;
                    }
                    st.session_id = None;
                    st.error = Some(payload.clone());
                    entry.settle(&mut st, AttemptPhase::Failed);
                    drop(st);
                    let _ = self.center.audit.append(
                        &ctx, "connection_failed", None, None,
                        serde_json::json!({"attempt_id": attempt_id, "error": payload.kind}), None);
                    emit_conn(&self.center, &attempt_id, AttemptPhase::Failed, None, Some(&payload));
                }
            }
        }
        self.merge_remove(&host_id, &domain, &attempt_id);
    }


    /// 转发的人类可读描述（审批卡命令串与审计载荷同源；free fn 供 trait impl 与未来调用方共用）
    pub fn forward_desc(spec: &ForwardSpec) -> String {
        match spec {
            ForwardSpec::Local { listen_addr, listen_port, target_host, target_port } =>
                format!("端口转发 -L {listen_addr}:{listen_port} → {target_host}:{target_port}"),
            ForwardSpec::Remote { listen_addr, listen_port, target_host, target_port } =>
                format!("端口转发 -R 远端 {listen_addr}:{listen_port} → 本地 {target_host}:{target_port}"),
            ForwardSpec::Dynamic { listen_addr, listen_port } =>
                format!("端口转发 -D SOCKS5 {listen_addr}:{listen_port}"),
        }
    }

    /// 非 exec 类审批卡一律拒绝「编辑后批准」（T44 复审②扩展）：这类卡的参数
    /// 无法从人类编辑后的文本回解，静默按原文执行会让审计「记 edited、实执行
    /// 原文」失真——统一拦截并明确报错（调用方不执行任何动作）。exec 卡除外
    /// （handle.rs 尊重 edited）。
    pub fn reject_edited_approval(edited: &Option<String>, original: &str, what: &str) -> Result<()> {
        if let Some(e) = edited {
            if e != original {
                return Err(Error::InvalidInput(format!(
                    "{what}不支持编辑后批准——请直接批准或拒绝（参数无法从编辑文本回解）"
                )));
            }
        }
        Ok(())
    }

    /// MCP 端点描述：装配层 bind 后写入实际地址（T43）；未装配时为占位提示。
    pub fn mcp_endpoint(&self) -> String {
        self.mcp_endpoint.lock().unwrap().clone()
    }

    /// 装配层写口（GUI 进程内嵌端点 / serve CLI 在 bind 成功后调用）。
    pub fn set_mcp_endpoint(&self, url: impl Into<String>) {
        *self.mcp_endpoint.lock().unwrap() = url.into();
    }

    /// 创建本地会话用的隐式主机记录。
    fn ensure_local_host(&self) -> Result<Host> {
        if let Some(h) = self
            .center
            .vault
            .list_hosts()?
            .into_iter()
            .find(|h| h.id == "local")
        {
            return Ok(h);
        }
        let draft = HostDraft {
            id: Some("local".into()),
            name: "本机".into(),
            address: "local".into(),
            port: Some(0),
            username: std::env::var("USER").unwrap_or_else(|_| "user".into()),
            auth: AuthDraft::None,
            tags: vec![],
            charset: Charset::Utf8,
            shell_integration: None,
        };
        self.center.vault.upsert_host(&draft)?;
        Ok(Host {
            id: "local".into(),
            name: "本机".into(),
            address: "local".into(),
            port: 0,
            username: draft.username,
            auth_type: AuthType::Key,
            identity_id: None,
            tags: vec![],
            fingerprint: None,
            shell_integration: None,
            charset: Charset::Utf8,
        })
    }

    async fn wait_create_session_approval(
        &self,
        actor: &Actor,
        client: &AgentClientId,
        host: &Host,
        attempt: Option<&Arc<AttemptEntry>>,
    ) -> Result<()> {
        let eval = tinyssh_approval::Evaluation {
            verdict: tinyssh_approval::SegmentVerdict::NeedsApproval,
            segments: vec![SegmentReport {
                segment: format!("create_session {}", host.name),
                verdict: "pending: 远程会话默认必审".into(),
            }],
        };
        let item = ApprovalItem {
            id: format!("a-{}", uuid::Uuid::new_v4()),
            session_id: String::new(),
            agent_id: client.clone(),
            command: format!("create_session host={}", host.name),
            edited_command: None,
            target_summary: "建立远程会话".into(),
            segment_report: eval.segments.clone(),
            session_busy: false,
            editable: false, // 建会话参数无法从编辑文本回解（T44 复核中-2 同款口径）
            created_at: chrono::Utc::now(),
            status: ApprovalStatus::Pending,
            attempt_id: attempt.map(|a| a.info.attempt_id.clone()),
            // R42（§6.7）：建会话审批尚无会话，也就无从取得委托目标 → 明确缺失。
            purpose: None,
        };
        let (tx, rx) = oneshot::channel();
        self.center.decisions.lock().unwrap().insert(item.id.clone(), tx);
        self.center.items.lock().unwrap().insert(item.id.clone(), item.clone());
        let _ = self.center.vault.save_approval(&item);
        let _ = self.center.approvals_tx.send(ApprovalEvent::New(item.clone()));
        let _ = self.center.audit.append(
            actor, "approval_requested", None, Some(&item.command), serde_json::json!({}), Some(&item.id));

        match tokio::time::timeout(DEFAULT_APPROVAL_TIMEOUT, rx).await {
            Ok(Ok(DecisionMsg::Decide(Decision::Approve))) => {
                if let Some(it) = self.center.items.lock().unwrap().get_mut(&item.id) {
                    it.status = ApprovalStatus::Approved;
                }
                Ok(())
            }
            Ok(Ok(DecisionMsg::Decide(Decision::ApproveEdited(_)))) => {
                // 主机参数无法从编辑文本回解（复审②）：拒绝执行。顺带补置卡状态
                // ——原实现漏置，ApproveEdited 后卡在 UI 恒 Pending。
                if let Some(it) = self.center.items.lock().unwrap().get_mut(&item.id) {
                    it.status = ApprovalStatus::ApprovedEdited;
                }
                Err(Error::InvalidInput(
                    "create_session 审批不支持编辑后批准——请直接批准或拒绝（主机参数无法从编辑文本回解）".into(),
                ))
            }
            Ok(Ok(DecisionMsg::Decide(Decision::Deny))) => {
                if let Some(it) = self.center.items.lock().unwrap().get_mut(&item.id) {
                    it.status = ApprovalStatus::Denied;
                }
                Err(Error::ApprovalDenied { reason: DeniedReason::Denied })
            }
            Ok(Ok(DecisionMsg::Voided)) | Ok(Err(_)) => {
                Err(Error::ApprovalDenied { reason: DeniedReason::Denied })
            }
            Err(_) => Err(Error::ApprovalDenied { reason: DeniedReason::ApprovalTimeout }),
        }
    }
}

// ---------------------------------------------------------------------------
// C1 建连尝试（R19）：attempt 状态机
// 状态转移仅核心可写；终态（Ready/Failed/Cancelled/CancelCloseFailed）后不再变化。
// 「已提交」= create_session_inner 返回 Ok；「已投递」= Ready 事件已广播（DC1.2
// 交付线性化点：取消与建连的竞态只在已提交未投递窗口内产生自动关闭）。
// ---------------------------------------------------------------------------

/// attempt 可变状态机（单把 tokio 锁内互斥；窗口/清扫的 close 一律先落锁再 await，
/// 锁上不做任何跨 await 操作——结算点重入只经重新 lock）。
#[derive(Debug)]
struct AttemptState {
    phase: AttemptPhase,
    session_id: Option<SessionId>,
    error: Option<ErrorPayload>,
    /// create_session_inner 已返回 Ok（会话已建立、已落库）。
    submitted: bool,
    /// inner 已过 sessions.insert 点但尚未返回（取消 drop inner 时的幽灵清扫依据，H2）。
    pending_sid: Option<SessionId>,
    /// Ready 事件已广播（投递点）。
    delivered: bool,
    /// cancel_connection 已受理（提交前受理路径）。
    cancel_requested: bool,
}

impl AttemptState {
    fn terminal(&self) -> bool {
        self.phase.is_terminal()
    }
}

#[derive(Debug)]
struct AttemptEntry {
    info: AttemptInfo,
    st: tokio::sync::Mutex<AttemptState>,
    /// 取消信号（watch 有记忆：门挂起前发生的取消在挂起后仍可观察到）。
    cancel_tx: tokio::sync::watch::Sender<bool>,
    cancel_rx: tokio::sync::watch::Receiver<bool>,
    /// 终态原子镜像（settle 置位，Release/Acquire 配对）：合并查询在 Std 锁临界区内
    /// 判活不跨 await（M3——tokio Mutex 的 phase 不可在 Std 锁内读）。
    term: AtomicBool,
}

impl AttemptEntry {
    fn cancel_notify(&self) {
        let _ = self.cancel_tx.send(true);
    }
    /// 终态结算唯一入口：phase 与 term 原子镜像同锁内写（M3 查询侧判活依据）。
    fn settle(&self, st: &mut AttemptState, phase: AttemptPhase) {
        st.phase = phase;
        self.term.store(phase.is_terminal(), AtomicOrdering::Release);
    }
    fn snapshot(&self, st: &AttemptState) -> AttemptInfo {
        AttemptInfo {
            attempt_id: self.info.attempt_id.clone(),
            host_id: self.info.host_id.clone(),
            actor: self.info.actor.clone(),
            phase: st.phase,
            session_id: st.session_id.clone(),
            created_at: self.info.created_at,
            error: st.error.clone(),
        }
    }
}

/// C1 契约测试钩子：暂停/到达信号与强制关闭失败（驱动竞态序列 2/3）。
#[derive(Default)]
struct AttemptTestHooks {
    /// run_attempt 到达「已提交未投递」暂停点后 notify_one。
    arrived_after_submit: Option<Arc<tokio::sync::Notify>>,
    /// run_attempt 在暂停点 await（测试调 cancel 后 notify 放行）。
    pause_after_submit: Option<Arc<tokio::sync::Notify>>,
    /// 窗口关闭强制失败（驱动 CancelCloseFailed 路径）。
    force_close_fail: bool,
    /// v1 幽灵面回归网（R23）：强制 record_session 失败，驱动半会话清扫。
    force_record_fail: bool,
}

/// C1 合并与取消权限的身份域（DC1.5）：Human 单域；Agent 按 client_id。
fn actor_domain(ctx: &Actor) -> String {
    match ctx {
        Actor::Human => "human".to_string(),
        Actor::Agent { client_id } => format!("agent:{}", client_id),
    }
}

fn emit_conn(
    center: &ApprovalCenter,
    attempt_id: &str,
    phase: AttemptPhase,
    session_id: Option<&str>,
    error: Option<&ErrorPayload>,
) {
    let _ = center.conn_tx.send(ConnectionEvent {
        attempt_id: attempt_id.to_string(),
        phase,
        session_id: session_id.map(|s| s.to_string()),
        error: error.cloned(),
    });
}

/// TOFU 主机指纹门（路线图⑤）：vault 已信任且一致 → 静默放行；
/// 首连 → 确认弹窗；不一致 → 变更红色告警。人类放行后指纹入库。
/// 拒绝/超时返回 HostKeyRejected（经 russh 透传为 create_session 的错误）。
/// 取消等待臂：watch 有记忆，门挂起前受理的取消在挂起后仍被观察到（C1）。
async fn wait_cancelled(mut rx: tokio::sync::watch::Receiver<bool>) {
    while !*rx.borrow_and_update() {
        if rx.changed().await.is_err() {
            return;
        }
    }
}

async fn host_key_gate(
    center: &Arc<ApprovalCenter>,
    ctx: &Actor,
    host: &Host,
    fp: &str,
    attempt: Option<&Arc<AttemptEntry>>,
) -> Result<bool> {
    // C1：门挂起前已受理取消 → 直接以取消结束（不新挂 pending 卡）
    if let Some(a) = attempt {
        if *a.cancel_rx.borrow() {
            return Err(Error::Cancelled);
        }
    }
    let stored = center.vault.host_fingerprint(&host.id)?;
    if stored.as_deref() == Some(fp) {
        return Ok(true);
    }
    let issue = if stored.is_some() {
        HostKeyIssue::Changed
    } else {
        HostKeyIssue::FirstSeen
    };
    let item = PendingHostKey {
        id: format!("hk-{}", uuid::Uuid::new_v4()),
        host_id: host.id.clone(),
        host_name: host.name.clone(),
        address: host.address.clone(),
        port: host.port,
        issue,
        fingerprint: fp.to_string(),
        previous_fingerprint: stored,
        created_at: chrono::Utc::now(),
        attempt_id: attempt.map(|a| a.info.attempt_id.clone()),
    };
    let _ = center.audit.append(
        ctx, "host_key_confirm_requested", None, Some(&host.name),
        serde_json::json!({"id": item.id, "issue": format!("{issue:?}"), "fingerprint": fp}), None);
    let (tx, rx) = oneshot::channel();
    center.hk_decisions.lock().unwrap().insert(item.id.clone(), tx);
    center.hk_pending.lock().unwrap().insert(item.id.clone(), item.clone());
    let _ = center.hk_tx.send(item.clone());
    if let Some(a) = attempt {
        let mut st = a.st.lock().await;
        if !st.terminal() {
            st.phase = AttemptPhase::TrustRequired;
            emit_conn(center, &a.info.attempt_id, AttemptPhase::TrustRequired, None, None);
        }
    }
    let wait = tokio::time::timeout(DEFAULT_APPROVAL_TIMEOUT, rx);
    tokio::pin!(wait);
    let decided = tokio::select! {
        r = &mut wait => match r {
            Ok(Ok(true)) => Some(true),
            Ok(Ok(false)) => Some(false),
            Ok(Err(_)) => Some(false),
            Err(_) => None, // 超时
        },
        _ = async { match attempt { Some(a) => wait_cancelled(a.cancel_rx.clone()).await, None => std::future::pending().await } } => {
            // 取消受理：以「拒绝」结算决策通道（decide 路径自清 pending 表；
            // 任务侧按 cancel_requested 识别为取消而非失败）
            Some(false)
        }
    };
    match decided {
        Some(true) => {
            center.vault.set_host_fingerprint(&host.id, fp)?;
            let _ = center.audit.append(
                ctx, "host_key_trusted", None, Some(&host.name),
                serde_json::json!({"fingerprint": fp}), None);
            if let Some(a) = attempt {
                let mut st = a.st.lock().await;
                if !st.terminal() {
                    st.phase = AttemptPhase::Authenticating;
                    emit_conn(center, &a.info.attempt_id, AttemptPhase::Authenticating, None, None);
                }
            }
            Ok(true)
        }
        Some(false) => Err(Error::HostKeyRejected("用户拒绝连接".into())),
        None => {
            center.hk_pending.lock().unwrap().remove(&item.id);
            if let Some(a) = attempt {
                let _ = center.audit.append(
                    ctx, "approval_voided", None, Some(&host.name),
                    serde_json::json!({"attempt_id": a.info.attempt_id, "reason": "gate_timeout", "gate": "host_key"}), None);
            }
            Err(Error::HostKeyRejected("确认超时".into()))
        }
    }
}

/// 2FA 人工应答门（路线图⑩）：keyboard-interactive 非密码类提示挂起等人类。
/// 应答串经 oneshot 送回 transport；取消/超时返回 None（transport 侧终止认证）。
async fn auth_prompt_gate(
    center: &Arc<ApprovalCenter>,
    ctx: &Actor,
    host: &Host,
    prompt: &str,
    echo: bool,
    attempt: Option<&Arc<AttemptEntry>>,
) -> Result<Option<String>> {
    if let Some(a) = attempt {
        if *a.cancel_rx.borrow() {
            return Err(Error::Cancelled);
        }
    }
    let item = PendingAuthPrompt {
        id: format!("ap-{}", uuid::Uuid::new_v4()),
        host_id: host.id.clone(),
        host_name: host.name.clone(),
        name: String::new(),
        instructions: String::new(),
        prompt: prompt.to_string(),
        echo,
        created_at: chrono::Utc::now(),
        attempt_id: attempt.map(|a| a.info.attempt_id.clone()),
    };
    let _ = center.audit.append(
        ctx, "auth_prompt_requested", None, Some(&host.name),
        serde_json::json!({"id": item.id, "prompt": prompt, "echo": echo}), None);
    let (tx, rx) = oneshot::channel();
    center.ap_pending.lock().unwrap().insert(item.id.clone(), (item.clone(), tx));
    let _ = center.ap_tx.send(item.clone());
    if let Some(a) = attempt {
        let mut st = a.st.lock().await;
        if !st.terminal() {
            st.phase = AttemptPhase::ChallengeRequired;
            emit_conn(center, &a.info.attempt_id, AttemptPhase::ChallengeRequired, None, None);
        }
    }
    let wait = tokio::time::timeout(DEFAULT_APPROVAL_TIMEOUT, rx);
    tokio::pin!(wait);
    let answered = tokio::select! {
        r = &mut wait => match r {
            Ok(Ok(answer)) => Some(Some(answer)),
            // 取消（空应答通道关闭）/ 待决项消失
            Ok(Err(_)) => Some(None),
            Err(_) => None, // 超时
        },
        _ = async { match attempt { Some(a) => wait_cancelled(a.cancel_rx.clone()).await, None => std::future::pending().await } } => {
            // 取消受理：空应答结算（transport 侧终止认证）
            Some(None)
        }
    };
    match answered {
        Some(Some(answer)) => {
            let _ = center.audit.append(
                ctx, "auth_prompt_answered", None, Some(&host.name),
                serde_json::json!({"id": item.id, "answer_len": answer.chars().count()}), None);
            if answer.is_empty() { Ok(None) } else { Ok(Some(answer)) }
        }
        Some(None) => {
            if let Some(a) = attempt {
                if *a.cancel_rx.borrow() {
                    return Err(Error::Cancelled);
                }
            }
            Ok(None)
        }
        None => {
            center.ap_pending.lock().unwrap().remove(&item.id);
            if let Some(a) = attempt {
                let _ = center.audit.append(
                    ctx, "approval_voided", None, Some(&host.name),
                    serde_json::json!({"attempt_id": a.info.attempt_id, "reason": "gate_timeout", "gate": "auth_prompt"}), None);
            }
            Ok(None)
        }
    }
}

fn spawn_pump(h: Arc<SessionHandle>, mut rx: tokio::sync::broadcast::Receiver<Vec<u8>>) {
    tokio::spawn(async move {
        // 会话级流式解码器（GBK）：多字节序列可跨 chunk 切开，须全程同一实例；
        // 解码后屏态与订阅广播只见 UTF-8（GBK 尾字节撞 ASCII，裸喂会腐蚀屏态）
        let mut decoder = charset::CharsetDecoder::new(h.host.charset);
        loop {
            let mut lost = false;
            loop {
                match tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await {
                    Ok(Ok(data)) => {
                        let data = decoder.feed(&data);
                        // 线性化点内部完成 seq/重放环/订阅广播（C10）
                        h.feed_output(&data).await;
                    }
                    Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                        let _ = h.output_tx.send(OutputEvent::Resync { sid: h.id.clone() });
                    }
                    Ok(Err(broadcast::error::RecvError::Closed)) => {
                        // 通路关闭：冲刷悬空的半个多字节序列（尾字节永远不到 → U+FFFD 落屏）
                        let tail = decoder.flush();
                        if !tail.is_empty() {
                            h.feed_output(&tail).await;
                        }
                        lost = true;
                        break;
                    }
                    Err(_timeout) => {
                        if !h.channel.is_alive().await {
                            lost = true;
                            break;
                        }
                    }
                }
            }
            let _ = lost;
            // 通路关闭：本地 = 进程退出；SSH = 断线 → 重连 + 重确认
            if h.kind != "ssh" {
                *h.state.lock().await = SessionState::Disconnected;
                h.note_transition("本地 shell 退出（Disconnected）").await;
                h.emit_state(SessionState::Disconnected, None, None,
                    Some("本地 shell 已退出".into())).await;
                return;
            }
            h.on_transport_reconnect().await;
            if *h.state.lock().await == SessionState::Disconnected {
                return;
            }
            // 先订阅新通道、再注入集成：远端回显与首个标记提示符不得落入
            // 无订阅者窗口（broadcast 无接收者即丢——并发回归中标记迟到 10s 的根因）
            rx = h.channel.subscribe_output();
            h.reinject_integration().await;
            // 外层循环：以新订阅继续泵
        }
    });
}

/// SSH 远端 shell 集成注入片段（bash/zsh 自动探测；OSC 133 + OSC 7）。
pub fn ssh_integration_snippet() -> String {
    let bash = r#"if [ -n "$BASH_VERSION" ]; then
  __t_prompt(){ __rc=$?; printf '\033]7;file://%s%s\007' "$HOSTNAME" "$PWD"; printf '\033]133;D;%s\007' "$__rc"; printf '\033]133;A\007'; }
  __t_preexec(){ printf '\033]133;C\007'; }
  PROMPT_COMMAND="__t_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  PS1="\[\033]133;B\007\]$PS1"
  PS0="\[\033]133;C\007\]$PS0"
fi"#;
    let zsh = r#"if [ -n "$ZSH_VERSION" ]; then
  __t_precmd(){ __rc=$?; printf '\033]7;file://%s%s\007' "$HOST" "$PWD"; printf '\033]133;D;%s\007' "$__rc"; printf '\033]133;A\007'; printf '\033]133;B\007'; }
  __t_preexec(){ printf '\033]133;C\007'; }
  precmd_functions=(__t_precmd $precmd_functions)
  preexec_functions=(__t_preexec $preexec_functions)
fi"#;
    // 末尾清屏：抹掉上面几行在远端 PTY 的回显（否则用户首连看到满屏集成代码）；
    // printf 是 shell 内建，不依赖外部 clear 二进制。
    format!("{bash}\n{zsh}\nprintf '\\033[2J\\033[H'\n")
}

#[async_trait::async_trait]
impl SessionApi for SessionManager {
    // ---- 主机与凭据 ----
    async fn list_hosts(&self, _ctx: &Actor) -> Result<Vec<Host>> {
        self.ensure_local_host()?;
        self.center.vault.list_hosts()
    }

    async fn upsert_host(&self, ctx: &Actor, host: HostDraft) -> Result<HostId> {
        let id = self.center.vault.upsert_host(&host)?;
        let _ = self.center.audit.append(
            ctx, "host_upsert", None, None,
            serde_json::json!({"host": id, "name": host.name}), None);
        Ok(id)
    }

    async fn delete_host(&self, ctx: &Actor, id: HostId) -> Result<()> {
        self.center.vault.delete_host(&id)?;
        let _ = self.center.audit.append(ctx, "host_delete", None, None, serde_json::json!({"host": id}), None);
        Ok(())
    }

    async fn list_identities(&self, _ctx: &Actor) -> Result<Vec<IdentityMeta>> {
        self.center.vault.list_identities()
    }

    async fn create_identity(&self, ctx: &Actor, req: IdentityReq) -> Result<IdentityMeta> {
        let meta = self.center.vault.create_identity(&req)?;
        let _ = self.center.audit.append(ctx, "identity_create", None, None, serde_json::json!({"id": meta.id, "kind": format!("{:?}", meta.kind)}), None);
        Ok(meta)
    }

    async fn delete_identity(&self, ctx: &Actor, id: IdentityId) -> Result<()> {
        // DF8.4：凭据被存活主机引用时拒绝（附主机名），不落删除
        let refs = self.center.vault.identity_host_refs(&id)?;
        if !refs.is_empty() {
            return Err(Error::IdentityInUse { host_names: refs });
        }
        self.center.vault.delete_identity(&id)?;
        let _ = self.center.audit.append(ctx, "identity_delete", None, None, serde_json::json!({"id": id}), None);
        Ok(())
    }

    // ---- 偏好与主机元数据（C8/R15）----
    async fn get_workspace(&self, _ctx: &Actor) -> Result<Workspace> {
        self.center.vault.workspace()
    }

    async fn set_workspace(&self, ctx: &Actor, ws: Workspace) -> Result<()> {
        self.center.vault.set_workspace(&ws)?;
        let _ = self.center.audit.append(ctx, "workspace_set", None, None,
            serde_json::json!({"chrome": ws.chrome, "schema_version": ws.schema_version, "hostbar": ws.hostbar}), None);
        Ok(())
    }

    async fn set_host_favorite(&self, ctx: &Actor, host_id: HostId, favorite: bool) -> Result<()> {
        self.center.vault.set_host_favorite(&host_id, favorite)?;
        let _ = self.center.audit.append(ctx, "host_favorite", None, None,
            serde_json::json!({"host": host_id, "favorite": favorite}), None);
        Ok(())
    }

    async fn list_host_metadata(&self, _ctx: &Actor) -> Result<Vec<HostMeta>> {
        self.center.vault.list_host_metadata()
    }

    async fn list_recent_hosts(&self, _ctx: &Actor) -> Result<Vec<RecentHost>> {
        // 上限 5（DF8.5）
        self.center.vault.list_recent_hosts(5)
    }

    // ---- 会话 ----
    async fn list_sessions(&self, _ctx: &Actor) -> Result<Vec<SessionInfo>> {
        let handles: Vec<Arc<SessionHandle>> = {
            let sessions = self.sessions.lock().unwrap();
            sessions.values().cloned().collect()
        };
        let mut out = Vec::new();
        for h in handles {
            out.push(SessionInfo {
                id: h.id.clone(),
                host_id: h.host.id.clone(),
                host_name: h.host.name.clone(),
                kind: h.kind.clone(),
                state: *h.state.lock().await,
                control_owner: *h.owner.lock().await,
                created_at: h.created_at,
                integration: *h.integration.lock().unwrap(),
                ever_agent_owned: h.ever_agent_owned.load(std::sync::atomic::Ordering::SeqCst),
            });
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    /// R41（§6.6/S09）连接详情：连接时 Host 快照（handle 持有构造期副本，主机配置此后
    /// 被编辑/删除都不影响）+ 真实创建时刻 + 运行时态。
    async fn session_detail(&self, _ctx: &Actor, sid: SessionId) -> Result<session_api::SessionDetail> {
        let h = {
            let sessions = self.sessions.lock().unwrap();
            sessions.get(&sid).cloned()
        }
        .ok_or(Error::SessionNotFound)?;
        // 先取运行时态再组装：async 锁守卫不能跨到返回表达式末尾
        let state = *h.state.lock().await;
        let owner = *h.owner.lock().await;
        let integration = *h.integration.lock().unwrap();
        Ok(session_api::SessionDetail {
            id: h.id.clone(),
            host_id: h.host.id.clone(),
            host_name: h.host.name.clone(),
            kind: h.kind.clone(),
            state,
            control_owner: owner,
            created_at: h.created_at,
            integration,
            address: h.host.address.clone(),
            port: h.host.port,
            username: h.host.username.clone(),
            auth_type: h.host.auth_type,
            fingerprint: h.host.fingerprint.clone(),
            charset: h.host.charset,
        })
    }

    async fn create_session(&self, ctx: &Actor, req: CreateSessionReq) -> Result<SessionId> {
        // v1 兼容路径（C1）：同步语义不变，不经 attempt 注册表。
        self.create_session_inner(ctx, req, None).await
    }

    async fn begin_connection(
        &self,
        ctx: &Actor,
        host_id: HostId,
        opts: BeginConnectionOpts,
    ) -> Result<AttemptInfo> {
        self.begin_connection_on(ctx, host_id, opts).await
    }

    async fn connection_status(&self, ctx: &Actor, attempt_id: AttemptId) -> Result<AttemptInfo> {
        let entry = self
            .attempts
            .lock()
            .unwrap()
            .get(&attempt_id)
            .cloned()
            .ok_or(Error::SessionNotFound)?;
        // 跨 Actor 域不可见（DC1.5 互不可见；与 cancel 同口径 NotFound 不泄露存在性）
        if entry.info.actor != actor_domain(ctx) {
            return Err(Error::SessionNotFound);
        }
        let st = entry.st.lock().await;
        Ok(entry.snapshot(&st))
    }

    async fn cancel_connection(&self, ctx: &Actor, attempt_id: AttemptId) -> Result<CancelOutcome> {
        let weak = self.self_weak.lock().unwrap().clone();
        let this = weak
            .and_then(|w| w.upgrade())
            .ok_or_else(|| Error::Storage("SessionManager 未装配 Arc".into()))?;
        this.cancel_connection_on(ctx, attempt_id).await
    }

    fn subscribe_connections(&self) -> broadcast::Receiver<ConnectionEvent> {
        self.center.conn_tx.subscribe()
    }

    fn subscribe_shell_integration(&self) -> broadcast::Receiver<ShellIntegrationEvent> {
        self.center.shell_tx.subscribe()
    }

    async fn close_session(&self, ctx: &Actor, sid: SessionId) -> Result<()> {
        let h = self
            .sessions
            .lock()
            .unwrap()
            .get(&sid)
            .cloned()
            .ok_or(Error::SessionNotFound)?;
        if !ctx.is_human() && *h.owner.lock().await == ControlOwner::Human {
            return Err(Error::ControlTakenByHuman);
        }
        *h.state.lock().await = SessionState::Closed;
        h.channel.close().await?;
        self.sessions.lock().unwrap().remove(&sid);
        // 会话关闭即作废其待决审批卡（T44 复核中-1）：否则 Agent 的 forward 卡在
        // 会话关闭后仍可被批准，而 transport 层 Local/Dynamic 分支 bind 不查会话
        // 状态——会造出 forwards_list 已查不到、也无入口可停的僵尸监听（泄漏到进程
        // 退出）。与接管的作废口径一致，只是触发源是关闭。
        let voided: Vec<ApprovalId> = {
            let items = self.center.items.lock().unwrap();
            items
                .iter()
                .filter(|(_, it)| it.session_id == sid && it.status == ApprovalStatus::Pending)
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in voided {
            let it = self.center.items.lock().unwrap().get(&id).cloned();
            if let Some(mut it) = it {
                it.status = ApprovalStatus::Voided;
                let _ = self.center.vault.save_approval(&it);
                // 内存表同步写回（mark_status 同口径）——同 get().cloned() 只改副本的坑
                if let Some(slot) = self.center.items.lock().unwrap().get_mut(&id) {
                    slot.status = ApprovalStatus::Voided;
                }
                // 作废必须留痕（五人走查·老周）：卡片凭空消失而审计无对应条目，
                // 事后无法回答「这张卡为何没了」。与接管的作废口径一致。
                let _ = self.center.audit.append(
                    ctx, "approval_voided", Some(&sid), Some(&it.command),
                    serde_json::json!({"reason": "session_closed", "agent": it.agent_id}),
                    Some(&id));
                let _ = self.center.approvals_tx.send(ApprovalEvent::Updated(it));
            }
            // 唤醒等待方（wait_approval 的 Voided 臂即作废返回，Agent 不再空等 120s）
            if let Some(tx) = self.center.decisions.lock().unwrap().remove(&id) {
                let _ = tx.send(DecisionMsg::Voided);
            }
        }
        self.center.vault.close_session_row(&sid)?;
        let _ = self.center.audit.append(ctx, "session_closed", Some(&sid), None, serde_json::json!({}), None);
        Ok(())
    }

    async fn resize(&self, _ctx: &Actor, sid: SessionId, cols: u16, rows: u16) -> Result<()> {
        let h = self.get(&sid)?;
        {
            let mut s = h.screen.lock().await;
            s.resize(cols, rows);
        }
        h.channel.resize(cols, rows).await
    }

    // ---- exec ----
    async fn exec(
        &self,
        ctx: &Actor,
        sid: SessionId,
        cmd: &str,
        opts: ExecOpts,
    ) -> Result<ExecResult> {
        let h = self.get(&sid)?;
        // Agent 策略刷新（vault → 引擎）
        if let Actor::Agent { client_id } = ctx {
            let policy = self.center.vault.load_policy(client_id);
            self.center.engine.set_policy(client_id, policy);
        }
        h.exec(ctx, cmd, opts).await
    }

    async fn cancel_exec(&self, ctx: &Actor, sid: SessionId, exec_id: ExecId) -> Result<()> {
        let h = self.get(&sid)?;
        let found = h.live_execs.lock().unwrap().get(&exec_id).map(|c| c.clone());
        match found {
            Some(c) => {
                c.cancel();
                let _ = self.center.audit.append(ctx, "exec_cancel", Some(&sid), None, serde_json::json!({"exec": exec_id}), None);
                Ok(())
            }
            None => Err(Error::InvalidInput("exec not found or finished".into())),
        }
    }

    // ---- 交互式 ----
    async fn read_screen(&self, _ctx: &Actor, sid: SessionId) -> Result<ScreenSnapshot> {
        let h = self.get(&sid)?;
        let s = h.screen.lock().await;
        let (row, col) = s.cursor();
        Ok(ScreenSnapshot {
            cols: s.config().cols,
            rows: s.config().rows,
            text: s.screen_only_text(),
            cursor_row: row,
            cursor_col: col,
            alt_screen: s.alt_screen(),
        })
    }

    async fn send_keys(&self, ctx: &Actor, sid: SessionId, keys: &str) -> Result<()> {
        let h = self.get(&sid)?;
        match ctx {
            Actor::Human => {
                *h.last_human_input.lock().await = Some(std::time::Instant::now());
                // 人类键入同样要登记：否则 B→C 键入捕获缺失，命令块 command 为空（简报/交接失明）。
                // ESC 开头的 meta/导航序列（⌥← 发 \x1bb、⌥⌫ 发 \x17 等）不是命令文本——
                // 登记的话裸 ESC 后的字母会残留在简报里（"…ddd"+\x1bb+Z 显示成 "dddbZ"）。
                if !keys.contains('\x1b') {
                    let mut s = h.screen.lock().await;
                    s.register_outgoing(keys.as_bytes(), term_core::BlockSource::Human);
                }
                h.channel.write(&charset::encode(h.host.charset, keys)).await
            }
            Actor::Agent { client_id } => {
                if *h.owner.lock().await == ControlOwner::Human {
                    return Err(Error::ControlTakenByHuman);
                }
                // 重确认期间 Agent 仅开放 exec 白名单核实（与 exec 同口径，L1 §3.1）
                if *h.state.lock().await == SessionState::Reconfirming {
                    return Err(Error::ReconfirmingPending);
                }
                // 会话级授权：一次审批，接管或会话结束失效
                if !h.send_keys_auth.lock().unwrap().contains(client_id) {
                    let eval = tinyssh_approval::Evaluation {
                        verdict: tinyssh_approval::SegmentVerdict::NeedsApproval,
                        segments: vec![SegmentReport {
                            segment: format!("send_keys {keys:?}"),
                            verdict: "pending: 会话级授权（一次审批，本次会话内有效）".into(),
                        }],
                    };
                    let (trace, edited) = h
                        .wait_approval(ctx, client_id, &"send_keys".to_string(), &format!("send_keys {keys:?}"), &eval, false, false, CancellationToken::new())
                        .await?;
                    let _ = trace;
                    // 键序列无法从编辑文本回解（复审②：静默按原文执行 = 审计失真）
                    SessionManager::reject_edited_approval(&edited, &format!("send_keys {keys:?}"), "send_keys 审批")?;
                    let _ = trace;
                    h.send_keys_auth.lock().unwrap().insert(client_id.clone());
                    // 授权后本次按键照常执行（逐次写入留痕）
                }
                // 人类输入优先：2s 内有人类输入 → 延迟排队
                let wait = {
                    let last = *h.last_human_input.lock().await;
                    match last {
                        Some(t) => HUMAN_INPUT_PRIORITY_WINDOW
                            .checked_sub(t.elapsed())
                            .unwrap_or_default(),
                        None => std::time::Duration::ZERO,
                    }
                };
                if !wait.is_zero() {
                    tokio::time::sleep(wait).await;
                }
                let _ = self.center.audit.append(
                    ctx, "send_keys", Some(&sid), Some(keys), serde_json::json!({}), None);
                h.channel.write(&charset::encode(h.host.charset, keys)).await
            }
        }
    }

    async fn wait_output(&self, _ctx: &Actor, sid: SessionId, opts: WaitOpts) -> Result<OutputChunk> {
        let h = self.get(&sid)?;
        let timeout_d = opts.timeout.unwrap_or(DEFAULT_WAIT_TIMEOUT);
        let quiet_ms = opts.quiet_ms.unwrap_or(DEFAULT_QUIET_MS);
        let re = match &opts.regex {
            Some(r) => Some(
                regex::Regex::new(r)
                    .map_err(|e| Error::InvalidInput(format!("bad regex: {e}")))?,
            ),
            None => None,
        };
        let deadline = tokio::time::Instant::now() + timeout_d;
        let (watermark, notify) = {
            let s = h.screen.lock().await;
            (s.lossless_len(), s.lossless_notify())
        };
        loop {
            {
                let s = h.screen.lock().await;
                let wm = watermark.min(s.lossless_len());
                let text = s.text_since(wm);
                let matched = re.as_ref().map(|r| r.is_match(&text)).unwrap_or(false);
                if matched {
                    return Ok(OutputChunk { text, matched: true, truncated_to_cap: false });
                }
                let quiet = std::time::Duration::from_millis(quiet_ms);
                let is_quiet = s
                    .tail_ts()
                    .map(|t| (chrono::Utc::now() - t).to_std().unwrap_or_default() >= quiet)
                    .unwrap_or(false);
                if is_quiet && !text.is_empty() {
                    return Ok(OutputChunk { text, matched: false, truncated_to_cap: false });
                }
            }
            tokio::select! {
                _ = notify.notified() => {}
                _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {}
                _ = tokio::time::sleep_until(deadline) => return Err(Error::ExecTimeout),
            }
        }
    }

    async fn set_control(
        &self,
        ctx: &Actor,
        sid: SessionId,
        owner: ControlOwner,
        opts: ControlOpts,
    ) -> Result<TakeoverReport> {
        if !ctx.is_human() {
            return Err(Error::InvalidActor);
        }
        let h = self.get(&sid)?;
        match owner {
            ControlOwner::Human => h.takeover(opts).await,
            ControlOwner::Agent => h.handback().await,
        }
    }

    /// C2（DC2.2）：首次委托——人类把会话交 Agent 并附目标。内部走既有 handback
    /// 受控转换（接管/作废语义不变）+ 独立审计 session_delegated；取消对话框不产生
    /// 任何调用（无 cancel 路径依赖）。仅 Human 可调。
    async fn delegate_session(&self, ctx: &Actor, sid: SessionId, goal: Option<String>) -> Result<()> {
        if !ctx.is_human() {
            return Err(Error::InvalidActor);
        }
        let h = self.get(&sid)?;
        h.handback().await?;
        if let Some(g) = &goal {
            *h.goal.lock().unwrap() = Some(g.clone());
        }
        let _ = self.center.audit.append(
            ctx, "session_delegated", Some(&sid), None,
            serde_json::json!({"goal_present": goal.is_some()}), None);
        Ok(())
    }

    /// C3（DC3.3）：能力只读快照，任何 Actor 可查。
    async fn shell_capability(&self, _ctx: &Actor, sid: SessionId) -> Result<ShellCapability> {
        let h = self.get(&sid)?;
        let s = h.screen.lock().await;
        Ok(ShellCapability {
            integration_present: s.shell_integration_present(),
            prompt_ready: s.prompt_ready(),
            host_setting: h.host.shell_integration == Some(true),
        })
    }

    // ---- 传输 ----
    async fn upload(
        &self,
        ctx: &Actor,
        sid: SessionId,
        local: &Path,
        remote: &str,
        collision: Option<CollisionDecision>,
    ) -> Result<TransferHandle> {
        self.transfer(ctx, sid, local.to_path_buf(), remote.to_string(), true, collision, None)
            .await
    }

    async fn download(
        &self,
        ctx: &Actor,
        sid: SessionId,
        remote: &str,
        local: &Path,
        collision: Option<CollisionDecision>,
    ) -> Result<TransferHandle> {
        self.transfer(ctx, sid, local.to_path_buf(), remote.to_string(), false, collision, None)
            .await
    }

    async fn cancel_transfer(&self, _ctx: &Actor, t: TransferId) -> Result<()> {
        // 取句柄：终态幂等返回（重复点取消/晚到取消无害）；进行中 → Cancelling 可见
        // 再置位 token（传输循环尽快返回 Cancelled，终态由任务收尾统一落账）。
        let (cancel, sid) = {
            let reg = self.transfers.lock().unwrap();
            let e = reg.get(&t).ok_or(Error::InvalidInput("transfer not found".into()))?;
            if e.task.status.is_terminal() {
                return Ok(());
            }
            (e.cancel.clone(), e.task.session_id.clone())
        };
        let _ = self.center.audit.append(
            &Actor::Human,
            "transfer_cancel",
            Some(&sid),
            None,
            serde_json::json!({ "transfer": t }),
            None,
        );
        self.transfer_apply(&t, |task| {
            if !task.status.is_terminal() {
                task.status = TransferStatus::Cancelling;
            }
        });
        cancel.cancel();
        Ok(())
    }

    /// C6/R34：冲突裁决提交（仅人类 UI；仅 AwaitingDecision 可调）。
    /// 乐观锁：revision 不匹配 → StaleDecision{当前 revision}（任务不因本次
    /// 提交推进）；重复提交/非待决态 → InvalidTransferState。生效 = 冲突通道
    /// 投递决定 + collision_decision 落账（revision+1 事件帧出），任务按唯一
    /// 发布决策表推进。
    async fn submit_collision_decision(
        &self,
        ctx: &Actor,
        t: TransferId,
        decision: CollisionDecision,
        expect_revision: u64,
    ) -> Result<TransferTask> {
        if !ctx.is_human() {
            // Agent 任务/调用方均不在此裁决（DF6.2：Agent 冲突走结构化错误）
            let state = self
                .transfers
                .lock()
                .unwrap()
                .get(&t)
                .map(|e| e.task.status)
                .ok_or(Error::InvalidInput("transfer not found".into()))?;
            return Err(Error::InvalidTransferState { task_id: t, state });
        }
        let (snapshot, tx) = {
            let mut reg = self.transfers.lock().unwrap();
            let e = reg
                .get_mut(&t)
                .ok_or(Error::InvalidInput("transfer not found".into()))?;
            if e.task.status != TransferStatus::AwaitingDecision {
                return Err(Error::InvalidTransferState { task_id: t, state: e.task.status });
            }
            if e.task.revision != expect_revision {
                return Err(Error::StaleDecision { expect_revision: e.task.revision });
            }
            let Some(tx) = e.decision_tx.take() else {
                return Err(Error::InvalidTransferState { task_id: t, state: e.task.status });
            };
            e.task.collision_decision = Some(decision);
            e.task.revision += 1;
            let _ = self.transfer_tx.send(e.task.clone());
            (e.task.clone(), tx)
        };
        let _ = self.center.audit.append(
            &Actor::Human,
            "transfer_decision",
            Some(&snapshot.session_id),
            Some(&snapshot.dest),
            serde_json::json!({ "transfer": t, "decision": decision }),
            None,
        );
        // 投递失败=等待端已消失（取消竞窗）：任务终态已落，本次提交按过期处置
        if tx.send(decision).is_err() {
            return Err(Error::StaleDecision { expect_revision: snapshot.revision });
        }
        Ok(snapshot)
    }

    /// C5/R34：人类 UI 显式作废过期决策卡。AwaitingDecision → 作废为 Cancelled
    ///（temp 确未提交即清，审计 transfer_decision_rejected）；否则幂等 no-op。
    async fn reject_expired_decision(&self, ctx: &Actor, t: TransferId) -> Result<()> {
        if !ctx.is_human() {
            let state = self
                .transfers
                .lock()
                .unwrap()
                .get(&t)
                .map(|e| e.task.status)
                .ok_or(Error::InvalidInput("transfer not found".into()))?;
            return Err(Error::InvalidTransferState { task_id: t, state });
        }
        let sid = {
            let mut reg = self.transfers.lock().unwrap();
            let e = reg.get_mut(&t).ok_or(Error::InvalidInput("transfer not found".into()))?;
            if e.task.status != TransferStatus::AwaitingDecision {
                return Ok(()); // 幂等：不在待决态即无卡可作废
            }
            e.decision_tx.take(); // 等待端收到通道关闭 → 作废收尾
            e.task.session_id.clone()
        };
        let _ = self.center.audit.append(
            &Actor::Human,
            "transfer_decision_rejected",
            Some(&sid),
            None,
            serde_json::json!({ "transfer": t }),
            None,
        );
        Ok(())
    }

    /// C6/R34：OutcomeUnknown 复核（仅人类 UI）。唯一绑定证据=journal verified
    /// 标记：true → Succeeded{verified}；false → 保持 OutcomeUnknown（同大小/
    /// temp 消失/摘要等单独不足以判定——契约明文；不自动重发/覆盖/清理）。
    async fn verify_transfer_outcome(&self, ctx: &Actor, t: TransferId) -> Result<TransferTask> {
        if !ctx.is_human() {
            let state = self
                .transfers
                .lock()
                .unwrap()
                .get(&t)
                .map(|e| e.task.status)
                .ok_or(Error::InvalidInput("transfer not found".into()))?;
            return Err(Error::InvalidTransferState { task_id: t, state });
        }
        let (sid, now_verified) = {
            let reg = self.transfers.lock().unwrap();
            let e = reg.get(&t).ok_or(Error::InvalidInput("transfer not found".into()))?;
            if e.task.status != TransferStatus::OutcomeUnknown {
                return Err(Error::InvalidTransferState { task_id: t, state: e.task.status });
            }
            (e.task.session_id.clone(), e.verified)
        };
        let journal = self.center.vault.transfer_journal_get(&t)?;
        let verified = now_verified || journal.map(|(_, v)| v).unwrap_or(false);
        let now = now_unix();
        if verified {
            // 「已确认提交归成功」——journal 证据绑定本次发布（发布原语成功后落账）
            {
                let mut reg = self.transfers.lock().unwrap();
                if let Some(e) = reg.get_mut(&t) {
                    e.verified = true; // 与 journal 同步（restart 场景 journal 已为 true）
                }
            }
            self.transfer_apply(&t, |task| {
                task.status = TransferStatus::Succeeded;
                task.error = None;
                if task.finished_at.is_none() {
                    task.finished_at = Some(now);
                }
            });
            let _ = self.center.audit.append(
                &Actor::Human,
                "transfer_outcome_verified",
                Some(&sid),
                None,
                serde_json::json!({ "transfer": t, "verified": true }),
                None,
            );
        } else {
            // 无绑定证据：保持未知（journal 行保持 Committing/verified=false 编码，
            // 重启恢复面继续可见；本次仅刷新复核说明，revision+1 事件帧出）
            {
                let mut reg = self.transfers.lock().unwrap();
                if let Some(e) = reg.get_mut(&t) {
                    e.task.error = Some("重新核实：无绑定证据（verified=false），保持结果未知——temp 与恢复资料保留".into());
                    e.task.revision += 1;
                    let snapshot = e.task.clone();
                    let _ = self.transfer_tx.send(snapshot.clone());
                }
            }
            let _ = self.center.audit.append(
                &Actor::Human,
                "transfer_outcome_reverify",
                Some(&sid),
                None,
                serde_json::json!({ "transfer": t, "verified": false }),
                None,
            );
        }
        let reg = self.transfers.lock().unwrap();
        reg.get(&t).map(|e| e.task.clone()).ok_or(Error::InvalidInput("transfer not found".into()))
    }

    // C5（§547）：注册表全量快照（创建倒序）。事件可丢，查询是权威对账面。
    async fn list_transfers(&self, _ctx: &Actor) -> Result<Vec<TransferTask>> {
        let mut v: Vec<TransferTask> = self
            .transfers
            .lock()
            .unwrap()
            .values()
            .map(|e| e.task.clone())
            .collect();
        v.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
        Ok(v)
    }

    /// C5/R35：失败重试（编排面同 transfer；见 retry_transfer 文档）。
    async fn retry_transfer(&self, ctx: &Actor, task_id: TransferId) -> Result<TransferHandle> {
        SessionManager::retry_transfer(self, ctx, &task_id).await
    }

    // 人类浏览远端目录（FR-7）：只读、不经审批、不入审计（浏览非动作）；
    // Agent 无此入口（MCP 无 list 工具——上传下载仍走 upload/download 必审口径）
    async fn sftp_list(&self, ctx: &Actor, sid: SessionId, path: &str) -> Result<Vec<DirEntryS>> {
        if !ctx.is_human() {
            return Err(Error::InvalidInput("sftp_list 仅人类浏览入口".into()));
        }
        let h = self.get(&sid)?;
        h.channel.list_dir(path).await
    }

    // C4（R30）：路径规范化（canonical path / 初始目录）。Human 浏览口径同 sftp_list。
    async fn sftp_resolve_path(
        &self,
        ctx: &Actor,
        sid: SessionId,
        path: Option<String>,
    ) -> Result<PathResolved> {
        if !ctx.is_human() {
            return Err(Error::InvalidInput("sftp_resolve_path 仅人类浏览入口".into()));
        }
        let h = self.get(&sid)?;
        h.channel.resolve_path(path.as_deref()).await
    }

    // C4（R30）：条目元数据（kind/symlink/未知字段）。Human 浏览口径同 sftp_list。
    async fn sftp_stat(&self, ctx: &Actor, sid: SessionId, path: String) -> Result<EntryStat> {
        // R34：Agent 放行（只读元数据）——DF6.2 MCP collision=fail 预检结构化
        // ConflictDetected 需目标 stat；浏览面（sftp_list）仍仅人类（R30 语义不变）
        let h = self.get(&sid)?;
        let st = h.channel.stat_entry(&path).await?;
        if !ctx.is_human() {
            let _ = self
                .center
                .audit
                .append(ctx, "sftp_stat", Some(&sid), Some(&path), serde_json::json!({ "remote": path }), None);
        }
        Ok(st)
    }

    // ---- 端口转发（FR-8，T42/T44）：人类直建；Agent 经逐段审批（V1 收口）；
    // 查询任何 Actor 可用（PRD「MCP 可查询状态」）。转发是持续存在的动作，审计留痕。----
    async fn list_forwards(&self, _ctx: &Actor, sid: SessionId) -> Result<Vec<ForwardInfo>> {
        let h = self.get(&sid)?;
        h.channel.list_forwards().await
    }

    async fn start_forward(&self, ctx: &Actor, sid: SessionId, spec: ForwardSpec) -> Result<ForwardId> {
        let h = self.get(&sid)?;
        // 审计可核对性（复核低-5）：forward_start 事件挂 approval_id（与 exec 同款）；
        // 人类直建时为 None
        let mut approval_id: Option<String> = None;
        if let Actor::Agent { client_id } = ctx {
            // 接管期间 Agent 不得新开隧道（复核低-6，与 exec 的 ControlTakenByHuman 同语义）
            if *h.owner.lock().await == ControlOwner::Human {
                return Err(Error::ControlTakenByHuman);
            }
            // Agent 建隧道 = 网络暴露面（T44 V1 收口）：与 exec/传输同款逐段审批，
            // 单段即转发描述本身；拒绝/超时/接管作废由 wait_approval 语义统一处理
            let desc = SessionManager::forward_desc(&spec);
            let eval = tinyssh_approval::Evaluation {
                verdict: tinyssh_approval::SegmentVerdict::NeedsApproval,
                segments: vec![SegmentReport {
                    segment: desc.clone(),
                    verdict: "pending: 端口转发（建立网络隧道）".into(),
                }],
            };
            let (trace, edited) = h.wait_approval(ctx, client_id, &"forward_start".to_string(), &desc, &eval, false, false, CancellationToken::new()).await?;
            approval_id = trace.approval_id;
            // 编辑后批准不支持（复核中-2，复审②统一拦截）：ForwardSpec 无法从人类
            // 编辑后的中文描述回解——出现编辑即拒绝，审计不会出现「记了 edited、
            // 实建原始」的失真
            SessionManager::reject_edited_approval(&edited, &desc, "端口转发审批")?;
            // 审批等待期间会话被关闭的极窄竞窗（复核中-1 双保险；主修在 close_session
            // 作废待决卡）：close 与 decide 并发时卡已生效、bind 仍会执行——此处复查
            if !self.sessions.lock().unwrap().contains_key(&sid) {
                return Err(Error::SessionNotFound);
            }
        }
        let fid = h.channel.start_forward(spec.clone()).await?;
        let _ = h.center.audit.append(
            ctx, "forward_start", Some(&sid), None,
            serde_json::json!({ "forward": fid, "spec": spec }), approval_id.as_deref());
        Ok(fid)
    }

    async fn stop_forward(&self, ctx: &Actor, sid: SessionId, fid: ForwardId) -> Result<()> {
        let h = self.get(&sid)?;
        let mut approval_id: Option<String> = None;
        if let Actor::Agent { client_id } = ctx {
            // 接管期间 Agent 不得停隧道（复核低-6；停隧道可能断生产链路，人类主权）
            if *h.owner.lock().await == ControlOwner::Human {
                return Err(Error::ControlTakenByHuman);
            }
            // 停隧道可能断生产链路：Agent 同样走审批（人类停转发放行，风险自担）。
            // 卡面 command 加「停止」前缀（复核低-5）：与建卡的 desc 同源文本在
            // 审批时间线上不可区分建/停
            let current = h.channel.list_forwards().await?;
            let desc = match current.iter().find(|f| f.id == fid) {
                Some(f) => format!("停止 {}", SessionManager::forward_desc(&f.spec)),
                None => format!("停止端口转发 {fid}"),
            };
            let eval = tinyssh_approval::Evaluation {
                verdict: tinyssh_approval::SegmentVerdict::NeedsApproval,
                segments: vec![SegmentReport {
                    segment: desc.clone(),
                    verdict: "pending: 停止端口转发（可能中断链路）".into(),
                }],
            };
            let (trace, edited) = h.wait_approval(ctx, client_id, &"forward_stop".to_string(), &desc, &eval, false, false, CancellationToken::new()).await?;
            approval_id = trace.approval_id;
            SessionManager::reject_edited_approval(&edited, &desc, "停止端口转发审批")?;
        }
        h.channel.stop_forward(&fid).await?;
        let _ = h.center.audit.append(
            ctx, "forward_stop", Some(&sid), None,
            serde_json::json!({ "forward": fid }), approval_id.as_deref());
        Ok(())
    }

    // ---- 审批 ----
    async fn list_approvals(&self, _ctx: &Actor, f: ApprovalFilter) -> Result<Vec<ApprovalItem>> {
        // R42（§6.7）「可用目的」按会话**当前**目标投影：人类在请求之后补写任务目标，
        // 复核时也应看得到（目的缺失就是缺失，不拿旧快照冒充当前意图）。
        let goals: HashMap<SessionId, Option<String>> = self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(sid, h)| (sid.clone(), h.goal.lock().unwrap().clone()))
            .collect();
        let items = self.center.items.lock().unwrap();
        Ok(items
            .values()
            .filter(|it| {
                f.session_id.as_ref().map(|s| &it.session_id == s).unwrap_or(true)
                    && f.agent_id.as_ref().map(|a| &it.agent_id == a).unwrap_or(true)
                    && (!f.pending_only || it.status == ApprovalStatus::Pending)
            })
            .map(|it| {
                let mut out = it.clone();
                // 严格按会话**当前**目标投影：会话已不在列表（已关闭）则无当前目标 → 明确缺失，
                // 不拿创建期快照冒充当前意图。
                out.purpose = goals.get(&it.session_id).cloned().flatten();
                out
            })
            .collect())
    }

    fn subscribe_approvals(&self) -> broadcast::Receiver<ApprovalEvent> {
        self.center.approvals_tx.subscribe()
    }

    fn subscribe_forwards(&self) -> broadcast::Receiver<session_api::ForwardEvent> {
        self.center.forwards_tx.subscribe()
    }

    async fn decide_approval(&self, ctx: &Actor, id: ApprovalId, d: Decision) -> Result<()> {
        if !ctx.is_human() {
            return Err(Error::InvalidActor);
        }
        let status = self.center.vault.approval_status(&id)?;
        if matches!(status, Some(ApprovalStatus::Voided)) {
            return Err(Error::InvalidInput("审批已作废（接管或会话关闭），不可再生效".into()));
        }
        let tx = self.center.decisions.lock().unwrap().remove(&id);
        match tx {
            Some(tx) => {
                // 审计必须自证「实际放行了什么」：编辑后批准以 edited 文本为准，
                // 否则时间线上只有「审批决定」四个字，追责时无从核对（PV R1）。
                let item = self.center.items.lock().unwrap().get(&id).cloned();
                let (sid, cmd, decision_key) = match &d {
                    Decision::Approve => (
                        item.as_ref().map(|i| i.session_id.clone()),
                        item.as_ref().map(|i| i.command.clone()),
                        "approve",
                    ),
                    Decision::ApproveEdited(c) => (
                        item.as_ref().map(|i| i.session_id.clone()),
                        Some(c.clone()),
                        "approve_edited",
                    ),
                    // 拒绝同样自证「拒的是什么」：审计留痕对称（五人走查·陈工）——
                    // 只有批准带命令全文而拒绝不带，追责时无法核对被拒内容
                    Decision::Deny => (
                        item.as_ref().map(|i| i.session_id.clone()),
                        item.as_ref().map(|i| i.command.clone()),
                        "deny",
                    ),
                };
                let _ = self.center.audit.append(
                    ctx, "approval_decision",
                    sid.as_deref(), cmd.as_deref(),
                    serde_json::json!({"decision": decision_key}), Some(&id));
                tx.send(DecisionMsg::Decide(d))
                    .map_err(|_| Error::Storage("decision receiver dropped".into()))
            }
            None => Err(Error::InvalidInput("no pending approval with this id".into())),
        }
    }

    // ---- 主机指纹门（路线图⑤ TOFU）----
    async fn pending_host_keys(&self, _ctx: &Actor) -> Result<Vec<PendingHostKey>> {
        Ok(self
            .center
            .hk_pending
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect())
    }

    fn subscribe_host_keys(&self) -> broadcast::Receiver<PendingHostKey> {
        self.center.hk_tx.subscribe()
    }

    async fn decide_host_key(&self, ctx: &Actor, id: &str, accept: bool) -> Result<()> {
        if !ctx.is_human() {
            return Err(Error::InvalidActor);
        }
        let tx = self.center.hk_decisions.lock().unwrap().remove(id);
        let item = self.center.hk_pending.lock().unwrap().remove(id);
        match (tx, item) {
            (Some(tx), Some(item)) => {
                let _ = self.center.audit.append(
                    ctx, "host_key_decision", None, Some(&item.host_name),
                    serde_json::json!({"accept": accept, "issue": format!("{:?}", item.issue), "fingerprint": item.fingerprint}), None);
                tx.send(accept)
                    .map_err(|_| Error::Storage("host key gate receiver dropped".into()))
            }
            _ => Err(Error::InvalidInput("no pending host key with this id".into())),
        }
    }

    // ---- 2FA 人工应答门（路线图⑩）----
    async fn pending_auth_prompts(&self, _ctx: &Actor) -> Result<Vec<PendingAuthPrompt>> {
        Ok(self
            .center
            .ap_pending
            .lock()
            .unwrap()
            .values()
            .map(|(item, _)| item.clone())
            .collect())
    }

    fn subscribe_auth_prompts(&self) -> broadcast::Receiver<PendingAuthPrompt> {
        self.center.ap_tx.subscribe()
    }

    async fn answer_auth_prompt(&self, ctx: &Actor, id: &str, answer: &str) -> Result<()> {
        if !ctx.is_human() {
            return Err(Error::InvalidActor);
        }
        let (item, tx) = self
            .center
            .ap_pending
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| Error::InvalidInput("no pending auth prompt with this id".into()))?;
        // 空串 = 取消：oneshot 关闭让 gate 返回 None；非空送应答
        if answer.is_empty() {
            let _ = self.center.audit.append(
                ctx, "auth_prompt_answered", None, Some(&item.host_name),
                serde_json::json!({"id": item.id, "cancelled": true}), None);
            drop(tx);
            Ok(())
        } else {
            tx.send(answer.to_string())
                .map_err(|_| Error::Storage("auth prompt gate receiver dropped".into()))
        }
    }

    // ---- 审计 ----
    async fn query_audit(&self, _ctx: &Actor, f: AuditFilter) -> Result<AuditPage> {
        self.center.audit.query(&f)
    }

    async fn export_audit(&self, _ctx: &Actor, f: AuditFilter, to: &Path) -> Result<()> {
        self.center.audit.export(&f, to)?;
        Ok(())
    }

    // ---- 简报 ----
    async fn get_session_brief(&self, _ctx: &Actor, sid: SessionId) -> Result<SessionBrief> {
        let h = self.get(&sid)?;
        Ok(brief::compute(&h).await)
    }

    // ---- 任务目标/交接留言（R9：人类→Agent 委托入口）----
    async fn set_session_goal(&self, ctx: &Actor, sid: SessionId, goal: Option<String>) -> Result<()> {
        if !ctx.is_human() {
            return Err(Error::InvalidActor);
        }
        let h = self.get(&sid)?;
        // 空串归一 None（清除语义）
        let goal = goal.and_then(|g| {
            let t = g.trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        });
        *h.goal.lock().unwrap() = goal.clone();
        let _ = self.center.audit.append(
            ctx,
            "goal_set",
            Some(&sid),
            goal.as_deref(),
            serde_json::json!({ "cleared": goal.is_none() }),
            None,
        );
        h.note_transition(match &goal {
            Some(_) => "人类更新任务目标（Agent 读简报可见）",
            None => "人类清除任务目标",
        })
        .await;
        Ok(())
    }

}

impl SessionManager {
    // ---- C5（R32）注册表辅助：节流合并 + journal 落库 ----

    /// 注册新任务（Queued）并立即对外发一帧（revision 从 1 起）。
    fn transfer_register(&self, task: TransferTask, cancel: CancellationToken) {
        let tid = task.id.clone();
        let now = std::time::Instant::now();
        let _ = self.transfer_tx.send(task.clone());
        self.transfers.lock().unwrap().insert(
            tid,
            TransferRegEntry {
                task,
                cancel,
                last_emit: now,
                last_journal: now,
                decision_tx: None,
                verified: false,
            },
        );
    }

    /// C6/R34 DF6.4：同目标锁（canonical path 键；持有至任务终态——本客户端
    /// 内同目标任务串行；外部写入由预检/复检/发布原语防线兜底）。
    fn target_lock(&self, key: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
        self.target_locks
            .lock()
            .unwrap()
            .entry(key.to_string())
            .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// 变更任务并按节奏对外发帧/落 journal：状态变化即时发；进度合并 ≥200ms
    ///（§560 ~5 次/秒/任务）；journal 状态变化必写、纯进度 ≥1s 一写。
    /// R34：journal 行随写 verified 证据位（提交窗口同步）。
    fn transfer_apply(&self, tid: &TransferId, mutate: impl FnOnce(&mut TransferTask)) {
        let now = std::time::Instant::now();
        let (emit_task, journal_task) = {
            let mut reg = self.transfers.lock().unwrap();
            let Some(e) = reg.get_mut(tid) else { return };
            let before = e.task.status;
            mutate(&mut e.task);
            e.task.revision += 1;
            let changed = e.task.status != before;
            let mut emit = None;
            let mut journal = None;
            if changed || now.duration_since(e.last_emit).as_millis() >= 200 {
                e.last_emit = now;
                emit = Some(e.task.clone());
            }
            if changed || now.duration_since(e.last_journal).as_millis() >= 1000 {
                e.last_journal = now;
                // journal 编码：OutcomeUnknown 行保持 Committing（活动集成员——
                // 重启恢复分类与「未决任务保留 journal」依据；注册表面呈现真实状态）
                let mut snap = e.task.clone();
                let mut verified = e.verified;
                if snap.status == TransferStatus::OutcomeUnknown {
                    snap.status = TransferStatus::Committing;
                    verified = false;
                }
                journal = Some((snap, verified));
            }
            (emit, journal)
        };
        if let Some(t) = emit_task {
            let _ = self.transfer_tx.send(t);
        }
        if let Some((t, verified)) = journal_task {
            let _ = self.center.vault.transfer_journal_update(&t, Some(verified));
        }
    }

    /// 终态收尾：即时发帧 + journal 必写（审计由调用方按既有键追加）。
    /// rev-r32 中-1：仅 Succeeded 覆写字节数——取消/失败保留在途进度（「恢复不抹账、
    /// 运行时同样不抹账」；终态字节 = MCP 对账权威面数据，0 会冒充「没传过」）。
    /// R34：离开 AwaitingDecision 即清提示载荷（wire：仅待决态非空）与决策通道。
    fn transfer_finish(&self, tid: &TransferId, status: TransferStatus, bytes: u64, error: Option<String>) {
        let now = now_unix();
        {
            let mut reg = self.transfers.lock().unwrap();
            if let Some(e) = reg.get_mut(tid) {
                e.decision_tx = None;
            }
        }
        self.transfer_apply(tid, |t| {
            t.status = status;
            t.decision_prompt = None;
            if status == TransferStatus::Succeeded {
                t.bytes_done = bytes;
            }
            t.error = error;
            if t.finished_at.is_none() {
                t.finished_at = Some(now);
            }
        });
    }

    /// C6/R34 DF5.2：发布原语成功 → verified 证据即时落 journal（先于收尾帧与
    /// temp 清理——「提交时退出重启」窗口内崩溃，重启恢复据此判 Succeeded{verified}）。
    fn transfer_mark_verified(&self, tid: &TransferId) {
        let t = {
            let mut reg = self.transfers.lock().unwrap();
            let Some(e) = reg.get_mut(tid) else { return };
            e.verified = true;
            e.last_journal = std::time::Instant::now(); // 状态未变也强制落账
            e.task.clone()
        };
        let _ = self.center.vault.transfer_journal_update(&t, Some(true));
    }

    /// C6/R34：进入 AwaitingDecision 并等待人类裁决（数据阶段前预检冲突——
    /// 不白传字节）。返回 Some(决定)=继续发布编排；None=取消/作废收尾已落终态。
    async fn transfer_await_decision(
        &self,
        tid: &TransferId,
        target_path: &str,
        target_stat: Option<TargetStat>,
        reason: &str,
        cancel: &CancellationToken,
    ) -> Option<CollisionDecision> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.transfer_apply(tid, |t| {
            t.status = TransferStatus::AwaitingDecision;
            t.decision_prompt = Some(DecisionPrompt {
                target_path: target_path.to_string(),
                target_stat: target_stat.clone(),
                reason: reason.to_string(),
            });
        });
        if let Some(e) = self.transfers.lock().unwrap().get_mut(tid) {
            e.decision_tx = Some(tx);
        }
        tokio::select! {
            r = rx => match r {
                Ok(d) => Some(d),
                // 通道被取走即关闭=提交决定/取消/作废。关闭而非投递（含取消竞窗
                // 抢先关闭）→ 确未提交，统一 Cancelled 收尾（取消=「已取消」、
                // 作废=「决策卡已作废」，错误文本区分留痕）
                Err(_) => {
                    let msg = if cancel.is_cancelled() {
                        "已取消（冲突待决中）".to_string()
                    } else {
                        "决策卡已作废（过期决定显式收卡）".to_string()
                    };
                    self.transfer_finish(tid, TransferStatus::Cancelled, 0, Some(msg));
                    None
                }
            },
            _ = cancel.cancelled() => {
                // 取消竞窗：通道取走防悬挂写；确未提交 → Cancelled
                if let Some(e) = self.transfers.lock().unwrap().get_mut(tid) {
                    e.decision_tx = None;
                }
                self.transfer_finish(tid, TransferStatus::Cancelled, 0, Some("已取消（冲突待决中）".into()));
                None
            }
        }
    }

    // ---- C10 输出订阅恢复（R11；桥层专用，不在 SessionApi trait 面）----

    /// 订阅会话输出：注册订阅身份 + 原子捕获检查点与水位（DF10.2）。
    /// 返回 (AttachOutput, broadcast receiver, 取消信号 receiver)；receiver 由桥层
    /// 转发为带 seq 帧头的 Raw 通道帧，取消信号触发桥 task 退出（显式退订即终结转发）。
    /// 注册起 broadcast 缓存 live——检查点应用前的早到帧由前端暂存。
    pub async fn subscribe_output_channel(
        &self,
        sid: SessionId,
    ) -> Result<(
        AttachOutput,
        broadcast::Receiver<OutputEvent>,
        tokio::sync::watch::Receiver<bool>,
    )> {
        let h = self.get(&sid)?;
        let rx = h.output_tx.subscribe();
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let (subscription_id, checkpoint, start_seq) = {
            // 锁序：screen → replay（与 pump 一致，防死锁）
            let s = h.screen.lock().await;
            let checkpoint = s.checkpoint();
            let start_seq = h.output_seq.load(std::sync::atomic::Ordering::Acquire);
            h.last_ckpt_seq.store(start_seq, std::sync::atomic::Ordering::Release);
            let sub = format!("sub-{}", uuid::Uuid::new_v4());
            h.subs.lock().unwrap().insert(sub.clone(), cancel_tx);
            (sub, checkpoint, start_seq)
        };
        Ok((
            AttachOutput { subscription_id, checkpoint, start_seq },
            rx,
            cancel_rx,
        ))
    }

    /// 显式退订（主清理路径，DF10.5）：幂等；重复或旧身份为 no-op。
    /// 会话不存在同样 Ok——UI 收尾顺序可能晚于会话关闭（close_session 已自动清理）。
    pub async fn unsubscribe_output(&self, sid: SessionId, subscription_id: &str) -> Result<()> {
        if let Some(h) = self.sessions.lock().unwrap().get(&sid).cloned() {
            let removed = h.subs.lock().unwrap().remove(subscription_id);
            if let Some(cancel_tx) = removed {
                let _ = cancel_tx.send(true); // 桥 task 退出（转发终结）
            } else {
                tracing::debug!(session = %sid, sub = %subscription_id, "unsubscribe: no such subscription (no-op)");
            }
        }
        Ok(())
    }

    /// resync（DF10.3）：绑定订阅身份；from_seq=None 请求检查点。
    /// Some(f)：优先 (f, cur] 连续原始字节重放（水位包含末事件）；
    /// 不可重放（淘汰/alt_screen 活跃/检查点更近）退检查点。
    /// 过期/未知 subscription_id 拒绝且不改任何状态。
    pub async fn resync_output(
        &self,
        sid: SessionId,
        subscription_id: &str,
        from_seq: Option<u64>,
    ) -> Result<ResyncOutput> {
        let h = self.get(&sid)?;
        if !h.subs.lock().unwrap().contains_key(subscription_id) {
            return Err(Error::InvalidInput(format!(
                "subscription 已过期或不存在：{subscription_id}"
            )));
        }
        // 锁序：screen → replay
        let s = h.screen.lock().await;
        let checkpoint_mode = match from_seq {
            None => true,
            Some(f) => {
                let cur = h.output_seq.load(std::sync::atomic::Ordering::Acquire);
                // seq 恰等于水位：已追平，空重放（不重放断言）
                if f >= cur {
                    return Ok(ResyncOutput::Replayed {
                        subscription_id: subscription_id.to_string(),
                        events: Vec::new(),
                        end_seq: cur,
                    });
                }
                let replayable = h.replay.lock().unwrap().covers_from(f);
                let ckpt_nearer =
                    h.last_ckpt_seq.load(std::sync::atomic::Ordering::Acquire) >= f + 1;
                !replayable || s.alt_screen() || ckpt_nearer
            }
        };
        if checkpoint_mode {
            let checkpoint = s.checkpoint();
            let end_seq = h.output_seq.load(std::sync::atomic::Ordering::Acquire);
            h.last_ckpt_seq.store(end_seq, std::sync::atomic::Ordering::Release);
            return Ok(ResyncOutput::Checkpointed {
                subscription_id: subscription_id.to_string(),
                checkpoint,
                end_seq,
            });
        }
        let f = from_seq.expect("checked above");
        let cur = h.output_seq.load(std::sync::atomic::Ordering::Acquire);
        let ring = h.replay.lock().unwrap();
        let events: Vec<SeqFrame> = ring
            .q
            .iter()
            .filter(|(seq, _)| *seq > f && *seq <= cur)
            .map(|(seq, data)| SeqFrame { seq: *seq, data: data.clone() })
            .collect();
        // 环内连续到 cur（covers_from 已验首帧；seq 逐帧连续推进，末帧即 cur）
        let end_seq = events.last().map(|e| e.seq).unwrap_or(cur);
        Ok(ResyncOutput::Replayed { subscription_id: subscription_id.to_string(), events, end_seq })
    }

    /// P6 测量口径（DF10.5）：活跃订阅计数。
    pub fn debug_subscriptions(&self) -> DebugSubscriptions {
        let sessions = self.sessions.lock().unwrap();
        let mut per_session = Vec::with_capacity(sessions.len());
        let mut active_count = 0usize;
        for (sid, h) in sessions.iter() {
            let ids: Vec<String> = h.subs.lock().unwrap().keys().cloned().collect();
            active_count += ids.len();
            per_session.push(SessionSubs { session_id: sid.clone(), subscription_ids: ids });
        }
        DebugSubscriptions { active_count, per_session }
    }
}

impl SessionManager {
    fn get(&self, sid: &str) -> Result<Arc<SessionHandle>> {
        self.sessions
            .lock()
            .unwrap()
            .get(sid)
            .cloned()
            .ok_or(Error::SessionNotFound)
    }

    /// 手动重连（GUI「重连」按钮；不在 SessionApi/MCP 面——断线恢复是人的基础设施动作）。
    /// 前置：会话处于 Disconnected（pump 已退出，自动重连 3 次均已失败或本地 shell 已死）。
    /// 与自动重连同构，但泵已不在：先订阅（broadcast 不因重连更换，UI 既有订阅继续有效）
    /// → 重建传输（SSH 原地重连保留 TOFU 指纹；本地重启新 shell）→ 重启泵 → 现场重置 → 重注入。
    pub async fn reconnect_session(&self, sid: &str) -> Result<()> {
        let h = self.get(sid)?;
        {
            let st = *h.state.lock().await;
            match st {
                SessionState::Disconnected => {
                    *h.state.lock().await = SessionState::Reconnecting;
                }
                SessionState::Reconnecting => {
                    return Err(Error::InvalidInput("重连已在进行中".into()));
                }
                _ => return Err(Error::InvalidInput("会话未处于断开状态，无需重连".into())),
            }
        }
        h.note_transition("手动重连：重建连接").await;
        h.retry_stop.store(false, std::sync::atomic::Ordering::SeqCst);
        // 先订阅：新传输的输出不得落入无订阅者窗口（§6.1-11 同源根因）
        let rx = h.channel.subscribe_output();
        let mut last_err = None;
        for attempt in 1..=3 {
            h.emit_state(SessionState::Reconnecting, Some(attempt), Some(3), None).await;
            match h.channel.reconnect().await {
                Ok(()) => {
                    last_err = None;
                    break;
                }
                Err(e) => {
                    tracing::warn!(session = %sid, attempt, "manual reconnect: {e}");
                    last_err = Some(e);
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        }
        if let Some(e) = last_err {
            *h.state.lock().await = SessionState::Disconnected;
            h.note_transition("手动重连失败（仍断开，可再试）").await;
            h.emit_state(SessionState::Disconnected, None, None,
                Some(format!("手动重连失败：{e}"))).await;
            return Err(e);
        }
        h.reset_scene_after_reconnect().await;
        spawn_pump(h.clone(), rx);
        if h.kind == "ssh" {
            h.reinject_integration().await;
        } else {
            // 本地重连 = 新 shell（rcfile 已带集成，无需注入）；现场事实同样降级
            h.verification_hits
                .store(0, std::sync::atomic::Ordering::SeqCst);
            *h.state.lock().await = SessionState::Reconfirming;
            h.note_transition("重连成功，进入重确认（仅内置只读白名单可用）")
                .await;
            h.emit_state(SessionState::Reconfirming, None, None, None).await;
        }
        let _ = self.center.audit.append(
            &Actor::Human,
            "session_reconnect",
            Some(sid),
            None,
            serde_json::json!({}),
            None,
        );
        Ok(())
    }

    /// R26（§6.4「可停止重试」）：置停止旗标，自动重连循环在下一检查点（≤250ms）
    /// 落 Disconnected。幂等：不在重连期调用是合法 no-op（旗标复位由新断线周期
    /// 与手动重连入口负责，此处不复位）。UI 的停止动作，不进 SessionApi/MCP 面。
    pub async fn stop_auto_reconnect(&self, sid: &str) -> Result<()> {
        let h = self.get(sid)?;
        h.retry_stop.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = self.center.audit.append(
            &Actor::Human,
            "session_reconnect_stop",
            Some(sid),
            None,
            serde_json::json!({}),
            None,
        );
        Ok(())
    }

    /// C5/C6 传输编排（R34：staging + 唯一发布决策表 + 取消线性化）。
    ///
    /// 流程（上传/下载对称）：canonical 目标规划 → 同目标锁（DF6.4，排队保持
    /// Queued）→ 预检（数据阶段前——冲突先裁决，不白传字节）→ temp 分片写
    ///（.tinyssh-part-<tid>-<name>，同目录）→ temp 长度核对 → Committing →
    /// 复检（存在性+size+mtime，不一致一律按新冲突 DF6.3）→ 原子 no-clobber
    /// 发布（hardlink temp→目标；竞态失败=目标被抢建按冲突重裁决）→ journal
    /// verified 证据 → temp 清理 → Succeeded。
    ///
    /// DF6.1 冻结矩阵（G3）：no-clobber=hardlink（远端 hardlink@openssh.com
    /// 扩展声明 + 发布尝试即行为验证——链接要么原子建立要么失败且绝不改动
    /// 目标；本地 std::fs::hard_link 同语义）；覆盖发布所需「目标版本约束」
    ///（CAS）在 SFTP v3+OpenSSH 扩展集与本地 syscall 均无原语 → overwrite
    /// 一律 ReplaceUnsupported 阻止（原目标零改动、无双重命名降级/bak/回滚）。
    /// 发布应答丢失/通路失稳 → Ambiguous → OutcomeUnknown（temp 保留；journal
    /// 行保持 Committing 编码供重启恢复分类；不自动重发/覆盖/清理）。
    /// 取消线性化：publish 前检查点生效（确未提交，temp 清理+Cancelled）；
    /// publish 之后提交不可逆，收尾 Succeeded 对晚到取消幂等（取消不回滚）。
    async fn transfer(
        &self,
        ctx: &Actor,
        sid: SessionId,
        local: PathBuf,
        remote: String,
        is_upload: bool,
        collision: Option<CollisionDecision>,
        retry_of: Option<TransferId>,
    ) -> Result<TransferHandle> {
        let h = self.get(&sid)?;
        if !ctx.is_human() && *h.owner.lock().await == ControlOwner::Human {
            return Err(Error::ControlTakenByHuman);
        }
        // 重确认期间 Agent 动作被拒（L1 §3.1：普通动作不开放）
        if !ctx.is_human() && *h.state.lock().await == SessionState::Reconfirming {
            return Err(Error::ReconfirmingPending);
        }
        // C6/R34：collision 仅 Agent 路径（DF6.2；人类冲突一律 AwaitingDecision 决策卡）
        if ctx.is_human() && collision.is_some() {
            return Err(Error::InvalidInput(
                "collision 仅 Agent 传输参数（人类冲突经决策卡裁决）".into(),
            ));
        }
        // Agent 传输必审（L1 §4）；collision=overwrite 审批卡明示（DF6.2）
        let mut edited: Option<String> = None;
        if let Actor::Agent { client_id } = ctx {
            let op = if is_upload { "upload" } else { "download" };
            let mut segment = format!("{op} → {remote}");
            if collision == Some(CollisionDecision::Overwrite) {
                // rev-r34 低-2：DF6.1 冻结后覆盖发布必被能力阻止——审批卡如实告知，
                // 不误导审批人放行一个注定失败的写请求
                segment.push_str("（覆盖已存在目标——将被能力阻止：传输不提供目标版本约束，原文件零改动）");
            }
            let eval = tinyssh_approval::Evaluation {
                verdict: tinyssh_approval::SegmentVerdict::NeedsApproval,
                segments: vec![SegmentReport {
                    segment,
                    verdict: "pending: 传输必审".into(),
                }],
            };
            let (trace, e) = h
                .wait_approval(ctx, client_id, &"transfer".to_string(), &format!("{op} {local:?} → {remote}"), &eval, false, false, CancellationToken::new())
                .await?;
            let _ = trace;
            // 传输路径无法从编辑文本回解（复审②：静默按原文执行 = 审计失真）
            SessionManager::reject_edited_approval(&e, &format!("{op} {local:?} → {remote}"), "传输审批")?;
        }
        let _ = edited.take();

        let tid = format!("t-{}", uuid::Uuid::new_v4());
        let handle = TransferHandle {
            id: tid.clone(),
            session_id: sid.clone(),
            kind: if is_upload { TransferKind::Upload } else { TransferKind::Download },
            local: local.clone(),
            remote: remote.clone(),
        };
        let cancel = CancellationToken::new();
        h.transfers.lock().unwrap().insert(tid.clone(), cancel.clone());

        // C5（§560）：创建先注册返回任务 ID 再开始读写——Queued 即注册表/journal/事件可见
        let task = TransferTask {
            id: tid.clone(),
            session_id: sid.clone(),
            kind: handle.kind,
            source: if is_upload { local.display().to_string() } else { remote.clone() },
            dest: if is_upload { remote.clone() } else { local.display().to_string() },
            status: TransferStatus::Queued,
            bytes_done: 0,
            total: None,
            revision: 1,
            created_at: now_unix(),
            finished_at: None,
            error: None,
            retry_of: retry_of.clone(),
            collision_decision: None,
            decision_prompt: None,
        };
        let _ = self.center.vault.transfer_journal_insert(&task);
        self.transfer_register(task, cancel.clone());

        // 执行任务（串行化并入 exec 队列之外的独立通道；MVP 直接执行）
        let h2 = h.clone();
        let sid2 = sid.clone();
        let tid2 = tid.clone();
        let ctx2 = ctx.clone();
        let gen = h.generation.load(std::sync::atomic::Ordering::SeqCst);
        let remote2 = remote.clone();
        let local2 = local.clone();
        let mgr = self
            .self_weak
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|w| w.upgrade())
            .ok_or(Error::SessionClosed)?;
        tokio::spawn(async move {
            if h2.generation.load(std::sync::atomic::Ordering::SeqCst) != gen {
                // 交接作废：任务从未开始读写——按 Cancelled 落账（§6.5 人类主权）
                mgr.transfer_finish(&tid2, TransferStatus::Cancelled, 0, Some("接管作废".into()));
                let _ = h2.center.audit.append(
                    &ctx2, "transfer_voided", Some(&sid2), Some(&remote2),
                    serde_json::json!({"transfer": tid2, "reason": "voided_by_handback"}), None);
                h2.transfers.lock().unwrap().remove(&tid2);
                return;
            }
            // R35 §366 并发闸：窗口全局 4、每会话 2，其余保持 Queued 排队。
            // 闸先于同目标锁（排队不占锁）；排队中取消/交接即时响应。
            // 先会话后全局：全局许可只发给已持会话槽、即将开跑的任务——避免「全局
            // 许可被卡在会话槽上的任务白占」的队首阻塞（否则单会话多排队会饿死他会话）。
            let gate_s = tokio::select! {
                s = h2.xfer_gate_session.clone().acquire_owned() => s,
                _ = cancel.cancelled() => {
                    mgr.transfer_finish(&tid2, TransferStatus::Cancelled, 0, Some("已取消（排队中）".into()));
                    let _ = h2.center.audit.append(
                        &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                        serde_json::json!({"transfer": tid2, "error": "已取消"}), None);
                    h2.transfers.lock().unwrap().remove(&tid2);
                    return;
                }
            };
            let gate_g = tokio::select! {
                g = mgr.xfer_gate_global.clone().acquire_owned() => g,
                _ = cancel.cancelled() => {
                    mgr.transfer_finish(&tid2, TransferStatus::Cancelled, 0, Some("已取消（排队中）".into()));
                    let _ = h2.center.audit.append(
                        &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                        serde_json::json!({"transfer": tid2, "error": "已取消"}), None);
                    h2.transfers.lock().unwrap().remove(&tid2);
                    return;
                }
            };
            // 闸后复查交接（排队期间接管=从未开始，按作废落账）
            if h2.generation.load(std::sync::atomic::Ordering::SeqCst) != gen {
                drop((gate_g, gate_s));
                mgr.transfer_finish(&tid2, TransferStatus::Cancelled, 0, Some("接管作废".into()));
                let _ = h2.center.audit.append(
                    &ctx2, "transfer_voided", Some(&sid2), Some(&remote2),
                    serde_json::json!({"transfer": tid2, "reason": "voided_by_handback_gated"}), None);
                h2.transfers.lock().unwrap().remove(&tid2);
                return;
            }
            // R35：目录明确不支持（源侧判别；上传源=本地、下载源=远端）。
            // NotFound 同样在此如实失败（优于后续 File::open 的含糊 IO 文案）。
            let src_path = if is_upload { local2.display().to_string() } else { remote2.clone() };
            match SessionManager::ns_stat(&h2, !is_upload, &src_path).await {
                Ok(st) if st.is_dir => {
                    let msg = "目录传输不支持：仅支持单文件（目录请先打包）".to_string();
                    mgr.transfer_finish(&tid2, TransferStatus::Failed, 0, Some(msg.clone()));
                    let _ = h2.center.audit.append(
                        &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                        serde_json::json!({"transfer": tid2, "error": msg}), None);
                    h2.transfers.lock().unwrap().remove(&tid2);
                    return;
                }
                Err(Error::SftpPathNotFound { .. }) => {
                    let msg = format!("源文件不存在：{src_path}");
                    mgr.transfer_finish(&tid2, TransferStatus::Failed, 0, Some(msg.clone()));
                    let _ = h2.center.audit.append(
                        &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                        serde_json::json!({"transfer": tid2, "error": msg}), None);
                    h2.transfers.lock().unwrap().remove(&tid2);
                    return;
                }
                _ => {} // 其余 stat 错误不拦截——数据阶段以真实读写错误落账
            }
            let human_path = ctx2.is_human();
            // C6/R34：canonical 目标规划（预检前置）。失败=确未提交，直接失败。
            let plan = match SessionManager::stage_plan(&h2, is_upload, &local2, &remote2, &tid2).await {
                Ok(p) => p,
                Err(e) => {
                    mgr.transfer_finish(&tid2, TransferStatus::Failed, 0, Some(e.to_string()));
                    let _ = h2.center.audit.append(
                        &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                        serde_json::json!({"transfer": tid2, "error": e.to_string()}), None);
                    h2.transfers.lock().unwrap().remove(&tid2);
                    return;
                }
            };
            // 同目标串行（DF6.4）：排队保持 Queued，持锁至终态（统一收尾释放）。
            // 锁内复查交接（排队期间接管=从未开始，按作废落账）。
            let lock = mgr.target_lock(&plan.lock_key);
            let _guard = lock.lock().await;
            if h2.generation.load(std::sync::atomic::Ordering::SeqCst) != gen {
                mgr.transfer_finish(&tid2, TransferStatus::Cancelled, 0, Some("接管作废".into()));
                let _ = h2.center.audit.append(
                    &ctx2, "transfer_voided", Some(&sid2), Some(&remote2),
                    serde_json::json!({"transfer": tid2, "reason": "voided_by_handback_locked"}), None);
                h2.transfers.lock().unwrap().remove(&tid2);
                return;
            }
            let cancel2 = cancel.clone();
            // 统一收尾（锁释放 + 会话级句柄清理）；显式调用保证每条路径只走一次
            struct Guard {
                h: Arc<SessionHandle>,
                tid: String,
            }
            impl Guard {
                fn done(self) {} // 消费即放弃显式清理（drop 仍兜底）
            }
            impl Drop for Guard {
                fn drop(&mut self) {
                    self.h.transfers.lock().unwrap().remove(&self.tid);
                }
            }
            let g = Guard { h: h2.clone(), tid: tid2.clone() };

            // ---- 预检（数据阶段前；冲突先裁决不白传字节）----
            let mut intent: Option<String> = None; // None=原目标名（新文件）；Some=keep-both 候选名
            match SessionManager::ns_stat(&h2, is_upload, &plan.target).await {
                Ok(st) => {
                    let tstat = Some(TargetStat { size: st.size, mtime: st.mtime });
                    match SessionManager::conflict_resolve(
                        &mgr, &h2, &tid2, &cancel2, human_path, collision, is_upload, &plan.target, tstat,
                        "target_exists", &plan.dir, &plan.name, &plan.temp, "preflight",
                    )
                    .await
                    {
                        Some(cand) => intent = Some(cand),
                        None => { g.done(); return; } // 终态已落（跳过/阻止/结构化失败）
                    }
                }
                Err(Error::SftpPathNotFound { .. }) => {} // 新文件路径
                Err(e) => {
                    mgr.transfer_finish(&tid2, TransferStatus::Failed, 0, Some(e.to_string()));
                    let _ = h2.center.audit.append(
                        &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                        serde_json::json!({"transfer": tid2, "error": e.to_string()}), None);
                    g.done();
                    return;
                }
            }

            // ---- 数据阶段（temp staging）----
            // rev-r32 低-2 沿袭：仅 Queued→Running（取消竞窗不回跳）；
            // R34：预检决策完成回 Running（决策卡关闭，提示载荷留待 finish 清）
            mgr.transfer_apply(&tid2, |t| {
                if t.status == TransferStatus::Queued {
                    t.status = TransferStatus::Running;
                } else if t.status == TransferStatus::AwaitingDecision {
                    t.status = TransferStatus::Running;
                }
            });
            let p_tid = tid2.clone();
            let p_mgr = mgr.clone();
            let progress = move |done: u64, total: Option<u64>| {
                p_mgr.transfer_apply(&p_tid, |t| {
                    t.bytes_done = done;
                    t.total = total;
                });
            };
            let temp_path = std::path::PathBuf::from(&plan.temp);
            let r = if is_upload {
                h2.channel.upload(&local2, &plan.temp, &cancel2, &progress).await
            } else {
                h2.channel.download(&remote2, &temp_path, &cancel2, &progress).await
            };
            let staged_bytes = match r {
                Ok(b) => b,
                Err(Error::Cancelled) => {
                    // 确未提交：temp 清理（尽力；失败审计留痕不阻塞终态）
                    SessionManager::cleanup_temp(&h2, is_upload, &plan.temp).await;
                    mgr.transfer_finish(&tid2, TransferStatus::Cancelled, 0, Some("已取消".into()));
                    let _ = h2.center.audit.append(
                        &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                        serde_json::json!({"transfer": tid2, "error": "已取消"}), None);
                    g.done();
                    return;
                }
                Err(e) => {
                    SessionManager::cleanup_temp(&h2, is_upload, &plan.temp).await;
                    mgr.transfer_finish(&tid2, TransferStatus::Failed, 0, Some(e.to_string()));
                    let _ = h2.center.audit.append(
                        &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                        serde_json::json!({"transfer": tid2, "error": e.to_string()}), None);
                    g.done();
                    return;
                }
            };
            // temp 长度核对（契约：stat 临时文件核对长度；不符=staging 不完整）
            match SessionManager::ns_stat(&h2, is_upload, &plan.temp).await {
                Ok(st) if st.size == Some(staged_bytes) => {}
                other => {
                    SessionManager::cleanup_temp(&h2, is_upload, &plan.temp).await;
                    let msg = format!(
                        "temp 长度核对不符（写 {staged_bytes}，stat {:?}）——未提交",
                        other.ok().and_then(|s| s.size)
                    );
                    mgr.transfer_finish(&tid2, TransferStatus::Failed, 0, Some(msg.clone()));
                    let _ = h2.center.audit.append(
                        &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                        serde_json::json!({"transfer": tid2, "error": msg}), None);
                    g.done();
                    return;
                }
            }

            // ---- 提交窗口（Committing）：复检 → 发布 → 证据 → 清理 ----
            mgr.transfer_apply(&tid2, |t| {
                if !t.status.is_terminal() {
                    t.status = TransferStatus::Committing;
                }
            });
            let mut rounds = 0u32;
            loop {
                rounds += 1;
                if rounds > 16 {
                    // 病态竞态回环防线：每轮复检不一致都真实重裁决，16 轮远超正常
                    SessionManager::cleanup_temp(&h2, is_upload, &plan.temp).await;
                    mgr.transfer_finish(&tid2, TransferStatus::Failed, 0, Some("发布复检竞态回环超限，已阻止提交".into()));
                    let _ = h2.center.audit.append(
                        &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                        serde_json::json!({"transfer": tid2, "error": "recheck loop bound"}), None);
                    g.done();
                    return;
                }
                let final_name = intent.clone().unwrap_or_else(|| plan.name.clone());
                let final_path = format!("{}/{}", plan.dir, final_name);
                // 复检（DF6.3 存在性+size+mtime）：发布路径一律复检；不一致一律按
                // 新冲突（L3：显式 overwrite 只针对预检所见那份）
                match SessionManager::ns_stat(&h2, is_upload, &final_path).await {
                    Ok(st) => {
                        let tstat = Some(TargetStat { size: st.size, mtime: st.mtime });
                        match SessionManager::conflict_resolve(
                            &mgr, &h2, &tid2, &cancel2, human_path, collision, is_upload, &final_path, tstat,
                            "stat_changed_since_preflight", &plan.dir, &plan.name, &plan.temp, "recheck",
                        )
                        .await
                        {
                            Some(cand) => { intent = Some(cand); continue; }
                            None => { g.done(); return; }
                        }
                    }
                    Err(Error::SftpPathNotFound { .. }) => {} // 复检一致：目标不存在
                    Err(e) => {
                        // 复检通路失败=无法判定（提交未开始，确未提交）
                        SessionManager::cleanup_temp(&h2, is_upload, &plan.temp).await;
                        mgr.transfer_finish(&tid2, TransferStatus::Failed, 0, Some(format!("复检失败（未提交）：{e}")));
                        let _ = h2.center.audit.append(
                            &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                            serde_json::json!({"transfer": tid2, "error": e.to_string()}), None);
                        g.done();
                        return;
                    }
                }
                // 取消检查点（线性化点=下方 publish）：publish 前 → 确未提交
                if cancel2.is_cancelled() {
                    SessionManager::cleanup_temp(&h2, is_upload, &plan.temp).await;
                    mgr.transfer_finish(&tid2, TransferStatus::Cancelled, 0, Some("已取消（提交窗口内）".into()));
                    let _ = h2.center.audit.append(
                        &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                        serde_json::json!({"transfer": tid2, "error": "已取消"}), None);
                    g.done();
                    return;
                }
                if fault::active("pre_publish") {
                    let _ = h2.center.audit.append(
                        &ctx2, "fault_inject", Some(&sid2), None,
                        serde_json::json!({"transfer": tid2, "point": "pre_publish"}), None);
                }
                fault::pause("pre_publish").await;
                // 暂停窗内到达的取消仍线性化在 publish 前（线性化点=publish 本身，
                // 不是暂停起点——否则「取消」后目标仍被写入）
                if cancel2.is_cancelled() {
                    SessionManager::cleanup_temp(&h2, is_upload, &plan.temp).await;
                    mgr.transfer_finish(&tid2, TransferStatus::Cancelled, 0, Some("已取消（提交窗口内）".into()));
                    let _ = h2.center.audit.append(
                        &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                        serde_json::json!({"transfer": tid2, "error": "已取消"}), None);
                    g.done();
                    return;
                }
                let publish_res = if fault::active("drop_link_response") && is_upload {
                    let _ = h2.center.audit.append(
                        &ctx2, "fault_inject", Some(&sid2), None,
                        serde_json::json!({"transfer": tid2, "point": "drop_link_response"}), None);
                    // C13 注入（分离续跑）：请求照发——服务端真实提交；应答弃收，
                    // 本侧按 Ambiguous 归一（提交与否不可知）。仅远端通路可注入
                    // （本地 syscall 无「应答丢失」形态）。
                    let h3 = h2.clone();
                    let t3 = plan.temp.clone();
                    let f3 = final_path.clone();
                    tokio::spawn(async move {
                        let _ = h3.channel.publish_hardlink(&t3, &f3).await;
                    });
                    Ok(PublishOutcome::Ambiguous)
                } else {
                    SessionManager::ns_publish(&h2, is_upload, &plan.temp, &final_path).await
                };
                match publish_res {
                    Ok(PublishOutcome::Committed) => {
                        // 证据先行（DF5.2/C13）：verified 落 journal——此点之后崩溃
                        // 重启可判「已确认提交归成功」
                        mgr.transfer_mark_verified(&tid2);
                        if fault::active("post_verified") {
                            let _ = h2.center.audit.append(
                                &ctx2, "fault_inject", Some(&sid2), None,
                                serde_json::json!({"transfer": tid2, "point": "post_verified"}), None);
                        }
                        fault::pause("post_verified").await;
                        // temp 已提交为冗余：清理（失败非致命，审计留痕）
                        if let Err(e) = SessionManager::ns_remove(&h2, is_upload, &plan.temp).await {
                            let _ = h2.center.audit.append(
                                &ctx2, "transfer_temp_clean_failed", Some(&sid2), None,
                                serde_json::json!({"transfer": tid2, "temp": plan.temp, "error": e.to_string()}), None);
                        }
                        // keepboth 发布名与请求目标不同：任务 dest 回写实际发布路径
                        // （账实相符——卡面/对账面不显示旧目标）
                        if final_name != plan.name {
                            let fp = final_path.clone();
                            mgr.transfer_apply(&tid2, |t| {
                                if !t.status.is_terminal() {
                                    t.dest = fp;
                                }
                            });
                        }
                        mgr.transfer_finish(&tid2, TransferStatus::Succeeded, staged_bytes, None);
                        let _ = h2.center.audit.append(
                            &ctx2, "transfer_done", Some(&sid2), Some(&remote2),
                            serde_json::json!({"transfer": tid2, "bytes": staged_bytes, "verified": true}), None);
                        g.done();
                        return;
                    }
                    Ok(PublishOutcome::Unsupported) => {
                        // DF6.1：无经验证 no-clobber 能力 → 阻止发布（确未提交）
                        SessionManager::cleanup_temp(&h2, is_upload, &plan.temp).await;
                        let msg = Error::ReplaceUnsupported { capability: "hardlink".into() }.to_string();
                        mgr.transfer_finish(&tid2, TransferStatus::Failed, staged_bytes, Some(msg.clone()));
                        let _ = h2.center.audit.append(
                            &ctx2, "transfer_publish_blocked", Some(&sid2), Some(&remote2),
                            serde_json::json!({"transfer": tid2, "capability": "hardlink"}), None);
                        g.done();
                        return;
                    }
                    Ok(PublishOutcome::Rejected(reason)) => {
                        // 链接失败绝不改动目标（原子 create-or-fail）→ 确定未提交；
                        // 目标此刻存在=竞态抢建 → 按冲突重裁决，否则真实错误
                        match SessionManager::ns_stat(&h2, is_upload, &final_path).await {
                            Ok(st) => {
                                let tstat = Some(TargetStat { size: st.size, mtime: st.mtime });
                                match SessionManager::conflict_resolve(
                                    &mgr, &h2, &tid2, &cancel2, human_path, collision, is_upload, &final_path,
                                    tstat, "stat_changed_since_preflight", &plan.dir, &plan.name,
                                    &plan.temp, "publish_raced",
                                )
                                .await
                                {
                                    Some(cand) => { intent = Some(cand); continue; }
                                    None => { g.done(); return; }
                                }
                            }
                            Err(_) => {
                                SessionManager::cleanup_temp(&h2, is_upload, &plan.temp).await;
                                mgr.transfer_finish(&tid2, TransferStatus::Failed, staged_bytes, Some(format!("发布被拒（未提交）：{reason}")));
                                let _ = h2.center.audit.append(
                                    &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                                    serde_json::json!({"transfer": tid2, "error": reason}), None);
                                g.done();
                                return;
                            }
                        }
                    }
                    Ok(PublishOutcome::Ambiguous) => {
                        // C13：请求已发出、应答丢失——提交与否不可知。OutcomeUnknown
                        // 终态；temp 保留（唯一恢复资料）；journal 行保持 Committing
                        // 编码（重启恢复分类继续可见）；不自动重发/覆盖/清理。
                        mgr.transfer_apply(&tid2, |t| {
                            if !t.status.is_terminal() {
                                t.status = TransferStatus::OutcomeUnknown;
                                t.error = Some("发布应答丢失，提交结果未知（temp 保留；可在卡片「重新核实」）".into());
                                if t.finished_at.is_none() {
                                    t.finished_at = Some(now_unix());
                                }
                            }
                        });
                        let _ = h2.center.audit.append(
                            &ctx2, "transfer_outcome_unknown", Some(&sid2), Some(&remote2),
                            serde_json::json!({"transfer": tid2, "phase": "live"}), None);
                        g.done();
                        return;
                    }
                    Err(e) => {
                        // 发布调用未发出（通路失败）→ 确定未提交
                        SessionManager::cleanup_temp(&h2, is_upload, &plan.temp).await;
                        mgr.transfer_finish(&tid2, TransferStatus::Failed, staged_bytes, Some(e.to_string()));
                        let _ = h2.center.audit.append(
                            &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                            serde_json::json!({"transfer": tid2, "error": e.to_string()}), None);
                        g.done();
                        return;
                    }
                }
            }
        });
        Ok(handle)
    }

    /// C5/R35 失败重试（§364）：以原参数创建**新任务**（retry_of=旧任务），
    /// 重新走完整 transfer 编排——连接、源文件与冲突全部重校验；不承诺断点
    /// 续传；重试不带 collision（不自动重试已授权覆盖，冲突重新裁决）。
    /// 仅终态 Failed/Cancelled/Skipped/Interrupted 可重试：OutcomeUnknown
    /// 只能「重新核实」（§374 通用重试绝不作为默认动作）；Succeeded 无重试
    /// 语义；Queued/Running/Cancelling/Committing/AwaitingDecision 未终态。
    /// keepboth 已发布成功会改写 dest——但 Succeeded 不可重试，可重试状态的
    /// dest 均为原始请求目标（skip/failed/cancelled 不改写），无需额外记录。
    async fn retry_transfer(&self, ctx: &Actor, task_id: &TransferId) -> Result<TransferHandle> {
        let old = {
            let reg = self.transfers.lock().unwrap();
            let e = reg.get(task_id).ok_or_else(|| {
                Error::InvalidInput(format!("transfer not found: {task_id}"))
            })?;
            e.task.clone()
        };
        match old.status {
            TransferStatus::Failed
            | TransferStatus::Cancelled
            | TransferStatus::Skipped
            | TransferStatus::Interrupted => {}
            TransferStatus::OutcomeUnknown => {
                // §374：通用重试绝不作为 unknown 的默认动作——只能「重新核实」
                return Err(Error::InvalidTransferState {
                    task_id: task_id.clone(),
                    state: old.status,
                });
            }
            other => {
                return Err(Error::InvalidTransferState {
                    task_id: task_id.clone(),
                    state: other,
                });
            }
        }
        let sid = old.session_id.clone();
        let (local, remote, is_upload) = if old.kind == TransferKind::Upload {
            (std::path::PathBuf::from(&old.source), old.dest.clone(), true)
        } else {
            (std::path::PathBuf::from(&old.dest), old.source.clone(), false)
        };
        let h = self.get(&sid)?;
        if !ctx.is_human() && *h.owner.lock().await == ControlOwner::Human {
            return Err(Error::ControlTakenByHuman);
        }
        let handle = self
            .transfer(ctx, sid, local, remote, is_upload, None, Some(task_id.clone()))
            .await?;
        let _ = self.center.audit.append(
            ctx, "transfer_retry", Some(&old.session_id), Some(&old.dest),
            serde_json::json!({"retry_of": task_id, "new": handle.id}), None);
        Ok(handle)
    }

    /// C6/R34：staging 规划——canonical 目标、temp（同目录 .tinyssh-part-<tid>-<name>）、
    /// 同目标锁键。上传=远端父目录 realpath+基名（基名不解析，服务端语义归一归父目录
    /// 层）；下载=本地父目录 canonicalize+基名。
    // ---- rev-r34 高-1：提交窗口文件系统操作的命名空间分流 ----
    // 下载任务的预检/temp 核对/复检/发布/清理全落在**本地**路径上（stage_plan
    // 下载分支产本地 canonical），绝不经 ChannelHandle 路由——SSH 通路的这些
    // 方法是远端 SFTP 语义，本地路径会恒 NotFound（temp 核对必失败、下载冲突
    // 面失效）。本地语义唯一源=session_api::local_*（transport-pty 同源委托）。
    async fn ns_stat(
        h: &Arc<SessionHandle>,
        is_upload: bool,
        path: &str,
    ) -> Result<EntryStat> {
        if is_upload {
            h.channel.stat_entry(path).await
        } else {
            session_api::local_stat_entry(path)
        }
    }

    async fn ns_publish(
        h: &Arc<SessionHandle>,
        is_upload: bool,
        temp: &str,
        target: &str,
    ) -> Result<PublishOutcome> {
        if is_upload {
            h.channel.publish_hardlink(temp, target).await
        } else {
            Ok(session_api::local_publish_hardlink(temp, target))
        }
    }

    async fn ns_remove(h: &Arc<SessionHandle>, is_upload: bool, path: &str) -> Result<()> {
        if is_upload {
            h.channel.remove_file(path).await
        } else {
            session_api::local_remove_file(path)
        }
    }

    async fn stage_plan(
        h: &Arc<SessionHandle>,
        is_upload: bool,
        local: &Path,
        remote: &str,
        tid: &str,
    ) -> Result<StagePlan> {
        if is_upload {
            let trimmed = remote.trim_end_matches('/');
            if trimmed.is_empty() {
                return Err(Error::InvalidInput(format!("上传目标无效：{remote}")));
            }
            let (dir, name) = match trimmed.rsplit_once('/') {
                Some((d, n)) if !n.is_empty() => (
                    if d.is_empty() { "/".to_string() } else { d.to_string() },
                    n.to_string(),
                ),
                Some(_) => return Err(Error::InvalidInput(format!("上传目标以 / 结尾：{remote}"))),
                None => (".".to_string(), trimmed.to_string()),
            };
            let canon = h.channel.resolve_path(Some(&dir)).await?.canonical;
            let dir_c = canon.trim_end_matches('/').to_string();
            let target = format!("{dir_c}/{name}");
            Ok(StagePlan {
                dir: dir_c.clone(),
                name: name.clone(),
                target: target.clone(),
                temp: format!("{dir_c}/.tinyssh-part-{tid}-{name}"),
                lock_key: format!("r:{target}"),
            })
        } else {
            let path = std::path::Path::new(local);
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| Error::InvalidInput(format!("下载目标缺文件名：{remote}")))?
                .to_string();
            let dir = path
                .parent()
                .ok_or_else(|| Error::InvalidInput(format!("下载目标缺目录：{remote}")))?;
            tokio::fs::create_dir_all(dir)
                .await
                .map_err(|e| Error::Io(format!("mkdir {}: {e}", dir.display())))?;
            let canon = tokio::fs::canonicalize(dir)
                .await
                .map_err(|e| Error::Io(format!("canonicalize {}: {e}", dir.display())))?
                .to_string_lossy()
                .into_owned();
            let dir_c = canon.trim_end_matches('/').to_string();
            let target = format!("{dir_c}/{name}");
            Ok(StagePlan {
                dir: dir_c.clone(),
                name: name.clone(),
                target: target.clone(),
                temp: format!("{dir_c}/.tinyssh-part-{tid}-{name}"),
                lock_key: format!("l:{target}"),
            })
        }
    }

    /// C6/R34：temp 清理（确未提交路径专用；尽力而为，失败由调用方审计留痕）。
    async fn cleanup_temp(h: &Arc<SessionHandle>, is_upload: bool, temp: &str) {
        if !is_upload {
            // 本地 temp 直接删（不占通路；不存在=幂等）
            let _ = tokio::fs::remove_file(temp).await;
            return;
        }
        let _ = h.channel.remove_file(temp).await;
    }

    /// C6/R34：重启恢复的本地 temp 清理（下载任务确未提交/已确认提交——远端
    /// temp 需通道，登记延后）。temp 名与提交路径同源，不存在=幂等。
    fn cleanup_local_temp(t: &TransferTask) {
        if t.kind != TransferKind::Download {
            return;
        }
        let dest = std::path::Path::new(&t.dest);
        let Some(dir) = dest.parent() else { return };
        let Some(name) = dest.file_name().and_then(|n| n.to_str()) else { return };
        let tmp = dir.join(format!(".tinyssh-part-{}-{}", t.id, name));
        if tmp.exists() {
            let _ = std::fs::remove_file(&tmp);
        }
    }

    /// C6/R34：keep-both 候选名探位——name.tinyssh-N.ext（无扩展名则 name.tinyssh-N），
    /// N 递增至首个不存在位（上限 9999）；候选位竞态由发布原语 no-clobber 兜底
    ///（链接失败 → 冲突重裁决自然进位）。
    async fn keep_both_candidate(
        h: &Arc<SessionHandle>,
        is_upload: bool,
        dir: &str,
        name: &str,
    ) -> Result<String> {
        let (stem, ext) = match name.rsplit_once('.') {
            Some((s, e)) if !s.is_empty() && !e.is_empty() => (s, Some(e)),
            _ => (name, None),
        };
        for n in 1..=9999u32 {
            let cand = match ext {
                Some(e) => format!("{stem}.tinyssh-{n}.{e}"),
                None => format!("{name}.tinyssh-{n}"),
            };
            let p = format!("{}/{}", dir.trim_end_matches('/'), cand);
            match SessionManager::ns_stat(h, is_upload, &p).await {
                Err(Error::SftpPathNotFound { .. }) => return Ok(cand),
                Ok(_) => continue, // 已占用 → 下一位
                Err(e) => return Err(e),
            }
        }
        Err(Error::InvalidInput(format!("keep-both 候选名耗尽（{name}）")))
    }

    /// C6/R34：冲突共径（预检/复检/发布竞态三入口）。人类 → AwaitingDecision
    /// 决策卡；Agent → collision 处置（skip=Skipped / overwrite=ReplaceUnsupported
    /// 阻止 / fail（None）=ConflictDetected 结构化失败——永不进入待决态）。
    /// 返回 Some(候选名)=KeepBoth 探位成功继续发布；None=已终态收尾。
    #[allow(clippy::too_many_arguments)]
    async fn conflict_resolve(
        mgr: &Arc<SessionManager>,
        h: &Arc<SessionHandle>,
        tid: &TransferId,
        cancel: &CancellationToken,
        human: bool,
        agent_collision: Option<CollisionDecision>,
        is_upload: bool,
        target_path: &str,
        target_stat: Option<TargetStat>,
        reason: &str,
        dir: &str,
        orig_name: &str,
        temp: &str,
        _phase: &str,
    ) -> Option<String> {
        if human {
            match mgr.transfer_await_decision(tid, target_path, target_stat, reason, cancel).await {
                None => None, // 取消/作废：终态已落
                Some(CollisionDecision::Skip) => {
                    SessionManager::cleanup_temp(h, is_upload, temp).await;
                    mgr.transfer_finish(tid, TransferStatus::Skipped, 0, None);
                    None
                }
                Some(CollisionDecision::Overwrite) => {
                    // DF6.1 冻结：目标版本约束（CAS）原语不可得 → 覆盖发布一律阻止，
                    // 原目标零改动；确未提交 → temp 清理
                    SessionManager::cleanup_temp(h, is_upload, temp).await;
                    let msg = Error::ReplaceUnsupported { capability: "target_version_constraint".into() }.to_string();
                    mgr.transfer_finish(tid, TransferStatus::Failed, 0, Some(msg));
                    None
                }
                Some(CollisionDecision::KeepBoth) => {
                    match SessionManager::keep_both_candidate(h, is_upload, dir, orig_name).await {
                        Ok(c) => Some(c),
                        Err(e) => {
                            SessionManager::cleanup_temp(h, is_upload, temp).await;
                            mgr.transfer_finish(tid, TransferStatus::Failed, 0, Some(e.to_string()));
                            None
                        }
                    }
                }
            }
        } else {
            match agent_collision {
                Some(CollisionDecision::Skip) => {
                    SessionManager::cleanup_temp(h, is_upload, temp).await;
                    mgr.transfer_finish(tid, TransferStatus::Skipped, 0, None);
                    None
                }
                Some(CollisionDecision::Overwrite) => {
                    SessionManager::cleanup_temp(h, is_upload, temp).await;
                    let msg = Error::ReplaceUnsupported { capability: "target_version_constraint".into() }.to_string();
                    mgr.transfer_finish(tid, TransferStatus::Failed, 0, Some(msg));
                    None
                }
                _ => {
                    // fail（MCP 缺省）：结构化冲突——预检所见那份的 stat 随错误返回
                    SessionManager::cleanup_temp(h, is_upload, temp).await;
                    let msg = Error::ConflictDetected {
                        target_path: target_path.to_string(),
                        target_stat: target_stat.clone(),
                    }
                    .to_string();
                    mgr.transfer_finish(tid, TransferStatus::Failed, 0, Some(msg));
                    None
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// ~/.ssh/config 导入（路线图⑨）：CLI 与 GUI 共用的组合逻辑。
// 解析在 vault::sshcfg（纯函数）；这里做路径解析、与现有主机对账、
// 身份落库（IdentityFile → Key）或 ssh-agent 引用（无 IdentityFile → Agent）。
// ---------------------------------------------------------------------------

impl SessionManager {
    fn ssh_config_path(explicit: Option<&Path>) -> PathBuf {
        match explicit {
            Some(p) => p.to_path_buf(),
            None => std::env::var_os("HOME")
                .map(|h| PathBuf::from(h).join(".ssh/config"))
                .unwrap_or_else(|| PathBuf::from(".ssh/config")),
        }
    }

    fn load_entries(
        explicit: Option<&Path>,
    ) -> Result<(PathBuf, Vec<tinyssh_vault::sshcfg::SshConfigEntry>)> {
        let path = Self::ssh_config_path(explicit);
        let content = std::fs::read_to_string(&path).map_err(|e| {
            Error::InvalidInput(format!("读取 {} 失败: {e}", path.display()))
        })?;
        let mut entries = tinyssh_vault::sshcfg::parse_ssh_config(&content);
        // 同名 Host 块会被 ssh 合并；去重避免重复导入
        entries.dedup_by(|a, b| a.name == b.name);
        Ok((path, entries))
    }

    fn default_username(entry: &tinyssh_vault::sshcfg::SshConfigEntry) -> String {
        entry
            .username
            .clone()
            .or_else(|| std::env::var("USER").ok())
            .unwrap_or_else(|| "root".into())
    }

    /// C7/DF7.1+DF7.5：无阻断指令且已指定用户才可直接导入
    fn directly_importable(entry: &tinyssh_vault::sshcfg::SshConfigEntry) -> bool {
        entry.unsupported.iter().all(|u| !u.blocking) && entry.username.is_some()
    }

    /// 预览（C7）：解析 + DF7.1 分级 + 与现有主机对账（同名或同 address+port+user
    /// 视为已导入）。无 User 条目不静默 root——user_specified=false、
    /// directly_importable=false（DF7.5），username 仅作兜底猜测值。
    pub async fn ssh_config_preview(
        &self,
        path: Option<&Path>,
    ) -> Result<Vec<SshConfigPreview>> {
        let (cfg_path, entries) = Self::load_entries(path)?;
        let existing = self.list_hosts(&Actor::Human).await?;
        Ok(entries
            .into_iter()
            .map(|e| {
                let username = Self::default_username(&e);
                let port = e.port.unwrap_or(22);
                let unsupported = e
                    .unsupported
                    .iter()
                    .map(|u| SshUnsupportedDirective {
                        directive: u.directive.clone(),
                        level: if u.blocking {
                            SshUnsupportedLevel::Blocking
                        } else {
                            SshUnsupportedLevel::Warning
                        },
                        line: u.line,
                    })
                    .collect();
                SshConfigPreview {
                    already_imported: existing.iter().any(|h| {
                        h.name == e.name
                            || (h.address == e.address
                                && h.port == port
                                && h.username == username)
                    }),
                    has_identity: e.identity_path.is_some(),
                    directly_importable: Self::directly_importable(&e),
                    user_specified: e.username.is_some(),
                    source_file: cfg_path.display().to_string(),
                    source_line: e.source_line,
                    unsupported,
                    name: e.name,
                    address: e.address,
                    port,
                    username,
                }
            })
            .collect())
    }

    /// 勾选导入（C7）：阻断条目拒绝（skipped=Blocked）；重复（同名 OR
    /// address+port+user）默认跳过（skipped=Duplicate），overwrite=true 时以既有
    /// 主机 id 覆盖写入（DF7.3）。逐条出结果，单条失败不阻塞其余。
    pub async fn ssh_config_import(
        &self,
        ctx: &Actor,
        path: Option<&Path>,
        names: &[String],
        overwrite: bool,
    ) -> Vec<SshImportOutcome> {
        let load = Self::load_entries(path);
        let (entries, existing) = match load {
            Ok((_, e)) => match self.list_hosts(ctx).await {
                Ok(h) => (e, h),
                Err(err) => {
                    return names
                        .iter()
                        .map(|n| SshImportOutcome {
                            name: n.clone(),
                            host_id: None,
                            error: Some(err.to_string()),
                            skipped_reason: None,
                        })
                        .collect();
                }
            },
            Err(e) => {
                return names
                    .iter()
                    .map(|n| SshImportOutcome {
                        name: n.clone(),
                        host_id: None,
                        error: Some(e.to_string()),
                        skipped_reason: None,
                    })
                    .collect();
            }
        };
        let mut out = Vec::new();
        // rev-r22 M3：批内可见性——成功导入的主机立即并入查重集，同批后续
        // 同三元组条目按 Duplicate 跳过（不双落库），与重新预览的对账一致
        let mut known: Vec<(String, String, String, u16, String)> = existing
            .iter()
            .map(|h| (h.id.clone(), h.name.clone(), h.address.clone(), h.port, h.username.clone()))
            .collect();
        for name in names {
            let skipped = |reason: SshSkipReason| SshImportOutcome {
                name: name.clone(),
                host_id: None,
                error: None,
                skipped_reason: Some(reason),
            };
            let Some(entry) = entries.iter().find(|e| &e.name == name) else {
                out.push(SshImportOutcome {
                    name: name.clone(),
                    host_id: None,
                    error: Some("配置中找不到该条目".into()),
                    skipped_reason: None,
                });
                continue;
            };
            if !Self::directly_importable(entry) {
                out.push(skipped(SshSkipReason::Blocked));
                continue;
            }
            let port = entry.port.unwrap_or(22);
            let username = Self::default_username(entry);
            let dup = known.iter().find(|(_, n, a, p, u)| {
                n == &entry.name || (a == &entry.address && *p == port && u == &username)
            });
            // DF7.3：重复默认跳过；overwrite=true 以既有 id 覆盖写入
            let host_id = if overwrite {
                dup.map(|h| h.0.clone())
            } else {
                if dup.is_some() {
                    out.push(skipped(SshSkipReason::Duplicate));
                    continue;
                }
                None
            };
            let r = async {
                let auth = match &entry.identity_path {
                    Some(p) => {
                        let pem = tokio::fs::read_to_string(p).await.map_err(|e| {
                            Error::InvalidInput(format!("读取私钥 {} 失败: {e}", p.display()))
                        })?;
                        let meta = self
                            .create_identity(
                                ctx,
                                IdentityReq::Import {
                                    label: name.clone(),
                                    pem,
                                    passphrase: None,
                                },
                            )
                            .await
                            .map_err(|e| match e {
                                // 加密私钥无口令解不开：明说，不静默降级
                                Error::InvalidInput(m) if m.contains("passphrase") => {
                                    Error::InvalidInput("私钥有口令，请先在应用内手工导入".into())
                                }
                                other => other,
                            })?;
                        AuthDraft::Key { identity_id: meta.id }
                    }
                    None => AuthDraft::Agent,
                };
                self.upsert_host(
                    ctx,
                    HostDraft {
                        id: host_id,
                        name: name.clone(),
                        address: entry.address.clone(),
                        port: Some(port),
                        username: username.clone(),
                        auth,
                        tags: vec!["ssh-config".into()],
                        charset: Charset::Utf8,
                        shell_integration: Some(true), // ssh-config 导入=存量 SSH 主机同口径（DC3.2）
                    },
                )
                .await
            }
            .await;
            match r {
                Ok(hid) => {
                    known.push((hid.clone(), name.clone(), entry.address.clone(), port, username.clone()));
                    out.push(SshImportOutcome {
                        name: name.clone(),
                        host_id: Some(hid),
                        error: None,
                        skipped_reason: None,
                    });
                }
                Err(e) => out.push(SshImportOutcome {
                    name: name.clone(),
                    host_id: None,
                    error: Some(e.to_string()),
                    skipped_reason: None,
                }),
            }
        }
        out
    }
}

#[cfg(test)]
mod t44_tests {
    use super::*;

    /// 编辑后批准统一拦截（复审②）：None（普通批准）/等文本编辑 → 放行；
    /// 异文本编辑 → 拒。四类卡（转发/停转发/send_keys/传输）共用此口径。
    #[test]
    fn reject_edited_approval_gates_non_exec_cards() {
        let orig = "端口转发 -L 127.0.0.1:8080 → 10.0.0.1:22";
        assert!(SessionManager::reject_edited_approval(&None, orig, "端口转发审批").is_ok());
        assert!(SessionManager::reject_edited_approval(&Some(orig.to_string()), orig, "端口转发审批").is_ok());
        let err = SessionManager::reject_edited_approval(
            &Some("端口转发 -L 127.0.0.1:9999 → 别处:22".to_string()), orig, "端口转发审批",
        ).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("不支持编辑后批准"), "{msg}");
        assert!(msg.contains("端口转发审批"), "报错应指明卡类：{msg}");
    }
}

#[cfg(test)]
#[path = "c1_tests.rs"]
mod c1_tests;

#[cfg(test)]
#[path = "r24_tests.rs"]
mod r24_tests;

#[cfg(test)]
#[path = "r26_tests.rs"]
mod r26_tests;

#[cfg(test)]
#[path = "r30_tests.rs"]
mod r30_tests;

#[cfg(test)]
#[path = "r32_tests.rs"]
mod r32_tests;
#[cfg(test)]
#[path = "r34_tests.rs"]
mod r34_tests;
#[cfg(test)]
#[path = "r35_tests.rs"]
mod r35_tests;
#[cfg(test)]
#[path = "r40_tests.rs"]
mod r40_tests;
#[cfg(test)]
#[path = "r41_tests.rs"]
mod r41_tests;

#[cfg(test)]
#[path = "r42_tests.rs"]
mod r42_tests;
#[cfg(test)]
mod c10_tests {
    //! C10 订阅恢复与生命周期（R11）。不建真 PTY：手工装配 SessionHandle
    //! （屏幕/环/注册表全 pub 字段），以 handle::feed_output 走唯一线性化点。

    use super::*;
    use crate::handle::{REPLAY_CAP_BYTES, ReplayRing};
    use session_api::transport::{ChannelHandle, FreshOutcome, TransportSignal};
    use std::sync::atomic::Ordering;

    struct StubChannel;
    #[async_trait::async_trait]
    impl ChannelHandle for StubChannel {
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
    }

    fn mgr() -> Arc<SessionManager> {
        // 主密钥走 env（vault 解析序 env > OS 钥匙串）：测试二进制重编译后签名
        // 变化会使钥匙串 ACL 失效，触发授权弹窗阻塞整个测试进程。
        if std::env::var("TINYSSH_MASTER_KEY").is_err() {
            std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
        }
        let dir = std::env::temp_dir().join(format!("c10-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        SessionManager::open(&dir.join("t.db")).unwrap()
    }

    fn mk_handle(center: Arc<ApprovalCenter>) -> Arc<SessionHandle> {
        let host = Host {
            id: "local".into(),
            name: "c10".into(),
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
        SessionHandle::new("s-c10".into(), host, "local".into(), Arc::new(StubChannel), screen, center, ControlOwner::Agent)
    }

    /// 注册一个手装会话（绕过 create_session 的真实传输）。
    fn register(m: &SessionManager, h: Arc<SessionHandle>) {
        m.sessions.lock().unwrap().insert(h.id.clone(), h.clone());
    }

    #[tokio::test]
    async fn attach_watermark_includes_last_event() {
        let m = mgr();
        let h = mk_handle(m.center.clone());
        register(&m, h.clone());
        let s1 = h.feed_output(b"one").await;
        let s2 = h.feed_output(b"two").await;
        assert_eq!((s1, s2), (1, 2));
        let (attach, _rx, _cancel) = m.subscribe_output_channel("s-c10".into()).await.unwrap();
        // 水位 = 最后已包含事件的序号（包含）
        assert_eq!(attach.start_seq, 2);
        // 检查点包含末事件内容（不能截到已推进 seq、尚未应用到屏幕）
        let joined: String = attach.checkpoint.buffers[0].lines.iter().flatten().map(|r| r.text.as_str()).collect();
        assert!(joined.contains("one") && joined.contains("two"), "{joined:?}");
        assert_eq!(m.debug_subscriptions().active_count, 1);
    }

    #[tokio::test]
    async fn resync_replay_and_exactly_at_watermark() {
        let m = mgr();
        let h = mk_handle(m.center.clone());
        register(&m, h.clone());
        for i in 1..=3 {
            h.feed_output(format!("c{i}").as_bytes()).await;
        }
        let (attach, _, _) = m.subscribe_output_channel("s-c10".into()).await.unwrap();
        let sub = attach.subscription_id;
        // attach 已在 seq3 捕获检查点：from=1 早于检查点 →「检查点更近」走 checkpoint（契约字面）
        assert!(matches!(
            m.resync_output("s-c10".into(), &sub, Some(1)).await.unwrap(),
            ResyncOutput::Checkpointed { .. }
        ));
        // attach 后新事件 seq4：from=3（恰为水位）→ 重放 [4]；水位包含末事件
        h.feed_output(b"c4").await;
        match m.resync_output("s-c10".into(), &sub, Some(3)).await.unwrap() {
            ResyncOutput::Replayed { events, end_seq, .. } => {
                assert_eq!(events.len(), 1);
                assert_eq!(events[0].seq, 4);
                assert_eq!(end_seq, 4);
            }
            other => panic!("expected replay, got {other:?}"),
        }
        // seq 恰等于水位（4=cur）：不重放（空 events）
        match m.resync_output("s-c10".into(), &sub, Some(4)).await.unwrap() {
            ResyncOutput::Replayed { events, end_seq, .. } => {
                assert!(events.is_empty());
                assert_eq!(end_seq, 4);
            }
            other => panic!("expected empty replay, got {other:?}"),
        }
        // UI 领先核心（不可能态）：同样空重放
        match m.resync_output("s-c10".into(), &sub, Some(9)).await.unwrap() {
            ResyncOutput::Replayed { events, .. } => assert!(events.is_empty()),
            other => panic!("expected empty replay, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn expired_subscription_rejected_without_fallback() {
        let m = mgr();
        let h = mk_handle(m.center.clone());
        register(&m, h.clone());
        h.feed_output(b"x").await;
        let old = m.subscribe_output_channel("s-c10".into()).await.unwrap().0.subscription_id;
        m.unsubscribe_output("s-c10".into(), &old).await.unwrap();
        // 过期订阅：拒绝（不改任何状态），且不得回落到同 session 新订阅
        assert!(m.resync_output("s-c10".into(), &old, Some(1)).await.is_err());
        let new = m.subscribe_output_channel("s-c10".into()).await.unwrap().0.subscription_id;
        assert_ne!(old, new);
        assert!(m.resync_output("s-c10".into(), &old, Some(1)).await.is_err());
        // 新订阅正常
        assert!(m.resync_output("s-c10".into(), &new, Some(1)).await.is_ok());
        // 退订幂等：重复/旧身份 no-op
        m.unsubscribe_output("s-c10".into(), &old).await.unwrap();
        m.unsubscribe_output("s-c10".into(), &new).await.unwrap();
        assert_eq!(m.debug_subscriptions().active_count, 0);
        // 会话不存在同样 no-op（UI 收尾可能晚于 close_session）
        m.unsubscribe_output("s-gone".into(), &old).await.unwrap();
    }

    #[tokio::test]
    async fn eviction_and_alt_screen_fall_back_to_checkpoint() {
        let m = mgr();
        let h = mk_handle(m.center.clone());
        register(&m, h.clone());
        for i in 1..=3 {
            h.feed_output(format!("c{i}").as_bytes()).await;
        }
        let sub = m.subscribe_output_channel("s-c10".into()).await.unwrap().0.subscription_id;
        h.feed_output(b"post-attach").await;
        // 淘汰：清空重放环（模拟窗口滑出）→ checkpoint 路径
        h.replay.lock().unwrap().q.clear();
        match m.resync_output("s-c10".into(), &sub, Some(1)).await.unwrap() {
            ResyncOutput::Checkpointed { end_seq, checkpoint, .. } => {
                assert_eq!(end_seq, 4);
                let joined: String = checkpoint.buffers[0].lines.iter().flatten().map(|r| r.text.as_str()).collect();
                assert!(joined.contains("post-attach"));
            }
            other => panic!("expected checkpoint, got {other:?}"),
        }
        // alt_screen 活跃 → checkpoint 路径（C-03）
        h.replay.lock().unwrap().q.clear();
        h.feed_output(b"\x1b[?1049h\x1b[2J\x1b[Halt-on").await;
        match m.resync_output("s-c10".into(), &sub, Some(2)).await.unwrap() {
            ResyncOutput::Checkpointed { checkpoint, .. } => {
                assert_eq!(checkpoint.active_buffer, 1);
            }
            other => panic!("expected checkpoint for alt screen, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn checkpoint_nearer_beats_replay() {
        let m = mgr();
        let h = mk_handle(m.center.clone());
        register(&m, h.clone());
        h.feed_output(b"a").await; // seq 1
        let (attach, _, _) = m.subscribe_output_channel("s-c10".into()).await.unwrap();
        assert_eq!(attach.start_seq, 1); // attach 已捕获检查点 @1
        h.feed_output(b"b").await; // seq 2
        // from=0：检查点(@1) 比 from 更近 → checkpoint 路径（契约字面）
        match m.resync_output("s-c10".into(), &attach.subscription_id, Some(0)).await.unwrap() {
            ResyncOutput::Checkpointed { end_seq, .. } => assert_eq!(end_seq, 2),
            other => panic!("expected checkpoint, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn silent_session_sub_persists_until_explicit_unsubscribe() {
        // C-03：静默会话不得依赖 send 失败清理——stub 通道恒死，
        // 订阅仍须存活直至显式退订/会话关闭。
        let m = mgr();
        let h = mk_handle(m.center.clone());
        register(&m, h.clone());
        let _ = m.subscribe_output_channel("s-c10".into()).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(m.debug_subscriptions().active_count, 1);
        // 会话关闭即自动清理
        m.sessions.lock().unwrap().remove("s-c10");
        assert_eq!(m.debug_subscriptions().active_count, 0);
    }

    #[test]
    fn replay_ring_eviction_semantics() {
        let mut ring = ReplayRing::default();
        for i in 1..=5u64 {
            ring.push(i, vec![i as u8]);
        }
        assert!(ring.covers_from(4)); // 首帧1 <= 5 → (4,∞) 可重放
        assert!(ring.covers_from(0));
        // 淘汰 1、2 → (1,∞) 不可重放，(2,∞) 可
        ring.q.pop_front();
        assert!(!ring.covers_from(0));
        assert!(ring.covers_from(1));
        ring.q.pop_front();
        assert!(!ring.covers_from(1));
        assert!(ring.covers_from(2));
        // 字节数上限淘汰
        let mut big = ReplayRing::default();
        big.push(1, vec![0u8; REPLAY_CAP_BYTES + 1]);
        big.push(2, vec![1u8]);
        assert_eq!(big.q.len(), 1); // 帧1被挤出
        assert_eq!(big.bytes, 1);
    }
}
