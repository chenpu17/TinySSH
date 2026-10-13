//! 十七轮「快速连接」：内存态临时主机（quick- 前缀）的注册校验、凭据即席解析、
//! 已知性/可见性边界（vault 无行、主机列表不出现）与 TOFU 信任的内存生命周期
//! （同指纹放行、换指纹 Changed、vault 永不落）。不真连：目标统一不可路由。

use super::*;
use session_api::{
    Actor, AuthDraft, BeginConnectionOpts, CancelOutcome, Charset, HostDraft, IdentityReq,
};
use std::sync::atomic::{AtomicU32, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::Duration;

fn mgr() -> Arc<SessionManager> {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = std::env::temp_dir().join(format!("quick-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    SessionManager::open(&dir.join("t.db")).unwrap()
}

static SEQ: AtomicU32 = AtomicU32::new(0);

/// 不可路由目标（同 c1_tests 口径：SYN 长挂，attempt 停在 Connecting 可从容断言）。
fn draft() -> HostDraft {
    let n = SEQ.fetch_add(1, AtomicOrdering::SeqCst);
    HostDraft {
        id: None,
        name: String::new(),
        address: format!("10.255.255.{}", 1 + n % 250),
        port: Some(2222),
        username: "root".into(),
        auth: AuthDraft::Password { password: "qp".into() },
        tags: vec![],
        charset: Charset::Utf8,
        shell_integration: None,
    }
}

fn reg_count(m: &SessionManager) -> usize {
    m.center.quick_hosts.lock().unwrap().len()
}

async fn cancel_quietly(m: &SessionManager, aid: &str) {
    let _: Result<CancelOutcome> = m.cancel_connection(&Actor::Human, aid.to_string()).await;
}

/// Agent 一律拒之门外（一次性目标不该成为 Agent 的隐蔽入口）；vault 无写入。
#[tokio::test(flavor = "multi_thread")]
async fn agent_rejected() {
    let m = mgr();
    let before = m.center.vault.list_hosts().unwrap().len();
    let err = m
        .begin_connection_draft(
            &Actor::Agent { client_id: "opencode".into() },
            draft(),
            BeginConnectionOpts::default(),
        )
        .await
        .unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)), "得 {err:?}");
    assert_eq!(reg_count(&m), 0, "拒绝路径不得残留注册");
    assert_eq!(m.center.vault.list_hosts().unwrap().len(), before);
}

/// 输入校验：空地址/空用户名/0 端口/带协议地址/无显式认证/空密码——全部
/// InvalidInput 且零残留（注册即败不留半条）。
#[tokio::test(flavor = "multi_thread")]
async fn input_validation_rejects() {
    let m = mgr();
    let mut bad = draft();
    bad.address = "  ".into();
    let mut bad2 = draft();
    bad2.username = "".into();
    let mut bad3 = draft();
    bad3.port = Some(0);
    let mut bad4 = draft();
    bad4.address = "http://example.com".into();
    let mut bad5 = draft();
    bad5.auth = AuthDraft::None;
    let mut bad6 = draft();
    bad6.auth = AuthDraft::Password { password: String::new() };
    for d in [bad, bad2, bad3, bad4, bad5, bad6] {
        let err = m
            .begin_connection_draft(&Actor::Human, d, BeginConnectionOpts::default())
            .await
            .unwrap_err();
        assert!(matches!(err, Error::InvalidInput(_)), "得 {err:?}");
    }
    assert_eq!(reg_count(&m), 0, "全部拒绝后注册表必须为空");
}

/// 注册成功：id 快速前缀、默认名 user@host:port、明文入内存、attempt 可发起，
/// 已注册 id 对普通 begin_connection 可见（known 通过并幂等合并），主机列表
/// （vault 与 UI 口径）都不出现。
#[tokio::test(flavor = "multi_thread")]
async fn registers_resolves_and_attempt_visible() {
    let m = mgr();
    let before = m.center.vault.list_hosts().unwrap().len();
    let info = m
        .begin_connection_draft(&Actor::Human, draft(), BeginConnectionOpts::default())
        .await
        .unwrap();
    assert!(info.host_id.starts_with("quick-"), "得 {}", info.host_id);
    assert_eq!(info.phase, AttemptPhase::Connecting);
    {
        let reg = m.center.quick_hosts.lock().unwrap();
        assert_eq!(reg.len(), 1);
        let qh = reg.values().next().unwrap();
        assert_eq!(qh.host.name, format!("root@{}:2222", qh.host.address));
        assert_eq!(*qh.secret, "qp", "明文凭据在内存注册表");
        assert!(qh.fingerprint.lock().unwrap().is_none(), "初始无信任");
    }
    // known：普通 begin 对已注册 id 合并到同一 attempt（M3 幂等）
    let merged = m
        .begin_connection(&Actor::Human, info.host_id.clone(), BeginConnectionOpts::default())
        .await
        .unwrap();
    assert_eq!(merged.attempt_id, info.attempt_id, "合并而非重复 spawn");
    // vault 无行；UI 主机列表不出现（快速连接不进主机栏/最近连接）
    assert_eq!(m.center.vault.list_hosts().unwrap().len(), before);
    let ui = m.list_hosts(&Actor::Human).await.unwrap();
    assert!(!ui.iter().any(|h| h.id.starts_with("quick-")));
    cancel_quietly(&m, &info.attempt_id).await;
}

