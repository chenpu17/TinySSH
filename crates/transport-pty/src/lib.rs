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

/// 共享写端：读循环（DSR 兜底应答）与 write_bytes（用户键入）同用一个 writer。
/// std Mutex——两处都是短暂持锁、无 await 跨越。
type PtyWriter = Arc<std::sync::Mutex<Box<dyn std::io::Write + Send>>>;

pub struct LocalPtyChannel {
    writer: Mutex<Option<PtyWriter>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    output_tx: broadcast::Sender<Vec<u8>>,
    alive: Arc<AtomicBool>,
    size: Mutex<(u16, u16)>,
    /// 集成注入临时目录（respawn 时更换；调用方可取用做延迟清理）。
    tmp: std::sync::Mutex<Option<std::path::PathBuf>>,
    /// 启动期集成注入是否成功（bash/zsh/fish/powershell·pwsh 判型命中即 true；
    /// respawn 时随新 shell 重估）。这是**先验**：标记回流与否由屏幕观测。
    pub integration: AtomicBool,
}

/// 选出用户 shell 并生成集成注入的启动方式。
pub enum ShellSpawn {
    /// bash --rcfile <tmp>
    Bash {
        program: String,
        rcfile: std::path::PathBuf,
    },
    /// zsh，ZDOTDIR 指向注入目录
    Zsh {
        program: String,
        zdotdir: std::path::PathBuf,
    },
    /// fish -C 'source <tmp>'（-C 在读完配置之后、首个提示符之前执行）
    Fish {
        program: String,
        init: std::path::PathBuf,
    },
    /// powershell/pwsh：-NoExit -Command ". <tmp>"（配置之后执行，包装 prompt 与 PSReadLine 读行钩子）
    PowerShell {
        program: String,
        script: std::path::PathBuf,
    },
    /// 直接启动（无集成注入；Shell 模式由 run_shell 入口如实拒绝，不静默降级：
    /// 通路先验 shell_integration_hint=false 让 core 立即给出原因，见 session-api）
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

/// fish 集成片段：**只注册事件钩子**（不包装 fish_prompt 函数，也不清屏）。
/// 钩子是附加的——用户/主题随后定义的 prompt 函数不会被我们截断；A/B 在提示符
/// 渲染前连发（渲染文本属 shell 输出，人类键入的字节仍落在 B 之后，块语义不受影响）。
/// `fish_prompt` 事件在提示符显示前触发、`fish_preexec` 只在真有命令要执行时触发
///（空行回车无事件 → 不产生空块），与 bash 侧 PROMPT_COMMAND/PS0 同口径。
pub fn shell_integration_fish() -> String {
    // \e / \a 由 fish 的 printf 内建解释（POSIX 语义）；状态码必须先存（printf 自身会刷新 $status）
    r#"
if not set -q __tinyssh_integration
  set -g __tinyssh_integration 1
  function __tinyssh_prompt --on-event fish_prompt
    set -l __tinyssh_rc $status
    set -l __tinyssh_p (string replace -a \\ / -- $PWD)
    if string match -q -r '^[A-Za-z]:' -- $__tinyssh_p
      set __tinyssh_p "/$__tinyssh_p"
    end
    printf '\e]7;file://%s\a' $__tinyssh_p
    printf '\e]133;D;%d\a' $__tinyssh_rc
    printf '\e]133;A\a'
    printf '\e]133;B\a'
  end
  function __tinyssh_preexec --on-event fish_preexec
    printf '\e]133;C\a'
  end
end
"#
    .to_string()
}

/// PowerShell 集成片段（powershell.exe 5.1 与 pwsh 7+ 同一份）：
/// - 包装 `prompt`：退出码必须在调原 prompt **之前**取（原 prompt 自身会改写 `$?`），
///   随后 D 退出码 → A 提示符开始 → 原 prompt 正文 → B 键入开始（把用户自己的提示符
///   夹在 A/B 之间，视觉与归属都不变）；
/// - 包装 PSReadLine 的 `PSConsoleHostReadLine`：读到非空行 → C 输出开始。钩子在
///   首个 `prompt` 调用时挂（PSReadLine 正是那个调用方，此刻必然已加载；未就绪则
///   每次提示符重试）。缺 PSReadLine 时**不伪造** C：Shell 模式 exec 走受管块不依赖 C，
///   人类键入不成块——如实降级。
/// 退出码映射：成功 0；失败优先原生命令退出码（`$LASTEXITCODE`），否则 1。PS 不暴露
///「上一条是否原生命令」，cmdlet 失败后残留的旧 `$LASTEXITCODE` 会被误读——如实接受，
/// 且**不改动** `$LASTEXITCODE`（用户可见语义，宁可自身读数偏差也不动用户环境）。
pub fn shell_integration_powershell() -> String {
    // 注意 $esc/$bel 必须放在 $? 读取之后：PowerShell 的赋值语句本身会把 $?
    // 置 true（实测 2026-10-19：cmd /c exit 7 后执行 $y=2 再读 $? 得 True）——先读后用。
    r#"
$global:__tinyssh_orig_prompt = $function:prompt
function global:prompt {
  $__tinyssh_rc = if ($?) { 0 } elseif ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } else { 1 }
  $esc = [char]27; $bel = [char]7
  $__tinyssh_body = ''
  if ($null -ne $global:__tinyssh_orig_prompt) { $__tinyssh_body = ((& $global:__tinyssh_orig_prompt) -join '') }
  $__tinyssh_cwd = ''
  if ($PWD.Provider.Name -eq 'FileSystem') {
    $__tinyssh_p = ([string]$PWD.Path).Replace('\', '/')
    if ($__tinyssh_p -match '^[A-Za-z]:') { $__tinyssh_p = "/$__tinyssh_p" }
    $__tinyssh_cwd = "$esc]7;file://$__tinyssh_p$bel"
  }
  if (-not $global:__tinyssh_readline_hook -and $null -ne $function:PSConsoleHostReadLine) {
    $global:__tinyssh_readline_hook = $true
    $global:__tinyssh_orig_readline = $function:PSConsoleHostReadLine
    function global:PSConsoleHostReadLine {
      $__tinyssh_line = & $global:__tinyssh_orig_readline
      if ($null -ne $__tinyssh_line -and "$__tinyssh_line".Trim().Length -gt 0) {
        [Console]::Write("$([char]27)]133;C$([char]7)")
      }
      return $__tinyssh_line
    }
  }
  "$esc]133;D;$__tinyssh_rc$bel$esc]133;A$bel$__tinyssh_cwd$__tinyssh_body$esc]133;B$bel"
}
"#
    .to_string()
}

fn dirs_or_home() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/"))
}

