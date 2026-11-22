// P3 会话现场恢复测试：采集→入库→读回 round-trip、滚回尾裁剪、空采集清陈旧、
// 损坏 KV 如实给空表、条目守卫。harness 复用 triggers_tests（RecChannel + 真
// SessionManager，sid "s-trg" / host "h-t"）。

use session_api::{Actor, CellRun, SessionApi};

use super::restore::{checkpoint_tail, guard_entries, RestoreEntry, RESTORE_KV_KEY};
use super::SessionManager;

async fn harness() -> (
    std::sync::Arc<SessionManager>,
    std::sync::Arc<crate::handle::SessionHandle>,
) {
    let (m, h, _w) = super::triggers_tests::harness().await;
    (m, h)
}

#[tokio::test(flavor = "multi_thread")]
async fn capture_roundtrip_contains_scene() {
    let (m, h) = harness().await;
    h.screen
        .lock()
        .await
        .feed(b"echo scene-line-42\r\nscene-line-42\r\n");
    // #26：tmux 现场（主视图 attach + 面板格子）随屏幕快照同拍入库
    *h.tmux_attached.lock().unwrap() = Some("work".into());
    h.pane_wishlist
        .lock()
        .unwrap()
        .extend(["logs".to_string(), "db".to_string()]);
    let n = m.capture_restore_snapshots().await;
    assert_eq!(n, 1, "一个会话应出一条快照");
    let entries = m.read_restore_snapshots().await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].host_id, "h-t");
    assert!(!entries[0].saved_at.is_empty());
    assert_eq!(entries[0].tmux_session.as_deref(), Some("work"));
    assert_eq!(
        entries[0].tmux_panes,
        vec!["logs".to_string(), "db".to_string()]
    );
    let text: String = entries[0].checkpoint.buffers[entries[0].checkpoint.active_buffer as usize]
        .lines
        .iter()
        .map(|l| l.iter().map(|r| r.text.as_str()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("scene-line-42"), "快照应含现场文本：{text}");
}

#[tokio::test(flavor = "multi_thread")]
async fn capture_orders_entries_by_creation_time() {
    // #43：sessions 是 HashMap，采集曾按随机迭代序出条目——恢复时标签顺序
    // 每个进程都可能不同（守卫超限丢的「最旧」也是随机的）。条目必须按会话
    // 创建时刻排定；这里用 tmux_session 给三条同主机条目打标以便断言顺序。
    let (m, h) = harness().await;
    *h.tmux_attached.lock().unwrap() = Some("base".into());
    let base = h.created_at;
    let early =
        super::triggers_tests::add_handle(&m, "s-early", base - chrono::Duration::seconds(30));
    *early.tmux_attached.lock().unwrap() = Some("early".into());
    let late =
        super::triggers_tests::add_handle(&m, "s-late", base + chrono::Duration::seconds(30));
    *late.tmux_attached.lock().unwrap() = Some("late".into());
    // KI-103 审核轮补：多会话各异名——capture 逐句柄取名不得张冠李戴，
    // tab_name 序列必须与 tmux_session 序列（同一条目序）一一对应。
    m.set_tab_name("s-early", Some("早".into()));
    m.set_tab_name("s-trg", Some("中".into()));
    m.set_tab_name("s-late", Some("晚".into()));

    assert_eq!(m.capture_restore_snapshots().await, 3);
    let entries = m.read_restore_snapshots().await;
    let order: Vec<_> = entries
        .iter()
        .map(|e| e.tmux_session.clone().unwrap_or_default())
        .collect();
    assert_eq!(
        order,
        vec!["early", "base", "late"],
        "按创建时刻排定（#43）"
    );
    let names: Vec<_> = entries
        .iter()
        .map(|e| e.tab_name.clone().unwrap_or_default())
        .collect();
    assert_eq!(names, vec!["早", "中", "晚"], "名字随各自条目走，不错位");
}

