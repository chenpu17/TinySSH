//! 十八轮：会话日志——开关生命周期（logs 目录/文件名净化/重复开启幂等/关闭收口）
//! 与落盘内容（log_append 即 pump tap 的写点）。

use super::*;
use session_api::{Actor, CreateSessionReq};
use std::sync::Arc;

fn mgr() -> Arc<SessionManager> {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = std::env::temp_dir().join(format!("slog-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    SessionManager::open(&dir.join("t.db")).unwrap()
}

/// 本机 PTY 会话上全生命周期：开（建文件，路径在 logs/、含主机名）→ 幂等同路径
/// → tap 写入可见 → 关（SessionInfo.logging 归假、后续写不落、路径查询 None）。
#[tokio::test(flavor = "multi_thread")]
async fn logging_lifecycle_and_content() {
    let m = mgr();
    let sid = m
        .create_session(
            &Actor::Human,
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();
    let path = m
        .set_session_logging(&Actor::Human, sid.clone(), true)
        .await
        .unwrap()
        .unwrap();
    let p = std::path::PathBuf::from(&path);
    assert!(p.exists(), "日志文件已建：{}", path);
    assert!(
        p.parent().unwrap().ends_with("logs"),
        "在 data/logs 下：{}",
        path
    );
    assert!(
        p.file_name().unwrap().to_string_lossy().contains("本机"),
        "文件名含主机名：{}",
        path
    );
    // 重复开启幂等：返回同一路径，不另建文件
    let again = m
        .set_session_logging(&Actor::Human, sid.clone(), true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(again, path, "重复开启返回同一路径");
    // tap 直测（pump 同点）：解码后 UTF-8 追加
    let h = m.sessions.lock().unwrap().get(&sid).cloned().unwrap();
    h.log_append("log-line-1\n");
    h.log_append("log-line-2");
    let content = std::fs::read_to_string(&p).unwrap();
    assert!(content.contains("log-line-1"), "得 {content:?}");
    assert!(content.contains("log-line-2"));
    // 关闭：返回 None、SessionInfo.logging 归假、后续写不落、路径查询 None
    let off = m
        .set_session_logging(&Actor::Human, sid.clone(), false)
        .await
        .unwrap();
    assert!(off.is_none());
    h.log_append("after-off");
    let content = std::fs::read_to_string(&p).unwrap();
    assert!(!content.contains("after-off"), "关闭后不再落盘");
    assert!(
        m.session_log_path(&Actor::Human, sid.clone())
            .await
            .unwrap()
            .is_none(),
        "路径查询归 None"
    );
    let info = m
        .list_sessions(&Actor::Human)
        .await
        .unwrap()
        .into_iter()
        .find(|x| x.id == sid)
        .unwrap();
    assert!(!info.logging, "SessionInfo.logging 归假");
    let _ = m.close_session(&Actor::Human, sid).await;
}

/// 未注册会话：开关与路径查询都 SessionNotFound（不泄露、不建孤儿文件）。
#[tokio::test(flavor = "multi_thread")]
async fn unknown_session_not_found() {
    let m = mgr();
    let r = m
        .set_session_logging(&Actor::Human, "s-missing".into(), true)
        .await
        .unwrap_err();
    assert!(matches!(r, Error::SessionNotFound), "得 {r:?}");
    let r = m
        .session_log_path(&Actor::Human, "s-missing".into())
        .await
        .unwrap_err();
    assert!(matches!(r, Error::SessionNotFound), "得 {r:?}");
}
