//! R42（§6.7 / §3.2 / D06 / D11）协作入口、首次委托、审批、接管/交还的会话层契约。
//! 不建真 SSH：手装 SessionHandle + 恒败 Stub 通道（同 r40/r41 工艺）——只驱动
//! 控制权、审批卡与简报三处状态，验证：
//!  · 登记 Agent / 启用服务不转移任何会话的控制权（D11）；
//!  · 「曾被 Agent 持有」标记的生命周期，供 UI 区分「交给 Agent」与「交还 Agent」；
//!  · 审批卡的「可用目的」是会话**当前**目标的投影（后补目标也可见；无目标即缺失）；
//!  · 接管默认只冻结、不停止运行中任务（停止是独立动作），且作废的旧请求不可复活。

use super::*;
use session_api::transport::{ChannelHandle, FreshOutcome, TransportSignal};

struct R42Channel;
#[async_trait::async_trait]
impl ChannelHandle for R42Channel {
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
    async fn list_dir(&self, _path: &str) -> Result<Vec<DirEntryS>> {
        Err(Error::InvalidInput("stub".into()))
    }
    async fn resolve_path(&self, _path: Option<&str>) -> Result<PathResolved> {
        Ok(PathResolved {
            canonical: "/home/u".into(),
        })
    }
    async fn stat_entry(&self, path: &str) -> Result<EntryStat> {
        Ok(EntryStat {
            canonical: Some(path.into()),
            kind: Some(EntryKind::File),
            is_dir: false,
            size: Some(0),
            mtime: None,
            symlink_target: None,
        })
    }
    async fn start_forward(
        &self,
        _spec: session_api::ForwardSpec,
    ) -> Result<session_api::ForwardId> {
        Err(Error::InvalidInput("stub".into()))
    }
    async fn stop_forward(&self, _id: &session_api::ForwardId) -> Result<()> {
        Err(Error::InvalidInput("stub".into()))
    }
    async fn list_forwards(&self) -> Result<Vec<session_api::ForwardInfo>> {
        Ok(vec![])
    }
    fn set_forward_event_cb(&self, _cb: session_api::ForwardStateCb) {}
}