#[tokio::test(flavor = "multi_thread")]
async fn list_orders_sessions_by_creation_time_not_random_id() {
    // #51/#43 闭环：恢复建连后的 sid 是随机 UUID；若列表继续按 id 排序，快照采集
    // 即使已按创建时刻排好，最终标签仍会被随机重排。故意让 early 的 id 字典序最晚、
    // late 的 id 字典序最早，旧实现必返回 late/base/early，不能靠随机碰巧通过。
    let (m, h) = harness().await;
    let base = h.created_at;
    super::triggers_tests::add_handle(&m, "s-z-early", base - chrono::Duration::seconds(30));
    super::triggers_tests::add_handle(&m, "s-a-late", base + chrono::Duration::seconds(30));

    let sessions = m.list_sessions(&Actor::Human).await.unwrap();
    let order: Vec<_> = sessions.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(order, vec!["s-z-early", "s-trg", "s-a-late"]);
}

#[test]
fn old_snapshot_json_defaults_tmux_fields() {
    // #26 兼容：升级前写入的 restore.v1 没有 tmux 字段，读回必须是空而不是解析失败
    let e = entry_of("h", false);
    let mut v = serde_json::to_value(&e).unwrap();
    let obj = v.as_object_mut().unwrap();
    obj.remove("tmux_session");
    obj.remove("tmux_panes");
    // KI-103 兼容：旧快照同样没有 tab_name 字段，读回须为 None 而非解析失败
    obj.remove("tab_name");
    let back: RestoreEntry = serde_json::from_value(v).unwrap();
    assert_eq!(back.tmux_session, None);
    assert!(back.tmux_panes.is_empty());
    assert_eq!(back.tab_name, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn set_tab_name_flows_into_capture() {
    // KI-103：标签自定名原是前端纯内存态（按 sid），恢复重建新 sid 后丢失。
    // 改名经 set_tab_name 落句柄 → 退出快照随条目带走 → 读回仍在。
    let (m, h) = harness().await;
    h.screen.lock().await.feed(b"scene\r\n");
    // 未改名：快照不带名（展示退回 host_name）
    assert_eq!(m.capture_restore_snapshots().await, 1);
    assert_eq!(m.read_restore_snapshots().await[0].tab_name, None);
    // 改名后采集：名字随快照带走；前后空白被 trim（FE 回填端二次 trim 会掩盖
    // vault 脏数据，这里直接钉「入库即归一」）
    m.set_tab_name("s-trg", Some("  生产数据库  ".into()));
    assert_eq!(m.capture_restore_snapshots().await, 1);
    assert_eq!(
        m.read_restore_snapshots().await[0].tab_name.as_deref(),
        Some("生产数据库")
    );
    // 显式 None = 清除（FE 清名生产路径传的就是 null 不是空白串）：实现若误写成
    // if let Some(n)（None 不覆盖旧值），生产清名会静默失效，这里必红
    m.set_tab_name("s-trg", None);
    assert_eq!(m.capture_restore_snapshots().await, 1);
    assert_eq!(m.read_restore_snapshots().await[0].tab_name, None);
    // 空串/纯空白 = 清除（归一 None）
    m.set_tab_name("s-trg", Some("   ".into()));
    assert_eq!(m.capture_restore_snapshots().await, 1);
    assert_eq!(m.read_restore_snapshots().await[0].tab_name, None);
    // 会话已不在（竞态）：静默 no-op，不 panic、不误写他会话
    m.set_tab_name("s-gone", Some("幽灵".into()));
    assert_eq!(m.capture_restore_snapshots().await, 1);
    assert_eq!(m.read_restore_snapshots().await[0].tab_name, None);
    // 超长名按字符截断（审核轮 review-rust）：名字不许把整条现场顶过 256KB 条目
    // 上限被 guard_entries 整条滤掉——45 万字节的纯中文名若无截断必让条目消失
    m.set_tab_name("s-trg", Some("名".repeat(150_000)));
    assert_eq!(m.capture_restore_snapshots().await, 1, "超长名不得挤掉整条现场");
    let back = m.read_restore_snapshots().await.remove(0).tab_name.unwrap();
    assert_eq!(back.chars().count(), 120, "截断到 120 字符");
}

#[test]
fn checkpoint_tail_keeps_tail_and_cursor() {
    let line = |t: &str| {
        vec![CellRun {
            text: t.into(),
            fg: None,
            bg: None,
            flags: 0,
        }]
    };
    let mk = |n: usize, cur_y: u32| session_api::ScreenCheckpoint {
        cols: 80,
        rows: 24,
        buffers: [
            session_api::BufferCheckpoint {
                lines: (0..n).map(|i| line(&format!("L{i}"))).collect(),
            },
            session_api::BufferCheckpoint { lines: vec![] },
        ],
        active_buffer: 0,
        cursor: session_api::CursorState {
            x: 3,
            y: cur_y,
            visible: true,
            style: "block".into(),
        },
        modes: session_api::ScreenModes {
            autowrap: true,
            application_cursor: false,
            bracketed_paste: false,
            origin_mode: false,
        },
        title: None,
    };
    let ck = mk(10, 5);
    let tail = checkpoint_tail(ck, 3);
    let lines = &tail.buffers[0].lines;
    assert_eq!(lines.len(), 3, "只留尾 3 行");
    assert_eq!(lines[2][0].text, "L9", "尾部行保持原序");
    assert_eq!(lines[0][0].text, "L7");
    assert_eq!(tail.cursor.y, 5, "光标 viewport 相对，不受历史裁剪影响");
    assert_eq!(tail.cursor.x, 3);
    // 备用缓冲原样
    assert!(tail.buffers[1].lines.is_empty());
    // keep > 行数：原样
    let ck2 = checkpoint_tail(mk(3, 0), 300);
    assert_eq!(ck2.buffers[0].lines.len(), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn empty_capture_clears_stale_entries() {
    let (m, h) = harness().await;
    // 先存一条陈旧快照
    h.screen.lock().await.feed(b"old\r\n");
    assert_eq!(m.capture_restore_snapshots().await, 1);
    assert_eq!(m.read_restore_snapshots().await.len(), 1);
    // 模拟会话全关：从表里摘掉句柄再采集 → 覆盖为空表（陈旧现场不复活）
    m.sessions.lock().unwrap().remove("s-trg");
    assert_eq!(m.capture_restore_snapshots().await, 0);
    assert!(
        m.read_restore_snapshots().await.is_empty(),
        "陈旧快照应被清掉"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn corrupt_kv_reads_empty() {
    let (m, _h) = harness().await;
    m.center
        .vault
        .set_setting(RESTORE_KV_KEY, "{{not json")
        .unwrap();
    assert!(
        m.read_restore_snapshots().await.is_empty(),
        "损坏配置不阻断，给空表"
    );
}

fn entry_of(host: &str, huge: bool) -> RestoreEntry {
    RestoreEntry {
        host_id: host.into(),
        saved_at: "t".into(),
        tmux_session: None,
        tmux_panes: Vec::new(),
        tab_name: None,
        checkpoint: session_api::ScreenCheckpoint {
            cols: 80,
            rows: 24,
            buffers: [
                session_api::BufferCheckpoint {
                    lines: vec![vec![CellRun {
                        text: if huge {
                            "x".repeat(300 * 1024)
                        } else {
                            "ok".into()
                        },
                        fg: None,
                        bg: None,
                        flags: 0,
                    }]],
                },
                session_api::BufferCheckpoint { lines: vec![] },
            ],
            active_buffer: 0,
            cursor: session_api::CursorState {
                x: 0,
                y: 0,
                visible: true,
                style: "block".into(),
            },
            modes: session_api::ScreenModes {
                autowrap: true,
                application_cursor: false,
                bracketed_paste: false,
                origin_mode: false,
            },
            title: None,
        },
    }
}

#[test]
fn guard_entries_caps_and_filters_oversize() {
    // 9 条合法 + 1 条超限（300KB 文本）→ 超限先滤（9 条），再裁条目上限到 8；
    // 条目上限：12 条合法 → 丢最旧 4 条。
    let mut entries: Vec<RestoreEntry> =
        (0..9).map(|i| entry_of(&format!("h{i}"), false)).collect();
    entries.push(entry_of("h-huge", true));
    let kept = guard_entries(entries);
    assert_eq!(kept.len(), 8, "滤超限后 9 条合法，再裁到条目上限 8");
    assert!(kept.iter().all(|e| e.host_id != "h-huge"), "超限条目应被滤");
    assert_eq!(kept[0].host_id, "h1", "丢最旧");
    let many: Vec<RestoreEntry> = (0..12).map(|i| entry_of(&format!("h{i}"), false)).collect();
    let kept2 = guard_entries(many);
    assert_eq!(kept2.len(), 8);
    assert_eq!(kept2[0].host_id, "h4", "丢最旧");
}
