//! SPIKE-3 / 协议合规：rmcp 客户端 → mcp-server 全链路。
//! 门限（L0 §8）：annotations 合规、错误语义表逐条断言、120s 审批挂起不被客户端切断、exec P95 < 300ms。

use std::sync::Arc;
use std::time::{Duration, Instant};

use rmcp::model::{CallToolRequestParams, ClientConfig};
use rmcp::ClientLifecycleMode;
use rmcp::service::{RunningService, RoleClient};
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
};
use rmcp::{ServiceExt, ClientServiceExt};

async fn spawn_stack() -> (Arc<core_session::SessionManager>, String, u16, String) {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t.db");
    std::mem::forget(dir);
    let m = core_session::SessionManager::open(&db).unwrap();
    let token = m.center.vault.create_agent("claude-code", "Claude Code").unwrap();
    m.center.vault.add_allow_pattern("claude-code", "echo *", "echo 放行").unwrap();

    let state = tinyssh_mcp_server::McpState {
        api: m.clone(),
        resolver: tinyssh_mcp_server::TokenResolver { vault: m.center.vault.clone() },
    };
    let config = tinyssh_mcp_server::StreamableHttpServerConfig::default()
        .with_json_response(true);
    let router = tinyssh_mcp_server::build_router(state, config);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let url = format!("http://127.0.0.1:{port}/mcp");
    (m, url, port, token)
}

async fn connect(url: &str, token: &str) -> RunningService<RoleClient, rmcp::model::ClientConfig> {
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url.to_string())
            .auth_header(token.to_string()),
    );
    ClientConfig::new(
        rmcp::model::ClientCapabilities::default(),
        rmcp::model::Implementation::new("spike3-test", "0.1.0"),
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
    if r.is_error != Some(true) {
        return None;
    }
    r.structured_content
        .as_ref()
        .and_then(|v| v.get("kind"))
        .and_then(|k| k.as_str())
        .map(|s| s.to_string())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn spike3_protocol_compliance() {
    let (m, url, _port, token) = spawn_stack().await;

    // 1) initialize + tools/list
    let client = connect(&url, &token).await;
    let tools = client.list_tools(None).await.expect("list tools");
    let names: Vec<String> = tools.tools.iter().map(|t| t.name.to_string()).collect();
    for expected in [
        "list_hosts", "list_sessions", "create_session", "exec", "cancel_exec",
        "upload", "download", "close_session", "get_session_brief", "query_audit",
        "read_screen", "send_keys", "wait_output",
    ] {
        assert!(names.contains(&expected.to_string()), "missing tool {expected}: {names:?}");
    }
    // annotations 合规
    let exec_tool = tools.tools.iter().find(|t| t.name == "exec").unwrap();
    assert_eq!(exec_tool.annotations.as_ref().and_then(|a| a.destructive_hint), Some(true));
    let lh = tools.tools.iter().find(|t| t.name == "list_hosts").unwrap();
    assert_eq!(lh.annotations.as_ref().and_then(|a| a.read_only_hint), Some(true));

    // 2) 本地会话 + shell 模式 exec（allow 规则 → Auto）
    let sid = m
        .create_session(&Actor::Human, CreateSessionReq { host_id: "local".into() })
        .await
        .unwrap();
    let human = Actor::Human;

    let r = client
        .call_tool(call("exec", serde_json::json!({"session_id": sid, "command": "echo protocol_ok"})))
        .await
        .unwrap();
    assert_eq!(r.is_error, Some(false));
    let out: serde_json::Value = serde_json::from_str(
        &r.structured_content.as_ref().map(|v| v.to_string()).unwrap_or_default(),
    )
    .unwrap_or(serde_json::json!({}));
    // structured_content 可能为 null → 从 content 取
    let val = if out.is_null() {
        let text = r.content.first().map(|c| c.as_text().map(|t| t.text.clone()).unwrap_or_default()).unwrap_or_default();
        serde_json::from_str(&text).unwrap_or(serde_json::json!({}))
    } else {
        out
    };
    assert_eq!(val["stdout"].as_str().map(|s| s.contains("protocol_ok")), Some(true), "{val}");

    // P95 < 300ms（50 次 allow 命中 exec）
    let mut samples = Vec::new();
    for i in 0..50 {
        let t0 = Instant::now();
        let r = client
            .call_tool(call("exec", serde_json::json!({"session_id": sid, "command": format!("echo p95_{i}")})))
            .await
            .unwrap();
        assert_eq!(r.is_error, Some(false));
        samples.push(t0.elapsed());
    }
    samples.sort();
    let p95 = samples[49];
    println!("exec P95 = {p95:?}（门限 <300ms）");
    assert!(p95 < Duration::from_millis(300), "P95 {p95:?} 超门限");

    // 3) 错误语义
    // 3a. 危险模式
    let r = client
        .call_tool(call("exec", serde_json::json!({"session_id": sid, "command": "reboot"})))
        .await
        .unwrap();
    assert_eq!(err_kind(&r).as_deref(), Some("dangerous_pattern"));

    // 3b. 待审批 → 人类拒绝
    let client2 = connect(&url, &token).await;
    let m3 = m.clone();
    let sid3 = sid.clone();
    let jh2 = tokio::spawn(async move {
        client2
            .call_tool(call("exec", serde_json::json!({"session_id": sid3, "command": "printf needs_human"})))
            .await
    });
    // 等卡片 → deny
    let mut card = None;
    for _ in 0..200 {
        let items = m3
            .list_approvals(&human, ApprovalFilter { pending_only: true, ..Default::default() })
            .await
            .unwrap();
        if let Some(it) = items.first() {
            card = Some(it.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    m3.decide_approval(&human, card.unwrap(), Decision::Deny).await.unwrap();
    let r = jh2.await.unwrap().unwrap();
    assert_eq!(err_kind(&r).as_deref(), Some("approval_denied"), "{r:?}");

    // 3c. 控制权在人类
    m.set_control(&human, sid.clone(), ControlOwner::Human, ControlOpts::default()).await.unwrap();
    let r = client
        .call_tool(call("exec", serde_json::json!({"session_id": sid, "command": "printf blocked"})))
        .await
        .unwrap();
    assert_eq!(err_kind(&r).as_deref(), Some("control_taken_by_human"));
    m.set_control(&human, sid.clone(), ControlOwner::Agent, ControlOpts::default()).await.unwrap();

    // 4) 120s 审批挂起不被客户端切断（门限验证：suspend ≥120s 后 ApprovalTimeout）
    let client3 = connect(&url, &token).await;
    let t0 = Instant::now();
    let r = client3
        .call_tool(call("exec", serde_json::json!({"session_id": sid, "command": "printf suspend_test"})))
        .await
        .unwrap();
    let suspend = t0.elapsed();
    assert_eq!(err_kind(&r).as_deref(), Some("approval_timeout"), "120s 无决策应返回 approval_timeout");
    assert!(suspend >= Duration::from_secs(119), "实际挂起 {suspend:?}——客户端提前切断？");
    println!("审批挂起 {suspend:?}，客户端未被切断 ✓");
}

use session_api::*;
