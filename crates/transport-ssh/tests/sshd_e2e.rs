//! 冒烟（需真实 sshd）：起 docker 容器 scripts/dev-sshd.sh 或手动：
//!   docker run -d --name tinyssh-e2e -p 2222:22 alpine:3.20 ...
//! 门控：TINYSSH_E2E_SSHD=1 才执行。

use std::time::Duration;
use term_core::{Screen, ScreenConfig};

fn sshd_enabled() -> bool {
    std::env::var("TINYSSH_E2E_SSHD").map(|v| v == "1").unwrap_or(false)
}

fn target() -> transport_ssh::SshTarget {
    transport_ssh::SshTarget {
        address: "127.0.0.1".into(),
        port: 2222,
        username: "root".into(),
        auth_type: session_api::AuthType::Password,
        secret: "testpass".into(),
        host_key_check: None, // 测试：全接受（生产走 TOFU 回调）
        kb_prompt_check: None, // 2FA 门：测试直连不用
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_shell_blocks_and_fresh() {
    let _sshd_guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    // 环境抖动兜底（共享容器偶发空流）：整场景最多重试两次
    let mut last_err = String::new();
    for attempt in 0..3 {
        match scenario().await {
            Ok(()) => return,
            Err(e) => {
                last_err = e;
                eprintln!("attempt {attempt} failed: {last_err}; retrying…");
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            }
        }
    }
    panic!("scenario failed twice: {last_err}");
}

async fn scenario() -> Result<(), String> {
    use session_api::transport::ChannelHandle;

    let channel: std::sync::Arc<transport_ssh::SshChannel> =
        transport_ssh::SshChannel::connect(target(), 120, 32)
            .await
            .map_err(|e| e.to_string())?;
    // 首连指纹应已记录（TOFU）
    let _fp_now = channel.fingerprint().await;

    let mut screen = Screen::new(ScreenConfig::default());
    let mut rx = channel.subscribe_output();
    let (tx, rx_feed) = std::sync::mpsc::channel::<Vec<u8>>();
    tokio::task::spawn_blocking(move || loop {
        match rx.blocking_recv() {
            Ok(d) => {
                if tx.send(d).is_err() {
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            Err(_) => continue,
        }
    });
    let mut drain = |screen: &mut Screen, rx_feed: &std::sync::mpsc::Receiver<Vec<u8>>| {
        while let Ok(d) = rx_feed.try_recv() {
            screen.feed(&d);
        }
    };

    // 注入 shell 集成（core-session 在 create_session 后做；此处模拟）
    // bash 容器默认 shell：bash -i via sshd? sshd shell 是 /bin/sh；此处直接写集成命令行
    channel.write(b"export PS1='$ ' ; PS0='\\[\\e]133;C\\a\\]' ; PROMPT_COMMAND='printf \"\\e]7;file://%s%s\\a\" \"$HOSTNAME\" \"$PWD\"; printf \"\\e]133;D;%s\\a\" \"$?\"; printf \"\\e]133;A\\a\"; printf \"\\e]133;B\\a\"'\r").await.unwrap();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        drain(&mut screen, &rx_feed);
        if screen.shell_integration_present() {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("no OSC 133; screen:\n{}", screen.snapshot_text()));
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Shell 模式执行：现场延续验证（cd 后 pwd）
    screen.register_outgoing(b"cd /tmp && echo mark_a\r", term_core::BlockSource::Human);
    channel.write(b"cd /tmp && echo mark_a\r").await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        drain(&mut screen, &rx_feed);
        let closed = screen
            .blocks
            .last_blocks(1)
            .last()
            .map(|b| b.end.is_some())
            .unwrap_or(false);
        if closed {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("block1 not closed:\n{}", screen.snapshot_text()));
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(screen.snapshot_text().contains("mark_a"));
    eprintln!("DEBUG screen:\n{}\nblocks: {:?}", screen.snapshot_text(), screen.blocks.last_blocks(3));
    eprintln!("DEBUG cwd: {:?}", screen.cwd());
    assert!(screen.cwd().map(|c| c.starts_with("/tmp")).unwrap_or(false), "cwd 应为 /tmp（OSC 7）");

    // 第二条命令在同 shell：cwd 延续
    screen.register_outgoing(b"pwd\r", term_core::BlockSource::Human);
    channel.write(b"pwd\r").await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        drain(&mut screen, &rx_feed);
        let count = screen.blocks.last_blocks(2).len();
        let closed2 = screen.blocks.last_blocks(2).last().map(|b| b.end.is_some()).unwrap_or(false);
        if count >= 2 && closed2 {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("block2 not closed:\n{}", screen.snapshot_text()));
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(screen.snapshot_text().contains("/tmp"));

    // Fresh：真实退出码 + 环境注入
    let out = channel
        .exec_fresh(
            "echo fresh_$X; exit 3",
            &session_api::ExecOpts {
                mode: session_api::ExecMode::Fresh,
                env: [("X".to_string(), "42".to_string())].into_iter().collect(),
                ..Default::default()
            },
            std::time::Instant::now() + Duration::from_secs(10),
            &session_api::transport::tokio_util_sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(out.exit_code, Some(3));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "fresh_42");
    assert!(out.completed);

    // SFTP 往返
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("u.txt");
    std::fs::write(&local, b"sftp-roundtrip-data").unwrap();
    let remote = format!("/tmp/{}.txt", std::process::id());
    let n = channel.upload(&local, &remote, &Default::default(), &|_,_|{}).await.unwrap();
    assert_eq!(n, b"sftp-roundtrip-data".len() as u64);
    let back = dir.path().join("d.txt");
    channel.download(&remote, &back, &Default::default(), &|_,_|{}).await.unwrap();
    assert_eq!(std::fs::read(&back).unwrap(), b"sftp-roundtrip-data");

    channel.close().await.unwrap();
    Ok(())
}

use tokio_util_like::CancellationToken as _CancellationTokenAlias;
mod tokio_util_like {
    pub use session_api::transport::tokio_util_sync::CancellationToken;
}

/// T20：下载中途取消——真实 SFTP 传输中触发 CancellationToken，
/// 断言返回 Cancelled 且本地未落完整文件（上传回路对称，同一循环实现）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sftp_download_cancel_midway() {
    let _sshd_guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    use session_api::transport::ChannelHandle;
    use session_api::transport::tokio_util_sync::CancellationToken;

    let channel = transport_ssh::SshChannel::connect(target(), 80, 24)
        .await
        .unwrap();
    // 远端造 256MB（alpine busybox dd；写 tmpfs/容器层均可）
    channel
        .exec_fresh(
            "dd if=/dev/zero of=/tmp/t20_cancel.bin bs=1048576 count=256 2>/dev/null; ls -l /tmp/t20_cancel.bin",
            &session_api::ExecOpts::default(),
            std::time::Instant::now() + Duration::from_secs(30),
            &CancellationToken::new(),
        )
        .await
        .unwrap();

    let cancel = CancellationToken::new();
    let c2 = cancel.clone();
    let ch2 = channel.clone();
    let dir = tempfile::tempdir().unwrap();
    let dst = dir.path().join("partial.bin");
    let dst_check = dst.clone();
    let dl = tokio::spawn(async move {
        ch2
            .download("/tmp/t20_cancel.bin", &dst, &c2, &|_,_|{})
            .await
    });
    // 传输进行中取消（256MB 回环传输 ≈ 0.5–3s，200ms 必然处于中途；
    // 若取消先于 SFTP 初始化完成，同样返回 Cancelled，两条路径都被断言覆盖）
    tokio::time::sleep(Duration::from_millis(200)).await;
    cancel.cancel();
    let r = dl.await.unwrap();
    match r {
        Err(session_api::Error::Cancelled) => {}
        other => panic!("expected Cancelled, got {other:?}"),
    }
    let sz = std::fs::metadata(&dst_check).map(|m| m.len()).unwrap_or(0);
    assert!(sz < 256 * 1024 * 1024, "本地不应有完整文件：{sz}");

    channel
        .exec_fresh(
            "rm -f /tmp/t20_cancel.bin",
            &session_api::ExecOpts::default(),
            std::time::Instant::now() + Duration::from_secs(10),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    channel.close().await.unwrap();
}

/// T41（FR-7）：sftp_list 目录浏览——远端造确定结构（目录 + 两个文件），
/// 断言过滤 . / ..、目录在前、名称序、size/mtime 非零；不存在路径报错。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sftp_list_lists_dir_entries_sorted() {
    let _sshd_guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    use session_api::transport::ChannelHandle;
    use session_api::transport::tokio_util_sync::CancellationToken;

    let channel = transport_ssh::SshChannel::connect(target(), 80, 24)
        .await
        .unwrap();
    channel
        .exec_fresh(
            // R30 C4：附符号链接（可达 + 悬空）供 resolve/stat 断言
            "rm -rf /tmp/t41_dir && mkdir -p /tmp/t41_dir/sub && echo hello > /tmp/t41_dir/b.txt && echo world > /tmp/t41_dir/a.txt && ln -s a.txt /tmp/t41_dir/link && ln -s missing /tmp/t41_dir/dangling",
            &session_api::ExecOpts::default(),
            std::time::Instant::now() + Duration::from_secs(15),
            &CancellationToken::new(),
        )
        .await
        .unwrap();

    let entries = channel.list_dir("/tmp/t41_dir").await.unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["sub", "a.txt", "b.txt", "dangling", "link"], "目录在前、名称序（链接与文件同序）：{names:?}");
    assert!(entries.iter().all(|e| !matches!(e.name.as_str(), "." | "..")));
    // C4（R30）：kind 如实（readdir 属性 lstat 语义——链接条目报 Symlink 不冒充实体）
    let by_name = |n: &str| entries.iter().find(|e| e.name == n).unwrap();
    assert_eq!(by_name("sub").kind, Some(session_api::EntryKind::Dir));
    assert!(by_name("sub").is_dir);
    let a = by_name("a.txt");
    assert_eq!(a.kind, Some(session_api::EntryKind::File));
    assert!(!a.is_dir && a.size == Some(b"world\n".len() as u64));
    assert!(a.mtime.is_some_and(|v| v > 0), "mtime 应为服务器返回的真实时间");
    assert_eq!(by_name("link").kind, Some(session_api::EntryKind::Symlink));
    assert_eq!(by_name("dangling").kind, Some(session_api::EntryKind::Symlink));

    // 不存在路径：可区别错误（SftpPathNotFound，非笼统 Io）
    let miss = channel.list_dir("/tmp/t41_dir/definitely-missing").await;
    assert!(matches!(miss, Err(session_api::Error::SftpPathNotFound { .. })), "{miss:?}");

    // ---- C4（R30）：resolve_path / stat_entry 真机契约 ----
    // resolve：相对与 .. 归一为 canonical；None → SFTP 初始目录（绝对路径）。
    // 注：OpenSSH realpath 对不存在的末段宽容（词法归一即返回，不查存在性）——
    // 「不存在」的可区别错误由 list（read_dir）/stat（lstat）承担，二者必查存在。
    let r = channel.resolve_path(Some("/tmp/t41_dir/../t41_dir")).await.unwrap();
    assert_eq!(r.canonical, "/tmp/t41_dir");
    let init = channel.resolve_path(None).await.unwrap();
    assert!(init.canonical.starts_with('/') && init.canonical.len() > 1, "初始目录应绝对路径：{init:?}");
    let rmiss = channel.resolve_path(Some("/tmp/t41_dir/definitely-missing")).await;
    match rmiss {
        Ok(p) => assert!(p.canonical.starts_with('/') , "宽容 realpath 返回归一绝对路径：{p:?}"),
        Err(session_api::Error::SftpPathNotFound { .. }) => {} // 严格实现（服务端依赖）同样合法
        other => panic!("resolve missing 只应成功归一或 SftpPathNotFound：{other:?}"),
    }

    // stat：文件本体 + 可达链接（跟随语义 size）+ 悬空链接（canonical=None 不猜路径）
    let st = channel.stat_entry("/tmp/t41_dir/a.txt").await.unwrap();
    assert_eq!(st.kind, Some(session_api::EntryKind::File));
    assert_eq!(st.size, Some(b"world\n".len() as u64));
    assert_eq!(st.canonical.as_deref(), Some("/tmp/t41_dir/a.txt"));
    assert_eq!(st.symlink_target, None);
    let stl = channel.stat_entry("/tmp/t41_dir/link").await.unwrap();
    assert_eq!(stl.kind, Some(session_api::EntryKind::Symlink));
    assert_eq!(stl.symlink_target.as_deref(), Some("a.txt"));
    assert_eq!(stl.is_dir, false);
    assert_eq!(stl.size, Some(b"world\n".len() as u64), "可达链接 size 跟随目标");
    assert_eq!(stl.canonical.as_deref(), Some("/tmp/t41_dir/a.txt"));
    let std_ = channel.stat_entry("/tmp/t41_dir/dangling").await.unwrap();
    assert_eq!(std_.kind, Some(session_api::EntryKind::Symlink));
    assert_eq!(std_.symlink_target.as_deref(), Some("missing"));
    // canonical 服务端依赖：OpenSSH 宽容 realpath 返回归一化目标路径；严格实现报错 → None
    match &std_.canonical {
        Some(c) => assert_eq!(c, "/tmp/t41_dir/missing", "宽容 realpath：悬空链接 canonical=归一化目标"),
        None => {} // 严格实现（realpath 失败）→ None（§352 不猜路径）
    }
    let stmiss = channel.stat_entry("/tmp/t41_dir/definitely-missing").await;
    assert!(matches!(stmiss, Err(session_api::Error::SftpPathNotFound { .. })), "{stmiss:?}");

    channel
        .exec_fresh(
            "rm -rf /tmp/t41_dir",
            &session_api::ExecOpts::default(),
            std::time::Instant::now() + Duration::from_secs(10),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    channel.close().await.unwrap();
}

// T21（路线图⑨）：ssh-agent 认证——起一次性 agent（不碰用户真实 agent），
// 容器 authorized_keys 临时加公钥，Agent 认证建连后跑命令，最后全部清理。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_agent_auth_connects() {
    let _sshd_guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let dir = std::env::temp_dir().join(format!("tinyssh-agent-t21-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    // 一次性 ed25519 key（无口令）
    let key_path = dir.join("id_test");
    let kg = std::process::Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "tinyssh-agent-test", "-f"])
        .arg(&key_path)
        .output()
        .expect("ssh-keygen exists");
    assert!(kg.status.success(), "ssh-keygen: {}", String::from_utf8_lossy(&kg.stderr));

    // 独立 ssh-agent：socket 固定在本测试目录，与用户真实 agent 隔离
    let agent_out = std::process::Command::new("ssh-agent")
        .arg("-a")
        .arg(dir.join("agent.sock"))
        .output()
        .expect("ssh-agent exists");
    assert!(agent_out.status.success(), "ssh-agent: {}", String::from_utf8_lossy(&agent_out.stderr));
    let envs = String::from_utf8_lossy(&agent_out.stdout).to_string();
    let sock = envs
        .split("SSH_AUTH_SOCK=")
        .nth(1)
        .expect("SSH_AUTH_SOCK line")
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let agent_pid: String = envs
        .split("SSH_AGENT_PID=")
        .nth(1)
        .expect("SSH_AGENT_PID line")
        .split(';')
        .next()
        .unwrap()
        .to_string();

    // 收尾：杀 agent + 删临时目录 + 容器 authorized_keys 还原（无论断言成败）
    struct Cleanup(String, String);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::process::Command::new("kill").arg(&self.0).output();
            let _ = std::process::Command::new("docker")
                .args(["exec", "tinyssh-e2e", "sed", "-i", "/tinyssh-agent-test$/d",
                       "/root/.ssh/authorized_keys"])
                .output();
            let _ = std::fs::remove_dir_all(&self.1);
        }
    }
    let _cleanup = Cleanup(agent_pid, dir.to_string_lossy().into_owned());

    let add = std::process::Command::new("ssh-add")
        .env("SSH_AUTH_SOCK", &sock)
        .arg(&key_path)
        .output()
        .expect("ssh-add exists");
    assert!(add.status.success(), "ssh-add: {}", String::from_utf8_lossy(&add.stderr));

    // 容器收公钥（StrictModes 要求目录/文件权限正确）
    let pubkey = std::fs::read_to_string(key_path.with_extension("pub")).unwrap();
    use std::io::Write as _;
    let mut child = std::process::Command::new("docker")
        .args(["exec", "-i", "tinyssh-e2e", "sh", "-c",
               "mkdir -p /root/.ssh && chmod 700 /root/.ssh && touch /root/.ssh/authorized_keys && cat >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .expect("docker exec");
    child.stdin.take().unwrap().write_all(pubkey.as_bytes()).unwrap();
    let added = child.wait().unwrap();
    assert!(added.success(), "docker exec authorized_keys");

    // Agent 认证建连（connect_env 读进程 env 的 SSH_AUTH_SOCK）
    let prev_sock = std::env::var("SSH_AUTH_SOCK").ok();
    std::env::set_var("SSH_AUTH_SOCK", &sock);
    let mut t = target();
    t.auth_type = session_api::AuthType::Agent;
    t.secret = String::new();
    let channel = match transport_ssh::SshChannel::connect(t, 120, 32).await {
        Ok(c) => c,
        Err(e) => {
            if let Some(s) = prev_sock {
                std::env::set_var("SSH_AUTH_SOCK", s);
            }
            panic!("agent auth connect failed: {e}");
        }
    };
    if let Some(s) = prev_sock {
        std::env::set_var("SSH_AUTH_SOCK", s);
    }

    // shell 里跑命令证明认证+通道完整
    use session_api::transport::ChannelHandle as _;
    let out = channel
        .exec_fresh(
            "whoami",
            &session_api::ExecOpts::default(),
            std::time::Instant::now() + Duration::from_secs(10),
            &session_api::transport::tokio_util_sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "root");
    channel.close().await.unwrap();
}

/// 路线图⑩ 2FA：服务器拒绝 password 方法、强制 keyboard-interactive（PAM）时，
/// Password 认证回落 kb 循环——首条密码类提示自动应答库内密码，认证成功。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_keyboard_interactive_fallback() {
    let _sshd_guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    match kb_scenario().await {
        Ok(()) => {}
        Err(e) => panic!("kb fallback scenario failed: {e}"),
    }
}

async fn kb_scenario() -> Result<(), String> {
    use session_api::transport::ChannelHandle as _;

    // 容器内起第二 sshd（2223）：alpine 的 PAM 版二进制是独立文件 /usr/sbin/sshd.pam
    //（普通 /usr/sbin/sshd 会静默忽略 UsePAM、kb 无后端恒拒）。
    // 杀旧实例走 /proc 全扫描：busybox pgrep/pkill 匹配 argv[0]，而 sshd 监听进程
    // re-exec 后 argv[0] 是 "sshd: …[listener]" 长标题，-x/-f 都打不准；
    // pkill -f 又会自匹配本 sh 命令行文本（T25 同型坑）。排除自身 PID 即可。
    let setup = std::process::Command::new("docker")
        .args([
            "exec", "tinyssh-e2e", "sh", "-c",
            "apk add --no-cache openssh-server-pam >/dev/null 2>&1; \
             SS=sshd.pam; [ -x /usr/sbin/$SS ] || SS=sshd; \
             [ -s /etc/pam.d/sshd ] || printf 'auth required pam_unix.so\\naccount required pam_unix.so\\npassword required pam_unix.so\\nsession required pam_unix.so\\n' > /etc/pam.d/sshd; \
             mkdir -p /run/sshd; \
             for p in /proc/[0-9]*; do i=${p#/proc/}; [ \"$i\" = \"$$\" ] && continue; c=$(tr \"\\0\" \" \" < $p/cmdline 2>/dev/null); case \"$c\" in *sshd*2223*) kill $i 2>/dev/null;; esac; done; sleep 0.4; \
             /usr/sbin/$SS -p 2223 -o UsePAM=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=yes -o PermitRootLogin=yes",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !setup.status.success() {
        return Err(format!("kb sshd 启动失败: {} {}", String::from_utf8_lossy(&setup.stderr), String::from_utf8_lossy(&setup.stdout)));
    }
    // banner 探测 2223（TCP 提前接受在 docker 端口代理下失真——banner 为准）
    let mut up = false;
    for _ in 0..20 {
        let ok = std::process::Command::new("bash")
            .args(["-c", "printf '' | nc -w 2 127.0.0.1 2223 2>/dev/null | head -c 4 | grep -q SSH-"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            up = true;
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    if !up {
        return Err("kb sshd 20s 未就绪".into());
    }

    let mut t = target();
    t.port = 2223;
    let channel = transport_ssh::SshChannel::connect(t, 120, 32)
        .await
        .map_err(|e| e.to_string())?;
    let out = channel
        .exec_fresh(
            "echo kb-fallback-ok",
            &session_api::ExecOpts::default(),
            std::time::Instant::now() + Duration::from_secs(10),
            &session_api::transport::tokio_util_sync::CancellationToken::new(),
        )
        .await
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    channel.close().await.map_err(|e| e.to_string())?;
    if text.contains("kb-fallback-ok") {
        Ok(())
    } else {
        Err(format!("kb 会话输出异常: {text:?}"))
    }
}

// T42（FR-8）端口转发：本地 -L / SOCKS5 -D / 远程 -R / 停止语义。
// 容器要求：AllowTcpForwarding yes（Alpine 默认 no）+ GatewayPorts clientspecified
//（远程转发 0.0.0.0 才能被 docker 端口代理够到）——dev-sshd.sh 已配置。
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// 读一行（到 \r\n 或 \n）带超时——sshd 连上即主动吐 banner，等不到就是转发没通
async fn read_banner(tcp: &mut tokio::net::TcpStream) -> String {
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::new();
    let mut b = [0u8; 1];
    let fut = async {
        loop {
            tcp.read_exact(&mut b).await.unwrap();
            buf.push(b[0]);
            if b[0] == b'\n' || buf.len() > 255 {
                break;
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(10), fut).await.expect("10s 未读到 banner");
    String::from_utf8_lossy(&buf).into_owned()
}

/// 停止后端口必须真的不可连（监听已关）：轮询到 refused，最多 3s
async fn assert_port_closed(port: u16) {
    for _ in 0..30 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_err() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("停止转发后 127.0.0.1:{port} 仍可连接（监听未关）");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forward_local_and_dynamic_roundtrip() {
    let _sshd_guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    use session_api::transport::ChannelHandle;

    let channel = transport_ssh::SshChannel::connect(target(), 80, 24).await.unwrap();

    // 非法 spec（端口 0）立即拒绝
    assert!(channel
        .start_forward(session_api::ForwardSpec::Local {
            listen_addr: "127.0.0.1".into(), listen_port: 0,
            target_host: "127.0.0.1".into(), target_port: 22,
        })
        .await
        .is_err());

    // R40（审核中-1）：目标侧非法 → 字段可定位错误（field=target）——**走生产 start_forward**，
    // 不是 r40_tests 的 stub 镜像（否则把生产 field 写错也三层全绿）
    for bad in [
        session_api::ForwardSpec::Local {
            listen_addr: "127.0.0.1".into(), listen_port: free_port(),
            target_host: "  ".into(), target_port: 22,
        },
        session_api::ForwardSpec::Local {
            listen_addr: "127.0.0.1".into(), listen_port: free_port(),
            target_host: "127.0.0.1".into(), target_port: 0,
        },
        session_api::ForwardSpec::Remote {
            listen_addr: "127.0.0.1".into(), listen_port: free_port(),
            target_host: "".into(), target_port: 0,
        },
    ] {
        let e = channel.start_forward(bad.clone()).await.unwrap_err();
        assert!(
            matches!(e, session_api::Error::ForwardListenFailed { ref field, .. } if field == "target"),
            "目标非法应回 ForwardListenFailed{{field:target}}：{bad:?} → {e:?}"
        );
    }


    // R40（§6.6/D02）：端口冲突 → 字段可定位错误（field=listen）——不是含糊 Io
    let dup = free_port();
    let f_dup = channel
        .start_forward(session_api::ForwardSpec::Local {
            listen_addr: "127.0.0.1".into(), listen_port: dup,
            target_host: "127.0.0.1".into(), target_port: 22,
        })
        .await
        .unwrap();
    let e_dup = channel
        .start_forward(session_api::ForwardSpec::Local {
            listen_addr: "127.0.0.1".into(), listen_port: dup,
            target_host: "127.0.0.1".into(), target_port: 22,
        })
        .await
        .unwrap_err();
    assert!(
        matches!(e_dup, session_api::Error::ForwardListenFailed { ref field, .. } if field == "listen"),
        "端口冲突应回 ForwardListenFailed{{field:listen}}：{e_dup:?}"
    );
    channel.stop_forward(&f_dup).await.unwrap();

    // R40（§6.6）：非回环监听放行（0.0.0.0 绑定）——「主动选择」由 FE 把关，核心不拒
    let np = free_port();
    let f_nl = channel
        .start_forward(session_api::ForwardSpec::Local {
            listen_addr: "0.0.0.0".into(), listen_port: np,
            target_host: "127.0.0.1".into(), target_port: 22,
        })
        .await
        .unwrap();
    let infos_nl = channel.list_forwards().await.unwrap();
    let e_nl = infos_nl.iter().find(|f| f.id == f_nl).expect("非回环转发应在列");
    assert_eq!(e_nl.state, "Listening", "0.0.0.0 绑定应成功：{:?}", e_nl.error);
    let mut t_nl = tokio::net::TcpStream::connect(("127.0.0.1", np)).await.expect("0.0.0.0 监听经回环应可连");
    let banner_nl = read_banner(&mut t_nl).await;
    assert!(banner_nl.starts_with("SSH-2.0"), "非回环转发真流量应读到 sshd banner：{banner_nl:?}");
    channel.stop_forward(&f_nl).await.unwrap();
    assert_port_closed(np).await;

    // ---- 本地 -L：127.0.0.1:lp → 容器 127.0.0.1:22，读 SSH banner ----
    let lp = free_port();
    let fid = channel
        .start_forward(session_api::ForwardSpec::Local {
            listen_addr: "127.0.0.1".into(), listen_port: lp,
            target_host: "127.0.0.1".into(), target_port: 22,
        })
        .await
        .unwrap();
    let infos = channel.list_forwards().await.unwrap();
    let e = infos.iter().find(|f| f.id == fid).expect("list_forwards 应含刚启动的转发");
    assert_eq!(e.state, "Listening", "本地转发应即刻 Listening：{:?}", e.error);
    let mut tcp = tokio::net::TcpStream::connect(("127.0.0.1", lp)).await.expect("本地监听应可连");
    let banner = read_banner(&mut tcp).await;
    assert!(banner.starts_with("SSH-2.0"), "经 -L 读到的应是容器 sshd banner：{banner:?}");

    // 停止：条目移除 + 监听关闭
    channel.stop_forward(&fid).await.unwrap();
    assert!(channel.list_forwards().await.unwrap().is_empty(), "停止后列表应为空");
    assert_port_closed(lp).await;

    // ---- 目标不可达 → Degraded 且文案指向目标侧（T44 复核中-3）：隧道健康、
    // 目标端口关闭时不得误导为「隧道降级」（会话仍在 → 目标侧分支）----
    let lp_bad = free_port();
    let fid_bad = channel
        .start_forward(session_api::ForwardSpec::Local {
            listen_addr: "127.0.0.1".into(), listen_port: lp_bad,
            target_host: "127.0.0.1".into(), target_port: 9, // 容器内无服务 → sshd 回 open failure
        })
        .await
        .unwrap();
    let mut tbad = tokio::net::TcpStream::connect(("127.0.0.1", lp_bad)).await.unwrap();
    let mut bbuf = [0u8; 16];
    let _ = tokio::time::timeout(Duration::from_secs(5), tbad.read(&mut bbuf)).await; // 失败即断开
    let mut deg: Option<Option<String>> = None;
    for _ in 0..30 {
        let infos = channel.list_forwards().await.unwrap();
        if let Some(e) = infos.iter().find(|f| f.id == fid_bad) {
            if e.state == "Degraded" {
                deg = Some(e.error.clone());
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let deg = deg.expect("目标拒绝后条目应转 Degraded");
    assert!(deg.as_deref().unwrap_or("").contains("目标不可达"), "文案应指向目标侧而非隧道：{deg:?}");
    channel.stop_forward(&fid_bad).await.unwrap();

    // ---- SOCKS5 -D：手动 RFC1928 握手（域名目标 localhost:22）读 banner ----
    let dp = free_port();
    let fid2 = channel
        .start_forward(session_api::ForwardSpec::Dynamic {
            listen_addr: "127.0.0.1".into(), listen_port: dp,
        })
        .await
        .unwrap();
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", dp)).await.expect("SOCKS5 监听应可连");
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // 方法协商：[VER,NMETHODS][METHOD=无认证]
    s.write_all(&[5, 1, 0]).await.unwrap();
    let mut m = [0u8; 2];
    tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut m)).await.unwrap().unwrap();
    assert_eq!(&m, &[5, 0], "服务端应选定无认证");
    // CONNECT localhost:22（ATYP=域名）
    let mut req = vec![5, 1, 0, 3, b"localhost".len() as u8];
    req.extend_from_slice(b"localhost");
    req.extend_from_slice(&22u16.to_be_bytes());
    s.write_all(&req).await.unwrap();
    let mut rep = [0u8; 10];
    tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut rep)).await.unwrap().unwrap();
    assert_eq!(&rep[..3], &[5, 0, 0], "CONNECT 应答成功：{rep:?}");
    let banner = read_banner(&mut s).await;
    assert!(banner.starts_with("SSH-2.0"), "经 SOCKS5 读到的应是容器 sshd banner：{banner:?}");

    // BIND/UDP 不支持：CONNECT 之外的 cmd 直接断开（重置/EOF/超时都算「已断开」）
    let mut s2 = tokio::net::TcpStream::connect(("127.0.0.1", dp)).await.unwrap();
    s2.write_all(&[5, 1, 0]).await.unwrap();
    let mut m2 = [0u8; 2];
    tokio::time::timeout(Duration::from_secs(5), s2.read_exact(&mut m2)).await.unwrap().unwrap();
    s2.write_all(&[5, 2, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap(); // cmd=2 BIND
    match tokio::time::timeout(Duration::from_secs(5), s2.read(&mut [0u8; 8])).await {
        Err(_) => {}                    // 超时无应答
        Ok(Err(_)) => {}                // 连接重置
        Ok(Ok(0)) => {}                 // EOF
        Ok(Ok(n)) => panic!("非 CONNECT 不应有应答数据（{} 字节）", n),
    }

    // 目标拒绝 → REP=5 connection refused（复审①：字符串匹配是死代码，须枚举判定；
    // 容器内 127.0.0.1:9 无服务，OpenSSH 对 direct-tcpip 连接失败回 reason 2）
    let mut s3 = tokio::net::TcpStream::connect(("127.0.0.1", dp)).await.unwrap();
    s3.write_all(&[5, 1, 0]).await.unwrap();
    let mut m3 = [0u8; 2];
    tokio::time::timeout(Duration::from_secs(5), s3.read_exact(&mut m3)).await.unwrap().unwrap();
    let mut req3 = vec![5, 1, 0, 3, b"localhost".len() as u8];
    req3.extend_from_slice(b"localhost");
    req3.extend_from_slice(&9u16.to_be_bytes());
    s3.write_all(&req3).await.unwrap();
    let mut rep3 = [0u8; 10];
    tokio::time::timeout(Duration::from_secs(5), s3.read_exact(&mut rep3)).await.unwrap().unwrap();
    assert_eq!(rep3[1], 5, "目标拒绝应回 REP=5（connection refused）：{rep3:?}");

    channel.stop_forward(&fid2).await.unwrap();
    assert_port_closed(dp).await;

    // 关闭会话即停全部转发（审核发现：监听任务持 Arc<Self>，不取消则监听端口
    // 泄漏到进程退出）——带活跃转发直接 close，端口必须随之释放
    let lp3 = free_port();
    channel
        .start_forward(session_api::ForwardSpec::Local {
            listen_addr: "127.0.0.1".into(), listen_port: lp3,
            target_host: "127.0.0.1".into(), target_port: 22,
        })
        .await
        .unwrap();
    channel.close().await.unwrap();
    assert_port_closed(lp3).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forward_remote_roundtrip() {
    let _sshd_guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    use session_api::transport::ChannelHandle;
    use tokio::io::AsyncWriteExt;

    // kb 测试会在容器 2223 起第二 sshd：先清（同 kb 的 /proc 扫描法，避免端口被占）
    let _ = std::process::Command::new("docker")
        .args(["exec", "tinyssh-e2e", "sh", "-c",
            "for p in /proc/[0-9]*; do i=${p#/proc/}; [ \"$i\" = \"$$\" ] && continue; c=$(tr \"\\0\" \" \" < $p/cmdline 2>/dev/null); case \"$c\" in *sshd*2223*) kill $i 2>/dev/null;; esac; done; true"])
        .output();

    // 回程目标：宿主机标记服务器，连上即写 MARKER
    let marker = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mp = marker.local_addr().unwrap().port();
    let marker_task = tokio::spawn(async move {
        let (mut s, _) = marker.accept().await.unwrap();
        s.write_all(b"T42-REMOTE-MARKER\n").await.unwrap();
    });

    let channel = transport_ssh::SshChannel::connect(target(), 80, 24).await.unwrap();
    // 远程 -R：容器 0.0.0.0:2223 →（回程）宿主机 127.0.0.1:mp。
    // GatewayPorts clientspecified 下 0.0.0.0 才可被 docker 端口代理够到。
    let fid = channel
        .start_forward(session_api::ForwardSpec::Remote {
            listen_addr: "0.0.0.0".into(), listen_port: 2223,
            target_host: "127.0.0.1".into(), target_port: mp,
        })
        .await
        .unwrap();
    let infos = channel.list_forwards().await.unwrap();
    let e = infos.iter().find(|f| f.id == fid).expect("远程转发应在列");
    assert_eq!(e.state, "Listening", "tcpip_forward 应被接受（否则：{:?}）", e.error);

    // 从宿主机连 2223：docker 代理 → 容器 sshd 转发监听 → 经 SSH 回程打到本地标记服务器
    let mut c = tokio::net::TcpStream::connect(("127.0.0.1", 2223)).await.expect("2223 应可连");
    let got = read_banner(&mut c).await;
    assert_eq!(got.trim_end(), "T42-REMOTE-MARKER", "远程转发回程应读到标记");
    marker_task.await.unwrap();

    // UI 实际 wire 值 listen_addr=""（服务器默认绑定）也应被接受——锁住 UI↔transport 契约
    let fid_empty = channel
        .start_forward(session_api::ForwardSpec::Remote {
            listen_addr: "".into(), listen_port: 2224,
            target_host: "127.0.0.1".into(), target_port: mp,
        })
        .await
        .unwrap();
    let infos2 = channel.list_forwards().await.unwrap();
    let e2 = infos2.iter().find(|f| f.id == fid_empty).expect("空地址远程转发应在列");
    assert_eq!(e2.state, "Listening", "listen_addr=\"\" 应被服务器接受（否则：{:?}）", e2.error);
    channel.stop_forward(&fid_empty).await.unwrap();

    // 停止：cancel_tcpip_forward 后容器监听关闭。注意 docker 端口代理在宿主侧
    // 恒监听 2223（connect 总成功）——「关」的判据是无数据（超时/EOF/重置），
    // 而非连接被拒。
    channel.stop_forward(&fid).await.unwrap();
    let mut closed = false;
    for _ in 0..30 {
        if let Ok(mut s) = tokio::net::TcpStream::connect(("127.0.0.1", 2223)).await {
            use tokio::io::AsyncReadExt;
            let mut b = [0u8; 1];
            match tokio::time::timeout(Duration::from_secs(1), s.read(&mut b)).await {
                Err(_) => { closed = true; break; }      // 超时无数据
                Ok(Err(_)) => { closed = true; break; }  // 代理重置
                Ok(Ok(0)) => { closed = true; break; }   // 立即 EOF
                Ok(Ok(_)) => {}                          // 仍有数据流过 = 未关
            }
        } else {
            closed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(closed, "取消远程转发后 2223 不应再吐数据");
    channel.close().await.unwrap();
}
