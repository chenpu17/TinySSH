//! R44（§10.2「建立脱敏迁移 fixture」+ §10.1）：**迁移矩阵与升级演练**。
//!
//! 目的：对迁移链上的每个历史 schema 版本各造一份**脱敏 fixture**，升到链尾，
//! 逐项核对「版本化、幂等、无损、默认正确」——而不是只测「当前版本能开」。
//!
//! 覆盖（§10.1）：
//!   1 旧 `ui.theme`/`ui.font_size` 读取与映射，只有新装才跟随系统；
//!   3 主机/tags/凭据引用/指纹/审计/Agent 身份与 token **保持原主键和含义**，
//!     布局迁移**不导出/不重加密凭据**（`identities.secret_blob` 逐字节不变）；
//!   4 收藏新增为空、最近连接无法获得时为空（不虚构）；
//!   6 以既有 schema 标记区分升级与新装（新装默认停用协作、升级保留旧默认开启）。
//!
//! 手法：fixture 用 SQL 直接构造（不依赖二进制 blob 入库），迁移后用**直连 SQLite**
//! 读原始字节核对——绕开解密路径，才能证明「密文没被重写」。fixture 按目标版本
//! **增量构造**，使 V5/V6 fixture 带上各自迁移本会产出的数据（否则是「缺数据的假
//! 旧库」，测不出真实升级路径）。

use rusqlite::{params, Connection};
use std::path::Path;
use tinyssh_vault::db::{SCHEMA_V1, SCHEMA_V5};
use tinyssh_vault::{migrate, SCHEMA_VERSION};

/// 固定的「已加密凭据」占位密文（脱敏：不是真凭据，只验证迁移是否动它）。
const SEED_SECRET_BLOB: &[u8] = &[0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04, 0xAA, 0xBB];
/// 既有 Agent 的**真实** Token 明文——seed 时用真实 `token_hash()` 落库，
/// 以便迁移后验证「升级不撤销既有 Agent Token」（§10.1-6）：token 仍能解析回身份。
const SEED_AGENT_TOKEN: &str = "TOK-UPGRADE-R44-DEADBEEF";
/// 测试主密钥（hex，32B）——走 env 规避钥匙串（见 R11 登记）。
const TEST_MASTER_KEY_HEX: &str =
    "0909090909090909090909090909090909090909090909090909090909090909";

fn seed_token_hash() -> [u8; 32] {
    tinyssh_vault::token_hash(SEED_AGENT_TOKEN)
}

fn set_key() {
    std::env::set_var("TINYSSH_MASTER_KEY", TEST_MASTER_KEY_HEX);
}

fn seed_common(conn: &Connection) {
    // 先父后子（FK 开启：hosts→identities、policies/sessions→hosts、approvals→sessions）。
    // 凭据：密文占位，迁移后须逐字节不变（不重加密）。
    conn.execute(
        "INSERT INTO identities(id,label,kind,public_key,fingerprint,secret_blob,created_at,updated_at)
         VALUES('i-1','deploy key','ed25519','ssh-ed25519 AAAAC3Nz','SHA256:abc',?1,100,100)",
        params![SEED_SECRET_BLOB],
    )
    .unwrap();
    // Agent 身份与 token（主键与含义须保持）。
    conn.execute(
        "INSERT INTO agents(id,label,token_hash,approval_mode,rate_limits_json,created_at)
         VALUES('a-1','OpenCode',?1,'per_command','{}',100)",
        params![seed_token_hash().as_slice()],
    )
    .unwrap();
    // 主机：SSH 口令认证（带 tags）、local（引用凭据）、软删。
    conn.execute(
        "INSERT INTO hosts(id,name,address,port,username,auth_type,tags_json,created_at,updated_at)
         VALUES('h-ssh','prod-web','10.0.0.1',2222,'ops','password','[\"prod\",\"web\"]',100,100)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO hosts(id,name,address,username,auth_type,identity_id,tags_json,created_at,updated_at)
         VALUES('h-local','local','local','me','key','i-1','[]',100,100)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO hosts(id,name,address,username,auth_type,tags_json,created_at,updated_at,deleted_at)
         VALUES('h-del','gone','10.0.0.9','ops','password','[]',100,100,999)",
        [],
    )
    .unwrap();
    // 策略（引用 agent+host）。
    conn.execute(
        "INSERT INTO policies(id,agent_id,host_id,kind,pattern,created_by,created_at)
         VALUES('p-1','a-1','h-ssh','allow_pattern','echo *','human',100)",
        [],
    )
    .unwrap();
    // 会话 + 审批（外键链：approvals → sessions → hosts）。
    conn.execute(
        "INSERT INTO sessions(id,host_id,kind,state,created_at)
         VALUES('s-1','h-ssh','ssh','closed',100)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO approvals(id,session_id,agent_id,command,target_summary,status,decided_by,decided_at,expires_at)
         VALUES('ap-1','s-1','a-1','df -h','prod-web','approved','human',110,9999999999999)",
        [],
    )
    .unwrap();
    // 审计链（两张同链行；vault 不建此表、不迁移它，此处建表以证明迁移不误伤）。
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS audit_events (
           seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
           actor_kind TEXT, agent_id TEXT, action TEXT NOT NULL, session_id TEXT,
           command TEXT, payload_json TEXT, approval_id TEXT,
           prev_hash TEXT, hash TEXT NOT NULL
         );
         INSERT INTO audit_events(ts,actor_kind,action,session_id,hash)
           VALUES(100,'human','session_created','s-1','h1');
         INSERT INTO audit_events(ts,actor_kind,agent_id,action,session_id,prev_hash,hash)
           VALUES(110,'agent','a-1','exec_approved','s-1','h1','h2');",
    )
    .unwrap();
}

