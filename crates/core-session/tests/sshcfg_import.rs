//! T21（路线图⑨）~/.ssh/config 导入与 ssh-agent 集成测试。
//! 覆盖 GUI 导入面板背后的完整内核链路：解析预览（跳过通配符/Match）
//! → 勾选导入（IdentityFile→Key 身份、无凭据→Agent）→ Agent 认证真实建连。
//! 主密钥缺省走 env（未导出时测试内自设，不触 OS 钥匙串）；
//! agent 连接段另需 TINYSSH_E2E_SSHD=1 + docker 容器。

use core_session::SessionManager;
use session_api::*;
use std::io::Write as _;
use std::process::Stdio;
use std::time::Duration;

// 主密钥走 env（vault 解析序 env > OS 钥匙串）：避免测试二进制重编译后
// 签名变化触发 macOS 钥匙串授权弹窗并阻塞测试进程。
fn test_master_key() {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
}

fn write_config(dir: &std::path::Path, key_path: &std::path::Path) -> std::path::PathBuf {
    let cfg = dir.join("config");
    std::fs::write(
        &cfg,
        format!(
            "# 合成走查 config\n\
             Host e2e-agent\n\
             \x20 HostName 127.0.0.1\n\
             \x20 Port 2222\n\
             \x20 User root\n\n\
             Host e2e-key\n\
             \x20 HostName 127.0.0.1\n\
             \x20 Port 2222\n\
             \x20 User root\n\
             \x20 IdentityFile {}\n\n\
             Host *.wildcard.example\n\
             \x20 User nobody\n\n\
             Match host badhost\n\
             \x20 User should_not_import\n\n\
             Host alias1 alias2\n\
             \x20 HostName 127.0.0.1\n",
            key_path.display()
        ),
    )
    .unwrap();
    cfg
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preview_and_import_local_parts() {
    test_master_key();
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("id_test");
    let kg = std::process::Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&key)
        .output()
        .expect("ssh-keygen");
    assert!(kg.status.success(), "{}", String::from_utf8_lossy(&kg.stderr));
    let cfg = write_config(dir.path(), &key);

    let db = dir.path().join("t.db");
    let m = SessionManager::open(&db).unwrap();

    // 预览：通配符与 Match 块跳过；多模式拆条目；身份有无如实标注
    let preview = m.ssh_config_preview(Some(&cfg)).await.unwrap();
    let names: Vec<&str> = preview.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, vec!["e2e-agent", "e2e-key", "alias1", "alias2"]);
    let by_name = |n: &str| preview.iter().find(|p| p.name == n).unwrap();
    assert!(!by_name("e2e-agent").has_identity);
    assert!(by_name("e2e-key").has_identity);
    assert!(by_name("alias1").address == "127.0.0.1" && by_name("alias2").address == "127.0.0.1");
    assert_eq!(by_name("e2e-key").port, 2222);
    assert_eq!(by_name("e2e-key").username, "root");
    // alias 块无 User → 回落当前用户（测试进程 USER 非空），端口缺省 22
    assert_eq!(by_name("alias1").port, 22);
    assert!(!preview.iter().any(|p| p.already_imported));

    // 导入：Key 条目建身份，Agent 条目零密钥落库
    let outs = m
        .ssh_config_import(&Actor::Human, Some(&cfg), &["e2e-key".into(), "e2e-agent".into()])
        .await;
    assert_eq!(outs.len(), 2, "{outs:?}");
    assert!(outs.iter().all(|o| o.error.is_none()), "{outs:?}");

    let hosts = m.list_hosts(&Actor::Human).await.unwrap();
    // 3 = 内置「本机」+ 两条导入
    assert_eq!(hosts.len(), 3, "{hosts:?}");
    let agent_host = hosts.iter().find(|h| h.name == "e2e-agent").unwrap();
    assert_eq!(agent_host.auth_type, AuthType::Agent);
    assert!(agent_host.identity_id.is_none(), "Agent 主机不落任何密钥材料");
    assert_eq!(agent_host.tags, vec!["ssh-config"]);
    let key_host = hosts.iter().find(|h| h.name == "e2e-key").unwrap();
    assert_eq!(key_host.auth_type, AuthType::Key);
    assert!(key_host.identity_id.is_some());

    // 身份确已落库（指纹非空）
    let ids = m.list_identities(&Actor::Human).await.unwrap();
    assert_eq!(ids.len(), 1);
    assert!(!ids[0].fingerprint.is_empty());

    // 再预览：两条目应标 already_imported（对账生效）
    let preview2 = m.ssh_config_preview(Some(&cfg)).await.unwrap();
    let by2 = |n: &str| preview2.iter().find(|p| p.name == n).unwrap();
    assert!(by2("e2e-key").already_imported && by2("e2e-agent").already_imported);
    assert!(!by2("alias1").already_imported);
}

