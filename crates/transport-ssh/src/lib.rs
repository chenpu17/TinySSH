//! SSH 通路（russh 0.63）：持久 shell channel（PTY）+ 同连接 Fresh exec channel + SFTP。
//! 主机指纹 TOFU 记录；断线检测 + 重连；shell 集成由 core 在会话建立后注入。

use async_trait::async_trait;
use russh::client::{self, Handle};
use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg};
use russh::Disconnect;
use russh::{Channel, ChannelMsg, ChannelWriteHalf};
use russh_sftp::protocol::StatusCode;
use session_api::transport::tokio_util_sync::CancellationToken;
use session_api::transport::{ChannelHandle, FreshOutcome, TransportSignal};
use session_api::ForwardStateCb;
use session_api::{
    AuthType, DirEntryS, EntryKind, EntryStat, Error, ExecOpts, ForwardId, ForwardInfo,
    ForwardSpec, PathResolved, PublishOutcome, Result,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, Mutex, MutexGuard};

/// TOFU 主机指纹回调：异步（人类确认可能跨秒级等待）。None = 全接受（测试专用）。
pub type HostKeyCheck = Arc<
    dyn Fn(&str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool>> + Send>>
        + Send
        + Sync,
>;

/// 2FA 人工应答门（路线图⑩）：keyboard-interactive 非密码类提示交人类应答。
/// Ok(None) = 人类取消/通道不可用（认证终止）。None 门 = 遇到非密码提示即失败。
pub type KbPromptCheck = Arc<
    dyn Fn(
            &str,
            bool,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<String>>> + Send>>
        + Send
        + Sync,
>;

/// russh Handler 的错误类型：桥接 session_api::Error 与 russh::Error（孤儿规则）。
#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error(transparent)]
    Api(#[from] Error),
    #[error("ssh: {0}")]
    Raw(#[from] russh::Error),
}

struct ClientHandler {
    host_key_check: Option<HostKeyCheck>,
    seen_fingerprint: Arc<Mutex<Option<String>>>,
    /// 远程转发回程路由（T42）：服务器监听端口 → 本地目标。与 SshChannel.forwards 同源注册。
    router: Arc<StdMutex<HashMap<u32, (String, u16)>>>,
}

impl ClientHandler {
    fn fingerprint_of(key: &russh::keys::PublicKeyOrCertificate) -> String {
        match key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key
                .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
                .to_string(),
            russh::keys::PublicKeyOrCertificate::Certificate(_) => "certificate".to_string(),
        }
    }
}

impl client::Handler for ClientHandler {
    type Error = SshError;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let fp = Self::fingerprint_of(server_public_key);
        let mut seen = self.seen_fingerprint.lock().await;
        match seen.as_ref() {
            None => {
                // 首连：交回调确认（TOFU 首连确认 / 变更告警在 core 层按 vault 记录分流）
                if let Some(check) = &self.host_key_check {
                    let ok = check(&fp).await?;
                    if ok {
                        *seen = Some(fp);
                    }
                    Ok(ok)
                } else {
                    *seen = Some(fp);
                    Ok(true)
                }
            }
            Some(prev) if *prev == fp => Ok(true),
            Some(_) => {
                // 进程内已见过不同指纹：无回调一律拒绝（测试）；有回调走变更告警流程
                match &self.host_key_check {
                    Some(check) => {
                        let ok = check(&fp).await?;
                        if ok {
                            *seen = Some(fp);
                        }
                        Ok(ok)
                    }
                    None => Ok(false),
                }
            }
        }
    }

    /// 远程转发的入站连接（T42 FR-8，-R）：按服务器监听端口查回程路由，
    /// 接通本地目标后双向泵；无路由（已停止/未知端口）则拒绝（丢弃 reply 即拒绝）。
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<russh::client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> std::result::Result<(), Self::Error> {
        let target = self.router.lock().unwrap().get(&connected_port).cloned();
        match target {
            Some((host, port)) => {
                reply.accept().await;
                let host2 = host.clone();
                tokio::spawn(async move {
                    let Ok(mut tcp) = TcpStream::connect((host2.as_str(), port)).await else {
                        return;
                    };
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
                });
            }
            None => {
                // drop(reply) 自动拒绝
            }
        }
        Ok(())
    }
}

pub struct SshTarget {
    pub address: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    /// password 或解密后的私钥 PEM
    pub secret: String,
    pub host_key_check: Option<HostKeyCheck>,
    /// keyboard-interactive 非密码类提示的人工应答门（2FA）。
    pub kb_prompt_check: Option<KbPromptCheck>,
}

pub struct SshChannel {
    target: SshTarget,
    handle: Mutex<Option<Handle<ClientHandler>>>,
    shell: Mutex<Option<ChannelWriteHalf<russh::client::Msg>>>,
    output_tx: broadcast::Sender<Vec<u8>>,
    alive: Arc<AtomicBool>,
    size: Mutex<(u16, u16)>,
    seen_fingerprint: Arc<Mutex<Option<String>>>,
    // 端口转发（T42 FR-8）：条目表 + 远程转发回程路由（与 ClientHandler 共享）；
    // self_ref = 自身 Weak（监听任务需要 Arc 逐连接取 handle，sound 地从 &self 升回）
    forwards: StdMutex<HashMap<ForwardId, FwdEntry>>,
    router: Arc<StdMutex<HashMap<u32, (String, u16)>>>,
    self_ref: StdMutex<Option<std::sync::Weak<SshChannel>>>,
    /// 转发状态变化回调（T44 真机冒烟补口）：装配层注入，写口触发——
    /// 见 insert_entry/mark_* 的 cb 参数。
    forward_cb: StdMutex<Option<ForwardStateCb>>,
}

/// 转发条目：状态与取消令牌（local/dynamic 监听任务与 remote 的重注册都以 id 寻址）
struct FwdEntry {
    spec: ForwardSpec,
    /// ("Listening"|"Degraded"|"Failed", 原因)——Degraded 为数据面暂不可用（可恢复）
    state: StdMutex<(String, Option<String>)>,
    cancel: CancellationToken,
}

fn ssh_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        inactivity_timeout: None,
        // 断线快速检测：5s 间隔 × 2 次无响应 ≈ 10s 内判死
        keepalive_interval: Some(std::time::Duration::from_secs(5)),
        keepalive_max: 2,
        ..Default::default()
    })
}

/// SFTP 临时通道（upload/download/list_dir/resolve/stat 同模式）：
/// handle guard 与 session 成对返回（guard 保活期间连接不可被并发 close）。
type SftpBorne<'a> = (
    MutexGuard<'a, Option<Handle<ClientHandler>>>,
    russh_sftp::client::SftpSession,
);

/// C4（R30）：SFTP 状态码 → 可区别错误（不存在/权限不足 → 专用变体），其余归 Io。
fn map_sftp_err(op: &str, path: &str, e: russh_sftp::client::error::Error) -> Error {
    if let russh_sftp::client::error::Error::Status(st) = &e {
        match st.status_code {
            StatusCode::NoSuchFile => return Error::SftpPathNotFound { path: path.into() },
            StatusCode::PermissionDenied => {
                return Error::SftpPermissionDenied { path: path.into() }
            }
            _ => {}
        }
    }
    Error::Io(format!("sftp {op} {path}: {e}"))
}

