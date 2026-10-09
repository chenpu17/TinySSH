//! 本地 PTY 通路（portable-pty）：
//! - 持久交互 shell：用户 shell + OSC 133 shell 集成注入（bash rcfile / zsh ZDOTDIR）；
//! - Fresh 执行：隐藏子进程 `$SHELL -c`（真实退出码，不注入交互 PTY）；
//! - 上传/下载：本地拷贝。

use async_trait::async_trait;
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use session_api::transport::tokio_util_sync::CancellationToken;
use session_api::transport::{ChannelHandle, FreshOutcome, TransportSignal};
use session_api::{Error, ExecOpts, Result};
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{broadcast, Mutex};

pub struct LocalPtyChannel {
    writer: Mutex<Option<Box<dyn std::io::Write + Send>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    output_tx: broadcast::Sender<Vec<u8>>,
    alive: Arc<AtomicBool>,
    size: Mutex<(u16, u16)>,
    /// 集成注入临时目录（respawn 时更换；调用方可取用做延迟清理）。
    tmp: Mutex<Option<std::path::PathBuf>>,
    /// shell 集成是否注入成功（决定 Shell 模式可用性；respawn 时随新 shell 重估）。
    pub integration: AtomicBool,
}

/// 选出用户 shell 并生成集成注入的启动方式。
pub enum ShellSpawn {
    /// bash --rcfile <tmp>
    Bash { program: String, rcfile: std::path::PathBuf },
    /// zsh，ZDOTDIR 指向注入目录
    Zsh { program: String, zdotdir: std::path::PathBuf },
    /// 直接启动（无集成注入；Shell 模式将不可用，自动降级 Fresh）
    Plain { program: String },
}

pub fn shell_integration_bash() -> String {
    r#"
__tinyssh_prompt() {
  __rc=$?
  printf '\033]7;file://%s%s\007' "$HOSTNAME" "$PWD"
  printf '\033]133;D;%s\007' "$__rc"
  printf '\033]133;A\007'
}
__tinyssh_preexec() { printf '\033]133;C\007'; }
PROMPT_COMMAND="__tinyssh_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
PS1="\[\033]133;B\007\]$PS1"
PS0="\[\033]133;C\007\]$PS0"
"#
    .to_string()
}

pub fn shell_integration_zsh() -> String {
    r#"
autoload -Uz add-zsh-hook
__tinyssh_precmd() {
  __rc=$?
  printf '\033]7;file://%s%s\007' "$HOST" "$PWD"
  printf '\033]133;D;%s\007' "$__rc"
  printf '\033]133;A\007'
  printf '\033]133;B\007'
}
__tinyssh_preexec() { printf '\033]133;C\007'; }
add-zsh-hook precmd __tinyssh_precmd
add-zsh-hook preexec __tinyssh_preexec
"#
    .to_string()
}

fn dirs_or_home() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/"))
}

/// 构造 shell 启动方式（写入注入文件；调用方负责清理临时目录）。
pub fn plan_shell_spawn(shell: &str, tmpdir: &std::path::Path) -> ShellSpawn {
    let basename = shell.rsplit('/').next().unwrap_or(shell);
    match basename {
        "bash" => {
            let rc = tmpdir.join("bashrc");
            let existing =
                std::fs::read_to_string(dirs_or_home().join(".bashrc")).unwrap_or_default();
            std::fs::write(&rc, format!("{}{}", existing, shell_integration_bash())).ok();
            ShellSpawn::Bash {
                program: shell.to_string(),
                rcfile: rc,
            }
        }
        "zsh" => {
            let zdot = tmpdir.join("zdotdir");
            std::fs::create_dir_all(&zdot).ok();
            let existing =
                std::fs::read_to_string(dirs_or_home().join(".zshrc")).unwrap_or_default();
            std::fs::write(
                zdot.join(".zshrc"),
                format!("{}\n{}", existing, shell_integration_zsh()),
            )
            .ok();
            ShellSpawn::Zsh {
                program: shell.to_string(),
                zdotdir: zdot,
            }
        }
        _ => ShellSpawn::Plain {
            program: shell.to_string(),
        },
    }
}