/// 增量构造一份「处于 `target` 版本」的脱敏库（1..=6）。
///
/// 关键：V5/V6 fixture 必须带上**该版本迁移本会产出**的数据（`ui.v2.workspace` blob、
/// `shell_integration` 回填），否则是「缺数据的假旧库」，真实升级路径测不到。
fn build_at(path: &Path, target: u32) {
    assert!((1..=6).contains(&target), "只构造 V1..V6 历史 fixture");
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(SCHEMA_V1).unwrap();
    if target >= 2 {
        conn.execute_batch("ALTER TABLE hosts ADD COLUMN host_fingerprint TEXT;")
            .unwrap();
    }
    if target >= 3 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
    }
    if target >= 4 {
        conn.execute_batch("ALTER TABLE hosts ADD COLUMN charset TEXT NOT NULL DEFAULT 'utf-8';")
            .unwrap();
    }
    if target >= 5 {
        conn.execute_batch(SCHEMA_V5).unwrap();
    }
    if target >= 6 {
        conn.execute_batch("ALTER TABLE hosts ADD COLUMN shell_integration INTEGER;")
            .unwrap();
    }
    seed_common(&conn);
    if target >= 3 {
        conn.execute("INSERT INTO settings VALUES('ui.theme','solar-dark')", [])
            .unwrap();
        conn.execute("INSERT INTO settings VALUES('ui.font_size','16')", [])
            .unwrap();
    }
    if target >= 5 {
        // 模拟 V5 迁移产物：旧键已映射进 v2 blob；字号已复制到命名空间键。
        conn.execute(
            "INSERT INTO settings VALUES('ui.v2.workspace', ?1)",
            params![r#"{"schema_version":1,"chrome":"dark","hostbar":null}"#],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings VALUES('ui.v2.terminal.font_size','16')",
            [],
        )
        .unwrap();
    }
    if target >= 6 {
        // 模拟 V6 迁移产物：存量 SSH 主机一次性置 1（local 与软删行不动）。
        conn.execute_batch(
            "UPDATE hosts SET shell_integration=1 WHERE deleted_at IS NULL AND address != 'local';",
        )
        .unwrap();
    }
    conn.pragma_update(None, "user_version", target as i32)
        .unwrap();
}

fn user_version(path: &Path) -> u32 {
    Connection::open(path)
        .unwrap()
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}

fn scalar_i64(path: &Path, sql: &str) -> i64 {
    Connection::open(path)
        .unwrap()
        .query_row(sql, [], |r| r.get(0))
        .unwrap()
}

fn scalar_text(path: &Path, sql: &str) -> Option<String> {
    Connection::open(path)
        .unwrap()
        .query_row(sql, [], |r| r.get(0))
        .ok()
}

fn scalar_opt_i64(path: &Path, sql: &str) -> Option<i64> {
    Connection::open(path)
        .unwrap()
        .query_row(sql, [], |r| r.get::<_, Option<i64>>(0))
        .unwrap()
}

fn scalar_blob(path: &Path, sql: &str) -> Vec<u8> {
    Connection::open(path)
        .unwrap()
        .query_row(sql, [], |r| r.get(0))
        .unwrap()
}