/// Agent 认证全链路：一次性 agent + 容器公钥 → 导入的 Agent 主机真实建连。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn imported_agent_host_connects_via_ssh_agent() {
    let sshd_enabled = std::env::var("TINYSSH_E2E_SSHD").map(|v| v == "1").unwrap_or(false);
    if !sshd_enabled {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let _guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(Duration::from_secs(30)).await;
    test_master_key();

    let dir = tempfile::tempdir().unwrap();
    let keep = dir.into_path(); // agent/容器清理前不能删
    let key = keep.join("id_agent");
    let kg = std::process::Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "t21-core-agent", "-f"])
        .arg(&key)
        .output()
        .unwrap();
    assert!(kg.status.success());

    let sock = keep.join("agent.sock");
    let agent_out = std::process::Command::new("ssh-agent")
        .arg("-a")
        .arg(&sock)
        .output()
        .unwrap();
    assert!(agent_out.status.success());
    let envs = String::from_utf8_lossy(&agent_out.stdout).to_string();
    let sock_str = envs.split("SSH_AUTH_SOCK=").nth(1).unwrap().split(';').next().unwrap().to_string();
    let agent_pid = envs.split("SSH_AGENT_PID=").nth(1).unwrap().split(';').next().unwrap().to_string();

    struct Cleanup(String, std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::process::Command::new("kill").arg(&self.0).output();
            let _ = std::process::Command::new("docker")
                .args(["exec", "tinyssh-e2e", "sed", "-i", "/t21-core-agent$/d",
                       "/root/.ssh/authorized_keys"])
                .output();
            let _ = std::fs::remove_dir_all(&self.1);
        }
    }
    let _cleanup = Cleanup(agent_pid, keep.clone());

    let add = std::process::Command::new("ssh-add")
        .env("SSH_AUTH_SOCK", &sock_str)
        .arg(&key)
        .output()
        .unwrap();
    assert!(add.status.success(), "{}", String::from_utf8_lossy(&add.stderr));

    let pubkey = std::fs::read_to_string(key.with_extension("pub")).unwrap();
    let mut child = std::process::Command::new("docker")
        .args(["exec", "-i", "tinyssh-e2e", "sh", "-c",
               "mkdir -p /root/.ssh && chmod 700 /root/.ssh && touch /root/.ssh/authorized_keys && cat >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(pubkey.as_bytes()).unwrap();
    assert!(child.wait().unwrap().success());

    // 合成 config（无 IdentityFile 条目）→ 导入 → Agent 主机建连
    let cfg = keep.join("config");
    std::fs::write(
        &cfg,
        "Host e2e-agent\n  HostName 127.0.0.1\n  Port 2222\n  User root\n",
    )
    .unwrap();
    let m = SessionManager::open(&keep.join("t.db")).unwrap();
    let outs = m
        .ssh_config_import(&Actor::Human, Some(&cfg), &["e2e-agent".into()])
        .await;
    assert!(outs[0].error.is_none(), "{:?}", outs[0]);

    // 指纹门测试侧应答器（与 MCP e2e 同构）
    let m2 = m.clone();
    tokio::spawn(async move {
        let human = Actor::Human;
        loop {
            if let Ok(items) = m2.pending_host_keys(&human).await {
                for it in items {
                    let _ = m2.decide_host_key(&human, &it.id, true).await;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    });

    let prev_sock = std::env::var("SSH_AUTH_SOCK").ok();
    std::env::set_var("SSH_AUTH_SOCK", &sock_str);
    let sid = m
        .create_session(&Actor::Human, CreateSessionReq { host_id: outs[0].host_id.clone().unwrap() })
        .await;
    if let Some(s) = prev_sock {
        std::env::set_var("SSH_AUTH_SOCK", s);
    }
    let sid = sid.expect("agent-host session create");
    assert!(sid.starts_with("s-"));
    m.close_session(&Actor::Human, sid).await.unwrap();
}
