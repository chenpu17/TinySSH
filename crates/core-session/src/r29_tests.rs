//! R29 / #29 文件管理：sftp_mkdir 会话层契约。不建真 SSH：手装 SessionHandle + 记账型
//! Stub 通道（同 r30 工艺）——验证人类专属、基名校验与路径拼接（核心绝不替 Agent 建目录、
//! 绝不把带分隔符的名称拼进路径）、绝对目录判定认 POSIX 与 Windows 两种形态、分隔符向
//! 通道要（远端恒 `/`，本机随平台）、通道收到的恒是拼好的全路径、可区别错误原样透传、
//! 成败都入审计。

use super::*;
use session_api::transport::{ChannelHandle, FreshOutcome, TransportSignal};

/// 记账型 stub：make_dir 记下收到的路径，再按路径分流——/taken 下=目标已存在、
/// /priv 下=权限不足、/gone 下=父目录不存在，其余成功（与 SSH 实现的失败面同形）。
/// `sep` 是通路报的路径分隔符（`/`=SFTP 远端，`\`=模拟 Windows 本机通路）。
struct R29Channel {
    mkdirs: std::sync::Mutex<Vec<String>>,
    sep: char,
}
#[async_trait::async_trait]
impl ChannelHandle for R29Channel {
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
    async fn make_dir(&self, path: &str) -> Result<()> {
        self.mkdirs.lock().unwrap().push(path.to_string());
        if path.starts_with("/taken/") {
            Err(Error::InvalidInput(format!("目标已存在，未创建：{path}")))
        } else if path.starts_with("/priv/") {
            Err(Error::SftpPermissionDenied { path: path.into() })
        } else if path.starts_with("/gone/") {
            Err(Error::SftpPathNotFound { path: path.into() })
        } else {
            Ok(())
        }
    }
    fn path_separator(&self) -> char {
        self.sep
    }
}

/// 独立管理器 + 一个挂了 R29Channel（分隔符 `/`，同 SFTP 远端）的已注册会话。
fn setup() -> (Arc<SessionManager>, Arc<R29Channel>) {
    setup_sep('/')
}

