//! P2-b 输出触发器：引擎（行界/ANSI 剥离/冷却/校验归一）与审批接线
//!（notify 事件、send 建卡→批准才写通道/拒绝不写/Agent 无权）。

use super::*;
use session_api::transport::{ChannelHandle, FreshOutcome, TransportSignal};
use std::sync::Arc;

// ---- 引擎纯单测 ----

fn rule(name: &str, pattern: &str, action: TriggerAction, keys: Option<String>) -> TriggerRule {
    TriggerRule {
        id: String::new(),
        name: name.into(),
        pattern: pattern.into(),
        action,
        keys,
        enabled: true,
        cooldown_secs: 60,
    }
}

#[test]
fn set_rules_validates_and_normalizes() {
    let mut eng = triggers::TriggerEngine::new();
    // 空名称 / 坏正则 / SendKeys 缺键序 —— 各自整体拒绝
    let bad_name = rule("", "x", TriggerAction::Notify, None);
    assert!(matches!(
        eng.set_rules(vec![bad_name]),
        Err(Error::InvalidInput(_))
    ));
    let bad_re = rule("r", "([", TriggerAction::Notify, None);
    assert!(matches!(
        eng.set_rules(vec![bad_re]),
        Err(Error::InvalidInput(_))
    ));
    let no_keys = rule("r", "x", TriggerAction::SendKeys, None);
    assert!(matches!(
        eng.set_rules(vec![no_keys]),
        Err(Error::InvalidInput(_))
    ));
    // 坏转义拒绝（键序存转义原文，set_rules 校验可解码）
    let bad_esc = rule("r", "x", TriggerAction::SendKeys, Some("a\\q".into()));
    assert!(matches!(
        eng.set_rules(vec![bad_esc]),
        Err(Error::InvalidInput(_))
    ));
    // 合法集：id 补齐、冷却 clamp、禁用规则不进编译快照
    let mut disabled = rule("off", "never", TriggerAction::Notify, None);
    disabled.enabled = false;
    disabled.id = "off".into();
    let norm = eng
        .set_rules(vec![
            rule("ok", "error-\\d+", TriggerAction::Notify, None),
            rule("send", "y/n", TriggerAction::SendKeys, Some("y\r".into())),
            {
                let mut r = rule("cd", "x", TriggerAction::Notify, None);
                r.cooldown_secs = 0;
                r
            },
            disabled,
        ])
        .unwrap();
    assert_eq!(norm.len(), 4);
    assert!(norm[0].id.starts_with("t-"));
    assert_eq!(norm[2].cooldown_secs, 5, "冷却下限 clamp 5s");
    assert_eq!(norm[3].id, "off", "传入 id 保留");
    assert_eq!(eng.rules_len(), 3, "禁用规则不进快照");
    // 上限 32
    let many: Vec<TriggerRule> = (0..33)
        .map(|i| rule(&format!("r{i}"), "x", TriggerAction::Notify, None))
        .collect();
    assert!(matches!(eng.set_rules(many), Err(Error::InvalidInput(_))));
}

#[test]
fn ingest_spans_chunks_and_strips_ansi() {
    let mut eng = triggers::TriggerEngine::new();
    eng.set_rules(vec![rule("e", "error-42", TriggerAction::Notify, None)])
        .unwrap();
    // 行跨 chunk 拼接（"err" + "or-42\n"）→ 命中一次
    assert_eq!(eng.ingest("s1", "prefix err").len(), 0);
    let fires = eng.ingest("s1", "or-42 tail\nnext\n");
    assert_eq!(fires.len(), 1);
    assert_eq!(fires[0].matched, "prefix error-42 tail");
    // ANSI 颜色码不干扰命中
    eng.set_rules(vec![rule("c", "ERROR boom", TriggerAction::Notify, None)])
        .unwrap();
    let fires = eng.ingest("s2", "\x1b[31mERROR\x1b[0m boom\n");
    assert_eq!(fires.len(), 1);
    assert_eq!(fires[0].matched, "ERROR boom");
    // 跨行不命中（如实边界）
    eng.set_rules(vec![rule("multi", "a.*b", TriggerAction::Notify, None)])
        .unwrap();
    assert_eq!(eng.ingest("s3", "a\nb\n").len(), 0);
}

