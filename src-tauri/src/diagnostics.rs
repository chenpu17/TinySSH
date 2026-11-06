//! 诊断包导出：版本/环境/运行概况 + 会话日志尾部，固定落点、只读采集。
//!
//! 从 main.rs 抽出（第二波结构拆分）。这里刻意只汇总条数与时间戳，
//! 不写凭据、主机地址/主机名、设置值与审计记录正文。

use crate::{human, ApiState, CmdResult, WireError};
use core_session::SessionManager;
use session_api::{AuditFilter, SessionApi};

// ---- 诊断包导出（export_diagnostics）：供用户报障的脱敏文本包 ----

/// 进程起点（运行时长用）：main() 装配最前 set 一次；get_or_init 兜底
/// （测试/极早调用不 panic，只是时长从首个调用点起算）。
pub(crate) static APP_STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// 诊断包内日志尾部总量上限（字节）：内容硬约束之一，多日志也不超。
const DIAG_LOG_TAIL_CAP: usize = 64 * 1024;

/// 诊断包固定落点：数据目录隔壁 `diagnostics/`，固定命名
/// tinyssh-diagnostics-<UTC>.txt（与 export_records 的 records-export/ 同一
/// 「固定路径+时间戳命名」模式，不开放任意路径写；定位由前端 reveal_path 做）。
fn diagnostics_dir(api: &SessionManager) -> std::path::PathBuf {
    api.data_dir.join("diagnostics")
}

