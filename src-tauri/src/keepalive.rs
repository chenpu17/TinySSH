//! Android 保活（KI-059 v1）：有活动会话或活动传输时挂常驻前台通知，归零即撤。
//!
//! 真源在 Rust：判定读 `SessionManager` 的 `list_sessions`/`list_transfers`
//! 快照，不信前端。监听现有三条广播（connection-event / session-state /
//! transfer-event），250ms 合并后重新快照——事件只做唤醒，快照才是权威面
//! （事件可丢，与 C5 的「查询是对账面」同一口径）。启动先算一次。
//!
//! 状态变化经 JNI 调 `KeepaliveBridge.setActive(Context, active, sessions,
//! transfers)`；Kotlin 侧负责 startForegroundService / stopService。非 Android
//! 整个模块除 `sync_now` 补口（非 Android no-op）外不参与装配。

#[cfg(target_os = "android")]
use session_api::SessionApi as _;
#[cfg(any(target_os = "android", test))]
use session_api::{SessionState, TransferStatus};

// 保活只关心「会话/传输是否还在动」：与前端活动态同一张表（Connected 及
// 其断线过渡态都算活动；Disconnected/Closed 不再保活）。
#[cfg(any(target_os = "android", test))]
fn session_is_active(state: SessionState) -> bool {
    matches!(
        state,
        SessionState::Connected
            | SessionState::Degraded
            | SessionState::Reconnecting
            | SessionState::Reconfirming
    )
}

// OutcomeUnknown 是终态（复核只在其上出 Succeeded，任务本身不推进）；
// Succeeded/Failed/Cancelled/Skipped/Interrupted 同样是终态。
#[cfg(any(target_os = "android", test))]
fn transfer_is_active(status: TransferStatus) -> bool {
    matches!(
        status,
        TransferStatus::Queued
            | TransferStatus::Running
            | TransferStatus::Committing
            | TransferStatus::Cancelling
            | TransferStatus::AwaitingDecision
    )
}

/// 下发给原生的计数：sessions/transfers 均为**活动**条目数（不是列表总数）。
#[cfg(any(target_os = "android", test))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct KeepaliveCounts {
    sessions: usize,
    transfers: usize,
}

#[cfg(any(target_os = "android", test))]
impl KeepaliveCounts {
    fn active(&self) -> bool {
        self.sessions > 0 || self.transfers > 0
    }
}

#[cfg(any(target_os = "android", test))]
fn count_active_sessions(states: impl Iterator<Item = SessionState>) -> usize {
    states.filter(|s| session_is_active(*s)).count()
}

#[cfg(any(target_os = "android", test))]
fn count_active_transfers(statuses: impl Iterator<Item = TransferStatus>) -> usize {
    statuses.filter(|s| transfer_is_active(*s)).count()
}

/// 启动 watcher（仅 Android；桌面不受后台冻结影响，不需要前台服务）。
#[cfg(target_os = "android")]
pub(crate) fn install(api: std::sync::Arc<core_session::SessionManager>) {
    tauri::async_runtime::spawn(async move { watch(api).await });
}

// 事件驱动的防抖重算：首条事件唤醒 → 固定 250ms 窗口内继续吞事件 → 窗口结束后
// 取一次权威快照。快照本身覆盖唤醒前的所有变化，窗口内后到的事件只会再触发下
// 一轮（无害）；不必维护事件累积计数。
#[cfg(target_os = "android")]
async fn watch(api: std::sync::Arc<core_session::SessionManager>) {
    use tokio::sync::broadcast::error::RecvError;

    let mut conn_rx = api.center.conn_tx.subscribe();
    let mut state_rx = api.center.state_tx.subscribe();
    let mut xfer_rx = api.transfer_tx.subscribe();

    // 启动先算一次：恢复面可能在 setup 之前就把会话重建出来了。
    if let Some(counts) = snapshot(&api).await {
        apply_counts(counts, false);
    }

    loop {
        // 三路 receiver 的载荷类型不同，select 分支里只关心「是否已 Closed」；
        // Lagged 是正常现象（快照对账兜底），照样重算。
        let mut closed = false;
        tokio::select! {
            r = conn_rx.recv() => closed = matches!(r, Err(RecvError::Closed)),
            r = state_rx.recv() => closed = matches!(r, Err(RecvError::Closed)),
            r = xfer_rx.recv() => closed = matches!(r, Err(RecvError::Closed)),
        }
        if closed {
            break;
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(DEBOUNCE_MS);
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => break,
                r = conn_rx.recv() => closed = matches!(r, Err(RecvError::Closed)),
                r = state_rx.recv() => closed = matches!(r, Err(RecvError::Closed)),
                r = xfer_rx.recv() => closed = matches!(r, Err(RecvError::Closed)),
            }
            if closed {
                break;
            }
        }
        if closed {
            break;
        }
        if let Some(counts) = snapshot(&api).await {
            apply_counts(counts, false);
        }
    }
}