#[test]
fn cooldown_throttles_and_drop_session_clears() {
    let mut eng = triggers::TriggerEngine::new();
    eng.set_rules(vec![{
        let mut r = rule("cd", "ping", TriggerAction::Notify, None);
        r.cooldown_secs = 300;
        r
    }])
    .unwrap();
    assert_eq!(eng.ingest("s1", "ping\n").len(), 1);
    assert_eq!(eng.ingest("s1", "ping\n").len(), 0, "冷却期内不重复");
    assert_eq!(eng.ingest("s2", "ping\n").len(), 1, "冷却按会话独立");
    eng.drop_session("s1");
    assert_eq!(eng.ingest("s1", "ping\n").len(), 1, "drop 后冷却清零");
    assert_eq!(eng.ingest("s2", "ping\n").len(), 0, "他 会话冷却不受影响");
}

#[test]
fn strip_ansi_handles_csi_osc_and_st() {
    assert_eq!(triggers::strip_ansi("\x1b[1;32mOK\x1b[0m"), "OK");
    assert_eq!(triggers::strip_ansi("\x1b]0;title\x07tail"), "tail");
    assert_eq!(
        triggers::strip_ansi("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\!"),
        "link!"
    );
    assert_eq!(triggers::strip_ansi("plain"), "plain");
}

// ---- 审批接线（真 ApprovalCenter + 桩通道） ----

