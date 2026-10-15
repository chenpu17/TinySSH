//! tinyssh CLI：装配核心 + 人工侧操作（主机/Agent Token/审批/接管/简报/审计）。
//! 人类交互动作与 GUI 同走 SessionApi（Actor::Human 短路审批）。

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use core_session::{ssh_integration_snippet, SessionManager};
use session_api::*;
use std::io::Write as _;
use std::sync::Arc;

#[derive(Parser)]
#[command(
    name = "tinyssh",
    version,
    about = "TinySSH — 人机协同 SSH 客户端（V0 thin-slice）"
)]
struct Cli {
    /// 数据库路径（默认 ~/.tinyssh/tinyssh.db）
    #[arg(long, global = true)]
    db: Option<String>,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 启动 MCP HTTP 端点（供 Agent/shim 连接）
    Serve {
        /// 固定默认端口（被占则递增）
        #[arg(long, default_value_t = 8722)]
        port: u16,
    },
    /// Agent 身份与 Token 管理
    Agent {
        #[command(subcommand)]
        cmd: AgentCmd,
    },
    /// 主机管理
    Host {
        #[command(subcommand)]
        cmd: HostCmd,
    },
    /// 凭据管理
    Identity {
        #[command(subcommand)]
        cmd: IdentityCmd,
    },
    /// 本地会话快速操作（人类身份）
    Session {
        #[command(subcommand)]
        cmd: SessionCmd,
    },
    /// 审批队列
    Approval {
        #[command(subcommand)]
        cmd: ApprovalCmd,
    },
    /// 审计
    Audit {
        #[command(subcommand)]
        cmd: AuditCmd,
    },
    /// 库备份 / 恢复 / 版本（§10.2 回退演练；需独占写锁，故不与其他子命令并发）
    Vault {
        #[command(subcommand)]
        cmd: VaultCmd,
    },
}

#[derive(Subcommand)]
enum VaultCmd {
    /// 导出库快照（升级后要回退到旧版本前，务必先备份）
    Backup { out: String },
    /// 从备份恢复（目标库须无其他实例占用；来源版本不得高于本程序）
    Restore { from: String },
    /// 打印库 schema 版本与本程序支持版本（只读探测，不迁移）
    Version,
}

#[derive(Subcommand)]
enum AgentCmd {
    /// 创建 agent 并签发 Token（仅展示一次）
    Create {
        id: String,
        #[arg(default_value = "unnamed")]
        label: String,
    },
    Revoke {
        id: String,
    },
    /// 追加 allow 规则（免审）
    Allow {
        agent_id: String,
        pattern: String,
        #[arg(default_value = "")]
        note: String,
    },
    /// 追加 TTL 授权窗口（小时）
    Ttl {
        agent_id: String,
        pattern: String,
        #[arg(default_value_t = 2)]
        hours: u64,
    },
}

#[derive(Subcommand)]
enum HostCmd {
    Add {
        name: String,
        address: String,
        #[arg(long, default_value_t = 22)]
        port: u16,
        #[arg(long)]
        username: String,
        /// password 交互输入省略：直接传（试点）
        #[arg(long)]
        password: Option<String>,
        /// 导入 ~/.ssh/config
        #[arg(long, default_value_t = false)]
        from_ssh_config: bool,
    },
    List,
}

#[derive(Subcommand)]
enum IdentityCmd {
    List,
    /// 删除凭据（被存活主机引用时拒绝并列出主机名，DF8.4）
    Delete {
        id: String,
    },
}

#[derive(Subcommand)]
enum SessionCmd {
    /// 建本地会话并进入交互（人类直连）
    Local,
    /// 建立 SSH 会话
    Ssh { host_id: String },
    /// 显示现场简报
    Brief { session_id: String },
    /// 接管
    Takeover { session_id: String },
    /// 交还
    Handback { session_id: String },
    /// 移交控制权给 Agent（内部走 handback 受控转换 + 审计 session_delegated）
    Delegate {
        session_id: String,
        /// 交给 Agent 的任务说明（可选）
        #[arg(long)]
        goal: Option<String>,
    },
}

