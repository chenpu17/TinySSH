//! R41（§6.6/S09/D01-D02 活动记录、连接详情与凭据设置）：会话层契约。
//! 不建真 SSH：手装 SessionHandle + 配置型 Stub 通道（同 r40/r30 工艺）——验证
//! 连接详情是**连接当时**的身份快照（主机被编辑后不漂）、创建时刻是真实值、
//! 活动记录的当前/全局范围与人类/Agent 过滤、seq 游标翻页连续（不重不漏）、
//! 会话关闭后记录仍在、以及凭据删除的引用检查不破坏主机认证。

use super::*;
use session_api::transport::{ChannelHandle, FreshOutcome, TransportSignal};

struct R41Channel;
#[async_trait::async_trait]
impl ChannelHandle for R41Channel {
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
    let dir = std::env::temp_dir().join(format!("r41-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    SessionManager::open(&dir.join("t.db")).unwrap()
}

fn mk_handle(sid: &str, host: Host, center: Arc<ApprovalCenter>) -> Arc<SessionHandle> {
    let screen = term_core::Screen::new(term_core::ScreenConfig {
        cols: 80,
        rows: 24,
        scrollback: 100,
        lossless_cap: 1 << 20,
    });
    SessionHandle::new(
        sid.into(),
        host,
        "ssh".into(),
        Arc::new(R41Channel),
        screen,
        center,
        ControlOwner::Human,
    )
}

fn register(m: &SessionManager, h: Arc<SessionHandle>) {
    m.sessions.lock().unwrap().insert(h.id.clone(), h.clone());
}

/// 建一台真实入库的主机（走 vault，返回其 Host 快照）——详情要的地址/端口/用户/
/// 认证/指纹/编码都从这里来。
async fn seed_host(m: &SessionManager, name: &str, address: &str, charset: Charset) -> Host {
    let human = Actor::Human;
    let hid = m
        .upsert_host(
            &human,
            HostDraft {
                id: None,
                name: name.into(),
                address: address.into(),
                port: Some(2222),
                username: "root".into(),
                auth: AuthDraft::Password {
                    password: "pw".into(),
                },
                tags: vec![],
                charset,
                shell_integration: None,
                jump_host_id: None,
            },
        )
        .await
        .unwrap();
    m.list_hosts(&human)
        .await
        .unwrap()
        .into_iter()
        .find(|h| h.id == hid)
        .unwrap()
}

fn audit(m: &SessionManager, actor: &Actor, action: &str, sid: Option<&str>) {
    m.center
        .audit
        .append(actor, action, sid, None, serde_json::json!({}), None)
        .unwrap();
}

/// §6.1/§6.6：连接详情是**连接当时**的身份快照——主机此后被改名/改址都不漂。
#[tokio::test]
async fn r41_detail_is_connection_time_snapshot() {
    let m = mgr();
    let human = Actor::Human;
    let host = seed_host(&m, "生产机", "10.0.0.5", Charset::Gbk).await;
    register(&m, mk_handle("s-1", host.clone(), m.center.clone()));

    let d = m.session_detail(&human, "s-1".into()).await.unwrap();
    assert_eq!(d.address, "10.0.0.5");
    assert_eq!(d.port, 2222);
    assert_eq!(d.username, "root");
    assert_eq!(d.charset, Charset::Gbk);
    assert_eq!(d.auth_type, AuthType::Password);
    assert_eq!(d.host_name, "生产机");
    assert_eq!(d.kind, "ssh");
    assert_eq!(d.control_owner, ControlOwner::Human);

    // 主机被改名 + 改址 + 换编码（活动会话不受影响，见 §6.1）
    m.upsert_host(
        &human,
        HostDraft {
            id: Some(host.id.clone()),
            name: "生产机-改名".into(),
            address: "10.0.0.9".into(),
            port: Some(2223),
            username: "ops".into(),
            auth: AuthDraft::None,
            tags: vec![],
            charset: Charset::Utf8,
            shell_integration: None,
            jump_host_id: None,
        },
    )
    .await
    .unwrap();

    let d2 = m.session_detail(&human, "s-1".into()).await.unwrap();
    assert_eq!(
        d2.address, "10.0.0.5",
        "详情必须显示连接时的地址，不是现在的配置"
    );
    assert_eq!(d2.port, 2222);
    assert_eq!(d2.username, "root");
    assert_eq!(d2.charset, Charset::Gbk);
    assert_eq!(d2.host_name, "生产机", "连接时的主机信息要保留");
}

/// §6.6「创建时间」：必须是真实创建时刻（旧实现填的是查询时刻，每次轮询都变）。
#[tokio::test]
async fn r41_detail_created_at_is_real_and_stable() {
    let m = mgr();
    let human = Actor::Human;
    let before = chrono::Utc::now();
    let host = seed_host(&m, "h", "10.0.0.5", Charset::Utf8).await;
    register(&m, mk_handle("s-1", host, m.center.clone()));

    let d1 = m.session_detail(&human, "s-1".into()).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    let d2 = m.session_detail(&human, "s-1".into()).await.unwrap();
    assert_eq!(d1.created_at, d2.created_at, "创建时刻不随查询变化");
    assert!(d1.created_at >= before, "创建时刻不早于建会话");
    assert!(d1.created_at <= chrono::Utc::now());
    // list_sessions 与详情同源（旧实现两处各自 now()，同一会话会给出两个时间）
    let list = m.list_sessions(&human).await.unwrap();
    assert_eq!(list[0].created_at, d1.created_at);
}

/// §6.6：未注册会话 → SessionNotFound（与其它会话入口一致）。
#[tokio::test]
async fn r41_detail_unknown_session() {
    let m = mgr();
    let human = Actor::Human;
    assert!(matches!(
        m.session_detail(&human, "nope".into()).await,
        Err(Error::SessionNotFound)
    ));
}

/// §6.6「默认当前会话，可切全部；可筛人类/Agent 与事件类型」。
#[tokio::test]
async fn r41_audit_scope_and_actor_kind_filter() {
    let m = mgr();
    let human = Actor::Human;
    let agent = Actor::Agent {
        client_id: "mcp-1".into(),
    };
    audit(&m, &human, "exec", Some("s-1"));
    audit(&m, &agent, "exec", Some("s-1"));
    audit(&m, &human, "forward_start", Some("s-2"));

    let q = |f: AuditFilter| async { m.query_audit(&human, f).await.unwrap() };

    // 当前会话（sid 过滤）
    let p = q(AuditFilter {
        session_id: Some("s-1".into()),
        limit: 50,
        ..Default::default()
    })
    .await;
    assert_eq!(p.total, 2);
    // 全局 = 超集，记录不因切范围丢失
    let all = q(AuditFilter {
        limit: 50,
        ..Default::default()
    })
    .await;
    assert_eq!(all.total, 3);
    // 人类 / Agent 两类过滤
    let h = q(AuditFilter {
        actor_kind: Some("human".into()),
        limit: 50,
        ..Default::default()
    })
    .await;
    assert_eq!(h.total, 2);
    assert!(h.events.iter().all(|e| e.actor_kind == "human"));
    let a = q(AuditFilter {
        actor_kind: Some("agent".into()),
        limit: 50,
        ..Default::default()
    })
    .await;
    assert_eq!(a.total, 1);
    assert_eq!(a.events[0].agent_id.as_deref(), Some("mcp-1"));
    // 范围 + 人类 + 事件类型三者叠加
    let combo = q(AuditFilter {
        session_id: Some("s-1".into()),
        actor_kind: Some("human".into()),
        action: Some("exec".into()),
        limit: 50,
        ..Default::default()
    })
    .await;
    assert_eq!(combo.total, 1);
    // 未知 actor_kind 如实返回空，不静默降级为「不过滤」
    let bogus = q(AuditFilter {
        actor_kind: Some("robot".into()),
        limit: 50,
        ..Default::default()
    })
    .await;
    assert_eq!(bogus.total, 0);
}

/// §6.6「记录连续」：按 seq 游标翻页不重不漏（offset 会在新事件入链后错位）。
#[tokio::test]
async fn r41_audit_seq_cursor_paging_is_continuous() {
    let m = mgr();
    let human = Actor::Human;
    for i in 0..10 {
        audit(
            &m,
            &human,
            if i % 2 == 0 { "exec" } else { "send_keys" },
            Some("s-1"),
        );
    }
    let mut seen: Vec<i64> = Vec::new();
    let mut cursor: Option<i64> = None;
    loop {
        let page = m
            .query_audit(
                &human,
                AuditFilter {
                    session_id: Some("s-1".into()),
                    before_seq: cursor,
                    limit: 4,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(page.total, 10, "total 是过滤后的总数，不随页变化");
        if page.events.is_empty() {
            break;
        }
        // 页内严格递减
        for w in page.events.windows(2) {
            assert!(
                w[0].seq > w[1].seq,
                "页内 seq 必须严格递减：{:?}",
                page.events.iter().map(|e| e.seq).collect::<Vec<_>>()
            );
        }
        cursor = Some(page.events.last().unwrap().seq);
        seen.extend(page.events.iter().map(|e| e.seq));
    }
    assert_eq!(seen.len(), 10, "翻页取回全部记录，不重不漏：{seen:?}");
    let uniq: std::collections::HashSet<i64> = seen.iter().copied().collect();
    assert_eq!(uniq.len(), 10, "无重复：{seen:?}");
    // 全局同样连续（换范围不丢记录）
    let all = m
        .query_audit(
            &human,
            AuditFilter {
                limit: 50,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(all.total, 10);
}

/// §6.6/§5「保留主机/会话身份」：会话关闭后其记录仍在（记录连续），不随会话一起消失。
#[tokio::test]
async fn r41_records_survive_session_close() {
    let m = mgr();
    let human = Actor::Human;
    let host = seed_host(&m, "h", "10.0.0.5", Charset::Utf8).await;
    register(&m, mk_handle("s-1", host, m.center.clone()));
    audit(&m, &human, "exec", Some("s-1"));

    m.close_session(&human, "s-1".into()).await.unwrap();
    assert!(matches!(
        m.session_detail(&human, "s-1".into()).await,
        Err(Error::SessionNotFound)
    ));

    let page = m
        .query_audit(
            &human,
            AuditFilter {
                session_id: Some("s-1".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        page.total >= 2,
        "exec + session_closed 都应留痕：{}",
        page.total
    );
    assert!(page
        .events
        .iter()
        .all(|e| e.session_id.as_deref() == Some("s-1")));
}

/// §238/§267/DF8.4：凭据删除前检查引用——被主机引用即拒绝并列出主机名，认证不被破坏。
#[tokio::test]
async fn r41_identity_delete_checks_host_refs() {
    let m = mgr();
    let human = Actor::Human;
    let id = m
        .create_identity(
            &human,
            session_api::IdentityReq::Generate {
                label: "k1".into(),
                kind: session_api::KeyKind::Ed25519,
            },
        )
        .await
        .unwrap();
    let hid = m
        .upsert_host(
            &human,
            HostDraft {
                id: None,
                name: "引用者".into(),
                address: "10.0.0.5".into(),
                port: Some(22),
                username: "root".into(),
                auth: AuthDraft::Key {
                    identity_id: id.id.clone(),
                },
                tags: vec![],
                charset: Charset::Utf8,
                shell_integration: None,
                jump_host_id: None,
            },
        )
        .await
        .unwrap();

    let e = m.delete_identity(&human, id.id.clone()).await.unwrap_err();
    match e {
        Error::IdentityInUse { host_names } => assert_eq!(host_names, vec!["引用者".to_string()]),
        other => panic!("被引用应回 IdentityInUse：{other:?}"),
    }
    // 拒绝后凭据与主机绑定都还在（不半删）
    assert!(m
        .list_identities(&human)
        .await
        .unwrap()
        .iter()
        .any(|x| x.id == id.id));
    let host = m
        .list_hosts(&human)
        .await
        .unwrap()
        .into_iter()
        .find(|h| h.id == hid)
        .unwrap();
    assert_eq!(host.identity_id.as_deref(), Some(id.id.as_str()));

    // 解除引用后即可删除
    m.delete_host(&human, hid).await.unwrap();
    m.delete_identity(&human, id.id.clone()).await.unwrap();
    assert!(!m
        .list_identities(&human)
        .await
        .unwrap()
        .iter()
        .any(|x| x.id == id.id));
}
