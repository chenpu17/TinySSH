//! Android Keystore 主密钥托管。
//!
//! keyring-core 的默认库由 `android-native-keyring-store` 提供：每条凭据的
//! 密文存应用私有 SharedPreferences，加解密密钥由 AndroidKeyStore 生成并托管
//! （进程外不可导出）。进程内只需把库设为默认一次。
//!
//! 应用上下文来自 ndk-context：Tauri/wry 的 JNI 入口在调用 `run()` 之前完成
//! 初始化，因此这里不再自行初始化。

use std::collections::HashMap;
use std::sync::OnceLock;

use session_api::{Error, Result};
use tinyssh_platform_api::SecretStore;
use zeroize::Zeroizing;

/// keyring 条目标识：与桌面钥匙串同一 service/user（语义一致，便于排查）。
const SERVICE: &str = "TinySSH";
const USER: &str = "master-key";

pub struct KeystoreStore;

impl SecretStore for KeystoreStore {
    fn load_or_create_master_key(&self) -> Result<Zeroizing<[u8; 32]>> {
        ensure_store()?;
        let entry = keyring_core::Entry::new(SERVICE, USER)
            .map_err(|e| Error::Storage(format!("Android Keystore entry: {e}")))?;
        match entry.get_secret() {
            Ok(bytes) => {
                if bytes.len() != 32 {
                    return Err(Error::Storage(
                        "Android Keystore 主密钥长度不是 32 字节".into(),
                    ));
                }
                let mut out = [0u8; 32];
                out.copy_from_slice(&bytes);
                Ok(Zeroizing::new(out))
            }
            Err(keyring_core::Error::NoEntry) => {
                use rand::RngCore;
                let mut key = [0u8; 32];
                rand::rng().fill_bytes(&mut key);
                entry
                    .set_secret(&key)
                    .map_err(|e| Error::Storage(format!("Android Keystore 写入失败: {e}")))?;
                Ok(Zeroizing::new(key))
            }
            Err(e) => Err(Error::Storage(format!("Android Keystore 读取失败: {e}"))),
        }
    }
}

/// 进程内一次性初始化默认库（Store 自身按名字去重，重复创建会报错）。
fn ensure_store() -> Result<()> {
    static INIT: OnceLock<std::result::Result<(), String>> = OnceLock::new();
    match INIT.get_or_init(|| {
        let store = android_native_keyring_store::Store::new_with_configuration(&HashMap::new())
            .map_err(|e| format!("Android Keystore 初始化失败: {e}"))?;
        keyring_core::set_default_store(store);
        Ok(())
    }) {
        Ok(()) => Ok(()),
        Err(e) => Err(Error::Storage(e.clone())),
    }
}