/// 注入脚本路径的可移植写法：Windows 路径统一正斜杠——fish 的单引号里反斜杠是
/// 转义前缀、PowerShell 的 `-Command` 会二次解析，正斜杠两种 shell 都照字面吃。
fn script_path(p: &std::path::Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// PowerShell 单引号字符串字面量（内部的 `'` 翻倍转义）。
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// fish 单引号字符串字面量（内部的 `'` 与 `\` 加反斜杠转义；路径已转正斜杠）。
fn fish_quote(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// 构造 shell 启动方式（写入注入文件；调用方负责清理临时目录）。
/// 判型表：bash / zsh / fish / powershell·pwsh（含 pwsh-preview）→ 注入集成；
/// 其余（cmd、WSL 的 wsl.exe、dash/ksh 等无 preexec 钩子的 shell）→ Plain，
/// 由通路先验 shell_integration_hint=false 让 core 立即如实拒绝 Shell 模式。
pub fn plan_shell_spawn(shell: &str, tmpdir: &std::path::Path) -> ShellSpawn {
    // Windows 上 SHELL 常是反斜杠 + .exe 形态（C:\Program Files\Git\bin\bash.exe），
    // POSIX 式 rsplit('/') 取不到文件名 → 全体误入 Plain、Shell 模式静默失效
    //（ConPTY 实测透传 OSC133，2026-10-12 探针：注入/透传/发射均正常，唯此判型断链）。
    // 大小写一并归一：Windows 文件名不区分大小写（BASH.EXE 同样是 bash）。
    let basename = shell
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(shell)
        .to_ascii_lowercase();
    let base = basename.strip_suffix(".exe").unwrap_or(&basename);
    match base {
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
        "fish" => {
            let init = tmpdir.join("integration.fish");
            std::fs::write(&init, shell_integration_fish()).ok();
            ShellSpawn::Fish {
                program: shell.to_string(),
                init,
            }
        }
        // pwsh-preview（预览版官方名）、powershell_ise 走不了（非控制台宿主）故不入表
        b if b == "powershell" || b.starts_with("pwsh") => {
            let script = tmpdir.join("integration.ps1");
            std::fs::write(&script, shell_integration_powershell()).ok();
            ShellSpawn::PowerShell {
                program: shell.to_string(),
                script,
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
        tmp: std::sync::Mutex::new(None),
        integration: AtomicBool::new(false),
    });
    channel.respawn().await?;
    let cleanup = channel.tmp.lock().unwrap().clone();
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
        // Windows 实验性分支：SHELL 未设时回退 powershell（unix 路径原样保留）。
        #[cfg(unix)]
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        #[cfg(windows)]
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "powershell.exe".to_string());
        let tmp = tempfile_dir();
        let plan = plan_shell_spawn(&shell, &tmp);

        let program = match &plan {
            ShellSpawn::Bash { program, .. } => program.clone(),
            ShellSpawn::Zsh { program, .. } => program.clone(),
            ShellSpawn::Fish { program, .. } => program.clone(),
            ShellSpawn::PowerShell { program, .. } => program.clone(),
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
            ShellSpawn::Fish { init, .. } => {
                cmd.arg("-i");
                cmd.arg("-C");
                cmd.arg(format!("source {}", fish_quote(&script_path(init))));
            }
            ShellSpawn::PowerShell { script, .. } => {
                // -NoExit：跑完注入脚本后留在交互会话（-Command 会二次解析，脚本路径单引号包）
                cmd.arg("-NoExit");
                cmd.arg("-Command");
                cmd.arg(format!(". {}", ps_quote(&script_path(script))));
            }
            ShellSpawn::Plain { .. } => {
                // `-i` 是 POSIX shell 交互标志，powershell 不接受
                #[cfg(unix)]
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
        let writer: PtyWriter = Arc::new(std::sync::Mutex::new(writer));

        *self.writer.lock().await = Some(writer.clone());
        *self.master.lock().await = Some(pair.master);
        *self.child.lock().await = Some(child);
        // 换新注入目录前清掉旧目录（审计 R7：respawn 曾直接弃置旧目录，
        // 每次本地重连泄漏一个含用户 .bashrc 全文的临时目录）
        if let Some(old) = self.tmp.lock().unwrap().replace(tmp) {
            let _ = std::fs::remove_dir_all(old);
        }
        self.integration
            .store(!matches!(plan, ShellSpawn::Plain { .. }), Ordering::SeqCst);
        self.alive.store(true, Ordering::SeqCst);

        // 读循环：阻塞读 → 同一 broadcast。
        // ConPTY 启动握手（Windows 实测，2026-10-11）：conhost 向客户端发 DSR 光标查询
        // （\x1b[6n）并**阻塞等应答才放行首屏**——不应答则 PowerShell/bash 提示符永久
        // 不来（复现：39s 零输出直至进程被杀；应答 \e[1;1R 后 10ms 内全量输出）。
        // xterm 的 DSR 应答依赖 UI attach 时序（6n 常在 xterm 存在前到达），必须由
        // 传输层兜底：读到 6n 立即以 1;1 应答 CPR。6n 照常转发 UI（xterm 后续应答
        // 双份无害，Windows Terminal 同款做法）。
        let tx = self.output_tx.clone();
        let alive_r = self.alive.clone();
        tokio::task::spawn_blocking(move || {
            let mut reader = reader;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if buf[..n].windows(4).any(|w| w == b"\x1b[6n") {
                            if let Ok(mut w) = writer.lock() {
                                let _ = w.write_all(b"\x1b[1;1R");
                                let _ = w.flush();
                            }
                        }
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
        let w = self
            .writer
            .lock()
            .await
            .as_ref()
            .ok_or(Error::SessionClosed)?
            .clone();
        let mut w = w.lock().unwrap();
        w.write_all(data)
            .and_then(|_| w.flush())
            .map_err(|e| Error::Io(format!("pty write: {e}")))
    }
}

impl Drop for LocalPtyChannel {
    fn drop(&mut self) {
        // 会话销毁收尾：注入临时目录（bashrc 分片含用户 shell 配置全文）不残留。
        // spawn_local_pty 返回的 cleanup 句柄仅是延迟清理的备用口，这里是兜底。
        if let Some(tmp) = self.tmp.lock().unwrap().take() {
            let _ = std::fs::remove_dir_all(tmp);
        }
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
        // Windows 实验性分支：SHELL 未设时回退 powershell（unix 路径原样保留）。
        #[cfg(unix)]
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        #[cfg(windows)]
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "powershell.exe".to_string());
        let mut command = tokio::process::Command::new(&shell);
        #[cfg(unix)]
        command.arg("-c").arg(cmd);
        #[cfg(windows)]
        // Windows 下 SHELL 可能被启动环境改写（Git Bash 里 SHELL=/usr/bin/bash）——
        // 按选定 shell 族给参：powershell 系 -NoProfile -Command，cmd 系 /c，bash 系 -c。
        // 曾犯的错：shell 选择 SHELL 感知、参数写死 powershell → bash 报 "-N: invalid option"；
        // cmd 族此前漏配（落到 -c）：cmd 不认 -c，只会打横幅后退出——cmd 本机会话
        // Shell 模式被门拒后 Fresh 是唯一通路，必须可用（P1 扩面同轮补齐）。
        let family = {
            let s = shell.to_ascii_lowercase();
            let base = s.rsplit(['/', '\\']).next().unwrap_or(&s);
            let base = base.strip_suffix(".exe").unwrap_or(base);
            if base.contains("powershell") || base.contains("pwsh") {
                2
            } else if base == "cmd" {
                1
            } else {
                0
            }
        };
        if family == 2 {
            command.arg("-NoProfile").arg("-Command").arg(cmd);
        } else if family == 1 {
            command.arg("/c").arg(cmd);
        } else {
            command.arg("-c").arg(cmd);
        }
        for (k, v) in &opts.env {
            command.env(k, v);
        }
        command.stdout(std::process::Stdio::piped());
        command.stderr(std::process::Stdio::piped());
        command.stdin(std::process::Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|e| Error::Io(format!("spawn fresh: {e}")))?;

        let out = child
            .stdout
            .take()
            .ok_or_else(|| Error::Io("fresh stdout missing".into()))?;
        let err = child
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

        // 读泵与等待**解耦**（审计 R1，2026-10-12）：原先 join!(读,读) 排在 select
        // 之前——「无输出且不退出」的命令（sleep 3600）读端永不 EOF，join 永不返回，
        // 其后的 deadline/cancel 分支不可达：exec 永久挂死、取消失效、exec_slot 被
        // 占满后全队列 QueueBusy（SSH 版 select 包住 wait，无此问题）。改为读任务
        // 后台排空（保留「继续读防子进程阻塞」语义），select 出局后 kill 子进程 →
        // 管道 EOF → 读任务自然收尾，部分输出照常回收。
        let out_task = tokio::spawn(read_limited(out, cap));
        let err_task = tokio::spawn(read_limited(err, cap));
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
        // 极端路径（孙进程继承管道持有写端）下 kill 后读端仍可能不 EOF：限时收编，
        // 超时放弃收集（子进程已死，结果如实标注未完成）。join! 产出元组非 Future，
        // 包一层 async 块才能进 timeout。
        let (out_res, err_res) =
            match tokio::time::timeout(std::time::Duration::from_secs(5), async {
                tokio::join!(out_task, err_task)
            })
            .await
            {
                Ok((o, e)) => (
                    o.unwrap_or((Vec::new(), false)),
                    e.unwrap_or((Vec::new(), false)),
                ),
                Err(_) => ((Vec::new(), false), (Vec::new(), false)),
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

    /// C3 扩面（P1 终端轮）：本地通路对 shell 集成有**先验**——构造期就知道判型
    /// 结果（rcfile/ZDOTDIR/-C/脚本四种注入），远端通路没有（注入由 host_setting
    /// 决定且只看回流标记）。
    fn shell_integration_hint(&self) -> Option<bool> {
        Some(self.integration.load(Ordering::SeqCst))
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
            let md = (e.metadata().await).ok();
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

#[cfg(test)]
mod plan_tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        tempfile_dir()
    }

    /// 判型表（P1 shell 集成扩面）：四种注入族 + 大小写/`.exe` 归一 + 未知族 Plain。
    #[test]
    fn shell_family_detection() {
        let d = tmp();
        // bash：POSIX 形态与 Git for Windows 的 Windows 形态（含大写 .EXE）都命中，
        // rcfile 落在临时目录且带注入片段
        for s in [
            "/bin/bash",
            "C:\\Program Files\\Git\\bin\\bash.exe",
            "BASH.EXE",
        ] {
            match plan_shell_spawn(s, &d) {
                ShellSpawn::Bash { rcfile, .. } => {
                    let body = std::fs::read_to_string(&rcfile).unwrap();
                    assert!(body.contains("__tinyssh_prompt"), "{s}: rcfile 缺注入片段");
                }
                other => panic!("{s} 应判为 Bash，得 {}", kind_of(&other)),
            }
        }
        // zsh
        match plan_shell_spawn("/usr/bin/zsh", &d) {
            ShellSpawn::Zsh { zdotdir, .. } => {
                let body = std::fs::read_to_string(zdotdir.join(".zshrc")).unwrap();
                assert!(body.contains("__tinyssh_precmd"));
            }
            other => panic!("zsh 应判为 Zsh，得 {}", kind_of(&other)),
        }
        // fish：-C 注入片段含 fish_prompt/fish_preexec 事件钩子与 C 标记
        for s in ["/usr/bin/fish", "C:\\tools\\fish\\fish.exe"] {
            match plan_shell_spawn(s, &d) {
                ShellSpawn::Fish { init, .. } => {
                    let body = std::fs::read_to_string(&init).unwrap();
                    assert!(
                        body.contains("--on-event fish_prompt"),
                        "{s}: 缺 prompt 钩子"
                    );
                    assert!(
                        body.contains("--on-event fish_preexec"),
                        "{s}: 缺 preexec 钩子"
                    );
                    assert!(body.contains("133;C"), "{s}: 缺 C 标记");
                }
                other => panic!("{s} 应判为 Fish，得 {}", kind_of(&other)),
            }
        }
        // powershell / pwsh / pwsh-preview
        for s in [
            "powershell.exe",
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
            "pwsh-preview.exe",
        ] {
            match plan_shell_spawn(s, &d) {
                ShellSpawn::PowerShell { script, .. } => {
                    let body = std::fs::read_to_string(&script).unwrap();
                    assert!(body.contains("PSConsoleHostReadLine"), "{s}: 缺读行钩子");
                    assert!(body.contains("133;D;"), "{s}: 缺 D 标记");
                }
                other => panic!("{s} 应判为 PowerShell，得 {}", kind_of(&other)),
            }
        }
        // 未支持族：Plain（core 侧靠 shell_integration_hint=false 立即如实拒绝）
        for s in [
            "cmd.exe",
            "C:\\Windows\\System32\\wsl.exe",
            "/bin/dash",
            "ksh",
        ] {
            match plan_shell_spawn(s, &d) {
                ShellSpawn::Plain { program } => assert_eq!(program, s),
                other => panic!("{s} 应判为 Plain，得 {}", kind_of(&other)),
            }
        }
    }

    /// 启动参数与注入文件路径的引号/斜杠约定（Windows 路径统一正斜杠）。
    #[test]
    fn launch_args_and_paths() {
        // PowerShell：-Command 走二次解析，脚本路径单引号包裹、反斜杠转正斜杠
        let d = tmp();
        match plan_shell_spawn("pwsh.exe", &d) {
            ShellSpawn::PowerShell { script, .. } => {
                let arg = format!(". {}", ps_quote(&script_path(&script)));
                assert!(arg.starts_with(". '"), "{arg}");
                assert!(!arg.contains('\\'), "路径应转正斜杠：{arg}");
                assert!(arg.ends_with("integration.ps1'"), "{arg}");
            }
            other => panic!("pwsh 应判为 PowerShell，得 {}", kind_of(&other)),
        }
        // fish：source 单引号 + 反斜杠转义（路径无单引号时不含反斜杠）
        let d2 = tmp();
        match plan_shell_spawn("fish", &d2) {
            ShellSpawn::Fish { init, .. } => {
                let arg = format!("source {}", fish_quote(&script_path(&init)));
                assert!(arg.starts_with("source '"), "{arg}");
                assert!(!arg.contains('\\'), "路径应转正斜杠：{arg}");
            }
            other => panic!("fish 应判为 Fish，得 {}", kind_of(&other)),
        }
        // 单引号转义：PowerShell 翻倍、fish 加反斜杠
        assert_eq!(ps_quote("a'b"), "'a''b'");
        assert_eq!(fish_quote("a'\\b"), "'a\\'\\\\b'");
    }

    fn kind_of(p: &ShellSpawn) -> &'static str {
        match p {
            ShellSpawn::Bash { .. } => "Bash",
            ShellSpawn::Zsh { .. } => "Zsh",
            ShellSpawn::Fish { .. } => "Fish",
            ShellSpawn::PowerShell { .. } => "PowerShell",
            ShellSpawn::Plain { .. } => "Plain",
        }
    }
}