/// 所有 fixture 的公共断言：升到链尾 + 无损。
fn assert_migrated_lossless(path: &Path, label: &str) {
    assert_eq!(user_version(path), SCHEMA_VERSION, "{label}: 须升到链尾");
    // §10.1-3：主机主键/含义保持（含软删行仍在表内、tags 原样）。
    assert_eq!(
        scalar_text(path, "SELECT name FROM hosts WHERE id='h-ssh'").as_deref(),
        Some("prod-web"),
        "{label}: 主机名保持"
    );
    assert_eq!(
        scalar_text(path, "SELECT tags_json FROM hosts WHERE id='h-ssh'").as_deref(),
        Some("[\"prod\",\"web\"]"),
        "{label}: tags 原样"
    );
    assert_eq!(
        scalar_text(path, "SELECT identity_id FROM hosts WHERE id='h-local'").as_deref(),
        Some("i-1"),
        "{label}: 凭据引用保持"
    );
    assert_eq!(
        scalar_i64(
            path,
            "SELECT COUNT(*) FROM hosts WHERE deleted_at IS NOT NULL"
        ),
        1,
        "{label}: 软删行不被迁移清掉（仍可回查）"
    );
    // §10.1-3：**凭据密文逐字节不变**（不导出、不重加密）。
    assert_eq!(
        scalar_blob(path, "SELECT secret_blob FROM identities WHERE id='i-1'"),
        SEED_SECRET_BLOB.to_vec(),
        "{label}: 凭据密文不得被重加密/改写"
    );
    // §10.1-3：Agent 身份与 token 哈希保持。
    assert_eq!(
        scalar_blob(path, "SELECT token_hash FROM agents WHERE id='a-1'"),
        seed_token_hash().to_vec(),
        "{label}: Agent token 哈希保持"
    );
    // 策略/会话/审批链保持。
    assert_eq!(
        scalar_i64(path, "SELECT COUNT(*) FROM policies"),
        1,
        "{label}: 策略保持"
    );
    assert_eq!(
        scalar_i64(path, "SELECT COUNT(*) FROM sessions"),
        1,
        "{label}: 会话保持"
    );
    assert_eq!(
        scalar_i64(path, "SELECT COUNT(*) FROM approvals"),
        1,
        "{label}: 审批保持"
    );
    // 审计链连续（seq 与 hash 原样，不被迁移打断）。
    assert_eq!(
        scalar_i64(path, "SELECT COUNT(*) FROM audit_events"),
        2,
        "{label}: 审计行保持"
    );
    assert_eq!(
        scalar_text(
            path,
            "SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1"
        )
        .as_deref(),
        Some("h2"),
        "{label}: 审计链尾 hash 保持"
    );
}

/// 每个历史版本各一份 fixture → 迁移 → 无损 → 重开幂等。
#[test]
fn r44_migration_matrix_every_version_is_lossless_and_idempotent() {
    set_key();
    let dir = tempfile::tempdir().unwrap();
    for (label, target) in [("v1", 1u32), ("v3", 3), ("v4", 4), ("v5", 5), ("v6", 6)] {
        let path = dir.path().join(format!("{label}.db"));
        build_at(&path, target);
        // 迁移（走真实 open 路径，含写锁）。
        drop(tinyssh_vault::Vault::open(&path).unwrap());
        assert_migrated_lossless(&path, label);
        // 幂等：再开一次，版本与数据都不变（不重复迁移、不重写 blob）。
        let blob_before = scalar_blob(&path, "SELECT secret_blob FROM identities WHERE id='i-1'");
        drop(tinyssh_vault::Vault::open(&path).unwrap());
        assert_eq!(user_version(&path), SCHEMA_VERSION, "{label}: 重开仍为链尾");
        assert_eq!(
            scalar_blob(&path, "SELECT secret_blob FROM identities WHERE id='i-1'"),
            blob_before,
            "{label}: 重开不得重写凭据密文"
        );
    }
}

