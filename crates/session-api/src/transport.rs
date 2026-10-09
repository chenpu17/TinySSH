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
    /// progress（C5 R32）：数据阶段周期回调（done=累计字节、total=总字节可未知），
    /// 由传输注册表节流合并；实现不得依赖回调时序（纯观察面）。
    async fn upload(
        &self,
        local: &std::path::Path,
        remote: &str,
        cancel: &tokio_util_sync::CancellationToken,
        progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<u64>;

    /// 下载（SFTP / 本地拷贝），返回传输字节数。progress 语义同 upload。
    async fn download(
        &self,
        remote: &str,
        local: &std::path::Path,
        cancel: &tokio_util_sync::CancellationToken,
        progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<u64>;

    /// 列目录（SFTP readdir / 本地 read_dir，T41 FR-7 浏览器）。
    /// 过滤 `.`/`..`；目录在前、按名称排序；kind=条目自身类型（readdir 属性为
    /// lstat 语义，符号链接照实报 Symlink）；size/mtime 未知为 None（§352 不伪造零值）。
    async fn list_dir(&self, path: &str) -> Result<Vec<crate::DirEntryS>>;

    /// C4（R30）：路径规范化（SFTP realpath / 本地 canonicalize）。
    /// path=None → 连接初始目录（SFTP "."，即服务端登录起始目录）。
    /// 不存在/权限不足返回可区别错误；悬空符号链接 canonical 不可得 → 错误呈现，
    /// 前端不猜路径（§352）。
    async fn resolve_path(&self, path: Option<&str>) -> Result<crate::PathResolved> {
        Err(crate::Error::InvalidInput("该通路不支持路径解析（仅 SSH 会话）".into()))
    }

    /// C4（R30）：条目元数据。kind/symlink_target 为 lstat 语义（链接本身）；
    /// is_dir/size/mtime 为跟随语义（符号链接取目标，取不到回落链接本体）。
    async fn stat_entry(&self, path: &str) -> Result<crate::EntryStat> {
        Err(crate::Error::InvalidInput("该通路不支持元数据查询（仅 SSH 会话）".into()))
    }

    // ---- 端口转发（T42 FR-8）。默认不支持（本地 PTY 无 SSH 连接可承载）----
    async fn start_forward(&self, _spec: crate::ForwardSpec) -> Result<crate::ForwardId> {
        Err(crate::Error::InvalidInput("该通路不支持端口转发（仅 SSH 会话）".into()))
    }
    async fn stop_forward(&self, _id: &crate::ForwardId) -> Result<()> {
        Err(crate::Error::InvalidInput("该通路不支持端口转发（仅 SSH 会话）".into()))
    }
    async fn list_forwards(&self) -> Result<Vec<crate::ForwardInfo>> {
        Ok(Vec::new())
    }

    /// 注入转发状态变化回调（T44 真机冒烟补口）：start/stop/Degraded/恢复/
    /// Failed 状态写口触发。默认 no-op（本地 PTY 不支持转发，无需通知）。
    fn set_forward_event_cb(&self, _cb: crate::ForwardStateCb) {}

    /// C6/R34 DF6.1 唯一发布原语：原子 no-clobber 硬链接发布（existing=本任务
    /// temp，new=最终目标，须同目录同文件系统）。语义：
    /// Committed=链接已原子建立（new 此前不存在，现在内容=existing）；
    /// Unsupported=通路/服务端无硬链接能力（扩展未声明）——调用方按
    /// ReplaceUnsupported 阻止发布；Rejected(reason)=确定未提交（含目标已存在
    /// 的竞态失败——链接失败绝不改动 new）；Ambiguous=请求已发出但应答丢失/
    /// 传输层失稳——提交与否不可知，调用方必须落 OutcomeUnknown（C13）。
    /// 本地实现走 std::fs::hard_link（本地路径传绝对路径字符串）。
    async fn publish_hardlink(&self, existing: &str, new: &str) -> Result<crate::PublishOutcome> {
        let _ = (existing, new);
        Err(crate::Error::InvalidInput("该通路不支持原子发布".into()))
    }

    /// C6/R34：删除远端/本地文件（temp 清理专用；不递归、不存在=Ok 幂等）。
    async fn remove_file(&self, path: &str) -> Result<()> {
        let _ = path;
        Err(crate::Error::InvalidInput("该通路不支持文件删除".into()))
    }
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
            // 先注册、后复查（审核低-11）：Notified 在首次 poll 前不注册，旧的
            // 「创建 + 复查」序列在复查通过与首次 poll 之间留有窗口——跨线程
            // cancel() 的 notify_waiters() 落在窗口内即无人可唤醒，本等待永挂
            // （监听任务不退、端口不释放）。enable() 原子完成注册：true = 注册
            // 前已收到通知直接完成；false = 注册已生效，复查 flag 后等待——此后
            // 任何 cancel() 的 notify_waiters() 必命中已注册的本 waiter。
            let mut notified = std::pin::pin!(self.inner.notified());
            if !notified.as_mut().enable() {
                if self.is_cancelled() {
                    return;
                }
                notified.await;
            }
        }
    }
}
