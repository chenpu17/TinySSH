//! tmux 探测、墙纸快照/输入、面板与恢复。

use super::*;

/// tmux 联动：探测远端 tmux 可用性与会话清单（exec_fresh 独立通道，零屏污染）。
/// 失败保留上次结果（断线横幅展示的是断线前仍在运行的会话）。
#[tauri::command]
pub(crate) async fn tmux_probe(
    state: ApiState<'_>,
    sid: String,
) -> CmdResult<session_api::TmuxStatus> {
    state.api.tmux_probe(&sid).await.map_err(WireError::from)
}

/// tmux 会话大屏（监控墙）：一次 exec 抓全部目标会话当前屏（capture-pane 快照，
/// 只读零客户端零 PTY）。帧协议/上限/降级在 core；Err 时前端保留上一帧继续
/// 呈现，不闪空白。
#[tauri::command]
pub(crate) async fn tmux_wall_snapshot(
    state: ApiState<'_>,
    sid: String,
    targets: Vec<session_api::TmuxWallTarget>,
) -> CmdResult<Vec<session_api::TmuxWallCell>> {
    state
        .api
        .tmux_wall_snapshot(&sid, targets)
        .await
        .map_err(WireError::from)
}

/// tmux 会话大屏输入：把键入送达指定会话（tmux send-keys 服务端 API，零客户端
/// ——小格不挂 attach 客户端就不拽会话窗口尺寸），同一命令立即补拍单格返回
/// （发送+取证一趟往返，不等 2s 节拍）。键名白名单/字面闸在 core。
#[tauri::command]
pub(crate) async fn tmux_wall_input(
    state: ApiState<'_>,
    sid: String,
    target: session_api::TmuxWallTarget,
    lit: String,
    keys: Vec<String>,
) -> CmdResult<session_api::TmuxWallCell> {
    state
        .api
        .tmux_wall_input(&sid, target, lit, keys)
        .await
        .map_err(WireError::from)
}

/// tmux 会话大屏 pane 贴格子：把 pane 调成格子字符预算（resize-window，守卫在
/// core——单窗格；attach 客户端在场照样贴，主视图 attach+大屏同看是主场景）。
/// 回执每格的原窗口尺寸+window-size 选项值——前端留存，关大屏时原样交还
/// tmux_wall_fit_restore（resize-window 会把 window-size 钉成 manual，不还原 =
/// 用户布局永久变形）。300ms 节拍的 pane_height 是「贴上了没」的反馈环。
#[tauri::command]
pub(crate) async fn tmux_wall_fit(
    state: ApiState<'_>,
    sid: String,
    fits: Vec<session_api::TmuxWallFit>,
) -> CmdResult<Vec<session_api::TmuxWallFitResult>> {
    state
        .api
        .tmux_wall_fit(&sid, fits)
        .await
        .map_err(WireError::from)
}

/// tmux 会话大屏关墙恢复：把贴格子借走的窗口几何与 window-size 选项原样交还
/// （core 侧白名单/死字符串消毒）。前端在墙卸载时发起；项为空=无事发生。
#[tauri::command]
pub(crate) async fn tmux_wall_fit_restore(
    state: ApiState<'_>,
    sid: String,
    items: Vec<session_api::TmuxWallRestoreItem>,
) -> CmdResult<()> {
    state
        .api
        .tmux_wall_fit_restore(&sid, items)
        .await
        .map_err(WireError::from)
}

/// tmux 新建会话：远端 `tmux new-session -d -s <名>`（名字白名单/同名预检在
/// core）。创建本身只落后台会话，接入由前端走既有链路（探针刷新 → attach）。
#[tauri::command]
pub(crate) async fn tmux_session_create(
    state: ApiState<'_>,
    sid: String,
    name: String,
) -> CmdResult<()> {
    state
        .api
        .tmux_session_create(&sid, &name)
        .await
        .map_err(WireError::from)
}

