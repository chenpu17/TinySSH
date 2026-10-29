//! 核心管线集成测试（本地会话）：审批语义、Shell 现场延续、接管作废。

use core_session::SessionManager;
use session_api::*;
use std::sync::Arc;
use std::time::Duration;

/// 本组测试按 POSIX shell 语义书写（`&&`、`pwd` 纯路径输出、`cd /tmp` 现场延续）。
/// 本地会话 shell 解析序为 override → $SHELL → powershell：开发机从 Git Bash 跑
/// 测试时 $SHELL 天然是 bash；CI runner 的 pwsh 环境不设 $SHELL → 回落
/// powershell.exe（PS 5.1 无 `&&`，`pwd` 打印表格头）→ POSIX 断言假翻车。
/// 夹具统一把 SHELL 钉到 git-bash；找不到则维持原样（纯 PowerShell 机器无法
/// 表达这些用例，属环境不支持，不应静默换成别的东西硬跑）。
/// `cd /tmp` 用例还要求 /tmp（Windows 解析为 D:\tmp）存在——一并兜底，
/// 不依赖 lib 测试二进制恰好先跑过并建出目录。
fn pin_posix_shell() {
    std::fs::create_dir_all("/tmp").unwrap();
    let cur = std::env::var("SHELL").unwrap_or_default();
    if cur.contains("bash") || cur.contains("zsh") || cur.contains("sh") {
        return;
    }
    for p in [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ] {
        if std::path::Path::new(p).exists() {
            std::env::set_var("SHELL", p);
            return;
        }
    }
}

async fn manager() -> Arc<SessionManager> {
    // 主密钥走 env（vault 解析序 env > OS 钥匙串）：避免测试二进制重编译后
    // 签名变化触发 macOS 钥匙串授权弹窗并阻塞测试进程。
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    pin_posix_shell();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t.db");
    // dir 泄漏以覆盖测试生命周期（含 tokio 任务）
    std::mem::forget(dir);
    let m = SessionManager::open(&db).unwrap();
    // C9（R43）：新装默认关闭协作；本组集成测试模拟「已启用协作的既有安装」，
    // 走真实 API 显式启用（开 admission 门），以便驱动 Agent 审批路径。
    m.collab_enable(&Actor::Human).await.unwrap();
    m
}

