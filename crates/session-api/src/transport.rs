//! 通路抽象（L1 §3.1）：`transport-ssh` 与 `transport-pty` 各实现一套。
//! core-session 只面向本 trait 编排，不感知具体协议。

use crate::{ExecOpts, Result};
use async_trait::async_trait;
use tokio::sync::broadcast;

/// 传输层信号（尽力停止的升级阶梯）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportSignal {
    /// SIGINT（PTY 通路写 0x03 控制字节）。
    Interrupt,
    /// SIGQUIT（PTY 通路写 0x1C 控制字节）。
    Quit,
    /// SIGTERM（Fresh 通路向子进程/通道发送；PTY shell 通路尽力映射）。
    Terminate,
    /// SIGKILL（Fresh 通路强杀子进程；Shell 通路等价于关闭）。
    Kill,
}

/// Fresh 模式执行结果（独立通道，退出码可靠）。
#[derive(Debug, Clone)]
pub struct FreshOutcome {
    pub exit_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// 触达输出上限被截断。
    pub truncated: bool,
    /// true=正常收尾（exit status/EOF）；false=因超时/取消中途放弃。
    pub completed: bool,
}

/// 持久 shell 通路（本地 PTY 或 SSH shell channel）+ 同连接上的 Fresh 通道能力。
#[async_trait]
pub trait ChannelHandle: Send + Sync {
    /// 写入持久 shell（人类或 Agent 的按键）。
    async fn write(&self, data: &[u8]) -> Result<()>;

    async fn resize(&self, cols: u16, rows: u16) -> Result<()>;

    /// Fresh 执行：同连接上开独立通道（本地为隐藏子进程 `$SHELL -c`），
    /// 退出码可靠；deadline 为放行时刻起算的绝对时刻；cancel 由 cancel_exec 触发。
    async fn exec_fresh(
        &self,
        cmd: &str,
        opts: &ExecOpts,
        deadline: std::time::Instant,
        cancel: &tokio_util_sync::CancellationToken,
    ) -> Result<FreshOutcome>;

    /// 对持久 shell 通路发信号（尽力停止用）。
    async fn signal(&self, sig: TransportSignal) -> Result<()>;

    /// 强拆通路（SIGKILL 级别的兜底）。
    async fn force_close(&self) -> Result<()>;

    /// 原始输出字节流（可丢块 broadcast；消费方 term-core）。
    fn subscribe_output(&self) -> broadcast::Receiver<Vec<u8>>;

    /// 通路是否存活。
    async fn is_alive(&self) -> bool;

    /// SSH 断线后重连；本地实现为 no-op（进程存活即通路存活）。
    async fn reconnect(&self) -> Result<()>;

    async fn close(&self) -> Result<()>;

    /// 上传（SFTP / 本地拷贝），返回传输字节数。cancel_token 置位后尽快中止。
    async fn upload(
        &self,
        local: &std::path::Path,
        remote: &str,
        cancel: &tokio_util_sync::CancellationToken,
    ) -> Result<u64>;

    /// 下载（SFTP / 本地拷贝），返回传输字节数。
    async fn download(
        &self,
        remote: &str,
        local: &std::path::Path,
        cancel: &tokio_util_sync::CancellationToken,
    ) -> Result<u64>;

    /// 列目录（SFTP readdir / 本地 read_dir，T41 FR-7 浏览器）。
    /// 过滤 `.`/`..`；按名称排序、目录在前；mtime 未知为 0。
    async fn list_dir(&self, path: &str) -> Result<Vec<crate::DirEntryS>>;
}

/// tokio_util 的 CancellationToken 的最小本地别名层：避免 session-api 直接依赖
/// tokio-util（保持轻依赖），由各 transport 使用真实类型实现；这里用 opaque 方式。
pub mod tokio_util_sync {
    /// 极简取消令牌（session-api 内部实现，避免额外依赖）。
    #[derive(Debug, Clone, Default)]
    pub struct CancellationToken {
        inner: std::sync::Arc<tokio::sync::Notify>,
        flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    impl CancellationToken {
        pub fn new() -> Self {
            Self::default()
        }
        pub fn cancel(&self) {
            self.flag.store(true, std::sync::atomic::Ordering::SeqCst);
            self.inner.notify_waiters();
        }
        pub fn is_cancelled(&self) -> bool {
            self.flag.load(std::sync::atomic::Ordering::SeqCst)
        }
        pub async fn cancelled(&self) {
            if self.is_cancelled() {
                return;
            }
            let notified = self.inner.notified();
            // 防丢失：注册后复查
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}
