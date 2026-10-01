
//! SSH 通路（russh 0.63）：持久 shell channel（PTY）+ 同连接 Fresh exec channel + SFTP。
//! 主机指纹 TOFU 记录；断线检测 + 重连；shell 集成由 core 在会话建立后注入。

use async_trait::async_trait;
use russh::client::{self, Handle};
use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg};
use russh::{Channel, ChannelMsg, ChannelWriteHalf};
use russh::{Disconnect, Sig};
use session_api::transport::tokio_util_sync::CancellationToken;
use session_api::transport::{ChannelHandle, FreshOutcome, TransportSignal};
use session_api::{AuthType, Error, ExecOpts, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{broadcast, Mutex};

/// TOFU 主机指纹回调：异步（人类确认可能跨秒级等待）。None = 全接受（测试专用）。
pub type HostKeyCheck = Arc<
    dyn Fn(&str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool>> + Send>>
        + Send
        + Sync,
>;

/// 2FA 人工应答门（路线图⑩）：keyboard-interactive 非密码类提示交人类应答。
/// Ok(None) = 人类取消/通道不可用（认证终止）。None 门 = 遇到非密码提示即失败。
pub type KbPromptCheck = Arc<
    dyn Fn(&str, bool) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<String>>> + Send>>
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

impl SshChannel {
    pub async fn connect(target: SshTarget, cols: u16, rows: u16) -> Result<Arc<Self>> {
        let seen = Arc::new(Mutex::new(None::<String>));
        let (output_tx, _) = broadcast::channel(4096);
        let alive = Arc::new(AtomicBool::new(true));

        let chan = Arc::new(Self {
            handle: Mutex::new(None),
            shell: Mutex::new(None),
            output_tx,
            alive,
            size: Mutex::new((cols, rows)),
            seen_fingerprint: seen.clone(),
            target,
        });
        chan.establish().await?;
        Ok(chan)
    }

    /// 连接 + 认证 + 打开持久 shell（PTY）。
    async fn establish(&self) -> Result<()> {
        let handler = ClientHandler {
            host_key_check: self.target.host_key_check.clone(),
            seen_fingerprint: self.seen_fingerprint.clone(),
        };        let handle = russh::client::connect(
            ssh_config(),
            (self.target.address.as_str(), self.target.port),
            handler,
        )
        .await
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
                    .map_err(|e| Error::AuthFailed)?;
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
                let key = decode_secret_key(&self.target.secret, None)
                    .map_err(|_| Error::AuthFailed)?;
                let with_hash = PrivateKeyWithHashAlg::new(Arc::new(key), None);
                handle
                    .authenticate_publickey(&self.target.username, with_hash)
                    .await
                    .map_err(|e| Error::AuthFailed)?
            }
            AuthType::Agent => {
                // 私钥不出 agent：逐个尝试 agent 中已加载的密钥（ssh 标准行为）
                use russh::keys::agent::client::AgentClient;
                let mut agent = AgentClient::connect_env()
                    .await
                    .map_err(|e| Error::ConnectFailed(format!(
                        "ssh-agent 不可达（检查 SSH_AUTH_SOCK）: {e}"
                    )))?;
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
        Ok(())
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
                        let is_pw = !p.echo && (text.contains("password") || p.prompt.contains("密码"));
                        let ans = if is_pw {
                            self.target.secret.clone()
                        } else {
                            match &self.target.kb_prompt_check {
                                Some(gate) => gate(&p.prompt, p.echo)
                                    .await?
                                    .ok_or_else(|| {
                                        Error::ConnectFailed(
                                            "服务器要求额外交互认证（2FA），人工应答被取消".into(),
                                        )
                                    })?,
                                None => return Err(Error::ConnectFailed(
                                    "服务器要求额外交互认证（2FA），但本连接未启用人工应答通道".into(),
                                )),
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
        let handle_guard = self.handle.lock().await;
        let handle = handle_guard.as_ref().ok_or(Error::SessionClosed)?;
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| Error::ConnectFailed(format!("fresh channel: {e}")))?;

        // env 注入：env K=V ... sh -c '<cmd>'
        // （直接 `env K=V cmd` 会让外层 shell 先展开 cmd 里的 $VAR，注入无效）
        let mut full = String::new();
        if !opts.env.is_empty() {
            full.push_str("env");
            for (k, v) in &opts.env {
                full.push_str(&format!(" {k}={v}"));
            }
            let quoted = cmd.replace("'", "'\\''");
            full.push_str(&format!(" sh -c '{quoted}'"));
        } else {
            full.push_str(cmd);
        }
        channel
            .exec(true, full.as_bytes())
            .await
            .map_err(|e| Error::ConnectFailed(format!("exec: {e}")))?;

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
            let _ = old.disconnect(Disconnect::ByApplication, "reconnect", "EN").await;
        }
        self.alive.store(true, Ordering::SeqCst);
        self.establish().await
    }

    async fn close(&self) -> Result<()> {
        self.alive.store(false, Ordering::SeqCst);
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
    ) -> Result<u64> {
        let handle_guard = self.handle.lock().await;
        let handle = handle_guard.as_ref().ok_or(Error::SessionClosed)?;
        let mut channel = handle
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

        let mut file = sftp
            .create(remote)
            .await
            .map_err(|e| Error::Io(format!("sftp create {remote}: {e}")))?;
        let mut src = tokio::fs::File::open(local)
            .await
            .map_err(|e| Error::Io(format!("open {}: {e}", local.display())))?;
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
    ) -> Result<u64> {
        let handle_guard = self.handle.lock().await;
        let handle = handle_guard.as_ref().ok_or(Error::SessionClosed)?;
        let mut channel = handle
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

        let mut file = sftp
            .open(remote)
            .await
            .map_err(|e| Error::Io(format!("sftp open {remote}: {e}")))?;
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
        }
        drop(dst);
        sftp.close().await.ok();
        Ok(total)
    }
}
