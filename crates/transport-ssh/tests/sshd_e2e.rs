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
    let n = channel.upload(&local, &remote, &Default::default()).await.unwrap();
    assert_eq!(n, b"sftp-roundtrip-data".len() as u64);
    let back = dir.path().join("d.txt");
    channel.download(&remote, &back, &Default::default()).await.unwrap();
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
            .download("/tmp/t20_cancel.bin", &dst, &c2)
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
