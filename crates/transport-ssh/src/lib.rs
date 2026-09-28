
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
        };
        let handle = russh::client::connect(
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
            AuthType::Password | AuthType::KeyboardInteractive => handle
                .authenticate_password(&self.target.username, &self.target.secret)
                .await
                .map_err(|e| Error::AuthFailed)?,
            AuthType::Key => {
                let key = decode_secret_key(&self.target.secret, None)
                    .map_err(|_| Error::AuthFailed)?;
                let with_hash = PrivateKeyWithHashAlg::new(Arc::new(key), None);
                handle
                    .authenticate_publickey(&self.target.username, with_hash)
                    .await
                    .map_err(|e| Error::AuthFailed)?
            }
        };
        if !auth.success() {
            return Err(Error::AuthFailed);
        }

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
