//! Android 平台能力装配。
//!
//! - `SecretStore`：Android Keystore。密钥材料由 AndroidKeyStore 托管（AES-GCM），
//!   密文落应用私有 SharedPreferences；实现走 keyring 生态的
//!   `android-native-keyring-store`，经 ndk-context 拿应用上下文（Tauri/wry 在
//!   进入 `run()` 前已初始化）。
//! - 本地终端：**不做**。Android 沙箱里的 `/system/bin/sh` 没有 coreutils，
//!   与桌面语义不等价，宁可明确不支持也不提供一个残缺的 shell。
//!
//! 非 Android 宿主（`--features mobile` 的编译检查）保留明确失败的桩：
//! 任何凭据读写都以 `Error::Unsupported` 失败——**不静默降级成明文存储**。

use std::sync::Arc;

#[cfg(not(target_os = "android"))]
use tinyssh_platform_api::NoSecretStore;
use tinyssh_platform_api::{NoLocalTerminal, Platform};

#[cfg(target_os = "android")]
mod keystore;

/// 构造 Android 平台能力集合。
///
/// 装配点：`src-tauri` 的 `mobile` feature 分支。核心域无需任何改动。
pub fn platform() -> Platform {
    #[cfg(target_os = "android")]
    {
        Platform::new(Arc::new(keystore::KeystoreStore), Arc::new(NoLocalTerminal))
    }
    #[cfg(not(target_os = "android"))]
    {
        Platform::new(Arc::new(NoSecretStore), Arc::new(NoLocalTerminal))
    }
}
