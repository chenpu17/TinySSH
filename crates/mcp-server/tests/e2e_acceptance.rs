//! E2E 首个可运行验收场景（PRD §10 / validation-plan §3）：
//!   旧请求待审批 → 人接管修改现场 → 交还 → 旧请求（含待审批卡片）失效
//!   → Agent 核实后重新提交。
//! 全程 MCP（rmcp 客户端）驱动 Agent 侧；人类侧走同一 SessionApi（Actor::Human）。
//! 门控：TINYSSH_E2E_SSHD=1（scripts/dev-sshd.sh）。

use std::sync::Arc;
use std::time::Duration;

use rmcp::model::{CallToolRequestParams, ClientConfig};
use rmcp::service::{ClientServiceExt as _, RoleClient, RunningService};
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
};
use rmcp::ClientLifecycleMode;
use session_api::*;

fn sshd_enabled() -> bool {
    let gate = std::env::var("TINYSSH_E2E_SSHD")
        .map(|v| v == "1")
        .unwrap_or(false);
    if gate && !tinyssh_testbed::docker_available() {
        // 本机 sshd 替代路径不带容器：六条旅程是「MCP 栈 × 容器会话」的重型
        // 集成面（Agent create_session 审批卡在本机栈 15s 内不出现，结构差异
        // 非时序），留容器 CI 跑；传输层/会话层已由 sshd_e2e/core_local 本机绿。
        eprintln!("skip: 本套件需容器（本机 sshd 替代路径上 MCP 集成面未适配）");
        return false;
    }
    gate
}