/// 密钥引用即席解出（vault 已有 identity → 内存明文）；未知 identity 注册即败。
#[tokio::test(flavor = "multi_thread")]
async fn key_identity_eager_resolution() {
    let m = mgr();
    let meta = m
        .center
        .vault
        .create_identity(&IdentityReq::Password { label: "k".into(), password: "kp".into() })
        .unwrap();
    let mut d = draft();
    d.auth = AuthDraft::Key { identity_id: meta.id.clone() };
    let info = m
        .begin_connection_draft(&Actor::Human, d, BeginConnectionOpts::default())
        .await
        .unwrap();
    {
        let reg = m.center.quick_hosts.lock().unwrap();
        let qh = reg.values().next().unwrap();
        assert_eq!(*qh.secret, "kp", "解出到内存");
        assert_eq!(qh.host.identity_id.as_deref(), Some(meta.id.as_str()));
    }
    let mut d2 = draft();
    d2.auth = AuthDraft::Key { identity_id: "i-missing".into() };
    let err = m
        .begin_connection_draft(&Actor::Human, d2, BeginConnectionOpts::default())
        .await
        .unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)), "得 {err:?}");
    assert_eq!(reg_count(&m), 1, "失败路径不残留");
    cancel_quietly(&m, &info.attempt_id).await;
}

/// 会话行落库：quick 主机 id 直接落 sessions 必撞 hosts FK（真机实锤过）——
/// 生产路径因此记 NULL；NULL 行不进最近连接派生。
#[tokio::test(flavor = "multi_thread")]
async fn session_row_records_null_host_for_quick() {
    let m = mgr();
    let mut d = draft();
    d.auth = AuthDraft::Agent;
    let host = m.register_quick_host(d).unwrap();
    let r = m.center.vault.record_session(&"s-qtest".to_string(), Some(&host.id), "ssh");
    assert!(r.is_err(), "quick id 直接落库必撞 FK——这正是必须记 NULL 的原因");
    m.center.vault.record_session(&"s-qtest".to_string(), None, "ssh").unwrap();
    let recents = m.center.vault.list_recent_hosts(5).unwrap();
    assert!(recents.is_empty(), "NULL host_id 不进最近连接，得 {recents:?}");
}

/// TOFU 内存生命周期：首连 FirstSeen 卡 → 信任入内存（vault 永不落）→ 同指纹
/// 直接放行（无新卡）→ 换指纹 Changed 卡（previous 在案）→ 拒绝即断连。
#[tokio::test(flavor = "multi_thread")]
async fn tofu_trust_stays_in_memory() {
    let m = mgr();
    let mut d = draft();
    d.auth = AuthDraft::Agent;
    let host = m.register_quick_host(d).unwrap();
    let fp = "SHA256:quick-test-fp";
    let gate = |m: Arc<SessionManager>, h: Host, f: &'static str| {
        tokio::spawn(async move { host_key_gate(&m.center, &Actor::Human, &h, f, None).await })
    };
    // 首连：FirstSeen 卡
    let g1 = gate(m.clone(), host.clone(), fp);
    let hk_id = loop {
        let p = m.center.hk_pending.lock().unwrap();
        if let Some(k) = p.values().next() {
            assert!(matches!(k.issue, HostKeyIssue::FirstSeen));
            break k.id.clone();
        }
        drop(p);
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    // 真实 decide 路径由提交侧自清两表（pending + decisions）——测试同口径
    {
        let mut pending = m.center.hk_pending.lock().unwrap();
        pending.remove(&hk_id);
        let tx = m.center.hk_decisions.lock().unwrap().remove(&hk_id).unwrap();
        tx.send(true).unwrap();
    }
    assert!(g1.await.unwrap().unwrap(), "信任后放行");
    {
        let reg = m.center.quick_hosts.lock().unwrap();
        assert_eq!(
            reg.get(&host.id).unwrap().fingerprint.lock().unwrap().as_deref(),
            Some(fp),
            "信任入内存注册表"
        );
    }
    assert!(m.center.vault.host_fingerprint(&host.id).is_err(), "vault 无行——永不落盘");
    // 同指纹：直接放行、无新卡
    let g2 = gate(m.clone(), host.clone(), fp);
    assert!(g2.await.unwrap().unwrap(), "同指纹免确认");
    assert!(m.center.hk_pending.lock().unwrap().is_empty(), "无卡产生");
    // 换指纹：Changed 卡且 previous 在案；拒绝 → 断连错误
    let fp2 = "SHA256:quick-test-fp-CHANGED";
    let g3 = gate(m.clone(), host.clone(), fp2);
    let hk2 = loop {
        let p = m.center.hk_pending.lock().unwrap();
        if let Some(k) = p.values().next() {
            assert!(matches!(k.issue, HostKeyIssue::Changed));
            assert_eq!(k.previous_fingerprint.as_deref(), Some(fp));
            break k.id.clone();
        }
        drop(p);
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    {
        let mut pending = m.center.hk_pending.lock().unwrap();
        pending.remove(&hk2);
        let tx = m.center.hk_decisions.lock().unwrap().remove(&hk2).unwrap();
        tx.send(false).unwrap();
    }
    let r3 = g3.await.unwrap();
    assert!(matches!(r3, Err(Error::HostKeyRejected(_))), "得 {r3:?}");
}
