//! 吞吐基准（开发/诊断用）。

use super::*;

/// SPIKE-1：是否处于基准模式。
#[tauri::command]
pub(crate) async fn bench_mode() -> CmdResult<bool> {
    let v = std::env::var("TINYSSH_BENCH")
        .map(|x| x == "1")
        .unwrap_or(false);
    eprintln!("[bench] bench_mode called -> {v}");
    Ok(v)
}

/// SPIKE-1：IPC Channel 吞吐基准——Rust → WebView 原始字节推送。
/// 稳定轮：仅 debug 构建可用——4MB/s IPC 洪水 + `exit(0)` 这类基准工具语义
/// 不该留在生产 invoke 表里（前端一次误调即可打洪水/自杀进程）。
#[tauri::command]
pub(crate) async fn bench_start(
    on_chunk: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> CmdResult<()> {
    if !cfg!(debug_assertions) {
        return Err("bench 命令仅 debug 构建可用".to_string().into());
    }
    eprintln!("[bench] bench_start called");
    tokio::spawn(async move {
        let chunk = vec![b'a'; 1024 * 1024];
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
        let mut i: u64 = 0;
        while tokio::time::Instant::now() < deadline {
            for _ in 0..4 {
                i += 1;
                if on_chunk
                    .send(tauri::ipc::InvokeResponseBody::Raw(chunk.clone()))
                    .is_err()
                {
                    return;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            if i.is_multiple_of(4800) {
                let _ = on_chunk.send(tauri::ipc::InvokeResponseBody::Json(
                    "{\"type\":\"resync\"}".into(),
                ));
            }
        }
        eprintln!("[bench] stream done, sending done marker");
        let _ = on_chunk.send(tauri::ipc::InvokeResponseBody::Json(
            "{\"type\":\"done\"}".into(),
        ));
    });
    Ok(())
}

/// SPIKE-1：WebView 回报收到的字节数并退出（debug 构建）。
#[tauri::command]
pub(crate) async fn bench_report(bytes: u64, resyncs: u32, seconds: u64) -> CmdResult<()> {
    if !cfg!(debug_assertions) {
        return Err("bench 命令仅 debug 构建可用".to_string().into());
    }
    eprintln!("[bench] report: bytes={bytes} resyncs={resyncs} seconds={seconds}");
    let out = serde_json::json!({
        "bytes": bytes,
        "seconds": seconds,
        "mbps": (bytes as f64) / (seconds as f64) / (1024.0 * 1024.0),
        "resyncs": resyncs,
    });
    let path = std::path::PathBuf::from("/tmp/tinyssh-spike1.json");
    std::fs::write(&path, serde_json::to_string_pretty(&out).unwrap()).ok();
    println!("SPIKE-1 result: {out}");
    std::process::exit(0);
}
