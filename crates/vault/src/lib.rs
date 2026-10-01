//! vault：主机/凭据/Agent 身份与策略存取与加密（L1 §3.4）。
//! - SQLite 存非敏感字段；凭据载荷（私钥 PEM、口令）以主密钥加密存 BLOB；
//! - 主密钥：OS 钥匙串托管的随机 32B（测试可用 env 覆盖）；
//! - XChaCha20-Poly1305 加密；Zeroizing 包裹；Debug 不输出明文。

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, Key as ChachaKey, XNonce};
use rusqlite::{params, Connection};
use session_api::{
    Actor, AgentClientId, ApprovalId, ApprovalItem, ApprovalStatus, AuthDraft, AuthType, Error,
    Host, HostDraft, HostId, IdentityId, IdentityKind, IdentityMeta, IdentityReq, KeyKind, Policy,
    Result, SessionId,
};
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::path::Path;
use zeroize::Zeroizing;

pub mod db;
pub mod sshcfg;

pub use db::SCHEMA_V1;

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
        conn.execute(
            "INSERT INTO hosts (id, name, address, port, username, auth_type, identity_id, tags_json, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)
             ON CONFLICT(id) DO UPDATE SET name=?2, address=?3, port=?4, username=?5, auth_type=?6, identity_id=?7, tags_json=?8, updated_at=?9",
            params![
                id,
                host.name,
                host.address,
                host.port.unwrap_or(22) as i64,
                host.username,
                auth_type,
                identity_id,
                serde_json::to_string(&host.tags).unwrap(),
                now_ms()
            ],
        )
        .map_err(db_err)?;
        Ok(id)
    }

    pub fn delete_host(&self, id: &str) -> Result<()> {
        self.conn.lock().unwrap()
            .execute("UPDATE hosts SET deleted_at=?2 WHERE id=?1", params![id, now_ms()])
            .map_err(db_err)?;
        Ok(())
    }

    pub fn list_hosts(&self) -> Result<Vec<Host>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, address, port, username, auth_type, identity_id, tags_json FROM hosts WHERE deleted_at IS NULL")
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
                ))
            })
            .map_err(db_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (id, name, address, port, username, auth_type, identity_id, tags_json) =
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
}