/// readdir 属性 / lstat 类型 → 条目种类（C4 R30）
fn kind_of(ft: russh_sftp::protocol::FileType) -> EntryKind {
    match ft {
        russh_sftp::protocol::FileType::Dir => EntryKind::Dir,
        russh_sftp::protocol::FileType::File => EntryKind::File,
        russh_sftp::protocol::FileType::Symlink => EntryKind::Symlink,
        russh_sftp::protocol::FileType::Other => EntryKind::Other,
    }
}

/// connect（TCP+banner 交换）阶段的有界窗。docker 等端口代理在容器死后仍接受
/// TCP（无 RST）——无超时则 banner 等待可挂任意久，「有限重试」退化为单次悬挂
/// （R26 §6.4：重试计数与停止重试都依赖 attempt 有界）。认证阶段不在此窗
/// （2FA 交互等待人的应答，不能限时）。
const CONNECT_PHASE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

impl SshChannel {
    /// SFTP 临时通道开启（subsystem + init）。guard 与 session 成对——调用方
    /// 在使用期间持有 guard，防并发 close 拆掉连接。
    async fn sftp_channel(&self) -> Result<SftpBorne<'_>> {
        let guard = self.handle.lock().await;
        if guard.is_none() {
            return Err(Error::SessionClosed);
        }
        let handle = guard.as_ref().expect("checked above");
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| Error::ConnectFailed(format!("sftp channel: {e}")))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| Error::ConnectFailed(format!("sftp subsystem: {e}")))?;
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| Error::ConnectFailed(format!("sftp init: {e}")))?;
        Ok((guard, sftp))
    }

    pub async fn connect(target: SshTarget, cols: u16, rows: u16) -> Result<Arc<Self>> {
        let seen = Arc::new(Mutex::new(None::<String>));
        let (output_tx, _) = broadcast::channel(4096);
        let alive = Arc::new(AtomicBool::new(true));
        let router = Arc::new(StdMutex::new(HashMap::new()));

        let chan = Arc::new(Self {
            handle: Mutex::new(None),
            shell: Mutex::new(None),
            output_tx,
            alive,
            size: Mutex::new((cols, rows)),
            seen_fingerprint: seen.clone(),
            forwards: StdMutex::new(HashMap::new()),
            router,
            self_ref: StdMutex::new(None),
            forward_cb: StdMutex::new(None),
            target,
        });
        *chan.self_ref.lock().unwrap() = Some(Arc::downgrade(&chan));
        chan.establish().await?;
        Ok(chan)
    }

    /// 连接 + 认证 + 打开持久 shell（PTY）。
    async fn establish(&self) -> Result<()> {
        let handler = ClientHandler {
            host_key_check: self.target.host_key_check.clone(),
            seen_fingerprint: self.seen_fingerprint.clone(),
            router: self.router.clone(),
        };
        let handle = tokio::time::timeout(
            CONNECT_PHASE_TIMEOUT,
            russh::client::connect(
                ssh_config(),
                (self.target.address.as_str(), self.target.port),
                handler,
            ),
        )
        .await
        .map_err(|_| {
            Error::ConnectFailed("connect timeout（10s 内未完成 TCP/banner 交换）".into())
        })?
        .map_err(|e| match e {
            // 指纹门拒绝等 Api 错误原样透传（UI 显示"主机指纹验证失败（…）"）
            SshError::Api(e) => e,
            other => Error::ConnectFailed(format!("{other}")),
        })?;

        let mut handle = handle;
        let auth = match self.target.auth_type {
            AuthType::Password => {
                let a = handle
                    .authenticate_password(&self.target.username, &self.target.secret)
                    .await
                    .map_err(|_e| Error::AuthFailed)?;
                if a.success() {
                    a
                } else {
                    // 2FA 服务器常见形态：拒绝 password 方法、只提供 keyboard-interactive
                    //（第一轮往往就是密码提示）。回落 kb 循环重试。
                    if !self.kb_loop(&mut handle).await? {
                        return Err(Error::AuthFailed);
                    }
                    russh::client::AuthResult::Success
                }
            }
            AuthType::KeyboardInteractive => {
                if !self.kb_loop(&mut handle).await? {
                    return Err(Error::AuthFailed);
                }
                russh::client::AuthResult::Success
            }
            AuthType::Key => {
                let key =
                    decode_secret_key(&self.target.secret, None).map_err(|_| Error::AuthFailed)?;
                let with_hash = PrivateKeyWithHashAlg::new(Arc::new(key), None);
                handle
                    .authenticate_publickey(&self.target.username, with_hash)
                    .await
                    .map_err(|_e| Error::AuthFailed)?
            }
            AuthType::Agent => {
                // 私钥不出 agent：逐个尝试 agent 中已加载的密钥（ssh 标准行为）。
                // 通道按平台：unix=SSH_AUTH_SOCK；windows=OpenSSH 服务命名管道
                // \\.\pipe\openssh-ssh-agent（TINYSSH_SSH_AGENT_PIPE 可覆盖，供测试/第三方 agent）。
                use russh::keys::agent::client::AgentClient;
                #[cfg(unix)]
                let mut agent = AgentClient::connect_env().await.map_err(|e| {
                    Error::ConnectFailed(format!("ssh-agent 不可达（检查 SSH_AUTH_SOCK）: {e}"))
                })?;
                #[cfg(windows)]
                let mut agent = {
                    let pipe = std::env::var("TINYSSH_SSH_AGENT_PIPE")
                        .unwrap_or_else(|_| r"\\.\pipe\openssh-ssh-agent".to_string());
                    AgentClient::connect_named_pipe(&pipe).await.map_err(|e| {
                        Error::ConnectFailed(format!(
                            "ssh-agent 不可达（命名管道 {pipe}；确认 OpenSSH Authentication \
                             Agent 服务已启动）: {e}"
                        ))
                    })?
                };
                let identities = agent
                    .request_identities()
                    .await
                    .map_err(|e| Error::ConnectFailed(format!("ssh-agent 列出密钥失败: {e}")))?;
                if identities.is_empty() {
                    return Err(Error::ConnectFailed(
                        "ssh-agent 中没有已加载的密钥（先 ssh-add）".into(),
                    ));
                }
                let mut ok = false;
                for ident in &identities {
                    let key = ident.public_key().into_owned();
                    match handle
                        .authenticate_publickey_with(&self.target.username, key, None, &mut agent)
                        .await
                    {
                        Ok(r) if r.success() => {
                            ok = true;
                            break;
                        }
                        _ => continue,
                    }
                }
                if !ok {
                    return Err(Error::AuthFailed);
                }
                // authenticate_publickey_with 已完成认证；占位 AuthResult 满足类型
                russh::client::AuthResult::Success
            }
        };
        if !auth.success() {
            return Err(Error::AuthFailed);
        }

        // ---------- 认证完成，打开 PTY shell ----------

        let (cols, rows) = *self.size.lock().await;
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| Error::ConnectFailed(format!("open channel: {e}")))?;
        channel
            .request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
            .await
            .map_err(|e| Error::ConnectFailed(format!("pty: {e}")))?;
        channel
            .request_shell(true)
            .await
            .map_err(|e| Error::ConnectFailed(format!("shell: {e}")))?;

        // 等待 shell 请求成功回包
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => break,
                Some(ChannelMsg::Failure) => {
                    return Err(Error::ConnectFailed("shell request failed".into()))
                }
                Some(_) => continue,
                None => return Err(Error::ConnectFailed("channel closed early".into())),
            }
        }

        // 输出泵：reader half 持续读取 → broadcast
        {
            let (mut read_half, write_half) = channel.split();
            let tx = self.output_tx.clone();
            let alive = self.alive.clone();
            tokio::spawn(async move {
                loop {
                    match read_half.wait().await {
                        Some(ChannelMsg::Data { ref data }) => {
                            if tx.send(data.to_vec()).is_err() {
                                break;
                            }
                        }
                        Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                            if tx.send(data.to_vec()).is_err() {
                                break;
                            }
                        }
                        Some(ChannelMsg::ExitStatus { .. }) => continue,
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                            alive.store(false, Ordering::SeqCst);
                            break;
                        }
                        Some(_) => continue,
                    }
                }
            });
            *self.shell.lock().await = Some(write_half);
        }

        // 保存 shell channel 引用（写入经 data_bytes；信号写控制字节同路径）
        *self.handle.lock().await = Some(handle);
        // 重连恢复：远程转发随旧连接失效，本地/Dynamic 监听任务存活（逐连接取 handle）
        self.restore_remote_forwards().await;
        Ok(())
    }

    /// 对 forwards 表中所有 Remote 条目重新请求服务器监听 + 重挂回程路由（重连后调用）。
    async fn restore_remote_forwards(&self) {
        let remotes: Vec<(ForwardId, String, u16, String, u16)> = {
            let m = self.forwards.lock().unwrap();
            m.iter()
                .filter_map(|(id, e)| match &e.spec {
                    ForwardSpec::Remote {
                        listen_addr,
                        listen_port,
                        target_host,
                        target_port,
                    } => Some((
                        id.clone(),
                        listen_addr.clone(),
                        *listen_port,
                        target_host.clone(),
                        *target_port,
                    )),
                    _ => None,
                })
                .collect()
        };
        for (id, addr, port, thost, tport) in remotes {
            // checked：快照后条目可能已被 stop 删除（审核中-5 幽灵监听防护）
            let r = self
                .request_remote_checked(&id, &addr, port, &thost, tport)
                .await;
            let mut m = self.forwards.lock().unwrap();
            if let Some(e) = m.get_mut(&id) {
                // 重连重注册：无条件写目标态（非 mark_* 条件翻转——Remote 条目
                // 的状态由重注册结果直接决定）；写后经 forward_cb 通知（全写口
                // 纪律，审核 Z1）。先 drop 再取 cb 锁：与 mark_* 的
                // forward_cb→forwards 取向严格同向，不引入反向嵌套
                match r {
                    Ok(()) => *e.state.lock().unwrap() = ("Listening".into(), None),
                    Err(msg) => *e.state.lock().unwrap() = ("Failed".into(), Some(msg)),
                }
                drop(m);
                if let Some(cb) = self.forward_cb.lock().unwrap().as_ref() {
                    cb(&id);
                }
            }
        }
    }

    async fn request_remote(
        &self,
        addr: &str,
        port: u16,
        thost: &str,
        tport: u16,
    ) -> std::result::Result<(), String> {
        let guard = self.handle.lock().await;
        let h = guard.as_ref().ok_or("会话未连接")?;
        h.tcpip_forward(addr.to_string(), port as u32)
            .await
            .map_err(|e| format!("服务器拒绝监听 {addr}:{port}：{e}"))?;
        self.router
            .lock()
            .unwrap()
            .insert(port as u32, (thost.to_string(), tport));
        Ok(())
    }

    /// request_remote + 停止竞态防护（审核中-5）：重连恢复与 stop_forward 并发时，
    /// 快照后条目可能已被 stop 删除——请求成功但条目不在 = 幽灵监听（服务器在听、
    /// 回程路由挂着、列表为空无从停）。此时立即撤回监听，不上路由。
    async fn request_remote_checked(
        &self,
        id: &str,
        addr: &str,
        port: u16,
        thost: &str,
        tport: u16,
    ) -> std::result::Result<(), String> {
        let r = self.request_remote(addr, port, thost, tport).await;
        if r.is_ok() && self.forwards.lock().unwrap().get(id).is_none() {
            let guard = self.handle.lock().await;
            if let Some(h) = guard.as_ref() {
                let _ = h.cancel_tcpip_forward(addr.to_string(), port as u32).await;
            }
            self.router.lock().unwrap().remove(&(port as u32));
            return Err("转发已被停止（请求成功后撤销）".into());
        }
        r
    }

    /// keyboard-interactive 认证循环（路线图⑩ 2FA）。
    /// 应答策略：非回显且文本含 password/密码 的提示 → 自动用库内密码（省一次
    /// 重复输入，服务器要求的正是表单里那个密码）；其余提示（OTP/验证码等）→
    /// 人工门。无门且需要人工 → ConnectFailed 明说，不静默失败。
    async fn kb_loop(&self, handle: &mut russh::client::Handle<ClientHandler>) -> Result<bool> {
        use russh::client::KeyboardInteractiveAuthResponse as R;
        let mut resp = handle
            .authenticate_keyboard_interactive_start(&self.target.username, None)
            .await
            .map_err(|_| Error::AuthFailed)?;
        loop {
            match resp {
                R::Success => return Ok(true),
                R::Failure { .. } => return Ok(false),
                R::InfoRequest { prompts, .. } => {
                    let mut answers = Vec::with_capacity(prompts.len());
                    for p in &prompts {
                        let text = p.prompt.trim().to_lowercase();
                        let is_pw =
                            !p.echo && (text.contains("password") || p.prompt.contains("密码"));
                        let ans = if is_pw {
                            self.target.secret.clone()
                        } else {
                            match &self.target.kb_prompt_check {
                                Some(gate) => gate(&p.prompt, p.echo).await?.ok_or_else(|| {
                                    Error::ConnectFailed(
                                        // 取消与超时同走 None：文案不得只说「被取消」冤枉超时，
                                        // 更不能落进 AuthFailed——把「取消认证」误报成凭据错误（PV R4）
                                        "服务器要求额外交互认证（2FA），人工应答被取消或超时"
                                            .into(),
                                    )
                                })?,
                                None => {
                                    return Err(Error::ConnectFailed(
                                        "服务器要求额外交互认证（2FA），但本连接未启用人工应答通道"
                                            .into(),
                                    ))
                                }
                            }
                        };
                        answers.push(ans);
                    }
                    resp = handle
                        .authenticate_keyboard_interactive_respond(answers)
                        .await
                        .map_err(|_| Error::AuthFailed)?;
                }
            }
        }
    }

    async fn write_bytes(&self, data: &[u8]) -> Result<()> {
        let guard = self.shell.lock().await;
        let w = guard.as_ref().ok_or(Error::SessionClosed)?;
        w.data_bytes(data.to_vec())
            .await
            .map_err(|e| Error::Io(format!("ssh write: {e}")))
    }

    pub async fn fingerprint(&self) -> Option<String> {
        self.seen_fingerprint.lock().await.clone()
    }
}

