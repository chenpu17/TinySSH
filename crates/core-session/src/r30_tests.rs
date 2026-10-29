//! R30（C4 路径、条目元数据与会话隔离）：sftp_resolve_path / sftp_stat 会话层契约。
//! 不建真 SSH：手装 SessionHandle + 配置型 Stub 通道（同 c10/r26 工艺）——
//! 验证 Human 浏览口径（Agent 拒绝）、通道转发与错误透传（不存在/权限可区别）。

use super::*;
use session_api::transport::{ChannelHandle, FreshOutcome, TransportSignal};

/// 配置型 stub：resolve 恒返回初始目录；stat 按路径分流（/gone=不存在、
/// /priv=权限不足、其余=悬空符号链接形状）。
struct R30Channel;
#[async_trait::async_trait]
impl ChannelHandle for R30Channel {
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
        match path {
            "/gone" => Err(Error::SftpPathNotFound { path: path.into() }),
            "/priv" => Err(Error::SftpPermissionDenied { path: path.into() }),
            _other => Ok(EntryStat {
                canonical: None, // 悬空链接：canonical 不可得（§352 不猜路径）
                kind: Some(EntryKind::Symlink),
                is_dir: false,
                size: None,
                mtime: None,
                symlink_target: Some("/target".into()),
            }),
        }
    }
}

fn mgr() -> Arc<SessionManager> {
    // 主密钥走 env（同 c10：规避钥匙串 ACL 弹窗阻塞测试进程）
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = std::env::temp_dir().join(format!("r30-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    SessionManager::open(&dir.join("t.db")).unwrap()
}

fn mk_handle(center: Arc<ApprovalCenter>) -> Arc<SessionHandle> {
    let host = Host {
        id: "local".into(),
        name: "r30".into(),
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
        "s-r30".into(),
        host,
        "local".into(),
        Arc::new(R30Channel),
        screen,
        center,
        ControlOwner::Agent,
    )
}

fn register(m: &SessionManager, h: Arc<SessionHandle>) {
    m.sessions.lock().unwrap().insert(h.id.clone(), h.clone());
}

/// C4：resolve 仍为 Human 浏览口径（Agent 拒绝）；stat 自 R34 起放行 Agent
///（DF6.2 MCP collision=fail 预检结构化冲突需目标 stat；只读+审计留痕）。
#[tokio::test]
async fn r30_sftp_entrypoints_human_only() {
    let m = mgr();
    register(&m, mk_handle(m.center.clone()));
    let agent = Actor::Agent {
        client_id: "mcp-1".into(),
    };
    let e1 = m
        .sftp_resolve_path(&agent, "s-r30".into(), None)
        .await
        .unwrap_err();
    assert!(
        matches!(e1, Error::InvalidInput(ref s) if s.contains("仅人类浏览入口")),
        "{e1:?}"
    );
    // Agent stat 走通道（R30 桩有 stat 实现——返回条目形状而非门禁错误）
    let st = m
        .sftp_stat(&agent, "s-r30".into(), "/x".into())
        .await
        .unwrap();
    assert_eq!(st.symlink_target.as_deref(), Some("/target"));
}

/// C4：Human 走通道——resolve(None) 转发、stat 透传可区别错误与悬空链接形状。
#[tokio::test]
async fn r30_human_forwarding_and_errors() {
    let m = mgr();
    register(&m, mk_handle(m.center.clone()));
    let human = Actor::Human;
    let r = m
        .sftp_resolve_path(&human, "s-r30".into(), None)
        .await
        .unwrap();
    assert_eq!(r.canonical, "/home/u");
    // 不存在/权限 → 专用变体（前端按 kind 呈现，不猜路径）
    let nf = m
        .sftp_stat(&human, "s-r30".into(), "/gone".into())
        .await
        .unwrap_err();
    assert!(
        matches!(nf, Error::SftpPathNotFound { ref path } if path == "/gone"),
        "{nf:?}"
    );
    let pd = m
        .sftp_stat(&human, "s-r30".into(), "/priv".into())
        .await
        .unwrap_err();
    assert!(
        matches!(pd, Error::SftpPermissionDenied { ref path } if path == "/priv"),
        "{pd:?}"
    );
    // 悬空链接：canonical=None + kind=Symlink + size/mtime 未知（None，不伪造零值）
    let st = m
        .sftp_stat(&human, "s-r30".into(), "/dangling".into())
        .await
        .unwrap();
    assert_eq!(st.canonical, None);
    assert_eq!(st.kind, Some(EntryKind::Symlink));
    assert_eq!((st.size, st.mtime), (None, None));
    assert_eq!(st.symlink_target.as_deref(), Some("/target"));
}

/// C4：未注册会话 → SessionNotFound（两入口一致）。
#[tokio::test]
async fn r30_session_not_found() {
    let m = mgr();
    let human = Actor::Human;
    assert!(matches!(
        m.sftp_resolve_path(&human, "nope".into(), None).await,
        Err(Error::SessionNotFound)
    ));
    assert!(matches!(
        m.sftp_stat(&human, "nope".into(), "/x".into()).await,
        Err(Error::SessionNotFound)
    ));
}
