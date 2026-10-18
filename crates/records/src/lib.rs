//! 执行记录存储（③ 记录与审计一期）：Agent/人类动作的**结构化**事后记录，
//! 供时间线回放、自查与后续评测/升级用。与审计（audit，哈希链、只进不出、
//! 面向追责）互补：记录带输出摘录与耗时等富信息，面向回看与分析。
//!
//! - 存储：按天分文件 `records-YYYY-MM-DD.jsonl.enc`，每行一条
//!   XChaCha20-Poly1305 密文（hex），密钥由调用方注入（vault 主密钥派生面）。
//!   落盘即密文——记录含输出摘录，本身是敏感数据。
//! - 脱敏：写入前对输出摘录做启发式密钥擦除（PEM/AWS/GitHub/OpenAI/JWT/
//!   password= 等）；启发式是尽力而为，不能替代权限边界。
//! - 保留期：open 时清理超期文件（默认 30 天）。
//! - 写入永不致命：append 的错误由调用方决定吞掉（动作不能因记录失败而失败）。

use chacha20poly1305::{Key as ChachaKey, XChaCha20Poly1305, XNonce};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub mod redact;

/// 记录种类（一期：动作面三类；审批决定已在 audit，不重复）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordKind {
    Exec,
    Transfer,
    Forward,
}

/// 一条结构化动作记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordEvent {
    /// 存储内单调递增（open 时从最新文件回播种）。
    pub seq: u64,
    pub ts: DateTime<Utc>,
    pub kind: RecordKind,
    pub session_id: Option<String>,
    /// None = 人类动作。
    pub agent_id: Option<String>,
    /// 一行摘要：命令全文 / 传输两端 / 转发规格。
    pub summary: String,
    /// ok | error | denied | timeout | cancelled | dangerous
    pub status: String,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    /// 截断 + 脱敏后的输出摘录（≤ OUTPUT_EXCERPT_CAP 字节）。
    pub output_excerpt: Option<String>,
    /// 种类专属细节（传输两端/字节数/哈希、转发规格、错误类型等）。
    pub meta: serde_json::Value,
}

/// 输出摘录上限（字节）：与 exec output_cap 缺省同量级，时间线够用、库不膨胀。
pub const OUTPUT_EXCERPT_CAP: usize = 4096;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RecordFilter {
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
    pub kind: Option<RecordKind>,
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    /// 缺省 200，硬上限 1000。
    pub limit: Option<u32>,
}

/// 加解密注入面：密钥不出 vault——store 只拿到闭包。
pub struct Crypto {
    pub seal: Box<dyn Fn(&[u8]) -> Vec<u8> + Send + Sync>,
    pub open: Box<dyn Fn(&[u8]) -> Result<Vec<u8>, String> + Send + Sync>,
}

pub struct RecordStore {
    dir: PathBuf,
    crypto: Crypto,
    seq: AtomicU64,
}

