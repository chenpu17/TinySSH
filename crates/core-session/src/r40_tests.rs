//! R40（§6.6/D01/D02 端口转发表单、列表与生命周期）：会话层契约。
//! 不建真 SSH：手装 SessionHandle + 配置型 Stub 通道（同 r30 工艺）——验证
//! 人类直建/停转发的注册表口径、非回环监听放行、字段可定位错误（ForwardListenFailed）
//! 透传、停止失败可重试、关闭会话影响计数、接管期 Agent 拒绝。

use super::*;
use session_api::transport::{ChannelHandle, FreshOutcome, TransportSignal};
use session_api::{ForwardId, ForwardInfo, ForwardSpec};
use std::sync::Mutex as StdMutex;

/// 转发注册表 stub：记录 spec、按冲突端口集合注入 ForwardListenFailed{field:"listen"}，
/// 其余走真实核心同口径（端口/地址/目标校验）。state 恒 "Listening"（无真实监听）。
struct R40Channel {
    fwds: StdMutex<Vec<ForwardInfo>>,
    /// 预置「占用」端口——命中即回字段可定位的监听失败（模拟端口冲突）
    conflict_ports: Vec<u16>,
}
impl R40Channel {
    fn new(conflict_ports: Vec<u16>) -> Self {
        Self {
            fwds: StdMutex::new(vec![]),
            conflict_ports,
        }
    }
}
#[async_trait::async_trait]
impl ChannelHandle for R40Channel {
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
    async fn start_forward(&self, spec: ForwardSpec) -> Result<ForwardId> {
        // 真实核心同口径的字段可定位校验（transport-ssh start_forward 的镜像）
        let (laddr, lport, target) = match &spec {
            ForwardSpec::Local {
                listen_addr,
                listen_port,
                target_host,
                target_port,
            } => (
                listen_addr.clone(),
                *listen_port,
                Some((target_host.clone(), *target_port)),
            ),
            ForwardSpec::Remote {
                listen_addr,
                listen_port,
                target_host,
                target_port,
            } => (
                listen_addr.clone(),
                *listen_port,
                Some((target_host.clone(), *target_port)),
            ),
            ForwardSpec::Dynamic {
                listen_addr,
                listen_port,
            } => (listen_addr.clone(), *listen_port, None),
        };
        if lport == 0 {
            return Err(Error::ForwardListenFailed {
                field: "listen".into(),
                reason: "监听端口须为 1–65535".into(),
            });
        }
        if laddr.trim().is_empty() {
            return Err(Error::ForwardListenFailed {
                field: "listen".into(),
                reason: "监听地址不能为空（默认 127.0.0.1）".into(),
            });
        }
        if let Some((th, tp)) = &target {
            if th.trim().is_empty() || *tp == 0 {
                return Err(Error::ForwardListenFailed {
                    field: "target".into(),
                    reason: "目标主机与端口（1–65535）不能为空".into(),
                });
            }
        }
        if self.conflict_ports.contains(&lport) {
            return Err(Error::ForwardListenFailed {
                field: "listen".into(),
                reason: format!("本地监听 {laddr}:{lport} 失败：Address already in use"),
            });
        }
        let id = format!("f-{}", self.fwds.lock().unwrap().len() + 1);
        self.fwds.lock().unwrap().push(ForwardInfo {
            id: id.clone(),
            spec,
            state: "Listening".into(),
            error: None,
        });
        Ok(id)
    }
    async fn stop_forward(&self, id: &ForwardId) -> Result<()> {
        let mut m = self.fwds.lock().unwrap();
        let before = m.len();
        m.retain(|f| &f.id != id);
        if m.len() == before {
            return Err(Error::InvalidInput("转发不存在或已停止".into()));
        }
        Ok(())
    }
    async fn list_forwards(&self) -> Result<Vec<ForwardInfo>> {
        Ok(self.fwds.lock().unwrap().clone())
    }
    fn set_forward_event_cb(&self, _cb: session_api::ForwardStateCb) {}
}