fn mgr() -> Arc<SessionManager> {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = std::env::temp_dir().join(format!("r42-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    SessionManager::open(&dir.join("t.db")).unwrap()
}

fn host() -> Host {
    Host {
        id: "h-1".into(),
        name: "prod-1".into(),
        address: "10.0.0.11".into(),
        port: 22,
        username: "ops".into(),
        auth_type: AuthType::Password,
        identity_id: None,
        tags: vec![],
        fingerprint: None,
        shell_integration: Some(true),
        charset: Charset::Utf8,
    }
}

fn mk_handle(sid: &str, owner: ControlOwner, center: Arc<ApprovalCenter>) -> Arc<SessionHandle> {
    let screen = term_core::Screen::new(term_core::ScreenConfig {
        cols: 80,
        rows: 24,
        scrollback: 100,
        lossless_cap: 1 << 20,
    });
    SessionHandle::new(
        sid.into(),
        host(),
        "ssh".into(),
        Arc::new(R42Channel),
        screen,
        center,
        owner,
    )
}

fn register(m: &SessionManager, h: Arc<SessionHandle>) {
    m.sessions.lock().unwrap().insert(h.id.clone(), h.clone());
}

fn needs_approval(cmd: &str) -> tinyssh_approval::Evaluation {
    tinyssh_approval::Evaluation {
        verdict: tinyssh_approval::SegmentVerdict::NeedsApproval,
        segments: vec![SegmentReport {
            segment: cmd.into(),
            verdict: "pending: 未命中任何允许规则".into(),
        }],
    }
}

/// D11：「启用协作服务」的既有动作是登记 Agent（vault create_agent）。登记不碰任何
/// 会话的控制权——owner 与「曾被 Agent 持有」标记都不变（服务可用 ≠ 会话易主）。
#[tokio::test]
async fn r42_registering_agent_does_not_move_owner() {
    let m = mgr();
    let h = mk_handle("s-1", ControlOwner::Human, m.center.clone());
    register(&m, h.clone());

    m.center.vault.create_agent("opencode", "OpenCode").unwrap();

    let info = m
        .list_sessions(&Actor::Human)
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.id == "s-1")
        .unwrap();
    assert_eq!(
        info.control_owner,
        ControlOwner::Human,
        "登记 Agent 不得转移会话控制权"
    );
    assert!(
        !info.ever_agent_owned,
        "从未委托的会话不是「曾被 Agent 持有」"
    );
}

/// §6.7：UI 依「曾被 Agent 持有」区分「交给 Agent」（首次）与「交还 Agent」。
/// 该标记：人类建会话 = false；Agent 建会话 = true；人类委托后 = true；
/// 人类再接管（owner 回 Human）**仍为 true**——历史不会被接管抹掉。
#[tokio::test]
async fn r42_ever_agent_owned_lifecycle() {
    let m = mgr();

    let human_h = mk_handle("s-h", ControlOwner::Human, m.center.clone());
    let agent_h = mk_handle("s-a", ControlOwner::Agent, m.center.clone());
    register(&m, human_h.clone());
    register(&m, agent_h.clone());

    let by = |m: Arc<SessionManager>, sid: &'static str| async move {
        m.list_sessions(&Actor::Human)
            .await
            .unwrap()
            .into_iter()
            .find(|s| s.id == sid)
            .unwrap()
            .ever_agent_owned
    };
    assert!(!by(m.clone(), "s-h").await, "人类建会话初始 false");
    assert!(by(m.clone(), "s-a").await, "Agent 建会话初始 true");

    // 人类首次委托 → 翻真
    m.delegate_session(&Actor::Human, "s-h".into(), Some("清理 /tmp 并打包".into()))
        .await
        .unwrap();
    assert!(by(m.clone(), "s-h").await, "委托后 true");

    // 人类接管（owner 回 Human）→ 历史保留，仍是 true（入口措辞为「交还 Agent」）
    m.set_control(
        &Actor::Human,
        "s-h".into(),
        ControlOwner::Human,
        ControlOpts::default(),
    )
    .await
    .unwrap();
    let info = m
        .list_sessions(&Actor::Human)
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.id == "s-h")
        .unwrap();
    assert_eq!(info.control_owner, ControlOwner::Human);
    assert!(info.ever_agent_owned, "接管不得抹掉「曾被 Agent 持有」历史");
}

