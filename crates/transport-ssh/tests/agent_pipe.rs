//! ssh-agent Windows 命名管道活体验证：连真实 OpenSSH Authentication Agent 服务
//! （\\.\pipe\openssh-ssh-agent），列身份 + 真签名 + 未加载密钥负例。
//! 前置：服务 Running 且已加载探针密钥（注释 tinyssh-agent-pipe-probe），如：
//!   powershell: Set-Service ssh-agent -StartupType Manual; Start-Service ssh-agent
//!   ssh-keygen -t ed25519 -f probe -N "" -C tinyssh-agent-pipe-probe
//!   ssh-add probe
//! 门控：TINYSSH_E2E_AGENT=1 才执行（无服务环境直接跳过，不假红）。
//! 协议校验点：列身份含探针密钥；签名回包为良构 ssh 编码签名
//! （string alg-name || bytes sig，ed25519 alg 名必须 ssh-ed25519）；
//! 未加载密钥的签名请求 → agent FAILURE（russh AgentFailure）。

use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::PublicKey;

fn agent_enabled() -> bool {
    std::env::var("TINYSSH_E2E_AGENT")
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// 弃置密钥（永不入 agent）的公钥——负例：agent 对未加载密钥必须回 FAILURE。
const UNLOADED_PUB: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINDbq8SZ6Ygjk/qP63DrE0TDKeJu3HFYdbg2uLm4l/QA \
     tinyssh-agent-pipe-unloaded";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_pipe_lists_signs_and_rejects_unloaded() {
    if !agent_enabled() {
        eprintln!("skip: TINYSSH_E2E_AGENT=1 未设置");
        return;
    }
    let pipe = std::env::var("TINYSSH_SSH_AGENT_PIPE")
        .unwrap_or_else(|_| r"\\.\pipe\openssh-ssh-agent".into());
    let mut agent = AgentClient::connect_named_pipe(&pipe)
        .await
        .expect("连接命名管道 agent 失败（服务在运行吗？）");
    let identities = agent
        .request_identities()
        .await
        .expect("request_identities 失败");
    assert!(
        !identities.is_empty(),
        "agent 中没有身份（先 ssh-add 探针密钥）"
    );
    let probe = identities
        .iter()
        .find(|i| i.comment().contains("tinyssh-agent-pipe-probe"))
        .unwrap_or_else(|| {
            panic!(
                "找不到探针密钥，实际身份: {:?}",
                identities.iter().map(|i| i.comment().to_owned()).collect::<Vec<_>>()
            )
        })
        .clone();

    // 正例：对已知数据签名。russh Signer 契约：返回 = 原请求数据 || 签名追加
    //（客户端以长度变化检测并以整包发送，见 encrypted.rs Signed 消费处），
    // 签名段自 data.len() 起，为良构 ssh 签名（string alg-name || bytes sig 体）。
    let data = b"tinyssh-agent-pipe-probe-signature-request".to_vec();
    let req_len = data.len();
    let sig = agent
        .sign_request(&probe, None, data.clone())
        .await
        .expect("sign_request 失败");
    assert!(sig.len() > req_len + 16, "签名回包过短: {} B", sig.len());
    assert_eq!(&sig[..req_len], &data[..], "返回头部应是原请求数据");
    let s = &sig[req_len..];
    let outer_len = u32::from_be_bytes([s[0], s[1], s[2], s[3]]) as usize;
    assert_eq!(outer_len, s.len() - 4, "外层长度前缀应等于余下字节数");
    let alg_len = u32::from_be_bytes([s[4], s[5], s[6], s[7]]) as usize;
    let alg = String::from_utf8_lossy(&s[8..8 + alg_len]).into_owned();
    assert_eq!(alg, "ssh-ed25519", "签名算法名不符: {alg}");
    assert!(s.len() > 8 + alg_len, "签名 blob 缺 sig 体");

    // 重复签名幂等：同数据再签，agent 状态无副作用
    let sig2 = agent
        .sign_request(&probe, None, data)
        .await
        .expect("第二次签名被拒（agent 状态异常）");
    assert_eq!(sig, sig2, "同数据同密钥两次签名应一致（ed25519 确定性）");

    // 负例：未加载密钥 → agent 回 FAILURE（不得 panic/挂起）
    let foreign: PublicKey = UNLOADED_PUB.parse().expect("解析弃置公钥");
    let ghost = AgentIdentity::PublicKey {
        key: foreign,
        comment: "tinyssh-agent-pipe-unloaded".into(),
    };
    match agent.sign_request(&ghost, None, b"data".to_vec()).await {
        Err(russh::keys::Error::AgentFailure) => {} // 预期：agent 拒签未加载密钥
        other => panic!("未加载密钥应回 AgentFailure，得到 {other:?}"),
    }
}
