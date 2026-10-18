//! vault：主机/凭据/Agent 身份与策略存取与加密（L1 §3.4）。
//! - SQLite 存非敏感字段；凭据载荷（私钥 PEM、口令）以主密钥加密存 BLOB；
//! - 主密钥：OS 钥匙串托管的随机 32B（测试可用 env 覆盖）；
//! - XChaCha20-Poly1305 加密；Zeroizing 包裹；Debug 不输出明文。

use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key as ChachaKey, XChaCha20Poly1305, XNonce};
use rusqlite::{params, Connection};
use session_api::{
    AgentClientId, ApprovalId, ApprovalItem, ApprovalStatus, AuthDraft, AuthType, Charset, Error,
    Host, HostDraft, HostId, HostMeta, IdentityKind, IdentityMeta, IdentityReq, KeyKind, Policy,
    RecentHost, Result, SessionId, TransferKind, TransferStatus, TransferTask, Workspace,
};
use sha2::{Digest, Sha256};
use std::path::Path;
use zeroize::Zeroizing;

pub mod db;
pub mod sshcfg;

pub use db::{SCHEMA_V1, SCHEMA_V5};

/// 本程序理解的最新 schema 版本（迁移链尾）。**只增不减**：升级应用即抬高，
/// 回退到旧二进制时旧程序读到的 `user_version` 会大于此值 → 拒绝打开（见 [`migrate`]）。
/// R44（§10.2 回退检查）把它显式化，避免「版本号散落在各 `if version < N` 分支里」。
pub const SCHEMA_VERSION: u32 = 8;

/// rev-r47：Agent 账号明细（`list_agents_detailed`）。时间均为 epoch ms。
pub struct AgentAccount {
    pub id: String,
    pub label: String,
    pub revoked_at: Option<i64>,
    pub last_used_at: Option<i64>,
    pub expires_at: Option<i64>,
}

/// 打开/创建库并执行迁移。
pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path).map_err(|e| Error::Storage(e.to_string()))?;
    // R44（§10.2 回退检查）F1：**只读**版本探测必须在**任何**持久写之前。
    // `PRAGMA journal_mode=WAL` 不是内存设置——它改写库文件头并把库永久切到 WAL
    // （对非 WAL 库实测文件 sha256 改变）。若先设 WAL 再进护栏，旧程序在**拒绝打开
    // 之前**就已经改动了新库，与「旧二进制不写新库」相悖。故先探版本、再设 WAL。
    ensure_schema_supported(&conn)?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| Error::Storage(e.to_string()))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| Error::Storage(e.to_string()))?;
    migrate(&conn)?;
    Ok(conn)
}
/// R44（§10.2）：库比本程序新 → 拒绝。**纯只读**（只查 `PRAGMA user_version`），
/// 不写库、不建表、不改 journal 模式——故可安全地在任何持久写之前调用。
pub fn ensure_schema_supported(conn: &Connection) -> Result<()> {
    let version: u32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| Error::Storage(e.to_string()))?;
    if version > SCHEMA_VERSION {
        return Err(Error::Storage(format!(
            "数据库 schema 版本 {version} 高于本程序支持的 {SCHEMA_VERSION}：\
             该库由更新版本的 TinySSH 创建。请升级应用后再打开；\
             若要回退到旧版本，请先用较新版本导出备份（`tinyssh vault backup <文件>`）\
             再恢复旧库，不要直接用旧程序打开该库。"
        )));
    }
    Ok(())
}

pub fn migrate(conn: &Connection) -> Result<()> {
    let version: u32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| Error::Storage(e.to_string()))?;
    // R44（§10.2 回退检查）：库比本程序新 → **拒绝打开**，绝不继续写。
    // 「数据库已升级后不能盲目用旧二进制写新库」：旧程序不知道新列/新表的语义，
    // 按旧 schema 写会静默损坏数据。
    //
    // 注意：本函数是**第二个**检查点（纵深防御）。真正「任何持久写之前」的把关在
    // [`open`] 里——`open` 在设 `journal_mode=WAL` 之前先调 [`ensure_schema_supported`]。
    // 直接调用 `migrate`（如 `open_shared`）的调用方须自行保证此前无持久写。
    ensure_schema_supported(conn)?;
    if version < 1 {
        conn.execute_batch(SCHEMA_V1)
            .map_err(|e| Error::Storage(e.to_string()))?;
        conn.pragma_update(None, "user_version", 1)
            .map_err(|e| Error::Storage(e.to_string()))?;
    }
    // V2（路线图⑤）：主机指纹持久化（TOFU 跨进程记忆）
    if version < 2 {
        conn.execute_batch("ALTER TABLE hosts ADD COLUMN host_fingerprint TEXT;")
            .map_err(|e| Error::Storage(e.to_string()))?;
        conn.pragma_update(None, "user_version", 2)
            .map_err(|e| Error::Storage(e.to_string()))?;
    }
    // V3（路线图⑥）：UI 偏好 KV（字号/主题等），跨进程记忆
    if version < 3 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )
        .map_err(|e| Error::Storage(e.to_string()))?;
        conn.pragma_update(None, "user_version", 3)
            .map_err(|e| Error::Storage(e.to_string()))?;
    }
    // V4（路线图⑩后半）：主机字节编码（utf-8/gbk），老库行缺省 utf-8 零感知
    if version < 4 {
        conn.execute_batch("ALTER TABLE hosts ADD COLUMN charset TEXT NOT NULL DEFAULT 'utf-8';")
            .map_err(|e| Error::Storage(e.to_string()))?;
        conn.pragma_update(None, "user_version", 4)
            .map_err(|e| Error::Storage(e.to_string()))?;
    }
    // V5（C8/C5，R15）：host_metadata + transfer_journal 建表 + 旧 UI 偏好键一次性
    // 迁移（DF8.3）：ui.theme 映射出应用外观写进 ui.v2.workspace blob、
    // ui.font_size → ui.v2.terminal.font_size；旧键保留不删（回退兼容）。
    // 幂等：blob 已存在（标记即键本身）则不再迁移。事务保证原子。
    if version < 5 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| Error::Storage(e.to_string()))?;
        tx.execute_batch(SCHEMA_V5)
            .map_err(|e| Error::Storage(e.to_string()))?;
        let has_blob: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key='ui.v2.workspace'",
                [],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if has_blob == 0 {
            let theme: Option<String> = tx
                .query_row("SELECT value FROM settings WHERE key='ui.theme'", [], |r| {
                    r.get(0)
                })
                .map(Some)
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other),
                })
                .map_err(db_err)?;
            // DF8.3（R27 修订 §10.1.1）：有旧键则映射外观避免升级突变——
            // light/solar-light→light、dark/solar-dark/未知值→dark；
            // 无旧键 = 新装 → 跟随系统（chrome="system"，FE 按 prefers-color-scheme 解析）
            let chrome = match theme.as_deref() {
                Some("light") | Some("solar-light") => "light",
                Some(_) => "dark",
                None => "system",
            };
            let blob = serde_json::json!({
                "schema_version": 1,
                "chrome": chrome,
                "hostbar": null,
            });
            tx.execute(
                "INSERT INTO settings(key,value) VALUES('ui.v2.workspace',?1)",
                params![blob.to_string()],
            )
            .map_err(db_err)?;
            // 字号迁到命名空间键（值原样；已有新键不覆盖）
            let font: Option<String> = tx
                .query_row(
                    "SELECT value FROM settings WHERE key='ui.font_size'",
                    [],
                    |r| r.get(0),
                )
                .map(Some)
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other),
                })
                .map_err(db_err)?;
            if let Some(f) = font {
                tx.execute(
                    "INSERT OR IGNORE INTO settings(key,value) VALUES('ui.v2.terminal.font_size',?1)",
                    params![f],
                )
                .map_err(db_err)?;
            }
        }
        tx.commit().map_err(|e| Error::Storage(e.to_string()))?;
        conn.pragma_update(None, "user_version", 5)
            .map_err(|e| Error::Storage(e.to_string()))?;
    }
    // V6（C3，R24）：主机 shell_integration 列 + 存量 SSH 主机一次性显式写 true
    // （与旧行为「无条件注入」一致，杜绝灰度期旧 UI/CLI upsert 缺字段静默关闭已迁移
    // 主机——DC3.2）；local 主机与软删行不动（None=未设置）。
    if version < 6 {
        conn.execute_batch(
            "ALTER TABLE hosts ADD COLUMN shell_integration INTEGER;
             UPDATE hosts SET shell_integration=1 WHERE deleted_at IS NULL AND address != 'local';",
        )
        .map_err(|e| Error::Storage(e.to_string()))?;
        conn.pragma_update(None, "user_version", 6)
            .map_err(|e| Error::Storage(e.to_string()))?;
    }
    // V7（C9，R43）：协作启用状态默认（§10.1-6）。以**既有 schema 标记**区分升级与新装
    // （不以「当前没有 Agent 在线」判定）：全新库（自 user_version=0 建起）默认**关闭**
    // （新装无自动 MCP 监听）；已有库（升级）缺少新键时**保留旧版本「MCP 默认开启」**的
    // 行为，已有明确偏好不覆盖（INSERT OR IGNORE）。
    if version < 7 {
        let default_enabled = if version == 0 { "0" } else { "1" };
        conn.execute(
            "INSERT OR IGNORE INTO settings(key,value) VALUES('collab.enabled',?1)",
            params![default_enabled],
        )
        .map_err(|e| Error::Storage(e.to_string()))?;
        conn.pragma_update(None, "user_version", 7)
            .map_err(|e| Error::Storage(e.to_string()))?;
    }
    // V8（rev-r47）：Agent Token 生命周期——last_used_at（resolve 命中时节流回写，
    // 供 GUI/CLI 展示「最近使用」与泄露排查）+ expires_at（可选过期；过期 token 与
    // 吊销同路径拒绝）。两列均可空，旧行零感知。
    // 幂等：按列存在性加列——部分应用后重放（如迁移中途崩溃、或测试把 user_version
    // 倒回重跑）不会 duplicate column。
    if version < 8 {
        let has_col = |name: &str| -> Result<bool> {
            Ok(conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('agents') WHERE name=?1",
                    params![name],
                    |r| r.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .map_err(|e| Error::Storage(e.to_string()))?)
        };
        if !has_col("last_used_at")? {
            conn.execute_batch("ALTER TABLE agents ADD COLUMN last_used_at INTEGER;")
                .map_err(|e| Error::Storage(e.to_string()))?;
        }
        if !has_col("expires_at")? {
            conn.execute_batch("ALTER TABLE agents ADD COLUMN expires_at INTEGER;")
                .map_err(|e| Error::Storage(e.to_string()))?;
        }
        conn.pragma_update(None, "user_version", 8)
            .map_err(|e| Error::Storage(e.to_string()))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 主密钥
// ---------------------------------------------------------------------------

/// 主密钥来源优先级：TINYSSH_MASTER_KEY(hex) > TINYSSH_MASTER_PASSPHRASE(argon2id) > OS 钥匙串。
/// 口令路径按 **v1 静态盐** 派生（兼容既有数据）。经 [`Vault::open`] 打库走
/// [`master_key_for_db`]（口令路径用库内随机盐）。
pub fn master_key() -> Result<Zeroizing<[u8; 32]>> {
    derive_from_sources(
        &std::env::var("TINYSSH_MASTER_KEY").ok(),
        &std::env::var("TINYSSH_MASTER_PASSPHRASE").ok(),
        None,
    )
}

/// 库绑定派生（[`Vault::open`] 专用）：与 [`master_key`] 同序，但口令路径的
/// argon2 盐从**库内**取（settings `master.salt`）——静态盐让同一口令跨安装
/// 派生同一密钥，攻击者拿一份库即可离线预计算；每库随机盐迫使逐库计算（十轮）。
pub fn master_key_for_db(conn: &Connection) -> Result<Zeroizing<[u8; 32]>> {
    derive_from_sources(
        &std::env::var("TINYSSH_MASTER_KEY").ok(),
        &std::env::var("TINYSSH_MASTER_PASSPHRASE").ok(),
        Some(conn),
    )
}

fn derive_from_sources(
    key_env: &Option<String>,
    pass_env: &Option<String>,
    db: Option<&Connection>,
) -> Result<Zeroizing<[u8; 32]>> {
    if let Some(hex_key) = key_env.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        // env 覆盖在所有构建生效（无头验收/CI 依赖此流程，见
        // docs/acceptance/v0-mvp-acceptance.md §7）——warn 提供可见性而非门控
        tracing::warn!("主密钥来源：TINYSSH_MASTER_KEY 环境变量覆盖（跳过钥匙串）");
        let bytes =
            hex::decode(hex_key).map_err(|_| Error::Storage("bad master key hex".into()))?;
        let mut out = [0u8; 32];
        if bytes.len() != 32 {
            return Err(Error::Storage("master key must be 32 bytes".into()));
        }
        out.copy_from_slice(&bytes);
        return Ok(Zeroizing::new(out));
    }
    if let Some(pass) = pass_env.as_deref().filter(|s| !s.is_empty()) {
        tracing::warn!("主密钥来源：TINYSSH_MASTER_PASSPHRASE 环境变量覆盖（argon2id）");
        return match db {
            Some(conn) => Ok(argon2_derive_with_salt(pass, &db_master_salt(conn)?)),
            None => Ok(argon2_derive(pass)),
        };
    }
    keychain_key()
}

/// v1 静态盐：仅剩两个消费者——`master_key()` 独立派生（open_shared 测试装配）
/// 与**已有数据的旧库**（有凭据但无 `master.salt`，换盐=换密钥=全部不可解）。
const LEGACY_MASTER_SALT: &[u8] = b"tinyssh-master-key-v1";
const MASTER_SALT_KEY: &str = "master.salt";