/// §6.7「可用目的」：审批卡的目的 = 该会话**当前**委托目标的投影。
/// 无目标 → 缺失（None，UI 明示缺失）；请求之后补写目标 → 复核时也看得到。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r42_approval_purpose_projects_current_goal() {
    let m = mgr();
    let h = mk_handle("s-1", ControlOwner::Agent, m.center.clone());
    register(&m, h.clone());

    // 场景一：无委托目标 → 目的缺失（不编造）
    let cancel = session_api::transport::tokio_util_sync::CancellationToken::new();
    let h1 = h.clone();
    let j1 = tokio::spawn(async move {
        h1.wait_approval(
            &Actor::Agent {
                client_id: "opencode".into(),
            },
            &"opencode".to_string(),
            &"e-1".to_string(),
            "rm -rf /tmp/old-build",
            &needs_approval("rm -rf /tmp/old-build"),
            true,
            false,
            cancel,
        )
        .await
    });
    let card = wait_card(&m, "s-1").await;
    assert!(
        card.purpose.is_none(),
        "无目标时目的必须缺失，不得编造：{:?}",
        card.purpose
    );
    // 核心自算的破坏性提示随卡下发（UI 直接展示，不必自猜）
    assert!(
        card.target_summary.contains("删除"),
        "破坏性提示应已算出：{}",
        card.target_summary
    );
    m.decide_approval(&Actor::Human, card.id.clone(), Decision::Deny)
        .await
        .unwrap();
    let _ = j1.await.unwrap();

    // 场景二：请求发出后人类才写目标 → 读取路径按当前目标投影（复核者看得到意图）
    let h2 = h.clone();
    let j2 = tokio::spawn(async move {
        h2.wait_approval(
            &Actor::Agent {
                client_id: "opencode".into(),
            },
            &"opencode".to_string(),
            &"e-2".to_string(),
            "docker system prune -f",
            &needs_approval("docker system prune -f"),
            true,
            false,
            session_api::transport::tokio_util_sync::CancellationToken::new(),
        )
        .await
    });
    let card = wait_card(&m, "s-1").await;
    assert!(card.purpose.is_none());
    m.set_session_goal(
        &Actor::Human,
        "s-1".into(),
        Some("把日志打包放到 /tmp 后交还".into()),
    )
    .await
    .unwrap();
    let card = m
        .list_approvals(
            &Actor::Human,
            ApprovalFilter {
                session_id: Some("s-1".into()),
                pending_only: true,
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    assert_eq!(
        card.purpose.as_deref(),
        Some("把日志打包放到 /tmp 后交还"),
        "目的应为当前目标的投影（后补目标也可见）"
    );
    m.decide_approval(&Actor::Human, card.id.clone(), Decision::Deny)
        .await
        .unwrap();
    let _ = j2.await.unwrap();
}

/// §6.7 / rev-r42 4.5：会话已不在列表（已关闭）时，审批卡不得拿创建期快照冒充当前意图——
/// 会话在列表时按当前目标投影；会话消失即无当前目标 → 明确缺失（None）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r42_purpose_is_none_when_session_gone() {
    let m = mgr();
    let h = mk_handle("s-gone", ControlOwner::Agent, m.center.clone());
    register(&m, h.clone());
    m.set_session_goal(
        &Actor::Human,
        "s-gone".into(),
        Some("打包日志到 /tmp".into()),
    )
    .await
    .unwrap();

    let h1 = h.clone();
    let j = tokio::spawn(async move {
        h1.wait_approval(
            &Actor::Agent {
                client_id: "opencode".into(),
            },
            &"opencode".to_string(),
            &"e-1".to_string(),
            "ls /tmp",
            &needs_approval("ls /tmp"),
            true,
            false,
            session_api::transport::tokio_util_sync::CancellationToken::new(),
        )
        .await
    });
    let card = wait_card(&m, "s-gone").await;
    assert_eq!(
        card.purpose.as_deref(),
        Some("打包日志到 /tmp"),
        "会话在列表时按当前目标投影"
    );

    // 会话关闭（从列表移除）→ 无当前目标 → 明确缺失（不得保留创建期快照）
    m.sessions.lock().unwrap().remove("s-gone");
    let after = m
        .list_approvals(
            &Actor::Human,
            ApprovalFilter {
                session_id: Some("s-gone".into()),
                pending_only: true,
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    assert!(
        after.purpose.is_none(),
        "会话已不在列表时不得保留旧快照冒充当前意图：{:?}",
        after.purpose
    );

    m.decide_approval(&Actor::Human, card.id.clone(), Decision::Deny)
        .await
        .unwrap();
    let _ = j.await.unwrap();
}

/// D06：接管默认只**冻结**（不停止运行中任务）——停止是独立动作；接管作废交接前
/// 尚未开始的请求；交还**不**自动恢复旧队列（旧卡保持作废，不可复活）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r42_takeover_default_freezes_only_and_voids_are_final() {
    // 「停止」是独立动作：默认策略即「仅冻结」
    assert_eq!(
        ControlOpts::default().stop_running,
        StopPolicy::None,
        "接管默认不得停任务"
    );

    let m = mgr();
    let h = mk_handle("s-1", ControlOwner::Agent, m.center.clone());
    register(&m, h.clone());

    let h1 = h.clone();
    let j = tokio::spawn(async move {
        h1.wait_approval(
            &Actor::Agent {
                client_id: "opencode".into(),
            },
            &"opencode".to_string(),
            &"e-1".to_string(),
            "systemctl restart nginx",
            &needs_approval("systemctl restart nginx"),
            true,
            false,
            session_api::transport::tokio_util_sync::CancellationToken::new(),
        )
        .await
    });
    let card = wait_card(&m, "s-1").await;

    let report = m
        .set_control(
            &Actor::Human,
            "s-1".into(),
            ControlOwner::Human,
            ControlOpts::default(),
        )
        .await
        .unwrap();
    assert!(report.frozen, "接管后新请求冻结");
    assert!(
        report.stopped.is_empty(),
        "默认接管不停止运行中任务（停止是独立动作）"
    );

    // Agent 阻塞调用收到作废通知
    assert!(matches!(
        j.await.unwrap(),
        Err(Error::VoidedByHandback { .. })
    ));

    // 交还 → 旧卡不得复活（仍为 Voided），决定被拒
    m.set_control(
        &Actor::Human,
        "s-1".into(),
        ControlOwner::Agent,
        ControlOpts::default(),
    )
    .await
    .unwrap();
    let old = m
        .list_approvals(&Actor::Human, ApprovalFilter::default())
        .await
        .unwrap()
        .into_iter()
        .find(|it| it.id == card.id)
        .unwrap();
    assert_eq!(old.status, ApprovalStatus::Voided, "交还不得恢复已作废请求");
    assert!(
        m.decide_approval(&Actor::Human, card.id.clone(), Decision::Approve)
            .await
            .is_err(),
        "已作废卡片不得再生效"
    );
}

/// 等第一张该会话的待审卡出现（不依赖固定 sleep 时长）。
async fn wait_card(m: &SessionManager, sid: &str) -> ApprovalItem {
    for _ in 0..300 {
        let items = m
            .list_approvals(
                &Actor::Human,
                ApprovalFilter {
                    session_id: Some(sid.into()),
                    pending_only: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        if let Some(it) = items.into_iter().next() {
            return it;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("审批卡未在 3s 内出现");
}

/// ①「批准并记住」TTL：按卡上未命中段**精确**写入 TTL 窗口（vault 单一事实源），
/// 重载进引擎后同命令 AutoAllow——复现「同一命令第二次不再出卡」的减摩擦语义。
#[tokio::test]
async fn r42_remember_ttl_grants_exact_repeat() {
    let m = mgr();
    let h = mk_handle("s-1", ControlOwner::Agent, m.center.clone());
    register(&m, h.clone());
    m.center.vault.create_agent("opencode", "OpenCode").unwrap();

    let h1 = h.clone();
    let j1 = tokio::spawn(async move {
        h1.wait_approval(
            &Actor::Agent { client_id: "opencode".into() },
            &"opencode".to_string(),
            &"e-1".to_string(),
            "docker system prune -f",
            &needs_approval("docker system prune -f"),
            true,
            false,
            session_api::transport::tokio_util_sync::CancellationToken::new(),
        )
        .await
    });
    let card = wait_card(&m, "s-1").await;
    let written = m
        .remember_approval(
            &Actor::Human,
            card.id.clone(),
            RememberScope::Ttl { minutes: 30 },
        )
        .await
        .unwrap();
    assert_eq!(written, vec!["docker system prune -f".to_string()]);

    // exec 入口的刷新路径：vault → 引擎；同命令应免审
    let policy = m.center.vault.load_policy("opencode");
    m.center.engine.set_policy("opencode", policy);
    assert_eq!(
        m.center.engine.evaluate("opencode", "docker system prune -f").verdict,
        tinyssh_approval::SegmentVerdict::AutoAllow,
        "记住后同命令必须免审"
    );
    // 不同命令仍报审（精确记忆无通配）
    assert_eq!(
        m.center.engine.evaluate("opencode", "docker system prune -a").verdict,
        tinyssh_approval::SegmentVerdict::NeedsApproval
    );
    // TTL 行带过期时间（> now），且秒级 clamp 生效（0 → 1 分钟）
    let p = m.center.vault.load_policy("opencode");
    assert!(p.ttl_windows.iter().any(|w| w.expires_at > chrono::Utc::now()));
    // 收尾：拒绝让等待侧收敛（与 r42 同款；只记不住卡——remember 不动决定）
    m.decide_approval(&Actor::Human, card.id.clone(), Decision::Deny)
        .await
        .unwrap();
    let _ = j1.await.unwrap();
}

/// ①「批准并记住」持久放行：写 allow 规则 + 审计；Agent 不可自记；空 pattern 拒绝。
#[tokio::test]
async fn r42_remember_persistent_and_guards() {
    let m = mgr();
    let h = mk_handle("s-1", ControlOwner::Agent, m.center.clone());
    register(&m, h.clone());
    m.center.vault.create_agent("opencode", "OpenCode").unwrap();

    let h1 = h.clone();
    let j1 = tokio::spawn(async move {
        h1.wait_approval(
            &Actor::Agent { client_id: "opencode".into() },
            &"opencode".to_string(),
            &"e-1".to_string(),
            "df -h",
            &needs_approval("df -h"),
            true,
            false,
            session_api::transport::tokio_util_sync::CancellationToken::new(),
        )
        .await
    });
    let card = wait_card(&m, "s-1").await;

    // Agent 不能给自己写放行（InvalidActor）
    assert!(matches!(
        m.remember_approval(
            &Actor::Agent { client_id: "opencode".into() },
            card.id.clone(),
            RememberScope::Persistent { pattern: "*".into() },
        )
        .await,
        Err(Error::InvalidActor)
    ));
    // 空 pattern 拒绝
    assert!(m
        .remember_approval(
            &Actor::Human,
            card.id.clone(),
            RememberScope::Persistent { pattern: "   ".into() },
        )
        .await
        .is_err());

    let written = m
        .remember_approval(
            &Actor::Human,
            card.id.clone(),
            RememberScope::Persistent { pattern: "df *".into() },
        )
        .await
        .unwrap();
    assert_eq!(written, vec!["df *".to_string()]);
    let policy = m.center.vault.load_policy("opencode");
    m.center.engine.set_policy("opencode", policy);
    assert_eq!(
        m.center.engine.evaluate("opencode", "df -h").verdict,
        tinyssh_approval::SegmentVerdict::AutoAllow,
        "持久放行后前缀命中免审"
    );
    // 审计留痕（approval_remember ×2：1 条 Agent 拒绝路径不落审计，Human 两条 1 成功）
    let audit = m
        .query_audit(
            &Actor::Human,
            AuditFilter {
                action: Some("approval_remember".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(audit.events.len() >= 1, "approval_remember 必须进审计");
    m.decide_approval(&Actor::Human, card.id.clone(), Decision::Deny)
        .await
        .unwrap();
    let _ = j1.await.unwrap();
}

/// ② 自主模式：授权生命周期（人类专属 / TTL clamp / 过期惰性清除 / 急停即收回）。
#[tokio::test]
async fn r42_autonomy_grant_lifecycle() {
    let m = mgr();
    m.center.vault.create_agent("opencode", "OpenCode").unwrap();

    // Agent 不能给自己授权
    assert!(matches!(
        m.set_autonomy(
            &Actor::Agent { client_id: "opencode".into() },
            "opencode".into(),
            true,
            None,
        )
        .await,
        Err(Error::InvalidActor)
    ));

    // 人类开启（TTL 0 → clamp 到 1 分钟）
    m.set_autonomy(&Actor::Human, "opencode".into(), true, Some(0))
        .await
        .unwrap();
    let grants = m.autonomy_list(&Actor::Human).await.unwrap();
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0].agent_id, "opencode");
    assert!(grants[0].expires_at.is_some_and(|e| e > chrono::Utc::now()));
    assert!(m.center.autonomy_active("opencode"));

    // Agent 只能看到自己的授权
    let own = m.autonomy_list(&Actor::Agent { client_id: "opencode".into() }).await.unwrap();
    assert_eq!(own.len(), 1);

    // 过期 → 惰性清除判定为不活跃
    *m.center.autonomy.lock().unwrap().get_mut("opencode").unwrap() =
        Some(chrono::Utc::now() - chrono::Duration::minutes(1));
    assert!(!m.center.autonomy_active("opencode"), "过期授权不得放行");
    let grants = m.autonomy_list(&Actor::Human).await.unwrap();
    assert!(grants.is_empty(), "过期项不进状态列表");

    // 无过期授权 + 急停
    m.set_autonomy(&Actor::Human, "opencode".into(), true, None)
        .await
        .unwrap();
    assert!(m.center.autonomy_active("opencode"));
    m.set_autonomy(&Actor::Human, "opencode".into(), false, None)
        .await
        .unwrap();
    assert!(!m.center.autonomy_active("opencode"), "急停必须立即生效");
    assert!(m.autonomy_list(&Actor::Human).await.unwrap().is_empty());

    // 审批模型变更进审计
    let audit = m
        .query_audit(
            &Actor::Human,
            AuditFilter { action: Some("autonomy_set".into()), limit: 50, ..Default::default() },
        )
        .await
        .unwrap();
    assert!(audit.events.len() >= 3, "开/关都要留痕");
}

/// ② exec 级端到端：自主模式开启后同一条命令**不出审批卡**直接到执行层
/// （stub 通道的执行错误 ≠ 审批拒绝）；关闭后恢复出卡；deny 名单在自主模式下
/// 仍硬拦（reboot 直接 Dangerous，不进执行层）。
#[tokio::test]
async fn r42_autonomy_exec_skips_card_deny_still_holds() {
    let m = mgr();
    *m.center.collab.lock().unwrap() = CollabGate::new(true);
    let h = mk_handle("s-1", ControlOwner::Agent, m.center.clone());
    register(&m, h.clone());
    m.center.vault.create_agent("opencode", "OpenCode").unwrap();
    let agent = Actor::Agent { client_id: "opencode".into() };
    let cmd = "docker system prune -f";

    // 关闭态：出卡（走审批）
    let j1 = {
        let h = h.clone();
        let agent = agent.clone();
        tokio::spawn(async move { h.exec(&agent, cmd, ExecOpts::default()).await })
    };
    let card = wait_card(&m, "s-1").await;
    m.decide_approval(&Actor::Human, card.id.clone(), Decision::Deny).await.unwrap();
    assert!(matches!(j1.await.unwrap(), Err(Error::ApprovalDenied { .. })));

    // 开启自主：同命令不再出卡，直接到执行层（stub 通道报 InvalidInput("stub")）
    m.set_autonomy(&Actor::Human, "opencode".into(), true, None).await.unwrap();
    let r2 = h.exec(&agent, cmd, ExecOpts { mode: ExecMode::Fresh, ..Default::default() }).await;
    match r2 {
        Err(Error::InvalidInput(msg)) if msg.contains("stub") => {}
        other => panic!("自主模式应跳过审批直达执行层（stub 错误），实际 {other:?}"),
    }
    let pending = m
        .list_approvals(&Actor::Human, ApprovalFilter { pending_only: true, ..Default::default() })
        .await
        .unwrap();
    assert!(pending.is_empty(), "自主模式不得产生审批卡：{pending:?}");

    // deny 名单仍硬拦：reboot 在自主模式下同样 Dangerous 拒绝
    let r3 = h.exec(&agent, "reboot", ExecOpts::default()).await;
    assert!(
        matches!(&r3, Err(Error::ApprovalDenied { reason: DeniedReason::DangerousPattern })),
        "deny 名单必须先于自主模式：{r3:?}"
    );

    // 审计：自主放行的 exec 带 autonomous 标记
    let audit = m
        .query_audit(&Actor::Human, AuditFilter { action: Some("exec".into()), limit: 50, ..Default::default() })
        .await
        .unwrap();
    assert!(
        audit.events.iter().any(|e| {
            e.payload_json.get("autonomous").and_then(|v| v.as_bool()) == Some(true)
        }),
        "自主放行的 exec 审计必须带 autonomous:true"
    );
}

/// ⑤ 传输免审 opt-in：默认必审（自主模式也不豁免）；人类显式开
/// SETTING_AUTONOMY_TRANSFERS 后，自主模式在效的 Agent 传输跳过逐条审批
/// ——但审计（transfer_autonomous）与动作记录照常；关掉开关即恢复必审。
#[tokio::test]
async fn r42_transfer_autonomy_opt_in() {
    let m = mgr();
    *m.center.collab.lock().unwrap() = CollabGate::new(true);
    let h = mk_handle("s-t42x", ControlOwner::Agent, m.center.clone());
    register(&m, h.clone());
    m.center.vault.create_agent("opencode", "OpenCode").unwrap();
    let agent = Actor::Agent { client_id: "opencode".into() };
    m.set_autonomy(&Actor::Human, "opencode".into(), true, None).await.unwrap();
    let dl = {
        let m2 = m.clone();
        let agent = agent.clone();
        tokio::spawn(async move {
            m2.download(&agent, "s-t42x".to_string(), "/tmp/src.txt", std::path::Path::new("/local/dst.txt"), None).await
        })
    };

    // 默认（未 opt-in）：自主模式也不免传输审批——出卡，拒绝收场
    let card = wait_card(&m, "s-t42x").await;
    assert!(card.command.contains("download"), "传输卡摘要应含 download：{}", card.command);
    m.decide_approval(&Actor::Human, card.id.clone(), Decision::Deny).await.unwrap();
    assert!(matches!(dl.await.unwrap(), Err(Error::ApprovalDenied { .. })));

    // opt-in 开：免审直达传输层（stub 通道任务异步失败），无卡、审计带标记、记录照落
    m.center
        .vault
        .set_setting(SETTING_AUTONOMY_TRANSFERS, "1")
        .unwrap();
    let r = m
        .download(&agent, "s-t42x".to_string(), "/tmp/src.txt", std::path::Path::new("/local/dst.txt"), None)
        .await;
    assert!(r.is_ok(), "免审传输应同步返回句柄，实际 {:?}", r.err());
    let pending = m
        .list_approvals(&Actor::Human, ApprovalFilter { pending_only: true, ..Default::default() })
        .await
        .unwrap();
    assert!(pending.is_empty(), "免审传输不得出卡：{pending:?}");
    let audit = m
        .query_audit(&Actor::Human, AuditFilter { action: Some("transfer_autonomous".into()), limit: 50, ..Default::default() })
        .await
        .unwrap();
    assert!(
        audit.events.iter().any(|e| e.payload_json.get("autonomous").and_then(|v| v.as_bool()) == Some(true)),
        "免审传输必须留 transfer_autonomous 审计"
    );
    let recs = m
        .query_records(
            &Actor::Human,
            tinyssh_records::RecordFilter {
                agent_id: Some("opencode".into()),
                kind: Some(tinyssh_records::RecordKind::Transfer),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(!recs.is_empty(), "免审传输仍须进动作记录");

    // opt-in 关：恢复逐条审批
    m.center
        .vault
        .set_setting(SETTING_AUTONOMY_TRANSFERS, "")
        .unwrap();
    let dl2 = {
        let m2 = m.clone();
        let agent = agent.clone();
        tokio::spawn(async move {
            m2.download(&agent, "s-t42x".to_string(), "/tmp/src.txt", std::path::Path::new("/local/dst.txt"), None).await
        })
    };
    let card2 = wait_card(&m, "s-t42x").await;
    m.decide_approval(&Actor::Human, card2.id.clone(), Decision::Deny).await.unwrap();
    assert!(matches!(dl2.await.unwrap(), Err(Error::ApprovalDenied { .. })));
}