/// §10.1-1：旧 `ui.theme` 映射为应用外观（避免升级突变），旧键保留不删。
#[test]
fn r44_legacy_theme_maps_and_keeps_old_keys() {
    set_key();
    let dir = tempfile::tempdir().unwrap();
    // solar-light → light
    let p = dir.path().join("theme-light.db");
    build_at(&p, 4);
    Connection::open(&p)
        .unwrap()
        .execute(
            "UPDATE settings SET value='solar-light' WHERE key='ui.theme'",
            [],
        )
        .unwrap();
    drop(tinyssh_vault::Vault::open(&p).unwrap());
    let blob = scalar_text(&p, "SELECT value FROM settings WHERE key='ui.v2.workspace'").unwrap();
    assert!(
        blob.contains("\"light\""),
        "solar-light 须映射为 light：{blob}"
    );
    // 旧键保留（回退兼容：旧 UI 仍能读到自己的键）
    assert_eq!(
        scalar_text(&p, "SELECT value FROM settings WHERE key='ui.theme'").as_deref(),
        Some("solar-light"),
        "旧键不得被删除"
    );
    assert_eq!(
        scalar_text(
            &p,
            "SELECT value FROM settings WHERE key='ui.v2.terminal.font_size'"
        )
        .as_deref(),
        Some("16"),
        "字号迁到命名空间键"
    );

    // dark 系 → dark（保守，不猜 light）
    let p2 = dir.path().join("theme-dark.db");
    build_at(&p2, 4); // 默认 ui.theme='solar-dark'
    drop(tinyssh_vault::Vault::open(&p2).unwrap());
    let blob2 = scalar_text(
        &p2,
        "SELECT value FROM settings WHERE key='ui.v2.workspace'",
    )
    .unwrap();
    assert!(
        blob2.contains("\"dark\""),
        "solar-dark 须映射为 dark：{blob2}"
    );
}

/// §10.1-1：**只有新装才默认跟随系统**——V1 老库无 `ui.theme` 键时外观取 system；
/// 而 §10.1-6 的协作默认才是「升级 vs 新装」的真正判别点（升级保留旧默认开启）。
#[test]
fn r44_upgrade_without_theme_key_follows_system_but_keeps_collab_on() {
    set_key();
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("nokey.db");
    build_at(&p, 1); // 有 schema 但无 settings 表/无 ui.theme 键 = 升级（不是新装）
    drop(tinyssh_vault::Vault::open(&p).unwrap());
    let blob = scalar_text(&p, "SELECT value FROM settings WHERE key='ui.v2.workspace'").unwrap();
    assert!(blob.contains("\"system\""), "无旧主题键时跟随系统：{blob}");
    assert_eq!(
        scalar_text(&p, "SELECT value FROM settings WHERE key='collab.enabled'").as_deref(),
        Some("1"),
        "有既有 schema 的库按升级处理 → 协作保留旧默认开启"
    );
}

/// §10.1-4：收藏与最近连接**不虚构**——迁移只建空表，不从别处猜。
#[test]
fn r44_favorites_and_recents_start_empty() {
    set_key();
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("meta.db");
    build_at(&p, 5);
    drop(tinyssh_vault::Vault::open(&p).unwrap());
    assert_eq!(
        scalar_i64(&p, "SELECT COUNT(*) FROM host_metadata"),
        0,
        "迁移不得凭空生成收藏/最近连接"
    );
}

/// §10.1-6 + R24：存量 SSH 主机在 V6 迁移一次性置 shell_integration=1；
/// local 与软删行不动。V1 起的老库同样适用（升级路径全覆盖）。
#[test]
fn r44_v6_shell_integration_backfill_on_old_library() {
    set_key();
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("si.db");
    build_at(&p, 1); // V1 老库，无 shell_integration 列
    drop(tinyssh_vault::Vault::open(&p).unwrap());
    assert_eq!(
        scalar_opt_i64(&p, "SELECT shell_integration FROM hosts WHERE id='h-ssh'"),
        Some(1),
        "存量 SSH 主机须一次性置 1（DC3.2：不静默关闭）"
    );
    assert_eq!(
        scalar_opt_i64(&p, "SELECT shell_integration FROM hosts WHERE id='h-local'"),
        None,
        "local 主机不动"
    );
    assert_eq!(
        scalar_opt_i64(&p, "SELECT shell_integration FROM hosts WHERE id='h-del'"),
        None,
        "软删行不动"
    );
}

/// §10.2：**新装**（user_version=0 起建）默认停用协作；**升级**保留旧默认开启。
/// 与 R43 的 vault 单测互补：这里走「矩阵」入口，用真实 fixture 对照两侧。
#[test]
fn r44_fresh_vs_upgrade_collab_default() {
    set_key();
    let dir = tempfile::tempdir().unwrap();
    // 新装：全新路径
    let fresh = dir.path().join("fresh.db");
    drop(tinyssh_vault::Vault::open(&fresh).unwrap());
    assert_eq!(
        scalar_text(
            &fresh,
            "SELECT value FROM settings WHERE key='collab.enabled'"
        )
        .as_deref(),
        Some("0"),
        "新装默认停用协作"
    );
    // 升级：V1 老库
    let up = dir.path().join("up.db");
    build_at(&up, 1);
    drop(tinyssh_vault::Vault::open(&up).unwrap());
    assert_eq!(
        scalar_text(&up, "SELECT value FROM settings WHERE key='collab.enabled'").as_deref(),
        Some("1"),
        "升级保留旧默认开启"
    );
}