#[derive(Subcommand)]
enum ApprovalCmd {
    List {
        #[arg(long, default_value_t = true)]
        pending_only: bool,
    },
    Approve {
        id: String,
    },
    /// 批准并编辑命令
    Edit {
        id: String,
        command: String,
    },
    Deny {
        id: String,
    },
}

#[derive(Subcommand)]
enum AuditCmd {
    Query {
        #[arg(long)]
        session_id: Option<String>,
        #[arg(long, default_value_t = 20)]
        limit: i64,
    },
    Export {
        #[arg(long)]
        out: String,
    },
}

fn db_path(cli: &Cli) -> Result<std::path::PathBuf> {
    match &cli.db {
        Some(p) => Ok(std::path::PathBuf::from(p)),
        None => {
            // TINYSSH_DB 与 GUI 进程同语义（T43 复验 A2：自定义 DB 下 CLI 签发的
            // token 要能被 GUI 内嵌端点解析到，两前端必须读同一个环境变量）
            if let Ok(p) = std::env::var("TINYSSH_DB") {
                return Ok(std::path::PathBuf::from(p));
            }
            let dir = dirs::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join(".tinyssh");
            std::fs::create_dir_all(&dir)?;
            Ok(dir.join("tinyssh.db"))
        }
    }
}

fn human() -> Actor {
    Actor::Human
}

/// R44（§10.2 回退演练）：库的备份 / 恢复 / 版本查询。
/// 全部走 `tinyssh_vault` 的写锁路径——同一库若有实例在跑则拒绝，避免与运行中进程抢写。
fn vault_cmd(db: &std::path::Path, cmd: VaultCmd) -> Result<()> {
    match cmd {
        VaultCmd::Backup { out } => {
            let out = std::path::PathBuf::from(out);
            tinyssh_vault::backup_to(db, &out)?;
            let v = tinyssh_vault::read_schema_version(db)?;
            println!(
                "已导出备份：{}（schema 版本 {}）",
                out.display(),
                v.map(|x| x.to_string()).unwrap_or_else(|| "?".into())
            );
            Ok(())
        }
        VaultCmd::Restore { from } => {
            let from = std::path::PathBuf::from(from);
            let had_db = db.exists();
            // R44 审核 N-1（CLI 半边）：**不要**在此预探测原始 `from`——`read_schema_version`
            // 只读打开 WAL 库也会在来源旁建 `-shm`/`-wal`（往用户备份旁塞文件；来源在只读
            // 介质上还会直接失败）。来源版本改由 `restore_from` 在私有副本上读出并返回。
            let src_v = tinyssh_vault::restore_from(db, &from)?;
            // 迁移已在 `restore_from` 内于替换目标库**之前**完成（在快照上试迁移到链尾）。
            // 此处再打开一次是**冗余校验**：确认恢复结果确实能被本程序正常打开。
            drop(SessionManager::open(db)?);
            let now = tinyssh_vault::read_schema_version(db)?;
            println!("已从 {} 恢复到 {}", from.display(), db.display());
            if had_db {
                println!(
                    "恢复前的库已留安全副本：{}",
                    tinyssh_vault::pre_restore_backup_path(db).display()
                );
            }
            if let Some(a) = now {
                if a != src_v {
                    println!("schema 版本：{src_v} → {a}（已迁移到本程序支持的版本）");
                }
            }
            Ok(())
        }
        VaultCmd::Version => {
            match tinyssh_vault::read_schema_version(db)? {
                Some(v) => println!(
                    "库 {}：schema 版本 {v}（本程序支持 {}）",
                    db.display(),
                    tinyssh_vault::SCHEMA_VERSION
                ),
                None => println!("库 {}：不存在（尚未创建）", db.display()),
            }
            Ok(())
        }
    }
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let cli = Cli::parse();
    let db = db_path(&cli)?;

    // R44（§10.2）：vault 子命令需**独占写锁**，而 `SessionManager::open` 会先取锁
    // （同进程对同一库再取 flock 会失败）。故必须在打开 manager **之前**分派。
    if let Cmd::Vault { cmd } = cli.cmd {
        return vault_cmd(&db, cmd);
    }

    let m = SessionManager::open(&db)?;

    match cli.cmd {
        Cmd::Serve { port } => serve(m, port).await,
        Cmd::Agent { cmd } => agent_cmd(m, cmd).await,
        Cmd::Host { cmd } => host_cmd(m, cmd).await,
        Cmd::Identity { cmd } => identity_cmd(m, cmd).await,
        Cmd::Session { cmd } => session_cmd(m, cmd).await,
        Cmd::Approval { cmd } => approval_cmd(m, cmd).await,
        Cmd::Audit { cmd } => audit_cmd(m, cmd).await,
        // 已在上面提前分派（需在取写锁前执行）
        Cmd::Vault { .. } => unreachable!("vault 子命令应在打开 SessionManager 之前返回"),
    }
}

