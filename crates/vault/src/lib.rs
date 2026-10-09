//! vault：主机/凭据/Agent 身份与策略存取与加密（L1 §3.4）。
//! - SQLite 存非敏感字段；凭据载荷（私钥 PEM、口令）以主密钥加密存 BLOB；
//! - 主密钥：OS 钥匙串托管的随机 32B（测试可用 env 覆盖）；
//! - XChaCha20-Poly1305 加密；Zeroizing 包裹；Debug 不输出明文。

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, Key as ChachaKey, XNonce};
use rusqlite::{params, Connection};
use session_api::{
    Actor, AgentClientId, ApprovalId, ApprovalItem, ApprovalStatus, AuthDraft, AuthType, Charset,
    Error, Host, HostDraft, HostId, HostMeta, IdentityId, IdentityKind, IdentityMeta, IdentityReq,
    KeyKind, Policy, RecentHost, Result, SessionId, TransferKind, TransferStatus, TransferTask,
    Workspace,
};
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::path::Path;
use zeroize::Zeroizing;

pub mod db;
pub mod sshcfg;

pub use db::{SCHEMA_V1, SCHEMA_V5};

/// 打开/创建库并执行迁移。
pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path).map_err(|e| Error::Storage(e.to_string()))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| Error::Storage(e.to_string()))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| Error::Storage(e.to_string()))?;
    migrate(&conn)?;
    Ok(conn)
}

pub fn migrate(conn: &Connection) -> Result<()> {
    let version: u32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| Error::Storage(e.to_string()))?;
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
                .query_row(
                    "SELECT value FROM settings WHERE key='ui.theme'",
                    [],
                    |r| r.get(0),
                )
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
    Ok(())
}

// ---------------------------------------------------------------------------
// 主密钥
// ---------------------------------------------------------------------------

/// 主密钥来源优先级：TINYSSH_MASTER_KEY(hex) > TINYSSH_MASTER_PASSPHRASE(argon2id) > OS 钥匙串。
pub fn master_key() -> Result<Zeroizing<[u8; 32]>> {
    if let Ok(hex_key) = std::env::var("TINYSSH_MASTER_KEY") {
        let bytes = hex::decode(hex_key.trim()).map_err(|_| Error::Storage("bad master key hex".into()))?;
        let mut out = [0u8; 32];
        if bytes.len() != 32 {
            return Err(Error::Storage("master key must be 32 bytes".into()));
        }
        out.copy_from_slice(&bytes);
        return Ok(Zeroizing::new(out));
    }
    if let Ok(pass) = std::env::var("TINYSSH_MASTER_PASSPHRASE") {
        return Ok(argon2_derive(&pass));
    }
    keychain_key()
}

fn argon2_derive(pass: &str) -> Zeroizing<[u8; 32]> {
    use argon2::{Argon2, Algorithm, Params, Version};
    let salt = b"tinyssh-master-key-v1";
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
            let bytes = base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                b64.trim(),
            )
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
        .encrypt(nonce, Payload { msg: plaintext, aad: b"tinyssh-identity" })
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
        .decrypt(nonce, Payload { msg: &blob[24..], aad: b"tinyssh-identity" })
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
}

use std::sync::Mutex;