#[cfg(target_os = "android")]
const DEBOUNCE_MS: u64 = 250;

// 查询失败时保留上次状态而不是按 0 处理：一次 SQLite/锁抖动不该把前台服务撤掉，
// 下一条事件或回前台补口会重算。
#[cfg(target_os = "android")]
async fn snapshot(api: &core_session::SessionManager) -> Option<KeepaliveCounts> {
    let sessions = match api.list_sessions(&session_api::Actor::Human).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[keepalive] list_sessions 失败，保留上次状态：{e}");
            return None;
        }
    };
    let transfers = match api.list_transfers(&session_api::Actor::Human).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[keepalive] list_transfers 失败，保留上次状态：{e}");
            return None;
        }
    };
    Some(KeepaliveCounts {
        sessions: count_active_sessions(sessions.iter().map(|s| s.state)),
        transfers: count_active_transfers(transfers.iter().map(|t| t.status)),
    })
}

/// 把计数变化下发给 Kotlin。`force=true` 用于回前台补口：即使计数未变也重发一次
/// ——Android 12+ 可能拒绝过后台启动，此时本地缓存是「active」但服务并未起来。
#[cfg(target_os = "android")]
fn apply_counts(counts: KeepaliveCounts, force: bool) {
    static LAST: std::sync::Mutex<Option<KeepaliveCounts>> = std::sync::Mutex::new(None);

    {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if !force && *last == Some(counts) {
            return;
        }
        *last = Some(counts);
    }
    if let Err(e) = android_set_keepalive(counts.active(), counts.sessions, counts.transfers) {
        eprintln!("[keepalive] setActive 失败（下次事件/回前台重试）：{e}");
        // 失败不缓存：保持与原生实际状态「未知」，下一次事件或补口会再发。
        if let Ok(mut last) = LAST.lock() {
            *last = None;
        }
    }
}

/// JNI 回调 Kotlin `KeepaliveBridge.setActive(Context, boolean, int, int)`。
/// ClassLoader 取法与 settings.rs 的 setSystemBarsLight 同源（KI-060）：
/// native 线程的 FindClass 走 bootstrap ClassLoader 不可靠，必须经 Application
/// context 的 getClassLoader().loadClass。失败只记日志，不 panic（保活是尽力而为）。
#[cfg(target_os = "android")]
fn android_set_keepalive(
    active: bool,
    sessions: usize,
    transfers: usize,
) -> std::result::Result<(), String> {
    use jni::objects::{JObject, JValue};

    // SAFETY: 与 open_url 同一前提：Tauri/wry 的 JNI 入口在 run() 前初始化
    // ndk-context，保存的是进程生命期有效的全局引用。
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };

    // JNI 错误路径卫生（KI-072）：保活失败只记日志重试，但挂起异常不清会污染
    // 这条 native 线程的后续 JNI 调用（错误信息也会一直停在第一个异常）。
    let result = (|| -> std::result::Result<(), String> {
        let loader = env
            .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;
        let class_name = env
            .new_string("com.tinyssh.app.KeepaliveBridge")
            .map_err(|e| e.to_string())?;
        let class_obj = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&class_name)],
            )
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;
        let class_ref = env.new_global_ref(&class_obj).map_err(|e| e.to_string())?;
        env.call_static_method(
            &class_ref,
            "setActive",
            "(Landroid/content/Context;ZII)V",
            &[
                JValue::Object(&context),
                JValue::Bool(active as u8),
                JValue::Int(sessions.min(i32::MAX as usize) as i32),
                JValue::Int(transfers.min(i32::MAX as usize) as i32),
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        crate::android_jni::clear_pending_exception(&mut env);
    }
    result
}

