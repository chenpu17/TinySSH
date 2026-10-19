//! P1 shell 集成扩面：不可注入 shell（cmd.exe）的本机建连时序与如实上报。
//! 单文件单测：进程内改 SHELL 无并发干扰（同 transport-pty
//! windows_local_shell_integration 的惯例）。非 Windows 整文件为空。

#![cfg(windows)]

use core_session::SessionManager;
use session_api::{Actor, CreateSessionReq, ExecMode, ExecOpts, IntegrationState, SessionApi};
use std::time::{Duration, Instant};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plain_local_shell_connects_fast_and_reports_unavailable() {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    std::env::set_var("SHELL", "cmd.exe");
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t.db");
    // dir 泄漏以覆盖测试生命周期（含 tokio 任务）
    std::mem::forget(dir);
    let m = SessionManager::open(&db).unwrap();

    let mut rx = m.subscribe_shell_integration();
    let started = Instant::now();
    let sid = m
        .create_session(
            &Actor::Human,
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();
    let elapsed = started.elapsed();
    // 先验 false：不再白等 10s 观测窗（此前的全量等待让 cmd/WSL 本机会话
    // 每次建连固定多挂 10s）。给 5s 余量，只拦「等满观测窗」的回归。
    assert!(
        elapsed < Duration::from_secs(5),
        "cmd 本机建连不应等满集成观测窗，实际 {elapsed:?}"
    );

    // 集成态如实 Unavailable（事件可达）
    let ev = rx.try_recv().expect("shell-integration-event 应可达");
    assert_eq!(ev.session_id, sid);
    assert_eq!(ev.state, IntegrationState::Unavailable);

    // 会话本体照常可用：Fresh exec 正常（Shell 模式由门拒绝，与本测试无关）
    let r = m
        .exec(
            &Actor::Human,
            sid.clone(),
            "echo plain_ok",
            ExecOpts {
                mode: ExecMode::Fresh,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(r.stdout.contains("plain_ok"), "{}", r.stdout);

    let _ = m.close_session(&Actor::Human, sid).await;
}