/// 取字符串尾部最多 cap 字节，UTF-8 安全（截断点回退到字符边界）。
/// 日志常含中文/多字节，直接按字节切会撕出非法 UTF-8。
fn utf8_tail(s: &str, cap: usize) -> &str {
    if s.len() <= cap {
        return s;
    }
    let start = s.len() - cap;
    let mut start = start;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// 从已开启会话日志的磁盘文件读尾部：单文件最多 cap 字节（EOF 侧 seek，
/// 不整读大文件），拼完后总量仍钳在 DIAG_LOG_TAIL_CAP（保尾部=保最新）。
/// BufWriter 未冲刷的最后一批（≤64KB/500ms tick）读不到，如实以盘上为准。
/// 只读文件内容，绝不把日志文件路径/文件名写进诊断包（文件名含主机名）。
fn collect_log_tail(paths: &[std::path::PathBuf]) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for p in paths {
        let Ok(mut f) = std::fs::File::open(p) else {
            continue;
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        if len == 0 {
            continue;
        }
        let want = (len as usize).min(DIAG_LOG_TAIL_CAP) as u64;
        use std::io::{Read, Seek, SeekFrom};
        if f.seek(SeekFrom::End(-(want as i64))).is_err() {
            continue;
        }
        let mut buf = String::new();
        if f.take(want).read_to_string(&mut buf).is_err() {
            continue; // 非法 UTF-8 的日志按整段放弃（不输出半截乱码）
        }
        let tail = utf8_tail(buf.trim_start(), DIAG_LOG_TAIL_CAP);
        if !tail.trim().is_empty() {
            parts.push(tail.to_string());
        }
    }
    if parts.is_empty() {
        return None;
    }
    let joined = parts.join("\n");
    Some(utf8_tail(&joined, DIAG_LOG_TAIL_CAP).to_string())
}

/// 诊断包事实面（渲染前先采集齐；结构体里没有任何主机/凭据/设置字段，
/// 从源头保证「想泄也泄不出去」）。
struct DiagFacts {
    version: String,
    build_time: String,
    os: &'static str,
    arch: &'static str,
    uptime: std::time::Duration,
    session_count: usize,
    audit_total: i64,
    audit_latest: Option<chrono::DateTime<chrono::Utc>>,
    log_tail: Option<String>,
}

/// 渲染诊断包文本：每段中文小标题；审计只出条数与最近时间戳（绝无记录正文）；
/// 日志只出尾部纯文本（≤64KB）。
fn render_diagnostics(f: &DiagFacts, generated_at: chrono::DateTime<chrono::Utc>) -> String {
    let secs = f.uptime.as_secs();
    let uptime = if secs >= 3600 {
        format!("{}小时{}分{}秒", secs / 3600, (secs % 3600) / 60, secs % 60)
    } else if secs >= 60 {
        format!("{}分{}秒", secs / 60, secs % 60)
    } else {
        format!("{secs}秒")
    };
    let mut out = String::new();
    out.push_str("TinySSH 诊断包\n");
    out.push_str(&format!(
        "生成时间：{}\n",
        generated_at.format("%Y-%m-%d %H:%M:%S UTC")
    ));
    out.push_str(
        "说明：本文件仅含版本/环境/运行概况与会话日志尾部，不含凭据、主机地址、\n主机名、用户名、设置值，也不含任何审计记录正文。\n",
    );
    out.push_str("\n【应用版本】\n");
    out.push_str(&format!("- 应用版本：{}\n", f.version));
    out.push_str(&format!("- 编译时间：{}\n", f.build_time));
    out.push_str("\n【操作系统与架构】\n");
    out.push_str(&format!("- 操作系统：{}\n", f.os));
    out.push_str(&format!("- 架构：{}\n", f.arch));
    out.push_str("\n【本次运行时长】\n");
    out.push_str(&format!("- 自本次启动已运行：{uptime}\n"));
    out.push_str("\n【当前会话数量】\n");
    out.push_str(&format!("- 当前会话数量：{}\n", f.session_count));
    out.push_str("\n【审计概况（仅条数与最近时间戳，不含任何记录内容）】\n");
    out.push_str(&format!("- 审计记录总条数：{}\n", f.audit_total));
    match f.audit_latest {
        Some(ts) => out.push_str(&format!(
            "- 最近一条记录时间：{}\n",
            ts.format("%Y-%m-%d %H:%M:%S UTC")
        )),
        None => out.push_str("- 最近一条记录时间：无\n"),
    }
    out.push_str("\n【会话日志尾部（纯文本，最多 64KB；不含日志文件路径与文件名）】\n");
    match &f.log_tail {
        Some(tail) => {
            out.push_str("---- 日志尾部开始 ----\n");
            out.push_str(tail);
            if !tail.ends_with('\n') {
                out.push('\n');
            }
            out.push_str("---- 日志尾部结束 ----\n");
        }
        None => out.push_str("（本次运行没有已落盘的会话日志）\n"),
    }
    out
}

/// 导出诊断包（报障自助）：落点固定 `数据目录/diagnostics/tinyssh-diagnostics-
/// <UTC时间戳>.txt`，返回写入路径（前端 toast/reveal 另做）。只读采集
/// （list_sessions / session_log_path / query_audit 均只读），不产生审计记录，
/// 不含任何记录正文/凭据/主机信息/设置值。
#[tauri::command]
pub(crate) async fn export_diagnostics(
    app: tauri::AppHandle,
    state: ApiState<'_>,
) -> CmdResult<String> {
    // 只读三源：会话列表（数量+逐个日志路径）、审计汇总、进程信息
    let sessions = state
        .api
        .list_sessions(&human())
        .await
        .map_err(WireError::from)?;
    let mut log_paths: Vec<std::path::PathBuf> = Vec::new();
    for s in &sessions {
        if let Ok(Some(p)) = state.api.session_log_path(&human(), s.id.clone()).await {
            log_paths.push(std::path::PathBuf::from(p));
        }
    }
    // limit=1：total 是全量计数（不随 limit 缩水），events[0] 即最近一条——
    // 只要汇总面（条数+最近时间戳），绝不取记录正文
    let (audit_total, audit_latest) = match state
        .api
        .query_audit(
            &human(),
            AuditFilter {
                limit: 1,
                ..Default::default()
            },
        )
        .await
    {
        Ok(page) => (page.total, page.events.first().map(|e| e.ts)),
        Err(_) => (0, None), // 审计读不出不阻断导出，如实计 0
    };
    let facts = DiagFacts {
        version: app.package_info().version.to_string(),
        build_time: env!("TINYSSH_BUILD_TIME").to_string(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        uptime: APP_STARTED.get_or_init(std::time::Instant::now).elapsed(),
        session_count: sessions.len(),
        audit_total,
        audit_latest,
        log_tail: collect_log_tail(&log_paths),
    };
    let body = render_diagnostics(&facts, chrono::Utc::now());
    let dir = diagnostics_dir(&state.api);
    std::fs::create_dir_all(&dir).map_err(|e| WireError::simple("storage", e.to_string()))?;
    let to = dir.join(format!(
        "tinyssh-diagnostics-{}.txt",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    ));
    std::fs::write(&to, body).map_err(|e| WireError::simple("storage", e.to_string()))?;
    Ok(to.display().to_string())
}

#[cfg(test)]
mod diagnostics_tests {
    use super::{utf8_tail, DiagFacts, DIAG_LOG_TAIL_CAP};
    use chrono::TimeZone;

    /// UTF-8 安全尾部截断：多字节字符不撕半截；不超 cap；小输入原样返回。
    #[test]
    fn utf8_tail_keeps_char_boundary() {
        // 全 ASCII 直取
        assert_eq!(utf8_tail("abcdef", 3), "def");
        // 中文三字节：cap=4 落在「中」中间 → 回退到「国」边界
        assert_eq!(utf8_tail("中国", 4), "国");
        assert_eq!(utf8_tail("中国", 6), "中国");
        // 不超 cap 原样
        assert_eq!(utf8_tail("中国abc", 64), "中国abc");
        // 64KB 语义：总量钳制生效
        let big = "x".repeat(DIAG_LOG_TAIL_CAP + 10);
        assert_eq!(utf8_tail(&big, DIAG_LOG_TAIL_CAP).len(), DIAG_LOG_TAIL_CAP);
    }

    /// 内容硬约束面：诊断包渲染只含约定字段；审计只出条数与时间戳；
    /// 日志尾部正文进得来、但文件路径/文件名（含主机名）没有进结构体的通道。
    #[test]
    fn render_contains_only_whitelisted_sections() {
        let facts = DiagFacts {
            version: "0.10.0".into(),
            build_time: "2026-10-23 10:00".into(),
            os: "windows",
            arch: "x86_64",
            uptime: std::time::Duration::from_secs(3723),
            session_count: 2,
            audit_total: 123,
            audit_latest: Some(chrono::Utc.with_ymd_and_hms(2026, 10, 23, 8, 0, 0).unwrap()),
            log_tail: Some("例：某段会话输出文本\n".into()),
        };
        let out = super::render_diagnostics(&facts, chrono::Utc::now());
        for title in [
            "【应用版本】",
            "【操作系统与架构】",
            "【本次运行时长】",
            "【当前会话数量】",
            "【审计概况",
            "【会话日志尾部",
        ] {
            assert!(out.contains(title), "缺小标题：{title}");
        }
        assert!(out.contains("应用版本：0.10.0"));
        assert!(out.contains("编译时间：2026-10-23 10:00"));
        assert!(out.contains("windows"));
        assert!(out.contains("x86_64"));
        assert!(out.contains("1小时2分3秒"));
        assert!(out.contains("当前会话数量：2"));
        assert!(out.contains("审计记录总条数：123"));
        assert!(out.contains("2026-10-23 08:00:00 UTC"));
        assert!(out.contains("例：某段会话输出文本"));
        // 无日志 / 审计为空的兜底文案
        let empty = DiagFacts {
            log_tail: None,
            audit_total: 0,
            audit_latest: None,
            ..facts
        };
        let out2 = super::render_diagnostics(&empty, chrono::Utc::now());
        assert!(out2.contains("没有已落盘的会话日志"));
        assert!(out2.contains("最近一条记录时间：无"));
    }
}
