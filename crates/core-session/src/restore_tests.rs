// P3 会话现场恢复测试：采集→入库→读回 round-trip、滚回尾裁剪、空采集清陈旧、
// 损坏 KV 如实给空表、条目守卫。harness 复用 triggers_tests（RecChannel + 真
// SessionManager，sid "s-trg" / host "h-t"）。

use session_api::CellRun;

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
    let n = m.capture_restore_snapshots().await;
    assert_eq!(n, 1, "一个会话应出一条快照");
    let entries = m.read_restore_snapshots().await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].host_id, "h-t");
    assert!(!entries[0].saved_at.is_empty());
    let text: String = entries[0].checkpoint.buffers[entries[0].checkpoint.active_buffer as usize]
        .lines
        .iter()
        .map(|l| l.iter().map(|r| r.text.as_str()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("scene-line-42"), "快照应含现场文本：{text}");
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
