//! 核心管线集成测试（本地会话）：审批语义、Shell 现场延续、接管作废。

use core_session::SessionManager;
use session_api::*;
use std::sync::Arc;
use std::time::Duration;

async fn manager() -> Arc<SessionManager> {
    // 主密钥走 env（vault 解析序 env > OS 钥匙串）：避免测试二进制重编译后
    // 签名变化触发 macOS 钥匙串授权弹窗并阻塞测试进程。
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t.db");
    // dir 泄漏以覆盖测试生命周期（含 tokio 任务）
    std::mem::forget(dir);
    SessionManager::open(&db).unwrap()
}

fn human() -> Actor {
    Actor::Human
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_exec_and_shell_persistence() {
    let m = manager().await;
    let sid = m
        .create_session(&human(), CreateSessionReq { host_id: "local".into() })
        .await
        .unwrap();

    // Shell 模式（默认）：cd 现场延续
    let r1 = m
        .exec(&human(), sid.clone(), "cd /tmp && echo step1", ExecOpts::default())
        .await
        .unwrap();
    assert_eq!(r1.exit_code, Some(0), "stdout={}", r1.stdout);
    assert!(r1.stdout.contains("step1"), "stdout={}", r1.stdout);

    let r2 = m
        .exec(&human(), sid.clone(), "pwd", ExecOpts::default())
        .await
        .unwrap();
    assert!(r2.stdout.trim().starts_with("/tmp"), "cwd 未延续: {}", r2.stdout);

    // 简报：cwd Confirmed
    let brief = m.get_session_brief(&human(), sid.clone()).await.unwrap();
    let cwd_fact = brief.facts.iter().find(|f| f.subject == "cwd");
    assert!(cwd_fact.is_some());
    assert_eq!(cwd_fact.unwrap().status, Epistemic::Confirmed);
    assert!(brief.cwd.as_deref().unwrap_or("").starts_with("/tmp"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fresh_mode_real_exit_and_replay() {
    let m = manager().await;
    let sid = m
        .create_session(&human(), CreateSessionReq { host_id: "local".into() })
        .await
        .unwrap();

    let r = m
        .exec(
            &human(),
            sid.clone(),
            "echo fresh_out; exit 7",
            ExecOpts { mode: ExecMode::Fresh, ..Default::default() },
        )
        .await
        .unwrap();
    assert_eq!(r.exit_code, Some(7));
    assert_eq!(r.stdout.trim(), "fresh_out");

    // 镜像回放：屏幕可见
    let snap = m.read_screen(&human(), sid.clone()).await.unwrap();
    assert!(snap.text.contains("fresh_out"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn approval_flow_deny_and_approve() {
    let m = manager().await;
    // 注册 agent token
    let token = m.center.vault.create_agent("test-agent", "Test").unwrap();
    let _ = token;
    let sid = m
        .create_session(&human(), CreateSessionReq { host_id: "local".into() })
        .await
        .unwrap();
    // C2（B01/R24）：人建会话初始 Human-owned，Agent 动作前须委托（契约 C2 首次委托）
    m.delegate_session(&human(), sid.clone(), None).await.unwrap();
    let agent = Actor::Agent { client_id: "test-agent".into() };

    // agent exec → 待审批（本地会话不经 create 审批；exec 每条必审）
    let m2 = m.clone();
    let sid2 = sid.clone();
    let jh = tokio::spawn(async move {
        m2.exec(&agent_actor(), sid2, "echo approved_cmd", ExecOpts::default()).await
    });

    // 等待审批卡片出现
    let mut approval_id = None;
    for _ in 0..100 {
        let items = m.list_approvals(&human(), ApprovalFilter { pending_only: true, ..Default::default() }).await.unwrap();
        if let Some(it) = items.first() {
            approval_id = Some(it.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let approval_id = approval_id.expect("审批卡片未出现");

    // 拒绝 → ApprovalDenied{Denied}
    m.decide_approval(&human(), approval_id.clone(), Decision::Deny).await.unwrap();
    let r = jh.await.unwrap();
    assert!(matches!(r, Err(Error::ApprovalDenied { reason: DeniedReason::Denied })));

    // 拒绝审计必须带命令全文（五人走查·陈工：批准带、拒绝不带 = 留痕不对称）
    let page = m.center.audit.query(&AuditFilter {
        action: Some("approval_decision".into()),
        ..Default::default()
    }).unwrap();
    let deny_ev = page.events.iter().find(|e| e.approval_id.as_deref() == Some(approval_id.as_str()))
        .expect("deny 未留 approval_decision 审计");
    assert_eq!(deny_ev.command.as_deref(), Some("echo approved_cmd"), "拒绝审计缺命令全文");
    assert_eq!(deny_ev.payload_json["decision"], "deny");

    // 再提交 → 批准 → 执行成功
    let m3 = m.clone();
    let sid3 = sid.clone();
    let jh2 = tokio::spawn(async move {
        m3.exec(&agent_actor(), sid3, "echo approved_cmd", ExecOpts::default()).await
    });
    let mut approval_id = None;
    for _ in 0..100 {
        let items = m.list_approvals(&human(), ApprovalFilter { pending_only: true, ..Default::default() }).await.unwrap();
        if let Some(it) = items.first() {
            approval_id = Some(it.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    m.decide_approval(&human(), approval_id.unwrap(), Decision::Approve).await.unwrap();
    let r = jh2.await.unwrap().unwrap();
    assert_eq!(r.approval.outcome, ApprovalOutcome::Approved);
    assert!(r.stdout.contains("approved_cmd"));
}

fn agent_actor() -> Actor {
    Actor::Agent { client_id: "test-agent".into() }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn allow_rule_skips_approval() {
    let m = manager().await;
    let _ = m.center.vault.create_agent("test-agent", "Test");
    m.center.vault.add_allow_pattern("test-agent", "echo *", "echo 放行").unwrap();
    let sid = m
        .create_session(&human(), CreateSessionReq { host_id: "local".into() })
        .await
        .unwrap();
    // C2（B01/R24）：人建会话初始 Human-owned，Agent 动作前须委托（契约 C2 首次委托）
    m.delegate_session(&human(), sid.clone(), None).await.unwrap();
    let r = m
        .exec(&agent_actor(), sid, "echo direct", ExecOpts::default())
        .await
        .unwrap();
    assert_eq!(r.approval.outcome, ApprovalOutcome::Auto);
    assert!(r.stdout.contains("direct"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dangerous_pattern_never_approved() {
    let m = manager().await;
    m.center.engine.set_policy(
        "test-agent",
        Policy {
            allow_rules: vec![AllowRule { pattern: "*".into(), note: "全放行".into() }],
            ..Default::default()
        },
    );
    let sid = m
        .create_session(&human(), CreateSessionReq { host_id: "local".into() })
        .await
        .unwrap();
    // C2（B01/R24）：人建会话初始 Human-owned，Agent 动作前须委托（契约 C2 首次委托）
    m.delegate_session(&human(), sid.clone(), None).await.unwrap();
    let r = m
        .exec(&agent_actor(), sid, "reboot", ExecOpts::default())
        .await;
    assert!(matches!(r, Err(Error::ApprovalDenied { reason: DeniedReason::DangerousPattern })));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn takeover_voids_pending_approval_and_card_cannot_revive() {
    let m = manager().await;
    let sid = m
        .create_session(&human(), CreateSessionReq { host_id: "local".into() })
        .await
        .unwrap();
    // C2（B01/R24）：人建会话初始 Human-owned，Agent 动作前须委托（契约 C2 首次委托）
    m.delegate_session(&human(), sid.clone(), None).await.unwrap();

    // agent 提交 exec → 卡片待审批；agent 阻塞中
    let m2 = m.clone();
    let sid2 = sid.clone();
    let jh = tokio::spawn(async move {
        m2.exec(&agent_actor(), sid2, "echo old_request", ExecOpts::default()).await
    });

    let mut approval_id = None;
    for _ in 0..200 {
        let items = m.list_approvals(&human(), ApprovalFilter { pending_only: true, ..Default::default() }).await.unwrap();
        if let Some(it) = items.first() {
            approval_id = Some(it.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let approval_id = approval_id.expect("卡片未出现");

    // 人接管（旧请求待审批 → 接管生效即作废）
    let report = m
        .set_control(&human(), sid.clone(), ControlOwner::Human, ControlOpts::default())
        .await
        .unwrap();
    assert!(report.frozen);
    // 被作废的待审批卡片应已移出 pending 队列（接管即作废）
    let pending = m.list_approvals(&human(), ApprovalFilter { pending_only: true, ..Default::default() }).await.unwrap();
    assert!(pending.iter().all(|it| it.id != approval_id), "作废卡片不得仍为 pending");

    // agent 阻塞调用返回 VoidedByHandback{brief}
    let r = jh.await.unwrap();
    match r {
        Err(Error::VoidedByHandback { brief }) => {
            // 简报应反映接管
            assert!(brief.facts.iter().any(|f| f.subject == "控制权" || f.subject == "SSH 现场"));
        }
        other => panic!("期望 VoidedByHandback，得到 {other:?}"),
    }

    // 卡片状态 voided；再次 decide → 拒绝（卡片不可再生效）
    let items = m.list_approvals(&human(), ApprovalFilter::default()).await.unwrap();
    let card = items.iter().find(|it| it.id == approval_id).unwrap();
    assert_eq!(card.status, ApprovalStatus::Voided);
    let decide = m.decide_approval(&human(), approval_id.clone(), Decision::Approve).await;
    assert!(decide.is_err(), "作废卡片不得再生效");

    // 控制权在人类：agent 动作被拒
    let r = m
        .exec(&agent_actor(), sid.clone(), "echo blocked", ExecOpts::default())
        .await;
    assert!(matches!(r, Err(Error::ControlTakenByHuman)));

    // 人类交还 → agent 先读简报再重新提交（核实后成功）
    m.set_control(&human(), sid.clone(), ControlOwner::Agent, ControlOpts::default()).await.unwrap();
    let brief = m.get_session_brief(&human(), sid.clone()).await.unwrap();
    assert!(!brief.facts.is_empty());

    // Agent 核实现场后重新提交（等价旅程 0.1 的“核实后重新提交”）
    let m4 = m.clone();
    let sid4 = sid.clone();
    let jh3 = tokio::spawn(async move {
        m4.exec(&agent_actor(), sid4, "echo resubmitted", ExecOpts::default()).await
    });
    let mut new_card = None;
    for _ in 0..200 {
        let items = m.list_approvals(&human(), ApprovalFilter { pending_only: true, ..Default::default() }).await.unwrap();
        if let Some(it) = items.first() {
            new_card = Some(it.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    m.decide_approval(&human(), new_card.expect("重新提交的审批卡片未出现"), Decision::Approve).await.unwrap();
    let r = jh3.await.unwrap().unwrap();
    assert!(r.stdout.contains("resubmitted"));

    // 接管作废必须留痕（五人走查·老周）：reason=takeover、命令全文、approval_id 可核对
    let page = m.center.audit.query(&AuditFilter {
        action: Some("approval_voided".into()),
        session_id: Some(sid.clone()),
        ..Default::default()
    }).unwrap();
    let void_ev = page.events.iter().find(|e| e.approval_id.is_some())
        .expect("接管作废未留 approval_voided 审计");
    assert_eq!(void_ev.command.as_deref(), Some("echo old_request"));
    assert_eq!(void_ev.payload_json["reason"], "takeover");
    assert_eq!(void_ev.payload_json["agent"], "test-agent");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn close_session_voided_approval_leaves_audit_trail() {
    // 会话关闭作废同款留痕（五人走查·老周）：卡片消失但审计要能回答「作废了什么、为何作废」
    let m = manager().await;
    let _ = m.center.vault.create_agent("test-agent", "Test");
    let sid = m
        .create_session(&human(), CreateSessionReq { host_id: "local".into() })
        .await
        .unwrap();
    // C2（B01/R24）：人建会话初始 Human-owned，Agent 动作前须委托（契约 C2 首次委托）
    m.delegate_session(&human(), sid.clone(), None).await.unwrap();

    let m2 = m.clone();
    let sid2 = sid.clone();
    let jh = tokio::spawn(async move {
        m2.exec(&agent_actor(), sid2, "echo pending_when_closed", ExecOpts::default()).await
    });
    let mut approval_id = None;
    for _ in 0..200 {
        let items = m.list_approvals(&human(), ApprovalFilter { pending_only: true, ..Default::default() }).await.unwrap();
        if let Some(it) = items.first() {
            approval_id = Some(it.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let approval_id = approval_id.expect("卡片未出现");

    m.close_session(&human(), sid.clone()).await.unwrap();
    // agent 阻塞调用被唤醒（不得空等 120s）
    let r = jh.await.unwrap();
    assert!(matches!(r, Err(Error::VoidedByHandback { .. }) | Err(Error::ApprovalDenied { .. })));

    let page = m.center.audit.query(&AuditFilter {
        action: Some("approval_voided".into()),
        session_id: Some(sid.clone()),
        ..Default::default()
    }).unwrap();
    let void_ev = page.events.iter().find(|e| e.approval_id.as_deref() == Some(approval_id.as_str()))
        .expect("关闭作废未留 approval_voided 审计");
    assert_eq!(void_ev.command.as_deref(), Some("echo pending_when_closed"));
    assert_eq!(void_ev.payload_json["reason"], "session_closed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn send_keys_ctrl_c_interrupts_foreground_process() {
    // 终端基础能力：Ctrl+C（0x03）必须原样直达 PTY，SIGINT 打断前台进程组。
    // 若中断失效，sleep 仍占住 shell 集成的 open block，后续 exec 会以 ExecTimeout 失败。
    let m = manager().await;
    let sid = m
        .create_session(&human(), CreateSessionReq { host_id: "local".into() })
        .await
        .unwrap();

    // 等待 shell 集成注入完成、提示符就绪
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // 前台跑一个长任务（等价 top 占住终端）
    m.send_keys(&human(), sid.clone(), "sleep 60\r").await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Ctrl+C
    m.send_keys(&human(), sid.clone(), "\u{3}").await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;

    // shell 存活且块已闭合：echo 立即执行并返回（中断失败则此处 ExecTimeout）
    let r = m
        .exec(
            &human(),
            sid.clone(),
            "echo alive_after_interrupt",
            ExecOpts { timeout: Some(Duration::from_secs(15)), ..Default::default() },
        )
        .await
        .unwrap();
    assert!(r.stdout.contains("alive_after_interrupt"), "stdout={}", r.stdout);
}

/// T14：⌥← 等 meta/导航序列（ESC 前缀）不是命令文本——登记的话裸 ESC 后的
/// 字母会残留进简报命令行（"…ddd" + \x1bb + Z 显示成 "dddbZ"）。
/// send_keys 对含 ESC 的键入块只写 PTY、不做键入登记。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn human_meta_sequence_not_registered_as_command_text() {
    let m = manager().await;
    let sid = m
        .create_session(&human(), CreateSessionReq { host_id: "local".into() })
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // 模拟 ⌥← 词跳转键序：键入命令 → \x1bb（backward-word）→ 补一个字符 → 回车
    m.send_keys(&human(), sid.clone(), "echo T14META").await.unwrap();
    m.send_keys(&human(), sid.clone(), "\u{1b}b").await.unwrap();
    m.send_keys(&human(), sid.clone(), "Z").await.unwrap();
    m.send_keys(&human(), sid.clone(), "\r").await.unwrap();

    // 等命令块闭合进入简报（命令（human）事实）
    let mut detail = String::new();
    for _ in 0..100 {
        let brief = m.get_session_brief(&human(), sid.clone()).await.unwrap();
        if let Some(f) = brief
            .facts
            .iter()
            .find(|f| f.subject.starts_with("命令") && f.detail.contains("T14META"))
        {
            detail = f.detail.clone();
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(detail.contains("echo T14METAZ"), "键入文本应完整登记：{detail}");
    assert!(!detail.contains("T14METAbZ"), "meta 序列被当成命令文本（b 残留）：{detail}");
}

async fn wait_state(m: &Arc<SessionManager>, sid: &str, want: SessionState, secs: u64) -> bool {
    for _ in 0..(secs * 20) {
        let ss = m.list_sessions(&human()).await.unwrap();
        if ss.iter().any(|s| s.id == sid && s.state == want) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

/// T13：本地会话断线死端 → 一键重连闭环。
/// shell 退出 → Disconnected；重连换新 shell（现场不延续）；白名单核实退出重确认。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_session_manual_reconnect() {
    let m = manager().await;
    let sid = m
        .create_session(&human(), CreateSessionReq { host_id: "local".into() })
        .await
        .unwrap();
    let r = m
        .exec(&human(), sid.clone(), "cd /tmp && echo before_death", ExecOpts::default())
        .await
        .unwrap();
    assert!(r.stdout.contains("before_death"));

    // shell 退出 → 死端（Disconnected）
    m.send_keys(&human(), sid.clone(), "exit\r").await.unwrap();
    assert!(
        wait_state(&m, &sid, SessionState::Disconnected, 15).await,
        "shell 退出后会话应进入 Disconnected"
    );

    // 死端上 exec 明确失败（不得假成功）
    let r = m
        .exec(&human(), sid.clone(), "echo should_fail", ExecOpts::default())
        .await;
    assert!(r.is_err(), "断线会话 exec 应失败: {r:?}");

    // 未断开的会话不可重连（防呆）
    let m2 = manager().await;
    let sid2 = m2
        .create_session(&human(), CreateSessionReq { host_id: "local".into() })
        .await
        .unwrap();
    assert!(m2.reconnect_session(&sid2).await.is_err());

    // 一键重连 → 新 shell；进入重确认（现场事实降级）
    m.reconnect_session(&sid).await.unwrap();
    assert!(
        wait_state(&m, &sid, SessionState::Reconfirming, 15).await,
        "重连后应进入 Reconfirming"
    );

    // 白名单核实（pwd）即执行成功，并触发自动退出重确认 → Connected
    let r = m
        .exec(&human(), sid.clone(), "pwd", ExecOpts::default())
        .await
        .unwrap();
    assert!(r.stdout.trim().starts_with("/"), "重连后应在新 shell（现场不延续）: {}", r.stdout);
    assert!(
        wait_state(&m, &sid, SessionState::Connected, 10).await,
        "核实后应自动退出 Reconfirming"
    );

    // 恢复后 shell 现场延续可用
    let r = m
        .exec(&human(), sid.clone(), "cd /tmp && echo revived", ExecOpts::default())
        .await
        .unwrap();
    assert!(r.stdout.contains("revived"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn queue_busy_backpressure() {
    let m = manager().await;
    let sid = m
        .create_session(&human(), CreateSessionReq { host_id: "local".into() })
        .await
        .unwrap();
    // C2（B01/R24）：人建会话初始 Human-owned，Agent 动作前须委托（契约 C2 首次委托）
    m.delegate_session(&human(), sid.clone(), None).await.unwrap();
    // 占住队列：一条长命令 + 8 条排队 → 第 9 条 QueueBusy
    let m2 = m.clone();
    let sid2 = sid.clone();
    let blocker = tokio::spawn(async move {
        m2.exec(
            &human(),
            sid2,
            "sleep 6",
            ExecOpts { timeout: Some(Duration::from_secs(10)), ..Default::default() },
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    for i in 0..8 {
        let m3 = m.clone();
        let sid3 = sid.clone();
        tokio::spawn(async move {
            let _ = m3
                .exec(&agent_actor(), sid3, &format!("echo q{i}"), ExecOpts::default())
                .await;
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let r = m
        .exec(&agent_actor(), sid.clone(), "echo overflow", ExecOpts::default())
        .await;
    assert!(matches!(r, Err(Error::QueueBusy { position: _ })), "期望 QueueBusy，得到 {r:?}");
    blocker.abort();
}

// ---- 主机指纹门（T17 路线图⑤ TOFU）：需 e2e sshd（TINYSSH_E2E_SSHD=1 + docker tinyssh-e2e）----

async fn wait_pending(m: &SessionManager, host_id: &str) -> PendingHostKey {
    for _ in 0..75 {
        let list = m.pending_host_keys(&human()).await.unwrap();
        if let Some(it) = list.into_iter().find(|it| it.host_id == host_id) {
            return it;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    panic!("host key pending did not appear for {host_id}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn host_key_gate_first_seen_change_and_reject() {
    let lock = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(Duration::from_secs(30)).await;
    if !std::env::var("TINYSSH_E2E_SSHD").map(|v| v == "1").unwrap_or(false) {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let _lock = lock;
    let m = manager().await;
    let hid = m
        .upsert_host(
            &human(),
            HostDraft {
                name: "e2e-gate".into(),
                address: "127.0.0.1".into(),
                port: Some(2222),
                username: "root".into(),
                auth: AuthDraft::Password { password: "testpass".into() },
                tags: vec![],
                ..Default::default()
            },
        )
        .await
        .unwrap();

    // ① 首连：FirstSeen 确认 → 信任后连接成功、指纹入库
    let m2 = m.clone();
    let hid_spawn = hid.clone();
    let t1 = tokio::spawn(async move {
        m2.create_session(&human(), CreateSessionReq { host_id: hid_spawn }).await
    });
    let it = wait_pending(&m, &hid).await;
    assert_eq!(it.issue, HostKeyIssue::FirstSeen);
    assert!(it.fingerprint.starts_with("SHA256:"));
    assert!(it.previous_fingerprint.is_none());
    m.decide_host_key(&human(), &it.id, true).await.unwrap();
    let sid = t1.await.unwrap().expect("first-seen accept should connect");
    assert_eq!(
        m.center.vault.host_fingerprint(&hid).unwrap().as_deref(),
        Some(it.fingerprint.as_str())
    );
    // T34：信任可查证——list_hosts 携带已信任指纹（GUI 卡片 tooltip / 编辑表单 / CLI 同源）
    let trusted = m
        .list_hosts(&human())
        .await
        .unwrap()
        .into_iter()
        .find(|h| h.id == hid)
        .expect("host should be listed");
    assert_eq!(trusted.fingerprint.as_deref(), Some(it.fingerprint.as_str()));
    m.close_session(&human(), sid).await.unwrap();

    // ② 变更告警：预置不一致旧指纹 → Changed；拒绝 → HostKeyRejected 且不改信任记录
    m.center.vault.set_host_fingerprint(&hid, "SHA256:FAKE-OLD").unwrap();
    let m3 = m.clone();
    let hid_spawn = hid.clone();
    let t2 = tokio::spawn(async move {
        m3.create_session(&human(), CreateSessionReq { host_id: hid_spawn }).await
    });
    let it2 = wait_pending(&m, &hid).await;
    assert_eq!(it2.issue, HostKeyIssue::Changed);
    assert_eq!(it2.previous_fingerprint.as_deref(), Some("SHA256:FAKE-OLD"));
    m.decide_host_key(&human(), &it2.id, false).await.unwrap();
    let err = t2.await.unwrap().expect_err("deny must fail the connect");
    assert!(matches!(err, Error::HostKeyRejected(_)), "got: {err:?}");
    assert_eq!(
        m.center.vault.host_fingerprint(&hid).unwrap().as_deref(),
        Some("SHA256:FAKE-OLD")
    );

    // ③ 变更确认：接受 → 连接成功且指纹更新为服务器真实值
    let m4 = m.clone();
    let hid_spawn = hid.clone();
    let t3 = tokio::spawn(async move {
        m4.create_session(&human(), CreateSessionReq { host_id: hid_spawn }).await
    });
    let it3 = wait_pending(&m, &hid).await;
    assert_eq!(it3.issue, HostKeyIssue::Changed);
    m.decide_host_key(&human(), &it3.id, true).await.unwrap();
    let sid3 = t3.await.unwrap().expect("change accept should connect");
    assert_eq!(
        m.center.vault.host_fingerprint(&hid).unwrap().as_deref(),
        Some(it3.fingerprint.as_str())
    );
    m.close_session(&human(), sid3).await.unwrap();
}

// ---- 远端字节编码（T38 路线图⑩后半 GBK）：需 e2e sshd（TINYSSH_E2E_SSHD=1 + docker tinyssh-e2e）----
// 双向实证：远端吐 GBK 字节（printf 八进制）→ 屏/捕获见 UTF-8 中文；
// 命令含中文 → 线上走 GBK 字节、远端原样回显 → 解码后命令文本完好。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gbk_charset_roundtrip_over_ssh() {
    let lock = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(Duration::from_secs(30)).await;
    if !std::env::var("TINYSSH_E2E_SSHD").map(|v| v == "1").unwrap_or(false) {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let _lock = lock;
    let m = manager().await;
    let hid = m
        .upsert_host(
            &human(),
            HostDraft {
                id: None,
                name: "e2e-gbk".into(),
                address: "127.0.0.1".into(),
                port: Some(2222),
                username: "root".into(),
                auth: AuthDraft::Password { password: "testpass".into() },
                tags: vec![],
                charset: Charset::Gbk,
                shell_integration: Some(true),
            },
        )
        .await
        .unwrap();

    // TOFU 首连确认
    let m2 = m.clone();
    let hid_spawn = hid.clone();
    let t = tokio::spawn(async move {
        m2.create_session(&human(), CreateSessionReq { host_id: hid_spawn }).await
    });
    let it = wait_pending(&m, &hid).await;
    m.decide_host_key(&human(), &it.id, true).await.unwrap();
    let sid = t.await.unwrap().expect("gbk host should connect");

    // ① 收方向：远端吐 GBK 字节「中文日志」（D6D0 CEC4 C8D5 D6BE），屏态须见 UTF-8 原文。
    //    若解码缺位，GBK 尾字节（如 D0='0'）会裸进 vt 解析，屏上是乱码/错位。
    let r = m
        .exec(&human(), sid.clone(), r"printf '\326\320\316\304\310\325\326\276\n'", ExecOpts::default())
        .await
        .unwrap();
    assert_eq!(r.exit_code, Some(0), "stdout={}", r.stdout);
    assert!(r.stdout.contains("中文日志"), "GBK 解码缺位，stdout={:?}", r.stdout);

    // ② 发方向：命令含中文，远端以字节级核验落线编码。
    //    「现场笔记」GBK = CF D6 B3 A1 B1 CA BC C7（UTF-8 则是 E7 8E B0…——
    //    od 见到 CF D6 开头即证明 GBK 编码上了链）。注意末两字节 BC C7 会被
    //    远端 readline 丢弃：e2e 容器是 UTF-8 locale，BC C7 不是合法 UTF-8 序列，
    //    行编辑按 locale 丢「非法」字节（真实 GBK 主机跑 GBK locale 无此问题，
    //    这是容器环境语义而非本端缺陷）——故断言前 6 字节。
    let r2 = m
        .exec(&human(), sid.clone(), "echo 现场笔记 | od -An -tx1", ExecOpts::default())
        .await
        .unwrap();
    assert_eq!(r2.exit_code, Some(0), "stdout={}", r2.stdout);
    assert!(r2.stdout.contains("cf d6 b3 a1 b1 ca"),
        "GBK 编码未上链（落线仍是 UTF-8?），stdout={:?}", r2.stdout);
    m.close_session(&human(), sid).await.unwrap();
}
