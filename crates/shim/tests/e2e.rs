//! rev-r46 P0 回归：**真实 stdio shim 二进制 × 真实 streamable HTTP 端点**全链路。
//!
//! 此前 shim 三处断裂导致 stdio 入口整体不可用（且零测试覆盖）：
//! 1. 不回传 `Mcp-Session-Id` → 服务端对非 initialize 请求一律 4xx；
//! 2. SSE 解析只取第一个 `data:` 行 → 命中空 priming 帧，initialize 响应被丢成空行；
//! 3. 非 JSON 错误体原样进 stdout、通知也被回写。
//! 本文件用 CARGO_BIN_EXE 拉起真二进制喂 stdio，任何一处回归都会在这里炸。

use std::sync::Arc;
use std::time::Duration;

use core_session::SessionManager;
use session_api::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::time::timeout;

fn test_master_key() {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
}

async fn spawn_stack() -> (
    Arc<SessionManager>,
    String,
    String,
    tinyssh_mcp_server::EndpointHandle,
) {
    test_master_key();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t.db");
    std::mem::forget(dir);
    let m = SessionManager::open(&db).unwrap();
    m.collab_enable(&Actor::Human).await.unwrap();
    let token = m
        .center
        .vault
        .create_agent("stdio-agent", "stdio 接入")
        .unwrap();
    let resolver: tinyssh_mcp_server::TokenResolver = {
        let vault = m.center.vault.clone();
        std::sync::Arc::new(move |t: &str| vault.resolve_token(t))
    };
    // 句柄必须存活并随栈返回：shutdown watch 发送端一 drop 即触发端点停机
    let (port, handle) =
        tinyssh_mcp_server::spawn_endpoint_with_shutdown(m.clone(), resolver, 0)
            .await
            .unwrap();
    let url = format!("http://127.0.0.1:{port}/mcp");
    (m, url, token, handle)
}

struct ShimProcess {
    child: Child,
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
}

impl ShimProcess {
    async fn start(token: &str, url: &str) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_tinyssh-mcp"))
            .env("TINYSSH_TOKEN", token)
            .env("TINYSSH_MCP_URL", url)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn shim binary");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self { child, stdin, stdout }
    }

    async fn send(&mut self, v: serde_json::Value) {
        self.stdin
            .write_all(format!("{}\n", v).as_bytes())
            .await
            .unwrap();
        self.stdin.flush().await.unwrap();
    }

    /// 读一行（带超时）；None = 窗口内无输出（断言「通知不回写」用）
    async fn read_line(&mut self, dur: Duration) -> Option<String> {
        let mut line = String::new();
        match timeout(dur, self.stdout.read_line(&mut line)).await {
            Ok(Ok(0)) | Err(_) => None,
            Ok(Ok(_)) => Some(line),
            Ok(Err(_)) => None,
        }
    }
}

fn drop_shim(mut s: ShimProcess) {
    let _ = s.child.start_kill();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shim_stdio_full_handshake() {
    let (_m, url, token, _ep) = spawn_stack().await;
    let mut shim = ShimProcess::start(&token, &url).await;

    // 1) initialize：必须收到**真实 JSON-RPC 结果**（回归点：以前是空行）
    shim.send(serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "shim-e2e", "version": "0.1"}
        }
    }))
    .await;
    let init_line = shim
        .read_line(Duration::from_secs(10))
        .await
        .expect("initialize 必须有响应（SSE 空 priming 帧不得吞掉结果）");
    let init: serde_json::Value = serde_json::from_str(&init_line)
        .unwrap_or_else(|e| panic!("initialize 响应必须是合法 JSON-RPC：{init_line:?}（{e}）"));
    assert_eq!(init["id"], 1, "响应关联正确请求 id：{init_line:?}");
    assert!(
        init.get("error").is_none(),
        "initialize 不得报错：{init_line:?}"
    );
    assert_eq!(
        init["result"]["serverInfo"]["name"].as_str(),
        Some("tinyssh-mcp"),
        "握手结果缺失：{init_line:?}"
    );

    // 2) notifications/initialized：通知**不回写**（回归点：以前回写 4xx 错误体）
    shim.send(serde_json::json!({
        "jsonrpc": "2.0", "method": "notifications/initialized"
    }))
    .await;
    let leaked = shim.read_line(Duration::from_millis(1500)).await;
    assert!(
        leaked.is_none(),
        "通知不得产生输出行：{leaked:?}"
    );

    // 3) tools/list：session id 回传后的第一个真请求（回归点：以前 4xx）
    shim.send(serde_json::json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))
        .await;
    let tl_line = shim
        .read_line(Duration::from_secs(10))
        .await
        .expect("tools/list 必须有响应（session id 必须被回传）");
    let tl: serde_json::Value =
        serde_json::from_str(&tl_line).unwrap_or_else(|e| panic!("tools/list 非 JSON：{tl_line:?}（{e}）"));
    assert!(tl.get("error").is_none(), "tools/list 报错：{tl_line:?}");
    let names: Vec<&str> = tl["result"]["tools"]
        .as_array()
        .expect("tools 数组")
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    for expected in ["exec", "list_sessions", "sftp_list", "retry_transfer"] {
        assert!(names.contains(&expected), "工具缺失 {expected}：{names:?}");
    }

    // 4) 工具真调用：list_sessions（走完整 HTTP→SessionApi 链）
    shim.send(serde_json::json!({
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "list_sessions", "arguments": {}}
    }))
    .await;
    let call_line = shim
        .read_line(Duration::from_secs(10))
        .await
        .expect("tools/call 必须有响应");
    let call: serde_json::Value = serde_json::from_str(&call_line)
        .unwrap_or_else(|e| panic!("tools/call 非 JSON：{call_line:?}（{e}）"));
    assert!(
        call.get("error").is_none() && call["result"].get("isError") != Some(&serde_json::json!(true)),
        "list_sessions 调用失败：{call_line:?}"
    );

    drop_shim(shim);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shim_bad_token_maps_to_jsonrpc_error() {
    // 回归点：HTTP 非 2xx 不再把非 JSON 错误体原样塞进 stdout
    let (_m, url, _token, _ep) = spawn_stack().await;
    let mut shim = ShimProcess::start("wrong-token", &url).await;
    shim.send(serde_json::json!({
        "jsonrpc": "2.0", "id": 7, "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "shim-e2e", "version": "0.1"}
        }
    }))
    .await;
    let line = shim
        .read_line(Duration::from_secs(10))
        .await
        .expect("认证失败也必须返回 JSON-RPC error");
    let v: serde_json::Value = serde_json::from_str(&line)
        .unwrap_or_else(|e| panic!("错误响应必须是 JSON-RPC：{line:?}（{e}）"));
    assert_eq!(v["id"], 7);
    assert_eq!(v["error"]["code"], -32000, "HTTP 层错误映射 -32000：{line:?}");
    assert!(
        v["error"]["message"]
            .as_str()
            .map(|m| m.contains("401"))
            .unwrap_or(false),
        "错误信息应携带上游状态码：{line:?}"
    );
    drop_shim(shim);
}
