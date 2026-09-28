//! E2E 首个可运行验收场景（PRD §10 / validation-plan §3）：
//!   旧请求待审批 → 人接管修改现场 → 交还 → 旧请求（含待审批卡片）失效
//!   → Agent 核实后重新提交。
//! 全程 MCP（rmcp 客户端）驱动 Agent 侧；人类侧走同一 SessionApi（Actor::Human）。
//! 门控：TINYSSH_E2E_SSHD=1（scripts/dev-sshd.sh）。

use std::sync::Arc;
use std::time::Duration;

use rmcp::model::{CallToolRequestParams, ClientConfig};
use rmcp::ClientLifecycleMode;
use session_api::*;
use rmcp::service::{RunningService, RoleClient, ServiceExt as _, ClientServiceExt as _};
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
};

fn sshd_enabled() -> bool {
    std::env::var("TINYSSH_E2E_SSHD").map(|v| v == "1").unwrap_or(false)
}

async fn spawn_stack() -> (Arc<core_session::SessionManager>, String, String) {
    // RUST_LOG 设置时输出核心 trace（排查并发回归用）
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_target(false)
        .without_time()
        .try_init();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t.db");
    std::mem::forget(dir);
    let m = core_session::SessionManager::open(&db).unwrap();
    let token = m.center.vault.create_agent("opencode", "OpenCode").unwrap();

    // 注册 docker sshd 主机
    m.upsert_host(
        &Actor::Human,
        HostDraft {
            id: Some("e2e-linux".into()),
            name: "e2e-linux".into(),
            address: "127.0.0.1".into(),
            port: Some(2222),
            username: "root".into(),
            auth: AuthDraft::Password { password: "testpass".into() },
            tags: vec![],
        },
    )
    .await
    .unwrap();

    let resolver: tinyssh_mcp_server::TokenResolver = {
        let vault = m.center.vault.clone();
        std::sync::Arc::new(move |t: &str| vault.resolve_token(t))
    };
    let state = tinyssh_mcp_server::McpState::new(m.clone(), resolver);
    let config = tinyssh_mcp_server::StreamableHttpServerConfig::default().with_json_response(true);
    let router = tinyssh_mcp_server::build_router(state, config);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (m, format!("http://127.0.0.1:{port}/mcp"), token)
}

async fn connect(url: &str, token: &str) -> RunningService<RoleClient, rmcp::model::ClientConfig> {
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url.to_string())
            .auth_header(token.to_string()),
    );
    ClientConfig::new(
        rmcp::model::ClientCapabilities::default(),
        rmcp::model::Implementation::new("opencode", "0.1.0"),
    )
    .serve_with_lifecycle(transport, ClientLifecycleMode::Initialize)
    .await
    .expect("client init")
}

fn call(name: &str, args: serde_json::Value) -> CallToolRequestParams {
    CallToolRequestParams::new(name.to_string())
        .with_arguments(args.as_object().cloned().unwrap_or_default())
}

fn err_kind(r: &rmcp::model::CallToolResult) -> Option<String> {
    r.structured_content
        .as_ref()
        .and_then(|v| v.get("kind"))
        .and_then(|k| k.as_str())
        .map(|s| s.to_string())
}