/// 回前台补口（KI-059）：Android 12+ 后台启动前台服务可能被拒，日志里只剩一条
/// 警告；App 回到前台时由 `keepalive_sync` 命令触发一次立即重算，把服务补起来。
/// force=true 绕过去重——即使计数未变也重发，因为本地缓存可能乐观于原生实际状态。
#[cfg(target_os = "android")]
pub(crate) async fn sync_now(api: &core_session::SessionManager) {
    if let Some(counts) = snapshot(api).await {
        apply_counts(counts, true);
    }
}

/// 非 Android：没有前台服务可补，no-op（桌面不受后台冻结影响）。
#[cfg(not(target_os = "android"))]
pub(crate) async fn sync_now(_api: &core_session::SessionManager) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// 活动会话 = Connected | Degraded | Reconnecting | Reconfirming；
    /// Disconnected（可能正在自动重连？不——重连窗口由 Reconnecting 表达）与
    /// Closed 不保活。逐变体覆盖，防枚举扩充后判定悄悄漏项。
    #[test]
    fn active_session_states_are_exactly_live_ones() {
        for state in [
            SessionState::Connected,
            SessionState::Degraded,
            SessionState::Reconnecting,
            SessionState::Reconfirming,
        ] {
            assert!(session_is_active(state), "{state:?} 应计入保活");
        }
        for state in [SessionState::Disconnected, SessionState::Closed] {
            assert!(!session_is_active(state), "{state:?} 不应计入保活");
        }
        assert_eq!(
            count_active_sessions(
                [
                    SessionState::Connected,
                    SessionState::Reconnecting,
                    SessionState::Disconnected,
                    SessionState::Closed,
                    SessionState::Degraded,
                ]
                .into_iter()
            ),
            3
        );
    }

    /// 活动传输 = Queued | Running | Committing | Cancelling | AwaitingDecision；
    /// OutcomeUnknown 是终态（v1 不替它保活——任务本身已停止推进）。
    #[test]
    fn active_transfer_statuses_are_exactly_live_ones() {
        for status in [
            TransferStatus::Queued,
            TransferStatus::Running,
            TransferStatus::Committing,
            TransferStatus::Cancelling,
            TransferStatus::AwaitingDecision,
        ] {
            assert!(transfer_is_active(status), "{status:?} 应计入保活");
        }
        for status in [
            TransferStatus::Succeeded,
            TransferStatus::Failed,
            TransferStatus::Cancelled,
            TransferStatus::OutcomeUnknown,
            TransferStatus::Skipped,
            TransferStatus::Interrupted,
        ] {
            assert!(!transfer_is_active(status), "{status:?} 不应计入保活");
        }
        assert_eq!(
            count_active_transfers(
                [
                    TransferStatus::Queued,
                    TransferStatus::Running,
                    TransferStatus::AwaitingDecision,
                    TransferStatus::Succeeded,
                    TransferStatus::OutcomeUnknown,
                ]
                .into_iter()
            ),
            3
        );
    }

    /// 常驻判定的唯一口径：任一活动条目即 active；全 0 才撤服务。
    #[test]
    fn counts_activate_only_when_nonzero() {
        assert!(!KeepaliveCounts::default().active());
        assert!(KeepaliveCounts {
            sessions: 1,
            transfers: 0
        }
        .active());
        assert!(KeepaliveCounts {
            sessions: 0,
            transfers: 1
        }
        .active());
        assert!(KeepaliveCounts {
            sessions: 2,
            transfers: 3
        }
        .active());
    }
}
