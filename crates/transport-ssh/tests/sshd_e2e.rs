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
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    use session_api::transport::ChannelHandle;

    let channel: std::sync::Arc<transport_ssh::SshChannel> =
        transport_ssh::SshChannel::connect(target(), 120, 32)
            .await
            .expect("ssh connect+auth");
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
        assert!(tokio::time::Instant::now() < deadline, "no OSC 133; screen:\n{}", screen.snapshot_text());
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
        assert!(tokio::time::Instant::now() < deadline, "block1 not closed:\n{}", screen.snapshot_text());
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
        assert!(tokio::time::Instant::now() < deadline, "block2 not closed:\n{}", screen.snapshot_text());
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
}

use tokio_util_like::CancellationToken as _CancellationTokenAlias;
mod tokio_util_like {
    pub use session_api::transport::tokio_util_sync::CancellationToken;
}