/// 同上，通道报的分隔符由用例指定。
fn setup_sep(sep: char) -> (Arc<SessionManager>, Arc<R29Channel>) {
    // 主密钥走 env（同 c10：规避钥匙串 ACL 弹窗阻塞测试进程）
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = std::env::temp_dir().join(format!("r29-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let m = SessionManager::open(&dir.join("t.db")).unwrap();
    let host = Host {
        id: "local".into(),
        name: "r29".into(),
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
    let ch = Arc::new(R29Channel {
        mkdirs: std::sync::Mutex::new(Vec::new()),
        sep,
    });
    let h = SessionHandle::new(
        "s-r29".into(),
        host,
        "local".into(),
        ch.clone(),
        screen,
        m.center.clone(),
        ControlOwner::Agent,
    );
    m.sessions.lock().unwrap().insert(h.id.clone(), h);
    (m, ch)
}

fn mkdirs_of(ch: &R29Channel) -> Vec<String> {
    ch.mkdirs.lock().unwrap().clone()
}

fn mkdir_audit(m: &SessionManager) -> Vec<session_api::AuditEvent> {
    m.center
        .audit
        .query(&AuditFilter {
            limit: 200,
            ..Default::default()
        })
        .unwrap()
        .events
        .into_iter()
        .filter(|e| e.action == "sftp_mkdir")
        .collect()
}

/// #29：建目录是人类专属入口——Agent 连通道都到不了（无记账、无审计）。
#[tokio::test]
async fn r29_mkdir_is_human_only() {
    let (m, ch) = setup();
    let agent = Actor::Agent {
        client_id: "mcp-1".into(),
    };
    let e = m
        .sftp_mkdir(&agent, "s-r29".into(), "/var/log".into(), "new".into())
        .await
        .unwrap_err();
    assert!(
        matches!(&e, Error::InvalidInput(ref s) if s.contains("仅人类文件管理入口")),
        "{e:?}"
    );
    assert!(mkdirs_of(&ch).is_empty(), "Agent 请求不得到达通道");
    assert!(mkdir_audit(&m).is_empty(), "入口处拒绝的调用不入审计");
}

/// #29：name 是基名——空名/./../路径分隔符一律拒绝（不借建目录做路径穿越）；dir 须为
/// 绝对路径。二者被拒时通道零到达。合法调用由核心拼成全路径——根目录、多级、尾斜杠
/// 都拼对，通道收到的恒是全路径、审计 command 同值。
#[tokio::test]
async fn r29_mkdir_validates_name_and_joins_full_path() {
    let (m, ch) = setup();
    let human = Actor::Human;
    for bad in ["", "   ", ".", "..", " .. ", "a/b", "a\\b"] {
        let e = m
            .sftp_mkdir(&human, "s-r29".into(), "/var/log".into(), bad.into())
            .await
            .unwrap_err();
        assert!(
            matches!(&e, Error::InvalidInput(ref s) if s.contains("文件夹名称无效")),
            "{bad:?} → {e:?}"
        );
    }
    // 相对目录会落到进程/SFTP 初始目录，不是用户看到的那一层：空串、裸相对路径、
    // `.`/`..`，以及 Windows 上「有根但不带盘符」的 `\rel` 与「只带盘符」的 `C:`/`C:rel`
    //（= 该盘当前目录下的相对路径）都不收
    for bad_dir in ["relative", "", ".", "..", "  ", r"\rel", "C:", "c:rel"] {
        let e = m
            .sftp_mkdir(&human, "s-r29".into(), bad_dir.into(), "new".into())
            .await
            .unwrap_err();
        assert!(
            matches!(&e, Error::InvalidInput(ref s) if s.contains("路径无效")),
            "{bad_dir:?} → {e:?}"
        );
    }
    assert!(
        mkdirs_of(&ch).is_empty(),
        "被入口校验拒绝的调用不得到达通道"
    );

    let calls = [
        ("/var/log", "new"),
        ("/var/log/", "  spaced  "),
        ("/", "at-root"),
        ("//", "at-root-2"),
        ("/a/b/c", "deep"),
    ];
    for (dir, name) in calls {
        m.sftp_mkdir(&human, "s-r29".into(), dir.into(), name.into())
            .await
            .unwrap();
    }
    let full = [
        "/var/log/new",
        "/var/log/spaced",
        "/at-root",
        "/at-root-2",
        "/a/b/c/deep",
    ];
    assert_eq!(mkdirs_of(&ch), full.to_vec(), "通道收到恒为拼好的全路径");

    let ev = mkdir_audit(&m);
    // 审计页最新在前：与调用顺序相反
    let commands: Vec<&str> = ev.iter().map(|e| e.command.as_deref().unwrap()).collect();
    let newest_first: Vec<&str> = full.iter().rev().copied().collect();
    assert_eq!(commands, newest_first);
    for e in &ev {
        assert_eq!(e.actor_kind, "human");
        assert_eq!(e.session_id.as_deref(), Some("s-r29"));
        assert_eq!(
            e.payload_json.get("path"),
            Some(&serde_json::json!(e.command))
        );
        assert_eq!(
            e.payload_json.get("ok"),
            Some(&serde_json::json!(true)),
            "{}",
            e.payload_json
        );
    }
}

/// #29：绝对目录判定不只认 POSIX——本机 Windows 会话的目录是 canonicalize 给出的
/// `\\?\C:\…` 形态（盘符、UNC 同理），面板一打开就停在这一层，拒了它等于 Windows
/// 本机会话建不了目录。分隔符向通道要：远端恒 `/`；本机通路随平台，Windows 上是
/// `\`（那种路径不认 `/`）。通道收到与审计记下的都是拼好的全路径。
#[tokio::test]
async fn r29_mkdir_accepts_windows_dirs_and_uses_channel_separator() {
    let human = Actor::Human;
    let dirs = [
        r"\\?\C:\Users\u",
        r"\\?\C:\",
        r"C:\Users\u",
        "C:/Users/u/",
        r"\\server\share\dir",
    ];
    // SFTP 远端（`/`）：校验放行，拼接照 POSIX
    let (_m, ch) = setup();
    for dir in dirs {
        _m.sftp_mkdir(&human, "s-r29".into(), dir.into(), "new".into())
            .await
            .unwrap_or_else(|e| panic!("{dir:?} 应被判为绝对目录：{e:?}"));
    }
    let posix = [
        r"\\?\C:\Users\u/new",
        r"\\?\C:\/new",
        r"C:\Users\u/new",
        "C:/Users/u/new",
        r"\\server\share\dir/new",
    ];
    assert_eq!(mkdirs_of(&ch), posix.to_vec());

    // Windows 本机通路（`\`）：同一批目录拼出的是那一边的路径形态
    let (m, ch) = setup_sep('\\');
    for dir in dirs {
        m.sftp_mkdir(&human, "s-r29".into(), dir.into(), "new".into())
            .await
            .unwrap();
    }
    let win = [
        r"\\?\C:\Users\u\new",
        r"\\?\C:\new",
        r"C:\Users\u\new",
        r"C:/Users/u\new",
        r"\\server\share\dir\new",
    ];
    assert_eq!(
        mkdirs_of(&ch),
        win.to_vec(),
        "分隔符取自通道，尾分隔符不重复"
    );
    let commands: Vec<String> = mkdir_audit(&m)
        .iter()
        .map(|e| e.command.clone().unwrap())
        .collect();
    let mut newest_first = win.to_vec();
    newest_first.reverse();
    assert_eq!(commands, newest_first, "审计记的同样是拼好的全路径");
}
/// #29：通道的可区别错误原样透传——同名占位/权限不足/父目录不存在三种失败各自保形
/// （前端按 kind 呈现，不猜路径）；失败同样入审计（ok=false），审计不因失败漏记。
#[tokio::test]
async fn r29_mkdir_passes_through_failures_and_audits_them() {
    let (m, ch) = setup();
    let human = Actor::Human;
    let e1 = m
        .sftp_mkdir(&human, "s-r29".into(), "/taken".into(), "x".into())
        .await
        .unwrap_err();
    assert!(
        matches!(&e1, Error::InvalidInput(ref s) if s == "目标已存在，未创建：/taken/x"),
        "{e1:?}"
    );
    let e2 = m
        .sftp_mkdir(&human, "s-r29".into(), "/priv".into(), "x".into())
        .await
        .unwrap_err();
    assert!(
        matches!(&e2, Error::SftpPermissionDenied { ref path } if path == "/priv/x"),
        "{e2:?}"
    );
    let e3 = m
        .sftp_mkdir(&human, "s-r29".into(), "/gone".into(), "x".into())
        .await
        .unwrap_err();
    assert!(
        matches!(&e3, Error::SftpPathNotFound { ref path } if path == "/gone/x"),
        "{e3:?}"
    );
    assert_eq!(mkdirs_of(&ch).len(), 3);
    let ev = mkdir_audit(&m);
    assert_eq!(ev.len(), 3, "三次失败三次留痕");
    assert!(ev
        .iter()
        .all(|e| e.payload_json.get("ok") == Some(&serde_json::json!(false))));

    // 未注册会话 → SessionNotFound（与其他 sftp 入口一致），通道与审计都不留痕
    assert!(matches!(
        m.sftp_mkdir(&human, "nope".into(), "/a".into(), "b".into())
            .await,
        Err(Error::SessionNotFound)
    ));
    assert_eq!(mkdirs_of(&ch).len(), 3);
    assert_eq!(mkdir_audit(&m).len(), 3);
}