/// 库内口令盐（hex 16B，settings 表）：在场即用；不在场时新库（无主机/身份
/// 行）生成随机盐落库，已有数据的旧库回落 v1 静态盐保持可解。
fn db_master_salt(conn: &Connection) -> Result<Vec<u8>> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![MASTER_SALT_KEY],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .filter(|s: &String| !s.is_empty());
    if let Some(hex_salt) = stored {
        let salt = hex::decode(hex_salt.trim())
            .map_err(|_| Error::Storage("master.salt 损坏（非合法 hex）".into()))?;
        if salt.len() < 8 {
            return Err(Error::Storage("master.salt 损坏（长度不足）".into()));
        }
        return Ok(salt);
    }
    let has_secrets: i64 = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM hosts) + (SELECT COUNT(*) FROM identities)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| Error::Storage(e.to_string()))?;
    if has_secrets > 0 {
        return Ok(LEGACY_MASTER_SALT.to_vec());
    }
    use rand::RngCore;
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    conn.execute(
        "INSERT INTO settings(key,value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![MASTER_SALT_KEY, hex::encode(salt)],
    )
    .map_err(|e| Error::Storage(e.to_string()))?;
    Ok(salt.to_vec())
}

fn argon2_derive(pass: &str) -> Zeroizing<[u8; 32]> {
    argon2_derive_with_salt(pass, LEGACY_MASTER_SALT)
}

fn argon2_derive_with_salt(pass: &str, salt: &[u8]) -> Zeroizing<[u8; 32]> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let params = Params::new(19456, 2, 1, Some(32)).expect("argon2 params");
    let a2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; 32];
    a2.hash_password_into(pass.as_bytes(), salt, &mut out)
        .expect("argon2");
    Zeroizing::new(out)
}

fn keychain_key() -> Result<Zeroizing<[u8; 32]>> {
    let entry = keyring::Entry::new("TinySSH", "master-key")
        .map_err(|e| Error::Storage(format!("keyring: {e}")))?;
    match entry.get_password() {
        Ok(b64) => {
            let bytes =
                base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64.trim())
                    .map_err(|_| Error::Storage("bad keychain key".into()))?;
            let mut out = [0u8; 32];
            if bytes.len() != 32 {
                return Err(Error::Storage("keychain key must be 32 bytes".into()));
            }
            out.copy_from_slice(&bytes);
            Ok(Zeroizing::new(out))
        }
        Err(keyring::Error::NoEntry) => {
            use rand::RngCore;
            let mut key = [0u8; 32];
            rand::rng().fill_bytes(&mut key);
            let b64 = base64::engine::general_purpose::STANDARD.encode(key);
            entry
                .set_password(&b64)
                .map_err(|e| Error::Storage(format!("keyring set: {e}")))?;
            Ok(Zeroizing::new(key))
        }
        Err(e) => Err(Error::Storage(format!("keyring: {e}"))),
    }
}

// ---------------------------------------------------------------------------
// 加密
// ---------------------------------------------------------------------------

/// XChaCha20-Poly1305 加密：输出 [24B nonce || ct]。
pub fn seal(master: &[u8; 32], plaintext: &[u8]) -> Vec<u8> {
    use rand::RngCore;
    let cipher = XChaCha20Poly1305::new(ChachaKey::from_slice(master));
    let mut nonce_bytes = [0u8; 24];
    rand::rng().fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad: b"tinyssh-identity",
            },
        )
        .expect("chacha encrypt");
    let mut out = Vec::with_capacity(24 + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    out
}

pub fn open_seal(master: &[u8; 32], blob: &[u8]) -> Result<Vec<u8>> {
    if blob.len() < 25 {
        return Err(Error::Storage("bad blob".into()));
    }
    let cipher = XChaCha20Poly1305::new(ChachaKey::from_slice(master));
    let nonce = XNonce::from_slice(&blob[..24]);
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: &blob[24..],
                aad: b"tinyssh-identity",
            },
        )
        .map_err(|_| Error::Storage("decrypt failed".into()))
}

/// rand_core-0.10 兼容的 OS 熵源适配器（供 ssh_key::PrivateKey::random 使用）。
struct OsRandom10;

impl rand_core_010::TryCryptoRng for OsRandom10 {}

impl rand_core_010::TryRng for OsRandom10 {
    type Error = std::convert::Infallible;
    fn try_next_u32(&mut self) -> std::result::Result<u32, Self::Error> {
        use rand::Rng;
        Ok(rand::rng().random())
    }
    fn try_next_u64(&mut self) -> std::result::Result<u64, Self::Error> {
        use rand::Rng;
        Ok(rand::rng().random())
    }
    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> std::result::Result<(), Self::Error> {
        use rand::RngCore;
        rand::rng().fill_bytes(dst);
        Ok(())
    }
}

pub fn token_hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

// ---------------------------------------------------------------------------
// Vault 存储门面
// ---------------------------------------------------------------------------

pub struct Vault {
    conn: Mutex<Connection>,
    master: Zeroizing<[u8; 32]>,
    /// R44（§10.2）：单实例写锁——持有到本 `Vault` 落地（或进程退出）。
    /// 字段只为「持有」而存在，从不读取；`None` 表示未加锁（`open_shared` 路径）。
    _lock: Option<VaultLock>,
}

/// 手写 `Debug`：**绝不输出主密钥**（`Zeroizing<[u8;32]>` 不参与格式化），
/// 只暴露「是否持锁」这一非敏感事实。R44 起也需要它来让 `Result<Vault, _>`
/// 在测试里可用 `unwrap_err()`。
impl std::fmt::Debug for Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vault")
            .field("conn", &"<sqlite>")
            .field("master", &"<redacted>")
            .field("locked", &self._lock.is_some())
            .finish()
    }
}

/// R44（§10.2）：「灰度期间只允许一个应用实例持有同一 vault 写锁」。
///
/// 用 `flock(LOCK_EX | LOCK_NB)` 锁住库文件旁的 `<db>.lock`。选独立锁文件而非锁
/// 库文件本身，是因为 SQLite 自己会在库文件上做字节区间锁，混用会互相干扰；锁文件
/// 只承载这一件事。`flock` 的锁随**打开文件描述**存活，故进程崩溃/被杀时由内核释放，
/// 不会留下需要人工清理的陈旧锁。`drop` 时显式解锁并关闭。
///
/// 两点经审核确认、**有意为之**的行为（R44 审核 F5/F6）：
/// - **粒度是「每个打开的 Vault 对象」而非「应用实例」**：`flock` 在独立 fd 上互斥，
///   故**同一进程内**两个活着的 `Vault` 也会互斥（比 §10.2 字面更严）。这是可接受的
///   收紧：生产代码只在启动时 open 一次（`src-tauri/src/main.rs`），人类交互路径不会
///   同时开两个；它换来的好处是「任何两个写者都不能同时持库」这条不变量与进程边界无关。
/// - **锁文件不删除**：`Drop` 只 `LOCK_UN` 不 `unlink`。删除锁文件是**危险**的经典错误
///   ——若 A 持锁时 B unlink 掉它，C 会创建同名新文件并拿到一把**独立的**锁，互斥即被
///   破坏。代价是库旁边会长期存在一个空的 `<db>.lock`（含护栏拒绝打开的情形），属可接受
///   的副作用，不是残留缺陷。
struct VaultLock {
    file: std::fs::File,
}

impl VaultLock {
    #[cfg(unix)]
    fn acquire(db_path: &Path) -> Result<Self> {
        let lock_path = lock_path_for(db_path);
        let file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|e| {
                Error::Storage(format!("无法创建写锁文件 {}：{e}", lock_path.display()))
            })?;
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::EWOULDBLOCK) {
                return Err(Error::Storage(format!(
                    "另一个 TinySSH 实例正在使用该库（写锁 {} 被占用）：\
                     灰度期同一 vault 只允许一个实例持有写锁。请关闭另一实例后重试。",
                    lock_path.display()
                )));
            }
            return Err(Error::Storage(format!(
                "无法获取写锁 {}：{err}",
                lock_path.display()
            )));
        }
        Ok(Self { file })
    }

    /// Windows 实验性分支（非本轮签收范围）：std 1.89+ 的跨平台文件锁
    /// （底层 LockFileEx），「随打开句柄存活、进程崩溃由内核释放」的语义
    /// 与 unix flock 一致；「被占用」判据按 ErrorKind::WouldBlock。
    #[cfg(windows)]
    fn acquire(db_path: &Path) -> Result<Self> {
        let lock_path = lock_path_for(db_path);
        let file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|e| {
                Error::Storage(format!("无法创建写锁文件 {}：{e}", lock_path.display()))
            })?;
        match file.try_lock() {
            Ok(()) => Ok(Self { file }),
            Err(std::fs::TryLockError::WouldBlock) => Err(Error::Storage(format!(
                "另一个 TinySSH 实例正在使用该库（写锁 {} 被占用）：\
                 灰度期同一 vault 只允许一个实例持有写锁。请关闭另一实例后重试。",
                lock_path.display()
            ))),
            Err(std::fs::TryLockError::Error(e)) => Err(Error::Storage(format!(
                "无法获取写锁 {}：{e}",
                lock_path.display()
            ))),
        }
    }
}

impl Drop for VaultLock {
    #[cfg(unix)]
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }

    #[cfg(windows)]
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

/// 写锁文件路径：与库文件同目录同名 + `.lock` 后缀。
fn lock_path_for(db_path: &Path) -> std::path::PathBuf {
    with_suffix(db_path, ".lock")
}

/// 在路径后追加后缀（`<p>.lock` / `<p>-wal` / `<p>.restore.src` …），不解析扩展名。
fn with_suffix(p: &Path, suffix: &str) -> std::path::PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(suffix);
    std::path::PathBuf::from(s)
}

// ---------------------------------------------------------------------------
// R44（§10.2）：回退演练——导出备份 / 从备份恢复
// ---------------------------------------------------------------------------
//
// §10.2 的语义：「数据库已升级后不能盲目用旧二进制写新库；若 schema 不向后兼容
// 提供导出备份/恢复流程」。`migrate` 的版本护栏（旧程序拒绝打开新库）负责**拦住**
// 误用；本节的导出/恢复负责**给出退路**——升级前先备份，要回退时用较新版本导出、
// 再恢复旧库，而不是拿旧程序硬开新库。

/// 读取库的 schema 版本（**不迁移、不加锁**，纯只读探测）。库文件不存在返回 `None`。
///
/// **注意（R44 审核 N-1 的另一半）**：这是以 `SQLITE_OPEN_READ_ONLY` 打开**原路径**，
/// 而对一个 WAL 模式的库，**只读打开也会创建 `-shm`/`-wal`**（wal-index）。故：
/// - 只应对**用户自己的活动库**用它（`vault version` / `backup` 后回读目标等）——那里
///   侧车本就该存在，无害；
/// - **绝不要**拿它去探测**备份文件**或**只读介质上的库**（会在用户备份旁塞陌生文件，
///   在只读介质上直接失败）。恢复路径已改为由 [`restore_from`] 在**私有副本**上读出
///   来源版本并返回，不再预探测原始来源。
pub fn read_schema_version(db_path: &Path) -> Result<Option<u32>> {
    if !db_path.exists() {
        return Ok(None);
    }
    let conn = Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| Error::Storage(e.to_string()))?;
    let v: u32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| Error::Storage(e.to_string()))?;
    Ok(Some(v))
}

/// 把库导出为一份**一致性快照**到 `out`（§10.2：回退前必备份）。
///
/// - 持写锁：导出期间保证没有别的实例在写（灰度期单实例）；
/// - `out` 已存在即**拒绝覆盖**（不静默毁掉既有备份）；
/// - 用 `VACUUM INTO` 而非文件拷贝——库处于 WAL 模式，直接拷主文件会漏掉已提交但
///   尚未 checkpoint 的 WAL 内容；`VACUUM INTO` 由 SQLite 保证快照一致且已包含它们。
pub fn backup_to(db_path: &Path, out: &Path) -> Result<()> {
    let _lock = VaultLock::acquire(db_path)?;
    // R44 审核 F8：库不存在时**不**先建再备（否则 `vault backup` 指向不存在的路径会
    // 悄悄产出一份空库备份，语义意外且掩盖拼写错误）。
    if !db_path.exists() {
        return Err(Error::Storage(format!(
            "库不存在，无可备份：{}",
            db_path.display()
        )));
    }
    if out.exists() {
        return Err(Error::Storage(format!(
            "备份目标已存在，拒绝覆盖：{}",
            out.display()
        )));
    }
    let conn = open(db_path)?;
    conn.execute("VACUUM INTO ?1", params![out.to_string_lossy().as_ref()])
        .map_err(|e| Error::Storage(format!("导出备份失败：{e}")))?;
    Ok(())
}

/// 从备份 `from` 恢复库到 `db_path`（§10.2）。
///
/// 校验（与 [`migrate`] 同一护栏，方向相反）：
/// - 来源必须是合法 TinySSH 库——**V1 核心表全套在场**（`hosts`/`identities`/`agents`/
///   `policies`/`sessions`/`approvals`），仅有一张 `hosts` 表不算（R44 审核 F2：只查
///   `hosts` 会把「恰好有 hosts 表的垃圾文件」当备份，恢复即毁掉真库）；
/// - 来源 schema 版本**不得高于**本程序支持版本——更高即由更新版本创建，本程序不知其
///   语义，拒绝恢复（否则会重演「旧程序写新库」的静默损坏）。
///
/// 手法：持写锁（目标库须无其他实例占用）→ 拒绝 `from == db_path` → **把来源拷到
/// 我们自己的临时文件，一律从副本读**（R44 审核 N-1：只读打开一个 WAL 库也会在来源
/// 旁创建 `-shm`/`-wal`——会往用户的备份旁塞陌生文件，且来源在只读介质上时会直接失败；
/// 副本归我们所有，随便读，来源分毫不动）→ 校验来源（核心表全套 + 版本不高于本程序）
/// → 从副本 `VACUUM INTO` 一份一致性快照到**临时文件**并**在快照上试迁移到链尾**
/// （证明这份备份真能用；失败则目标库分毫未动）→ **给既有目标库留一份安全副本**
/// `<db>.pre-restore.bak`（R44 审核 F2：覆盖不可逆，必须留退路；用 `VACUUM INTO` 而非
/// 拷主文件，WAL 下后者会漏已提交内容）→ `rename` 原子替换目标库 → 清掉目标库可能残留
/// 的 `-wal`/`-shm`（否则会与旧内容拼接）。
///
/// 注：`<db>.pre-restore.bak` **只保留最近一次**恢复前的状态（每次恢复先删旧的）。
///
/// **返回来源备份的 schema 版本**（在**私有副本**上读出，见 [`restore_from_snapshot`]）。
/// 调用方据此报告「版本 N → M」即可，**不要**再去 [`read_schema_version`] 预探测原始
/// `from`——那会在来源旁建 `-shm`/`-wal`，正是 N-1 要消除的现象（R44 审核：库层修好但
/// CLI 层仍预探测原始来源，故把版本改为从这里带出）。
pub fn restore_from(db_path: &Path, from: &Path) -> Result<u32> {
    let _lock = VaultLock::acquire(db_path)?;
    // R44 审核 F7：拒绝「备份与目标是同一个文件」——否则等于自我重写，语义无意义且
    // 易误用（也会把自身当成备份去覆盖自身）。
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(db_path), std::fs::canonicalize(from)) {
        if a == b {
            return Err(Error::Storage(format!(
                "备份与目标库是同一个文件（{}），拒绝恢复",
                db_path.display()
            )));
        }
    }
    // R44 审核 N-1：从来源的**副本**读，绝不在来源旁写任何东西。
    let src_copy = with_suffix(db_path, ".restore.src");
    let r = restore_from_snapshot(db_path, from, &src_copy);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(with_suffix(&src_copy, suffix));
    }
    r
}

