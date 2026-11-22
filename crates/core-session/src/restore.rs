// P3 会话现场恢复：PTY 不跨进程重启，「现场」= 受控退出前的屏幕快照（C10
// ScreenCheckpoint，含滚回历史 + 光标 + 模式）+ 主机身份。快照进 vault settings KV
//（restore.v1）——与凭据同库加密，终端回显可能含敏感内容，不落明文盘。
// 恢复走欢迎页一键入口（点了才连，不自动拨号），每个条目走既有建连全流程
//（TOFU 指纹/双因素原样把关），Ready 后由 FE applyCheckpoint 重放。
// 如实边界：强杀/断电/崩溃来不及快照——只覆盖 FE 退出确认后的受控退出（quit_app）。

use serde::{Deserialize, Serialize};
use session_api::ScreenCheckpoint;

use crate::SessionManager;

pub const RESTORE_KV_KEY: &str = "restore.v1";

/// 单快照保留的滚回尾行数：全量 50K 行序列化过重，恢复语义下尾 300 行足够衔接
/// 「刚才做到哪」；更久的历史随会话日志（用户显式开启）留档。
const TAIL_LINES: usize = 300;
/// 快照条目上限（同主机多会话各占一条；超出丢最旧）。
const MAX_ENTRIES: usize = 8;
/// 单条序列化字节上限（异常巨型 run 不入库；实测尾 300 行远低于此）。
pub(crate) const MAX_ENTRY_BYTES: usize = 256 * 1024;

/// 一个会话的现场快照条目（主机身份 + 屏幕检查点）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestoreEntry {
    pub host_id: String,
    /// 快照时刻（RFC3339）：恢复按钮 tooltip 与恢复后公告行引用。
    pub saved_at: String,
    /// 快照时主视图注入 attach 的 tmux 会话名（#26）：恢复时据此重新接入，
    /// 让现场从「静态画面 + 新 shell」回到活的远端会话。旧快照无此字段。
    #[serde(default)]
    pub tmux_session: Option<String>,
    /// 快照时 tmux 面板格子里的会话名（顺序=格子顺序，#26）：恢复时逐格重开。
    /// 旧快照无此字段。
    #[serde(default)]
    pub tmux_panes: Vec<String>,
    /// 快照时用户给标签起的自定名（KI-103）：标签重命名原是前端纯内存态（按 sid），
    /// 恢复重建的是新 sid，名字无处附着而丢失。改名经 set_tab_name 同步到会话句柄，
    /// 采集时随条目带走，恢复后 FE 回填——名字与快照条目同生同灭。旧快照无此字段。
    #[serde(default)]
    pub tab_name: Option<String>,
    pub checkpoint: ScreenCheckpoint,
}

/// 滚回尾部裁剪：只动**活动缓冲**的头部行（历史在上，滚动语义下头部最旧）；
/// 可视区行与光标（viewport 相对）不受影响，备用缓冲原样（本来就只有空形/小网格）。
pub fn checkpoint_tail(mut ck: ScreenCheckpoint, keep: usize) -> ScreenCheckpoint {
    let lines = &mut ck.buffers[ck.active_buffer as usize].lines;
    if lines.len() > keep {
        lines.drain(..lines.len() - keep);
    }
    ck
}

/// 条目守卫：先逐条按序列化大小过滤（超限跳过，不拖垮整批、不挤占名额），
/// 再丢最旧到 MAX_ENTRIES。独立成函数便于单测（真实巨 grid 难造）。
pub(crate) fn guard_entries(entries: Vec<RestoreEntry>) -> Vec<RestoreEntry> {
    let mut entries: Vec<RestoreEntry> = entries
        .into_iter()
        .filter(|e| {
            serde_json::to_string(e)
                .map(|s| s.len() <= MAX_ENTRY_BYTES)
                .unwrap_or(false)
        })
        .collect();
    if entries.len() > MAX_ENTRIES {
        let drop = entries.len() - MAX_ENTRIES;
        entries.drain(..drop);
    }
    entries
}