impl RecordStore {
    /// 打开（目录不存在则建）；清理超期文件。`retention_days=0` 表示永久保留。
    pub fn open(dir: &Path, retention_days: u32, crypto: Crypto) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        if retention_days > 0 {
            let cutoff = Utc::now() - chrono::Duration::days(retention_days as i64);
            for e in std::fs::read_dir(dir)?.flatten() {
                if let Some(name) = e.file_name().to_str() {
                    if let Some(day) = day_of(name) {
                        if day < cutoff.date_naive() {
                            let _ = std::fs::remove_file(e.path());
                        }
                    }
                }
            }
        }
        let mut store = Self {
            dir: dir.to_path_buf(),
            crypto,
            seq: AtomicU64::new(0),
        };
        // 回播种：读最新文件末行 seq（失败从 0 起——序号只为排序，不承诺连续）
        if let Some(f) = store.latest_file() {
            if let Ok(fh) = std::fs::File::open(f) {
                let last = std::io::BufReader::new(fh)
                    .lines()
                    .flatten()
                    .last();
                if let Some(line) = last {
                    if let Some(ev) = store.decode_line(&line) {
                        store.seq.store(ev.seq, Ordering::SeqCst);
                    }
                }
            }
        }
        Ok(store)
    }

    /// 追加一条。**调用方约定**：动作路径上忽略本调用错误（记录失败不得使动作失败）。
    pub fn append(&self, mut ev: RecordEvent) -> std::io::Result<u64> {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        ev.seq = seq;
        ev.ts = Utc::now();
        let day = ev.ts.date_naive();
        let line = self.encode_line(&ev)?;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join(format!("records-{day}.jsonl.enc")))?;
        f.write_all(line.as_bytes())?;
        f.write_all(b"\n")?;
        Ok(seq)
    }

    /// 查询：从新到旧扫描，命中即收集，够 limit 即停。
    pub fn query(&self, f: &RecordFilter) -> std::io::Result<Vec<RecordEvent>> {
        let limit = f.limit.unwrap_or(200).min(1000) as usize;
        let mut out = Vec::new();
        let mut files = self.list_files()?;
        files.reverse(); // 新→旧
        'files: for path in files {
            let Ok(fh) = std::fs::File::open(path) else { continue };
            let lines: Vec<String> = std::io::BufReader::new(fh).lines().flatten().collect();
            for line in lines.into_iter().rev() {
                let Some(ev) = self.decode_line(&line) else { continue };
                if !matches(&ev, f) {
                    continue;
                }
                out.push(ev);
                if out.len() >= limit {
                    break 'files;
                }
            }
        }
        Ok(out)
    }

    /// 导出**明文** JSONL（人类发起；供离线分析/评测集）。返回导出行数。
    pub fn export_jsonl(&self, f: &RecordFilter, to: &Path) -> std::io::Result<u64> {
        let evs = self.query(f)?;
        let mut w = std::io::BufWriter::new(std::fs::File::create(to)?);
        let mut n = 0u64;
        for ev in &evs {
            serde_json::to_writer(&mut w, ev).map_err(|e| std::io::Error::other(e.to_string()))?;
            w.write_all(b"\n")?;
            n += 1;
        }
        w.flush()?;
        Ok(n)
    }

    /// 存储目录（④ 导出面用：明文导出默认落在隔壁 `records-export/`）。
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn count(&self) -> std::io::Result<u64> {
        let mut n = 0u64;
        for p in self.list_files()? {
            n += std::io::BufReader::new(std::fs::File::open(p)?).lines().count() as u64;
        }
        Ok(n)
    }

    // ---- 内部 ----

    fn list_files(&self) -> std::io::Result<Vec<PathBuf>> {
        let mut v: Vec<PathBuf> = std::fs::read_dir(&self.dir)?
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("records-") && n.ends_with(".jsonl.enc"))
                    .unwrap_or(false)
            })
            .collect();
        v.sort(); // 文件名含日期，字典序即时间序
        Ok(v)
    }

    fn latest_file(&self) -> Option<PathBuf> {
        self.list_files().ok()?.pop()
    }

    fn encode_line(&self, ev: &RecordEvent) -> std::io::Result<String> {
        let pt = serde_json::to_vec(ev).map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok(hex_encode(&(self.crypto.seal)(&pt)))
    }

    fn decode_line(&self, line: &str) -> Option<RecordEvent> {
        let ct = hex_decode(line.trim())?;
        let pt = (self.crypto.open)(&ct).ok()?;
        serde_json::from_slice(&pt).ok()
    }
}

fn matches(ev: &RecordEvent, f: &RecordFilter) -> bool {
    if let Some(s) = &f.session_id {
        if ev.session_id.as_deref() != Some(s) {
            return false;
        }
    }
    if let Some(a) = &f.agent_id {
        if ev.agent_id.as_deref() != Some(a) {
            return false;
        }
    }
    if let Some(k) = f.kind {
        if ev.kind != k {
            return false;
        }
    }
    if let Some(since) = f.since {
        if ev.ts < since {
            return false;
        }
    }
    if let Some(until) = f.until {
        if ev.ts > until {
            return false;
        }
    }
    true
}

fn day_of(file_name: &str) -> Option<chrono::NaiveDate> {
    let rest = file_name.strip_prefix("records-")?.strip_suffix(".jsonl.enc")?;
    chrono::NaiveDate::parse_from_str(rest, "%Y-%m-%d").ok()
}

/// 自带一套与 vault.seal 同构的 XChaCha20-Poly1305 实现，供不依赖 vault 的
/// 场景（测试/独立进程）构造 Crypto；生产装配走 vault 闭包（密钥单一来源）。
pub fn chacha_crypto(key: &[u8; 32]) -> Crypto {
    let key = *key; // 闭包要求 'static：拿副本（调用方密钥本就在 vault 内部）
    let seal = move |pt: &[u8]| -> Vec<u8> {
        use chacha20poly1305::aead::{Aead, KeyInit, Payload};
        let cipher = XChaCha20Poly1305::new(ChachaKey::from_slice(&key));
        let mut nonce_bytes = [0u8; 24];
        use rand::RngCore;
        rand::rng().fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);
        let ct = cipher
            .encrypt(nonce, Payload { msg: pt, aad: &[] })
            .expect("chacha seal");
        let mut out = Vec::with_capacity(24 + ct.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ct);
        out
    };
    let open = move |blob: &[u8]| -> Result<Vec<u8>, String> {
        use chacha20poly1305::aead::{Aead, KeyInit, Payload};
        if blob.len() < 24 {
            return Err("blob too short".into());
        }
        let cipher = XChaCha20Poly1305::new(ChachaKey::from_slice(&key));
        let nonce = XNonce::from_slice(&blob[..24]);
        cipher
            .decrypt(nonce, Payload { msg: &blob[24..], aad: &[] })
            .map_err(|_| "decrypt failed".to_string())
    };
    Crypto {
        seal: Box::new(seal),
        open: Box::new(open),
    }
}

