//! 冒烟：本地 PTY + shell 集成注入 + OSC 133 块检测（transport × term-core 联动）。

use std::sync::mpsc as std_mpsc;
use std::time::Duration;
use session_api::transport::ChannelHandle;
use term_core::{Screen, ScreenConfig};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_shell_produces_blocks_and_cwd() {
    let (channel, _cleanup) = transport_pty::spawn_local_pty(120, 32)
        .await
        .expect("spawn local pty");

    let mut screen = Screen::new(ScreenConfig::default());
    let mut rx = channel.subscribe_output();

    // std channel 桥接 broadcast 回调与主测试任务
    let (tx, rx_feed) = std_mpsc::channel::<Vec<u8>>();
    tokio::task::spawn_blocking(move || loop {
        match rx.blocking_recv() {
            Ok(data) => {
                if tx.send(data).is_err() {
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            Err(_) => continue,
        }
    });

    let drain = |screen: &mut Screen, rx_feed: &std_mpsc::Receiver<Vec<u8>>| {
        while let Ok(data) = rx_feed.try_recv() {
            screen.feed(&data);
        }
    };

    // 等待提示符出现（集成注入生效标志：OSC 133 A 事件）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        drain(&mut screen, &rx_feed);
        if screen.shell_integration_present() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no OSC 133 seen; screen:\n{}",
            screen.snapshot_text()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // 发送命令
    // 键入先向屏幕登记（core-session 的职责；决定命令文本归因与捕获）
    screen.register_outgoing(b"echo tinyssh_smoke_$((40+2))\r", term_core::BlockSource::Human);
    channel
        .write(b"echo tinyssh_smoke_$((40+2))\r")
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        drain(&mut screen, &rx_feed);
        let blocks = screen.blocks.last_blocks(1);
        if let Some(b) = blocks.last() {
            if b.command.contains("tinyssh_smoke") {
                assert_eq!(b.exit_code, Some(0), "echo 应以 0 退出");
                assert!(b.end.is_some());
                break;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "block not closed; screen:\n{}",
            screen.snapshot_text()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(screen.snapshot_text().contains("tinyssh_smoke_42"));

    // cwd 经 OSC 7 报告
    drain(&mut screen, &rx_feed);
    assert!(
        screen.cwd().is_some(),
        "OSC 7 cwd 未上报；integration 需要 PWD 打印"
    );

    // Fresh 模式：真实退出码
    let out = channel
        .exec_fresh(
            "echo fresh_out; exit 7",
            &session_api::ExecOpts::default(),
            std::time::Instant::now() + Duration::from_secs(10),
            &session_api::transport::tokio_util_sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(out.exit_code, Some(7));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "fresh_out");
    assert!(out.completed);
}