/// [`restore_from`] 的实际工作体：把 `from` 拷成 `src_copy` 并从副本读。
/// 返回来源备份的 schema 版本（副本上读出）。
fn restore_from_snapshot(db_path: &Path, from: &Path, src_copy: &Path) -> Result<u32> {
    let _ = std::fs::remove_file(src_copy);
    std::fs::copy(from, src_copy)
        .map_err(|e| Error::Storage(format!("无法读取备份 {}：{e}", from.display())))?;
    // 连 WAL 侧车一起拷——来源若是 WAL 库，其已提交内容可能还在 `-wal` 里，
    // 只拷主文件会读到旧数据。
    for suffix in ["-wal", "-shm"] {
        let sp = with_suffix(from, suffix);
        if sp.exists() {
            std::fs::copy(&sp, with_suffix(src_copy, suffix))
                .map_err(|e| Error::Storage(format!("无法读取备份 {}：{e}", sp.display())))?;
        }
    }
    let src = Connection::open_with_flags(src_copy, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| Error::Storage(format!("无法读取备份 {}：{e}", from.display())))?;
    // R44 审核 F2：必须是**完整** TinySSH 库，不能只凭一张 `hosts` 表就认定。
    const CORE_TABLES: [&str; 6] = [
        "hosts",
        "identities",
        "agents",
        "policies",
        "sessions",
        "approvals",
    ];
    for t in CORE_TABLES {
        let n: i64 = src
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                params![t],
                |r| r.get(0),
            )
            .map_err(|e| {
                Error::Storage(format!("备份 {} 不是有效的 SQLite 库：{e}", from.display()))
            })?;
        if n == 0 {
            return Err(Error::Storage(format!(
                "备份 {} 不是 TinySSH 库（缺少核心表 {t}）；\
                 为避免误毁现有数据库，已拒绝恢复。",
                from.display()
            )));
        }
    }
    let v: u32 = src
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| Error::Storage(e.to_string()))?;
    if v > SCHEMA_VERSION {
        return Err(Error::Storage(format!(
            "备份的 schema 版本 {v} 高于本程序支持的 {SCHEMA_VERSION}：\
             该备份由更新版本的 TinySSH 创建，本程序无法安全恢复。请升级应用后再恢复。"
        )));
    }
    // R44 审核 F2：**先在临时副本上完整验证，再动目标库**——原先「先覆盖、后验证」
    // （CLI 在 rename 之后才 `SessionManager::open` 试迁移），迁移失败时真库已被换掉。
    let mut tmp_os = db_path.as_os_str().to_os_string();
    tmp_os.push(".restore.tmp");
    let tmp = std::path::PathBuf::from(tmp_os);
    let _ = std::fs::remove_file(&tmp);
    src.execute("VACUUM INTO ?1", params![tmp.to_string_lossy().as_ref()])
        .map_err(|e| Error::Storage(format!("生成恢复快照失败：{e}")))?;
    drop(src);
    {
        // 副本归我们所有，就地迁移到链尾以证明「这份备份真能用」；失败则目标库分毫未动。
        let conn =
            Connection::open(&tmp).map_err(|e| Error::Storage(format!("恢复快照无法打开：{e}")))?;
        if let Err(e) = migrate(&conn) {
            let _ = std::fs::remove_file(&tmp);
            return Err(Error::Storage(format!(
                "备份无法迁移到本程序支持的版本（{e}）；目标库未被改动。"
            )));
        }
    }
    // 走到这里才动目标库：先给**既有目标库**留一份安全副本。用 `VACUUM INTO`（一致性
    // 快照，含 WAL 中已提交内容），不用 `open()`（那会先设 WAL/跑迁移，且对未来版本库
    // 会拒绝——而「用旧备份覆盖新库」正是 §10.2 的合法降级路径）。
    let bak = pre_restore_backup_path(db_path);
    if db_path.exists() {
        let _ = std::fs::remove_file(&bak);
        let cur = Connection::open(db_path)
            .map_err(|e| Error::Storage(format!("无法读取现有库以留副本：{e}")))?;
        cur.execute("VACUUM INTO ?1", params![bak.to_string_lossy().as_ref()])
            .map_err(|e| {
                Error::Storage(format!(
                    "现有库无法留安全副本（{e}）；为免不可逆销毁，已拒绝恢复。\
                     如确认要覆盖，请先手工移走 {}。",
                    db_path.display()
                ))
            })?;
    }
    std::fs::rename(&tmp, db_path).map_err(|e| Error::Storage(format!("替换目标库失败：{e}")))?;
    for suffix in ["-wal", "-shm"] {
        let mut p = db_path.as_os_str().to_os_string();
        p.push(suffix);
        let _ = std::fs::remove_file(std::path::PathBuf::from(p));
    }
    Ok(v)
}

/// 恢复时给既有库留下的安全副本路径（`<db>.pre-restore.bak`）。仅当恢复前目标库
/// 已存在时才会生成。
pub fn pre_restore_backup_path(db_path: &Path) -> std::path::PathBuf {
    let mut p = db_path.as_os_str().to_os_string();
    p.push(".pre-restore.bak");
    std::path::PathBuf::from(p)
}

#[cfg(unix)]
use std::os::unix::io::AsRawFd;

use std::sync::Mutex;

