//! SQLite DDL（L1 §6 v1）：user_version 顺序迁移。

pub const SCHEMA_V1: &str = r#"CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, group_id TEXT,
  address TEXT NOT NULL, port INTEGER DEFAULT 22, username TEXT NOT NULL,
  auth_type TEXT CHECK(auth_type IN ('key','password','agent','keyboard-interactive')),
  identity_id TEXT REFERENCES identities(id), jump_host_id TEXT REFERENCES hosts(id),
  tags_json TEXT DEFAULT '[]',
  created_at INTEGER, updated_at INTEGER, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_hosts_group ON hosts(group_id);

CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY, label TEXT NOT NULL,
  kind TEXT CHECK(kind IN ('ed25519','rsa','ecdsa','password')),
  public_key TEXT, fingerprint TEXT,
  secret_blob BLOB NOT NULL,
  created_at INTEGER, updated_at INTEGER, deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash BLOB NOT NULL,
  approval_mode TEXT NOT NULL DEFAULT 'per_command',
  rate_limits_json TEXT DEFAULT '{}',
  created_at INTEGER, revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id),
  host_id TEXT REFERENCES hosts(id),
  kind TEXT CHECK(kind IN ('allow_pattern','ttl_window','deny_extra')),
  pattern TEXT, scope TEXT,
  expires_at INTEGER,
  created_by TEXT, created_at INTEGER, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_policies_agent_host ON policies(agent_id, host_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, host_id TEXT REFERENCES hosts(id),
  kind TEXT CHECK(kind IN ('local','ssh')),
  state TEXT, created_at INTEGER, closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_host ON sessions(host_id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id),
  agent_id TEXT REFERENCES agents(id),
  command TEXT NOT NULL, edited_command TEXT,
  target_summary TEXT,
  status TEXT CHECK(status IN ('pending','approved','denied','timeout','approved_edited','voided')),
  decided_by TEXT, decided_at INTEGER, expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, expires_at);
"#;

/// V5（C8/C5 同批，R15 落表）：主机元数据（收藏/最近连接）+ 传输日志（C5 任务
/// 创建即落行；R32 消费，此处先建表避免 R32 再动 user_version）。旧键迁移在
/// vault::migrate 的 V5 步内做（需读 settings 内容拼 blob，非纯 DDL）。
pub const SCHEMA_V5: &str = r#"
CREATE TABLE IF NOT EXISTS host_metadata (
  host_id TEXT PRIMARY KEY REFERENCES hosts(id),
  favorite INTEGER NOT NULL DEFAULT 0,
  last_connected_at INTEGER
);

CREATE TABLE IF NOT EXISTS transfer_journal (
  task_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT CHECK(kind IN ('upload','download')),
  identity_label TEXT,
  src_path TEXT NOT NULL,
  dst_path TEXT NOT NULL,
  state TEXT NOT NULL,
  bytes_transferred INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER,
  revision INTEGER NOT NULL DEFAULT 0,
  collision_decision TEXT,
  verified INTEGER,
  error TEXT,
  retry_of TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tjournal_session ON transfer_journal(session_id);
"#;