fn tempfile_dir() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("tinyssh-pty-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).ok();
    d
}

/// 启动本地持久 shell PTY。返回通路与需要延迟清理的临时目录。
pub async fn spawn_local_pty(
    cols: u16,
    rows: u16,
) -> Result<(Arc<LocalPtyChannel>, Option<std::path::PathBuf>)> {
    let (output_tx, _) = broadcast::channel(4096);
    let channel = Arc::new(LocalPtyChannel {
        writer: Mutex::new(None),
        master: Mutex::new(None),
        child: Mutex::new(None),
        output_tx,
        alive: Arc::new(AtomicBool::new(true)),
        size: Mutex::new((cols, rows)),
        tmp: Mutex::new(None),
        integration: AtomicBool::new(false),
    });
    channel.respawn().await?;
    let cleanup = channel.tmp.lock().await.clone();
    Ok((channel, cleanup))
}

impl LocalPtyChannel {
    /// 启动（或重连时重启）持久 shell：新 PTY + 新 shell 进程 + 新读循环。
    /// 输出并入同一 broadcast——重连后泵与 UI 的既有订阅无需更换。
    /// 断线后旧 shell 已随 PTY 关闭退出，writer/master/child 全部换新。
    async fn respawn(&self) -> Result<()> {
        if let Some(mut old) = self.child.lock().await.take() {
            let _ = old.kill();
        }
        let pty_system = NativePtySystem::default();
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let tmp = tempfile_dir();
        let plan = plan_shell_spawn(&shell, &tmp);

        let program = match &plan {
            ShellSpawn::Bash { program, .. } => program.clone(),
            ShellSpawn::Zsh { program, .. } => program.clone(),
            ShellSpawn::Plain { program } => program.clone(),
        };
        let mut cmd = CommandBuilder::new(program.as_str());
        match &plan {
            ShellSpawn::Bash { rcfile, .. } => {
                cmd.arg("--rcfile");
                cmd.arg(rcfile);
                cmd.arg("-i");
            }
            ShellSpawn::Zsh { zdotdir, .. } => {
                cmd.env("ZDOTDIR", zdotdir);
            }
            ShellSpawn::Plain { .. } => {
                cmd.arg("-i");
            }
        }
        cmd.env("TERM", "xterm-256color");

        let (cols, rows) = *self.size.lock().await;
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| Error::Io(format!("openpty: {e}")))?;
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| Error::Io(format!("spawn shell: {e}")))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| Error::Io(format!("clone reader: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| Error::Io(format!("take writer: {e}")))?;

        *self.writer.lock().await = Some(writer);
        *self.master.lock().await = Some(pair.master);
        *self.child.lock().await = Some(child);
        *self.tmp.lock().await = Some(tmp);
        self.integration
            .store(!matches!(plan, ShellSpawn::Plain { .. }), Ordering::SeqCst);
        self.alive.store(true, Ordering::SeqCst);

        // 读循环：阻塞读 → 同一 broadcast
        let tx = self.output_tx.clone();
        let alive_r = self.alive.clone();
        tokio::task::spawn_blocking(move || {
            let mut reader = reader;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            alive_r.store(false, Ordering::SeqCst);
        });
        Ok(())
    }

    async fn write_bytes(&self, data: &[u8]) -> Result<()> {
        let mut guard = self.writer.lock().await;
        let w = guard.as_mut().ok_or(Error::SessionClosed)?;
        w.write_all(data)
            .and_then(|_| w.flush())
            .map_err(|e| Error::Io(format!("pty write: {e}")))
    }
}

#[async_trait]
impl ChannelHandle for LocalPtyChannel {
    async fn write(&self, data: &[u8]) -> Result<()> {
        self.write_bytes(data).await
    }