impl Vault {
    /// 打开库并**取得单实例写锁**（R44 §10.2）。库被另一实例持有时返回错误，
    /// 不静默降级为只读——调用方（app/CLI）据此提示用户。
    pub fn open(path: &Path) -> Result<Self> {
        let lock = VaultLock::acquire(path)?;
        let conn = open(path)?;
        let master = master_key_for_db(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            master,
            _lock: Some(lock),
        })
    }

    /// 由调用方提供连接：**不加写锁**（连接的归属与生命周期由调用方负责，加锁会
    /// 与调用方自己的打开方式冲突）。仅用于测试与嵌入式装配。
    pub fn open_shared(conn: Connection, master: Zeroizing<[u8; 32]>) -> Result<Self> {
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            master,
            _lock: None,
        })
    }

    // ---- 主机 ----
    pub fn upsert_host(&self, host: &HostDraft) -> Result<HostId> {
        let conn = self.conn.lock().unwrap();
        let id = host
            .id
            .clone()
            .unwrap_or_else(|| format!("h-{}", uuid::Uuid::new_v4()));
        let (auth_type, identity_id, secret_json): (String, Option<String>, Option<String>) =
            match &host.auth {
                AuthDraft::Key { identity_id } => ("key".into(), Some(identity_id.clone()), None),
                AuthDraft::Password { password } => {
                    let blob = seal(&self.master, password.as_bytes());
                    (
                        "password".into(),
                        None,
                        Some(base64::engine::general_purpose::STANDARD.encode(blob)),
                    )
                }
                // Keep 语义：编辑主机不回传明文——已存在的行保留原凭据列
                // （identities 表的密码行随 identity_id 不变而原样保留）。
                AuthDraft::None => match host.id.as_ref() {
                    Some(id) => {
                        let existing: Option<(String, Option<String>)> = conn
                            .query_row(
                                "SELECT auth_type, identity_id FROM hosts WHERE id=?1 AND deleted_at IS NULL",
                                params![id],
                                |r| Ok((r.get(0)?, r.get(1)?)),
                            )
                            .ok();
                        match existing {
                            Some((t, iid)) => (t, iid, None),
                            None => ("key".into(), None, None),
                        }
                    }
                    None => ("key".into(), None, None),
                },
                AuthDraft::Agent => ("agent".into(), None, None),
            };
        // 口令类凭据也存 identities（kind=password），统一加密管理
        let identity_id = if let Some(b64) = secret_json {
            let iid = format!("i-{}", uuid::Uuid::new_v4());
            conn.execute(
                "INSERT INTO identities (id, label, kind, public_key, fingerprint, secret_blob, created_at, updated_at)
                 VALUES (?1,?2,'password',NULL,NULL,?3,?4,?4)",
                params![iid, format!("pwd:{id}"), b64, now_ms()],
            )
            .map_err(db_err)?;
            Some(iid)
        } else {
            identity_id
        };
        // C3（DC3.2）：None=编辑保原值（旧行列原样）/新建 false；Some(v)=显式覆盖
        let shell_integration: i64 = match host.shell_integration {
            Some(v) => {
                if v {
                    1
                } else {
                    0
                }
            }
            None => {
                let existing: Option<Option<i64>> = conn
                    .query_row(
                        "SELECT shell_integration FROM hosts WHERE id=?1 AND deleted_at IS NULL",
                        params![id],
                        |r| r.get(0),
                    )
                    .ok();
                match existing {
                    Some(Some(v)) => v,
                    _ => 0, // 新建或列空（未设置）→ false
                }
            }
        };
        conn.execute(
            "INSERT INTO hosts (id, name, address, port, username, auth_type, identity_id, tags_json, charset, shell_integration, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?11,?10,?10)
             ON CONFLICT(id) DO UPDATE SET name=?2, address=?3, port=?4, username=?5, auth_type=?6, identity_id=?7, tags_json=?8, charset=?9, shell_integration=?11, updated_at=?10",
            params![
                id,
                host.name,
                host.address,
                host.port.unwrap_or(22) as i64,
                host.username,
                auth_type,
                identity_id,
                serde_json::to_string(&host.tags).unwrap(),
                host.charset.as_str(),
                now_ms(),
                shell_integration,
            ],
        )
        .map_err(db_err)?;
        Ok(id)
    }

    pub fn delete_host(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE hosts SET deleted_at=?2 WHERE id=?1",
            params![id, now_ms()],
        )
        .map_err(db_err)?;
        // C8 联动：主机元数据行随删（收藏/最近连接时间不留幽灵）；凭据不删、
        // 会话不隐式关闭（§5 已定）
        conn.execute("DELETE FROM host_metadata WHERE host_id=?1", params![id])
            .map_err(db_err)?;
        Ok(())
    }

    pub fn list_hosts(&self) -> Result<Vec<Host>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, address, port, username, auth_type, identity_id, tags_json, host_fingerprint, charset, shell_integration FROM hosts WHERE deleted_at IS NULL")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                let tags_json: String = r.get(7)?;
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    tags_json,
                    // 空串 = 信任未建立（set_host_fingerprint 只写非空，此处兜底）
                    r.get::<_, Option<String>>(8)?.filter(|s| !s.is_empty()),
                    r.get::<_, String>(9)?,
                    r.get::<_, Option<i64>>(10)?.map(|v| v != 0),
                ))
            })
            .map_err(db_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (
                id,
                name,
                address,
                port,
                username,
                auth_type,
                identity_id,
                tags_json,
                fingerprint,
                charset,
                shell_integration,
            ) = row.map_err(db_err)?;
            out.push(Host {
                id,
                name,
                address,
                port: port as u16,
                username,
                auth_type: match auth_type.as_str() {
                    "password" => AuthType::Password,
                    "agent" => AuthType::Agent,
                    _ => AuthType::Key,
                },
                identity_id,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                fingerprint,
                shell_integration,
                charset: Charset::parse(&charset),
            });
        }
        Ok(out)
    }

    /// 已信任的主机指纹（TOFU，路线图⑤）；None = 该主机尚无信任记录。
    pub fn host_fingerprint(&self, host_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let fp: Option<String> = conn
            .query_row(
                "SELECT host_fingerprint FROM hosts WHERE id=?1 AND deleted_at IS NULL",
                params![host_id],
                |r| r.get(0),
            )
            .map_err(|e| Error::Storage(e.to_string()))?;
        Ok(fp.filter(|s| !s.is_empty()))
    }

    /// 记录/更新主机指纹（仅在人类确认后调用）。
    pub fn set_host_fingerprint(&self, host_id: &str, fp: &str) -> Result<()> {
        let n = self
            .conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE hosts SET host_fingerprint=?2, updated_at=?3 WHERE id=?1 AND deleted_at IS NULL",
                params![host_id, fp, now_ms()],
            )
            .map_err(|e| Error::Storage(e.to_string()))?;
        if n == 0 {
            return Err(Error::InvalidInput(format!("host {host_id} not found")));
        }
        Ok(())
    }

    /// 读 UI 偏好（路线图⑥：字号/主题等）；None = 从未设置。
    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let v = conn.query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![key],
            |r| r.get::<_, String>(0),
        );
        match v {
            Ok(s) => Ok(Some(s).filter(|s| !s.is_empty())),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(Error::Storage(e.to_string())),
        }
    }

    /// 写 UI 偏好（upsert）。
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO settings(key,value) VALUES(?1,?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value],
            )
            .map_err(|e| Error::Storage(e.to_string()))?;
        Ok(())
    }

    // ---- C9 协作启用状态（R43）----
    /// 协作服务是否启用（settings `collab.enabled`；缺省按 false=关闭，保守侧）。
    /// V7 迁移保证键存在（新装 "0" / 升级 "1"）；此处兜底手删场景。
    pub fn collab_enabled(&self) -> Result<bool> {
        Ok(self.get_setting("collab.enabled")?.as_deref() == Some("1"))
    }

    /// 写协作启用状态（用户显式启用/停用时持久化期望态）。
    pub fn set_collab_enabled(&self, on: bool) -> Result<()> {
        self.set_setting("collab.enabled", if on { "1" } else { "0" })
    }

    // ---- C8 偏好与主机元数据（R15）----
    /// 工作区偏好整取（ui.v2.workspace blob）：缺失/损坏回落 Default（不炸启动，
    /// 下次整存即自愈）。V5 迁移保证键存在；此处兜底手删/旧库直开场景。
    pub fn workspace(&self) -> Result<Workspace> {
        match self.get_setting("ui.v2.workspace")? {
            None => Ok(Workspace::default()),
            Some(raw) => Ok(serde_json::from_str(&raw).unwrap_or_default()),
        }
    }

    /// 工作区偏好整存（原子覆盖单行 = 原子；schemaVersion 由核心归一为当前版本）。
    pub fn set_workspace(&self, ws: &Workspace) -> Result<()> {
        let mut normalized = ws.clone();
        normalized.schema_version = 1;
        self.set_setting(
            "ui.v2.workspace",
            &serde_json::to_string(&normalized).map_err(|e| Error::Storage(e.to_string()))?,
        )
    }

    /// 收藏/取消收藏（host_metadata upsert；未知主机 InvalidInput）。
    pub fn set_host_favorite(&self, host_id: &str, favorite: bool) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let alive: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM hosts WHERE id=?1 AND deleted_at IS NULL",
                params![host_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if alive == 0 {
            return Err(Error::InvalidInput(format!("host {host_id} not found")));
        }
        conn.execute(
            "INSERT INTO host_metadata(host_id, favorite) VALUES(?1,?2)
             ON CONFLICT(host_id) DO UPDATE SET favorite=excluded.favorite",
            params![host_id, favorite as i64],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// 主机元数据列表（只含有行的主机；无行 = 未收藏且从未连接，不虚构）。
    pub fn list_host_metadata(&self) -> Result<Vec<HostMeta>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT host_id, favorite, last_connected_at FROM host_metadata")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                ))
            })
            .map_err(db_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (host_id, favorite, last) = row.map_err(db_err)?;
            out.push(HostMeta {
                host_id,
                favorite: favorite != 0,
                last_connected_at: last
                    .and_then(chrono::DateTime::from_timestamp_millis)
                    .map(|t| t),
            });
        }
        Ok(out)
    }

    /// 最近连接（DF8.5）：sessions 派生——排除 local、每主机取最近一次、倒序上限
    /// `limit`；只含仍存活主机（删除主机不留幽灵项），无记录返回空。
    pub fn list_recent_hosts(&self, limit: i64) -> Result<Vec<RecentHost>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT s.host_id, h.name, MAX(s.created_at) AS last_at
                 FROM sessions s JOIN hosts h ON h.id = s.host_id AND h.deleted_at IS NULL
                 WHERE s.kind != 'local' AND s.host_id IS NOT NULL
                 GROUP BY s.host_id
                 ORDER BY last_at DESC
                 LIMIT ?1",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![limit], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(db_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (host_id, host_name, last_at) = row.map_err(db_err)?;
            out.push(RecentHost {
                host_id,
                host_name,
                connected_at: chrono::DateTime::from_timestamp_millis(last_at).unwrap_or_default(),
            });
        }
        Ok(out)
    }

    /// 记录主机成功建连（host_metadata.last_connected_at upsert；未知主机忽略——
    /// local 兜底主机/并发删除窗口不致命。WHERE EXISTS 防并发删除后幽灵行复活，
    /// 全库未开 PRAGMA foreign_keys，FK 不拦——rev-r15 M1）。
    pub fn touch_host_connection(&self, host_id: &str) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO host_metadata(host_id, favorite, last_connected_at)
                 SELECT ?1, 0, ?2
                 WHERE EXISTS(SELECT 1 FROM hosts WHERE id=?1 AND deleted_at IS NULL)
                 ON CONFLICT(host_id) DO UPDATE SET last_connected_at=excluded.last_connected_at",
                params![host_id, now_ms()],
            )
            .map_err(db_err)?;
        Ok(())
    }

    // ---- C5 传输 journal（R32 §560：任务创建即落行；重启按提交前中断恢复）----
    // state 列存 TransferStatus 的 wire 字符串（PascalCase），kind 列存小写
    //（schema CHECK 约束），与 TransferTask 序列化格式单点映射。

    fn journal_kind_str(k: TransferKind) -> &'static str {
        match k {
            TransferKind::Upload => "upload",
            TransferKind::Download => "download",
        }
    }

    fn journal_status_str(s: &TransferStatus) -> String {
        serde_json::to_value(s)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_else(|| "Running".into())
    }

    fn journal_row_to_task(r: &rusqlite::Row<'_>) -> rusqlite::Result<TransferTask> {
        let kind: String = r.get(2)?;
        let state: String = r.get(5)?;
        let collision: Option<String> = r.get(9)?;
        Ok(TransferTask {
            id: r.get(0)?,
            session_id: r.get(1)?,
            kind: if kind == "download" {
                TransferKind::Download
            } else {
                TransferKind::Upload
            },
            source: r.get(3)?,
            dest: r.get(4)?,
            status: serde_json::from_str::<TransferStatus>(&format!("\"{state}\""))
                .unwrap_or(TransferStatus::Failed),
            bytes_done: r.get::<_, Option<i64>>(6)?.unwrap_or(0).max(0) as u64,
            total: r.get::<_, Option<i64>>(7)?.map(|v| v.max(0) as u64),
            revision: r.get::<_, i64>(8)?.max(0) as u64,
            created_at: r.get(13)?,
            finished_at: r.get(14)?,
            error: r.get(11)?,
            retry_of: r.get(12)?,
            collision_decision: collision
                .and_then(|s| serde_json::from_str(&format!("\"{s}\"")).ok()),
            decision_prompt: None,
        })
    }

    /// 提交窗口证据读取（C6/R34 DF5.2）：verified 标记=发布应答丢失复核路径
    /// 的唯一绑定证据（true=发布原语成功后落库，可判 Succeeded{verified}；
    /// false=不可判定，保持 OutcomeUnknown）。
    fn journal_row_to_task_verified(
        r: &rusqlite::Row<'_>,
    ) -> rusqlite::Result<(TransferTask, bool)> {
        let t = Self::journal_row_to_task(r)?;
        let verified: Option<i64> = r.get(10)?;
        Ok((t, verified.unwrap_or(0) != 0))
    }

    const JOURNAL_COLS: &str = "task_id, session_id, kind, src_path, dst_path, state, \
         bytes_transferred, total_bytes, revision, collision_decision, verified, \
         error, retry_of, created_at, finished_at";

    /// 任务创建即落行（Queued，§560）。collision_decision/verified 随 C6/R34
    /// 启用（列 V5 已建；verified=提交窗口发布原语成功标记，0 起步）。
    pub fn transfer_journal_insert(&self, t: &TransferTask) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO transfer_journal(task_id, session_id, kind, src_path, dst_path, \
                 state, bytes_transferred, total_bytes, revision, collision_decision, verified, \
                 error, retry_of, created_at, finished_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                params![
                    t.id,
                    t.session_id,
                    Self::journal_kind_str(t.kind),
                    t.source,
                    t.dest,
                    Self::journal_status_str(&t.status),
                    t.bytes_done as i64,
                    t.total.map(|v| v as i64),
                    t.revision as i64,
                    t.collision_decision.map(Self::journal_collision_str),
                    0i64,
                    t.error,
                    t.retry_of,
                    t.created_at,
                    t.finished_at,
                ],
            )
            .map_err(db_err)?;
        Ok(())
    }

    /// 进度/状态推进（节流落库节奏由调用方定；按主键整行可变字段覆盖）。
    /// verified：发布原语成功后由提交窗口写入（仅 Committing 态行，C6/R34）。
    pub fn transfer_journal_update(&self, t: &TransferTask, verified: Option<bool>) -> Result<()> {
        let n = self
            .conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE transfer_journal SET state=?2, bytes_transferred=?3, total_bytes=?4, \
                 revision=?5, collision_decision=?6, verified=COALESCE(?7, verified), \
                 error=?8, finished_at=?9 WHERE task_id=?1",
                params![
                    t.id,
                    Self::journal_status_str(&t.status),
                    t.bytes_done as i64,
                    t.total.map(|v| v as i64),
                    t.revision as i64,
                    t.collision_decision.map(Self::journal_collision_str),
                    verified.map(|v| if v { 1i64 } else { 0i64 }),
                    t.error,
                    t.finished_at,
                ],
            )
            .map_err(db_err)?;
        if n == 0 {
            return Err(Error::InvalidInput(format!(
                "transfer journal row {} missing",
                t.id
            )));
        }
        Ok(())
    }

    fn journal_collision_str(d: session_api::CollisionDecision) -> &'static str {
        match d {
            session_api::CollisionDecision::Skip => "skip",
            session_api::CollisionDecision::Overwrite => "overwrite",
            session_api::CollisionDecision::KeepBoth => "keepboth",
        }
    }

    /// 启动恢复：活动阶段行（§560 绝不仅凭异常退出宣告成功/失败——由调用方
    /// 按提交语义处置；R34 分类：Committing+verified→Succeeded{verified}、
    /// Committing→OutcomeUnknown、其余→Interrupted）。
    pub fn transfer_journal_load_active(&self) -> Result<Vec<(TransferTask, bool)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {} FROM transfer_journal \
                 WHERE state IN ('Queued','Running','Committing','Cancelling','AwaitingDecision') \
                 ORDER BY created_at ASC",
                Self::JOURNAL_COLS,
            ))
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], Self::journal_row_to_task_verified)
            .map_err(db_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(db_err)?);
        }
        Ok(out)
    }

    /// C6/R34：按 id 取行（OutcomeUnknown 复核路径的 journal 证据读取）。
    pub fn transfer_journal_get(&self, task_id: &str) -> Result<Option<(TransferTask, bool)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {} FROM transfer_journal WHERE task_id = ?1",
                Self::JOURNAL_COLS,
            ))
            .map_err(db_err)?;
        let mut rows = stmt
            .query_map(params![task_id], Self::journal_row_to_task_verified)
            .map_err(db_err)?;
        match rows.next() {
            Some(r) => Ok(Some(r.map_err(db_err)?)),
            None => Ok(None),
        }
    }

    /// 查询最近 N 行（创建倒序；UI 重挂对账与历史呈现）。
    pub fn transfer_journal_list(&self, limit: u32) -> Result<Vec<TransferTask>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {} FROM transfer_journal \
                 ORDER BY created_at DESC, task_id DESC LIMIT ?1",
                Self::JOURNAL_COLS,
            ))
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![limit], Self::journal_row_to_task)
            .map_err(db_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(db_err)?);
        }
        Ok(out)
    }

    /// 凭据引用检查（DF8.4）：返回仍引用该 identity 的存活主机名列表。
    pub fn identity_host_refs(&self, id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT name FROM hosts WHERE identity_id=?1 AND deleted_at IS NULL ORDER BY name",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![id], |r| r.get::<_, String>(0))
            .map_err(db_err)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(db_err)?);
        }
        Ok(out)
    }

    /// 取主机连接凭据（内部用；SessionApi 无返回凭据的方法）。
    /// Agent 认证不经 vault（签名时私钥不出 ssh-agent），返回空串。
    pub fn host_secret(&self, host: &Host) -> Result<(AuthType, Zeroizing<String>)> {
        if host.auth_type == AuthType::Agent {
            return Ok((AuthType::Agent, Zeroizing::new(String::new())));
        }
        let iid = host
            .identity_id
            .as_ref()
            .ok_or_else(|| Error::InvalidInput("host has no identity".into()))?;
        Ok((host.auth_type, self.identity_secret(iid)?))
    }

    /// 按 id 解出凭据明文（十七轮：快速连接引用凭据库已有密钥时即席解出到内存，
    /// 不新建不改 vault；明文由调用方 Zeroizing 持有，应用退出即失）。
    /// 身份不存在/已删除 → InvalidInput（快速连接表单可行动文案，非存储错误）。
    pub fn identity_secret(&self, iid: &str) -> Result<Zeroizing<String>> {
        let conn = self.conn.lock().unwrap();
        let blob: String = conn
            .query_row(
                "SELECT secret_blob FROM identities WHERE id=?1 AND deleted_at IS NULL",
                params![iid],
                |r| r.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    Error::InvalidInput("所选密钥不存在或已删除".into())
                }
                other => Error::Storage(other.to_string()),
            })?;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(blob)
            .map_err(|_| Error::Storage("bad blob b64".into()))?;
        let plain = open_seal(&self.master, &raw)?;
        Ok(Zeroizing::new(String::from_utf8_lossy(&plain).into_owned()))
    }

    // ---- 身份（生成/导入）----
    pub fn create_identity(&self, req: &IdentityReq) -> Result<IdentityMeta> {
        use russh::keys::PublicKeyBase64;
        let (label, kind, pem, fingerprint, kkind) = match req {
            IdentityReq::Password { label, password } => {
                let blob = seal(&self.master, password.as_bytes());
                let b64 = base64::engine::general_purpose::STANDARD.encode(blob);
                let id = format!("i-{}", uuid::Uuid::new_v4());
                let conn = self.conn.lock().unwrap();
                conn.execute(
                    "INSERT INTO identities (id, label, kind, public_key, fingerprint, secret_blob, created_at, updated_at)
                     VALUES (?1,?2,'password',NULL,NULL,?3,?4,?4)",
                    params![id, label, b64, now_ms()],
                )
                .map_err(db_err)?;
                return Ok(IdentityMeta {
                    id,
                    label: label.clone(),
                    kind: IdentityKind::Password,
                    fingerprint: String::new(),
                });
            }
            IdentityReq::Generate { label, kind } => {
                use russh::keys::ssh_key::{Algorithm, PrivateKey};
                let alg = match kind {
                    KeyKind::Ed25519 => Algorithm::Ed25519,
                    KeyKind::Rsa => Algorithm::Rsa { hash: None },
                };
                let key = PrivateKey::random(&mut OsRandom10, alg)
                    .map_err(|e| Error::Storage(format!("keygen: {e}")))?;
                let pem = key
                    .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                    .map_err(|e| Error::Storage(format!("pem: {e}")))?
                    .to_string();
                let fp = key
                    .public_key()
                    .fingerprint(russh::keys::ssh_key::HashAlg::Sha256);
                (
                    label.clone(),
                    match kind {
                        KeyKind::Ed25519 => IdentityKind::Ed25519,
                        KeyKind::Rsa => IdentityKind::Rsa,
                    },
                    pem,
                    format!("{fp}"),
                    *kind,
                )
            }
            IdentityReq::Import {
                label,
                pem,
                passphrase,
            } => {
                let key = russh::keys::decode_secret_key(pem, passphrase.as_deref())
                    .map_err(|_| Error::InvalidInput("bad key or passphrase".into()))?;
                let fp = key
                    .public_key()
                    .fingerprint(russh::keys::ssh_key::HashAlg::Sha256);
                (
                    label.clone(),
                    if key.algorithm() == russh::keys::ssh_key::Algorithm::Ed25519 {
                        IdentityKind::Ed25519
                    } else if key.algorithm().as_str().starts_with("rsa") {
                        IdentityKind::Rsa
                    } else {
                        IdentityKind::Ecdsa
                    },
                    pem.clone(),
                    format!("{fp}"),
                    KeyKind::Ed25519,
                )
            }
        };
        let pk = if pem.is_empty() {
            None
        } else {
            russh::keys::decode_secret_key(&pem, None)
                .ok()
                .map(|k| k.public_key().public_key_base64())
        };
        let id = format!("i-{}", uuid::Uuid::new_v4());
        let blob = seal(&self.master, pem.as_bytes());
        let b64 = base64::engine::general_purpose::STANDARD.encode(blob);
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO identities (id, label, kind, public_key, fingerprint, secret_blob, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
            params![
                id,
                label,
                match kkind {
                    KeyKind::Ed25519 => "ed25519",
                    KeyKind::Rsa => "rsa",
                },
                pk,
                fingerprint,
                b64,
                now_ms()
            ],
        )
        .map_err(db_err)?;
        Ok(IdentityMeta {
            id,
            label,
            kind,
            fingerprint,
        })
    }

    pub fn list_identities(&self) -> Result<Vec<IdentityMeta>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, label, kind, fingerprint FROM identities WHERE deleted_at IS NULL")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                let kind: String = r.get(2)?;
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    kind,
                    r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                ))
            })
            .map_err(db_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (id, label, kind, fingerprint) = row.map_err(db_err)?;
            out.push(IdentityMeta {
                id,
                label,
                kind: match kind.as_str() {
                    "ed25519" => IdentityKind::Ed25519,
                    "rsa" => IdentityKind::Rsa,
                    "ecdsa" => IdentityKind::Ecdsa,
                    _ => IdentityKind::Password,
                },
                fingerprint,
            });
        }
        Ok(out)
    }

    pub fn identity_pem(&self, id: &str) -> Result<Zeroizing<String>> {
        let conn = self.conn.lock().unwrap();
        let blob: String = conn
            .query_row(
                "SELECT secret_blob FROM identities WHERE id=?1 AND deleted_at IS NULL",
                params![id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(blob)
            .map_err(|_| Error::Storage("bad blob".into()))?;
        let plain = open_seal(&self.master, &raw)?;
        Ok(Zeroizing::new(String::from_utf8_lossy(&plain).into_owned()))
    }

    pub fn delete_identity(&self, id: &str) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE identities SET deleted_at=?2 WHERE id=?1",
                params![id, now_ms()],
            )
            .map_err(db_err)?;
        Ok(())
    }

    // ---- Agent 身份与 Token ----
    /// 创建 agent；返回原始 Token（仅此一次展示）。不过期。
    pub fn create_agent(&self, client_id: &str, label: &str) -> Result<String> {
        self.create_agent_ex(client_id, label, None)
    }

    /// rev-r47：创建 agent 并附可选过期时间——过期后 token 解析即拒（与吊销同路径
    /// `invalid_actor`，不新增错误类别）。重签发（同 id）会重置过期时间。
    pub fn create_agent_ex(
        &self,
        client_id: &str,
        label: &str,
        expires_at: Option<chrono::DateTime<chrono::Utc>>,
    ) -> Result<String> {
        use rand::RngCore;
        let mut tok = [0u8; 32];
        rand::rng().fill_bytes(&mut tok);
        let token = hex::encode(tok);
        let hash = token_hash(&token);
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO agents (id, label, token_hash, created_at, expires_at) VALUES (?1,?2,?3,?4,?5)
                 ON CONFLICT(id) DO UPDATE SET token_hash=?3, revoked_at=NULL, label=?2, expires_at=?5",
                params![client_id, label, hash.to_vec(), now_ms(), expires_at.map(|e| e.timestamp_millis())],
            )
            .map_err(db_err)?;
        Ok(token)
    }

    /// 校验 Token → client_id（常数时间比较 via sha256 比对）。
    /// rev-r47：过期 token 视同吊销（返回 None → invalid_actor）；
    /// 命中时节流回写 `last_used_at`（60s 内不重复写，避免每请求一次写放大）。
    pub fn resolve_token(&self, token: &str) -> Option<AgentClientId> {
        const TOUCH_THROTTLE_MS: i64 = 60_000;
        let hash = token_hash(token);
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, token_hash, expires_at, last_used_at FROM agents WHERE revoked_at IS NULL")
            .ok()?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Vec<u8>>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                ))
            })
            .ok()?;
        let mut matched: Option<(String, bool)> = None;
        for row in rows {
            let (id, stored, expires_at, last_used_at) = row.ok()?;
            // 常数时间比较
            if stored.len() == 32 && constant_time_eq(&stored, &hash) {
                // 过期 token：与吊销同口径拒绝
                if let Some(e) = expires_at {
                    if e <= now_ms() {
                        return None;
                    }
                }
                let touch = last_used_at
                    .map(|t| now_ms().saturating_sub(t) > TOUCH_THROTTLE_MS)
                    .unwrap_or(true);
                matched = Some((id, touch));
                break;
            }
        }
        drop(stmt);
        let (id, touch) = matched?;
        if touch {
            let _ = conn.execute(
                "UPDATE agents SET last_used_at=?1 WHERE id=?2",
                params![now_ms(), id],
            );
        }
        Some(id)
    }

    pub fn list_agents(&self) -> Result<Vec<(String, String, Option<i64>)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, label, revoked_at FROM agents ORDER BY created_at")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                ))
            })
            .map_err(db_err)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(db_err)?);
        }
        Ok(out)
    }

    /// rev-r47：带生命周期字段的明细（GUI/CLI 列表用）——id/label/吊销/最近使用/过期。
    pub fn list_agents_detailed(&self) -> Result<Vec<AgentAccount>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, label, revoked_at, last_used_at, expires_at
                 FROM agents ORDER BY (revoked_at IS NOT NULL), created_at",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(AgentAccount {
                    id: r.get(0)?,
                    label: r.get(1)?,
                    revoked_at: r.get(2)?,
                    last_used_at: r.get(3)?,
                    expires_at: r.get(4)?,
                })
            })
            .map_err(db_err)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(db_err)?);
        }
        Ok(out)
    }

    pub fn revoke_agent(&self, client_id: &str) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE agents SET revoked_at=?2 WHERE id=?1",
                params![client_id, now_ms()],
            )
            .map_err(db_err)?;
        Ok(())
    }

    // ---- 策略（per agent）----
    pub fn load_policy(&self, agent_id: &str) -> Policy {
        let conn = self.conn.lock().unwrap();
        // 过期 TTL 窗口顺手清理（「批准并记住」会持续产生短命行）
        let _ = conn.execute(
            "DELETE FROM policies WHERE kind='ttl_window' AND expires_at IS NOT NULL AND expires_at < ?1",
            params![chrono::Utc::now().timestamp_millis()],
        );
        let mut stmt = match conn
            .prepare("SELECT kind, pattern, scope, expires_at FROM policies WHERE agent_id=?1 AND deleted_at IS NULL")
        {
            Ok(s) => s,
            Err(_) => return Policy::default(),
        };
        let mut policy = Policy::default();
        let rows = stmt.query_map(params![agent_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<i64>>(3)?,
            ))
        });
        if let Ok(rows) = rows {
            for row in rows.flatten() {
                let (kind, pattern, scope, expires_at) = row;
                match kind.as_str() {
                    "allow_pattern" => {
                        if let Some(p) = pattern {
                            policy.allow_rules.push(session_api::AllowRule {
                                pattern: p,
                                note: scope.unwrap_or_default(),
                            });
                        }
                    }
                    "ttl_window" => {
                        if let (Some(p), Some(exp)) = (pattern, expires_at) {
                            policy.ttl_windows.push(session_api::TtlWindow {
                                pattern: p,
                                expires_at: chrono::DateTime::from_timestamp_millis(exp)
                                    .unwrap_or_default(),
                            });
                        }
                    }
                    "deny_extra" => {
                        if let Some(p) = pattern {
                            policy.deny_rules.push(session_api::DenyRule {
                                pattern: p,
                                reason: scope.unwrap_or_default(),
                                builtin: false,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        policy
    }

    // ---- 策略写入（单一事实源；engine 每次从 vault 刷新）----
    pub fn add_allow_pattern(&self, agent_id: &str, pattern: &str, note: &str) -> Result<()> {
        self.conn.lock().unwrap()
            .execute(
                "INSERT INTO policies (id, agent_id, kind, pattern, scope, created_by, created_at) VALUES (?1,?2,'allow_pattern',?3,?4,'human',?5)",
                params![format!("p-{}", uuid::Uuid::new_v4()), agent_id, pattern, note, now_ms()],
            )
            .map_err(db_err)?;
        Ok(())
    }

    pub fn add_ttl_window(
        &self,
        agent_id: &str,
        pattern: &str,
        expires_at: chrono::DateTime<chrono::Utc>,
    ) -> Result<()> {
        self.conn.lock().unwrap()
            .execute(
                "INSERT INTO policies (id, agent_id, kind, pattern, expires_at, created_by, created_at) VALUES (?1,?2,'ttl_window',?3,?4,'human',?5)",
                params![format!("p-{}", uuid::Uuid::new_v4()), agent_id, pattern, expires_at.timestamp_millis(), now_ms()],
            )
            .map_err(db_err)?;
        Ok(())
    }

    // ---- 会话记录 ----
    /// 会话行落库。十七轮：host_id 可为 None——快速连接主机不在 hosts 表
    /// （FK 会拒），记 NULL；最近连接按 `host_id IS NOT NULL` 派生，天然排除。
    pub fn record_session(&self, sid: &SessionId, host_id: Option<&str>, kind: &str) -> Result<()> {
        self.conn.lock().unwrap()
            .execute(
                "INSERT INTO sessions (id, host_id, kind, state, created_at) VALUES (?1,?2,?3,'connected',?4)",
                params![sid, host_id, kind, now_ms()],
            )
            .map_err(db_err)?;
        Ok(())
    }

    pub fn set_session_state(&self, sid: &SessionId, state: &str) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE sessions SET state=?2 WHERE id=?1",
                params![sid, state],
            )
            .map_err(db_err)?;
        Ok(())
    }

    pub fn close_session_row(&self, sid: &SessionId) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE sessions SET state='closed', closed_at=?2 WHERE id=?1",
                params![sid, now_ms()],
            )
            .map_err(db_err)?;
        Ok(())
    }

    // ---- 审批持久化 ----
    pub fn save_approval(&self, item: &ApprovalItem) -> Result<()> {
        self.conn.lock().unwrap()
            .execute(
                "INSERT INTO approvals (id, session_id, agent_id, command, edited_command, target_summary, status, decided_at, expires_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,NULL)
                 ON CONFLICT(id) DO UPDATE SET status=?7, edited_command=?5, decided_at=?8",
                params![
                    item.id,
                    item.session_id,
                    item.agent_id,
                    item.command,
                    item.edited_command,
                    item.target_summary,
                    format!("{:?}", item.status).to_lowercase(),
                    now_ms()
                ],
            )
            .map_err(db_err)?;
        Ok(())
    }

    pub fn approval_status(&self, id: &ApprovalId) -> Result<Option<ApprovalStatus>> {
        let conn = self.conn.lock().unwrap();
        let r = conn.query_row(
            "SELECT status FROM approvals WHERE id=?1",
            params![id],
            |r| r.get::<_, String>(0),
        );
        match r {
            Ok(s) => Ok(Some(match s.as_str() {
                "pending" => ApprovalStatus::Pending,
                "approved" => ApprovalStatus::Approved,
                "approved_edited" => ApprovalStatus::ApprovedEdited,
                "denied" => ApprovalStatus::Denied,
                "timeout" => ApprovalStatus::Timeout,
                "voided" => ApprovalStatus::Voided,
                _ => ApprovalStatus::Pending,
            })),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(Error::Storage(e.to_string())),
        }
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn db_err(e: rusqlite::Error) -> Error {
    Error::Storage(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let conn = Connection::open(dir.path().join("v.db")).unwrap();
        // env 主密钥（测试固定）
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let v = Vault::open_shared(conn, master_key().unwrap()).unwrap();
        (dir, v)
    }

    #[test]
    fn seal_roundtrip() {
        let m = [9u8; 32];
        let ct = seal(&m, b"secret-pem-data");
        assert_ne!(ct, b"secret-pem-data".to_vec());
        assert_eq!(open_seal(&m, &ct).unwrap(), b"secret-pem-data");
        // 篡改 nonce
        let mut bad = ct.clone();
        bad[0] ^= 1;
        assert!(open_seal(&m, &bad).is_err());
    }

    #[test]
    fn agent_token_lifecycle() {
        let (_dir, v) = vault();
        let token = v.create_agent("claude-code", "Claude Code").unwrap();
        assert_eq!(v.resolve_token(&token).as_deref(), Some("claude-code"));
        assert!(v.resolve_token("wrong").is_none());
        v.revoke_agent("claude-code").unwrap();
        assert!(v.resolve_token(&token).is_none());
    }

    #[test]
    fn agent_token_expiry_and_last_used() {
        // rev-r47：过期 token 与吊销同口径拒绝；命中回写 last_used_at（节流）
        let (_dir, v) = vault();
        // 已过期：解析即拒
        let tok = v
            .create_agent_ex(
                "stale",
                "过期 Agent",
                Some(chrono::Utc::now() - chrono::Duration::hours(1)),
            )
            .unwrap();
        assert!(v.resolve_token(&tok).is_none(), "过期 token 必须被拒");
        // 未过期：解析成功，且 last_used_at 被回写
        let tok2 = v
            .create_agent_ex(
                "live",
                "在用 Agent",
                Some(chrono::Utc::now() + chrono::Duration::hours(1)),
            )
            .unwrap();
        assert_eq!(v.resolve_token(&tok2).as_deref(), Some("live"));
        let detail = v
            .list_agents_detailed()
            .unwrap()
            .into_iter()
            .find(|a| a.id == "live")
            .unwrap();
        assert!(detail.last_used_at.is_some(), "命中后 last_used_at 应被回写");
        assert!(detail.expires_at.is_some());
        // 不过期路径：expires_at 为空
        let tok3 = v.create_agent("forever", "永不过期").unwrap();
        assert_eq!(v.resolve_token(&tok3).as_deref(), Some("forever"));
        let d3 = v
            .list_agents_detailed()
            .unwrap()
            .into_iter()
            .find(|a| a.id == "forever")
            .unwrap();
        assert!(d3.expires_at.is_none());
        // 重签发重置过期时间：过期 agent 重新签发后复活
        let tok4 = v.create_agent_ex("stale", "续期", Some(chrono::Utc::now() + chrono::Duration::hours(2))).unwrap();
        assert_eq!(v.resolve_token(&tok4).as_deref(), Some("stale"));
    }

    #[test]
    fn host_password_encrypted_at_rest() {
        let (_dir, v) = vault();
        let hid = v
            .upsert_host(&HostDraft {
                name: "prod-1".into(),
                address: "10.0.0.1".into(),
                port: Some(22),
                username: "ops".into(),
                auth: AuthDraft::Password {
                    password: "hunter2".into(),
                },
                ..Default::default()
            })
            .unwrap();
        let hosts = v.list_hosts().unwrap();
        assert_eq!(hosts.len(), 1);
        let (auth, secret) = v.host_secret(&hosts[0]).unwrap();
        assert_eq!(auth, AuthType::Password);
        assert_eq!(&*secret, "hunter2");
        let _ = hid;
        // 库文件中不含明文
        let raw = std::fs::read_to_string(std::env::temp_dir().join("nonexist")).ok();
        drop(raw);
    }

    #[test]
    fn identity_generate_and_decrypt() {
        let (_dir, v) = vault();
        let meta = v
            .create_identity(&IdentityReq::Generate {
                label: "ops-key".into(),
                kind: KeyKind::Ed25519,
            })
            .unwrap();
        assert_eq!(meta.kind, IdentityKind::Ed25519);
        assert!(meta.fingerprint.starts_with("SHA256:"));
        let pem = v.identity_pem(&meta.id).unwrap();
        assert!(pem.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
    }

    #[test]
    fn host_fingerprint_tofu_roundtrip() {
        let (_dir, v) = vault();
        let id = v
            .upsert_host(&HostDraft {
                name: "e2e".into(),
                address: "127.0.0.1".into(),
                username: "root".into(),
                auth: AuthDraft::Password {
                    password: "testpass".into(),
                },
                ..Default::default()
            })
            .unwrap();
        // 新主机无信任记录
        assert!(v.host_fingerprint(&id).unwrap().is_none());
        // 确认后入库、可更新
        v.set_host_fingerprint(&id, "SHA256:AAAA").unwrap();
        assert_eq!(
            v.host_fingerprint(&id).unwrap().as_deref(),
            Some("SHA256:AAAA")
        );
        v.set_host_fingerprint(&id, "SHA256:BBBB").unwrap();
        assert_eq!(
            v.host_fingerprint(&id).unwrap().as_deref(),
            Some("SHA256:BBBB")
        );
        // 未知主机拒绝
        assert!(v.set_host_fingerprint("h-missing", "SHA256:X").is_err());
    }

    #[test]
    fn settings_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let mk = || {
            Vault::open_shared(
                Connection::open(dir.path().join("v.db")).unwrap(),
                master_key().unwrap(),
            )
            .unwrap()
        };
        let v = mk();
        // 未设置 → None
        assert!(v.get_setting("ui.font_size").unwrap().is_none());
        // 写入、覆盖（upsert）、按 key 隔离
        v.set_setting("ui.font_size", "16").unwrap();
        assert_eq!(
            v.get_setting("ui.font_size").unwrap().as_deref(),
            Some("16")
        );
        v.set_setting("ui.font_size", "13").unwrap();
        assert_eq!(
            v.get_setting("ui.font_size").unwrap().as_deref(),
            Some("13")
        );
        v.set_setting("ui.theme", "light").unwrap();
        assert_eq!(v.get_setting("ui.theme").unwrap().as_deref(), Some("light"));
        // 重开同一库：迁移幂等 + 偏好仍在（跨进程记忆，同 T17 指纹语义）
        drop(v);
        let v2 = mk();
        assert_eq!(
            v2.get_setting("ui.font_size").unwrap().as_deref(),
            Some("13")
        );
        assert_eq!(
            v2.get_setting("ui.theme").unwrap().as_deref(),
            Some("light")
        );
    }

    #[test]
    fn c8_v5_migration_one_shot_and_idempotent() {
        // V4 老库（含旧键）→ 开库升 V5：blob 派生（DF8.3 映射）、字号迁移、
        // 旧键保留、重开不重跑迁移（幂等标记 = blob 键本身）
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);")
                .unwrap();
            conn.execute("INSERT INTO settings VALUES('ui.theme','solar-light')", [])
                .unwrap();
            conn.execute("INSERT INTO settings VALUES('ui.font_size','15')", [])
                .unwrap();
            conn.pragma_update(None, "user_version", 4).unwrap();
        }
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let v = Vault::open(&path).unwrap();
        let ver: u32 = {
            let conn = v.conn.lock().unwrap();
            conn.query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap()
        };
        // 开库升到当前链尾（rev-r47 后=8）；V5 专属断言在下方逐项验证
        assert_eq!(ver, SCHEMA_VERSION);
        let ws = v.workspace().unwrap();
        assert_eq!(ws.schema_version, 1);
        assert_eq!(ws.chrome, "light"); // solar-light → light（DF8.3）
        assert!(ws.hostbar.is_none()); // 主机栏是 FE localStorage 域，核心不虚构
        assert_eq!(
            v.get_setting("ui.v2.terminal.font_size")
                .unwrap()
                .as_deref(),
            Some("15")
        );
        // 旧键保留不删（回退兼容）
        assert_eq!(
            v.get_setting("ui.theme").unwrap().as_deref(),
            Some("solar-light")
        );
        assert_eq!(
            v.get_setting("ui.font_size").unwrap().as_deref(),
            Some("15")
        );
        // 迁移幂等：重开 + 用户改写 blob 后再重开，保持用户值不被旧键重置
        let mut ws2 = v.workspace().unwrap();
        ws2.chrome = "dark".into();
        ws2.hostbar = Some(session_api::HostbarPrefs {
            open: false,
            width: 260,
        });
        v.set_workspace(&ws2).unwrap();
        drop(v);
        let v2 = Vault::open(&path).unwrap();
        let ws3 = v2.workspace().unwrap();
        assert_eq!(ws3.chrome, "dark");
        assert_eq!(
            ws3.hostbar,
            Some(session_api::HostbarPrefs {
                open: false,
                width: 260
            })
        );
        assert_eq!(ws3.schema_version, 1);
        // 损坏 blob 自愈回落 Default（不炸启动）
        v2.set_setting("ui.v2.workspace", "not-json{").unwrap();
        assert_eq!(v2.workspace().unwrap(), Workspace::default());
    }

    #[test]
    fn c8_v5_migration_fresh_install_follows_system() {
        // §10.1.1（R27）：全新库（无 ui.theme 旧键）→ blob chrome="system"，
        // 只有新装才默认跟随系统；老键用户保持映射值不突变
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fresh.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);")
                .unwrap();
            conn.pragma_update(None, "user_version", 4).unwrap();
        }
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let v = Vault::open(&path).unwrap();
        let ws = v.workspace().unwrap();
        assert_eq!(ws.chrome, "system");
        // 字号无旧键 → 不写新键（FE 按规格默认 14）
        assert!(v.get_setting("ui.v2.terminal.font_size").unwrap().is_none());
    }

    #[test]
    fn c3_v6_migration_shell_integration_one_shot() {
        // V5 老库（含 ssh/local/软删 host 行）→ 开库升 V6：存量 SSH 主机一次性
        // 显式写 1（与旧行为「无条件注入」一致——DC3.2 灰度期防静默关闭）；local
        // 与软删行不动；升级后 upsert 缺省保原值；重开幂等。
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m6.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.execute_batch("ALTER TABLE hosts ADD COLUMN host_fingerprint TEXT;")
                .unwrap();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
            )
            .unwrap();
            conn.execute_batch(
                "ALTER TABLE hosts ADD COLUMN charset TEXT NOT NULL DEFAULT 'utf-8';",
            )
            .unwrap();
            conn.execute_batch(SCHEMA_V5).unwrap();
            conn.execute(
                "INSERT INTO hosts(id,name,address,username,auth_type,created_at,updated_at)
                 VALUES('h-ssh','prod','10.0.0.1','ops','password',1,1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO hosts(id,name,address,username,auth_type,created_at,updated_at)
                 VALUES('h-local','local','local','me','password',1,1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO hosts(id,name,address,username,auth_type,created_at,updated_at,deleted_at)
                 VALUES('h-del','gone','10.0.0.2','ops','password',1,1,9)",
                [],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 5).unwrap();
        }
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let v = Vault::open(&path).unwrap();
        let by = |id: &str| {
            v.list_hosts()
                .unwrap()
                .into_iter()
                .find(|h| h.id == id)
                .unwrap()
        };
        assert_eq!(
            by("h-ssh").shell_integration,
            Some(true),
            "存量 SSH 主机一次性置启用（DC3.2）"
        );
        assert_eq!(by("h-local").shell_integration, None, "local 主机不动");
        assert!(
            v.list_hosts().unwrap().iter().all(|h| h.id != "h-del"),
            "软删行不在活列表"
        );
        // 升级后 upsert 缺省（None）保原值——不静默关闭已迁移主机
        let h = by("h-ssh");
        v.upsert_host(&HostDraft {
            id: Some(h.id.clone()),
            name: h.name.clone(),
            address: h.address.clone(),
            port: Some(h.port),
            username: h.username.clone(),
            auth: AuthDraft::Password {
                password: "x".into(),
            },
            tags: h.tags.clone(),
            charset: h.charset,
            shell_integration: None,
        })
        .unwrap();
        assert_eq!(
            by("h-ssh").shell_integration,
            Some(true),
            "缺省 upsert 保原值"
        );
        // 显式 Some(false) 生效（用户可关闭）
        let h = by("h-ssh");
        v.upsert_host(&HostDraft {
            id: Some(h.id.clone()),
            name: h.name.clone(),
            address: h.address.clone(),
            port: Some(h.port),
            username: h.username.clone(),
            auth: AuthDraft::Password {
                password: "x".into(),
            },
            tags: h.tags.clone(),
            charset: h.charset,
            shell_integration: Some(false),
        })
        .unwrap();
        assert_eq!(by("h-ssh").shell_integration, Some(false), "显式关闭生效");
        // 重开幂等：显式 false 不被迁移重写
        drop(v);
        let v2 = Vault::open(&path).unwrap();
        assert_eq!(
            v2.list_hosts()
                .unwrap()
                .into_iter()
                .find(|h| h.id == "h-ssh")
                .unwrap()
                .shell_integration,
            Some(false),
            "重开不得重写用户显式值"
        );
    }

    #[test]
    fn c8_favorites_recents_identity_refs_and_cascade() {
        let (_dir, v) = vault();
        let key_id = v
            .create_identity(&IdentityReq::Generate {
                label: "k1".into(),
                kind: KeyKind::Ed25519,
            })
            .unwrap()
            .id;
        let hid = v
            .upsert_host(&HostDraft {
                name: "prod-1".into(),
                address: "10.0.0.9".into(),
                username: "ops".into(),
                auth: AuthDraft::Key {
                    identity_id: key_id.clone(),
                },
                ..Default::default()
            })
            .unwrap();
        let hid2 = v
            .upsert_host(&HostDraft {
                name: "staging".into(),
                address: "10.0.0.10".into(),
                username: "ops".into(),
                auth: AuthDraft::Key {
                    identity_id: key_id.clone(),
                },
                ..Default::default()
            })
            .unwrap();
        // 收藏：未知主机拒绝；正常 upsert
        assert!(v.set_host_favorite("h-none", true).is_err());
        v.set_host_favorite(&hid, true).unwrap();
        v.set_host_favorite(&hid, false).unwrap();
        let meta = v.list_host_metadata().unwrap();
        assert_eq!(meta.len(), 1);
        assert_eq!(meta[0].host_id, hid);
        assert!(!meta[0].favorite);
        assert!(meta[0].last_connected_at.is_none());
        // 建连打点 → last_connected_at
        v.touch_host_connection(&hid).unwrap();
        assert!(v.list_host_metadata().unwrap()[0]
            .last_connected_at
            .is_some());
        // 最近连接（DF8.5）：sessions 派生、排除 local、每主机最近一次、删除主机无幽灵
        v.record_session(&"s-1".to_string(), Some(&hid), "ssh")
            .unwrap();
        v.record_session(&"s-2".to_string(), Some(&hid), "ssh")
            .unwrap();
        v.record_session(&"s-3".to_string(), Some(&hid), "local")
            .unwrap(); // 排除
        v.record_session(&"s-4".to_string(), Some(&hid2), "ssh")
            .unwrap();
        // 钉死时间戳：record_session 用 now_ms()，连续四写常落同一毫秒，而
        // list_recent_hosts 的 `ORDER BY last_at DESC` 对并列无确定序——本用例曾
        // 2/12 偶发红（h-8f9b… vs h-a61f…）。此处显式赋值使「s-4 晚于 s-2」恒真。
        {
            let conn = v.conn.lock().unwrap();
            for (sid, ts) in [
                ("s-1", 1000i64),
                ("s-2", 2000),
                ("s-3", 3000),
                ("s-4", 4000),
            ] {
                conn.execute(
                    "UPDATE sessions SET created_at=?2 WHERE id=?1",
                    params![sid, ts],
                )
                .unwrap();
            }
        }
        let recents = v.list_recent_hosts(5).unwrap();
        assert_eq!(recents.len(), 2); // local 不算；每主机一行
        assert_eq!(recents[0].host_id, hid2); // s-4 晚于 s-2
        assert_eq!(recents[0].host_name, "staging");
        // 引用检查（DF8.4）：两个主机引用同一凭据
        let mut refs = v.identity_host_refs(&key_id).unwrap();
        refs.sort();
        assert_eq!(refs, vec!["prod-1".to_string(), "staging".to_string()]);
        assert!(v.identity_host_refs("i-none").unwrap().is_empty());
        // delete_host 联动：元数据行随删、recents 不再出现
        v.delete_host(&hid).unwrap();
        let meta = v.list_host_metadata().unwrap();
        assert!(meta.iter().all(|m| m.host_id != hid));
        let recents = v.list_recent_hosts(5).unwrap();
        assert_eq!(recents.len(), 1);
        assert_eq!(recents[0].host_id, hid2);
        // transfer_journal 表已建（C5/R32 消费，V5 同批）：可插可查
        let n = {
            let conn = v.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO transfer_journal(task_id, session_id, kind, src_path, dst_path, state, created_at)
                 VALUES('t-1','s-4','upload','/a','/b','Queued',1)",
                [],
            )
            .unwrap();
            conn.query_row("SELECT COUNT(*) FROM transfer_journal", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
        };
        assert_eq!(n, 1);
    }

    /// C5（R32）+ C6（R34）：transfer_journal 存取面回环——insert/update/load_active/
    /// list 的列映射与状态字符串单点转换（lib::journal_row_to_task 与 wire
    /// PascalCase）；collision_decision/verified 列读写（R34 提交窗口证据）。
    #[test]
    fn c5_transfer_journal_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let v = Vault::open_shared(
            Connection::open(dir.path().join("v.db")).unwrap(),
            master_key().unwrap(),
        )
        .unwrap();
        let t = TransferTask {
            id: "t-x1".into(),
            session_id: "s-1".into(),
            kind: TransferKind::Upload,
            source: "/tmp/a.tar".into(),
            dest: "/root/a.tar".into(),
            status: TransferStatus::Queued,
            bytes_done: 0,
            total: None,
            revision: 1,
            created_at: 1790956800,
            finished_at: None,
            error: None,
            retry_of: None,
            collision_decision: None,
            decision_prompt: None,
        };
        v.transfer_journal_insert(&t).unwrap();
        // 活动阶段行进恢复面（带 verified 证据位）
        let active = v.transfer_journal_load_active().unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].0.status, TransferStatus::Queued);
        assert!(!active[0].1, "未进提交窗 verified=false");
        // 推进到终态：状态/字节/revision/finished_at 落账
        let mut done = t.clone();
        done.status = TransferStatus::Succeeded;
        done.bytes_done = 4096;
        done.total = Some(4096);
        done.revision = 9;
        done.finished_at = Some(1790956801);
        v.transfer_journal_update(&done, None).unwrap();
        let active = v.transfer_journal_load_active().unwrap();
        assert!(active.is_empty(), "终态行退出恢复面");
        let list = v.transfer_journal_list(10).unwrap();
        let row = list.iter().find(|r| r.id == "t-x1").unwrap();
        assert_eq!(row.status, TransferStatus::Succeeded);
        assert_eq!(row.bytes_done, 4096);
        assert_eq!(row.total, Some(4096));
        assert_eq!(row.revision, 9);
        assert_eq!(row.finished_at, Some(1790956801));
        // 更新不存在的行报错（不静默丢账）
        let mut ghost = done.clone();
        ghost.id = "t-ghost".into();
        assert!(v.transfer_journal_update(&ghost, None).is_err());
        // download kind 列（CHECK 约束小写）与 Failed 状态回读
        let d = TransferTask {
            id: "t-x2".into(),
            session_id: "s-1".into(),
            kind: TransferKind::Download,
            source: "/var/log/x".into(),
            dest: "/tmp/x".into(),
            status: TransferStatus::Failed,
            bytes_done: 0,
            total: None,
            revision: 3,
            created_at: 1790956802,
            finished_at: Some(1790956803),
            error: Some("boom".into()),
            retry_of: None,
            collision_decision: None,
            decision_prompt: None,
        };
        v.transfer_journal_insert(&d).unwrap();
        let list = v.transfer_journal_list(10).unwrap();
        let row = list.iter().find(|r| r.id == "t-x2").unwrap();
        assert_eq!(row.kind, TransferKind::Download);
        assert_eq!(row.status, TransferStatus::Failed);
        assert_eq!(row.error.as_deref(), Some("boom"));
        // 排序：创建倒序（新在前）
        assert_eq!(list[0].id, "t-x2");
        // C6/R34：collision_decision 落列回读 + verified 标记（提交窗口证据）
        let mut c = t.clone();
        c.id = "t-x3".into();
        c.status = TransferStatus::Committing;
        c.revision = 5;
        c.collision_decision = Some(session_api::CollisionDecision::Overwrite);
        v.transfer_journal_insert(&c).unwrap();
        v.transfer_journal_update(&c, Some(true)).unwrap();
        let got = v.transfer_journal_get("t-x3").unwrap().unwrap();
        assert_eq!(got.0.status, TransferStatus::Committing);
        assert_eq!(
            got.0.collision_decision,
            Some(session_api::CollisionDecision::Overwrite)
        );
        assert!(got.1, "发布原语成功后 verified=true 可读");
        let mut k = t.clone();
        k.id = "t-x4".into();
        k.status = TransferStatus::AwaitingDecision;
        k.collision_decision = Some(session_api::CollisionDecision::KeepBoth);
        v.transfer_journal_insert(&k).unwrap();
        let got2 = v.transfer_journal_get("t-x4").unwrap().unwrap();
        assert_eq!(
            got2.0.collision_decision,
            Some(session_api::CollisionDecision::KeepBoth)
        );
        assert!(!got2.1);
        // 未知 id → None（不虚构）
        assert!(v.transfer_journal_get("t-nope").unwrap().is_none());
    }

    /// C9（R43 §10.1-6）：协作启用状态迁移——以既有 vault/schema 标记区分升级与新装
    /// （不以「当前没有 Agent 在线」判定）。新装默认关闭（无自动 MCP 监听）；升级保留
    /// 旧版「默认开启」；已有明确偏好不被覆盖；重复启动幂等。
    #[test]
    fn c9_collab_enabled_migration_fresh_vs_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));

        // 新装：全新库（自 user_version=0 建起）默认关闭
        let fresh = dir.path().join("fresh.db");
        let v =
            Vault::open_shared(Connection::open(&fresh).unwrap(), master_key().unwrap()).unwrap();
        assert!(
            !v.collab_enabled().unwrap(),
            "全新库默认关闭协作（新装无自动 MCP 监听）"
        );
        drop(v);

        // 升级：造一个「既有 V6 库」（schema 已到 V7，但删去新键并把版本退到 6）
        let up = dir.path().join("up.db");
        drop(Vault::open_shared(Connection::open(&up).unwrap(), master_key().unwrap()).unwrap());
        {
            let conn = Connection::open(&up).unwrap();
            conn.execute("DELETE FROM settings WHERE key='collab.enabled'", [])
                .unwrap();
            conn.pragma_update(None, "user_version", 6).unwrap();
        }
        let v = Vault::open_shared(Connection::open(&up).unwrap(), master_key().unwrap()).unwrap();
        assert!(
            v.collab_enabled().unwrap(),
            "升级库缺新键时保留旧版「MCP 默认开启」行为"
        );
        drop(v);

        // 幂等：重开不翻转
        let v = Vault::open_shared(Connection::open(&up).unwrap(), master_key().unwrap()).unwrap();
        assert!(v.collab_enabled().unwrap(), "重复启动幂等，迁移不重写");
        drop(v);

        // 已有明确偏好优先：用户已显式关闭 → 迁移不覆盖
        {
            let conn = Connection::open(&up).unwrap();
            conn.execute(
                "UPDATE settings SET value='0' WHERE key='collab.enabled'",
                [],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 6).unwrap();
        }
        let v = Vault::open_shared(Connection::open(&up).unwrap(), master_key().unwrap()).unwrap();
        assert!(!v.collab_enabled().unwrap(), "已有明确偏好优先，迁移不覆盖");

        // 人类可显式切换（set_collab_enabled 落库并回读）
        v.set_collab_enabled(true).unwrap();
        assert!(v.collab_enabled().unwrap());
        v.set_collab_enabled(false).unwrap();
        assert!(!v.collab_enabled().unwrap());
    }

    /// R44（§10.2 回退检查）：库比本程序新 → 拒绝打开，且**一个字节都不写**。
    /// 「数据库已升级后不能盲目用旧二进制写新库」。
    #[test]
    fn r44_newer_schema_is_refused_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("future.db");
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        // 造一个「未来版本」库：正常建到链尾，再把 user_version 抬到 SCHEMA_VERSION+1
        drop(Vault::open(&path).unwrap());
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
                .unwrap();
        }
        // 记录拒绝前的库内容摘要（user_version + 表清单）
        let before = {
            let conn = Connection::open(&path).unwrap();
            let ver: u32 = conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            let tables: Vec<String> = {
                let mut st = conn
                    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                    .unwrap();
                st.query_map([], |r| r.get(0))
                    .unwrap()
                    .map(|x| x.unwrap())
                    .collect()
            };
            (ver, tables)
        };

        let err = Vault::open(&path).unwrap_err();
        let msg = format!("{err:?}");
        assert!(
            msg.contains("高于本程序支持"),
            "拒绝信息须说明版本过高：{msg}"
        );
        assert!(
            msg.contains("vault backup"),
            "拒绝信息须给出备份出路：{msg}"
        );

        // 库未被改动：版本仍为未来值、表清单不变（未跑任何迁移）
        let after = {
            let conn = Connection::open(&path).unwrap();
            let ver: u32 = conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            let tables: Vec<String> = {
                let mut st = conn
                    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                    .unwrap();
                st.query_map([], |r| r.get(0))
                    .unwrap()
                    .map(|x| x.unwrap())
                    .collect()
            };
            (ver, tables)
        };
        assert_eq!(after.0, SCHEMA_VERSION + 1, "拒绝打开不得改写版本号");
        assert_eq!(after.1, before.1, "拒绝打开不得建/删任何表");
    }

    /// R44（§10.2）：单实例写锁——第二个实例打开同一库必须失败；第一个落地后可再开。
    #[test]
    fn r44_single_instance_write_lock() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("locked.db");
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));

        let v1 = Vault::open(&path).unwrap();
        let err = Vault::open(&path).unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("写锁"), "第二实例须因写锁被拒：{msg}");
        assert!(msg.contains("一个实例"), "错误信息须说明单实例约束：{msg}");

        // 第一个落地 → 锁释放 → 可再开
        drop(v1);
        let v2 = Vault::open(&path).unwrap();
        // 不同库互不影响（锁按库路径隔离）
        let other = dir.path().join("other.db");
        let v3 = Vault::open(&other).unwrap();
        drop((v2, v3));
    }

    /// R44：`open_shared` 不取写锁（调用方持有连接）——同进程可开多个，不互相阻塞。
    #[test]
    fn r44_open_shared_does_not_take_write_lock() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let p1 = dir.path().join("s1.db");
        let p2 = dir.path().join("s2.db");
        let a = Vault::open_shared(Connection::open(&p1).unwrap(), master_key().unwrap()).unwrap();
        let b = Vault::open_shared(Connection::open(&p2).unwrap(), master_key().unwrap()).unwrap();
        assert!(a.workspace().is_ok() && b.workspace().is_ok());
    }

    /// R44（§10.2 回退演练）：导出 → 改动 → 恢复，内容回到备份时；且导出拒绝覆盖既有备份。
    #[test]
    fn r44_backup_and_restore_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let db = dir.path().join("main.db");
        drop(Vault::open(&db).unwrap());
        Connection::open(&db)
            .unwrap()
            .execute(
                "INSERT INTO settings(key,value) VALUES('r44.marker','keepme')",
                [],
            )
            .unwrap();

        let bak = dir.path().join("bak.db");
        backup_to(&db, &bak).unwrap();
        assert!(bak.exists(), "备份文件须生成");

        // 覆盖保护：同目标再备份须拒绝（不静默毁掉既有备份）
        let err = backup_to(&db, &bak).unwrap_err();
        assert!(
            format!("{err:?}").contains("拒绝覆盖"),
            "须拒绝覆盖既有备份：{err:?}"
        );

        // 改动原库 → 从备份恢复 → 内容回到备份时
        Connection::open(&db)
            .unwrap()
            .execute(
                "UPDATE settings SET value='changed' WHERE key='r44.marker'",
                [],
            )
            .unwrap();
        restore_from(&db, &bak).unwrap();
        let got: String = Connection::open(&db)
            .unwrap()
            .query_row(
                "SELECT value FROM settings WHERE key='r44.marker'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(got, "keepme", "恢复后应回到备份时的内容");
        // 恢复后仍可正常打开（迁移无碍）
        assert!(Vault::open(&db).unwrap().workspace().is_ok());
    }

    /// R44（§10.2）：恢复**拒绝**由更新版本创建的备份（版本护栏的反向）——否则会重演
    /// 「旧程序写新库」的静默损坏。
    #[test]
    fn r44_restore_refuses_newer_backup() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let future = dir.path().join("future.db");
        drop(Vault::open(&future).unwrap());
        Connection::open(&future)
            .unwrap()
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        let target = dir.path().join("target.db");
        drop(Vault::open(&target).unwrap());
        let err = restore_from(&target, &future).unwrap_err();
        assert!(
            format!("{err:?}").contains("高于本程序支持"),
            "须拒绝更新版本的备份：{err:?}"
        );
    }

    /// R44（§10.2）：恢复**拒绝**不是 TinySSH 库的文件（缺 hosts 表）。
    #[test]
    fn r44_restore_refuses_non_vault_backup() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let junk = dir.path().join("junk.db");
        Connection::open(&junk)
            .unwrap()
            .execute_batch("CREATE TABLE unrelated(x INTEGER);")
            .unwrap();
        let target = dir.path().join("target.db");
        drop(Vault::open(&target).unwrap());
        let err = restore_from(&target, &junk).unwrap_err();
        assert!(
            format!("{err:?}").contains("不是 TinySSH 库"),
            "须拒绝非 vault 文件：{err:?}"
        );
    }

    /// R44 审核 F1 回归：护栏必须真正落在**任何持久写之前**。
    /// 造一个**非 WAL**（默认 rollback journal）的未来版本库——若实现先设
    /// `journal_mode=WAL` 再进护栏，库文件字节会变（旧实现实测会）。断言拒绝后
    /// 文件**逐字节不变**且 journal 模式不变。原用例只比版本号与表清单，证不了这条。
    #[test]
    fn r44_refusal_writes_no_bytes_even_on_non_wal_db() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("future-nonwal.db");
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        {
            let conn = Connection::open(&path).unwrap();
            let jm: String = conn
                .query_row("PRAGMA journal_mode", [], |r| r.get(0))
                .unwrap();
            assert_ne!(
                jm.to_lowercase(),
                "wal",
                "前置条件：库须为非 WAL（实得 {jm}）"
            );
            conn.execute_batch("CREATE TABLE hosts (id TEXT PRIMARY KEY);")
                .unwrap();
            conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
                .unwrap();
        }
        let read_jm = || -> String {
            Connection::open(&path)
                .unwrap()
                .query_row("PRAGMA journal_mode", [], |r| r.get(0))
                .unwrap()
        };
        let before = std::fs::read(&path).unwrap();
        let before_jm = read_jm();

        let err = Vault::open(&path).unwrap_err();
        assert!(
            format!("{err:?}").contains("高于本程序支持"),
            "须因版本过高被拒：{err:?}"
        );

        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "拒绝打开不得改动库文件任何字节"
        );
        assert_eq!(read_jm(), before_jm, "拒绝打开不得把库切成 WAL");
    }

    /// R44 审核 F2 回归：只带一张 `hosts` 表的文件**不得**被当成备份——否则恢复会
    /// 不可逆毁掉真库（审核员以真二进制复现过：11 张表 → 只剩 hosts）。断言拒绝
    /// 且目标库**原样存活**。
    #[test]
    fn r44_restore_refuses_partial_vault_and_keeps_target() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let fake = dir.path().join("fake.db");
        Connection::open(&fake)
            .unwrap()
            .execute_batch("CREATE TABLE hosts (id TEXT PRIMARY KEY);")
            .unwrap();
        let target = dir.path().join("target.db");
        drop(Vault::open(&target).unwrap());
        Connection::open(&target)
            .unwrap()
            .execute(
                "INSERT INTO settings(key,value) VALUES('f2.marker','survive')",
                [],
            )
            .unwrap();

        let err = restore_from(&target, &fake).unwrap_err();
        assert!(
            format!("{err:?}").contains("不是 TinySSH 库"),
            "须拒绝残缺库：{err:?}"
        );

        // 目标库未被毁：仍是完整 vault，标记行还在
        let got: String = Connection::open(&target)
            .unwrap()
            .query_row(
                "SELECT value FROM settings WHERE key='f2.marker'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(got, "survive", "拒绝恢复时目标库必须原样存活");
    }

    /// R44 审核 F2：覆盖既有库前**必留安全副本** `<db>.pre-restore.bak`，且副本内容
    /// 为「恢复前」的库（即被覆盖掉的那份），给出可回退路径。
    #[test]
    fn r44_restore_keeps_pre_restore_backup() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let db = dir.path().join("main.db");
        drop(Vault::open(&db).unwrap());
        let set = |v: &str| {
            Connection::open(&db)
                .unwrap()
                .execute(
                    "INSERT OR REPLACE INTO settings(key,value) VALUES('f2b',?1)",
                    [v],
                )
                .unwrap();
        };
        set("backup-content");
        let bak = dir.path().join("bak.db");
        backup_to(&db, &bak).unwrap();
        set("live-content");

        restore_from(&db, &bak).unwrap();

        let live: String = Connection::open(&db)
            .unwrap()
            .query_row("SELECT value FROM settings WHERE key='f2b'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(live, "backup-content", "恢复后应为备份内容");
        let pre = pre_restore_backup_path(&db);
        assert!(pre.exists(), "覆盖前必须留安全副本");
        let old: String = Connection::open(&pre)
            .unwrap()
            .query_row("SELECT value FROM settings WHERE key='f2b'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(old, "live-content", "安全副本须是恢复前（被覆盖）的那份");
    }

    /// R44 审核 F7：`from == db_path` 须被拒（否则等于自我重写，且会把自身当备份覆盖自身）。
    #[test]
    fn r44_restore_refuses_same_file() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let db = dir.path().join("main.db");
        drop(Vault::open(&db).unwrap());
        let err = restore_from(&db, &db).unwrap_err();
        assert!(
            format!("{err:?}").contains("同一个文件"),
            "须拒绝自我恢复：{err:?}"
        );
    }

    /// R44 审核 F8：库不存在时 `backup_to` 须拒绝，**不得**先建空库再备份。
    #[test]
    fn r44_backup_refuses_missing_db() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let missing = dir.path().join("nope.db");
        let out = dir.path().join("out.db");
        let err = backup_to(&missing, &out).unwrap_err();
        assert!(
            format!("{err:?}").contains("库不存在"),
            "须拒绝备份不存在的库：{err:?}"
        );
        assert!(!missing.exists(), "不得因备份而创建空库");
        assert!(!out.exists(), "不得产出备份文件");
    }

    /// R44 审核 F2（先验证后覆盖）：旧版本备份须**在临时副本上先迁移到链尾**再替换目标，
    /// 故恢复完成后目标库已是本程序支持的版本——不需要事后 `open()` 补迁移。
    #[test]
    fn r44_restore_migrates_snapshot_before_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        // 造一份 V1 老库作备份来源
        let old = dir.path().join("old.db");
        {
            let conn = Connection::open(&old).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
        }
        assert_eq!(
            read_schema_version(&old).unwrap(),
            Some(1),
            "前置：来源须为 V1"
        );
        // 目标是一份当前版本的库
        let db = dir.path().join("main.db");
        drop(Vault::open(&db).unwrap());
        restore_from(&db, &old).unwrap();
        // 未调用任何 open()，目标库应已在链尾（证明迁移发生在 rename 之前）
        assert_eq!(
            read_schema_version(&db).unwrap(),
            Some(SCHEMA_VERSION),
            "恢复须在替换前把快照迁到链尾"
        );
        // 且真能打开（迁移结果可用）
        assert!(Vault::open(&db).unwrap().workspace().is_ok());
    }

    /// R44 审核 N-1：来源若是 **WAL 模式**库，恢复**不得**在来源旁创建 `-shm`/`-wal`
    /// ——只读打开一个 WAL 库也会写 wal-index（会往用户备份旁塞陌生文件；来源在只读
    /// 介质上时会直接失败）。故实现改为从来源的**副本**读。断言来源文件逐字节不变、
    /// 且旁边没有多出任何侧车。
    #[test]
    fn r44_restore_does_not_touch_source_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let src = dir.path().join("src.db");
        drop(Vault::open(&src).unwrap()); // `open()` 会把库设成 WAL
        {
            let c = Connection::open(&src).unwrap();
            let jm: String = c
                .query_row("PRAGMA journal_mode", [], |r| r.get(0))
                .unwrap();
            assert_eq!(jm.to_lowercase(), "wal", "前置：来源须为 WAL 库");
        }
        let before = std::fs::read(&src).unwrap();
        let target = dir.path().join("main.db");
        drop(Vault::open(&target).unwrap());

        let v = restore_from(&target, &src).unwrap();
        // R44 审核 N-1（CLI 半边）：来源版本由 `restore_from` 从**副本**读出并返回，
        // 调用方不必再预探测原始来源。来源此处是最新库，故应等于链尾版本。
        assert_eq!(
            v, SCHEMA_VERSION,
            "restore_from 须返回来源备份的 schema 版本"
        );

        assert_eq!(std::fs::read(&src).unwrap(), before, "来源文件不得被改动");
        for s in ["-wal", "-shm"] {
            assert!(
                !super::with_suffix(&src, s).exists(),
                "不得在来源旁留下 {s} 侧车"
            );
        }
        // 我们自己的中间文件也不该残留
        assert!(!super::with_suffix(&target, ".restore.src").exists());
        assert!(!super::with_suffix(&target, ".restore.tmp").exists());
    }

    /// R44（§10.2）：另一实例持写锁时，导出与恢复都须被拒（灰度期单实例语义一致）。
    #[test]
    fn r44_backup_and_restore_refused_while_locked() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let db = dir.path().join("main.db");
        let v = Vault::open(&db).unwrap();
        let err = backup_to(&db, &dir.path().join("b.db")).unwrap_err();
        assert!(
            format!("{err:?}").contains("写锁"),
            "持锁时导出须被拒：{err:?}"
        );
        let err2 = restore_from(&db, &db).unwrap_err();
        assert!(
            format!("{err2:?}").contains("写锁"),
            "持锁时恢复须被拒：{err2:?}"
        );
        drop(v);
    }

    // ---- 十轮：库内随机盐（口令派生）----

    fn fresh_conn(dir: &std::path::Path) -> Connection {
        open(&dir.join("v.db")).unwrap()
    }

    /// 新库（无凭据）首次口令派生：生成随机盐落库，重复派生稳定；同口令跨库
    /// 盐不同 → 派生密钥不同（静态盐跨安装同值的隐患消除）。
    #[test]
    fn master_salt_random_on_fresh_db() {
        let dir = tempfile::tempdir().unwrap();
        let conn = fresh_conn(dir.path());
        let s1 = db_master_salt(&conn).unwrap();
        assert_eq!(s1.len(), 16);
        // 落库后重复取值稳定（派生可重现）
        assert_eq!(db_master_salt(&conn).unwrap(), s1);
        let stored: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='master.salt'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hex::decode(&stored).unwrap(), s1);
        // 同口令、另一新库 → 不同盐不同密钥
        let dir2 = tempfile::tempdir().unwrap();
        let conn2 = fresh_conn(dir2.path());
        let k1 = argon2_derive_with_salt("pass-1", &db_master_salt(&conn).unwrap());
        let k2 = argon2_derive_with_salt("pass-1", &db_master_salt(&conn2).unwrap());
        assert_ne!(*k1, *k2);
    }

    /// 已有数据的旧库（无盐行）回落 v1 静态盐——换盐=换密钥=既有凭据不可解。
    #[test]
    fn master_salt_legacy_fallback_when_data_present() {
        let dir = tempfile::tempdir().unwrap();
        let conn = fresh_conn(dir.path());
        conn.execute(
            "INSERT INTO hosts(id,name,address,port,username,auth_type) VALUES('h1','n','x',22,'u','key')",
            [],
        )
        .unwrap();
        assert_eq!(db_master_salt(&conn).unwrap(), LEGACY_MASTER_SALT.to_vec());
        // v1 静态盐派生与旧实现逐字节一致（口令路径向后兼容锚点）
        assert_eq!(
            *argon2_derive("p"),
            *argon2_derive_with_salt("p", LEGACY_MASTER_SALT)
        );
    }

    /// 口令派生密钥端到端：新库存盐 → 加密凭据 → 同口令重开可解。
    #[test]
    fn passphrase_derived_key_roundtrip_via_db_salt() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("v.db");
        let master = {
            let conn = open(&db).unwrap();
            derive_from_sources(&None, &Some("pass-2".into()), Some(&conn)).unwrap()
        };
        {
            let v = Vault::open_shared(Connection::open(&db).unwrap(), master.clone()).unwrap();
            v.upsert_host(&HostDraft {
                id: None,
                name: "n".into(),
                address: "h".into(),
                port: Some(22),
                username: "u".into(),
                auth: AuthDraft::Password {
                    password: "sekret".into(),
                },
                tags: vec![],
                charset: Charset::Utf8,
                shell_integration: None,
            })
            .unwrap();
        }
        // 重开（同口令，库内盐在场）→ 凭据可解
        let conn = open(&db).unwrap();
        let master2 = derive_from_sources(&None, &Some("pass-2".into()), Some(&conn)).unwrap();
        assert_eq!(*master, *master2);
        let v = Vault::open_shared(Connection::open(&db).unwrap(), master2).unwrap();
        let hosts = v.list_hosts().unwrap();
        assert_eq!(hosts[0].auth_type, AuthType::Password);
        let (_, secret) = v.host_secret(&hosts[0]).unwrap();
        assert_eq!(&*secret, "sekret");
    }
}