async fn serve(m: Arc<SessionManager>, port: u16) -> Result<()> {
    // 端口占用递增（L1 §3.5）——与 GUI 进程内装配（T43）共用同一助手
    let (listener, actual) = tinyssh_mcp_server::bind_increment(port)
        .await
        .context("bind")?;
    m.set_mcp_endpoint(format!("http://127.0.0.1:{actual}/mcp"));
    println!("TinySSH MCP endpoint: http://127.0.0.1:{actual}/mcp");
    println!(
        "shim: TINYSSH_TOKEN=<token> TINYSSH_MCP_URL=http://127.0.0.1:{actual}/mcp tinyssh-mcp"
    );
    let resolver: tinyssh_mcp_server::TokenResolver = {
        let vault = m.center.vault.clone();
        std::sync::Arc::new(move |t: &str| vault.resolve_token(t))
    };
    let state = tinyssh_mcp_server::McpState::new(m.clone(), resolver);
    let config = rmcp::transport::streamable_http_server::StreamableHttpServerConfig::default()
        .with_json_response(true);
    let router = tinyssh_mcp_server::build_router(state, config);
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

async fn agent_cmd(m: Arc<SessionManager>, cmd: AgentCmd) -> Result<()> {
    match cmd {
        AgentCmd::Create { id, label } => {
            let token = m.center.vault.create_agent(&id, &label)?;
            println!("agent {id} ({label}) created");
            println!("TOKEN（仅此一次展示）:\n{token}");
            Ok(())
        }
        AgentCmd::Revoke { id } => {
            m.center.vault.revoke_agent(&id)?;
            println!("agent {id} revoked");
            Ok(())
        }
        AgentCmd::Allow {
            agent_id,
            pattern,
            note,
        } => {
            m.center
                .vault
                .add_allow_pattern(&agent_id, &pattern, &note)?;
            println!("allow rule added: {agent_id} {pattern}");
            Ok(())
        }
        AgentCmd::Ttl {
            agent_id,
            pattern,
            hours,
        } => {
            m.center.vault.add_ttl_window(
                &agent_id,
                &pattern,
                chrono::Utc::now() + chrono::Duration::hours(hours as i64),
            )?;
            println!("TTL window added: {agent_id} {pattern} ({hours}h)");
            Ok(())
        }
    }
}

async fn host_cmd(m: Arc<SessionManager>, cmd: HostCmd) -> Result<()> {
    match cmd {
        HostCmd::Add {
            name,
            address,
            port,
            username,
            password,
            from_ssh_config,
        } => {
            if from_ssh_config {
                import_ssh_config(&m).await?;
                return Ok(());
            }
            let auth = match password {
                Some(p) => AuthDraft::Password { password: p },
                None => bail!("--password required (或 --from-ssh-config)"),
            };
            let id = m
                .upsert_host(
                    &human(),
                    HostDraft {
                        id: None,
                        name,
                        address,
                        port: Some(port),
                        username,
                        auth,
                        tags: vec![],
                        charset: Default::default(),
                        shell_integration: None,
                    },
                )
                .await?;
            println!("host {id} added");
            Ok(())
        }
        HostCmd::List => {
            for h in m.list_hosts(&human()).await? {
                // T34：指纹列（"-" = 信任未建立）——信任可查证在 CLI 同样成立
                println!(
                    "{}\t{}\t{}@{}:{}\t{}\t{:?}",
                    h.id,
                    h.name,
                    h.username,
                    h.address,
                    h.port,
                    h.fingerprint.as_deref().unwrap_or("-"),
                    h.tags
                );
            }
            Ok(())
        }
    }
}

async fn identity_cmd(m: Arc<SessionManager>, cmd: IdentityCmd) -> Result<()> {
    match cmd {
        IdentityCmd::List => {
            for i in m.list_identities(&human()).await? {
                println!("{}\t{}\t{:?}\t{}", i.id, i.label, i.kind, i.fingerprint);
            }
            Ok(())
        }
        IdentityCmd::Delete { id } => {
            // DF8.4：引用检查在核心（delete_identity 返回 IdentityInUse），
            // CLI 与 GUI 同行为——不绕过、不提示强删
            match m.delete_identity(&human(), id.clone()).await {
                Ok(()) => {
                    println!("identity {id} deleted");
                    Ok(())
                }
                Err(Error::IdentityInUse { host_names }) => bail!(
                    "identity {id} 正在被主机引用: {}——先编辑或删除相关主机再删除",
                    host_names.join(", ")
                ),
                Err(e) => Err(e.into()),
            }
        }
    }
}

async fn import_ssh_config(m: &Arc<SessionManager>) -> Result<()> {
    // 解析/对账/身份落库都在 core-session（与 GUI 导入面板同一实现）
    let preview = m.ssh_config_preview(None).await?;
    // C7：默认只导可直接导入且不重复的条目；重复/阻断跳过并明示原因
    let names: Vec<String> = preview
        .iter()
        .filter(|p| p.directly_importable && !p.already_imported)
        .map(|p| p.name.clone())
        .collect();
    let blocked = preview.iter().filter(|p| !p.directly_importable).count();
    let dup = preview.iter().filter(|p| p.already_imported).count();
    let outcomes = m.ssh_config_import(&human(), None, &names, false).await;
    let mut ok = 0;
    for o in &outcomes {
        match (&o.host_id, &o.error, &o.skipped_reason) {
            (Some(_), _, _) => ok += 1,
            (None, Some(e), _) => println!("  ✕ {}: {e}", o.name),
            (None, None, Some(r)) => println!("  ↷ {}: 跳过（{r:?}）", o.name),
            _ => {}
        }
    }
    println!(
        "imported {ok}/{} hosts from ~/.ssh/config（阻断 {blocked} 条、重复 {dup} 条未导入——GUI 导入面板可转手工表单/显式覆盖）",
        preview.len()
    );
    Ok(())
}

async fn session_cmd(m: Arc<SessionManager>, cmd: SessionCmd) -> Result<()> {
    match cmd {
        SessionCmd::Local | SessionCmd::Ssh { .. } => {
            let host_id = match cmd {
                SessionCmd::Local => "local".into(),
                SessionCmd::Ssh { host_id } => host_id,
                _ => unreachable!(),
            };
            let sid = m
                .create_session(&human(), CreateSessionReq { host_id })
                .await?;
            println!("session {sid} created. 交互模式（V0 thin-slice）：输入命令执行；/brief 简报；/takeover 接管；/handback 交还；/exit 退出");
            // 人类直连交互：读行 → exec（Human 短路审批）
            let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
            let (attach, mut out_rx, _cancel) = m.subscribe_output_channel(sid.clone()).await?;
            let _ = attach; // cli 不消费检查点（只跟进实时流）
            let sid_out = sid.clone();
            tokio::spawn(async move {
                loop {
                    match out_rx.recv().await {
                        Ok(OutputEvent::Raw { sid, data, .. }) if sid == sid_out => {
                            tx.send(data).ok();
                        }
                        Ok(_) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        Err(_) => continue,
                    }
                }
            });
            use std::io::BufRead;
            let stdin = std::io::stdin();
            print!("{}", m.read_screen(&human(), sid.clone()).await?.text);
            loop {
                let mut line = String::new();
                std::io::stdout().flush()?;
                if stdin.lock().read_line(&mut line)? == 0 {
                    break;
                }
                let t = line.trim_end();
                match t {
                    "/exit" => break,
                    "/brief" => {
                        let b = m.get_session_brief(&human(), sid.clone()).await?;
                        println!("{}", serde_json::to_string_pretty(&b)?);
                        continue;
                    }
                    "/takeover" => {
                        let r = m
                            .set_control(
                                &human(),
                                sid.clone(),
                                ControlOwner::Human,
                                ControlOpts::default(),
                            )
                            .await?;
                        println!("{}", serde_json::to_string_pretty(&r)?);
                        continue;
                    }
                    "/handback" => {
                        let r = m
                            .set_control(
                                &human(),
                                sid.clone(),
                                ControlOwner::Agent,
                                ControlOpts::default(),
                            )
                            .await?;
                        println!("{}", serde_json::to_string_pretty(&r)?);
                        continue;
                    }
                    "" => continue,
                    cmd_line => {
                        let r = m
                            .exec(&human(), sid.clone(), cmd_line, ExecOpts::default())
                            .await?;
                        print!("{}", r.stdout);
                        if !r.stderr.is_empty() {
                            print!("{}", r.stderr);
                        }
                    }
                }
            }
            Ok(())
        }
        SessionCmd::Brief { session_id } => {
            let b = m.get_session_brief(&human(), session_id).await?;
            println!("{}", serde_json::to_string_pretty(&b)?);
            Ok(())
        }
        SessionCmd::Takeover { session_id } => {
            let r = m
                .set_control(
                    &human(),
                    session_id,
                    ControlOwner::Human,
                    ControlOpts {
                        stop_running: StopPolicy::BestEffort,
                    },
                )
                .await?;
            println!("{}", serde_json::to_string_pretty(&r)?);
            Ok(())
        }
        SessionCmd::Handback { session_id } => {
            let r = m
                .set_control(
                    &human(),
                    session_id,
                    ControlOwner::Agent,
                    ControlOpts::default(),
                )
                .await?;
            println!("{}", serde_json::to_string_pretty(&r)?);
            Ok(())
        }
        SessionCmd::Delegate { session_id, goal } => {
            m.delegate_session(&human(), session_id, goal).await?;
            println!("已移交：会话控制权转给 Agent。");
            Ok(())
        }
    }
}

async fn approval_cmd(m: Arc<SessionManager>, cmd: ApprovalCmd) -> Result<()> {
    match cmd {
        ApprovalCmd::List { pending_only } => {
            let items = m
                .list_approvals(
                    &human(),
                    ApprovalFilter {
                        pending_only,
                        ..Default::default()
                    },
                )
                .await?;
            for it in items {
                println!(
                    "{} [{}] {} :: {}",
                    it.id,
                    format!("{:?}", it.status).to_lowercase(),
                    it.agent_id,
                    it.command
                );
                for seg in &it.segment_report {
                    println!("    - {} : {}", seg.segment, seg.verdict);
                }
            }
            Ok(())
        }
        ApprovalCmd::Approve { id } => {
            m.decide_approval(&human(), id, Decision::Approve).await?;
            println!("approved");
            Ok(())
        }
        ApprovalCmd::Edit { id, command } => {
            m.decide_approval(&human(), id, Decision::ApproveEdited(command))
                .await?;
            println!("approved (edited)");
            Ok(())
        }
        ApprovalCmd::Deny { id } => {
            m.decide_approval(&human(), id, Decision::Deny).await?;
            println!("denied");
            Ok(())
        }
    }
}

async fn audit_cmd(m: Arc<SessionManager>, cmd: AuditCmd) -> Result<()> {
    match cmd {
        AuditCmd::Query { session_id, limit } => {
            let page = m
                .query_audit(
                    &human(),
                    AuditFilter {
                        session_id,
                        limit,
                        ..Default::default()
                    },
                )
                .await?;
            for ev in &page.events {
                println!(
                    "{} #{} {} {:?} {}",
                    ev.seq,
                    ev.ts.format("%H:%M:%S"),
                    ev.action,
                    ev.agent_id,
                    ev.command.clone().unwrap_or_default()
                );
            }
            println!("total: {}", page.total);
            Ok(())
        }
        AuditCmd::Export { out } => {
            m.export_audit(&human(), AuditFilter::default(), std::path::Path::new(&out))
                .await?;
            println!("exported to {out}");
            Ok(())
        }
    }
}

/// 供 --print-integration 调试使用。
#[allow(dead_code)]
fn _print_integration() {
    println!("{}", ssh_integration_snippet());
}