/// T17 主机指纹门的测试侧人类应答器：轮询待决指纹并按人类身份接受。
/// 与真实 UI 流程同构（FirstSeen → 决定 → 信任入库 → 放行）——门禁本身无测试旁路，
/// MCP e2e 的会话创建必须有人应答才能继续。任务随各测试的 tokio runtime 结束回收。
fn auto_accept_host_keys(m: Arc<core_session::SessionManager>) {
    let human = Actor::Human;
    tokio::spawn(async move {
        loop {
            if let Ok(items) = m.pending_host_keys(&human).await {
                for it in items {
                    let _ = m.decide_host_key(&human, &it.id, true).await;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    });
}

async fn spawn_stack() -> (Arc<core_session::SessionManager>, String, String) {
    // 主密钥走 env（vault 解析序 env > OS 钥匙串）：避免测试二进制重编译后
    // 签名变化触发 macOS 钥匙串授权弹窗并阻塞测试进程。
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
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

    // 注册 e2e sshd 主机（docker 契约或本机替代，端点可经环境覆盖）
    let (_host, port, username, password) = tinyssh_testbed::sshd_endpoint();
    m.upsert_host(
        &Actor::Human,
        HostDraft {
            id: Some("e2e-linux".into()),
            name: "e2e-linux".into(),
            address: "127.0.0.1".into(),
            port: Some(port),
            username: username.into(),
            auth: AuthDraft::Password {
                password: password.into(),
            },
            tags: vec![],
            charset: Default::default(),
            shell_integration: Some(true),
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
    r.structured_content
        .clone()
        .unwrap_or(serde_json::Value::Null)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn acceptance_scenario_on_ssh() {
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let _sshd_guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    let (m, url, token) = spawn_stack().await;
    auto_accept_host_keys(m.clone());
    let human = Actor::Human;
    let mut client = connect(&url, &token).await;

    // ---- Agent：create_session（远程 → 人类批准）----
    let client_c = connect(&url, &token).await;
    let jh = tokio::spawn(async move {
        client_c
            .call_tool(call(
                "create_session",
                serde_json::json!({"host_id": "e2e-linux"}),
            ))
            .await
    });
    let mut card = None;
    for _ in 0..1500 {
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
        if let Some(it) = items.first() {
            card = Some(it.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    m.decide_approval(
        &human,
        card.expect("create_session 卡片"),
        Decision::Approve,
    )
    .await
    .unwrap();
    let r = jh.await.unwrap().unwrap();
    let sid = structured(&r)["session_id"].as_str().unwrap().to_string();

    // ---- 步骤 1：Agent 提交 exec → 待审批（阻塞中）----
    let client_a = connect(&url, &token).await;
    let sid_a = sid.clone();
    let jh_agent = tokio::spawn(async move {
        client_a
            .call_tool(call(
                "exec",
                serde_json::json!({"session_id": sid_a, "command": "echo old_request_should_die"}),
            ))
            .await
    });
    let mut old_card = None;
    for _ in 0..300 {
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
        if let Some(it) = items
            .iter()
            .find(|it| it.command.contains("old_request_should_die"))
        {
            old_card = Some(it.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let old_card = old_card.expect("旧请求卡片未出现");

    // ---- 步骤 2：人接管（冻结；不作废运行中——无运行任务）----
    let report = m
        .set_control(
            &human,
            sid.clone(),
            ControlOwner::Human,
            ControlOpts::default(),
        )
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
    let items = m
        .list_approvals(&human, ApprovalFilter::default())
        .await
        .unwrap();
    let card_status = items.iter().find(|it| it.id == old_card).unwrap().status;
    assert_eq!(card_status, ApprovalStatus::Voided);
    let revive = m
        .decide_approval(&human, old_card.clone(), Decision::Approve)
        .await;
    assert!(revive.is_err(), "作废卡片不可再生效");
    // Agent 侧控制权被拒
    let r = client
        .call_tool(call(
            "exec",
            serde_json::json!({"session_id": sid, "command": "echo blocked"}),
        ))
        .await
        .unwrap();
    assert_eq!(err_kind(&r).as_deref(), Some("control_taken_by_human"));

    // ---- 步骤 5：人类修改现场（mkdir + cd；Human 短路审批）----
    m.exec(
        &human,
        sid.clone(),
        "mkdir -p /tmp/handoff-demo && cd /tmp/handoff-demo && touch marker_from_human",
        ExecOpts::default(),
    )
    .await
    .unwrap();

    // ---- 步骤 6：人交还 ----
    m.set_control(
        &human,
        sid.clone(),
        ControlOwner::Agent,
        ControlOpts::default(),
    )
    .await
    .unwrap();

    // ---- 步骤 7：Agent 读简报核实（cwd 已变为人工现场）----
    let r = client
        .call_tool(call(
            "get_session_brief",
            serde_json::json!({"session_id": sid}),
        ))
        .await
        .unwrap();
    let brief = structured(&r);
    assert_eq!(
        brief["cwd"].as_str(),
        Some("/tmp/handoff-demo"),
        "简报 cwd={brief}"
    );

    // ---- 步骤 8：Agent 核实后重新提交 → 批准 → 在新现场执行 ----
    let client_b = connect(&url, &token).await;
    let sid_b = sid.clone();
    let jh_resub = tokio::spawn(async move {
        client_b
            .call_tool(call(
                "exec",
                serde_json::json!({"session_id": sid_b, "command": "pwd && ls marker_from_human"}),
            ))
            .await
    });
    let mut resub_card = None;
    for _ in 0..300 {
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
        if let Some(it) = items.iter().find(|it| it.command.contains("pwd")) {
            resub_card = Some(it.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    m.decide_approval(&human, resub_card.expect("重新提交卡片"), Decision::Approve)
        .await
        .unwrap();
    let r = jh_resub.await.unwrap().unwrap();
    assert_eq!(r.is_error, Some(false), "{r:?}");
    let out = structured(&r);
    let stdout = out["stdout"].as_str().unwrap_or_default();
    assert!(stdout.contains("/tmp/handoff-demo"), "新现场 cwd：{stdout}");
    assert!(
        stdout.contains("marker_from_human"),
        "人类修改可见：{stdout}"
    );

    // 旧请求没有被自动执行：审计里没有 old_request_should_die 的成功 exec
    let page = m
        .query_audit(
            &human,
            AuditFilter {
                session_id: Some(sid.clone()),
                limit: 1000,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let old_ran = page.events.iter().any(|ev| {
        ev.action == "exec"
            && ev
                .command
                .as_deref()
                .unwrap_or("")
                .contains("old_request_should_die")
    });
    assert!(!old_ran, "旧请求被自动执行了！");
    let _ = client.close().await;
}

/// 旅程 2：断线重连 → Reconfirming（白名单外动作被拒；核实后自动恢复）。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn journey2_reconnect_reconfirm() {
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let _sshd_guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    let (m, _url, _token) = spawn_stack().await;
    auto_accept_host_keys(m.clone());
    let human = Actor::Human;

    let sid = m
        .create_session(
            &human,
            CreateSessionReq {
                host_id: "e2e-linux".into(),
            },
        )
        .await
        .unwrap();
    m.exec(
        &human,
        sid.clone(),
        "cd /tmp && echo ready",
        ExecOpts::default(),
    )
    .await
    .unwrap();

    // 断线：重启 sshd（容器=docker restart，本机=net stop+start；sshd 重启 <2s；
    // 核心 3 次重连机会，间隔 2s）
    tinyssh_testbed::bounce_sshd();

    // 等待核心完成重连并进入 Reconfirming
    let mut reached = false;
    for _i in 0..450 {
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
    let r = m
        .exec(
            &Actor::Agent {
                client_id: "opencode".into(),
            },
            sid.clone(),
            "touch /tmp/nope",
            ExecOpts::default(),
        )
        .await;
    assert!(matches!(r, Err(Error::ReconfirmingPending)), "得到 {r:?}");

    // M1 回归：白名单命令携带复合段同样被拒（前缀匹配不得绕过重确认门槛）
    let r = m
        .exec(
            &Actor::Agent {
                client_id: "opencode".into(),
            },
            sid.clone(),
            "pwd && touch /tmp/nope2",
            ExecOpts::default(),
        )
        .await;
    assert!(
        matches!(r, Err(Error::ReconfirmingPending)),
        "复合白名单被放行？{r:?}"
    );

    // 白名单核实（Agent 侧允许）
    let r = m
        .exec(
            &Actor::Agent {
                client_id: "opencode".into(),
            },
            sid.clone(),
            "pwd",
            ExecOpts::default(),
        )
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
    m.exec(
        &human,
        sid.clone(),
        "echo after_reconfirm",
        ExecOpts::default(),
    )
    .await
    .unwrap();
}

/// 旅程 3（T13）：重连死端 → 一键重连闭环。
/// 与旅程 2（自动重连：容器 <2s 内回来）互补：这里 sshd 真正下线超过自动重连窗口，
/// 核心进入 Disconnected 死端；容器恢复后 reconnect_session 手动恢复。
/// 场景含 docker stop/start（慢且对时序敏感），与 sshd_e2e/spike2 同款两次尝试兜底
///（§6-11 并发 flake 家族；v1.15–v1.19 回归漏带 e2e 守卫跳过未暴露）。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn journey3_manual_reconnect_after_hard_down() {
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let _sshd_guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    let mut last = String::new();
    for attempt in 0..2 {
        let r = std::panic::AssertUnwindSafe(journey3_scenario());
        match futures_util::FutureExt::catch_unwind(r).await {
            Ok(Ok(())) => return,
            Ok(Err(e)) => last = e,
            Err(p) => last = format!("panic: {p:?}"),
        }
        eprintln!("journey3 attempt {attempt} failed: {last}; retrying…");
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    panic!("journey3 两次尝试均失败: {last}");
}

async fn journey3_scenario() -> std::result::Result<(), String> {
    struct SshdStartGuard;
    impl Drop for SshdStartGuard {
        fn drop(&mut self) {
            // 任何退出路径（含断言失败 panic）都把 sshd 拉起，不污染后续测试
            tinyssh_testbed::sshd_up();
        }
    }
    let (m, _url, _token) = spawn_stack().await;
    auto_accept_host_keys(m.clone());
    let human = Actor::Human;
    let sid = m
        .create_session(
            &human,
            CreateSessionReq {
                host_id: "e2e-linux".into(),
            },
        )
        .await
        .unwrap();
    m.exec(
        &human,
        sid.clone(),
        "cd /tmp && echo up_before_down",
        ExecOpts::default(),
    )
    .await
    .unwrap();

    // sshd 下线超过自动重连窗口（3 次尝试 + 2s 间隔）→ Disconnected 死端
    tinyssh_testbed::sshd_down();
    let _sshd_guard = SshdStartGuard;
    let mut dead = false;
    for _ in 0..600 {
        let sessions = m.list_sessions(&human).await.unwrap();
        if let Some(s) = sessions.iter().find(|s| s.id == sid) {
            if s.state == SessionState::Disconnected {
                dead = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(dead, "sshd 下线后会话应进入 Disconnected 死端");

    // 死端上 exec 明确失败
    let r = m
        .exec(&human, sid.clone(), "echo should_fail", ExecOpts::default())
        .await;
    assert!(r.is_err(), "死端 exec 应失败: {r:?}");

    // sshd 恢复 → 一键重连
    tinyssh_testbed::sshd_up();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;

    m.reconnect_session(&sid).await.unwrap();
    // 进入重确认；白名单核实（pwd）→ 自动退出重确认
    let mut reconfirmed = false;
    for _ in 0..300 {
        let sessions = m.list_sessions(&human).await.unwrap();
        if let Some(s) = sessions.iter().find(|s| s.id == sid) {
            if s.state == SessionState::Reconfirming {
                reconfirmed = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(reconfirmed, "重连后应进入 Reconfirming");

    let r = m
        .exec(&human, sid.clone(), "pwd", ExecOpts::default())
        .await
        .unwrap();
    assert!(
        r.stdout.trim().starts_with("/"),
        "重连后应在新 shell: {:?}",
        r.stdout
    );
    let mut connected = false;
    for _ in 0..100 {
        let sessions = m.list_sessions(&human).await.unwrap();
        if let Some(s) = sessions.iter().find(|s| s.id == sid) {
            if s.state == SessionState::Connected {
                connected = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(connected, "核实后应自动退出 Reconfirming");

    // 恢复后普通动作可用（审计应含手动重连事件）
    m.exec(
        &human,
        sid.clone(),
        "echo after_manual_reconnect",
        ExecOpts::default(),
    )
    .await
    .unwrap();
    let page = m
        .query_audit(
            &human,
            AuditFilter {
                session_id: Some(sid.clone()),
                limit: 100,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        page.events
            .iter()
            .any(|ev| ev.action == "session_reconnect"),
        "审计应含 session_reconnect 事件"
    );
    Ok(())
}

/// 旅程 4（T13 / P1 §6-17）：脏状态断线 → 自动重连。
/// 命令键入到一半（未回车、未闭合引号）时容器重启：
/// ① 屏上不得残留注入片段明文（§6-17 回显泄漏检查；重注入就绪等 B 标记=清屏已执行）；
/// ② 残留块被强制收尾，shell exec 立即可用（不收尾则永久等块空闲超时）；
/// ③ 半截命令不得被执行（新 shell 不延续现场）。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn journey4_reconnect_with_dirty_typing_state() {
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let _sshd_guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    struct ContainerStartGuard;
    impl Drop for ContainerStartGuard {
        fn drop(&mut self) {
            let _ = std::process::Command::new("docker")
                .args(["start", "tinyssh-e2e"])
                .output();
        }
    }
    let (m, _url, _token) = spawn_stack().await;
    auto_accept_host_keys(m.clone());
    let human = Actor::Human;
    let sid = m
        .create_session(
            &human,
            CreateSessionReq {
                host_id: "e2e-linux".into(),
            },
        )
        .await
        .unwrap();
    m.exec(
        &human,
        sid.clone(),
        "cd /tmp && echo dirty_base",
        ExecOpts::default(),
    )
    .await
    .unwrap();

    // 键入一半（无回车）→ 屏上留下 Typing 相残留
    m.send_keys(&human, sid.clone(), "echo 'half_typed_command")
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // 容器重启（2s 内回来）→ 自动重连路径
    let _ = std::process::Command::new("docker")
        .args(["restart", "tinyssh-e2e"])
        .output()
        .expect("docker restart");
    let _container_guard = ContainerStartGuard;

    let mut reconfirmed = false;
    for _ in 0..600 {
        let sessions = m.list_sessions(&human).await.unwrap();
        if let Some(s) = sessions.iter().find(|s| s.id == sid) {
            if s.state == SessionState::Reconfirming {
                reconfirmed = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(reconfirmed, "自动重连后未进入 Reconfirming");

    // ① 屏上不得残留注入片段明文
    let snap = m.read_screen(&human, sid.clone()).await.unwrap();
    assert!(
        !snap.text.contains("PROMPT_COMMAND")
            && !snap.text.contains("__t_prompt")
            && !snap.text.contains("printf '\\033[2J"),
        "重连后注入片段明文泄漏进屏: {:?}",
        snap.text
    );

    // ②③ shell exec 立即可用；新 shell 起始 cwd 是 /root（半截命令未执行、现场不延续）
    let r = m
        .exec(
            &human,
            sid.clone(),
            "pwd",
            ExecOpts {
                timeout: Some(Duration::from_secs(15)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        r.stdout.contains("/root"),
        "新 shell 应在 /root（半截命令不得执行）: {:?}",
        r.stdout
    );

    let mut connected = false;
    for _ in 0..100 {
        let sessions = m.list_sessions(&human).await.unwrap();
        if let Some(s) = sessions.iter().find(|s| s.id == sid) {
            if s.state == SessionState::Connected {
                connected = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(connected, "核实后应自动退出 Reconfirming");
}

/// 回归（T9 走查发现）：read_screen 语义是"当前屏幕"——
/// (a) 不得包含 scrollback（清屏前旧内容如 MOTD/集成注入回显不得回魂）；
/// (b) 集成注入 + 2J 清屏后，用户首屏应只有提示符，没有集成代码。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn create_session_screen_is_clean() {
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let _sshd_guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    let (m, _url, _token) = spawn_stack().await;
    auto_accept_host_keys(m.clone());
    let human = Actor::Human;
    let sid = m
        .create_session(
            &human,
            CreateSessionReq {
                host_id: "e2e-linux".into(),
            },
        )
        .await
        .unwrap();
    let snap = m.read_screen(&human, sid).await.unwrap();
    assert!(
        !snap.text.contains("__t_prompt") && !snap.text.contains("PROMPT_COMMAND"),
        "read_screen 泄漏集成注入回显:\n{}",
        snap.text
    );
    assert!(
        !snap.text.contains("Welcome to Alpine"),
        "read_screen 混入 scrollback（MOTD）:\n{}",
        snap.text
    );
}

// T44（V1 收口）：Agent 建隧道/停隧道逐段审批——批准后隧道真实可用、停止必审、
// 拒绝即不建；非回环监听地址被拒（审核中-6）。
fn t44_free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn t44_wait_card(
    m: &Arc<core_session::SessionManager>,
    human: &Actor,
    needle: &str,
) -> String {
    for _ in 0..300 {
        let items = m
            .list_approvals(
                human,
                ApprovalFilter {
                    pending_only: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        if let Some(it) = items.iter().find(|it| it.command.contains(needle)) {
            return it.id.clone();
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("卡片未出现（{needle}）");
}

async fn t44_read_banner(tcp: &mut tokio::net::TcpStream) -> String {
    use tokio::io::AsyncReadExt as _;
    let mut buf = Vec::new();
    let mut b = [0u8; 1];
    let fut = async {
        loop {
            tcp.read_exact(&mut b).await.unwrap();
            buf.push(b[0]);
            if b[0] == b'\n' || buf.len() > 255 {
                break;
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(10), fut)
        .await
        .expect("10s 未读到 banner");
    String::from_utf8_lossy(&buf).into_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn journey5_agent_forward_approval_flow() {
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let _sshd_guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    let (m, url, token) = spawn_stack().await;
    auto_accept_host_keys(m.clone());
    let human = Actor::Human;
    let client = connect(&url, &token).await;

    // 建会话（远程默认必审，与既有旅程同款门）
    let client_c = connect(&url, &token).await;
    let jh = tokio::spawn(async move {
        client_c
            .call_tool(call(
                "create_session",
                serde_json::json!({"host_id": "e2e-linux"}),
            ))
            .await
    });
    let card = t44_wait_card(&m, &human, "create_session").await;
    m.decide_approval(&human, card, Decision::Approve)
        .await
        .unwrap();
    let r = jh.await.unwrap().unwrap();
    let sid = structured(&r)["session_id"].as_str().unwrap().to_string();

    // ---- Agent 建本地转发：卡（人类可读 -L 描述）→ 批准 → fid ----
    // 转发状态事件（T44 真机冒烟补口）：建/停等写口广播 Changed——UI 事件驱动
    // 刷新依赖此通道（真机实测 WKWebView 节流 timer 时 3s 盲轮询会挂起）
    let mut fwd_ev = m.subscribe_forwards();
    let lp = t44_free_port();
    let client_f = connect(&url, &token).await;
    let sid_f = sid.clone();
    let jh_f = tokio::spawn(async move {
        client_f
            .call_tool(call(
                "forward_start",
                serde_json::json!({
                    "session_id": sid_f,
                    "spec": { "Local": { "listen_addr": "127.0.0.1", "listen_port": lp,
                                          "target_host": "127.0.0.1", "target_port": 22 } }
                }),
            ))
            .await
    });
    let fwd_cmd = format!("端口转发 -L 127.0.0.1:{lp}");
    let card = t44_wait_card(&m, &human, &fwd_cmd).await;
    // 卡片段落报告人类可读（逐段审批语义）
    {
        let items = m
            .list_approvals(&human, ApprovalFilter::default())
            .await
            .unwrap();
        let it = items.iter().find(|it| it.id == card).unwrap();
        assert!(
            it.segment_report
                .iter()
                .any(|s| s.segment.contains("-L") && s.verdict.contains("端口转发")),
            "{:?}",
            it.segment_report
        );
    }
    m.decide_approval(&human, card, Decision::Approve)
        .await
        .unwrap();
    let r = jh_f.await.unwrap().unwrap();
    let fid = structured(&r)["forward_id"].as_str().unwrap().to_string();

    // ---- Agent 可查状态：Listening；隧道真实可用（读容器 sshd banner）----
    let r = client
        .call_tool(call(
            "forwards_list",
            serde_json::json!({"session_id": sid}),
        ))
        .await
        .unwrap();
    let fwd = structured(&r)["forwards"][0].clone();
    assert_eq!(fwd["state"], "Listening", "{fwd:?}");
    let mut tcp = tokio::net::TcpStream::connect(("127.0.0.1", lp))
        .await
        .expect("本地监听应可连");
    let banner = t44_read_banner(&mut tcp).await;
    assert!(
        banner.starts_with("SSH-2.0"),
        "经审批建立的隧道应通：{banner:?}"
    );

    // ---- 非回环监听地址被拒（审核中-6；人类路径同样走 transport 校验）----
    let bad = m
        .start_forward(
            &human,
            sid.clone(),
            session_api::ForwardSpec::Local {
                listen_addr: "0.0.0.0".into(),
                listen_port: t44_free_port(),
                target_host: "127.0.0.1".into(),
                target_port: 22,
            },
        )
        .await;
    assert!(bad.is_err(), "0.0.0.0 监听应被拒");

    // ---- Agent 停转发：同样必审 ----
    let client_s = connect(&url, &token).await;
    let sid_s = sid.clone();
    let fid_s = fid.clone();
    let jh_s = tokio::spawn(async move {
        client_s
            .call_tool(call(
                "forward_stop",
                serde_json::json!({"session_id": sid_s, "forward_id": fid_s}),
            ))
            .await
    });
    let card = t44_wait_card(&m, &human, &fwd_cmd).await; // 停卡命令串=「停止 +同描述」前缀，pending 队列再现
    m.decide_approval(&human, card, Decision::Approve)
        .await
        .unwrap();
    let r = jh_s.await.unwrap().unwrap();
    assert_eq!(structured(&r)["stopped"], true);

    // 停止后：列表空、端口关闭
    let r = client
        .call_tool(call(
            "forwards_list",
            serde_json::json!({"session_id": sid}),
        ))
        .await
        .unwrap();
    assert_eq!(structured(&r)["forwards"].as_array().unwrap().len(), 0);
    for _ in 0..30 {
        if tokio::net::TcpStream::connect(("127.0.0.1", lp))
            .await
            .is_err()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", lp))
            .await
            .is_err(),
        "停止后监听应关闭"
    );

    // 事件收账：建 + 停至少各一条 Changed{session_id}（写口 → 广播全链）
    let mut ev_n = 0u32;
    while let Ok(ev) = fwd_ev.try_recv() {
        assert!(
            matches!(ev, session_api::ForwardEvent::Changed { ref session_id } if *session_id == sid),
            "转发事件应带本会话 id：{ev:?}"
        );
        ev_n += 1;
    }
    assert!(ev_n >= 2, "建/停写口都应广播 Changed：{ev_n}");

    // ---- 拒绝路径：建转发被拒 → Agent 收审批拒绝错误，转发未建 ----
    let client_d = connect(&url, &token).await;
    let sid_d = sid.clone();
    let jh_d = tokio::spawn(async move {
        client_d
            .call_tool(call("forward_start", serde_json::json!({
                "session_id": sid_d,
                "spec": { "Dynamic": { "listen_addr": "127.0.0.1", "listen_port": t44_free_port() } }
            })))
            .await
    });
    let card = t44_wait_card(&m, &human, "端口转发 -D").await;
    m.decide_approval(&human, card, Decision::Deny)
        .await
        .unwrap();
    let r = jh_d.await.unwrap().unwrap();
    let kind = err_kind(&r).unwrap_or_default();
    assert!(
        kind.contains("denied") || kind.contains("Deny"),
        "拒绝应回审批拒绝错误：{kind}"
    );
    let r = client
        .call_tool(call(
            "forwards_list",
            serde_json::json!({"session_id": sid}),
        ))
        .await
        .unwrap();
    assert_eq!(
        structured(&r)["forwards"].as_array().unwrap().len(),
        0,
        "拒绝后不应有转发"
    );

    // ---- 编辑后批准被后端拦截（复审②）：转发参数无法从编辑文本回解，不得静默
    // 按原文执行（UI 已按 editable 隐藏编辑钮，此处证后端防线对任何前端成立）----
    let lp2 = t44_free_port();
    let client_e = connect(&url, &token).await;
    let sid_e = sid.clone();
    let jh_e = tokio::spawn(async move {
        client_e
            .call_tool(call(
                "forward_start",
                serde_json::json!({
                    "session_id": sid_e,
                    "spec": { "Local": { "listen_addr": "127.0.0.1", "listen_port": lp2,
                                          "target_host": "127.0.0.1", "target_port": 22 } }
                }),
            ))
            .await
    });
    let card = t44_wait_card(&m, &human, &format!("端口转发 -L 127.0.0.1:{lp2}")).await;
    m.decide_approval(
        &human,
        card,
        Decision::ApproveEdited("端口转发 -L 127.0.0.1:9999 → 别的目标:22".into()),
    )
    .await
    .unwrap();
    let r = jh_e.await.unwrap().unwrap();
    let kind = err_kind(&r).unwrap_or_default();
    assert!(
        kind.contains("Invalid") || kind.contains("invalid"),
        "编辑后批准应被拒：{kind}"
    );
    let r = client
        .call_tool(call(
            "forwards_list",
            serde_json::json!({"session_id": sid}),
        ))
        .await
        .unwrap();
    assert_eq!(
        structured(&r)["forwards"].as_array().unwrap().len(),
        0,
        "编辑拦截后不应有转发（原文也不建）"
    );

    // ---- 会话关闭作废滞留卡（T44 复核中-1）：堵「批了已死会话的卡 → 僵尸监听」----
    // 此前 close_session 不作废 pending 卡，human 仍可批准 → transport 层 bind 不查
    // 会话状态 → 造出 forwards_list 查不到、无入口可停的监听（泄漏到进程退出）
    let lp3 = t44_free_port();
    let client_v = connect(&url, &token).await;
    let sid_v = sid.clone();
    let jh_v = tokio::spawn(async move {
        client_v
            .call_tool(call(
                "forward_start",
                serde_json::json!({
                    "session_id": sid_v,
                    "spec": { "Local": { "listen_addr": "127.0.0.1", "listen_port": lp3,
                                          "target_host": "127.0.0.1", "target_port": 22 } }
                }),
            ))
            .await
    });
    let card = t44_wait_card(&m, &human, &format!("端口转发 -L 127.0.0.1:{lp3}")).await;
    // 关闭会话：卡随之作废、Agent 等待即醒（不空等 120s）
    m.close_session(&human, sid.clone()).await.unwrap();
    {
        let items = m
            .list_approvals(&human, ApprovalFilter::default())
            .await
            .unwrap();
        let it = items.iter().find(|it| it.id == card).unwrap();
        assert_eq!(it.status, ApprovalStatus::Voided, "会话关闭应作废其待决卡");
    }
    let r = jh_v.await.unwrap().unwrap();
    let kind = err_kind(&r).unwrap_or_default();
    assert!(
        kind.contains("voided"),
        "Agent 应收到作废错误而非僵尸成功：{kind}"
    );
    // 作废的卡不可再生效（事后补批被拦）
    assert!(
        m.decide_approval(&human, card, Decision::Approve)
            .await
            .is_err(),
        "作废卡不可再批"
    );
}
