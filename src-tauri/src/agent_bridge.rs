//! 内嵌 Agent 宿主与 core-session 的桥接层。
//!
//! `AgentSshOps` 把 agent 工作线程上的同步工具调用转成 tokio 上的 SessionApi；
//! 审批/审计在 core-session 层自动继承，这里不重复实现。从 main.rs 抽出，
//! 让应用壳只保留装配与命令接线。

use core_session::SessionManager;
use session_api::*;
use std::sync::Arc;

/// 内嵌 agent 的 actor：身份固定（非参数可指定，与 MCP 的 token 身份同一原则）。
pub(crate) fn embedded_agent() -> Actor {
    Actor::Agent {
        client_id: tinyssh_agent_host::AGENT_CLIENT_ID.into(),
    }
}

/// SshOps 适配器：agent 工作线程上的同步阻塞调用 → tokio 上的 SessionApi。
/// 审批等待期间工具阻塞（agent 线程本就为它存在）；错误字符串即模型看到的
/// is_error 工具结果。
pub(crate) struct AgentSshOps {
    pub(crate) api: Arc<SessionManager>,
    pub(crate) rt: tokio::runtime::Handle,
}

/// 提示词/技能资产源（提示词/技能资产化轮）：直连 vault settings（get_setting
/// 命令同款路径——管理面直连 vault 既有先例，同步读、SQLite 行级锁、微秒级）。
pub(crate) struct AgentPromptAssets {
    pub(crate) api: Arc<SessionManager>,
}

impl tinyssh_agent_host::PromptAssets for AgentPromptAssets {
    fn session_extra(&self) -> String {
        self.setting("agent.prompt_extra")
    }
    fn fleet_extra(&self) -> String {
        self.setting("agent.fleet_prompt_extra")
    }
    fn skills(&self) -> Vec<(String, String)> {
        // KV 单键 JSON 对象（名称 → 正文）；损坏/缺省视为空库，不阻塞对话
        let raw = self.setting("agent.skills");
        let mut out: Vec<(String, String)> =
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&raw)
                .unwrap_or_default()
                .into_iter()
                .filter_map(|(k, v)| v.as_str().map(|b| (k, b.to_string())))
                .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }
}

impl AgentPromptAssets {
    fn setting(&self, key: &str) -> String {
        self.api
            .center
            .vault
            .get_setting(key)
            .ok()
            .flatten()
            .unwrap_or_default()
    }
}

