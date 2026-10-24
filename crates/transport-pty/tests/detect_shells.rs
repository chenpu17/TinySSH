//! 本地终端一等公民轮：detect_local_shells 探测面 + shell override 生效。
//! override 探针语义：cmd 用 `%VAR%` 展开、powershell 不认——按展开结果断言
//! 实际启动的是指定 shell 而非默认回退。

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

#[test]
fn detect_lists_builtin_shells_with_honest_integrable() {
    let shells = transport_pty::detect_local_shells();
    // id 唯一、path 非空（探测面基本契约）
    let mut ids: Vec<_> = shells.iter().map(|s| s.id.clone()).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), shells.len(), "id 应唯一：{shells:?}");
    assert!(shells.iter().all(|s| !s.path.is_empty()));
    #[cfg(windows)]
    {
        // Windows PowerShell 与 cmd 是系统组件，恒应探到；powershell 置首（默认回退）
        assert!(
            shells.iter().any(|s| s.id == "powershell"),
            "Windows PowerShell 恒在：{shells:?}"
        );
        assert!(shells.iter().any(|s| s.id == "cmd"), "cmd 恒在：{shells:?}");
        assert_eq!(shells[0].id, "powershell", "默认回退 shell 应置首");
        let ps = shells.iter().find(|s| s.id == "powershell").unwrap();
        assert!(ps.integrable, "powershell 可注入 OSC133");
        for s in shells
            .iter()
            .filter(|s| matches!(s.id.as_str(), "cmd" | "wsl"))
        {
            assert!(!s.integrable, "{} 无 preexec 钩子，应如实标不可注入", s.id);
        }
        // System32 的 bash.exe 是 WSL 启动器——若探到 git-bash 必须不是它
        for s in shells.iter().filter(|s| s.id == "git-bash") {
            assert!(
                !s.path.to_ascii_lowercase().contains("system32"),
                "git-bash 不得误探 System32 bash 启动器：{}",
                s.path
            );
        }
    }
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawn_with_override_uses_requested_shell() {
    let shells = transport_pty::detect_local_shells();
    let cmd = shells
        .iter()
        .find(|s| s.id == "cmd")
        .expect("cmd 恒在")
        .path
        .clone();
    // cmd 展开 %VAR%、powershell 原样回显——展开命中即证明启动的是 override 指定的 cmd
    std::env::set_var("TINYSSH_PTY_OVERRIDE_PROBE", "override_ok");
    let (ch, _cleanup) = transport_pty::spawn_local_pty(100, 30, Some(cmd))
        .await
        .unwrap();
    let mut rx = ch.subscribe_output();
    ch.write(b"echo %TINYSSH_PTY_OVERRIDE_PROBE%\r")
        .await
        .unwrap();
    let out = recv_until(&mut rx, Duration::from_secs(15), |t| {
        t.contains("override_ok") || t.contains("TINYSSH_PTY_OVERRIDE_PROBE")
    })
    .await;
    assert!(out.contains("override_ok"), "cmd 应展开变量（实得 {out:?})");
    ch.close().await.unwrap();
}