    async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        *self.size.lock().await = (cols, rows);
        if let Some(master) = self.master.lock().await.as_ref() {
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
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
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let mut command = tokio::process::Command::new(&shell);
        command.arg("-c").arg(cmd);
        for (k, v) in &opts.env {
            command.env(k, v);
        }
        command.stdout(std::process::Stdio::piped());
        command.stderr(std::process::Stdio::piped());
        command.stdin(std::process::Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|e| Error::Io(format!("spawn fresh: {e}")))?;

        let mut out = child
            .stdout
            .take()
            .ok_or_else(|| Error::Io("fresh stdout missing".into()))?;
        let mut err = child
            .stderr
            .take()
            .ok_or_else(|| Error::Io("fresh stderr missing".into()))?;
        let cap = opts.output_cap.unwrap_or(session_api::DEFAULT_OUTPUT_CAP);

        async fn read_limited<R: AsyncReadExt + Unpin>(
            mut stream: R,
            cap: usize,
        ) -> (Vec<u8>, bool) {
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 8192];
            let mut truncated = false;
            loop {
                match stream.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if buf.len() + n <= cap {
                            buf.extend_from_slice(&chunk[..n]);
                        } else {
                            let take = cap.saturating_sub(buf.len());
                            buf.extend_from_slice(&chunk[..take]);
                            truncated = true;
                            // 继续排空防止子进程阻塞；内容丢弃
                        }
                    }
                }
            }
            (buf, truncated)
        }

        let (out_res, err_res) = tokio::join!(read_limited(out, cap), read_limited(err, cap));
        let status = tokio::select! {
            s = child.wait() => Some(s.map_err(|e| Error::Io(format!("wait: {e}")))?),
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                None
            }
            _ = cancel.cancelled() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                None
            }
        };

        Ok(FreshOutcome {
            exit_code: status.as_ref().and_then(|s| s.code()),
            stdout: out_res.0,
            stderr: err_res.0,
            truncated: out_res.1 || err_res.1,
            completed: status.is_some(),
        })
    }

    async fn signal(&self, sig: TransportSignal) -> Result<()> {
        match sig {
            TransportSignal::Interrupt => self.write_bytes(&[0x03]).await,
            TransportSignal::Quit => self.write_bytes(&[0x1c]).await,
            // 持久 shell 通路不杀 shell 本体
            TransportSignal::Terminate | TransportSignal::Kill => Ok(()),
        }
    }

    async fn force_close(&self) -> Result<()> {
        self.alive.store(false, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill();
        }
        Ok(())
    }

    fn subscribe_output(&self) -> broadcast::Receiver<Vec<u8>> {
        self.output_tx.subscribe()
    }

    async fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
            && self
                .child
                .lock()
                .await
                .as_mut()
                .map(|c| c.try_wait().map(|s| s.is_none()).unwrap_or(true))
                .unwrap_or(false)
    }

    async fn reconnect(&self) -> Result<()> {
        // 本地会话的「重连」= 重启一个新 shell（旧 shell 进程已随 PTY 退出）
        self.respawn().await
    }

    async fn close(&self) -> Result<()> {
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill();
        }
        self.alive.store(false, Ordering::SeqCst);
        Ok(())
    }

    async fn upload(
        &self,
        local: &std::path::Path,
        remote: &str,
        cancel: &CancellationToken,
        progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<u64> {
        copy_file(local, std::path::Path::new(remote), cancel, progress).await
    }

    async fn download(
        &self,
        remote: &str,
        local: &std::path::Path,
        cancel: &CancellationToken,
        progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<u64> {
        copy_file(std::path::Path::new(remote), local, cancel, progress).await
    }

    /// 本机「远端」= 本地文件系统（T41 FR-7：本机会话的文件浏览器同样可用）。
    /// kind=条目自身类型（symlink_metadata 语义）；size/mtime 未知为 None（§352）。
    async fn list_dir(&self, path: &str) -> Result<Vec<session_api::DirEntryS>> {
        let _ = &self; // 无 PTY 依赖，纯 fs
        let mut rd = tokio::fs::read_dir(path)
            .await
            .map_err(|e| Error::from_fs_err(path, &e))?;
        let mut out = Vec::new();
        while let Some(e) = rd
            .next_entry()
            .await
            .map_err(|e| Error::from_fs_err(path, &e))?
        {
            // 单条目 stat 失败不炸整表（§352：未知字段如实缺省），
            // kind/size/mtime 全 None，名称与类型兜底 is_dir=false
            let md = match e.metadata().await {
                Ok(m) => Some(m),
                Err(_) => None,
            };
            let (kind, is_dir, size, mtime) = match &md {
                Some(m) => {
                    let ft = m.file_type();
                    (
                        Some(if ft.is_dir() {
                            session_api::EntryKind::Dir
                        } else if ft.is_file() {
                            session_api::EntryKind::File
                        } else if ft.is_symlink() {
                            session_api::EntryKind::Symlink
                        } else {
                            session_api::EntryKind::Other
                        }),
                        m.is_dir(),
                        Some(m.len()),
                        m.modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64),
                    )
                }
                None => (None, false, None, None),
            };
            out.push(session_api::DirEntryS {
                name: e.file_name().to_string_lossy().into_owned(),
                is_dir,
                kind,
                size,
                mtime,
            });
        }
        out.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    }

    /// C4（R30）：本地 canonicalize。path=None → 当前工作目录。
    async fn resolve_path(&self, path: Option<&str>) -> Result<session_api::PathResolved> {
        let _ = &self;
        let target = path.unwrap_or(".");
        let canon = tokio::fs::canonicalize(target)
            .await
            .map_err(|e| Error::from_fs_err(target, &e))?;
        Ok(session_api::PathResolved {
            canonical: canon.to_string_lossy().into_owned(),
        })
    }

    /// C4（R30）：本地元数据。kind/symlink_target=lstat；is_dir/size/mtime=跟随。
    async fn stat_entry(&self, path: &str) -> Result<session_api::EntryStat> {
        let _ = &self;
        // 本地语义唯一源（rev-r34 高-1）：与 core-session 下载分支同一实现
        session_api::local_stat_entry(path)
    }

    /// C6/R34 DF6.1：本地原子 no-clobber 发布（std::fs::hard_link）。
    /// 本地 syscall 完成即有确定结果——错误一律 Rejected（含 AlreadyExists
    /// 竞态；链接失败绝不改动目标），无 Ambiguous 形态。
    async fn publish_hardlink(
        &self,
        existing: &str,
        new: &str,
    ) -> Result<session_api::PublishOutcome> {
        let _ = &self;
        Ok(session_api::local_publish_hardlink(existing, new))
    }

    /// C6/R34：本地文件删除（temp 清理；不存在=幂等 Ok）。
    async fn remove_file(&self, path: &str) -> Result<()> {
        let _ = &self;
        session_api::local_remove_file(path)
    }
}

async fn copy_file(
    from: &std::path::Path,
    to: &std::path::Path,
    cancel: &CancellationToken,
    progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
) -> Result<u64> {
    let mut src = tokio::fs::File::open(from)
        .await
        .map_err(|e| Error::Io(format!("open {}: {e}", from.display())))?;
    let total_len = tokio::fs::metadata(from).await.ok().map(|m| m.len());
    if let Some(parent) = to.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| Error::Io(format!("mkdir {}: {e}", parent.display())))?;
    }
    let mut dst = tokio::fs::File::create(to)
        .await
        .map_err(|e| Error::Io(format!("create {}: {e}", to.display())))?;
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
        dst.write_all(&buf[..n])
            .await
            .map_err(|e| Error::Io(format!("write: {e}")))?;
        total += n as u64;
        progress(total, total_len);
    }
    Ok(total)
}