fn hex_encode(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for byte in b {
        s.push_str(&format!("{byte:02x}"));
    }
    s
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.is_empty() || s.len() % 2 != 0 {
        return None;
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(dir: &Path) -> RecordStore {
        std::fs::remove_dir_all(dir).ok();
        RecordStore::open(dir, 30, chacha_crypto(&[7u8; 32])).unwrap()
    }

    fn ev(kind: RecordKind, summary: &str) -> RecordEvent {
        RecordEvent {
            seq: 0,
            ts: Utc::now(),
            kind,
            session_id: Some("s-1".into()),
            agent_id: Some("agent-x".into()),
            summary: summary.into(),
            status: "ok".into(),
            exit_code: Some(0),
            duration_ms: Some(12),
            output_excerpt: None,
            meta: serde_json::json!({}),
        }
    }

    #[test]
    fn append_query_roundtrip_encrypted_at_rest() {
        let dir = std::env::temp_dir().join(format!("rec-{}", uuid::Uuid::new_v4()));
        let s = store(&dir);
        s.append(ev(RecordKind::Exec, "docker ps")).unwrap();
        s.append(ev(RecordKind::Transfer, "upload a.bin")).unwrap();
        s.append(ev(RecordKind::Exec, "df -h")).unwrap();

        let all = s.query(&RecordFilter::default()).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].summary, "df -h", "新→旧");
        assert!(all[0].seq > all[2].seq);

        let mut f = RecordFilter::default();
        f.kind = Some(RecordKind::Transfer);
        assert_eq!(s.query(&f).unwrap().len(), 1);

        // 落盘的是密文：文件里找不到明文摘要
        let raw = std::fs::read_to_string(
            dir.join(format!("records-{}.jsonl.enc", Utc::now().date_naive())),
        )
        .unwrap();
        assert!(!raw.contains("docker ps"), "磁盘上不得出现明文");
        assert!(!raw.contains("agent-x"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn wrong_key_cannot_read() {
        let dir = std::env::temp_dir().join(format!("rec-{}", uuid::Uuid::new_v4()));
        {
            let s = store(&dir);
            s.append(ev(RecordKind::Exec, "secret-cmd")).unwrap();
        }
        let s2 = RecordStore::open(&dir, 30, chacha_crypto(&[9u8; 32])).unwrap();
        assert!(s2.query(&RecordFilter::default()).unwrap().is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn retention_prunes_old_files() {
        let dir = std::env::temp_dir().join(format!("rec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("records-2020-01-01.jsonl.enc");
        std::fs::write(&old, b"junk").unwrap();
        RecordStore::open(&dir, 30, chacha_crypto(&[7u8; 32])).unwrap();
        assert!(!old.exists(), "超期文件应被清理");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn export_writes_plaintext_jsonl() {
        let dir = std::env::temp_dir().join(format!("rec-{}", uuid::Uuid::new_v4()));
        let s = store(&dir);
        s.append(ev(RecordKind::Exec, "echo hi")).unwrap();
        let to = dir.parent().unwrap().join("export.jsonl");
        let n = s
            .export_jsonl(&RecordFilter::default(), &to)
            .unwrap();
        assert_eq!(n, 1);
        let text = std::fs::read_to_string(&to).unwrap();
        assert!(text.contains("\"echo hi\""), "导出是明文 JSONL：{text}");
        std::fs::remove_dir_all(dir).ok();
        std::fs::remove_file(to).ok();
    }

    #[test]
    fn seq_survives_reopen() {
        let dir = std::env::temp_dir().join(format!("rec-{}", uuid::Uuid::new_v4()));
        {
            let s = store(&dir);
            s.append(ev(RecordKind::Exec, "a")).unwrap();
            s.append(ev(RecordKind::Exec, "b")).unwrap();
        }
        let s2 = RecordStore::open(&dir, 30, chacha_crypto(&[7u8; 32])).unwrap();
        let seq = s2.append(ev(RecordKind::Exec, "c")).unwrap();
        assert!(seq > 2, "重开后续接序号：{seq}");
        std::fs::remove_dir_all(dir).ok();
    }
}
