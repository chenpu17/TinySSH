//! tinyssh-mcp shim：对 Agent 说 stdio MCP，向应用端点说 streamable HTTP（L1 §3.5 / L0 ADR-4）。
//!
//! rev-r46 重写（此前实现三处断裂，stdio 入口实际不可用，见 tests/e2e.rs 回归）：
//! 1. 会话回传：捕获 initialize 响应的 `Mcp-Session-Id` 并回传后续请求——rmcp 服务端
//!    legacy 会话模式下，不带 session id 的非 initialize 请求一律 4xx；
//! 2. SSE 帧完整解析：跳过空 priming 帧（`retry:`）与注释行，逐帧把 JSON-RPC 消息
//!    实时写给 stdout（审批挂起期间的 progress 心跳因此能透传给 stdio 客户端）；
//! 3. 并发转发：每行一个 task（JSON-RPC 按 id 关联，乱序合法）；通知（无 id）不回写；
//!    HTTP 非 2xx 映射为 JSON-RPC error（不再把非 JSON 错误体原样塞进 stdout）。
//!
//! 配置：Token 经 `TINYSSH_TOKEN`；端点经 `TINYSSH_MCP_URL`（默认 127.0.0.1:8722/mcp）；
//! 单请求超时经 `TINYSSH_MCP_TIMEOUT_SECS`（默认 180，须覆盖应用侧 120s 审批挂起）。

use std::io::{BufRead, Write};
use std::time::Duration;

use futures_util::StreamExt;
use tokio::sync::{mpsc, watch};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let token = std::env::var("TINYSSH_TOKEN").unwrap_or_default();
    let url =
        std::env::var("TINYSSH_MCP_URL").unwrap_or_else(|_| "http://127.0.0.1:8722/mcp".into());
    let timeout_secs: u64 = std::env::var("TINYSSH_MCP_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(180);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs)) // 审批等待表现为长时工具调用；不得先于应用端超时
        .no_proxy() // 回环直连：用户环境的 HTTP_PROXY 不应劫持本机 MCP 流量
        .build()
        .expect("http client");

    // initialize 响应携带的 Mcp-Session-Id；后续所有请求回传（无 session 的请求
    // 会被服务端拒绝）。watch 兼作屏障：initialize 之后到达的请求等它落位。
    let (sid_tx, sid_rx) = watch::channel(None::<String>);

    // 逐行读 stdio（JSON-RPC）；每行一个并发 task 转发
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    tokio::task::spawn_blocking(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(l) if !l.trim().is_empty() => {
                    if tx.send(l).is_err() {
                        break;
                    }
                }
                Ok(_) => continue,
                Err(_) => break,
            }
        }
    });

    // 单一写者：并发 task 的响应行经队列串行落 stdout，避免交错半行
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let mut stdout = std::io::stdout();
        while let Some(line) = out_rx.recv().await {
            let _ = writeln!(stdout, "{line}");
            let _ = stdout.flush();
        }
    });

    while let Some(line) = rx.recv().await {
        let client = client.clone();
        let token = token.clone();
        let url = url.clone();
        let sid_tx = sid_tx.clone();
        let mut sid_wait = sid_rx.clone();
        let out_tx = out_tx.clone();
        tokio::spawn(async move {
            forward_line(client, token, url, &sid_tx, &mut sid_wait, out_tx, line).await;
        });
    }
}

async fn forward_line(
    client: reqwest::Client,
    token: String,
    url: String,
    sid_tx: &watch::Sender<Option<String>>,
    sid_rx: &mut watch::Receiver<Option<String>>,
    out: mpsc::UnboundedSender<String>,
    line: String,
) {
    let parsed: serde_json::Value = match serde_json::from_str(&line) {
        Ok(v) => v,
        Err(e) => {
            // 无法解析的行：按 JSON-RPC 约定回 parse error（id 不可知，置 null）
            let _ = out.send(
                serde_json::json!({
                    "jsonrpc": "2.0", "id": null,
                    "error": {"code": -32700, "message": format!("parse error: {e}")}
                })
                .to_string(),
            );
            return;
        }
    };
    let id = parsed.get("id").cloned().filter(|v| !v.is_null());
    let method = parsed
        .get("method")
        .and_then(|m| m.as_str())
        .map(String::from);
    // 请求 = 有 id 且有 method；通知（无 id）不回写任何输出
    let is_request = id.is_some() && method.is_some();

    // 会话屏障：非 initialize 请求等 initialize 响应落位（正常客户端本就串行握手，
    // 这里是宽容窗口，防抢先并发请求拿空 session）
    if sid_rx.borrow().is_none() && method.as_deref() != Some("initialize") {
        let _ = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if sid_rx.borrow().is_some() {
                    break;
                }
                if sid_rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;
    }
    let sid = sid_rx.borrow().clone();

    let mut req = client
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json, text/event-stream")
        .header("Content-Type", "application/json")
        .json(&parsed);
    if let Some(s) = &sid {
        req = req.header("mcp-session-id", s);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            if is_request {
                let msg = if e.is_timeout() {
                    format!("upstream timeout（审批等待可能超过 TINYSSH_MCP_TIMEOUT_SECS；可用 cancel_exec 工具收口）")
                } else {
                    format!("upstream unreachable: {e}")
                };
                let _ = out.send(
                    serde_json::json!({
                        "jsonrpc": "2.0", "id": id,
                        "error": {"code": -32603, "message": msg}
                    })
                    .to_string(),
                );
            }
            return;
        }
    };

    // initialize：捕获会话 id（header 与 body 格式无关，先于 body 消费）
    if method.as_deref() == Some("initialize") {
        if let Some(s) = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            let _ = sid_tx.send(Some(s.to_string()));
        }
    }

    if !resp.status().is_success() {
        if is_request {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let brief: String = body.chars().take(200).collect();
            let _ = out.send(
                serde_json::json!({
                    "jsonrpc": "2.0", "id": id,
                    "error": {"code": -32000, "message": format!("upstream HTTP {status}: {brief}")}
                })
                .to_string(),
            );
        }
        return;
    }

    let ctype = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if ctype.contains("text/event-stream") {
        // SSE：逐帧解析、实时下发。跳过注释行（: ping）与空 priming 帧；
        // 每个含 data 的帧就是一条服务端消息（响应/通知/progress 心跳）。
        let mut stream = resp.bytes_stream();
        let mut data_lines: Vec<String> = Vec::new();
        let mut carry = String::new();
        'outer: while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(_) => break,
            };
            carry.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = carry.find('\n') {
                let raw: String = carry.drain(..=pos).collect();
                let line = raw.trim_end_matches(['\n', '\r']);
                if line.starts_with(':') {
                    continue; // SSE 注释/keep-alive
                }
                if let Some(d) = line.strip_prefix("data:") {
                    data_lines.push(d.strip_prefix(' ').unwrap_or(d).to_string());
                    continue;
                }
                // event:/id:/retry: 与空行在此分派；空行 = 帧结束
                if line.is_empty() {
                    let data = data_lines.join("\n");
                    data_lines.clear();
                    if data.trim().is_empty() {
                        continue; // priming 帧（空 data + retry）
                    }
                    if out.send(data).is_err() {
                        break 'outer;
                    }
                }
            }
        }
        // 流末尾残帧
        let data = data_lines.join("\n");
        if !data.trim().is_empty() {
            let _ = out.send(data);
        }
    } else {
        // JSON 响应：非空即透传（202 空体 = 通知受理，不回写）
        let body = resp.text().await.unwrap_or_default();
        if !body.trim().is_empty() {
            let _ = out.send(body);
        }
    }
}
