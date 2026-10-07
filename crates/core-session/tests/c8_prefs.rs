//! C8 偏好与主机元数据（R15）核心契约：workspace 整取整存/版本归一、收藏、
//! 建连打点、IdentityInUse 引用检查（DF8.4）、delete_host 元数据联动。

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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn workspace_roundtrip_and_version_normalization() {
    let m = manager().await;
    // 未写入 → Default（迁移保证键存在，值无 hostbar）
    let ws = m.get_workspace(&human()).await.unwrap();
    assert_eq!(ws.schema_version, 1);
    assert!(ws.hostbar.is_none());
    // 整存：schemaVersion 由核心归一（客户端伪造 99 不落库）
    let mut ws2 = ws.clone();
    ws2.schema_version = 99;
    ws2.chrome = "light".into();
    ws2.hostbar = Some(HostbarPrefs { open: false, width: 260 });
    m.set_workspace(&human(), ws2).await.unwrap();
    let back = m.get_workspace(&human()).await.unwrap();
    assert_eq!(back.schema_version, 1);
    assert_eq!(back.chrome, "light");
    assert_eq!(back.hostbar, Some(HostbarPrefs { open: false, width: 260 }));
    // 整取一致（跨调用读同一行）
    let again = m.get_workspace(&human()).await.unwrap();
    assert_eq!(again, back);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn favorites_metadata_and_local_touch() {
    let m = manager().await;
    // 未知主机收藏拒绝
    let e = m.set_host_favorite(&human(), "h-none".into(), true).await.unwrap_err();
    assert!(matches!(e, Error::InvalidInput(_)), "{e:?}");
    // local 会话成功建连 → local 主机 last_connected_at 打点
    m.create_session(&human(), CreateSessionReq { host_id: "local".into() })
        .await
        .unwrap();
    let meta = m.list_host_metadata(&human()).await.unwrap();
    let local = meta.iter().find(|x| x.host_id == "local").expect("local 打点缺失");
    assert!(!local.favorite);
    assert!(local.last_connected_at.is_some());
    // 收藏翻转
    m.set_host_favorite(&human(), "local".into(), true).await.unwrap();
    let meta = m.list_host_metadata(&human()).await.unwrap();
    assert!(meta.iter().find(|x| x.host_id == "local").unwrap().favorite);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn identity_in_use_reference_check() {
    let m = manager().await;
    let meta = m
        .create_identity(&human(), IdentityReq::Generate { label: "k1".into(), kind: KeyKind::Ed25519 })
        .await
        .unwrap();
    let hid = m
        .upsert_host(&human(), HostDraft {
            id: None,
            name: "prod-1".into(),
            address: "10.0.0.9".into(),
            port: Some(22),
            username: "ops".into(),
            auth: AuthDraft::Key { identity_id: meta.id.clone() },
            tags: vec![],
            charset: Default::default(),
        })
        .await
        .unwrap();
    // 被引用 → IdentityInUse 附主机名（DF8.4），不落删除
    let e = m.delete_identity(&human(), meta.id.clone()).await.unwrap_err();
    match e {
        Error::IdentityInUse { host_names } => assert_eq!(host_names, vec!["prod-1".to_string()]),
        other => panic!("期望 IdentityInUse，实得 {other:?}"),
    }
    // 删除主机（元数据联动）后引用解除 → 可删
    m.delete_host(&human(), hid).await.unwrap();
    m.delete_identity(&human(), meta.id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn recents_empty_when_only_local() {
    let m = manager().await;
    // 无记录 → 空（不虚构）
    assert!(m.list_recent_hosts(&human()).await.unwrap().is_empty());
    // local 会话不入最近连接（DF8.5 排除 local）；派生口径（分组/倒序/上限/
    // 删除主机无幽灵）由 vault 单测 c8_favorites_recents_identity_refs_and_cascade 覆盖
    m.create_session(&human(), CreateSessionReq { host_id: "local".into() })
        .await
        .unwrap();
    assert!(m.list_recent_hosts(&human()).await.unwrap().is_empty());
}
