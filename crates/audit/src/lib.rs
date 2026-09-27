//! 审计事件存储：SQLite + 哈希链（完整性检测口径，L1 §6/§7）。

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::Connection;
use session_api::{AuditEvent, AuditFilter, AuditPage, Error, Result};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Mutex;

pub struct AuditStore {
    conn: Mutex<Connection>,
}

pub fn open_db(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path).map_err(|e| Error::Storage(e.to_string()))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| Error::Storage(e.to_string()))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| Error::Storage(e.to_string()))?;
    Ok(conn)
}

pub const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','agent')),
  agent_id TEXT,
  action TEXT NOT NULL, session_id TEXT,
  command TEXT,
  payload_json TEXT NOT NULL,
  approval_id TEXT,
  prev_hash TEXT, hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_events(agent_id);
"#;

impl AuditStore {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = open_db(path)?;
        conn.execute_batch(SCHEMA_V1)
            .map_err(|e| Error::Storage(e.to_string()))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn open_shared(conn: Connection) -> Result<Self> {
        conn.execute_batch(SCHEMA_V1)
            .map_err(|e| Error::Storage(e.to_string()))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// 追加事件；哈希链 = sha256(prev_hash + 规范化载荷)。
    pub fn append(
        &self,
        actor: &session_api::Actor,
        action: &str,
        session_id: Option<&str>,
        command: Option<&str>,
        payload_json: serde_json::Value,
        approval_id: Option<&str>,
    ) -> Result<AuditEvent> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| Error::Storage(e.to_string()))?;

        let prev_hash: Option<String> = tx
            .query_row(
                "SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .ok();
        let ts = Utc::now();
        let (actor_kind, agent_id) = match actor {
            session_api::Actor::Human => ("human", None),
            session_api::Actor::Agent { client_id } => ("agent", Some(client_id.clone())),
        };
        let payload = serde_json::to_string(&payload_json)
            .map_err(|e| Error::Storage(e.to_string()))?;
        let mut hash_input = String::new();
        hash_input.push_str(prev_hash.as_deref().unwrap_or(""));
        hash_input.push_str(&ts.timestamp_millis().to_string());
        hash_input.push_str(&actor_kind);
        hash_input.push_str(agent_id.as_deref().unwrap_or(""));
        hash_input.push_str(action);
        hash_input.push_str(session_id.unwrap_or(""));
        hash_input.push_str(command.unwrap_or(""));
        hash_input.push_str(&payload);
        let hash = hex::encode(Sha256::digest(hash_input.as_bytes()));

        tx.execute(
            "INSERT INTO audit_events (ts, actor_kind, agent_id, action, session_id, command, payload_json, approval_id, prev_hash, hash)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            rusqlite::params![
                ts.timestamp_millis(),
                actor_kind,
                agent_id,
                action,
                session_id,
                command,
                payload,
                approval_id,
                prev_hash,
                hash
            ],
        )
        .map_err(|e| Error::Storage(e.to_string()))?;
        let seq = tx.last_insert_rowid();
        tx.commit().map_err(|e| Error::Storage(e.to_string()))?;