/// tmux 联动：恢复现场——先走既有手动重连全机器（会话已连时跳过），再探针
/// 解析目标并 capture-pane 抓近史。attach 由前端经 tmux_attach 二段式下发。
#[tauri::command]
pub(crate) async fn tmux_restore(
    state: ApiState<'_>,
    sid: String,
    session: Option<String>,
) -> CmdResult<session_api::TmuxRestorePlan> {
    state
        .api
        .tmux_restore(&sid, session)
        .await
        .map_err(WireError::from)
}

/// tmux 联动：注入 attach/switch 到 PTY（人类归属）。auto=true（断线自动恢复）
/// 时用户 2s 内刚敲过键则静默跳过。已挂 tmux 的会话自动改走 switch-client。
#[tauri::command]
pub(crate) async fn tmux_attach(
    state: ApiState<'_>,
    sid: String,
    session: String,
    auto: Option<bool>,
) -> CmdResult<()> {
    state
        .api
        .tmux_attach(&sid, &session, auto.unwrap_or(false))
        .await
        .map_err(WireError::from)
}

/// 主视图从 tmux 分离（统一视图语义：× 只关闭当前视图）：回到 shell，tmux
/// 会话与面板格子继续运行。
#[tauri::command]
pub(crate) async fn tmux_detach(state: ApiState<'_>, sid: String) -> CmdResult<()> {
    state.api.tmux_detach(&sid).await.map_err(WireError::from)
}

/// tmux 面板（一标签多 tmux 会话）：同连接开附加交互 PTY 通道跑 `tmux attach`。
/// 防呆（同会话两路视图/同名格去重/存在性核验）在 core；返回 pane_id 供前端
/// 立即挂格子（乐观渲染，不等 3s 快照）。
#[tauri::command]
pub(crate) async fn tmux_pane_open(
    state: ApiState<'_>,
    sid: String,
    session: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> CmdResult<session_api::PaneInfo> {
    state
        .api
        .tmux_pane_open(&sid, &session, cols.unwrap_or(120), rows.unwrap_or(32))
        .await
        .map_err(WireError::from)
}

/// tmux 面板：关闭格子——只拆客户端通道（detach），远端 tmux 会话与其中
/// 进程不受影响。
#[tauri::command]
pub(crate) async fn tmux_pane_close(
    state: ApiState<'_>,
    sid: String,
    pane_id: u32,
) -> CmdResult<()> {
    state
        .api
        .tmux_pane_close(&sid, pane_id)
        .await
        .map_err(WireError::from)
}

/// tmux 面板：格子 PTY 尺寸（window_change）。
#[tauri::command]
pub(crate) async fn tmux_pane_resize(
    state: ApiState<'_>,
    sid: String,
    pane_id: u32,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    state
        .api
        .tmux_pane_resize(&sid, pane_id, cols, rows)
        .await
        .map_err(WireError::from)
}

/// tmux 面板：格子按键（人类键盘直写该通道）。
#[tauri::command]
pub(crate) async fn tmux_pane_input(
    state: ApiState<'_>,
    sid: String,
    pane_id: u32,
    keys: String,
) -> CmdResult<()> {
    state
        .api
        .tmux_pane_input(&sid, pane_id, &keys)
        .await
        .map_err(WireError::from)
}

/// tmux 面板：格子输出订阅（原始字节直通 IPC Channel；单订阅者——订阅即接走
/// core 侧积压）。核心侧流终结时补发一条 JSON `"eof"` 后退出；FE 通道先消失则
/// 直接退出。
#[tauri::command]
pub(crate) async fn tmux_pane_subscribe(
    state: ApiState<'_>,
    sid: String,
    pane_id: u32,
    on_event: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> CmdResult<()> {
    let mut rx = state
        .api
        .tmux_pane_subscribe(&sid, pane_id)
        .map_err(WireError::from)?;
    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            if on_event
                .send(tauri::ipc::InvokeResponseBody::Raw(chunk))
                .is_err()
            {
                return;
            }
        }
        // 流终结 = 核心已摘除此格（用户结束/重建换装/会话关闭；pane_id 不复用）：
        // 通知前端即刻对账，不干等 3s 快照轮询
        let _ = on_event.send(tauri::ipc::InvokeResponseBody::Json("\"eof\"".into()));
    });
    Ok(())
}