#[async_trait]
impl ChannelHandle for SshChannel {
    async fn write(&self, data: &[u8]) -> Result<()> {
        self.write_bytes(data).await
    }

    async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        *self.size.lock().await = (cols, rows);
        // resize 作用于 shell channel
        let guard = self.shell.lock().await;
        if let Some(ch) = guard.as_ref() {
            ch.window_change(cols as u32, rows as u32, 0, 0)
                .await
                .map_err(|e| Error::Io(format!("resize: {e}")))?;
        }
        Ok(())
    }

    async fn exec_fresh(
        &self,
        cmd: &str,
        opts: &ExecOpts,
        deadline: std::time::Instant,
        cancel: &CancellationToken,
    ) -> Result<FreshOutcome> {
        // 锁收窄（并发修复②）：handle 锁只罩 channel_open——此前 guard 全程持有
        // 到 exec 收尾，force_close/reconnect/close 与并发 sftp 全被单次 exec
        // 阻塞（挂死 IO 时恒等至 deadline）。通道开启后连接生命周期由 channel
        // 自持：close 抢到锁 disconnect，在途 exec 以连接错误快速失败（正确语义
        // ——关闭不再等执行，执行不再钉死关闭）。
        // cancel 即时性轮：开通道/exec 写入两个网络点也包 cancel——读环本就有
        // select 臂，此前前置段挂在死网络上时 cancel_exec 迟迟不可达。
        let mut channel = {
            let handle_guard = self.handle.lock().await;
            let handle = handle_guard.as_ref().ok_or(Error::SessionClosed)?;
            let opened = tokio::select! {
                c = handle.channel_open_session() => c,
                _ = cancel.cancelled() => return Err(Error::Cancelled),
            };
            opened.map_err(|e| Error::ConnectFailed(format!("fresh channel: {e}")))?
        };

        // env 注入：env K=V ... sh -c '<cmd>'
        // （直接 `env K=V cmd` 会让外层 shell 先展开 cmd 里的 $VAR，注入无效）
        let mut full = String::new();
        if !opts.env.is_empty() {
            full.push_str("env");
            for (k, v) in &opts.env {
                // 值按 sh 单引号转义（与 cmd 同法；审计 S6）：env 是公共 ExecOpts
                // 字段，值含 `;`/`` ` ``/`$()` 时不转义会逃逸出 sh -c 边界——审批
                // 卡与审计只记 effective_cmd，逃逸即「审批记 A、执行 B」
                let vq = v.replace('\'', "'\\''");
                full.push_str(&format!(" {k}='{vq}'"));
            }
            let quoted = cmd.replace("'", "'\\''");
            full.push_str(&format!(" sh -c '{quoted}'"));
        } else {
            full.push_str(cmd);
        }
        let execed = tokio::select! {
            r = channel.exec(true, full.as_bytes()) => r,
            _ = cancel.cancelled() => return Err(Error::Cancelled),
        };
        execed.map_err(|e| Error::ConnectFailed(format!("exec: {e}")))?;

        let cap = opts.output_cap.unwrap_or(session_api::DEFAULT_OUTPUT_CAP);
        let mut stdout: Vec<u8> = Vec::new();
        let mut stderr: Vec<u8> = Vec::new();
        let mut truncated = false;
        let mut exit_code: Option<i32> = None;
        let mut completed = false;

        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { ref data }) => {
                            if stdout.len() + data.len() <= cap {
                                stdout.extend_from_slice(data);
                            } else {
                                let take = cap.saturating_sub(stdout.len());
                                stdout.extend_from_slice(&data[..take]);
                                truncated = true;
                            }
                        }
                        Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                            if stderr.len() + data.len() <= cap {
                                stderr.extend_from_slice(data);
                            } else {
                                let take = cap.saturating_sub(stderr.len());
                                stderr.extend_from_slice(&data[..take]);
                                truncated = true;
                            }
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            exit_code = Some(exit_status as i32);
                        }
                        Some(ChannelMsg::Eof) => {
                            // EOF 后仍可能收到 ExitStatus/Close；继续等一拍
                            if exit_code.is_some() {
                                completed = true;
                                break;
                            }
                        }
                        Some(ChannelMsg::Close) => {
                            completed = exit_code.is_some();
                            break;
                        }
                        None => {
                            completed = exit_code.is_some();
                            break;
                        }
                        Some(_) => {}
                    }
                }
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => break,
                _ = cancel.cancelled() => break,
            }
        }
        let _ = channel.close().await;

        Ok(FreshOutcome {
            exit_code,
            stdout,
            stderr,
            truncated,
            completed,
        })
    }

    async fn signal(&self, sig: TransportSignal) -> Result<()> {
        match sig {
            TransportSignal::Interrupt => self.write_bytes(&[0x03]).await,
            TransportSignal::Quit => self.write_bytes(&[0x1c]).await,
            TransportSignal::Terminate | TransportSignal::Kill => Ok(()),
        }
    }

    async fn force_close(&self) -> Result<()> {
        self.alive.store(false, Ordering::SeqCst);
        if let Some(handle) = self.handle.lock().await.as_ref() {
            let _ = handle
                .disconnect(Disconnect::ByApplication, "force close", "EN")
                .await;
        }
        Ok(())
    }

    fn subscribe_output(&self) -> broadcast::Receiver<Vec<u8>> {
        self.output_tx.subscribe()
    }

    async fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
            && self
                .handle
                .lock()
                .await
                .as_ref()
                .map(|h| !h.is_closed())
                .unwrap_or(false)
    }

    async fn reconnect(&self) -> Result<()> {
        // 断开旧连接，重建
        if let Some(old) = self.handle.lock().await.take() {
            let _ = old
                .disconnect(Disconnect::ByApplication, "reconnect", "EN")
                .await;
        }
        self.alive.store(true, Ordering::SeqCst);
        self.establish().await
    }

    async fn close(&self) -> Result<()> {
        self.alive.store(false, Ordering::SeqCst);
        // T42：关闭会话即停全部转发——本地/-D 监听任务持有 Arc<Self>，
        // 不取消会连监听 socket 一起泄漏（端口被占到进程退出）
        let entries: Vec<FwdEntry> = self
            .forwards
            .lock()
            .unwrap()
            .drain()
            .map(|(_, e)| e)
            .collect();
        self.router.lock().unwrap().clear();
        for e in entries {
            e.cancel.cancel();
        }
        if let Some(handle) = self.handle.lock().await.take() {
            let _ = handle
                .disconnect(Disconnect::ByApplication, "session closed", "EN")
                .await;
        }
        Ok(())
    }

    async fn upload(
        &self,
        local: &std::path::Path,
        remote: &str,
        cancel: &CancellationToken,
        progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<u64> {
        // 锁收窄（并发修复②，upload/download/list_dir 同款）：handle 锁只罩
        // channel_open——大传输此前把锁拿在手里到传完，close/reconnect 与
        // sftp_list（文件面板）全被阻塞数分钟；sftp 会话自 channel 派生后
        // guard 即死重。close disconnect → 在途传输以连接错误快速失败。
        let channel = {
            let handle_guard = self.handle.lock().await;
            let handle = handle_guard.as_ref().ok_or(Error::SessionClosed)?;
            handle
                .channel_open_session()
                .await
                .map_err(|e| Error::ConnectFailed(format!("sftp channel: {e}")))?
        };
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| Error::ConnectFailed(format!("sftp subsystem: {e}")))?;
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| Error::ConnectFailed(format!("sftp init: {e}")))?;

        let mut file = sftp
            .create(remote)
            .await
            .map_err(|e| Error::Io(format!("sftp create {remote}: {e}")))?;
        let mut src = tokio::fs::File::open(local)
            .await
            .map_err(|e| Error::Io(format!("open {}: {e}", local.display())))?;
        let total_len = tokio::fs::metadata(local).await.ok().map(|m| m.len());
        let mut total = 0u64;
        let mut buf = [0u8; 65536];
        loop {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let n = src
                .read(&mut buf)
                .await
                .map_err(|e| Error::Io(format!("read: {e}")))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])
                .await
                .map_err(|e| Error::Io(format!("sftp write: {e}")))?;
            total += n as u64;
            progress(total, total_len);
        }
        file.flush().await.ok();
        drop(file);
        sftp.close().await.ok();
        Ok(total)
    }

    async fn download(
        &self,
        remote: &str,
        local: &std::path::Path,
        cancel: &CancellationToken,
        progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<u64> {
        // 锁收窄（并发修复②，upload/download/list_dir 同款）：handle 锁只罩
        // channel_open——大传输此前把锁拿在手里到传完，close/reconnect 与
        // sftp_list（文件面板）全被阻塞数分钟；sftp 会话自 channel 派生后
        // guard 即死重。close disconnect → 在途传输以连接错误快速失败。
        let channel = {
            let handle_guard = self.handle.lock().await;
            let handle = handle_guard.as_ref().ok_or(Error::SessionClosed)?;
            handle
                .channel_open_session()
                .await
                .map_err(|e| Error::ConnectFailed(format!("sftp channel: {e}")))?
        };
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| Error::ConnectFailed(format!("sftp subsystem: {e}")))?;
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| Error::ConnectFailed(format!("sftp init: {e}")))?;

        let mut file = sftp
            .open(remote)
            .await
            .map_err(|e| Error::Io(format!("sftp open {remote}: {e}")))?;
        let total_len = sftp.metadata(remote).await.ok().and_then(|a| a.size);
        if let Some(parent) = local.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| Error::Io(format!("mkdir: {e}")))?;
        }
        let mut dst = tokio::fs::File::create(local)
            .await
            .map_err(|e| Error::Io(format!("create {}: {e}", local.display())))?;
        let mut total = 0u64;
        let mut buf = [0u8; 65536];
        loop {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let n = file
                .read(&mut buf)
                .await
                .map_err(|e| Error::Io(format!("sftp read: {e}")))?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n])
                .await
                .map_err(|e| Error::Io(format!("write: {e}")))?;
            total += n as u64;
            progress(total, total_len);
        }
        drop(dst);
        sftp.close().await.ok();
        Ok(total)
    }

    /// 列目录（T41 FR-7）：临时 SFTP 通道 readdir（与上传下载同模式，无持久会话生命周期负担）。
    /// kind=条目自身类型（readdir 属性 lstat 语义）；size/mtime 未知为 None（§352 不伪造零值）。
    async fn list_dir(&self, path: &str) -> Result<Vec<DirEntryS>> {
        // 锁收窄（并发修复②，upload/download/list_dir 同款）：handle 锁只罩
        // channel_open——大传输此前把锁拿在手里到传完，close/reconnect 与
        // sftp_list（文件面板）全被阻塞数分钟；sftp 会话自 channel 派生后
        // guard 即死重。close disconnect → 在途传输以连接错误快速失败。
        let channel = {
            let handle_guard = self.handle.lock().await;
            let handle = handle_guard.as_ref().ok_or(Error::SessionClosed)?;
            handle
                .channel_open_session()
                .await
                .map_err(|e| Error::ConnectFailed(format!("sftp channel: {e}")))?
        };
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| Error::ConnectFailed(format!("sftp subsystem: {e}")))?;
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| Error::ConnectFailed(format!("sftp init: {e}")))?;

        let rd = sftp
            .read_dir(path)
            .await
            .map_err(|e| map_sftp_err("readdir", path, e))?;
        let mut out: Vec<DirEntryS> = rd
            .filter(|e| !matches!(e.file_name().as_str(), "." | ".."))
            .map(|e| {
                let m = e.metadata();
                DirEntryS {
                    name: e.file_name(),
                    is_dir: m.is_dir(),
                    kind: Some(kind_of(m.file_type())),
                    size: m.size,
                    mtime: m.mtime.map(|v| v as i64),
                }
            })
            .collect();
        // 目录在前、名称不区分大小写排序（浏览可预期性）
        out.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        sftp.close().await.ok();
        Ok(out)
    }

    /// C4（R30）：路径规范化。path=None → SFTP 初始目录（canonicalize "."）。
    async fn resolve_path(&self, path: Option<&str>) -> Result<PathResolved> {
        let target = path.unwrap_or(".");
        let (_guard, sftp) = self.sftp_channel().await?;
        let canon = sftp
            .canonicalize(target)
            .await
            .map_err(|e| map_sftp_err("realpath", target, e))?;
        sftp.close().await.ok();
        Ok(PathResolved { canonical: canon })
    }

    /// C4（R30）：条目元数据。kind/symlink_target=lstat 语义；is_dir/size/mtime=
    /// 跟随语义（链接取目标，失败回落链接本体）；canonical 悬空链接为 None（§352 不猜路径）。
    async fn stat_entry(&self, path: &str) -> Result<EntryStat> {
        let (_guard, sftp) = self.sftp_channel().await?;
        let lst = sftp
            .symlink_metadata(path)
            .await
            .map_err(|e| map_sftp_err("lstat", path, e))?;
        let ft = lst.file_type();
        let kind = Some(kind_of(ft));
        let symlink_target = if ft.is_symlink() {
            sftp.read_link(path).await.ok()
        } else {
            None
        };
        let md = if ft.is_symlink() {
            match sftp.metadata(path).await {
                Ok(m) => m,
                Err(_) => lst, // 悬空链接等：回落链接本体，size/mtime 照服务器所报
            }
        } else {
            lst
        };
        let canonical = sftp.canonicalize(path).await.ok();
        sftp.close().await.ok();
        Ok(EntryStat {
            canonical,
            kind,
            is_dir: md.is_dir(),
            size: md.size,
            mtime: md.mtime.map(|v| v as i64),
            symlink_target,
        })
    }

    /// C6/R34 DF6.1：hardlink@openssh.com 原子 no-clobber 发布。
    /// Ok(false)=扩展未声明（init 探明）→ Unsupported；Status 应答=确定未提交
    /// （服务端已裁决失败，含目标已存在竞态）→ Rejected；IO/Timeout 等=请求已
    /// 发出、应答丢失/失稳 → Ambiguous（提交与否不可知，调用方落 OutcomeUnknown）。
    async fn publish_hardlink(&self, existing: &str, new: &str) -> Result<PublishOutcome> {
        let (_guard, sftp) = self.sftp_channel().await?;
        let r = sftp.hardlink(existing, new).await;
        sftp.close().await.ok();
        match r {
            Ok(true) => Ok(PublishOutcome::Committed),
            Ok(false) => Ok(PublishOutcome::Unsupported),
            Err(russh_sftp::client::error::Error::Status(st)) => Ok(PublishOutcome::Rejected(
                format!("{} {}", st.status_code, st.error_message),
            )),
            Err(_e) => Ok(PublishOutcome::Ambiguous),
        }
    }

    /// C6/R34：远端文件删除（temp 清理；不存在=幂等 Ok）。
    async fn remove_file(&self, path: &str) -> Result<()> {
        let (_guard, sftp) = self.sftp_channel().await?;
        let r = sftp.remove_file(path).await;
        sftp.close().await.ok();
        match r {
            Ok(()) => Ok(()),
            Err(russh_sftp::client::error::Error::Status(st))
                if st.status_code == StatusCode::NoSuchFile =>
            {
                Ok(())
            }
            Err(e) => Err(map_sftp_err("remove", path, e)),
        }
    }

    // ---- 端口转发（T42 FR-8）----

    async fn start_forward(&self, spec: ForwardSpec) -> Result<ForwardId> {
        let id = format!("f-{}", uuid::Uuid::new_v4());
        match spec.clone() {
            ForwardSpec::Local {
                listen_addr,
                listen_port,
                target_host,
                target_port,
            } => {
                if listen_port == 0 {
                    return Err(Error::ForwardListenFailed {
                        field: "listen".into(),
                        reason: "监听端口须为 1–65535".into(),
                    });
                }
                if target_host.trim().is_empty() || target_port == 0 {
                    return Err(Error::ForwardListenFailed {
                        field: "target".into(),
                        reason: "目标主机与端口（1–65535）不能为空".into(),
                    });
                }
                validate_local_listen_addr(&listen_addr)?;
                let listener = TcpListener::bind((listen_addr.as_str(), listen_port))
                    .await
                    .map_err(|e| Error::ForwardListenFailed {
                        field: "listen".into(),
                        reason: format!("本地监听 {listen_addr}:{listen_port} 失败：{e}"),
                    })?;
                let cancel = CancellationToken::new();
                let arc = self.self_arc()?;
                // 目标在 spawn 时捕获（审核中-1）：条目 spec 从不变更，逐连接按端口反查
                // HashMap 只会引入同端口多绑定（127.0.0.1 与 0.0.0.0 可并存）的串台
                tokio::spawn(run_local_forward(
                    arc,
                    listener,
                    Some((target_host, target_port)),
                    id.clone(),
                    cancel.clone(),
                ));
                insert_entry(
                    &self.forwards,
                    &self.forward_cb.lock().unwrap(),
                    &id,
                    spec,
                    cancel,
                );
            }
            ForwardSpec::Remote {
                listen_addr,
                listen_port,
                target_host,
                target_port,
            } => {
                if listen_port == 0 {
                    return Err(Error::ForwardListenFailed {
                        field: "listen".into(),
                        reason: "监听端口须为 1–65535".into(),
                    });
                }
                if target_host.trim().is_empty() || target_port == 0 {
                    return Err(Error::ForwardListenFailed {
                        field: "target".into(),
                        reason: "目标主机与端口（1–65535）不能为空".into(),
                    });
                }
                let cancel = CancellationToken::new();
                insert_entry(
                    &self.forwards,
                    &self.forward_cb.lock().unwrap(),
                    &id,
                    spec,
                    cancel,
                );
                if let Err(msg) = self
                    .request_remote(&listen_addr, listen_port, &target_host, target_port)
                    .await
                {
                    mark_failed(&self.forwards, &self.forward_cb.lock().unwrap(), &id, msg);
                }
            }
            ForwardSpec::Dynamic {
                listen_addr,
                listen_port,
            } => {
                if listen_port == 0 {
                    return Err(Error::ForwardListenFailed {
                        field: "listen".into(),
                        reason: "监听端口须为 1–65535".into(),
                    });
                }
                validate_local_listen_addr(&listen_addr)?;
                let listener = TcpListener::bind((listen_addr.as_str(), listen_port))
                    .await
                    .map_err(|e| Error::ForwardListenFailed {
                        field: "listen".into(),
                        reason: format!("本地监听 {listen_addr}:{listen_port} 失败：{e}"),
                    })?;
                let cancel = CancellationToken::new();
                let arc = self.self_arc()?;
                tokio::spawn(run_local_forward(
                    arc,
                    listener,
                    None,
                    id.clone(),
                    cancel.clone(),
                ));
                insert_entry(
                    &self.forwards,
                    &self.forward_cb.lock().unwrap(),
                    &id,
                    spec,
                    cancel,
                );
            }
        }
        Ok(id)
    }

    async fn stop_forward(&self, id: &ForwardId) -> Result<()> {
        let entry = self.forwards.lock().unwrap().remove(id);
        let Some(e) = entry else {
            return Err(Error::InvalidInput("转发不存在或已停止".into()));
        };
        e.cancel.cancel();
        if let Some(cb) = self.forward_cb.lock().unwrap().as_ref() {
            cb(id);
        }
        if let ForwardSpec::Remote {
            listen_addr,
            listen_port,
            ..
        } = &e.spec
        {
            self.router.lock().unwrap().remove(&(*listen_port as u32));
            let guard = self.handle.lock().await;
            if let Some(h) = guard.as_ref() {
                let _ = h
                    .cancel_tcpip_forward(listen_addr.clone(), *listen_port as u32)
                    .await;
            }
        }
        Ok(())
    }

    async fn list_forwards(&self) -> Result<Vec<ForwardInfo>> {
        let m = self.forwards.lock().unwrap();
        Ok(m.iter()
            .map(|(id, e)| {
                let (state, error) = e.state.lock().unwrap().clone();
                ForwardInfo {
                    id: id.clone(),
                    spec: e.spec.clone(),
                    state,
                    error,
                }
            })
            .collect())
    }

    fn set_forward_event_cb(&self, cb: ForwardStateCb) {
        *self.forward_cb.lock().unwrap() = Some(cb);
    }
}

