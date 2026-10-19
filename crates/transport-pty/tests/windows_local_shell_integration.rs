//! Windows 本地 shell 集成扩面（P1 终端轮）实测：powershell.exe 全链
//! （注入 → ConPTY 透传 → OSC 133 A/B/C/D → 命令块文本/退出码/cwd → 先验 hint），
//! 以及不可注入 shell（cmd.exe）的构造性先验 false。单文件单测：进程内改 SHELL
//! 无并发干扰。非 Windows 平台整文件为空。

#![cfg(windows)]

use session_api::transport::ChannelHandle;
use std::sync::mpsc as std_mpsc;
use std::time::Duration;
use term_core::{Screen, ScreenConfig};

/// 等条件成立（每 20ms 轮询），超时带屏幕快照失败——定位卡在哪一步。
async fn wait_for(
    screen: &mut Screen,
    rx_feed: &std_mpsc::Receiver<Vec<u8>>,
    secs: u64,
    what: &str,
    pred: impl Fn(&Screen) -> bool,
) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        while let Ok(data) = rx_feed.try_recv() {
            screen.feed(&data);
        }
        if pred(screen) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "等待 {what} 超时；blocks:\n{:?}\nscreen:\n{}",
            screen.blocks.blocks,
            screen.snapshot_text()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn powershell_integration_and_plain_prior() {
    // ---- powershell.exe：判型命中 → 注入脚本 → 全链块 ----
    std::env::set_var("SHELL", "powershell.exe");
    let (channel, cleanup) = transport_pty::spawn_local_pty(120, 32)
        .await
        .expect("spawn local pty");
    assert!(
        channel.shell_integration_hint() == Some(true),
        "powershell 应判型为可注入（先验 true）"
    );

    let mut screen = Screen::new(ScreenConfig::default());
    let mut rx = channel.subscribe_output();
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

    // 首个提示符：A（saw_133）与 B（prompt_ready）都要在——注入生效的直接证据
    wait_for(&mut screen, &rx_feed, 30, "OSC133 A+B 首提示符", |s| {
        s.shell_integration_present() && s.prompt_ready()
    })
    .await;

    // 人类键入：B→C 键入捕获 → 块命令文本
    screen.register_outgoing(b"echo tinyssh_ps_$(40+2)\r", term_core::BlockSource::Human);
    channel.write(b"echo tinyssh_ps_$(40+2)\r").await.unwrap();
    wait_for(&mut screen, &rx_feed, 20, "块闭合 exit 0", |s| {
        s.blocks
            .last_blocks(1)
            .last()
            .map(|b| b.command.contains("tinyssh_ps") && b.exit_code == Some(0) && b.end.is_some())
            .unwrap_or(false)
    })
    .await;
    // ConPTY 流序：文本可整帧晚于 D——块闭合 ≠ 输出已落屏（与 bash 冒烟同一纪律）
    wait_for(&mut screen, &rx_feed, 10, "输出落屏", |s| {
        s.snapshot_text().contains("tinyssh_ps_42")
    })
    .await;

    // 原生命令退出码：$? false 且 $LASTEXITCODE=7 → D 带真实退出码（混合映射的成功面）
    screen.register_outgoing(b"cmd /c exit 7\r", term_core::BlockSource::Human);
    channel.write(b"cmd /c exit 7\r").await.unwrap();
    wait_for(&mut screen, &rx_feed, 20, "块闭合 exit 7", |s| {
        s.blocks
            .last_blocks(1)
            .last()
            .map(|b| b.command.contains("cmd /c exit 7") && b.exit_code == Some(7))
            .unwrap_or(false)
    })
    .await;

    // cwd 经 OSC 7 上报（PowerShell 发 file:///C:/… 形态）
    wait_for(&mut screen, &rx_feed, 5, "OSC 7 cwd", |s| s.cwd().is_some()).await;

    // Fresh 模式照常（-NoProfile -Command 族参数）
    let out = channel
        .exec_fresh(
            "echo fresh_ps; exit 7",
            &session_api::ExecOpts::default(),
            std::time::Instant::now() + Duration::from_secs(15),
            &session_api::transport::tokio_util_sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(out.exit_code, Some(7));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "fresh_ps");
    assert!(out.completed);
    drop(channel);
    if let Some(d) = cleanup {
        let _ = std::fs::remove_dir_all(d);
    }

    // ---- cmd.exe：无法注入 → 构造性先验 false（core 据此立即如实拒绝 Shell 模式）----
    std::env::set_var("SHELL", "cmd.exe");
    let (channel, cleanup) = transport_pty::spawn_local_pty(120, 32)
        .await
        .expect("spawn cmd pty");
    assert_eq!(channel.shell_integration_hint(), Some(false));
    drop(channel);
    if let Some(d) = cleanup {
        let _ = std::fs::remove_dir_all(d);
    }
}
