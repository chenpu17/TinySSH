//! ProxyJump（FR-9）核心链路 e2e（TINYSSH_E2E_SSHD=1，同一 e2e sshd 自跳）：
//! ①TOFU 门 FIFO——跳板卡先挂（jump_note=第1跳）、目标卡后挂；②批准后指纹
//! 各自按主机落 vault（同 sshd → 两行指纹相等）；③删除保护贯穿核心门；
//! ④跳板认证失败错误串点名跳板。守卫先于就绪等待（无 docker 开发机跳过）。

use core_session::SessionManager;
use session_api::*;
use std::sync::Arc;
use std::time::{Duration, Instant};

async fn manager() -> Arc<SessionManager> {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t.db");
    std::mem::forget(dir);
    SessionManager::open(&db).unwrap()
}

fn human() -> Actor {
    Actor::Human
}

fn host_draft(
    name: &str,
    port: u16,
    username: &str,
    password: &str,
    jump: Option<String>,
) -> HostDraft {
    HostDraft {
        id: None,
        name: name.into(),
        address: "127.0.0.1".into(),
        port: Some(port),
        username: username.into(),
        auth: AuthDraft::Password {
            password: password.into(),
        },
        tags: vec![],
        charset: Charset::Utf8,
        shell_integration: None,
        jump_host_id: jump,
    }
}

async fn wait_host_key(m: &SessionManager, host_id: &str, budget: Duration) -> PendingHostKey {
    let start = Instant::now();
    loop {
        assert!(
            start.elapsed() < budget,
            "host key pending 未在预算内出现: {host_id}"
        );
        let list = m.pending_host_keys(&human()).await.unwrap();
        if let Some(it) = list.into_iter().find(|it| it.host_id == host_id) {
            return it;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn core_self_jump_gate_order_fingerprints_delete_protection() {
    if !std::env::var("TINYSSH_E2E_SSHD")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let lock = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(Duration::from_secs(30)).await;
    let _lock = lock;
    let (_host, port, username, password) = tinyssh_testbed::sshd_endpoint();
    let m = manager().await;
    let jid = m
        .upsert_host(
            &human(),
            host_draft("jump-e2e", port, &username, &password, None),
        )
        .await
        .unwrap();
    let tid = m
        .upsert_host(
            &human(),
            host_draft("target-e2e", port, &username, &password, Some(jid.clone())),
        )
        .await
        .unwrap();

    // 建连：门序断言挂起在「跳板门出现而目标门未出现」——轮询期同时盯目标卡
    let m2 = m.clone();
    let tid_spawn = tid.clone();
    let t = tokio::spawn(async move {
        m2.create_session(&human(), CreateSessionReq { host_id: tid_spawn })
            .await
    });
    let start = Instant::now();
    let it_hop = loop {
        assert!(start.elapsed() < Duration::from_secs(20), "跳板门未出现");
        let list = m.pending_host_keys(&human()).await.unwrap();
        if let Some(it) = list.iter().find(|x| x.host_id == jid) {
            assert!(
                !list.iter().any(|x| x.host_id == tid),
                "跳板门必须先于目标门挂起（FIFO）"
            );
            assert_eq!(it.jump_note.as_deref(), Some("第1跳"), "跳板卡面标注归属");
            break it.clone();
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    m.decide_host_key(&human(), &it_hop.id, true).await.unwrap();

    // 目标门随后出现：无跳板标注（目标自身的门）
    let it_target = wait_host_key(&m, &tid, Duration::from_secs(20)).await;
    assert_eq!(it_target.jump_note, None);
    m.decide_host_key(&human(), &it_target.id, true)
        .await
        .unwrap();

    let sid = t.await.unwrap().expect("两门齐批后自跳建连应成功");
    // 指纹各自行落库（同 sshd → 相等），且都非空
    let fp_j = m.center.vault.host_fingerprint(&jid).unwrap();
    let fp_t = m.center.vault.host_fingerprint(&tid).unwrap();
    assert!(fp_j.is_some() && fp_t.is_some(), "跳板与目标指纹都要落库");
    assert_eq!(fp_j, fp_t, "同一 sshd 指纹一致");

    // 删除保护贯穿核心门：跳板被 target-e2e 引用 → JumpHostInUse
    let e = m.delete_host(&human(), jid.clone()).await.unwrap_err();
    assert!(matches!(e, Error::JumpHostInUse { .. }), "{e:?}");

    m.close_session(&human(), sid).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn core_jump_auth_failure_names_the_hop() {
    if !std::env::var("TINYSSH_E2E_SSHD")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let lock = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(Duration::from_secs(30)).await;
    let _lock = lock;
    let (_host, port, username, password) = tinyssh_testbed::sshd_endpoint();
    let m = manager().await;
    // 密码错误的跳板
    let bad = m
        .upsert_host(
            &human(),
            host_draft("jump-bad", port, &username, "wrong-pass", None),
        )
        .await
        .unwrap();
    let target = m
        .upsert_host(
            &human(),
            host_draft("behind-bad", port, &username, &password, Some(bad.clone())),
        )
        .await
        .unwrap();
    let err = m
        .create_session(&human(), CreateSessionReq { host_id: target })
        .await
        .unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("第1跳(jump-bad)"),
        "核心层失败归因缺跳板名: {msg}"
    );
    assert!(
        !m.list_sessions(&human())
            .await
            .unwrap()
            .iter()
            .any(|s| { s.host_id == bad }),
        "失败建连不得残留会话"
    );
}