impl tinyssh_agent_host::SshOps for AgentSshOps {
    fn exec(
        &self,
        sid: &str,
        cmd: &str,
        timeout_secs: Option<u64>,
        output_cap: Option<u64>,
        mode: Option<&str>,
    ) -> std::result::Result<String, String> {
        let api = self.api.clone();
        let (sid, cmd) = (sid.to_string(), cmd.to_string());
        // 缺省 shell（持久现场）；未启用 shell 集成的主机上 shell 模式不可用，
        // 工具表引导模型显式传 "fresh"（独立通道，可靠退出码）
        let exec_mode = if mode == Some("fresh") {
            ExecMode::Fresh
        } else {
            ExecMode::Shell
        };
        self.rt.block_on(async move {
            let opts = ExecOpts {
                mode: exec_mode,
                timeout: timeout_secs.map(std::time::Duration::from_secs),
                output_cap: output_cap.map(|x| x as usize),
                env: Default::default(),
            };
            match api.exec(&embedded_agent(), sid, &cmd, opts).await {
                Ok(r) => serde_json::to_string(&r).map_err(|e| e.to_string()),
                Err(e) => Err(format!("{e}")),
            }
        })
    }
    fn read_screen(&self, sid: &str) -> std::result::Result<String, String> {
        let api = self.api.clone();
        let sid = sid.to_string();
        self.rt.block_on(async move {
            match api.read_screen(&embedded_agent(), sid).await {
                Ok(mut s) => {
                    // 画面文本保尾截断（滚回可能巨大；模型关心的是当前现场）
                    const SCREEN_TAIL: usize = 8 * 1024;
                    if s.text.len() > SCREEN_TAIL {
                        let mut cut = s.text.len() - SCREEN_TAIL;
                        while !s.text.is_char_boundary(cut) {
                            cut += 1;
                        }
                        s.text = format!("…（前段略）{}", &s.text[cut..]);
                    }
                    serde_json::to_string(&s).map_err(|e| e.to_string())
                }
                Err(e) => Err(format!("{e}")),
            }
        })
    }
    fn read_blocks(&self, sid: &str, limit: u32) -> std::result::Result<String, String> {
        let api = self.api.clone();
        let sid = sid.to_string();
        self.rt.block_on(async move {
            match api.read_blocks(&embedded_agent(), sid, limit).await {
                Ok(r) => serde_json::to_string(&r).map_err(|e| e.to_string()),
                Err(e) => Err(format!("{e}")),
            }
        })
    }
    fn wait_output(
        &self,
        sid: &str,
        quiet_ms: Option<u64>,
        regex: Option<String>,
        timeout_secs: Option<u64>,
    ) -> std::result::Result<String, String> {
        let api = self.api.clone();
        let sid = sid.to_string();
        self.rt.block_on(async move {
            let opts = WaitOpts {
                quiet_ms,
                regex,
                timeout: timeout_secs.map(std::time::Duration::from_secs),
            };
            match api.wait_output(&embedded_agent(), sid, opts).await {
                Ok(r) => serde_json::to_string(&r).map_err(|e| e.to_string()),
                Err(e) => Err(format!("{e}")),
            }
        })
    }
    fn stat_remote(
        &self,
        sid: &str,
        path: &str,
    ) -> std::result::Result<Option<tinyssh_agent_host::StatInfo>, String> {
        let api = self.api.clone();
        let (sid, path) = (sid.to_string(), path.to_string());
        self.rt.block_on(async move {
            match api.sftp_stat(&embedded_agent(), sid, path).await {
                Ok(st) => Ok(Some(tinyssh_agent_host::StatInfo {
                    size: st.size,
                    mtime: st.mtime,
                    is_dir: st.is_dir,
                })),
                // 预检语义：不存在=无冲突（Err 才是异常）
                Err(Error::SftpPathNotFound { .. }) => Ok(None),
                Err(e) => Err(format!("{e}")),
            }
        })
    }
    fn stat_local(
        &self,
        path: &str,
    ) -> std::result::Result<Option<tinyssh_agent_host::StatInfo>, String> {
        match std::fs::metadata(path) {
            Ok(md) => Ok(Some(tinyssh_agent_host::StatInfo {
                size: Some(md.len()),
                mtime: md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64),
                is_dir: md.is_dir(),
            })),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("本地路径不可访问：{e}")),
        }
    }
    fn transfer_start(
        &self,
        sid: &str,
        local: &str,
        remote: &str,
        is_upload: bool,
        collision: Option<&str>,
    ) -> std::result::Result<String, String> {
        let api = self.api.clone();
        let (sid, local, remote) = (sid.to_string(), local.to_string(), remote.to_string());
        let collision = match collision {
            None => None,
            Some("skip") => Some(CollisionDecision::Skip),
            Some("overwrite") => Some(CollisionDecision::Overwrite),
            Some(other) => return Err(format!("非法 collision：{other}")),
        };
        self.rt.block_on(async move {
            // api.upload/download 内部即传输必审（审批阻塞在此，拒绝即 Err）
            let local_path = std::path::PathBuf::from(&local);
            let r = if is_upload {
                api.upload(
                    &embedded_agent(),
                    sid,
                    local_path.as_path(),
                    &remote,
                    collision,
                )
                .await
            } else {
                api.download(
                    &embedded_agent(),
                    sid,
                    &remote,
                    local_path.as_path(),
                    collision,
                )
                .await
            };
            match r {
                Ok(h) => Ok(h.id),
                Err(e) => Err(format!("{e}")),
            }
        })
    }
    fn transfer_status(
        &self,
        tid: &str,
    ) -> std::result::Result<tinyssh_agent_host::TransferPoll, String> {
        let api = self.api.clone();
        let tid = tid.to_string();
        self.rt.block_on(async move {
            let list = api
                .list_transfers(&embedded_agent())
                .await
                .map_err(|e| format!("{e}"))?;
            match list.iter().find(|t| t.id == tid) {
                Some(t) => Ok(tinyssh_agent_host::TransferPoll {
                    status: transfer_status_str(t.status).to_string(),
                    error: t.error.clone(),
                    bytes_done: t.bytes_done,
                    total: t.total,
                }),
                None => Err(format!("传输任务不存在：{tid}")),
            }
        })
    }
    fn send_keys(&self, sid: &str, keys: &str) -> std::result::Result<String, String> {
        let api = self.api.clone();
        let (sid, keys) = (sid.to_string(), keys.to_string());
        self.rt.block_on(async move {
            // core-session 侧：协作门→人类控制权拒→危险模式引擎→会话级授权
            //（一次审批）→人类输入 2s 优先窗→审计。错误文本即模型所见。
            match api.send_keys(&embedded_agent(), sid, &keys).await {
                Ok(()) => Ok(serde_json::json!({ "sent": true }).to_string()),
                Err(e) => Err(format!("{e}")),
            }
        })
    }
    fn list_sessions(&self) -> std::result::Result<String, String> {
        let api = self.api.clone();
        self.rt.block_on(async move {
            match api.list_sessions(&embedded_agent()).await {
                Ok(list) => {
                    // 编排者视角的简要清单：够选目标即可，不漏控制权（派发预期管理）
                    let briefs: Vec<serde_json::Value> = list
                        .iter()
                        .map(|s| {
                            serde_json::json!({
                                "session_id": s.id,
                                "host": s.host_name,
                                "kind": s.kind,
                                "state": s.state,
                                "control_owner": s.control_owner,
                            })
                        })
                        .collect();
                    Ok(serde_json::Value::Array(briefs).to_string())
                }
                Err(e) => Err(format!("{e}")),
            }
        })
    }
}

/// TransferStatus → 宿主轮询串（小写下划线；见 agent-host::TransferPoll 契约）。
fn transfer_status_str(s: TransferStatus) -> &'static str {
    use TransferStatus::*;
    match s {
        Queued => "queued",
        Running => "running",
        Committing => "committing",
        Succeeded => "succeeded",
        Failed => "failed",
        Cancelled => "cancelled",
        Cancelling => "cancelling",
        AwaitingDecision => "awaiting_decision",
        OutcomeUnknown => "outcome_unknown",
        Skipped => "skipped",
        Interrupted => "interrupted",
    }
}
