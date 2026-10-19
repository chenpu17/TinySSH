//! SPIKE-3 / 协议合规：rmcp 客户端 → mcp-server 全链路。
//! 门限（L0 §8）：annotations 合规、错误语义表逐条断言、120s 审批挂起不被客户端切断、exec P95 < 300ms。

use std::sync::Arc;
use std::time::{Duration, Instant};

use rmcp::model::{CallToolRequestParams, ClientConfig};
use rmcp::service::{RoleClient, RunningService};
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
};
use rmcp::ClientLifecycleMode;
use rmcp::ClientServiceExt;

// 主密钥走 env（vault 解析序 env > OS 钥匙串）：避免测试二进制重编译后
// 签名变化触发 macOS 钥匙串授权弹窗并阻塞测试进程。
fn test_master_key() {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
}

async fn spawn_stack() -> (Arc<core_session::SessionManager>, String, u16, String) {
    test_master_key();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t.db");
    std::mem::forget(dir);
    let m = core_session::SessionManager::open(&db).unwrap();
    // C9（R43）：新装默认关闭协作；本协议测试模拟「已启用协作的既有安装」，
    // 走真实 API 显式启用（开 admission 门），以便驱动 Agent exec 路径。
    m.collab_enable(&Actor::Human).await.unwrap();
    let token = m
        .center
        .vault
        .create_agent("claude-code", "Claude Code")
        .unwrap();
    m.center
        .vault
        .add_allow_pattern("claude-code", "echo *", "echo 放行")
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
        "list_hosts",
        "list_sessions",
        "create_session",
        "exec",
        "cancel_exec",
        "upload",
        "download",
        "close_session",
        "get_session_brief",
        "query_audit",
        "read_screen",
        "send_keys",
        "wait_output",
        // rev-r46 能力面补齐
        "sftp_list",
        "sftp_stat",
        "shell_capability",
        "cancel_transfer",
        "retry_transfer",
        // ③ 执行记录
        "query_records",
    ] {
        assert!(
            names.contains(&expected.to_string()),
            "missing tool {expected}: {names:?}"
        );
    }
    // annotations 合规
    let exec_tool = tools.tools.iter().find(|t| t.name == "exec").unwrap();
    assert_eq!(
        exec_tool
            .annotations
            .as_ref()
            .and_then(|a| a.destructive_hint),
        Some(true)
    );
    let lh = tools.tools.iter().find(|t| t.name == "list_hosts").unwrap();
    assert_eq!(
        lh.annotations.as_ref().and_then(|a| a.read_only_hint),
        Some(true)
    );

    // 2) 本地会话 + shell 模式 exec（allow 规则 → Auto）
    let sid = m
        .create_session(
            &Actor::Human,
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();
    // C2（B01/R24）：人建会话初始 Human-owned；MCP 面是 Agent 域，先委托
    m.delegate_session(&Actor::Human, sid.clone(), None)
        .await
        .unwrap();
    let human = Actor::Human;

    let r = client
        .call_tool(call(
            "exec",
            serde_json::json!({"session_id": sid, "command": "echo protocol_ok"}),
        ))
        .await
        .unwrap();
    assert_eq!(r.is_error, Some(false));
    let out: serde_json::Value = serde_json::from_str(
        &r.structured_content
            .as_ref()
            .map(|v| v.to_string())
            .unwrap_or_default(),
    )
    .unwrap_or(serde_json::json!({}));
    // structured_content 可能为 null → 从 content 取
    let val = if out.is_null() {
        let text = r
            .content
            .first()
            .map(|c| c.as_text().map(|t| t.text.clone()).unwrap_or_default())
            .unwrap_or_default();
        serde_json::from_str(&text).unwrap_or(serde_json::json!({}))
    } else {
        out
    };
    assert_eq!(
        val["stdout"].as_str().map(|s| s.contains("protocol_ok")),
        Some(true),
        "{val}"
    );

    // P95 < 300ms（50 次 allow 命中 exec）
    let mut samples = Vec::new();
    for i in 0..50 {
        let t0 = Instant::now();
        let r = client
            .call_tool(call(
                "exec",
                serde_json::json!({"session_id": sid, "command": format!("echo p95_{i}")}),
            ))
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
        .call_tool(call(
            "exec",
            serde_json::json!({"session_id": sid, "command": "reboot"}),
        ))
        .await
        .unwrap();
    assert_eq!(err_kind(&r).as_deref(), Some("dangerous_pattern"));

    // 3b. 待审批 → 人类拒绝
    let client2 = connect(&url, &token).await;
    let m3 = m.clone();
    let sid3 = sid.clone();
    let jh2 = tokio::spawn(async move {
        client2
            .call_tool(call(
                "exec",
                serde_json::json!({"session_id": sid3, "command": "printf needs_human"}),
            ))
            .await
    });
    // 等卡片 → deny
    let mut card = None;
    for _ in 0..200 {
        let items = m3
            .list_approvals(
                &human,
                ApprovalFilter {
                    pending_only: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        if let Some(it) = items.first() {
            card = Some(it.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    m3.decide_approval(&human, card.unwrap(), Decision::Deny)
        .await
        .unwrap();
    let r = jh2.await.unwrap().unwrap();
    assert_eq!(err_kind(&r).as_deref(), Some("approval_denied"), "{r:?}");

    // 3c. 控制权在人类
    m.set_control(
        &human,
        sid.clone(),
        ControlOwner::Human,
        ControlOpts::default(),
    )
    .await
    .unwrap();
    let r = client
        .call_tool(call(
            "exec",
            serde_json::json!({"session_id": sid, "command": "printf blocked"}),
        ))
        .await
        .unwrap();
    assert_eq!(err_kind(&r).as_deref(), Some("control_taken_by_human"));
    m.set_control(
        &human,
        sid.clone(),
        ControlOwner::Agent,
        ControlOpts::default(),
    )
    .await
    .unwrap();

    // 4) 120s 审批挂起不被客户端切断（门限验证：suspend ≥120s 后 ApprovalTimeout）
    let client3 = connect(&url, &token).await;
    let t0 = Instant::now();
    let r = client3
        .call_tool(call(
            "exec",
            serde_json::json!({"session_id": sid, "command": "printf suspend_test"}),
        ))
        .await
        .unwrap();
    let suspend = t0.elapsed();
    assert_eq!(
        err_kind(&r).as_deref(),
        Some("approval_timeout"),
        "120s 无决策应返回 approval_timeout"
    );
    assert!(
        suspend >= Duration::from_secs(119),
        "实际挂起 {suspend:?}——客户端提前切断？"
    );
    println!("审批挂起 {suspend:?}，客户端未被切断 ✓");
}

use session_api::*;

// T43（§6-7 收口）：GUI 进程内装配助手——bind_increment 递增语义 + spawn_endpoint
// 全链（rmcp 客户端打到 spawn 起的端点，且与 GUI 共享同一 SessionManager 实例：
// Agent 视角与人类视角同一内存态）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bind_increment_skips_occupied_ports() {
    // 占住一个端口：bind_increment 从该端口起应递增（审核低-2：同测试二进制
    // 并行 port-0 分配可能落在 occupied+1 上，精确断言属概率 flake——区间断言）
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let occupied = l.local_addr().unwrap().port();
    let (l2, got) = tinyssh_mcp_server::bind_increment(occupied).await.unwrap();
    assert!(
        got > occupied && got <= occupied + 8,
        "被占端口应递增到附近端口：{occupied} → {got}"
    );
    drop(l2);
    drop(l);

    // 释放后的空闲端口应直接命中（不递增）
    let (l3, got3) = tinyssh_mcp_server::bind_increment(occupied).await.unwrap();
    assert_eq!(got3, occupied, "空闲起点应直接命中");
    drop(l3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawn_endpoint_serves_in_process_stack() {
    test_master_key();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t.db");
    std::mem::forget(dir);
    let m = core_session::SessionManager::open(&db).unwrap();
    let token = m
        .center
        .vault
        .create_agent("gui-agent", "GUI 内嵌")
        .unwrap();

    let resolver: tinyssh_mcp_server::TokenResolver = {
        let vault = m.center.vault.clone();
        std::sync::Arc::new(move |t: &str| vault.resolve_token(t))
    };
    // GUI 同款装配：port=0（OS 分配）避免与并行测试抢 8722 段
    let port = tinyssh_mcp_server::spawn_endpoint(m.clone(), resolver, 0)
        .await
        .unwrap();
    let url = format!("http://127.0.0.1:{port}/mcp");

    // rmcp 客户端打到端点：initialize + 一个无副作用工具（list_sessions）
    let client = connect(&url, &token).await;
    let r = client
        .call_tool(call("list_sessions", serde_json::json!({})))
        .await
        .unwrap();
    assert_ne!(r.is_error, Some(true), "list_sessions 经内嵌端点应成功");
    client.cancel().await;
}

// ---- rev-r46：内置接入文档路由 + exec 心跳 + output_cap（裸 HTTP 验证）----

use futures_util::StreamExt;

/// 裸 HTTP 会话：initialize → 捕获 Mcp-Session-Id（shim 同款语义）。
async fn raw_init(base: &str, token: &str) -> reqwest::Client {
    let client = reqwest::Client::new();
    let r = client
        .post(format!("{base}/mcp"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .body(
            serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "raw-probe", "version": "0.1"}
                }
            })
            .to_string(),
        )
        .send()
        .await
        .expect("initialize POST");
    assert!(r.status().is_success(), "initialize: {}", r.status());
    let sid = r
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
        .expect("initialize 响应必须带 mcp-session-id");
    let _ = r.text().await;
    // 之后的请求统一回传 session id（+ 延续 Bearer）
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        "mcp-session-id",
        reqwest::header::HeaderValue::from_str(&sid).unwrap(),
    );
    headers.insert(
        reqwest::header::AUTHORIZATION,
        reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn docs_routes_served_without_auth() {
    let (_m, url, _port, token) = spawn_stack().await;
    let client = raw_init(&url, &token).await;
    // 文档挂在 origin（/mcp 的上一级），不在 MCP 路径下
    let origin = url.trim_end_matches("/mcp").to_string();

    // /integration.md：Markdown、含端点与工具目录（目录与工具面实时一致）
    let r = client
        .get(format!("{origin}/integration.md"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "GET /integration.md 非 200");
    assert!(r
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .contains("text/markdown"));
    let md = r.text().await.unwrap();
    assert!(md.contains(&url), "端点必须写进文档");
    for t in ["exec", "sftp_list", "retry_transfer", "get_session_brief"] {
        assert!(md.contains(&format!("`{t}`")), "工具目录缺 {t}");
    }
    assert!(md.contains("Bearer <TOKEN>"));
    assert!(md.contains("approval_denied"));
    assert!(!md.contains(&token), "文档不得泄露真实 Token");

    // / ：人读 HTML
    let r = client.get(format!("{origin}/")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert!(r
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .contains("text/html"));
    let html = r.text().await.unwrap();
    assert!(html.contains("/integration.md"));
    assert!(html.contains("TinySSH"));

    // 认证边界不松动：/mcp 无 Token 仍 401
    let anon = reqwest::Client::new();
    let r = anon.get(format!("{url}/mcp")).send().await.unwrap();
    assert_eq!(r.status(), 401);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exec_sends_progress_heartbeat_during_approval() {
    // 审批挂起 120s 期间，带 progressToken 的调用每 10s 收到 progress 心跳——
    // 否则真实客户端（默认超时 30–60s）会先掐断连接。
    let (m, url, _port, token) = spawn_stack().await;
    let client = raw_init(&url, &token).await;
    let sid = m
        .create_session(
            &Actor::Human,
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();
    m.delegate_session(&Actor::Human, sid.clone(), None)
        .await
        .unwrap();

    let c2 = client.clone();
    let sid2 = sid.clone();
    let call = tokio::spawn(async move {
        c2.post(format!("{url}/mcp"))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .body(
                serde_json::json!({
                    "jsonrpc": "2.0", "id": 9, "method": "tools/call",
                    "params": {
                        "name": "exec",
                        "arguments": {"session_id": sid2, "command": "printf needs_hb"},
                        "_meta": {"progressToken": "hb-1"}
                    }
                })
                .to_string(),
            )
            .send()
            .await
            .expect("exec POST")
    });
    let mut resp = tokio::time::timeout(Duration::from_secs(10), call)
        .await
        .unwrap()
        .unwrap();
    let st = resp.status();
    eprintln!("[hb] exec POST status={st}");
    assert!(st.is_success(), "exec POST 应成功：{st}");

    // 流式收 SSE 帧：等 progress 心跳（progressToken=hb-1），见到即喂狗成功
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut saw_heartbeat = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    let human = Actor::Human;
    while !saw_heartbeat {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            panic!("25s 内未收到 progress 心跳");
        }
        let chunk = tokio::time::timeout(remaining, stream.next()).await;
        match chunk {
            Ok(Some(item)) => {
                let bytes = item.expect("stream chunk");
                buf.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(pos) = buf.find("\n\n") {
                    let frame: String = buf.drain(..pos + 2).collect();
                    if frame.contains("notifications/progress") && frame.contains("hb-1") {
                        saw_heartbeat = true;
                    }
                }
            }
            _ => break,
        }
    }
    assert!(saw_heartbeat, "审批挂起期间应收到 progress 心跳");
    // 心跳确认后人类拒绝，调用应收敛返回（流结束）
    let items = m
        .list_approvals(
            &human,
            ApprovalFilter {
                pending_only: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    m.decide_approval(&human, items.first().unwrap().id.clone(), Decision::Deny)
        .await
        .unwrap();
    let mut rest = String::new();
    while let Some(chunk) = stream.next().await {
        rest.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
        if rest.contains("approval_denied") {
            break;
        }
    }
    assert!(
        rest.contains("approval_denied"),
        "拒绝后应返回结构化错误：{rest}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exec_output_cap_truncates() {
    // rev-r46：output_cap 暴露到 MCP 面——超限截断并标 truncated
    let (m, url, _port, token) = spawn_stack().await;
    let client = connect(&url, &token).await;
    let sid = m
        .create_session(
            &Actor::Human,
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();
    m.delegate_session(&Actor::Human, sid.clone(), None)
        .await
        .unwrap();

    let long = "x".repeat(4000);
    let r = client
        .call_tool(call(
            "exec",
            serde_json::json!({
                "session_id": sid,
                "command": format!("echo {long}"),
                "output_cap": 256
            }),
        ))
        .await
        .unwrap();
    assert_eq!(r.is_error, Some(false), "{r:?}");
    let text = r
        .structured_content
        .as_ref()
        .map(|v| v.to_string())
        .unwrap_or_default();
    let out: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::json!({}));
    assert_eq!(out["truncated"], true, "应标 truncated：{text}");
    let s = out["stdout"].as_str().unwrap_or_default();
    assert!(
        s.chars().count() < 400,
        "stdout 应被截断：{} 字符",
        s.chars().count()
    );
}

// ---- rev-r48：资源/订阅/提示能力面（第二能力面）----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resources_prompts_served_over_mcp() {
    let (_m, url, _port, token) = spawn_stack().await;
    let client = connect(&url, &token).await;

    // resources/list：5 个静态资源 + 2 个模板
    let rs = client.list_resources(None).await.expect("list resources");
    let uris: Vec<String> = rs.resources.iter().map(|r| r.uri.clone()).collect();
    for u in [
        "tinyssh://sessions",
        "tinyssh://transfers",
        "tinyssh://forwards",
        "tinyssh://approvals/pending",
        "tinyssh://records/recent",
    ] {
        assert!(uris.contains(&u.to_string()), "缺资源 {u}: {uris:?}");
    }
    let ts = client
        .list_resource_templates(None)
        .await
        .expect("templates");
    assert_eq!(ts.resource_templates.len(), 2);

    // resources/read：空会话列表也应是合法 JSON 数组
    let r = client
        .read_resource(rmcp::model::ReadResourceRequestParams::new(
            "tinyssh://sessions",
        ))
        .await
        .expect("read sessions");
    assert_eq!(r.contents.len(), 1);
    let (uri, mime_type, text) = match &r.contents[0] {
        rmcp::model::ResourceContents::TextResourceContents {
            uri,
            mime_type,
            text,
            ..
        } => (uri, mime_type, text),
        other => panic!("应为文本资源内容：{other:?}"),
    };
    assert_eq!(uri, "tinyssh://sessions");
    assert_eq!(mime_type.as_deref(), Some("application/json"));
    let parsed: serde_json::Value = serde_json::from_str(text).expect("会话列表应是 JSON");
    assert!(parsed.is_array(), "{parsed}");

    // 未知 uri → 协议错误（invalid_params）
    assert!(
        client
            .read_resource(rmcp::model::ReadResourceRequestParams::new(
                "file:///etc/passwd"
            ))
            .await
            .is_err(),
        "未知资源必须是协议错误"
    );

    // prompts/list + get（带参与缺参）
    let ps = client.list_prompts(None).await.expect("list prompts");
    let pnames: Vec<String> = ps.prompts.iter().map(|p| p.name.clone()).collect();
    for n in ["onboarding", "session-triage", "transfer-followup"] {
        assert!(pnames.contains(&n.to_string()), "缺提示 {n}: {pnames:?}");
    }
    let g = client
        .get_prompt(
            rmcp::model::GetPromptRequestParams::new("session-triage").with_arguments(
                serde_json::json!({ "session_id": "s-x" })
                    .as_object()
                    .cloned()
                    .unwrap(),
            ),
        )
        .await
        .expect("get session-triage");
    let text = g
        .messages
        .first()
        .map(|m| match &m.content {
            rmcp::model::ContentBlock::Text(t) => t.text.clone(),
            _ => String::new(),
        })
        .unwrap_or_default();
    assert!(text.contains("s-x"), "参数须注入提示文本: {text}");
    assert!(
        client
            .get_prompt(rmcp::model::GetPromptRequestParams::new("session-triage"))
            .await
            .is_err(),
        "缺参数必须是协议错误"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn subscribe_pushes_resource_updated() {
    // 订阅 tinyssh://approvals/pending → 人类侧产生新审批 →
    // GET SSE 流收到 notifications/resources/updated（推式可观测性，替代轮询）
    let (m, url, _port, token) = spawn_stack().await;
    let client = raw_init(&url, &token).await;
    let sid = m
        .create_session(
            &Actor::Human,
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();
    m.delegate_session(&Actor::Human, sid.clone(), None)
        .await
        .unwrap();

    // 规范动作：initialized 通知（202），随后开 GET SSE 流收服务器推送
    let r = client
        .post(format!("{url}/mcp"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .body(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 202, "initialized 通知应 202：{}", r.status());
    let get_resp = client
        .get(format!("{url}/mcp"))
        .header("Accept", "text/event-stream")
        .send()
        .await
        .expect("GET SSE 流");
    assert!(
        get_resp.status().is_success(),
        "GET 流应成功：{}",
        get_resp.status()
    );
    let mut stream = get_resp.bytes_stream();
    let buf: Arc<std::sync::Mutex<String>> = Arc::default();
    let buf2 = buf.clone();
    tokio::spawn(async move {
        while let Some(Ok(chunk)) = stream.next().await {
            buf2.lock()
                .unwrap()
                .push_str(&String::from_utf8_lossy(&chunk));
        }
    });

    // 订阅 → 触发（exec 走审批 → ApprovalEvent::New）→ 等推送
    let r = client
        .post(format!("{url}/mcp"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .body(
            serde_json::json!({
                "jsonrpc": "2.0", "id": 8, "method": "resources/subscribe",
                "params": {"uri": "tinyssh://approvals/pending"}
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert!(r.status().is_success(), "subscribe 应成功：{}", r.status());

    let c2 = client.clone();
    let sid2 = sid.clone();
    let url2 = url.clone();
    let exec = tokio::spawn(async move {
        c2.post(format!("{url2}/mcp"))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .body(
                serde_json::json!({
                    "jsonrpc": "2.0", "id": 9, "method": "tools/call",
                    "params": {"name": "exec", "arguments": {"session_id": sid2, "command": "printf sub_evt"}}
                })
                .to_string(),
            )
            .send()
            .await
            .expect("exec POST")
    });

    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let b = buf.lock().unwrap().clone();
        if b.contains("notifications/resources/updated")
            && b.contains("tinyssh://approvals/pending")
        {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("15s 内未收到 resources/updated 推送；缓冲：{b}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // 收敛：拒绝审批，exec 返回结构化错误；unsubscribe 幂等成功
    m.decide_approval(
        &Actor::Human,
        m.list_approvals(
            &Actor::Human,
            ApprovalFilter {
                pending_only: true,
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .first()
        .unwrap()
        .id
        .clone(),
        Decision::Deny,
    )
    .await
    .unwrap();
    let resp = tokio::time::timeout(Duration::from_secs(10), exec)
        .await
        .unwrap()
        .unwrap();
    let body = resp.text().await.unwrap_or_default();
    assert!(
        body.contains("approval_denied"),
        "拒绝后 exec 应收敛：{body}"
    );
    let r = client
        .post(format!("{url}/mcp"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .body(
            serde_json::json!({
                "jsonrpc": "2.0", "id": 10, "method": "resources/unsubscribe",
                "params": {"uri": "tinyssh://approvals/pending"}
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert!(
        r.status().is_success(),
        "unsubscribe 应成功：{}",
        r.status()
    );
}

// ---- ③ 执行记录：exec 留痕 → query_records 可查 → Agent 隔离 ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn records_capture_exec_and_are_agent_scoped() {
    let (m, url, _port, token) = spawn_stack().await;
    let client = connect(&url, &token).await;
    let sid = m
        .create_session(
            &Actor::Human,
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();
    m.delegate_session(&Actor::Human, sid.clone(), None)
        .await
        .unwrap();

    let r = client
        .call_tool(call(
            "exec",
            serde_json::json!({"session_id": sid, "command": "echo records_live"}),
        ))
        .await
        .unwrap();
    assert_eq!(r.is_error, Some(false), "{r:?}");

    // 记录可查：状态 ok、输出摘录含命令回显
    let q = client
        .call_tool(call("query_records", serde_json::json!({"limit": 50})))
        .await
        .unwrap();
    assert_eq!(q.is_error, Some(false), "{q:?}");
    let text = q
        .structured_content
        .as_ref()
        .map(|v| v.to_string())
        .unwrap_or_default();
    let out: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::json!({}));
    let records = out["records"].as_array().cloned().unwrap_or_default();
    assert!(out["total"].as_i64().unwrap_or(0) >= 1, "{text}");
    let hit = records.iter().find(|rec| {
        rec["summary"]
            .as_str()
            .map(|s| s.contains("records_live"))
            .unwrap_or(false)
    });
    let hit = hit.expect("exec 记录必须出现在 query_records 结果里");
    assert_eq!(hit["status"], "ok");
    assert_eq!(hit["agent_id"], "claude-code");
    assert!(
        hit["output_excerpt"]
            .as_str()
            .unwrap_or_default()
            .contains("records_live"),
        "输出摘录应含回显：{hit}"
    );

    // 隔离：另一个 Agent 查不到 claude-code 的记录（服务端强制 agent_id 过滤）
    let token2 = m.center.vault.create_agent("other", "Other").unwrap();
    let client2 = connect(&url, &token2).await;
    let q2 = client2
        .call_tool(call("query_records", serde_json::json!({})))
        .await
        .unwrap();
    let text2 = q2
        .structured_content
        .as_ref()
        .map(|v| v.to_string())
        .unwrap_or_default();
    let out2: serde_json::Value = serde_json::from_str(&text2).unwrap_or(serde_json::json!({}));
    assert_eq!(
        out2["total"].as_i64().unwrap_or(-1),
        0,
        "另一 Agent 不得看到别人的记录：{text2}"
    );
}
