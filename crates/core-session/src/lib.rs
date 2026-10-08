//! core-session：SessionApi 实现（L1 §2/§3.1）。
//! 双前端（GUI/MCP）唯一核心；审批在门面之后强制挂接（L0 ADR-5）。

mod brief;
mod charset;
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
        });
        *arc.self_weak.lock().unwrap() = Some(Arc::downgrade(&arc));
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
        let handle = SessionHandle::new(sid.clone(), host.clone(), kind.clone(), channel, screen, self.center.clone());
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

        // 远端注入 shell 集成（本地已在 PTY 启动时注入）。
        // 登记用原 UTF-8（屏态吃泵侧解码后的回显）；snippet 纯 ASCII，GBK 下编码恒等。
        if kind == "ssh" {
            let snippet = ssh_integration_snippet();
            let mut text = snippet.to_string();
            text.push('\n');
            {
                let mut s = handle.screen.lock().await;
                s.register_outgoing(text.as_bytes(), term_core::BlockSource::Human);
            }
            handle.channel.write(&charset::encode(handle.host.charset, &text)).await?;
            let _ = self.center.audit.append(
                ctx, "shell_integration_inject", Some(&sid), Some("OSC133+OSC7"), serde_json::json!({}), None);
        }

        // 等待集成生效（最多 10s；失败不阻断——Shell 模式将自动降级 Fresh）。
        // 窗口须覆盖全量回归时编译与测试争抢 CPU 的首个提示符延迟（实测 5s 不够）。
        for _ in 0..200 {
            if handle.screen.lock().await.shell_integration_present() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        self.center.vault.record_session(&sid, &host.id, &kind)?;
        // C8：成功建连打点（host_metadata.last_connected_at；最近连接由 sessions
        // 表派生，此处只供元数据展示）
        let _ = self.center.vault.touch_host_connection(&host.id);
        let _ = self.center.audit.append(
            ctx, "session_created", Some(&sid), None,
            serde_json::json!({"host": host.id, "kind": kind}), None);
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
                created_at: chrono::Utc::now(),
            });
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
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
                        .wait_approval(ctx, client_id, &"send_keys".to_string(), &format!("send_keys {keys:?}"), &eval, false, CancellationToken::new())
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

    // ---- 传输 ----
    async fn upload(&self, ctx: &Actor, sid: SessionId, local: &Path, remote: &str) -> Result<TransferHandle> {
        self.transfer(ctx, sid, local.to_path_buf(), remote.to_string(), true).await
    }

    async fn download(&self, ctx: &Actor, sid: SessionId, remote: &str, local: &Path) -> Result<TransferHandle> {
        self.transfer(ctx, sid, local.to_path_buf(), remote.to_string(), false).await
    }

    async fn cancel_transfer(&self, _ctx: &Actor, t: TransferId) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        for h in sessions.values() {
            if let Some(c) = h.transfers.lock().unwrap().get(&t) {
                c.cancel();
                return Ok(());
            }
        }
        Err(Error::InvalidInput("transfer not found".into()))
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
            let (trace, edited) = h.wait_approval(ctx, client_id, &"forward_start".to_string(), &desc, &eval, false, CancellationToken::new()).await?;
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
            let (trace, edited) = h.wait_approval(ctx, client_id, &"forward_stop".to_string(), &desc, &eval, false, CancellationToken::new()).await?;
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
        let items = self.center.items.lock().unwrap();
        Ok(items
            .values()
            .filter(|it| {
                f.session_id.as_ref().map(|s| &it.session_id == s).unwrap_or(true)
                    && f.agent_id.as_ref().map(|a| &it.agent_id == a).unwrap_or(true)
                    && (!f.pending_only || it.status == ApprovalStatus::Pending)
            })
            .cloned()
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
        // 先订阅：新传输的输出不得落入无订阅者窗口（§6.1-11 同源根因）
        let rx = h.channel.subscribe_output();
        let mut last_err = None;
        for attempt in 1..=3 {
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

    async fn transfer(
        &self,
        ctx: &Actor,
        sid: SessionId,
        local: PathBuf,
        remote: String,
        is_upload: bool,
    ) -> Result<TransferHandle> {
        let h = self.get(&sid)?;
        if !ctx.is_human() && *h.owner.lock().await == ControlOwner::Human {
            return Err(Error::ControlTakenByHuman);
        }
        // 重确认期间 Agent 动作被拒（L1 §3.1：普通动作不开放）
        if !ctx.is_human() && *h.state.lock().await == SessionState::Reconfirming {
            return Err(Error::ReconfirmingPending);
        }
        // Agent 传输必审（L1 §4）
        let mut edited: Option<String> = None;
        if let Actor::Agent { client_id } = ctx {
            let op = if is_upload { "upload" } else { "download" };
            let eval = tinyssh_approval::Evaluation {
                verdict: tinyssh_approval::SegmentVerdict::NeedsApproval,
                segments: vec![SegmentReport {
                    segment: format!("{op} → {remote}"),
                    verdict: "pending: 传输必审".into(),
                }],
            };
            let (trace, e) = h
                .wait_approval(ctx, client_id, &"transfer".to_string(), &format!("{op} {local:?} → {remote}"), &eval, false, CancellationToken::new())
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

        // 执行任务（串行化并入 exec 队列之外的独立通道；MVP 直接执行）
        let h2 = h.clone();
        let sid2 = sid.clone();
        let tid2 = tid.clone();
        let ctx2 = ctx.clone();
        let gen = h.generation.load(std::sync::atomic::Ordering::SeqCst);
        let remote2 = remote.clone();
        let local2 = local.clone();
        tokio::spawn(async move {
            if h2.generation.load(std::sync::atomic::Ordering::SeqCst) != gen {
                let _ = h2.center.audit.append(
                    &ctx2, "transfer_voided", Some(&sid2), Some(&remote2),
                    serde_json::json!({"transfer": tid2, "reason": "voided_by_handback"}), None);
                h2.transfers.lock().unwrap().remove(&tid2);
                return;
            }
            let r = if is_upload {
                h2.channel.upload(&local2, &remote2, &cancel).await
            } else {
                h2.channel.download(&remote2, &local2, &cancel).await
            };
            match r {
                Ok(bytes) => {
                    let _ = h2.center.audit.append(
                        &ctx2, "transfer_done", Some(&sid2), Some(&remote2),
                        serde_json::json!({"transfer": tid2, "bytes": bytes}), None);
                }
                Err(e) => {
                    let _ = h2.center.audit.append(
                        &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                        serde_json::json!({"transfer": tid2, "error": e.to_string()}), None);
                }
            }
            h2.transfers.lock().unwrap().remove(&tid2);
        });
        Ok(handle)
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

    fn load_entries(explicit: Option<&Path>) -> Result<Vec<tinyssh_vault::sshcfg::SshConfigEntry>> {
        let path = Self::ssh_config_path(explicit);
        let content = std::fs::read_to_string(&path).map_err(|e| {
            Error::InvalidInput(format!("读取 {} 失败: {e}", path.display()))
        })?;
        let mut entries = tinyssh_vault::sshcfg::parse_ssh_config(&content);
        // 同名 Host 块会被 ssh 合并；去重避免重复导入
        entries.dedup_by(|a, b| a.name == b.name);
        Ok(entries)
    }

    fn default_username(entry: &tinyssh_vault::sshcfg::SshConfigEntry) -> String {
        entry
            .username
            .clone()
            .or_else(|| std::env::var("USER").ok())
            .unwrap_or_else(|| "root".into())
    }

    /// 预览：解析 + 与现有主机对账（同名或同 address+port+user 视为已导入）。
    pub async fn ssh_config_preview(
        &self,
        path: Option<&Path>,
    ) -> Result<Vec<SshConfigPreview>> {
        let entries = Self::load_entries(path)?;
        let existing = self.list_hosts(&Actor::Human).await?;
        Ok(entries
            .into_iter()
            .map(|e| {
                let username = Self::default_username(&e);
                let port = e.port.unwrap_or(22);
                SshConfigPreview {
                    already_imported: existing.iter().any(|h| {
                        h.name == e.name
                            || (h.address == e.address
                                && h.port == port
                                && h.username == username)
                    }),
                    has_identity: e.identity_path.is_some(),
                    name: e.name,
                    address: e.address,
                    port,
                    username,
                }
            })
            .collect())
    }

    /// 勾选导入。逐条出结果，单条失败不阻塞其余（UI 逐行展示）。
    /// 有 IdentityFile 且可读 → 私钥入 vault（Key）；否则走本机 ssh-agent（Agent）。
    pub async fn ssh_config_import(
        &self,
        ctx: &Actor,
        path: Option<&Path>,
        names: &[String],
    ) -> Vec<SshImportOutcome> {
        let mut out = Vec::new();
        let entries = match Self::load_entries(path) {
            Ok(e) => e,
            Err(e) => {
                return names
                    .iter()
                    .map(|n| SshImportOutcome {
                        name: n.clone(),
                        host_id: None,
                        error: Some(e.to_string()),
                    })
                    .collect();
            }
        };
        for name in names {
            let Some(entry) = entries.iter().find(|e| &e.name == name) else {
                out.push(SshImportOutcome {
                    name: name.clone(),
                    host_id: None,
                    error: Some("配置中找不到该条目".into()),
                });
                continue;
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
                        id: None,
                        name: name.clone(),
                        address: entry.address.clone(),
                        port: Some(entry.port.unwrap_or(22)),
                        username: Self::default_username(entry),
                        auth,
                        tags: vec!["ssh-config".into()],
                        charset: Charset::Utf8,
                    },
                )
                .await
            }
            .await;
            match r {
                Ok(hid) => out.push(SshImportOutcome {
                    name: name.clone(),
                    host_id: Some(hid),
                    error: None,
                }),
                Err(e) => out.push(SshImportOutcome {
                    name: name.clone(),
                    host_id: None,
                    error: Some(e.to_string()),
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
        async fn upload(&self, _local: &std::path::Path, _remote: &str, _cancel: &session_api::transport::tokio_util_sync::CancellationToken) -> Result<u64> { Err(Error::InvalidInput("stub".into())) }
        async fn download(&self, _remote: &str, _local: &std::path::Path, _cancel: &session_api::transport::tokio_util_sync::CancellationToken) -> Result<u64> { Err(Error::InvalidInput("stub".into())) }
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
        };
        let screen = term_core::Screen::new(term_core::ScreenConfig {
            cols: 80, rows: 24, scrollback: 100, lossless_cap: 1 << 20,
        });
        SessionHandle::new("s-c10".into(), host, "local".into(), Arc::new(StubChannel), screen, center)
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
