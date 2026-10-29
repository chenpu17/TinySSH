//! ProxyJump（FR-9）守卫契约（离线，零网络）：upsert 引用校验（缺失/自引用/
//! 「本机」/环/超深）、delete 引用保护（JumpHostInUse）、合法三层链放行、
//! 解引用后可删。建连期展链（resolve_jump_hops）的再验由 sshd 自跳 e2e 覆盖。

use core_session::SessionManager;
use session_api::*;
use std::sync::Arc;

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

fn draft(name: &str, jump: Option<String>) -> HostDraft {
    HostDraft {
        id: None,
        name: name.into(),
        address: format!("10.9.0.{}", 3 + name.len() % 250),
        port: Some(22),
        username: "ops".into(),
        auth: AuthDraft::Password {
            password: "pw".into(),
        },
        tags: vec![],
        charset: Charset::Utf8,
        shell_integration: None,
        jump_host_id: jump,
        startup_command: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn jump_ref_guards() {
    let m = manager().await;
    // 引用缺失：目标主机不存在
    let e = m
        .upsert_host(&human(), draft("a", Some("h-none".into())))
        .await
        .unwrap_err();
    assert!(matches!(e, Error::JumpChainInvalid(_)), "{e:?}");
    // 引用「本机」：本机不作为跳板
    let e = m
        .upsert_host(&human(), draft("a", Some("local".into())))
        .await
        .unwrap_err();
    assert!(matches!(e, Error::JumpChainInvalid(_)), "{e:?}");

    // 链底：h1 无跳板
    let h1 = m.upsert_host(&human(), draft("h1", None)).await.unwrap();
    // h2 → h1 合法；编辑把自己设为跳板（自引用）拒绝
    let h2 = m
        .upsert_host(&human(), draft("h2", Some(h1.clone())))
        .await
        .unwrap();
    let e = m
        .upsert_host(
            &human(),
            HostDraft {
                id: Some(h2.clone()),
                ..draft("h2", Some(h2.clone()))
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(e, Error::JumpChainInvalid(_)), "{e:?}");
    // 成环：h1 → h2（h2 → h1 已存在）拒绝
    let e = m
        .upsert_host(
            &human(),
            HostDraft {
                id: Some(h1.clone()),
                ..draft("h1", Some(h2.clone()))
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(e, Error::JumpChainInvalid(_)), "{e:?}");

    // 链深：h3→h2→h1 两层、h4→h3→h2→h1 三层均合法；再深一层（X→h4）拒绝
    let h3 = m
        .upsert_host(&human(), draft("h3", Some(h2.clone())))
        .await
        .unwrap();
    let h4 = m
        .upsert_host(&human(), draft("h4", Some(h3.clone())))
        .await
        .unwrap();
    let e = m
        .upsert_host(&human(), draft("deep", Some(h4.clone())))
        .await
        .unwrap_err();
    assert!(matches!(e, Error::JumpChainInvalid(_)), "{e:?}");
    // 恰好三层放行
    m.upsert_host(&human(), draft("ok3", Some(h3.clone())))
        .await
        .unwrap();

    // 删除保护（引用关系：h2→h1、h3→h2、h4→h3、ok3→h3）：
    // h1 被 h2 引用 → JumpHostInUse 附引用主机名
    let e = m.delete_host(&human(), h1.clone()).await.unwrap_err();
    match e {
        Error::JumpHostInUse { host_names } => {
            assert_eq!(host_names, vec!["h2".to_string()], "{host_names:?}");
        }
        other => panic!("期望 JumpHostInUse，得到 {other:?}"),
    }
    // 解引用（h2 清掉跳板设置，Keep 凭据）→ h1 无人引用 → 可删
    m.upsert_host(
        &human(),
        HostDraft {
            id: Some(h2.clone()),
            ..draft("h2", None)
        },
    )
    .await
    .unwrap();
    m.delete_host(&human(), h1.clone()).await.unwrap();
    // h2 仍被 h3 引用 → 删除拒绝
    let e = m.delete_host(&human(), h2.clone()).await.unwrap_err();
    assert!(matches!(e, Error::JumpHostInUse { .. }), "{e:?}");
    let hosts = m.list_hosts(&human()).await.unwrap();
    assert!(hosts.iter().all(|h| h.id != h1), "h1 已不在列表");
    assert!(hosts.iter().any(|h| h.id == h2), "h2 仍在列表");
}
