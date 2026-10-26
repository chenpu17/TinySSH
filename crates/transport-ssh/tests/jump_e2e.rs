//! ProxyJump（FR-9）传输层自跳 e2e：同一 e2e sshd 既当跳板又当目标——hop 握手
//! 成功后 direct-tcpip 指回 127.0.0.1:22 二次握手，零新增环境。
//! 断言：①逐跳 TOFU 门调用顺序（跳板先、目标后）；②链上 shell 可用（echo 标记
//! 展开，回显的命令行不含展开值）；③跳板认证失败归因带跳名。
//! 门控：TINYSSH_E2E_SSHD=1（无 docker 开发机跳过，守卫先于就绪等待）。

use session_api::transport::ChannelHandle;
use std::sync::{Arc, Mutex as StdMutex};

fn sshd_enabled() -> bool {
    std::env::var("TINYSSH_E2E_SSHD")
        .map(|v| v == "1")
        .unwrap_or(false)
}

type Order = Arc<StdMutex<Vec<&'static str>>>;

fn counting_gate(tag: &'static str, order: Order) -> transport_ssh::HostKeyCheck {
    Arc::new(move |_fp| {
        let order = order.clone();
        Box::pin(async move {
            order.lock().unwrap().push(tag);
            Ok(true)
        })
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn jump_chain_self_hop_connects_and_gate_order() {
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let _guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    let (addr, port, username, secret) = tinyssh_testbed::sshd_endpoint();

    let order: Order = Arc::new(StdMutex::new(Vec::new()));
    let target = transport_ssh::SshTarget {
        address: addr.clone(),
        port,
        username: username.clone(),
        auth_type: session_api::AuthType::Password,
        secret: secret.clone(),
        host_key_check: Some(counting_gate("target", order.clone())),
        kb_prompt_check: None,
        hops: vec![transport_ssh::JumpHop {
            address: addr.clone(),
            port,
            username,
            auth_type: session_api::AuthType::Password,
            secret,
            host_key_check: Some(counting_gate("hop", order.clone())),
            kb_prompt_check: None,
            label: "第1跳(self)".into(),
        }],
    };

    let ch = transport_ssh::SshChannel::connect(target, 120, 32)
        .await
        .expect("自跳两跳握手应成功");
    // 链上 shell 可用：命令行回显含 $((40+2)) 原文，只有真实输出含展开值 42
    let mut rx = ch.subscribe_output();
    ch.write(b"echo TINYSSH_JUMP_$((40+2))\r\n").await.unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let remain = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(
            !remain.is_zero(),
            "标记未在 20s 内出现: {}",
            String::from_utf8_lossy(&buf)
        );
        match tokio::time::timeout(remain, rx.recv()).await {
            Ok(Ok(chunk)) => {
                buf.extend_from_slice(&chunk);
                // 只匹配展开值：命令行回显是 $((40+2)) 原文，不含 TINYSSH_JUMP_42
                if buf.windows(15).any(|w| w == b"TINYSSH_JUMP_42") {
                    break;
                }
            }
            Ok(Err(_)) | Err(_) => continue,
        }
    }
    assert_eq!(
        *order.lock().unwrap(),
        vec!["hop", "target"],
        "TOFU 门必须跳板先、目标后（FIFO）"
    );
    ch.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn jump_auth_failure_attributed_to_hop() {
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let _guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    let (addr, port, username, secret) = tinyssh_testbed::sshd_endpoint();

    // 跳板密码错误：错误串必须点名是哪一跳（第1跳(bad)），不得让人误判为目标认证失败
    let target = transport_ssh::SshTarget {
        address: addr.clone(),
        port,
        username: username.clone(),
        auth_type: session_api::AuthType::Password,
        secret,
        host_key_check: None, // 测试：全接受（TOFU 归因由上一用例覆盖）
        kb_prompt_check: None,
        hops: vec![transport_ssh::JumpHop {
            address: addr,
            port,
            username,
            auth_type: session_api::AuthType::Password,
            secret: "definitely-wrong-password".into(),
            host_key_check: None,
            kb_prompt_check: None,
            label: "第1跳(bad)".into(),
        }],
    };
    let err = match transport_ssh::SshChannel::connect(target, 120, 32).await {
        Ok(_) => panic!("跳板密码错误必须失败"),
        Err(e) => e,
    };
    let msg = err.to_string();
    assert!(msg.contains("第1跳(bad)"), "失败归因缺跳名: {msg}");
}
