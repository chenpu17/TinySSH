//! 冒烟：本地 PTY + shell 集成注入 + OSC 133 块检测（transport × term-core 联动）。

use session_api::transport::ChannelHandle;
use std::sync::mpsc as std_mpsc;
use std::time::Duration;
use term_core::{Screen, ScreenConfig};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_shell_produces_blocks_and_cwd() {
    let (channel, _cleanup) = transport_pty::spawn_local_pty(120, 32, None)
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
    screen.register_outgoing(
        b"echo tinyssh_smoke_$((40+2))\r",
        term_core::BlockSource::Human,
    );
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
    // ConPTY 流序（2026-10-12 实测）：文本攒进渲染缓冲按帧刷出，可整帧晚于 D 标记
    // 到达——块闭合 ≠ 输出已落屏。断言前等文本渲染（并行套件 CPU 争抢下必现）。
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        drain(&mut screen, &rx_feed);
        if screen.snapshot_text().contains("tinyssh_smoke_42") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "输出未落屏; screen:\n{}",
            screen.snapshot_text()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fresh_exec_deadline_fires_without_output() {
    // 审计 R1 回归：读泵曾与 select 串行（join! 在前）——「无输出且不退出」的
    // 命令读端永不 EOF，deadline/cancel 分支不可达，exec 永久挂死。重构后
    // deadline 应按时出局、completed=false、promptly 返回。
    let (channel, _cleanup) = transport_pty::spawn_local_pty(120, 32, None)
        .await
        .expect("spawn local pty");
    let started = std::time::Instant::now();
    let out = channel
        .exec_fresh(
            "sleep 30",
            &session_api::ExecOpts::default(),
            std::time::Instant::now() + Duration::from_secs(2),
            &session_api::transport::tokio_util_sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    let elapsed = started.elapsed();
    assert!(!out.completed, "超时出局应 completed=false");
    assert!(elapsed >= Duration::from_secs(2), "应等到 deadline 才出局");
    assert!(
        elapsed < Duration::from_secs(10),
        "deadline 后应及时返回，实际 {elapsed:?}"
    );
}
