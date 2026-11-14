//! 平台能力契约：核心域（core-session / vault）只认这里的 trait，具体实现由
//! 装配层按目标平台注入。
//!
//! **本 crate 不得依赖任何平台原生库**（keyring / portable-pty / objc2 / JNI）——
//! 它是「去桌面化」的分界线：桌面与移动端的差异只允许出现在实现侧与装配侧，
//! 不允许以 `cfg!(target_os = ...)` 的形式渗进核心逻辑。
//!
//! 装配关系：
//! - 桌面：`transport-pty::PortablePty` + `vault::desktop_secret_store()`；
//! - Android：`platform-android` 的 Keystore 实现 + 无本地终端（[`NoLocalTerminal`]）。
//!
//! 能力不支持时**明确报错**（[`session_api::Error::Unsupported`]），不静默降级——
//! 静默降级会让「本地终端怎么没了」变成无从归因的玄学。

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use session_api::transport::ChannelHandle;
use session_api::{Error, Result};
use zeroize::Zeroizing;

/// 主密钥托管：桌面 = OS 钥匙串，Android = Keystore，iOS = Keychain。
///
/// 只负责那把 32 字节主密钥的**取用与首次生成**；加密派生（argon2 / XChaCha20）
/// 留在 vault，与平台无关。
pub trait SecretStore: Send + Sync + 'static {
    /// 取已存在的 32 字节主密钥；不存在则生成并持久化后返回。
    ///
    /// 持久化失败必须报错——退化成「每次启动换一把密钥」会让既有凭据全部不可解。
    fn load_or_create_master_key(&self) -> Result<Zeroizing<[u8; 32]>>;
}

/// 本地终端：桌面 = portable-pty，移动端 = 不支持。
///
/// 这是 `transport-pty` 在核心域的唯一抽象面。返回的 cleanup 句柄语义与
/// `spawn_local_pty` 一致：调用方不持有它时由通路自身兜底清理。
#[async_trait]
pub trait LocalTerminal: Send + Sync + 'static {
    /// 该平台是否提供本地终端。`false` 时 `create_session` 的 `host_id == "local"`
    /// 直接拒绝，`list_hosts` 也不再生成本机条目。
    fn supported(&self) -> bool;

    async fn spawn(
        &self,
        cols: u16,
        rows: u16,
        shell: Option<String>,
    ) -> Result<(Arc<dyn ChannelHandle>, Option<PathBuf>)>;
}

/// 一次装配注入的全部平台能力。
///
/// 新增能力（本机指标、更新通道等）往这里加字段，由装配层决定各平台给什么实现。
#[derive(Clone)]
pub struct Platform {
    pub secrets: Arc<dyn SecretStore>,
    pub local_terminal: Arc<dyn LocalTerminal>,
}

impl Platform {
    pub fn new(secrets: Arc<dyn SecretStore>, local_terminal: Arc<dyn LocalTerminal>) -> Self {
        Self {
            secrets,
            local_terminal,
        }
    }
}

/// 未装配主密钥托管：任何取用都明确失败。
///
/// 移动端实现落地前用它占位——比「悄悄用一份明文密钥」安全。
pub struct NoSecretStore;

impl SecretStore for NoSecretStore {
    fn load_or_create_master_key(&self) -> Result<Zeroizing<[u8; 32]>> {
        Err(Error::Unsupported(
            "当前平台尚未装配主密钥托管（SecretStore）".into(),
        ))
    }
}

/// 该平台不提供本地终端（移动端）。
pub struct NoLocalTerminal;

#[async_trait]
impl LocalTerminal for NoLocalTerminal {
    fn supported(&self) -> bool {
        false
    }

    async fn spawn(
        &self,
        _cols: u16,
        _rows: u16,
        _shell: Option<String>,
    ) -> Result<(Arc<dyn ChannelHandle>, Option<PathBuf>)> {
        Err(Error::Unsupported("当前平台不提供本地终端".into()))
    }
}