fn structured(r: &rmcp::model::CallToolResult) -> serde_json::Value {
    r.structured_content.clone().unwrap_or(serde_json::Value::Null)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn acceptance_scenario_on_ssh() {
    let _sshd_guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let (m, url, token) = spawn_stack().await;
    let human = Actor::Human;
    let mut client = connect(&url, &token).await;

    // ---- Agent：create_session（远程 → 人类批准）----
    let client_c = connect(&url, &token).await;
    let jh = tokio::spawn(async move {
        client_c.call_tool(call("create_session", serde_json::json!({"host_id": "e2e-linux"}))).await
    });
    let mut card = None;
    for _ in 0..300 {
        let items = m.list_approvals(&human, ApprovalFilter { pending_only: true, ..Default::default() }).await.unwrap();
        if let Some(it) = items.first() {
            card = Some(it.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    m.decide_approval(&human, card.expect("create_session 卡片"), Decision::Approve).await.unwrap();
    let r = jh.await.unwrap().unwrap();
    let sid = structured(&r)["session_id"].as_str().unwrap().to_string();

    // ---- 步骤 1：Agent 提交 exec → 待审批（阻塞中）----
    let client_a = connect(&url, &token).await;
    let sid_a = sid.clone();
    let jh_agent = tokio::spawn(async move {
        client_a
            .call_tool(call("exec", serde_json::json!({"session_id": sid_a, "command": "echo old_request_should_die"})))
            .await
    });
    let mut old_card = None;
    for _ in 0..300 {
        let items = m.list_approvals(&human, ApprovalFilter { pending_only: true, ..Default::default() }).await.unwrap();
        if let Some(it) = items.iter().find(|it| it.command.contains("old_request_should_die")) {
            old_card = Some(it.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let old_card = old_card.expect("旧请求卡片未出现");

    // ---- 步骤 2：人接管（冻结；不作废运行中——无运行任务）----
    let report = m
        .set_control(&human, sid.clone(), ControlOwner::Human, ControlOpts::default())
        .await
        .unwrap();
    assert!(report.frozen);

    // ---- 步骤 3：Agent 阻塞调用返回 voided_by_handback（附简报）----
    let r = jh_agent.await.unwrap().unwrap();
    assert_eq!(err_kind(&r).as_deref(), Some("voided_by_handback"), "{r:?}");
    let brief_in_err = r
        .structured_content
        .as_ref()
        .and_then(|v| v.get("detail").and_then(|d| d.get("brief")).cloned());
    assert!(brief_in_err.is_some(), "错误载荷应附简报");

    // ---- 步骤 4：待审批卡片已作废且不可再生效 ----
    let items = m.list_approvals(&human, ApprovalFilter::default()).await.unwrap();
    let card_status = items.iter().find(|it| it.id == old_card).unwrap().status;
    assert_eq!(card_status, ApprovalStatus::Voided);
    let revive = m.decide_approval(&human, old_card.clone(), Decision::Approve).await;
    assert!(revive.is_err(), "作废卡片不可再生效");
    // Agent 侧控制权被拒
    let r = client
        .call_tool(call("exec", serde_json::json!({"session_id": sid, "command": "echo blocked"})))
        .await
        .unwrap();
    assert_eq!(err_kind(&r).as_deref(), Some("control_taken_by_human"));

    // ---- 步骤 5：人类修改现场（mkdir + cd；Human 短路审批）----
    m.exec(&human, sid.clone(), "mkdir -p /tmp/handoff-demo && cd /tmp/handoff-demo && touch marker_from_human", ExecOpts::default())
        .await
        .unwrap();

    // ---- 步骤 6：人交还 ----
    m.set_control(&human, sid.clone(), ControlOwner::Agent, ControlOpts::default()).await.unwrap();

    // ---- 步骤 7：Agent 读简报核实（cwd 已变为人工现场）----
    let r = client
        .call_tool(call("get_session_brief", serde_json::json!({"session_id": sid})))
        .await
        .unwrap();
    let brief = structured(&r);
    assert_eq!(brief["cwd"].as_str(), Some("/tmp/handoff-demo"), "简报 cwd={brief}");

    // ---- 步骤 8：Agent 核实后重新提交 → 批准 → 在新现场执行 ----
    let client_b = connect(&url, &token).await;
    let sid_b = sid.clone();
    let jh_resub = tokio::spawn(async move {
        client_b
            .call_tool(call("exec", serde_json::json!({"session_id": sid_b, "command": "pwd && ls marker_from_human"})))
            .await
    });
    let mut resub_card = None;
    for _ in 0..300 {
        let items = m.list_approvals(&human, ApprovalFilter { pending_only: true, ..Default::default() }).await.unwrap();
        if let Some(it) = items.iter().find(|it| it.command.contains("pwd")) {
            resub_card = Some(it.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    m.decide_approval(&human, resub_card.expect("重新提交卡片"), Decision::Approve).await.unwrap();
    let r = jh_resub.await.unwrap().unwrap();
    assert_eq!(r.is_error, Some(false), "{r:?}");
    let out = structured(&r);
    let stdout = out["stdout"].as_str().unwrap_or_default();
    assert!(stdout.contains("/tmp/handoff-demo"), "新现场 cwd：{stdout}");
    assert!(stdout.contains("marker_from_human"), "人类修改可见：{stdout}");

    // 旧请求没有被自动执行：审计里没有 old_request_should_die 的成功 exec
    let page = m
        .query_audit(&human, AuditFilter { session_id: Some(sid.clone()), limit: 1000, ..Default::default() })
        .await
        .unwrap();
    let old_ran = page.events.iter().any(|ev| {
        ev.action == "exec" && ev.command.as_deref().unwrap_or("").contains("old_request_should_die")
    });
    assert!(!old_ran, "旧请求被自动执行了！");
    let _ = client.close().await;
}

/// 旅程 2：断线重连 → Reconfirming（白名单外动作被拒；核实后自动恢复）。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn journey2_reconnect_reconfirm() {
    let _sshd_guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let (m, url, token) = spawn_stack().await;
    let human = Actor::Human;

    let sid = m
        .create_session(&human, CreateSessionReq { host_id: "e2e-linux".into() })
        .await
        .unwrap();
    m.exec(&human, sid.clone(), "cd /tmp && echo ready", ExecOpts::default()).await.unwrap();

    // 断线：重启容器（sshd 重启 <2s；核心 3 次重连机会，间隔 2s）
    let _ = std::process::Command::new("docker")
        .args(["restart", "tinyssh-e2e"])
        .output()
        .expect("docker restart");

    // 等待核心完成重连并进入 Reconfirming
    let mut reached = false;
    for i in 0..450 {
        let sessions = m.list_sessions(&human).await.unwrap();
        if let Some(s) = sessions.iter().find(|s| s.id == sid) {
            if s.state == SessionState::Reconfirming {
                reached = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(reached, "未进入 Reconfirming");

    // 简报：cwd 降级 NeedsRecheck；运行中任务 Unobservable
    let brief = m.get_session_brief(&human, sid.clone()).await.unwrap();
    let cwd_fact = brief.facts.iter().find(|f| f.subject == "cwd");
    if let Some(f) = cwd_fact {
        assert_eq!(f.status, Epistemic::NeedsRecheck);
    }

    // 白名单外动作被拒
    let r = m.exec(&Actor::Agent { client_id: "opencode".into() }, sid.clone(), "touch /tmp/nope", ExecOpts::default()).await;
    assert!(matches!(r, Err(Error::ReconfirmingPending)), "得到 {r:?}");

    // M1 回归：白名单命令携带复合段同样被拒（前缀匹配不得绕过重确认门槛）
    let r = m.exec(&Actor::Agent { client_id: "opencode".into() }, sid.clone(), "pwd && touch /tmp/nope2", ExecOpts::default()).await;
    assert!(matches!(r, Err(Error::ReconfirmingPending)), "复合白名单被放行？{r:?}");

    // 白名单核实（Agent 侧允许）
    let r = m
        .exec(&Actor::Agent { client_id: "opencode".into() }, sid.clone(), "pwd", ExecOpts::default())
        .await
        .unwrap();
    assert_eq!(r.exit_code, Some(0));
    // 语义：重连后是新 shell，现场不延续（显示历史 ≠ 现场）——核实返回真实 cwd（/root）
    assert!(r.stdout.contains("/root"), "核实结果: {}", r.stdout);

    // 核心自动判定：核实完成 → 退出 Reconfirming
    let mut exited = false;
    for _ in 0..50 {
        let sessions = m.list_sessions(&human).await.unwrap();
        if let Some(s) = sessions.iter().find(|s| s.id == sid) {
            if s.state == SessionState::Connected {
                exited = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(exited, "核实后未自动退出 Reconfirming");

    // 恢复后普通动作可用，且现场延续（cwd 仍为 /tmp —— 同一持久 shell? 重连是新 shell；
    // 正确断言：新 shell 的初始 cwd 生效即可（显示历史 ≠ 现场延续，PRD v0.5）
    m.exec(&human, sid.clone(), "echo after_reconfirm", ExecOpts::default()).await.unwrap();
}