/// 迁移不得丢失 settings：全部既有键在迁移后仍可读，且无重复键。
#[test]
fn r44_settings_survive_migration() {
    set_key();
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("keys.db");
    build_at(&p, 5);
    Connection::open(&p)
        .unwrap()
        .execute("INSERT INTO settings VALUES('custom.key','keepme')", [])
        .unwrap();
    drop(tinyssh_vault::Vault::open(&p).unwrap());
    assert_eq!(
        scalar_text(&p, "SELECT value FROM settings WHERE key='custom.key'").as_deref(),
        Some("keepme"),
        "未知/自定义设置键不得在迁移中丢失"
    );
    assert_eq!(
        scalar_i64(
            &p,
            "SELECT COUNT(*) FROM (SELECT key FROM settings GROUP BY key HAVING COUNT(*)>1)"
        ),
        0,
        "settings 不得出现重复键"
    );
}

/// 迁移幂等性：连开 3 次，链尾版本与关键数据保持不变（不重复迁移）。
#[test]
fn r44_repeated_open_is_idempotent() {
    set_key();
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("idem.db");
    build_at(&p, 6);
    for _ in 0..3 {
        drop(tinyssh_vault::Vault::open(&p).unwrap());
        assert_eq!(user_version(&p), SCHEMA_VERSION);
    }
    assert_eq!(scalar_i64(&p, "SELECT COUNT(*) FROM hosts"), 3);
    assert_eq!(
        scalar_opt_i64(&p, "SELECT shell_integration FROM hosts WHERE id='h-ssh'"),
        Some(1)
    );
}

/// `migrate` 对链尾库是纯 no-op：改哨兵值后直接调 `migrate`，哨兵与用户偏好不被重置。
#[test]
fn r44_migrate_on_latest_is_noop() {
    set_key();
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("noop.db");
    drop(tinyssh_vault::Vault::open(&p).unwrap());
    {
        let conn = Connection::open(&p).unwrap();
        conn.execute("INSERT INTO settings VALUES('sentinel','1')", [])
            .unwrap();
        conn.execute(
            "UPDATE settings SET value='user-set' WHERE key='collab.enabled'",
            [],
        )
        .unwrap();
    }
    {
        let conn = Connection::open(&p).unwrap();
        migrate(&conn).unwrap();
    }
    assert_eq!(
        scalar_text(&p, "SELECT value FROM settings WHERE key='collab.enabled'").as_deref(),
        Some("user-set"),
        "链尾库上 migrate 不得改写既有偏好"
    );
    assert_eq!(
        scalar_text(&p, "SELECT value FROM settings WHERE key='sentinel'").as_deref(),
        Some("1"),
        "链尾库上 migrate 不得丢键"
    );
}

/// §10.1-6 + G4 退出条件（「MCP/CLI 能力可用」）：**升级后既有 Agent 仍可用**。
///
/// 造一个 V1 老库，里面已有一个用**真实 token 哈希**落库的 Agent（模拟升级前签发的
/// Token）。升到 V7 后：①token 仍能解析回同一身份（**不撤销既有 Token**）；②Agent
/// 仍在列；③协作按升级默认**开启**（MCP 端点可用，不因新装默认停用而掐断老用户）。
#[test]
fn r44_upgrade_keeps_existing_agent_usable() {
    set_key();
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("agent-upgrade.db");
    build_at(&p, 1);

    // 升级（真实 open 路径，含迁移 + 写锁）
    let v = tinyssh_vault::Vault::open(&p).unwrap();
    // ① 既有 Token 仍解析回身份
    assert_eq!(
        v.resolve_token(SEED_AGENT_TOKEN).map(|c| c.to_string()),
        Some("a-1".to_string()),
        "升级不得撤销既有 Agent Token"
    );
    // ② Agent 仍在列
    let agents = v.list_agents().unwrap();
    assert!(
        agents.iter().any(|(id, _, _)| id == "a-1"),
        "升级后既有 Agent 须仍在列：{agents:?}"
    );
    // ③ 协作按升级默认开启（MCP 端点可用）
    assert!(
        v.collab_enabled().unwrap(),
        "升级须保留旧默认「MCP 开启」，不掐断老用户"
    );
    drop(v);

    // 反面对照：全新安装默认停用（与升级路径区分开）——避免本用例因「恒真」而失去判别力
    let fresh = dir.path().join("fresh.db");
    let vf = tinyssh_vault::Vault::open(&fresh).unwrap();
    assert!(!vf.collab_enabled().unwrap(), "新装默认停用（对照组）");
}