fn mgr() -> Arc<SessionManager> {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = std::env::temp_dir().join(format!("r40-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let m = SessionManager::open(&dir.join("t.db")).unwrap();
    // C9（R43）：新装默认关闭协作；本组用例模拟「已启用协作的既有安装」，显式开 admission 门。
    *m.center.collab.lock().unwrap() = CollabGate::new(true);
    m
}

fn mk_handle(
    center: Arc<ApprovalCenter>,
    owner: ControlOwner,
    ch: Arc<R40Channel>,
) -> Arc<SessionHandle> {
    let host = Host {
        id: "local".into(),
        name: "r40".into(),
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
    SessionHandle::new(
        "s-r40".into(),
        host,
        "local".into(),
        ch,
        screen,
        center,
        owner,
    )
}

fn register(m: &SessionManager, h: Arc<SessionHandle>) {
    m.sessions.lock().unwrap().insert(h.id.clone(), h.clone());
}

fn local(laddr: &str, lport: u16, thost: &str, tport: u16) -> ForwardSpec {
    ForwardSpec::Local {
        listen_addr: laddr.into(),
        listen_port: lport,
        target_host: thost.into(),
        target_port: tport,
    }
}

/// §6.6/D01：人类直建（无审批）→ 列表可见 → 停止移除；审计留痕。
#[tokio::test]
async fn r40_human_start_list_stop() {
    let m = mgr();
    let ch = Arc::new(R40Channel::new(vec![]));
    register(
        &m,
        mk_handle(m.center.clone(), ControlOwner::Human, ch.clone()),
    );
    let human = Actor::Human;
    let fid = m
        .start_forward(
            &human,
            "s-r40".into(),
            local("127.0.0.1", 8080, "10.0.0.5", 80),
        )
        .await
        .unwrap();
    let list = m.list_forwards(&human, "s-r40".into()).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, fid);
    assert_eq!(list[0].state, "Listening");
    assert!(matches!(
        &list[0].spec,
        ForwardSpec::Local {
            listen_port: 8080,
            ..
        }
    ));
    // 停止（等待核心结果：调用返回即已移除）
    m.stop_forward(&human, "s-r40".into(), fid.clone())
        .await
        .unwrap();
    assert!(m
        .list_forwards(&human, "s-r40".into())
        .await
        .unwrap()
        .is_empty());
    // 审计：forward_start/forward_stop 各一
    let evs = m
        .center
        .audit
        .query(&AuditFilter {
            limit: 50,
            ..Default::default()
        })
        .map(|p| p.events)
        .unwrap_or_default();
    let acts: Vec<String> = evs.into_iter().map(|e| e.action).collect();
    assert!(acts.iter().any(|a| a == "forward_start"), "{acts:?}");
    assert!(acts.iter().any(|a| a == "forward_stop"), "{acts:?}");
}

/// §6.6：非回环监听**放行**（地址是显式字段；「主动选择」由 FE 把关）——核心不再拒。
#[tokio::test]
async fn r40_non_loopback_allowed() {
    let m = mgr();
    let ch = Arc::new(R40Channel::new(vec![]));
    register(
        &m,
        mk_handle(m.center.clone(), ControlOwner::Human, ch.clone()),
    );
    let human = Actor::Human;
    let fid = m
        .start_forward(
            &human,
            "s-r40".into(),
            local("0.0.0.0", 9000, "10.0.0.5", 80),
        )
        .await
        .unwrap();
    let list = m.list_forwards(&human, "s-r40".into()).await.unwrap();
    let e = list.iter().find(|f| f.id == fid).unwrap();
    assert!(matches!(&e.spec, ForwardSpec::Local { listen_addr, .. } if listen_addr == "0.0.0.0"));
}

/// §6.6/D02：端口冲突 → 字段可定位错误（wire kind=forward_listen_failed，field=listen）。
#[tokio::test]
async fn r40_port_conflict_field_error() {
    let m = mgr();
    let ch = Arc::new(R40Channel::new(vec![8080]));
    register(
        &m,
        mk_handle(m.center.clone(), ControlOwner::Human, ch.clone()),
    );
    let human = Actor::Human;
    let err = m
        .start_forward(
            &human,
            "s-r40".into(),
            local("127.0.0.1", 8080, "10.0.0.5", 80),
        )
        .await
        .unwrap_err();
    let (kind, detail) = err.wire_parts();
    assert_eq!(kind, "forward_listen_failed");
    assert_eq!(detail.unwrap()["field"], "listen");
    // 换端口即成功（错误不污染注册表）
    m.start_forward(
        &human,
        "s-r40".into(),
        local("127.0.0.1", 8081, "10.0.0.5", 80),
    )
    .await
    .unwrap();
}

/// §6.6/D02：目标字段错误也定位到对应字段（field=target）。
#[tokio::test]
async fn r40_target_field_error() {
    let m = mgr();
    let ch = Arc::new(R40Channel::new(vec![]));
    register(
        &m,
        mk_handle(m.center.clone(), ControlOwner::Human, ch.clone()),
    );
    let human = Actor::Human;
    let err = m
        .start_forward(&human, "s-r40".into(), local("127.0.0.1", 8080, "  ", 80))
        .await
        .unwrap_err();
    let (kind, detail) = err.wire_parts();
    assert_eq!(kind, "forward_listen_failed");
    assert_eq!(detail.unwrap()["field"], "target");
}

/// §6.6「停止等待核心结果；失败可重试」：未知 id 报错，重试合法 id 成功。
#[tokio::test]
async fn r40_stop_unknown_then_retry() {
    let m = mgr();
    let ch = Arc::new(R40Channel::new(vec![]));
    register(
        &m,
        mk_handle(m.center.clone(), ControlOwner::Human, ch.clone()),
    );
    let human = Actor::Human;
    let e = m
        .stop_forward(&human, "s-r40".into(), "f-nope".into())
        .await
        .unwrap_err();
    assert!(
        matches!(e, Error::InvalidInput(ref s) if s.contains("不存在")),
        "{e:?}"
    );
    let fid = m
        .start_forward(
            &human,
            "s-r40".into(),
            local("127.0.0.1", 8082, "10.0.0.5", 80),
        )
        .await
        .unwrap();
    m.stop_forward(&human, "s-r40".into(), fid).await.unwrap();
    assert!(m
        .list_forwards(&human, "s-r40".into())
        .await
        .unwrap()
        .is_empty());
}

/// §6.6「关闭会话前展示将受影响的转发数量」：list_forwards 计数即影响面。
#[tokio::test]
async fn r40_close_impact_count() {
    let m = mgr();
    let ch = Arc::new(R40Channel::new(vec![]));
    register(
        &m,
        mk_handle(m.center.clone(), ControlOwner::Human, ch.clone()),
    );
    let human = Actor::Human;
    for (i, p) in [7001u16, 7002, 7003].iter().enumerate() {
        let _ = i;
        m.start_forward(
            &human,
            "s-r40".into(),
            local("127.0.0.1", *p, "10.0.0.5", 80),
        )
        .await
        .unwrap();
    }
    assert_eq!(
        m.list_forwards(&human, "s-r40".into()).await.unwrap().len(),
        3
    );
}

/// §6.6/接管主权：Agent 在人类接管期不得新开隧道（与 exec 同语义）。
#[tokio::test]
async fn r40_agent_takeover_rejected() {
    let m = mgr();
    let ch = Arc::new(R40Channel::new(vec![]));
    register(
        &m,
        mk_handle(m.center.clone(), ControlOwner::Human, ch.clone()),
    );
    let agent = Actor::Agent {
        client_id: "mcp-1".into(),
    };
    let e = m
        .start_forward(
            &agent,
            "s-r40".into(),
            local("127.0.0.1", 8080, "10.0.0.5", 80),
        )
        .await
        .unwrap_err();
    assert!(matches!(e, Error::ControlTakenByHuman), "{e:?}");
}

/// §6.6：未注册会话 → SessionNotFound（两入口一致）。
#[tokio::test]
async fn r40_session_not_found() {
    let m = mgr();
    let human = Actor::Human;
    assert!(matches!(
        m.list_forwards(&human, "nope".into()).await,
        Err(Error::SessionNotFound)
    ));
    assert!(matches!(
        m.start_forward(&human, "nope".into(), local("127.0.0.1", 1, "h", 1))
            .await,
        Err(Error::SessionNotFound)
    ));
}