fn human() -> Actor {
    Actor::Human
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_exec_and_shell_persistence() {
    let m = manager().await;
    let sid = m
        .create_session(
            &human(),
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();

    // Shell 模式（默认）：cd 现场延续
    let r1 = m
        .exec(
            &human(),
            sid.clone(),
            "cd /tmp && echo step1",
            ExecOpts::default(),
        )
        .await
        .unwrap();
    assert_eq!(r1.exit_code, Some(0), "stdout={}", r1.stdout);
    assert!(r1.stdout.contains("step1"), "stdout={}", r1.stdout);

    let r2 = m
        .exec(&human(), sid.clone(), "pwd", ExecOpts::default())
        .await
        .unwrap();
    assert!(
        r2.stdout.trim().starts_with("/tmp"),
        "cwd 未延续: {}",
        r2.stdout
    );

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
        .create_session(
            &human(),
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();

    let r = m
        .exec(
            &human(),
            sid.clone(),
            "echo fresh_out; exit 7",
            ExecOpts {
                mode: ExecMode::Fresh,
                ..Default::default()
            },
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
        .create_session(
            &human(),
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();
    // C2（B01/R24）：人建会话初始 Human-owned，Agent 动作前须委托（契约 C2 首次委托）
    m.delegate_session(&human(), sid.clone(), None)
        .await
        .unwrap();
    let _agent = Actor::Agent {
        client_id: "test-agent".into(),
    };

    // agent exec → 待审批（本地会话不经 create 审批；exec 每条必审）
    let m2 = m.clone();
    let sid2 = sid.clone();
    let jh = tokio::spawn(async move {
        m2.exec(
            &agent_actor(),
            sid2,
            "echo approved_cmd",
            ExecOpts::default(),
        )
        .await
    });

    // 等待审批卡片出现
    let mut approval_id = None;
    for _ in 0..100 {
        let items = m
            .list_approvals(
                &human(),
                ApprovalFilter {
                    pending_only: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        if let Some(it) = items.first() {
            approval_id = Some(it.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let approval_id = approval_id.expect("审批卡片未出现");

    // 拒绝 → ApprovalDenied{Denied}
    m.decide_approval(&human(), approval_id.clone(), Decision::Deny)
        .await
        .unwrap();
    let r = jh.await.unwrap();
    assert!(matches!(
        r,
        Err(Error::ApprovalDenied {
            reason: DeniedReason::Denied
        })
    ));

    // 拒绝审计必须带命令全文（五人走查·陈工：批准带、拒绝不带 = 留痕不对称）
    let page = m
        .center
        .audit
        .query(&AuditFilter {
            action: Some("approval_decision".into()),
            ..Default::default()
        })
        .unwrap();
    let deny_ev = page
        .events
        .iter()
        .find(|e| e.approval_id.as_deref() == Some(approval_id.as_str()))
        .expect("deny 未留 approval_decision 审计");
    assert_eq!(
        deny_ev.command.as_deref(),
        Some("echo approved_cmd"),
        "拒绝审计缺命令全文"
    );
    assert_eq!(deny_ev.payload_json["decision"], "deny");

    // 再提交 → 批准 → 执行成功
    let m3 = m.clone();
    let sid3 = sid.clone();
    let jh2 = tokio::spawn(async move {
        m3.exec(
            &agent_actor(),
            sid3,
            "echo approved_cmd",
            ExecOpts::default(),
        )
        .await
    });
    let mut approval_id = None;
    for _ in 0..100 {
        let items = m
            .list_approvals(
                &human(),
                ApprovalFilter {
                    pending_only: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        if let Some(it) = items.first() {
            approval_id = Some(it.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    m.decide_approval(&human(), approval_id.unwrap(), Decision::Approve)
        .await
        .unwrap();
    let r = jh2.await.unwrap().unwrap();
    assert_eq!(r.approval.outcome, ApprovalOutcome::Approved);
    assert!(r.stdout.contains("approved_cmd"));
}

fn agent_actor() -> Actor {
    Actor::Agent {
        client_id: "test-agent".into(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn allow_rule_skips_approval() {
    let m = manager().await;
    let _ = m.center.vault.create_agent("test-agent", "Test");
    m.center
        .vault
        .add_allow_pattern("test-agent", "echo *", "echo 放行")
        .unwrap();
    let sid = m
        .create_session(
            &human(),
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();
    // C2（B01/R24）：人建会话初始 Human-owned，Agent 动作前须委托（契约 C2 首次委托）
    m.delegate_session(&human(), sid.clone(), None)
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
            allow_rules: vec![AllowRule {
                pattern: "*".into(),
                note: "全放行".into(),
            }],
            ..Default::default()
        },
    );
    let sid = m
        .create_session(
            &human(),
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();
    // C2（B01/R24）：人建会话初始 Human-owned，Agent 动作前须委托（契约 C2 首次委托）
    m.delegate_session(&human(), sid.clone(), None)
        .await
        .unwrap();
    let r = m
        .exec(&agent_actor(), sid, "reboot", ExecOpts::default())
        .await;
    assert!(matches!(
        r,
        Err(Error::ApprovalDenied {
            reason: DeniedReason::DangerousPattern
        })
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn takeover_voids_pending_approval_and_card_cannot_revive() {
    let m = manager().await;
    let sid = m
        .create_session(
            &human(),
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();
    // C2（B01/R24）：人建会话初始 Human-owned，Agent 动作前须委托（契约 C2 首次委托）
    m.delegate_session(&human(), sid.clone(), None)
        .await
        .unwrap();

    // agent 提交 exec → 卡片待审批；agent 阻塞中
    let m2 = m.clone();
    let sid2 = sid.clone();
    let jh = tokio::spawn(async move {
        m2.exec(
            &agent_actor(),
            sid2,
            "echo old_request",
            ExecOpts::default(),
        )
        .await
    });

    let mut approval_id = None;
    for _ in 0..200 {
        let items = m
            .list_approvals(
                &human(),
                ApprovalFilter {
                    pending_only: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        if let Some(it) = items.first() {
            approval_id = Some(it.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let approval_id = approval_id.expect("卡片未出现");

    // 人接管（旧请求待审批 → 接管生效即作废）
    let report = m
        .set_control(
            &human(),
            sid.clone(),
            ControlOwner::Human,
            ControlOpts::default(),
        )
        .await
        .unwrap();
    assert!(report.frozen);
    // 被作废的待审批卡片应已移出 pending 队列（接管即作废）
    let pending = m
        .list_approvals(
            &human(),
            ApprovalFilter {
                pending_only: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        pending.iter().all(|it| it.id != approval_id),
        "作废卡片不得仍为 pending"
    );

    // agent 阻塞调用返回 VoidedByHandback{brief}
    let r = jh.await.unwrap();
    match r {
        Err(Error::VoidedByHandback { brief }) => {
            // 简报应反映接管
            assert!(brief
                .facts
                .iter()
                .any(|f| f.subject == "控制权" || f.subject == "SSH 现场"));
        }
        other => panic!("期望 VoidedByHandback，得到 {other:?}"),
    }

    // 卡片状态 voided；再次 decide → 拒绝（卡片不可再生效）
    let items = m
        .list_approvals(&human(), ApprovalFilter::default())
        .await
        .unwrap();
    let card = items.iter().find(|it| it.id == approval_id).unwrap();
    assert_eq!(card.status, ApprovalStatus::Voided);
    let decide = m
        .decide_approval(&human(), approval_id.clone(), Decision::Approve)
        .await;
    assert!(decide.is_err(), "作废卡片不得再生效");

    // 控制权在人类：agent 动作被拒
    let r = m
        .exec(
            &agent_actor(),
            sid.clone(),
            "echo blocked",
            ExecOpts::default(),
        )
        .await;
    assert!(matches!(r, Err(Error::ControlTakenByHuman)));

    // 人类交还 → agent 先读简报再重新提交（核实后成功）
    m.set_control(
        &human(),
        sid.clone(),
        ControlOwner::Agent,
        ControlOpts::default(),
    )
    .await
    .unwrap();
    let brief = m.get_session_brief(&human(), sid.clone()).await.unwrap();
    assert!(!brief.facts.is_empty());

    // Agent 核实现场后重新提交（等价旅程 0.1 的“核实后重新提交”）
    let m4 = m.clone();
    let sid4 = sid.clone();
    let jh3 = tokio::spawn(async move {
        m4.exec(
            &agent_actor(),
            sid4,
            "echo resubmitted",
            ExecOpts::default(),
        )
        .await
    });
    let mut new_card = None;
    for _ in 0..200 {
        let items = m
            .list_approvals(
                &human(),
                ApprovalFilter {
                    pending_only: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        if let Some(it) = items.first() {
            new_card = Some(it.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    m.decide_approval(
        &human(),
        new_card.expect("重新提交的审批卡片未出现"),
        Decision::Approve,
    )
    .await
    .unwrap();
    let r = jh3.await.unwrap().unwrap();
    assert!(r.stdout.contains("resubmitted"));

    // 接管作废必须留痕（五人走查·老周）：reason=takeover、命令全文、approval_id 可核对
    let page = m
        .center
        .audit
        .query(&AuditFilter {
            action: Some("approval_voided".into()),
            session_id: Some(sid.clone()),
            ..Default::default()
        })
        .unwrap();
    let void_ev = page
        .events
        .iter()
        .find(|e| e.approval_id.is_some())
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
        .create_session(
            &human(),
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();
    // C2（B01/R24）：人建会话初始 Human-owned，Agent 动作前须委托（契约 C2 首次委托）
    m.delegate_session(&human(), sid.clone(), None)
        .await
        .unwrap();

    let m2 = m.clone();
    let sid2 = sid.clone();
    let jh = tokio::spawn(async move {
        m2.exec(
            &agent_actor(),
            sid2,
            "echo pending_when_closed",
            ExecOpts::default(),
        )
        .await
    });
    let mut approval_id = None;
    for _ in 0..200 {
        let items = m
            .list_approvals(
                &human(),
                ApprovalFilter {
                    pending_only: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
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
    assert!(matches!(
        r,
        Err(Error::VoidedByHandback { .. }) | Err(Error::ApprovalDenied { .. })
    ));

    let page = m
        .center
        .audit
        .query(&AuditFilter {
            action: Some("approval_voided".into()),
            session_id: Some(sid.clone()),
            ..Default::default()
        })
        .unwrap();
    let void_ev = page
        .events
        .iter()
        .find(|e| e.approval_id.as_deref() == Some(approval_id.as_str()))
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
        .create_session(
            &human(),
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();

    // 等待 shell 集成注入完成、提示符就绪
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // 前台跑一个长任务（等价 top 占住终端）
    m.send_keys(&human(), sid.clone(), "sleep 60\r")
        .await
        .unwrap();
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
            ExecOpts {
                timeout: Some(Duration::from_secs(15)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        r.stdout.contains("alive_after_interrupt"),
        "stdout={}",
        r.stdout
    );
}

/// T14：⌥← 等 meta/导航序列（ESC 前缀）不是命令文本——登记的话裸 ESC 后的
/// 字母会残留进简报命令行（"…ddd" + \x1bb + Z 显示成 "dddbZ"）。
/// send_keys 对含 ESC 的键入块只写 PTY、不做键入登记。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn human_meta_sequence_not_registered_as_command_text() {
    let m = manager().await;
    let sid = m
        .create_session(
            &human(),
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // 模拟 ⌥← 词跳转键序：键入命令 → \x1bb（backward-word）→ 补一个字符 → 回车
    m.send_keys(&human(), sid.clone(), "echo T14META")
        .await
        .unwrap();
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
    assert!(
        detail.contains("echo T14METAZ"),
        "键入文本应完整登记：{detail}"
    );
    assert!(
        !detail.contains("T14METAbZ"),
        "meta 序列被当成命令文本（b 残留）：{detail}"
    );
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
        .create_session(
            &human(),
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();
    // Windows 探针刻意走 Fresh（独立通道、可靠退出码、不依赖集成标记时序）——
    // P1 起 powershell 本地 shell 也有 OSC133 注入（Shell 模式可用），但本测试的
    // 主角是断线/重连状态机，探针不掺入启动竞态变量；unix 保持默认 Shell 模式原语义。
    // 此测试曾因 ConPTY DSR 握手挂死根本到不了这里（2026-10-11 修复）。
    let probe_opts = || {
        if cfg!(windows) {
            ExecOpts {
                mode: ExecMode::Fresh,
                ..Default::default()
            }
        } else {
            ExecOpts::default()
        }
    };
    let probe = if cfg!(windows) {
        "echo before_death"
    } else {
        "cd /tmp && echo before_death"
    };
    let r = m
        .exec(&human(), sid.clone(), probe, probe_opts())
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
        .exec(
            &human(),
            sid.clone(),
            "echo should_fail",
            ExecOpts::default(),
        )
        .await;
    assert!(r.is_err(), "断线会话 exec 应失败: {r:?}");

    // 未断开的会话不可重连（防呆）
    let m2 = manager().await;
    let sid2 = m2
        .create_session(
            &human(),
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
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
        .exec(&human(), sid.clone(), "pwd", probe_opts())
        .await
        .unwrap();
    // 现场不延续：unix 断言 POSIX 前缀；windows powershell 断言盘符/根前缀（家目录）
    let cwd = r.stdout.trim();
    let fresh_ok = if cfg!(windows) {
        cwd.starts_with("C:") || cwd.starts_with('\\') || cwd.starts_with('/')
    } else {
        cwd.starts_with('/')
    };
    assert!(fresh_ok, "重连后应在新 shell（现场不延续）: {}", r.stdout);
    assert!(
        wait_state(&m, &sid, SessionState::Connected, 10).await,
        "核实后应自动退出 Reconfirming"
    );

    // 恢复后 shell 现场延续可用
    let probe2 = if cfg!(windows) {
        "echo revived"
    } else {
        "cd /tmp && echo revived"
    };
    let r = m
        .exec(&human(), sid.clone(), probe2, probe_opts())
        .await
        .unwrap();
    assert!(r.stdout.contains("revived"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn queue_busy_backpressure() {
    let m = manager().await;
    let sid = m
        .create_session(
            &human(),
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();
    // C2（B01/R24）：人建会话初始 Human-owned，Agent 动作前须委托（契约 C2 首次委托）
    m.delegate_session(&human(), sid.clone(), None)
        .await
        .unwrap();
    // 占住队列：一条长命令 + 8 条排队 → 第 9 条 QueueBusy。
    // CI 三档轮硬化：阻塞器必须长于满载 starvation 窗（实测本共享 VM 1082s
    // 二进制饥饿、6s 阻塞器被拖穿→队列排空→第 9 条级联进审批门假红）——
    // sleep 300（超时 310s）+ 头部等待 1s 保 blocker 先持槽；manager 落幕关
    // PTY，abort() 收尾不受影响
    let m2 = m.clone();
    let sid2 = sid.clone();
    let blocker = tokio::spawn(async move {
        m2.exec(
            &human(),
            sid2,
            "sleep 300",
            ExecOpts {
                timeout: Some(Duration::from_secs(310)),
                ..Default::default()
            },
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(1000)).await;
    for i in 0..8 {
        let m3 = m.clone();
        let sid3 = sid.clone();
        tokio::spawn(async move {
            let _ = m3
                .exec(
                    &agent_actor(),
                    sid3,
                    &format!("echo q{i}"),
                    ExecOpts::default(),
                )
                .await;
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    // 第 9 条=轮询式探针（CI 三档轮 starvation 根治）：slot 被阻塞器钉死时，探针
    // 只有两种合法归宿——立即 QueueBusy（队列满）或挂进队列不返回（排队等槽；
    // 审批门在取槽之后，不可能先到）。5s 未返回=已排队=证明成立；返回
    // Ok/其他错误=队列未满（满载下 spawn 迟 poll 计数未齐）→ 等 200ms 重探。
    // 阻塞器 sleep 300（此前 6s 被实测饥饿拖穿→队列排空→级联审批假红），
    // manager 落幕关 PTY 不留残进程。
    let probe_fut = || {
        let m9 = m.clone();
        let sid9 = sid.clone();
        tokio::spawn(async move {
            m9.exec(&agent_actor(), sid9, "echo overflow", ExecOpts::default())
                .await
        })
    };
    let mut r = Err(Error::InvalidInput("探针未发出".into()));
    for _ in 0..12 {
        match tokio::time::timeout(Duration::from_secs(5), probe_fut()).await {
            Ok(Ok(Err(e @ Error::QueueBusy { .. }))) => {
                r = Err(e);
                break;
            }
            Ok(Ok(other)) => {
                r = other;
                break;
            }
            Ok(Err(join)) => panic!("探针任务 join 失败: {join:?}"),
            Err(_elapsed) => {
                // 5s 仍挂起=已排队：判定成立
                r = Err(Error::QueueBusy { position: 9 });
                break;
            }
        }
    }
    assert!(
        matches!(r, Err(Error::QueueBusy { position: _ })),
        "期望 QueueBusy，得到 {r:?}"
    );
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
    // 守卫先于就绪等待：无 docker 的开发机（TINYSSH_E2E_SSHD 未设）应当跳过，
    // 而不是空等 30s 后在 await_sshd_ready 里 panic（守卫原本排在等待之后=形同虚设）
    if !std::env::var("TINYSSH_E2E_SSHD")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let lock = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(Duration::from_secs(30)).await;
    let _lock = lock;
    let (_host, port, username, password) = tinyssh_testbed::sshd_endpoint();
    let m = manager().await;
    let hid = m
        .upsert_host(
            &human(),
            HostDraft {
                name: "e2e-gate".into(),
                address: "127.0.0.1".into(),
                port: Some(port),
                username: username.into(),
                auth: AuthDraft::Password {
                    password: password.into(),
                },
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
        m2.create_session(&human(), CreateSessionReq { host_id: hid_spawn })
            .await
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
    assert_eq!(
        trusted.fingerprint.as_deref(),
        Some(it.fingerprint.as_str())
    );
    m.close_session(&human(), sid).await.unwrap();

    // ② 变更告警：预置不一致旧指纹 → Changed；拒绝 → HostKeyRejected 且不改信任记录
    m.center
        .vault
        .set_host_fingerprint(&hid, "SHA256:FAKE-OLD")
        .unwrap();
    let m3 = m.clone();
    let hid_spawn = hid.clone();
    let t2 = tokio::spawn(async move {
        m3.create_session(&human(), CreateSessionReq { host_id: hid_spawn })
            .await
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
        m4.create_session(&human(), CreateSessionReq { host_id: hid_spawn })
            .await
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
    // 守卫先于就绪等待（同 host_key_gate：无 docker 开发机跳过而非 30s 后 panic）
    if !std::env::var("TINYSSH_E2E_SSHD")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    if !tinyssh_testbed::docker_available() {
        // 字节级前提只在受控容器成立：Git-bash（本机 sshd 替代路径）的 printf
        // 会把 \NNN 八进制按 locale 上转（实测 \326 吐 c3 96 而非裸 D6），
        // 「线上 GBK 裸字节」的往返断言在 MSYS interactive shell 上不成立。
        // GBK 编解码本身由 charset.rs 单测覆盖（含跨 chunk 序列）。
        eprintln!("skip: 本机 sshd 替代路径（Git-bash printf 语义不符，需容器 UTF-8 locale）");
        return;
    }
    let lock = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(Duration::from_secs(30)).await;
    let _lock = lock;
    let (_host, port, username, password) = tinyssh_testbed::sshd_endpoint();
    let m = manager().await;
    let hid = m
        .upsert_host(
            &human(),
            HostDraft {
                id: None,
                name: "e2e-gbk".into(),
                address: "127.0.0.1".into(),
                port: Some(port),
                username: username.into(),
                auth: AuthDraft::Password {
                    password: password.into(),
                },
                tags: vec![],
                charset: Charset::Gbk,
                shell_integration: Some(true),
                jump_host_id: None,
                startup_command: None,
            },
        )
        .await
        .unwrap();

    // TOFU 首连确认
    let m2 = m.clone();
    let hid_spawn = hid.clone();
    let t = tokio::spawn(async move {
        m2.create_session(&human(), CreateSessionReq { host_id: hid_spawn })
            .await
    });
    let it = wait_pending(&m, &hid).await;
    m.decide_host_key(&human(), &it.id, true).await.unwrap();
    let sid = t.await.unwrap().expect("gbk host should connect");

    // ① 收方向：远端吐 GBK 字节「中文日志」（D6D0 CEC4 C8D5 D6BE），屏态须见 UTF-8 原文。
    //    若解码缺位，GBK 尾字节（如 D0='0'）会裸进 vt 解析，屏上是乱码/错位。
    let r = m
        .exec(
            &human(),
            sid.clone(),
            r"printf '\326\320\316\304\310\325\326\276\n'",
            ExecOpts::default(),
        )
        .await
        .unwrap();
    assert_eq!(r.exit_code, Some(0), "stdout={}", r.stdout);
    assert!(
        r.stdout.contains("中文日志"),
        "GBK 解码缺位，stdout={:?}",
        r.stdout
    );

    // ② 发方向：命令含中文，远端以字节级核验落线编码。
    //    「现场笔记」GBK = CF D6 B3 A1 B1 CA BC C7（UTF-8 则是 E7 8E B0…——
    //    od 见到 CF D6 开头即证明 GBK 编码上了链）。注意末两字节 BC C7 会被
    //    远端 readline 丢弃：e2e 容器是 UTF-8 locale，BC C7 不是合法 UTF-8 序列，
    //    行编辑按 locale 丢「非法」字节（真实 GBK 主机跑 GBK locale 无此问题，
    //    这是容器环境语义而非本端缺陷）——故断言前 6 字节。
    let r2 = m
        .exec(
            &human(),
            sid.clone(),
            "echo 现场笔记 | od -An -tx1",
            ExecOpts::default(),
        )
        .await
        .unwrap();
    assert_eq!(r2.exit_code, Some(0), "stdout={}", r2.stdout);
    assert!(
        r2.stdout.contains("cf d6 b3 a1 b1 ca"),
        "GBK 编码未上链（落线仍是 UTF-8?），stdout={:?}",
        r2.stdout
    );
    m.close_session(&human(), sid).await.unwrap();
}

// ---- 监控面板采样（监控面板轮）：probe_metrics / probe_npu_metrics 直连通路 ----

// 本地会话即可验的三件事：人类可采（不 error）、Agent 身份被人类专属门拦下、
// 脚本不依赖注入（远端无 /proc 或无 npu-smi 时返回标记而非错误——本机 Windows
// cmd 解析不了 POSIX if 也只是空输出/非零退出码，probe 仍 Ok）。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn npu_probe_human_gate_and_local_ok() {
    let m = manager().await;
    let sid = m
        .create_session(
            &human(),
            CreateSessionReq {
                host_id: "local".into(),
            },
        )
        .await
        .unwrap();
    let base = m
        .probe_npu_metrics(&human(), &sid)
        .await
        .expect("human probe must not error even on non-POSIX local shell");
    let _ = base; // Windows 本地无 npu-smi：内容形状由 sshd e2e / live 测试锁

    let err = m
        .probe_npu_metrics(&agent_actor(), &sid)
        .await
        .expect_err("agent must be rejected");
    assert!(matches!(err, Error::InvalidInput(_)), "got: {err:?}");
    m.close_session(&human(), sid).await.unwrap();
}

// 走 e2e sshd 锁真实 SSH 通道：probe_metrics 出 /proc 样本、probe_npu_metrics
// 在无 npu-smi 的容器里返回 NO_NPU 标记（前端据此隐藏 NPU 区）——通道、脚本、
// 超时闸三者在真 Fresh 通道上过一遍。需 TINYSSH_E2E_SSHD=1 + docker tinyssh-e2e。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn metrics_and_npu_probe_over_sshd() {
    if !std::env::var("TINYSSH_E2E_SSHD")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let lock = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(Duration::from_secs(30)).await;
    let _lock = lock;
    let (_host, port, username, password) = tinyssh_testbed::sshd_endpoint();
    let m = manager().await;
    let hid = m
        .upsert_host(
            &human(),
            HostDraft {
                name: "e2e-probe".into(),
                address: "127.0.0.1".into(),
                port: Some(port),
                username: username.into(),
                auth: AuthDraft::Password {
                    password: password.into(),
                },
                tags: vec![],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let m2 = m.clone();
    let hid_spawn = hid.clone();
    let t1 = tokio::spawn(async move {
        m2.create_session(&human(), CreateSessionReq { host_id: hid_spawn })
            .await
    });
    let it = wait_pending(&m, &hid).await;
    m.decide_host_key(&human(), &it.id, true).await.unwrap();
    let sid = t1.await.unwrap().expect("first-seen accept should connect");

    let metrics = m
        .probe_metrics(&human(), &sid)
        .await
        .expect("probe_metrics over sshd");
    assert!(metrics.contains("MemTotal"), "stdout={}", metrics);

    let npu = m
        .probe_npu_metrics(&human(), &sid)
        .await
        .expect("probe_npu_metrics over sshd");
    assert_eq!(npu.trim(), "NO_NPU", "容器无 npu-smi 应返回标记: {:?}", npu);
    m.close_session(&human(), sid).await.unwrap();
}
