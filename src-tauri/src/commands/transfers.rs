//! 上传/下载、冲突决策、SFTP 浏览与路径打开。

use super::*;

/// SFTP 上传（T20）：本地绝对路径 → 远端路径。人类直传（Agent 侧走 MCP 工具且必审），
/// 结果经审计 transfer_done/transfer_failed 广播（payload 带 transfer id 供 UI 对账）。
/// R34：人类路径 collision 恒 None——冲突进 AwaitingDecision 决策卡（DF6.2 参数仅 Agent）。
#[tauri::command]
pub(crate) async fn upload_file(
    state: ApiState<'_>,
    sid: String,
    local: String,
    remote: String,
) -> CmdResult<TransferHandle> {
    state
        .api
        .upload(&human(), sid, std::path::Path::new(&local), &remote, None)
        .await
        .map_err(WireError::from)
}

/// SFTP 下载（T20）：远端路径 → 本地。local 省略时存入 ~/Downloads/<远端文件名>。
#[tauri::command]
pub(crate) async fn download_file(
    state: ApiState<'_>,
    sid: String,
    remote: String,
    local: Option<String>,
) -> CmdResult<TransferHandle> {
    let dest = match local {
        Some(p) => std::path::PathBuf::from(p),
        None => {
            let name = remote
                .rsplit('/')
                .find(|s| !s.is_empty())
                .unwrap_or("download")
                .to_string();
            dirs_or_home().join("Downloads").join(name)
        }
    };
    state
        .api
        .download(&human(), sid, &remote, &dest, None)
        .await
        .map_err(WireError::from)
}

/// 取消进行中的传输（取消语义：传输任务收到 Cancelled，审计记 transfer_failed/已取消）。
#[tauri::command]
pub(crate) async fn cancel_transfer(state: ApiState<'_>, id: String) -> CmdResult<()> {
    state
        .api
        .cancel_transfer(&human(), id)
        .await
        .map_err(WireError::from)
}

/// C6（R34）：冲突裁决提交（乐观锁 expect_revision；StaleDecision/InvalidTransferState
/// 结构化返回——UI 以当前 revision 重同步或收卡）。
#[tauri::command]
pub(crate) async fn submit_collision_decision(
    state: ApiState<'_>,
    id: String,
    decision: String,
    expect_revision: u64,
) -> CmdResult<TransferTask> {
    let d = parse_collision_decision(&decision)?;
    state
        .api
        .submit_collision_decision(&human(), id, d, expect_revision)
        .await
        .map_err(WireError::from)
}

/// C5/R34：显式作废过期决策卡（非待决态幂等 no-op）。
#[tauri::command]
pub(crate) async fn reject_expired_decision(state: ApiState<'_>, id: String) -> CmdResult<()> {
    state
        .api
        .reject_expired_decision(&human(), id)
        .await
        .map_err(WireError::from)
}

/// C6/R34：OutcomeUnknown 复核——journal verified 证据绑定则 Succeeded，否则保持未知。
#[tauri::command]
pub(crate) async fn verify_transfer_outcome(
    state: ApiState<'_>,
    id: String,
) -> CmdResult<TransferTask> {
    state
        .api
        .verify_transfer_outcome(&human(), id)
        .await
        .map_err(WireError::from)
}

pub(crate) fn parse_collision_decision(s: &str) -> Result<session_api::CollisionDecision> {
    match s {
        "skip" => Ok(session_api::CollisionDecision::Skip),
        "overwrite" => Ok(session_api::CollisionDecision::Overwrite),
        "keepboth" => Ok(session_api::CollisionDecision::KeepBoth),
        other => Err(Error::InvalidInput(format!(
            "decision 仅支持 skip|overwrite|keepboth，得到 {other:?}"
        ))),
    }
}

/// C5（R32）：任务注册表查询——UI 重挂对账与事件漏收兜底（创建倒序全量）。
#[tauri::command]
pub(crate) async fn list_transfers(state: ApiState<'_>) -> CmdResult<Vec<TransferTask>> {
    state
        .api
        .list_transfers(&human())
        .await
        .map_err(WireError::from)
}

