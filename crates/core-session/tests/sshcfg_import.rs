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
    assert!(
        kg.status.success(),
        "{}",
        String::from_utf8_lossy(&kg.stderr)
    );
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

    // 导入：Key 条目建身份；e2e-agent 与 e2e-key 同三元组（127.0.0.1:2222 root）
    // → 按 DF7.3 判 Duplicate 跳过（R22 M3 语义：不双落库同一目标）
    let outs = m
        .ssh_config_import(
            &Actor::Human,
            Some(&cfg),
            &["e2e-key".into(), "e2e-agent".into()],
            false,
        )
        .await;
    assert_eq!(outs.len(), 2, "{outs:?}");
    assert!(outs.iter().all(|o| o.error.is_none()), "{outs:?}");
    assert!(outs[0].host_id.is_some(), "{outs:?}");
    assert_eq!(
        outs[1].skipped_reason,
        Some(SshSkipReason::Duplicate),
        "{outs:?}"
    );

    let hosts = m.list_hosts(&Actor::Human).await.unwrap();
    // 2 = 内置「本机」+ e2e-key（e2e-agent 同三元组被跳过）
    assert_eq!(hosts.len(), 2, "{hosts:?}");
    let key_host = hosts.iter().find(|h| h.name == "e2e-key").unwrap();
    assert_eq!(key_host.auth_type, AuthType::Key);
    assert!(key_host.identity_id.is_some());
    assert_eq!(key_host.tags, vec!["ssh-config"]);

    // 身份确已落库（指纹非空）
    let ids = m.list_identities(&Actor::Human).await.unwrap();
    assert_eq!(ids.len(), 1);
    assert!(!ids[0].fingerprint.is_empty());

    // 再预览：两条目应标 already_imported（e2e-agent 按三元组对账命中）
    let preview2 = m.ssh_config_preview(Some(&cfg)).await.unwrap();
    let by2 = |n: &str| preview2.iter().find(|p| p.name == n).unwrap();
    assert!(by2("e2e-key").already_imported && by2("e2e-agent").already_imported);
    assert!(!by2("alias1").already_imported);
}

/// C7（R22）：DF7.1 分级预览 + Blocked/Duplicate 跳过 + DF7.3 overwrite 覆盖
/// + DF7.5 无 User 不静默 root。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn c7_classification_skip_and_overwrite() {
    test_master_key();
    let dir = tempfile::tempdir().unwrap();
    let cfg = dir.path().join("config");
    std::fs::write(
        &cfg,
        "Host ok1\n  HostName 10.9.0.1\n  User root\n  ServerAliveInterval 30\n\
         Host blocked\n  HostName 10.9.0.2\n  User root\n  ProxyJump bastion\n\
         Host nouser\n  HostName 10.9.0.3\n\
         Host dup\n  HostName 10.9.0.4\n  User root\n",
    )
    .unwrap();
    let db = dir.path().join("t.db");
    let m = SessionManager::open(&db).unwrap();

    let pv = m.ssh_config_preview(Some(&cfg)).await.unwrap();
    let by = |n: &str| pv.iter().find(|p| p.name == n).unwrap();
    // ok1：仅警告级（ServerAliveInterval），可直接导入 + 溯源在位
    let ok1 = by("ok1");
    assert!(ok1.directly_importable && ok1.user_specified, "{ok1:?}");
    assert_eq!(ok1.unsupported.len(), 1, "{:?}", ok1.unsupported);
    assert_eq!(ok1.unsupported[0].level, SshUnsupportedLevel::Warning);
    assert_eq!(ok1.unsupported[0].directive, "serveraliveinterval");
    assert!(ok1.source_line >= 1 && !ok1.source_file.is_empty());
    // blocked：ProxyJump 阻断
    let blocked = by("blocked");
    assert!(!blocked.directly_importable);
    assert!(blocked
        .unsupported
        .iter()
        .any(|u| u.level == SshUnsupportedLevel::Blocking && u.directive == "proxyjump"));
    // nouser：DF7.5 未指定用户 → 不可直接导入
    let nouser = by("nouser");
    assert!(!nouser.user_specified && !nouser.directly_importable);

    // 预置同名主机（用户名不同——证明覆盖以 config 为准）
    m.upsert_host(
        &Actor::Human,
        HostDraft {
            id: None,
            name: "dup".into(),
            address: "10.9.0.4".into(),
            port: Some(22),
            username: "old".into(),
            auth: AuthDraft::Agent,
            tags: vec![],
            charset: Charset::Utf8,
            shell_integration: None,
        },
    )
    .await
    .unwrap();

    // 全量请求（overwrite=false）：ok1 导入；blocked/nouser=Blocked；dup=Duplicate
    let outs = m
        .ssh_config_import(
            &Actor::Human,
            Some(&cfg),
            &[
                "ok1".into(),
                "blocked".into(),
                "nouser".into(),
                "dup".into(),
            ],
            false,
        )
        .await;
    let byo = |n: &str| outs.iter().find(|o| o.name == n).unwrap();
    assert!(byo("ok1").host_id.is_some(), "{outs:?}");
    assert!(byo("ok1").skipped_reason.is_none());
    // 无 IdentityFile 条目 → Agent 主机（零密钥材料落库）
    let ok1_host = m
        .list_hosts(&Actor::Human)
        .await
        .unwrap()
        .into_iter()
        .find(|h| h.name == "ok1")
        .unwrap();
    assert_eq!(ok1_host.auth_type, AuthType::Agent);
    assert!(ok1_host.identity_id.is_none());
    assert_eq!(byo("blocked").skipped_reason, Some(SshSkipReason::Blocked));
    assert_eq!(byo("nouser").skipped_reason, Some(SshSkipReason::Blocked));
    assert_eq!(byo("dup").skipped_reason, Some(SshSkipReason::Duplicate));
    assert!(byo("dup").host_id.is_none() && byo("dup").error.is_none());

    // overwrite=true：dup 以既有 id 覆盖写入（username 来自 config）
    let existing = m
        .list_hosts(&Actor::Human)
        .await
        .unwrap()
        .into_iter()
        .find(|h| h.name == "dup")
        .unwrap();
    let outs2 = m
        .ssh_config_import(&Actor::Human, Some(&cfg), &["dup".into()], true)
        .await;
    assert_eq!(
        outs2[0].host_id.as_deref(),
        Some(existing.id.as_str()),
        "{outs2:?}"
    );
    let after = m.list_hosts(&Actor::Human).await.unwrap();
    assert_eq!(after.iter().filter(|h| h.name == "dup").count(), 1);
    assert_eq!(
        after.iter().find(|h| h.name == "dup").unwrap().username,
        "root"
    );
}