fn insert_entry(
    m: &StdMutex<HashMap<ForwardId, FwdEntry>>,
    cb: &Option<ForwardStateCb>,
    id: &str,
    spec: ForwardSpec,
    cancel: CancellationToken,
) {
    m.lock().unwrap().insert(
        id.to_string(),
        FwdEntry {
            spec,
            state: StdMutex::new(("Listening".into(), None)),
            cancel,
        },
    );
    if let Some(cb) = cb.as_ref() {
        cb(&id.to_string());
    }
}

fn mark_failed(
    m: &StdMutex<HashMap<ForwardId, FwdEntry>>,
    cb: &Option<ForwardStateCb>,
    id: &str,
    msg: String,
) {
    if let Some(e) = m.lock().unwrap().get_mut(id) {
        *e.state.lock().unwrap() = ("Failed".into(), Some(msg));
        if let Some(cb) = cb.as_ref() {
            cb(&id.to_string());
        }
    }
}

/// 数据面降级（审核中-4）：监听仍在但隧道当前不可用（断线/通道开启失败）。
/// 仅从 Listening 降级——不覆盖 Failed（配置性失败）与已是 Degraded 的旧原因。
fn mark_degraded(
    m: &StdMutex<HashMap<ForwardId, FwdEntry>>,
    cb: &Option<ForwardStateCb>,
    id: &str,
    msg: &str,
) {
    if let Some(e) = m.lock().unwrap().get(id) {
        let mut st = e.state.lock().unwrap();
        if st.0 == "Listening" {
            *st = ("Degraded".into(), Some(msg.to_string()));
            drop(st);
            if let Some(cb) = cb.as_ref() {
                cb(&id.to_string());
            }
        }
    }
}