struct RecChannel {
    writes: Arc<StdMutex<Vec<Vec<u8>>>>,
}
#[async_trait::async_trait]
impl ChannelHandle for RecChannel {
    fn subscribe_output(&self) -> tokio::sync::broadcast::Receiver<Vec<u8>> {
        let (_tx, rx) = tokio::sync::broadcast::channel(1);
        rx
    }
    async fn write(&self, data: &[u8]) -> Result<()> {
        self.writes.lock().unwrap().push(data.to_vec());
        Ok(())
    }
    async fn resize(&self, _cols: u16, _rows: u16) -> Result<()> {
        Ok(())
    }
    async fn exec_fresh(
        &self,
        _cmd: &str,
        _opts: &ExecOpts,
        _deadline: std::time::Instant,
        _cancel: &session_api::transport::tokio_util_sync::CancellationToken,
    ) -> Result<FreshOutcome> {
        Err(Error::InvalidInput("stub".into()))
    }
    async fn signal(&self, _sig: TransportSignal) -> Result<()> {
        Ok(())
    }
    async fn force_close(&self) -> Result<()> {
        Ok(())
    }
    async fn is_alive(&self) -> bool {
        true
    }
    async fn reconnect(&self) -> Result<()> {
        Ok(())
    }
    async fn close(&self) -> Result<()> {
        Ok(())
    }
    async fn upload(
        &self,
        _local: &std::path::Path,
        _remote: &str,
        _cancel: &session_api::transport::tokio_util_sync::CancellationToken,
        _progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<u64> {
        Err(Error::InvalidInput("stub".into()))
    }
    async fn download(
        &self,
        _remote: &str,
        _local: &std::path::Path,
        _cancel: &session_api::transport::tokio_util_sync::CancellationToken,
        _progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<u64> {
        Err(Error::InvalidInput("stub".into()))
    }
    async fn list_dir(&self, _path: &str) -> Result<Vec<session_api::DirEntryS>> {
        Err(Error::InvalidInput("stub".into()))
    }
}

fn ssh_host() -> Host {
    Host {
        id: "h-t".into(),
        name: "trigger-host".into(),
        address: "10.0.0.9".into(),
        port: 22,
        username: "ops".into(),
        auth_type: AuthType::Password,
        identity_id: None,
        tags: vec![],
        fingerprint: None,
        charset: Charset::Utf8,
        shell_integration: None,
    }
}

fn screen() -> term_core::Screen {
    term_core::Screen::new(term_core::ScreenConfig {
        cols: 80,
        rows: 24,
        scrollback: 100,
        lossless_cap: 1 << 20,
    })
}

pub(crate) async fn harness() -> (
    Arc<SessionManager>,
    Arc<SessionHandle>,
    Arc<StdMutex<Vec<Vec<u8>>>>,
) {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = std::env::temp_dir().join(format!("trg-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let m = SessionManager::open(&dir.join("t.db")).unwrap();
    let writes: Arc<StdMutex<Vec<Vec<u8>>>> = Arc::default();
    let ch = RecChannel {
        writes: writes.clone(),
    };
    let h = SessionHandle::new(
        "s-trg".into(),
        ssh_host(),
        "ssh".into(),
        Arc::new(ch),
        screen(),
        m.center.clone(),
        ControlOwner::Human,
    );
    m.sessions.lock().unwrap().insert(h.id.clone(), h.clone());
    (m, h, writes)
}

#[tokio::test(flavor = "multi_thread")]
async fn notify_fires_event_and_send_needs_approval() {
    let (m, h, writes) = harness().await;
    let norm = m
        .save_triggers(
            &Actor::Human,
            vec![
                rule("fail", "BUILD FAILED", TriggerAction::Notify, None),
                // 键序存转义原文（y + \r 两字符），发送前解码为真实 CR
                rule(
                    "confirm",
                    r"Proceed \(y/n\)",
                    TriggerAction::SendKeys,
                    Some("y\\r".into()),
                ),
            ],
        )
        .await
        .unwrap();
    assert!(norm.iter().all(|r| r.id.starts_with("t-")));

    // Agent 无权读写（规则能自动请求键序发送——人类专属）
    let agent = Actor::Agent {
        client_id: "c1".into(),
    };
    assert!(matches!(
        m.read_triggers(&agent).await,
        Err(Error::InvalidActor)
    ));
    assert!(matches!(
        m.save_triggers(&agent, vec![]).await,
        Err(Error::InvalidActor)
    ));

    // notify 命中 → trigger_tx 事件
    let mut ev_rx = m.center.trigger_tx.subscribe();
    triggers::on_output(&m.center, &h, "…BUILD FAILED in 3.2s\n");
    let ev = ev_rx.try_recv().expect("notify 命中应有事件");
    assert_eq!(ev.rule_name, "fail");
    assert_eq!(ev.action, "notify");
    assert!(ev.matched.contains("BUILD FAILED"));

    // send 命中 → 审批卡（未批准前不写通道）
    triggers::on_output(&m.center, &h, "Proceed (y/n)? \n");
    let card = {
        let items = m.center.items.lock().unwrap();
        items
            .values()
            .find(|it| it.agent_id == "trigger" && it.status == ApprovalStatus::Pending)
            .cloned()
            .expect("send 命中应建审批卡")
    };
    // Debug 格式化会把转义原文里的反斜杠双写（y,\,r → "y\\r"）——卡上人读的仍是转义原文
    assert!(
        card.command.contains(r#"y\\r"#),
        "卡上显示转义原文：{}",
        card.command
    );
    assert!(card.editable, "键序卡可编辑后批准");
    {
        let w = writes.lock().unwrap();
        assert!(w.is_empty(), "未批准不得写通道：{:?}", *w);
    }

    // 批准 → 通道收到**解码后**键序（转义 \r → 真实 CR）
    m.decide_approval(&Actor::Human, card.id.clone(), Decision::Approve)
        .await
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        let got = writes.lock().unwrap().contains(&b"y\r".to_vec());
        if got || std::time::Instant::now() > deadline {
            assert!(got, "批准后应直写键序");
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }

    // 同规则冷却期内再命中 → 不再建卡（上限防审批轰炸）
    triggers::on_output(&m.center, &h, "Proceed (y/n)? again\n");
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    let pending = m
        .center
        .items
        .lock()
        .unwrap()
        .values()
        .filter(|it| it.agent_id == "trigger" && it.status == ApprovalStatus::Pending)
        .count();
    assert_eq!(pending, 0, "冷却期内不应再建卡");
}

#[tokio::test(flavor = "multi_thread")]
async fn deny_leaves_channel_untouched_and_card_settled() {
    let (m, h, writes) = harness().await;
    m.save_triggers(
        &Actor::Human,
        vec![rule(
            "rm",
            r"Really delete\?",
            TriggerAction::SendKeys,
            Some("n\\r".into()),
        )],
    )
    .await
    .unwrap();
    triggers::on_output(&m.center, &h, "Really delete? [yes/no]\n");
    let card = {
        let items = m.center.items.lock().unwrap();
        items
            .values()
            .find(|it| it.agent_id == "trigger" && it.status == ApprovalStatus::Pending)
            .cloned()
            .expect("应建卡")
    };
    m.decide_approval(&Actor::Human, card.id.clone(), Decision::Deny)
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(writes.lock().unwrap().is_empty(), "拒绝后不得写通道");
    let it = m
        .center
        .items
        .lock()
        .unwrap()
        .get(&card.id)
        .cloned()
        .unwrap();
    assert_eq!(it.status, ApprovalStatus::Denied, "卡状态应落 Denied");
}