        Ok(AuditEvent {
            seq,
            ts,
            actor_kind: actor_kind.into(),
            agent_id,
            action: action.into(),
            session_id: session_id.map(|s| s.into()),
            command: command.map(|s| s.into()),
            payload_json,
            approval_id: approval_id.map(|s| s.into()),
            prev_hash,
            hash: Some(hash),
        })
    }

    pub fn query(&self, f: &AuditFilter) -> Result<AuditPage> {
        let conn = self.conn.lock().unwrap();
        let mut where_clauses: Vec<String> = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(s) = &f.session_id {
            params.push(Box::new(s.clone()));
            where_clauses.push(format!("session_id = ?{}", params.len()));
        }
        if let Some(a) = &f.agent_id {
            params.push(Box::new(a.clone()));
            where_clauses.push(format!("agent_id = ?{}", params.len()));
        }
        if let Some(a) = &f.action {
            params.push(Box::new(a.clone()));
            where_clauses.push(format!("action = ?{}", params.len()));
        }
        if let Some(t) = f.since {
            params.push(Box::new(t.timestamp_millis()));
            where_clauses.push(format!("ts >= ?{}", params.len()));
        }
        if let Some(t) = f.until {
            params.push(Box::new(t.timestamp_millis()));
            where_clauses.push(format!("ts <= ?{}", params.len()));
        }
        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };
        let limit = if f.limit <= 0 { 100 } else { f.limit };
        let offset = f.offset.max(0);

        let psql: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let total: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM audit_events {where_sql}"),
                psql.as_slice(),
                |r| r.get(0),
            )
            .map_err(|e| Error::Storage(e.to_string()))?;

        let sql = format!(
            "SELECT seq, ts, actor_kind, agent_id, action, session_id, command, payload_json, approval_id, prev_hash, hash
             FROM audit_events {where_sql} ORDER BY seq DESC LIMIT {limit} OFFSET {offset}"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| Error::Storage(e.to_string()))?;
        let rows = stmt
            .query_map(psql.as_slice(), row_to_event)
            .map_err(|e| Error::Storage(e.to_string()))?;
        let mut events = Vec::new();
        for r in rows {
            events.push(r.map_err(|e| Error::Storage(e.to_string()))?);
        }
        Ok(AuditPage { total, events })
    }

    /// 导出 JSONL（含哈希链校验说明性字段）。
    pub fn export(&self, f: &AuditFilter, to: &Path) -> Result<usize> {
        let mut all = AuditFilter {
            limit: i64::MAX,
            ..f.clone()
        };
        all.offset = 0;
        let page = self.query(&all)?;
        let mut out = String::new();
        for ev in &page.events {
            let line = serde_json::to_string(ev).map_err(|e| Error::Storage(e.to_string()))?;
            out.push_str(&line);
            out.push('\n');
        }
        std::fs::write(to, out).map_err(|e| Error::Io(e.to_string()))?;
        Ok(page.events.len())
    }

    /// 哈希链校验（完整性检测）。
    pub fn verify_chain(&self) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT seq, ts, actor_kind, agent_id, action, session_id, command, payload_json, prev_hash, hash FROM audit_events ORDER BY seq ASC")
            .map_err(|e| Error::Storage(e.to_string()))?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, Option<String>>(9)?,
                ))
            })
            .map_err(|e| Error::Storage(e.to_string()))?;
        let mut prev: Option<String> = None;
        for row in rows {
            let (seq, ts, kind, agent, action, sid, cmd, payload, prev_h, hash) =
                row.map_err(|e| Error::Storage(e.to_string()))?;
            if prev_h != prev {
                return Ok(false); // 链断裂/被改
            }
            let mut input = String::new();
            input.push_str(prev_h.as_deref().unwrap_or(""));
            input.push_str(&ts.to_string());
            input.push_str(&kind);
            input.push_str(agent.as_deref().unwrap_or(""));
            input.push_str(&action);
            input.push_str(sid.as_deref().unwrap_or(""));
            input.push_str(cmd.as_deref().unwrap_or(""));
            input.push_str(&payload);
            let expect = hex::encode(Sha256::digest(input.as_bytes()));
            if Some(expect) != hash {
                return Ok(false);
            }
            prev = hash;
            let _ = seq;
        }
        Ok(true)
    }
}

fn row_to_event(r: &rusqlite::Row) -> rusqlite::Result<AuditEvent> {
    let ts_ms: i64 = r.get(1)?;
    let payload: String = r.get(7)?;
    Ok(AuditEvent {
        seq: r.get(0)?,
        ts: Utc.timestamp_millis_opt(ts_ms).single().unwrap_or_default(),
        actor_kind: r.get(2)?,
        agent_id: r.get(3)?,
        action: r.get(4)?,
        session_id: r.get(5)?,
        command: r.get(6)?,
        payload_json: serde_json::from_str(&payload)
            .unwrap_or(serde_json::Value::String(payload)),
        approval_id: r.get(8)?,
        prev_hash: r.get(9)?,
        hash: r.get(10)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use session_api::Actor;

    #[test]
    fn append_query_verify_chain() {
        let dir = tempfile::tempdir().unwrap();
        let store = AuditStore::open(&dir.path().join("a.db")).unwrap();
        for i in 0..5 {
            store
                .append(
                    &Actor::Agent { client_id: "cc".into() },
                    "exec",
                    Some("s1"),
                    Some(&format!("cmd {i}")),
                    serde_json::json!({"exit": i}),
                    None,
                )
                .unwrap();
        }
        store
            .append(&Actor::Human, "takeover", Some("s1"), None, serde_json::json!({}), None)
            .unwrap();

        let page = store
            .query(&AuditFilter {
                session_id: Some("s1".into()),
                action: Some("exec".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.total, 5);
        assert_eq!(page.events[0].seq, 5, "按 seq 倒序");

        let f = AuditFilter {
            session_id: Some("s1".into()),
            ..Default::default()
        };
        let to = dir.path().join("export.jsonl");
        assert_eq!(store.export(&f, &to).unwrap(), 6);
        let content = std::fs::read_to_string(&to).unwrap();
        assert_eq!(content.lines().count(), 6);

        assert!(store.verify_chain().unwrap());
    }

    #[test]
    fn chain_detects_tamper() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.db");
        {
            let store = AuditStore::open(&path).unwrap();
            store.append(&Actor::Human, "a", None, Some("x"), serde_json::json!({}), None).unwrap();
            store.append(&Actor::Human, "b", None, Some("y"), serde_json::json!({}), None).unwrap();
        }
        // 直接改库（模拟篡改）
        let conn = Connection::open(&path).unwrap();
        conn.execute("UPDATE audit_events SET command='hacked' WHERE seq=1", [])
            .unwrap();
        let store = AuditStore::open(&path).unwrap();
        assert!(!store.verify_chain().unwrap());
    }
}
