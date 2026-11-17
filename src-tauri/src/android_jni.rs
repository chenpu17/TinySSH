//! Android JNI 错误路径卫生（KI-072）。
//!
//! Java 异常不会被 Rust 侧的 `Result` 自动清掉：`call_method` 等返回
//! `Err(JavaException)` 后，异常仍挂起在当前 attach 的 native 线程上，该线程
//! 后续每次 JNI 调用都会带着同一个异常返回（`exception_check` 恒为真，错误
//! 信息始终是第一个异常）。一次反射失败（类被 R8 裁掉等）就会把这条线程的
//! 后续调用全部带病，所以失败路径必须 describe + clear。
//!
//! settings（系统栏/物理键盘/打开链接）与 keepalive 共用本实现；调用点自己
//! 不需要再写一遍 exception_check。

/// 清掉当前线程上挂起的 Java 异常。**失败路径专用**：成功返回时线程本就不该
/// 有挂起异常；describe 只进日志侧（stderr），错误原文仍由调用方随 `Err` 上抛。
pub(crate) fn clear_pending_exception(env: &mut jni::JNIEnv<'_>) {
    if env.exception_check().unwrap_or(false) {
        env.exception_describe().ok();
        let _ = env.exception_clear();
    }
}
