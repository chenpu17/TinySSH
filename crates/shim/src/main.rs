//! tinyssh-mcp shim：对 Agent 说 stdio MCP，向应用端点说 streamable HTTP（L1 §3.5 / L0 ADR-4）。
//! 单文件、无状态；Token 经环境变量 TINYSSH_TOKEN；端点经 TINYSSH_MCP_URL（默认 127.0.0.1:8722/mcp）。

use std::io::{BufRead, Write};
use std::time::Duration;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let token = std::env::var("TINYSSH_TOKEN").unwrap_or_default();
    let url =
        std::env::var("TINYSSH_MCP_URL").unwrap_or_else(|_| "http://127.0.0.1:8722/mcp".into());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180)) // 审批等待表现为长时工具调用；不得先于应用端超时
        .build()
        .expect("http client");

    // 逐行读 stdio（JSON-RPC）；后台并发转发以支持通知/并发请求
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
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

    let mut stdout = std::io::stdout();
    while let Some(line) = rx.recv().await {
        let parsed: serde_json::Value =
            serde_json::from_str(&line).unwrap_or(serde_json::Value::Null);
        let client = client.clone();
        let token = token.clone();
        let url = url.clone();
        let body = match client
            .post(&url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json, text/event-stream")
            .json(&parsed)
            .send()
            .await
        {
            Ok(r) => {
                let text = r.text().await.unwrap_or_default();
                // SSE 帧 → 取 data 行（streamable HTTP 简单响应为 JSON）
                if text.starts_with("event:") || text.contains("\ndata:") {
                    text.lines()
                        .filter_map(|l| l.strip_prefix("data:").map(|s| s.trim_start().to_string()))
                        .next()
                        .unwrap_or(text)
                } else {
                    text
                }
            }
            Err(e) => serde_json::json!({
                "jsonrpc": "2.0", "id": null,
                "error": {"code": -32603, "message": format!("upstream unreachable: {e}")}
            })
            .to_string(),
        };
        writeln!(stdout, "{body}").ok();
        stdout.flush().ok();
    }
}
