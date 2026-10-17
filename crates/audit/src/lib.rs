//! 审计事件存储：SQLite + 哈希链（完整性检测口径，L1 §6/§7）。

use chrono::{TimeZone, Utc};
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
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn open_shared(conn: Connection) -> Result<Self> {
        conn.execute_batch(SCHEMA_V1)
            .map_err(|e| Error::Storage(e.to_string()))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
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
        let payload =
            serde_json::to_string(&payload_json).map_err(|e| Error::Storage(e.to_string()))?;
        let mut hash_input = String::new();
        hash_input.push_str(prev_hash.as_deref().unwrap_or(""));
        hash_input.push_str(&ts.timestamp_millis().to_string());
        hash_input.push_str(actor_kind);
        hash_input.push_str(agent_id.as_deref().unwrap_or(""));
        hash_input.push_str(action);
        hash_input.push_str(session_id.unwrap_or(""));
        hash_input.push_str(command.unwrap_or(""));
        hash_input.push_str(&payload);
        hash_input.push_str(approval_id.unwrap_or(""));
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
        // R41（§6.6「可筛人类/Agent」）：actor_kind 精确匹配；未知值不匹配任何行
        if let Some(k) = &f.actor_kind {
            params.push(Box::new(k.clone()));
            where_clauses.push(format!("actor_kind = ?{}", params.len()));
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
        // R41：`before_seq` 是翻页游标而非过滤条件——`total` 报**过滤后**的总数，不随翻页缩水
        // （否则界面上的「共 N 条」会一页页变小）。故先按过滤条件计数，再加游标取当页。
        let total: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM audit_events {where_sql}"),
                psql.as_slice(),
                |r| r.get(0),
            )
            .map_err(|e| Error::Storage(e.to_string()))?;

        // R41（「记录连续」）：seq 游标翻页（offset 会在新事件入链后错位/重复）
        if let Some(s) = f.before_seq {
            params.push(Box::new(s));
            where_clauses.push(format!("seq < ?{}", params.len()));
        }
        // rev-r46：反方向游标（跟随新事件），与 before_seq 同不计入 total
        if let Some(s) = f.after_seq {
            params.push(Box::new(s));
            where_clauses.push(format!("seq > ?{}", params.len()));
        }
        let page_where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };
        let psql: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();

        let sql = format!(
            "SELECT seq, ts, actor_kind, agent_id, action, session_id, command, payload_json, approval_id, prev_hash, hash
             FROM audit_events {page_where_sql} ORDER BY seq DESC LIMIT {limit} OFFSET {offset}"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| Error::Storage(e.to_string()))?;
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
            .prepare("SELECT seq, ts, actor_kind, agent_id, action, session_id, command, payload_json, approval_id, prev_hash, hash FROM audit_events ORDER BY seq ASC")
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
                    r.get::<_, Option<String>>(10)?,
                ))
            })
            .map_err(|e| Error::Storage(e.to_string()))?;
        let mut prev: Option<String> = None;
        for row in rows {
            let (seq, ts, kind, agent, action, sid, cmd, payload, apid, prev_h, hash) =
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
            input.push_str(apid.as_deref().unwrap_or(""));
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
        payload_json: serde_json::from_str(&payload).unwrap_or(serde_json::Value::String(payload)),
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
                    &Actor::Agent {
                        client_id: "cc".into(),
                    },
                    "exec",
                    Some("s1"),
                    Some(&format!("cmd {i}")),
                    serde_json::json!({"exit": i}),
                    None,
                )
                .unwrap();
        }
        store
            .append(
                &Actor::Human,
                "takeover",
                Some("s1"),
                None,
                serde_json::json!({}),
                None,
            )
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

    /// R41（§6.6「记录连续」）：`before_seq` 是**翻页游标**，不是过滤条件——
    /// `total` 必须报过滤后的总数（不随翻页缩水），且相邻两页不重不漏。
    #[test]
    fn seq_cursor_paging_is_continuous_and_total_is_stable() {
        let dir = tempfile::tempdir().unwrap();
        let store = AuditStore::open(&dir.path().join("a.db")).unwrap();
        for i in 0..5 {
            store
                .append(
                    &Actor::Human,
                    "exec",
                    Some("s1"),
                    Some(&format!("c{i}")),
                    serde_json::json!({}),
                    None,
                )
                .unwrap();
        }
        store
            .append(
                &Actor::Agent {
                    client_id: "cc".into(),
                },
                "exec",
                Some("s2"),
                None,
                serde_json::json!({}),
                None,
            )
            .unwrap();

        // 全量：按 seq 倒序取前 2 条
        let p1 = store
            .query(&AuditFilter {
                limit: 2,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(p1.total, 6, "total 是过滤后总数");
        assert_eq!(p1.events.len(), 2);
        assert_eq!(p1.events[0].seq, 6);

        // 游标翻页：第二页严格早于第一页末条，且 total 不变
        let p2 = store
            .query(&AuditFilter {
                limit: 2,
                before_seq: Some(p1.events[1].seq),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(p2.total, 6, "翻页不改变 total");
        assert_eq!(p2.events.len(), 2);
        let s1: Vec<i64> = p1.events.iter().map(|e| e.seq).collect();
        let s2: Vec<i64> = p2.events.iter().map(|e| e.seq).collect();
        assert!(
            s2.iter().all(|s| *s < s1[1]),
            "第二页全部早于第一页末条：{s1:?} / {s2:?}"
        );
        assert!(s1.iter().all(|s| !s2.contains(s)), "两页无重复");

        // 新事件入链后按游标继续翻页，仍不重复、不漏掉旧记录
        store
            .append(
                &Actor::Human,
                "exec",
                Some("s3"),
                None,
                serde_json::json!({}),
                None,
            )
            .unwrap();
        let p3 = store
            .query(&AuditFilter {
                limit: 2,
                before_seq: Some(p2.events[1].seq),
                ..Default::default()
            })
            .unwrap();
        let s3: Vec<i64> = p3.events.iter().map(|e| e.seq).collect();
        assert!(
            s3.iter().all(|s| !s1.contains(s) && !s2.contains(s)),
            "第三页与前两页无重复：{s3:?}"
        );
        assert_eq!(p3.total, 7, "新事件入链后 total 跟上");

        // 过滤器 + 游标组合：total 只反映过滤条件，不含游标
        let pf = store
            .query(&AuditFilter {
                session_id: Some("s1".into()),
                limit: 2,
                before_seq: Some(5),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(pf.total, 5, "过滤后 total=5（s1 的行），游标不参与计数");
        assert!(pf
            .events
            .iter()
            .all(|e| e.session_id.as_deref() == Some("s1") && e.seq < 5));
    }

    #[test]
    fn after_seq_cursor_follows_new_events() {
        // rev-r46：after_seq 反方向游标——跟随新事件（等审批时轮询增量），不计入 total
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.db");
        let store = AuditStore::open(&path).unwrap();
        for action in ["a1", "a2", "a3"] {
            store
                .append(&Actor::Human, action, None, None, serde_json::json!({}), None)
                .unwrap();
        }
        let base = store
            .query(&AuditFilter {
                limit: 1,
                ..Default::default()
            })
            .unwrap();
        let head = base.events[0].seq;
        store
            .append(&Actor::Human, "a4", None, None, serde_json::json!({}), None)
            .unwrap();
        let inc = store
            .query(&AuditFilter {
                after_seq: Some(head),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(inc.total, 4, "after_seq 不参与 total 计数（全表仍 4 条）");
        assert_eq!(
            inc.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![head + 1],
            "只取游标之后的增量"
        );
        // 双游标开窗：1 < seq < 3
        let win = store
            .query(&AuditFilter {
                after_seq: Some(1),
                before_seq: Some(3),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            win.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![2],
            "双游标取开窗区间"
        );
    }

    #[test]
    fn chain_detects_tamper() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.db");
        {
            let store = AuditStore::open(&path).unwrap();
            store
                .append(
                    &Actor::Human,
                    "a",
                    None,
                    Some("x"),
                    serde_json::json!({}),
                    None,
                )
                .unwrap();
            store
                .append(
                    &Actor::Human,
                    "b",
                    None,
                    Some("y"),
                    serde_json::json!({}),
                    None,
                )
                .unwrap();
        }
        // 直接改库（模拟篡改）
        let conn = Connection::open(&path).unwrap();
        conn.execute("UPDATE audit_events SET command='hacked' WHERE seq=1", [])
            .unwrap();
        let store = AuditStore::open(&path).unwrap();
        assert!(!store.verify_chain().unwrap());
    }
}