/// 下一连接成功即恢复（仅 Degraded → Listening；不动 Failed）
fn mark_recovered(
    m: &StdMutex<HashMap<ForwardId, FwdEntry>>,
    cb: &Option<ForwardStateCb>,
    id: &str,
) {
    if let Some(e) = m.lock().unwrap().get(id) {
        let mut st = e.state.lock().unwrap();
        if st.0 == "Degraded" {
            *st = ("Listening".into(), None);
            drop(st);
            if let Some(cb) = cb.as_ref() {
                cb(&id.to_string());
            }
        }
    }
}

/// 本地/Dynamic 监听地址校验（R40 §6.6）：地址是显式字段，默认回环。
/// 非回环（0.0.0.0/::/具体网卡 IP/主机名）**允许**——设计 §6.6 要求「非回环监听
/// 显示暴露范围，必须主动选择」，故「主动选择」由 FE 把关（默认 127.0.0.1 +
/// 暴露范围提示 + 显式确认），核心只拒绝空串/纯空白（bind 会因无效地址自然报错，
/// 由 start_forward 映射为 ForwardListenFailed{field:"listen"}）。
fn validate_local_listen_addr(addr: &str) -> Result<()> {
    if addr.trim().is_empty() {
        return Err(Error::InvalidInput(
            "监听地址不能为空（默认 127.0.0.1）".into(),
        ));
    }
    Ok(())
}