/// C5/R35：失败重试——以原参数创建新任务（retry_of=旧任务），重新校验连接/
/// 源文件/冲突。仅 Failed/Cancelled/Skipped/Interrupted；OutcomeUnknown 结构化
/// 拒绝（UI 只提供「重新核实」）。
#[tauri::command]
pub(crate) async fn retry_transfer(state: ApiState<'_>, id: String) -> CmdResult<TransferHandle> {
    state
        .api
        .retry_transfer(&human(), id)
        .await
        .map_err(WireError::from)
}

/// C5/R35「定位」（S08）：下载任务在访达中显示本地目标（open -R）。
/// 仅接受已存在的本地路径；上传任务的定位走文件面板导航（FE 域），不经此命令。
#[tauri::command]
pub(crate) async fn reveal_path(path: String) -> CmdResult<()> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(WireError::from(Error::SftpPathNotFound { path }));
    }
    // `--` 终止选项解析：以「-」开头的文件名不会被 open 当作选项（R35 审核 低-6）。
    // Windows 分支（审计 W2）：原实现硬编码 macOS `open`，Windows 上恒 program-not-found
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg("--")
            .arg(&p)
            .spawn()
            .map_err(|e| WireError::from(Error::Io(format!("reveal: {e}"))))?;
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", p.display()))
            .spawn()
            .map_err(|e| WireError::from(Error::Io(format!("reveal: {e}"))))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = p.parent().unwrap_or(&p).to_path_buf();
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| WireError::from(Error::Io(format!("reveal: {e}"))))?;
    }
    Ok(())
}

/// 下载完成卡的「立即打开」：用系统默认程序打开本地文件本身（「定位」开所在
/// 文件夹，本命令开文件——双击语义）。与 reveal_path 同源校验：仅接受已存在的
/// 路径；无关联扩展名由系统「打开方式」选择器兜底，不在应用内预判扩展名。
#[tauri::command]
pub(crate) async fn open_path(path: String) -> CmdResult<()> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(WireError::from(Error::SftpPathNotFound { path }));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("--")
            .arg(&p)
            .spawn()
            .map_err(|e| WireError::from(Error::Io(format!("open: {e}"))))?;
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&p)
            .spawn()
            .map_err(|e| WireError::from(Error::Io(format!("open: {e}"))))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&p)
            .spawn()
            .map_err(|e| WireError::from(Error::Io(format!("open: {e}"))))?;
    }
    Ok(())
}

/// SFTP 目录浏览（T41 FR-7）：只读 readdir，人类专属入口（不经审批）。
/// 稳定轮：截断 5000 条——几万条目的大目录（数据盘/CI 产物）曾全量过 IPC +
/// 全量 DOM，秒级冻结乃至 webview OOM；截断由前端给「结果截断」提示。
#[tauri::command]
pub(crate) async fn sftp_list(
    state: ApiState<'_>,
    sid: String,
    path: String,
) -> CmdResult<Vec<DirEntryS>> {
    let mut es = state
        .api
        .sftp_list(&human(), sid, &path)
        .await
        .map_err(WireError::from)?;
    es.truncate(SFTP_LIST_CAP);
    Ok(es)
}

/// sftp_list 单次返回上限（前端依此长度显示截断提示）。
const SFTP_LIST_CAP: usize = 5000;

/// C4（R30）：路径规范化。path=None → 连接初始目录（SFTP "."）。
#[tauri::command]
pub(crate) async fn sftp_resolve_path(
    state: ApiState<'_>,
    sid: String,
    path: Option<String>,
) -> CmdResult<PathResolved> {
    state
        .api
        .sftp_resolve_path(&human(), sid, path)
        .await
        .map_err(WireError::from)
}

/// C4（R30）：条目元数据（kind/symlink/未知字段语义见 EntryStat）。
#[tauri::command]
pub(crate) async fn sftp_stat(
    state: ApiState<'_>,
    sid: String,
    path: String,
) -> CmdResult<EntryStat> {
    state
        .api
        .sftp_stat(&human(), sid, path)
        .await
        .map_err(WireError::from)
}
