//! C13 故障注入（QA 专用；契约 C6/C13 验收行「核心故障注入+真实 SFTP」）：
//! 以环境变量驱动三种提交时序——服务端已提交但丢响应、提交时取消、提交窗口
//! 内退出重启。每个激活点由调用方写 fault_inject 审计，冒烟与对抗探针据此对账。
//! 产品路径零影响：env 缺省全部直通。仅 QA 进程（冒烟/探针）设置这些变量。

/// 注入点是否激活。
/// - `drop_link_response`：`TINYSSH_FAULT_DROP_LINK_RESPONSE=1`（transport 侧
///   丢弃发布应答，core 侧收到 Ambiguous）
/// - 提交窗口暂停点：`TINYSSH_FAULT_COMMIT_PAUSE=<point>`
///   （`pre_publish`=发布前[取消/kill 窗]、`post_verified`=verified 落账后[kill 窗]）
pub fn active(point: &str) -> bool {
    match point {
        "drop_link_response" => {
            std::env::var("TINYSSH_FAULT_DROP_LINK_RESPONSE").as_deref() == Ok("1")
        }
        p => std::env::var("TINYSSH_FAULT_COMMIT_PAUSE").as_deref() == Ok(p),
    }
}

/// 暂停点：激活则长停（冒烟驱动在窗口内执行取消/kill -9；进程被杀即重启时序）。
/// 时长默认 90s；单测用 `TINYSSH_FAULT_PAUSE_MS` 缩短以确定性地落进窗口。
pub async fn pause(point: &str) {
    if active(point) {
        let ms = std::env::var("TINYSSH_FAULT_PAUSE_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(90_000);
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    }
}