impl SshChannel {
    fn self_arc(&self) -> Result<Arc<Self>> {
        self.self_ref
            .lock()
            .unwrap()
            .as_ref()
            .and_then(std::sync::Weak::upgrade)
            .ok_or_else(|| Error::Io("通道已释放".into()))
    }
}

/// 本地/Dynamic 转发监听任务：accept → （SOCKS5 时先握手取目标，否则用 spawn 时
/// 捕获的固定目标）→ 每连接开 direct_tcpip 通道双向泵。逐连接取当前 handle——
/// 重连后自动用新连接，监听不中断。
async fn run_local_forward(
    this: Arc<SshChannel>,
    listener: TcpListener,
    // 固定目标（-L）。None = Dynamic（SOCKS5 按连接解析目标）
    fixed: Option<(String, u16)>,
    // 条目 id（Degraded 态回写，审核中-4）
    fwd_id: ForwardId,
    cancel: CancellationToken,
) {
    loop {
        let (mut tcp, _peer) = tokio::select! {
            _ = cancel.cancelled() => break,
            a = listener.accept() => match a {
                Ok(x) => x,
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    continue;
                }
            },
        };
        let this2 = this.clone();
        let fixed2 = fixed.clone();
        let id2 = fwd_id.clone();
        tokio::spawn(async move {
            // dynamic：先解析到目标（方法选择即时回）；CONNECT 应答延后到通道结果
            let ((host, port), socks5) = if let Some(t) = fixed2 {
                (t, false)
            } else {
                match socks5_parse(&mut tcp).await {
                    Some(hp) => (hp, true),
                    None => return, // 握手失败：直接断开（SOCKS 客户端会报错）
                }
            };
            pump_direct(&this2, tcp, (host, port), socks5, &id2).await;
        });
    }
}

