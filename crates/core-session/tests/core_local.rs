//! 核心管线集成测试（本地会话）：审批语义、Shell 现场延续、接管作废。

use core_session::SessionManager;
use session_api::*;
use std::sync::Arc;
use std::time::Duration;

async fn manager() -> Arc<SessionManager> {
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
    m.decide_approval(&human(), approval_id, Decision::Deny).await.unwrap();
    let r = jh.await.unwrap();
    assert!(matches!(r, Err(Error::ApprovalDenied { reason: DeniedReason::Denied })));

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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn queue_busy_backpressure() {
    let m = manager().await;
    let sid = m
        .create_session(&human(), CreateSessionReq { host_id: "local".into() })
        .await
        .unwrap();
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