impl SessionManager {
    /// 退出快照：全部会话逐个锁屏采集 → 裁尾 → 条目守卫 → 入 vault KV。
    /// 返回实际入库条数。同步入口（quit_app）用 `tauri::async_runtime::block_on` 包。
    pub async fn capture_restore_snapshots(&self) -> usize {
        let handles: Vec<std::sync::Arc<crate::handle::SessionHandle>> = {
            let sessions = self.sessions.lock().unwrap();
            let mut hs: Vec<_> = sessions.values().cloned().collect();
            // #43：sessions 是 HashMap，values() 的顺序每个进程随机——条目序就是
            // FE 恢复时的建标签序，曾因此「恢复后标签位置和之前不同」，且守卫
            // 超限丢头（最旧）也是丢随机的。按真实创建时刻排定（同刻并列用 sid
            // 兜底，SessionId 非时间序、只保证确定）。注意：手工拖拽出的标签序
            // 不在这里持久化（恢复按创建序），见 KI-083。
            hs.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
            hs
        };
        let mut entries: Vec<RestoreEntry> = Vec::with_capacity(handles.len());
        for h in handles {
            // 屏幕锁（tokio）逐个短临界区采集；断线会话的屏幕内容同样有价值
            //（恢复语义是「回到刚才的画面」，重连成不成由既有建连流程如实呈现）
            let ck = h.screen.lock().await.checkpoint();
            // tmux 状态只对 SSH 会话有意义（本机 kind=local 即便残留也不带走）；
            // 两个字段都是会话内内存态，采集时刻与屏幕快照同一拍。
            let (tmux_session, tmux_panes) = if h.kind == "ssh" {
                (
                    h.tmux_attached.lock().unwrap().clone(),
                    h.pane_wishlist.lock().unwrap().clone(),
                )
            } else {
                (None, Vec::new())
            };
            entries.push(RestoreEntry {
                host_id: h.host.id.clone(),
                saved_at: chrono::Utc::now().to_rfc3339(),
                tmux_session,
                tmux_panes,
                // KI-103：标签自定名（前端改名经 set_tab_name 同步到句柄）随快照带走
                tab_name: h.tab_name.lock().unwrap().clone(),
                checkpoint: checkpoint_tail(ck, TAIL_LINES),
            });
        }
        let kept = guard_entries(entries);
        let n = kept.len();
        let json = serde_json::to_string(&kept).unwrap_or_default();
        let _ = self.center.vault.set_setting(RESTORE_KV_KEY, &json);
        n
    }

    /// 读取快照条目（启动时 FE 拉取，欢迎页恢复入口数据源）。
    /// 损坏 → 空表（不阻断启动；下次受控退出会重写修复）。
    pub async fn read_restore_snapshots(&self) -> Vec<RestoreEntry> {
        let raw = match self.center.vault.get_setting(RESTORE_KV_KEY) {
            Ok(Some(s)) => s,
            _ => return Vec::new(),
        };
        serde_json::from_str(&raw).unwrap_or_default()
    }

    /// KI-103：前端标签自定名同步到会话句柄（改名即调，恢复回填后再调一次以保证
    /// 二次退出快照仍带名）。空串/纯空白归一 None（清除语义，展示退回 host_name）。
    /// 纯内存态落句柄、随退出快照带走，不入 vault 独立键。会话已不在（竞态）静默
    /// no-op——改名不该因会话刚关而报错。同步即可（只动两把短临界区锁）。
    pub fn set_tab_name(&self, sid: &str, name: Option<String>) {
        let name = name.and_then(|n| {
            let t = n.trim().to_string();
            if t.is_empty() {
                None
            } else {
                // 审核轮（review-rust）：改名框无 maxlength，超长名会把整条快照顶过
                // 256KB 条目上限、被 guard_entries 整条滤掉——丢的不止名字而是整个
                // 现场（checkpoint+tmux）。按字符截断（中文按字数不按字节）。
                Some(t.chars().take(120).collect())
            }
        });
        let sessions = self.sessions.lock().unwrap();
        if let Some(h) = sessions.get(sid) {
            *h.tab_name.lock().unwrap() = name;
        }
    }
}