async fn pump_direct(
    this: &Arc<SshChannel>,
    mut tcp: TcpStream,
    (host, port): (String, u16),
    socks5: bool,
    fwd_id: &str,
) {
    if host.is_empty() || port == 0 {
        return;
    }
    // 数据面失败可见性（审核中-4）：此前两处静默 return——断线期间 accept 的连接
    // 即断、通道开启失败无痕，UI 恒「监听中 ✓」。改为 Degraded 态 + tracing，
    // 下一连接成功即恢复 Listening（重连后 handle 换新）。
    let chan = {
        let guard = this.handle.lock().await;
        let Some(h) = guard.as_ref() else {
            tracing::warn!(forward = fwd_id, "会话未连接，转发连接被吞（等待重连）");
            // SOCKS5 失败应答一致性（复核低-1）：此路径也回 REP=1——
            // 否则 SOCKS 客户端拿到的是裸重置而非代理错误
            if socks5 {
                let _ = tcp.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            }
            mark_degraded(
                &this.forwards,
                &this.forward_cb.lock().unwrap(),
                fwd_id,
                "会话未连接（重连后自动恢复）",
            );
            return;
        };
        h.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
            .await
    };
    match chan {
        Ok(chan) => {
            // SOCKS5 应答时序（审核中-3）：通道确认后才回 REP=0；失败回 REP=1
            // （general failure）——OpenSSH 同序，客户端能拿到代理错误而非裸重置
            if socks5 {
                let _ = tcp.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            }
            mark_recovered(&this.forwards, &this.forward_cb.lock().unwrap(), fwd_id);
            let mut stream = chan.into_stream();
            let copied = tokio::io::copy_bidirectional(&mut tcp, &mut stream)
                .await
                .map(|(c2s, s2c)| c2s + s2c)
                .unwrap_or(0);
            // Win32-OpenSSH 对「目标拒绝」回「通道开启成功→立即零字节关闭」而非
            // open-failure（容器/Alpine 走上面 Err 分支）——双向零字节即闭视为
            // 目标侧拒绝（T44 语义：文案指目标侧），下一次成功连接即恢复 Listening。
            if copied == 0 {
                tracing::info!(forward = fwd_id, "direct 通道零字节即闭——目标侧拒绝");
                mark_degraded(
                    &this.forwards,
                    &this.forward_cb.lock().unwrap(),
                    fwd_id,
                    "目标不可达或被拒绝（连接即断）",
                );
            }
        }
        Err(e) => {
            tracing::warn!(forward = fwd_id, error = %e, "direct_tcpip 通道开启失败");
            // REP 精细化（复核中-3，复审①修正）：russh 丢弃服务器描述串、Display 恒为
            // "Failed to open channel (枚举)"——字符串匹配 refused 永不命中（死代码）。
            // 改 match 枚举：ConnectFailed（SSH reason 2 = 目标拒绝/不可达）→
            // REP=5 connection refused，其余按 general failure REP=1
            let rep: u8 = if matches!(
                e,
                russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed)
            ) {
                5
            } else {
                1
            };
            if socks5 {
                let _ = tcp.write_all(&[5, rep, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            }
            // 语义区分（复核中-3）：会话仍在而通道被拒 → 目标侧不可达（隧道本身
            // 正常），文案不再误导为「隧道降级」；会话已断才是隧道侧问题
            let tunnel_down = this.handle.lock().await.is_none();
            let msg = if tunnel_down {
                "会话未连接（重连后自动恢复）".to_string()
            } else {
                format!("目标不可达或被拒绝：{e}")
            };
            mark_degraded(
                &this.forwards,
                &this.forward_cb.lock().unwrap(),
                fwd_id,
                &msg,
            );
        }
    }
}

/// 最小 SOCKS5 服务端握手解析（RFC1928）：无认证 + CONNECT；IPv4/域名/IPv6 目标。
/// 方法选择即时应答；CONNECT 结果应答**不在本函数**——延后到通道开启结果（见
/// pump_direct，审核中-3）。失败返回 None（连接断开，由调用方放弃）。
async fn socks5_parse(tcp: &mut TcpStream) -> Option<(String, u16)> {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let mut hdr = [0u8; 2];
    tcp.read_exact(&mut hdr).await.ok()?;
    if hdr[0] != 5 {
        return None;
    }
    let mut methods = vec![0u8; hdr[1] as usize];
    tcp.read_exact(&mut methods).await.ok()?;
    tcp.write_all(&[5, 0]).await.ok()?; // 选定「无认证」
    let mut req = [0u8; 4];
    tcp.read_exact(&mut req).await.ok()?;
    if req[0] != 5 || req[1] != 1 {
        return None; // 仅支持 CONNECT
    }
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            tcp.read_exact(&mut a).await.ok()?;
            format!("{}.{}.{}.{}", a[0], a[1], a[2], a[3])
        }
        3 => {
            let mut l = [0u8; 1];
            tcp.read_exact(&mut l).await.ok()?;
            let mut d = vec![0u8; l[0] as usize];
            tcp.read_exact(&mut d).await.ok()?;
            String::from_utf8(d).ok()?
        }
        4 => {
            let mut a = [0u8; 16];
            tcp.read_exact(&mut a).await.ok()?;
            let parts: Vec<String> = a
                .chunks(2)
                .map(|c| format!("{:02x}{:02x}", c[0], c[1]))
                .collect();
            parts.join(":")
        }
        _ => return None,
    };
    let mut p = [0u8; 2];
    tcp.read_exact(&mut p).await.ok()?;
    Some((host, u16::from_be_bytes(p)))
}

