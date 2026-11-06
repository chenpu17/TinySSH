//! 执行记录查询/导出与审计查询。

use super::*;

// ---- ④ 记录审计 GUI：时间线查询 + 明文导出（人类视角全量；Agent 走 MCP 只见自己）----

/// UI 过滤面（camelCase 过桥；kind 走 RecordKind 的 serde snake_case 契约；
/// since 供时间范围筛选，until 供「加载更早」翻页——传已载最旧 ts−1ms 表达严格小于）。
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct RecordsFilterReq {
    session_id: Option<String>,
    agent_id: Option<String>,
    kind: Option<tinyssh_records::RecordKind>,
    since: Option<chrono::DateTime<chrono::Utc>>,
    until: Option<chrono::DateTime<chrono::Utc>>,
    limit: Option<u32>,
}

impl From<RecordsFilterReq> for tinyssh_records::RecordFilter {
    fn from(r: RecordsFilterReq) -> Self {
        tinyssh_records::RecordFilter {
            session_id: r.session_id,
            agent_id: r.agent_id,
            kind: r.kind,
            since: r.since,
            until: r.until,
            limit: r.limit,
        }
    }
}

#[tauri::command]
pub(crate) async fn query_records(
    state: ApiState<'_>,
    filter: Option<RecordsFilterReq>,
) -> CmdResult<Vec<tinyssh_records::RecordEvent>> {
    state
        .api
        .query_records(&human(), filter.map(Into::into).unwrap_or_default())
        .await
        .map_err(WireError::from)
}

#[derive(serde::Serialize)]
pub(crate) struct RecordsExported {
    count: u64,
    path: String,
}

/// 明文导出（人类专属，核心层再校验一次）：落点固定在记录库隔壁
/// `records-export/records-<UTC时间戳>.jsonl`，不开放任意路径写。
#[tauri::command]
pub(crate) async fn export_records(
    state: ApiState<'_>,
    filter: Option<RecordsFilterReq>,
) -> CmdResult<RecordsExported> {
    let dir = state
        .api
        .center
        .records
        .dir()
        .parent()
        .ok_or_else(|| WireError::simple("storage", "记录库目录异常"))?
        .join("records-export");
    std::fs::create_dir_all(&dir).map_err(|e| WireError::simple("storage", e.to_string()))?;
    let to = dir.join(format!(
        "records-{}.jsonl",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    ));
    let count = state
        .api
        .export_records(&human(), filter.map(Into::into).unwrap_or_default(), &to)
        .await
        .map_err(WireError::from)?;
    Ok(RecordsExported {
        count,
        path: to.display().to_string(),
    })
}

/// R41（§6.6「默认当前会话，可切全部；可筛人类/Agent 与事件类型」）：过滤面全量过桥。
/// `sid=None` = 全部会话；`actor_kind` ∈ {human, agent}（未知值不匹配任何行）；
/// `action` 精确匹配动作名；`before_seq` 供「加载更早」按 seq 游标翻页（连续，不重不漏）。
#[tauri::command]
pub(crate) async fn audit_query(
    state: ApiState<'_>,
    sid: Option<String>,
    limit: i64,
    actor_kind: Option<String>,
    action: Option<String>,
    before_seq: Option<i64>,
) -> CmdResult<AuditPage> {
    let f = AuditFilter {
        session_id: sid,
        limit,
        actor_kind,
        action,
        before_seq,
        ..Default::default()
    };
    state
        .api
        .query_audit(&human(), f)
        .await
        .map_err(WireError::from)
}