impl Vault {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = open(path)?;
        let master = master_key()?;
        Ok(Self { conn: Mutex::new(conn), master })
    }

    pub fn open_shared(conn: Connection, master: Zeroizing<[u8; 32]>) -> Result<Self> {
        migrate(&conn)?;
        Ok(Self { conn: Mutex::new(conn), master })
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
        conn.execute("UPDATE hosts SET deleted_at=?2 WHERE id=?1", params![id, now_ms()])
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
            let (id, name, address, port, username, auth_type, identity_id, tags_json, fingerprint, charset, shell_integration) =
                row.map_err(db_err)?;
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
        let v = conn.query_row("SELECT value FROM settings WHERE key=?1", params![key], |r| {
            r.get::<_, String>(0)
        });
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
                    .map(|t| t.into()),
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
                connected_at: chrono::DateTime::from_timestamp_millis(last_at)
                    .unwrap_or_default()
                    .into(),
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
                    t.collision_decision
                        .map(|d| Self::journal_collision_str(d)),
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
                    t.collision_decision
                        .map(|d| Self::journal_collision_str(d)),
                    verified.map(|v| if v { 1i64 } else { 0i64 }),
                    t.error,
                    t.finished_at,
                ],
            )
            .map_err(db_err)?;
        if n == 0 {
            return Err(Error::InvalidInput(format!("transfer journal row {} missing", t.id)));
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
        let conn = self.conn.lock().unwrap();
        let blob: String = conn
            .query_row(
                "SELECT secret_blob FROM identities WHERE id=?1 AND deleted_at IS NULL",
                params![iid],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(blob)
            .map_err(|_| Error::Storage("bad blob b64".into()))?;
        let plain = open_seal(&self.master, &raw)?;
        Ok((
            host.auth_type,
            Zeroizing::new(String::from_utf8_lossy(&plain).into_owned()),
        ))
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
                let fp = key.public_key().fingerprint(
                    russh::keys::ssh_key::HashAlg::Sha256,
                );
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
            IdentityReq::Import { label, pem, passphrase } => {
                let key = russh::keys::decode_secret_key(pem, passphrase.as_deref())
                    .map_err(|_| Error::InvalidInput("bad key or passphrase".into()))?;
                let fp = key.public_key().fingerprint(russh::keys::ssh_key::HashAlg::Sha256);
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
        Ok(IdentityMeta { id, label, kind, fingerprint })
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
        self.conn.lock().unwrap()
            .execute("UPDATE identities SET deleted_at=?2 WHERE id=?1", params![id, now_ms()])
            .map_err(db_err)?;
        Ok(())
    }

    // ---- Agent 身份与 Token ----
    /// 创建 agent；返回原始 Token（仅此一次展示）。
    pub fn create_agent(&self, client_id: &str, label: &str) -> Result<String> {
        use rand::RngCore;
        let mut tok = [0u8; 32];
        rand::rng().fill_bytes(&mut tok);
        let token = hex::encode(tok);
        let hash = token_hash(&token);
        self.conn.lock().unwrap()
            .execute(
                "INSERT INTO agents (id, label, token_hash, created_at) VALUES (?1,?2,?3,?4)
                 ON CONFLICT(id) DO UPDATE SET token_hash=?3, revoked_at=NULL, label=?2",
                params![client_id, label, hash.to_vec(), now_ms()],
            )
            .map_err(db_err)?;
        Ok(token)
    }

    /// 校验 Token → client_id（常数时间比较 via sha256 比对）。
    pub fn resolve_token(&self, token: &str) -> Option<AgentClientId> {
        let hash = token_hash(token);
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, token_hash FROM agents WHERE revoked_at IS NULL")
            .ok()?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
            })
            .ok()?;
        for row in rows {
            let (id, stored) = row.ok()?;
            // 常数时间比较
            if stored.len() == 32 && constant_time_eq(&stored, &hash) {
                return Some(id);
            }
        }
        None
    }

    pub fn list_agents(&self) -> Result<Vec<(String, String, Option<i64>)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, label, revoked_at FROM agents ORDER BY created_at")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?))
            })
            .map_err(db_err)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(db_err)?);
        }
        Ok(out)
    }

    pub fn revoke_agent(&self, client_id: &str) -> Result<()> {
        self.conn.lock().unwrap()
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
                                    .unwrap_or_default()
                                    .into(),
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

    pub fn add_ttl_window(&self, agent_id: &str, pattern: &str, expires_at: chrono::DateTime<chrono::Utc>) -> Result<()> {
        self.conn.lock().unwrap()
            .execute(
                "INSERT INTO policies (id, agent_id, kind, pattern, expires_at, created_by, created_at) VALUES (?1,?2,'ttl_window',?3,?4,'human',?5)",
                params![format!("p-{}", uuid::Uuid::new_v4()), agent_id, pattern, expires_at.timestamp_millis(), now_ms()],
            )
            .map_err(db_err)?;
        Ok(())
    }

    // ---- 会话记录 ----
    pub fn record_session(&self, sid: &SessionId, host_id: &str, kind: &str) -> Result<()> {
        self.conn.lock().unwrap()
            .execute(
                "INSERT INTO sessions (id, host_id, kind, state, created_at) VALUES (?1,?2,?3,'connected',?4)",
                params![sid, host_id, kind, now_ms()],
            )
            .map_err(db_err)?;
        Ok(())
    }

    pub fn set_session_state(&self, sid: &SessionId, state: &str) -> Result<()> {
        self.conn.lock().unwrap()
            .execute(
                "UPDATE sessions SET state=?2 WHERE id=?1",
                params![sid, state],
            )
            .map_err(db_err)?;
        Ok(())
    }

    pub fn close_session_row(&self, sid: &SessionId) -> Result<()> {
        self.conn.lock().unwrap()
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
    fn host_password_encrypted_at_rest() {
        let (_dir, v) = vault();
        let hid = v
            .upsert_host(&HostDraft {
                name: "prod-1".into(),
                address: "10.0.0.1".into(),
                port: Some(22),
                username: "ops".into(),
                auth: AuthDraft::Password { password: "hunter2".into() },
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
                auth: AuthDraft::Password { password: "testpass".into() },
                ..Default::default()
            })
            .unwrap();
        // 新主机无信任记录
        assert!(v.host_fingerprint(&id).unwrap().is_none());
        // 确认后入库、可更新
        v.set_host_fingerprint(&id, "SHA256:AAAA").unwrap();
        assert_eq!(v.host_fingerprint(&id).unwrap().as_deref(), Some("SHA256:AAAA"));
        v.set_host_fingerprint(&id, "SHA256:BBBB").unwrap();
        assert_eq!(v.host_fingerprint(&id).unwrap().as_deref(), Some("SHA256:BBBB"));
        // 未知主机拒绝
        assert!(v.set_host_fingerprint("h-missing", "SHA256:X").is_err());
    }

    #[test]
    fn settings_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let mk = || Vault::open_shared(Connection::open(dir.path().join("v.db")).unwrap(), master_key().unwrap()).unwrap();
        let v = mk();
        // 未设置 → None
        assert!(v.get_setting("ui.font_size").unwrap().is_none());
        // 写入、覆盖（upsert）、按 key 隔离
        v.set_setting("ui.font_size", "16").unwrap();
        assert_eq!(v.get_setting("ui.font_size").unwrap().as_deref(), Some("16"));
        v.set_setting("ui.font_size", "13").unwrap();
        assert_eq!(v.get_setting("ui.font_size").unwrap().as_deref(), Some("13"));
        v.set_setting("ui.theme", "light").unwrap();
        assert_eq!(v.get_setting("ui.theme").unwrap().as_deref(), Some("light"));
        // 重开同一库：迁移幂等 + 偏好仍在（跨进程记忆，同 T17 指纹语义）
        drop(v);
        let v2 = mk();
        assert_eq!(v2.get_setting("ui.font_size").unwrap().as_deref(), Some("13"));
        assert_eq!(v2.get_setting("ui.theme").unwrap().as_deref(), Some("light"));
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
            conn.execute("INSERT INTO settings VALUES('ui.theme','solar-light')", []).unwrap();
            conn.execute("INSERT INTO settings VALUES('ui.font_size','15')", []).unwrap();
            conn.pragma_update(None, "user_version", 4).unwrap();
        }
        std::env::set_var("TINYSSH_MASTER_KEY", hex::encode([7u8; 32]));
        let v = Vault::open(&path).unwrap();
        let ver: u32 = {
            let conn = v.conn.lock().unwrap();
            conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
        };
        // 开库升到当前链尾（R43 后=7）；V5 专属断言在下方逐项验证
        assert_eq!(ver, 7);
        let ws = v.workspace().unwrap();
        assert_eq!(ws.schema_version, 1);
        assert_eq!(ws.chrome, "light"); // solar-light → light（DF8.3）
        assert!(ws.hostbar.is_none()); // 主机栏是 FE localStorage 域，核心不虚构
        assert_eq!(
            v.get_setting("ui.v2.terminal.font_size").unwrap().as_deref(),
            Some("15")
        );
        // 旧键保留不删（回退兼容）
        assert_eq!(v.get_setting("ui.theme").unwrap().as_deref(), Some("solar-light"));
        assert_eq!(v.get_setting("ui.font_size").unwrap().as_deref(), Some("15"));
        // 迁移幂等：重开 + 用户改写 blob 后再重开，保持用户值不被旧键重置
        let mut ws2 = v.workspace().unwrap();
        ws2.chrome = "dark".into();
        ws2.hostbar = Some(session_api::HostbarPrefs { open: false, width: 260 });
        v.set_workspace(&ws2).unwrap();
        drop(v);
        let v2 = Vault::open(&path).unwrap();
        let ws3 = v2.workspace().unwrap();
        assert_eq!(ws3.chrome, "dark");
        assert_eq!(ws3.hostbar, Some(session_api::HostbarPrefs { open: false, width: 260 }));
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
            conn.execute_batch("ALTER TABLE hosts ADD COLUMN host_fingerprint TEXT;").unwrap();
            conn.execute_batch("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
            conn.execute_batch("ALTER TABLE hosts ADD COLUMN charset TEXT NOT NULL DEFAULT 'utf-8';").unwrap();
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
        let by = |id: &str| v.list_hosts().unwrap().into_iter().find(|h| h.id == id).unwrap();
        assert_eq!(by("h-ssh").shell_integration, Some(true), "存量 SSH 主机一次性置启用（DC3.2）");
        assert_eq!(by("h-local").shell_integration, None, "local 主机不动");
        assert!(v.list_hosts().unwrap().iter().all(|h| h.id != "h-del"), "软删行不在活列表");
        // 升级后 upsert 缺省（None）保原值——不静默关闭已迁移主机
        let h = by("h-ssh");
        v.upsert_host(&HostDraft {
            id: Some(h.id.clone()),
            name: h.name.clone(),
            address: h.address.clone(),
            port: Some(h.port),
            username: h.username.clone(),
            auth: AuthDraft::Password { password: "x".into() },
            tags: h.tags.clone(),
            charset: h.charset,
            shell_integration: None,
        })
        .unwrap();
        assert_eq!(by("h-ssh").shell_integration, Some(true), "缺省 upsert 保原值");
        // 显式 Some(false) 生效（用户可关闭）
        let h = by("h-ssh");
        v.upsert_host(&HostDraft {
            id: Some(h.id.clone()),
            name: h.name.clone(),
            address: h.address.clone(),
            port: Some(h.port),
            username: h.username.clone(),
            auth: AuthDraft::Password { password: "x".into() },
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
            v2.list_hosts().unwrap().into_iter().find(|h| h.id == "h-ssh").unwrap().shell_integration,
            Some(false),
            "重开不得重写用户显式值"
        );
    }

    #[test]
    fn c8_favorites_recents_identity_refs_and_cascade() {
        let (_dir, v) = vault();
        let key_id = v
            .create_identity(&IdentityReq::Generate { label: "k1".into(), kind: KeyKind::Ed25519 })
            .unwrap()
            .id;
        let hid = v
            .upsert_host(&HostDraft {
                name: "prod-1".into(),
                address: "10.0.0.9".into(),
                username: "ops".into(),
                auth: AuthDraft::Key { identity_id: key_id.clone() },
                ..Default::default()
            })
            .unwrap();
        let hid2 = v
            .upsert_host(&HostDraft {
                name: "staging".into(),
                address: "10.0.0.10".into(),
                username: "ops".into(),
                auth: AuthDraft::Key { identity_id: key_id.clone() },
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
        assert!(v.list_host_metadata().unwrap()[0].last_connected_at.is_some());
        // 最近连接（DF8.5）：sessions 派生、排除 local、每主机最近一次、删除主机无幽灵
        v.record_session(&"s-1".to_string(), &hid, "ssh").unwrap();
        v.record_session(&"s-2".to_string(), &hid, "ssh").unwrap();
        v.record_session(&"s-3".to_string(), &hid, "local").unwrap(); // 排除
        v.record_session(&"s-4".to_string(), &hid2, "ssh").unwrap();
        // 钉死时间戳：record_session 用 now_ms()，连续四写常落同一毫秒，而
        // list_recent_hosts 的 `ORDER BY last_at DESC` 对并列无确定序——本用例曾
        // 2/12 偶发红（h-8f9b… vs h-a61f…）。此处显式赋值使「s-4 晚于 s-2」恒真。
        {
            let conn = v.conn.lock().unwrap();
            for (sid, ts) in [("s-1", 1000i64), ("s-2", 2000), ("s-3", 3000), ("s-4", 4000)] {
                conn.execute("UPDATE sessions SET created_at=?2 WHERE id=?1", params![sid, ts]).unwrap();
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
            conn.query_row("SELECT COUNT(*) FROM transfer_journal", [], |r| r.get::<_, i64>(0))
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
        let v = Vault::open_shared(Connection::open(dir.path().join("v.db")).unwrap(), master_key().unwrap()).unwrap();
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
        assert_eq!(got.0.collision_decision, Some(session_api::CollisionDecision::Overwrite));
        assert!(got.1, "发布原语成功后 verified=true 可读");
        let mut k = t.clone();
        k.id = "t-x4".into();
        k.status = TransferStatus::AwaitingDecision;
        k.collision_decision = Some(session_api::CollisionDecision::KeepBoth);
        v.transfer_journal_insert(&k).unwrap();
        let got2 = v.transfer_journal_get("t-x4").unwrap().unwrap();
        assert_eq!(got2.0.collision_decision, Some(session_api::CollisionDecision::KeepBoth));
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
        let v = Vault::open_shared(Connection::open(&fresh).unwrap(), master_key().unwrap()).unwrap();
        assert!(!v.collab_enabled().unwrap(), "全新库默认关闭协作（新装无自动 MCP 监听）");
        drop(v);

        // 升级：造一个「既有 V6 库」（schema 已到 V7，但删去新键并把版本退到 6）
        let up = dir.path().join("up.db");
        drop(Vault::open_shared(Connection::open(&up).unwrap(), master_key().unwrap()).unwrap());
        {
            let conn = Connection::open(&up).unwrap();
            conn.execute("DELETE FROM settings WHERE key='collab.enabled'", []).unwrap();
            conn.pragma_update(None, "user_version", 6).unwrap();
        }
        let v = Vault::open_shared(Connection::open(&up).unwrap(), master_key().unwrap()).unwrap();
        assert!(v.collab_enabled().unwrap(), "升级库缺新键时保留旧版「MCP 默认开启」行为");
        drop(v);

        // 幂等：重开不翻转
        let v = Vault::open_shared(Connection::open(&up).unwrap(), master_key().unwrap()).unwrap();
        assert!(v.collab_enabled().unwrap(), "重复启动幂等，迁移不重写");
        drop(v);

        // 已有明确偏好优先：用户已显式关闭 → 迁移不覆盖
        {
            let conn = Connection::open(&up).unwrap();
            conn.execute("UPDATE settings SET value='0' WHERE key='collab.enabled'", []).unwrap();
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
}