#[cfg(test)]
mod t44_tests {
    use super::*;

    fn entry_with(state: &str) -> StdMutex<HashMap<ForwardId, FwdEntry>> {
        let mut m = HashMap::new();
        m.insert(
            "f-x".into(),
            FwdEntry {
                spec: ForwardSpec::Dynamic {
                    listen_addr: "127.0.0.1".into(),
                    listen_port: 11080,
                },
                state: StdMutex::new((state.to_string(), None)),
                cancel: CancellationToken::new(),
            },
        );
        StdMutex::new(m)
    }
    fn state_of(m: &StdMutex<HashMap<ForwardId, FwdEntry>>) -> String {
        m.lock()
            .unwrap()
            .get("f-x")
            .unwrap()
            .state
            .lock()
            .unwrap()
            .0
            .clone()
    }

    // Degraded 状态机（审核中-4）：Listening → Degraded → Listening 可逆；
    // Failed 不被降级路径覆盖；Degraded 恢复不动 Failed
    #[test]
    fn degraded_state_transitions() {
        let m = entry_with("Listening");
        mark_degraded(&m, &None, "f-x", "隧道暂不可用");
        assert_eq!(state_of(&m), "Degraded");
        // 重复降级不重复写（已是 Degraded）
        mark_degraded(&m, &None, "f-x", "另一原因");
        assert_eq!(state_of(&m), "Degraded");
        mark_recovered(&m, &None, "f-x");
        assert_eq!(state_of(&m), "Listening");

        let f = entry_with("Failed");
        mark_degraded(&f, &None, "f-x", "不应覆盖");
        assert_eq!(state_of(&f), "Failed");
        mark_recovered(&f, &None, "f-x");
        assert_eq!(state_of(&f), "Failed");

        // 条目不存在：不 panic
        mark_degraded(&m, &None, "f-none", "x");
        mark_recovered(&m, &None, "f-none");
    }

    // 状态写口触发回调（T44 真机冒烟补口）：insert/degraded/recovered 各通知
    // 一次；条件写口状态未变（重复降级/重复恢复）与条目不存在时不通知
    #[test]
    fn forward_state_cb_fires_on_write_paths() {
        let hits: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let h2 = hits.clone();
        let cb: ForwardStateCb = Arc::new(move |id| h2.lock().unwrap().push(id.to_string()));
        let cb = Some(cb);
        let m: StdMutex<HashMap<ForwardId, FwdEntry>> = StdMutex::new(HashMap::new());
        insert_entry(
            &m,
            &cb,
            "f-x",
            ForwardSpec::Dynamic {
                listen_addr: "127.0.0.1".into(),
                listen_port: 11080,
            },
            CancellationToken::new(),
        );
        mark_degraded(&m, &cb, "f-x", "隧道暂不可用");
        mark_degraded(&m, &cb, "f-x", "已降级不重复通知");
        mark_recovered(&m, &cb, "f-x");
        mark_recovered(&m, &cb, "f-x");
        mark_failed(&m, &cb, "f-none", "条目不存在".into());
        assert_eq!(*hits.lock().unwrap(), vec!["f-x", "f-x", "f-x"]);
    }

    // R40（§6.6）：监听地址是**显式字段**、默认回环；非回环（0.0.0.0/::/网卡 IP/
    // 主机名）**放行**——「主动选择 + 暴露范围告知」由 FE 把关（默认 127.0.0.1 +
    // 非回环警告 + 显式勾选），核心只拒空串/纯空白。此前的 T44「回环 only」约束
    // 随 §6.6 放宽（D01：地址是显式字段，用户可显式选择对外监听）。
    #[test]
    fn local_listen_addr_only_rejects_empty() {
        for ok in [
            "127.0.0.1",
            "127.8.8.7",
            "::1",
            "localhost",
            "LOCALHOST",
            "0.0.0.0",
            "::",
            "192.168.1.5",
            "8.8.8.8",
            "localhost.",
        ] {
            assert!(validate_local_listen_addr(ok).is_ok(), "{ok} 应放行");
        }
        for bad in ["", "   ", "\t"] {
            assert!(validate_local_listen_addr(bad).is_err(), "{bad:?} 应拒绝");
        }
    }
}