/// C7（rev-r22 M3 判别，旧代码必红）：同批两条同三元组（不同名）条目——
/// 第二条按 Duplicate 跳过，不双落库（批内写入对后续条目可见）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn c7_batch_internal_duplicate_skipped() {
    test_master_key();
    let dir = tempfile::tempdir().unwrap();
    let cfg = dir.path().join("config");
    std::fs::write(
        &cfg,
        "Host n1\n  HostName 10.9.1.1\n  User root\n\
         Host n2\n  HostName 10.9.1.1\n  User root\n",
    )
    .unwrap();
    let db = dir.path().join("t.db");
    let m = SessionManager::open(&db).unwrap();

    let outs = m
        .ssh_config_import(
            &Actor::Human,
            Some(&cfg),
            &["n1".into(), "n2".into()],
            false,
        )
        .await;
    assert_eq!(outs.len(), 2, "{outs:?}");
    assert!(outs[0].host_id.is_some(), "{outs:?}");
    assert_eq!(
        outs[1].skipped_reason,
        Some(SshSkipReason::Duplicate),
        "{outs:?}"
    );
    assert!(outs[1].host_id.is_none());

    let hosts = m.list_hosts(&Actor::Human).await.unwrap();
    assert_eq!(
        hosts.iter().filter(|h| h.address == "10.9.1.1").count(),
        1,
        "同三元组只落一条: {hosts:?}"
    );
}

/// Agent 认证全链路：一次性 agent + 容器公钥 → 导入的 Agent 主机真实建连。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn imported_agent_host_connects_via_ssh_agent() {
    let sshd_enabled = std::env::var("TINYSSH_E2E_SSHD")
        .map(|v| v == "1")
        .unwrap_or(false);
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
        .args([
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-C",
            "t21-core-agent",
            "-f",
        ])
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
    let sock_str = envs
        .split("SSH_AUTH_SOCK=")
        .nth(1)
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let agent_pid = envs
        .split("SSH_AGENT_PID=")
        .nth(1)
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();

    struct Cleanup(String, std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::process::Command::new("kill").arg(&self.0).output();
            let _ = std::process::Command::new("docker")
                .args([
                    "exec",
                    "tinyssh-e2e",
                    "sed",
                    "-i",
                    "/t21-core-agent$/d",
                    "/root/.ssh/authorized_keys",
                ])
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
    assert!(
        add.status.success(),
        "{}",
        String::from_utf8_lossy(&add.stderr)
    );

    let pubkey = std::fs::read_to_string(key.with_extension("pub")).unwrap();
    let mut child = std::process::Command::new("docker")
        .args(["exec", "-i", "tinyssh-e2e", "sh", "-c",
               "mkdir -p /root/.ssh && chmod 700 /root/.ssh && touch /root/.ssh/authorized_keys && cat >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(pubkey.as_bytes())
        .unwrap();
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
        .ssh_config_import(&Actor::Human, Some(&cfg), &["e2e-agent".into()], false)
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
        .create_session(
            &Actor::Human,
            CreateSessionReq {
                host_id: outs[0].host_id.clone().unwrap(),
            },
        )
        .await;
    if let Some(s) = prev_sock {
        std::env::set_var("SSH_AUTH_SOCK", s);
    }
    let sid = sid.expect("agent-host session create");
    assert!(sid.starts_with("s-"));
    m.close_session(&Actor::Human, sid).await.unwrap();
}
