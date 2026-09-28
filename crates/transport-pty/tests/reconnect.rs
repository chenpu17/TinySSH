//! 本地 PTY 重连（T13）：shell 退出成死端 → reconnect 换新 shell，
//! 同一 broadcast 继续输出（UI/泵既有订阅不失效的契约）。

use session_api::transport::ChannelHandle;
use std::time::Duration;

async fn recv_until(
    rx: &mut tokio::sync::broadcast::Receiver<Vec<u8>>,
    timeout: Duration,
    pred: impl Fn(&str) -> bool,
) -> String {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut acc = String::new();
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Ok(data)) => {
                acc.push_str(&String::from_utf8_lossy(&data));
                if pred(&acc) {
                    return acc;
                }
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                panic!("broadcast closed: {acc:?}")
            }
            Err(_) => panic!("timeout waiting output: {acc:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pty_reconnect_revives_shell_on_same_broadcast() {
    let (ch, _cleanup) = transport_pty::spawn_local_pty(100, 30).await.unwrap();
    let mut rx = ch.subscribe_output();

    // shell 退出 → 死端
    ch.write(b"exit\r").await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while ch.is_alive().await {
        assert!(tokio::time::Instant::now() < deadline, "旧 shell 未退出");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // 重连 → 新 shell 仍在同一 broadcast 上
    ch.reconnect().await.unwrap();
    assert!(ch.is_alive().await, "重连后应存活");
    ch.write(b"echo T13_PTY_RECONNECT_MARK\r").await.unwrap();
    let out = recv_until(&mut rx, Duration::from_secs(15), |t| {
        t.contains("T13_PTY_RECONNECT_MARK")
    })
    .await;
    assert!(out.contains("T13_PTY_RECONNECT_MARK"));

    // 重连后的 shell 可再次正常退出
    ch.close().await.unwrap();
    assert!(!ch.is_alive().await);
}
