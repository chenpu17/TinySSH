//! TinySSH 内置 Agent 宿主（Round 2，接真模型轮）。
//!
//! tiny-agent-core 驱动的「每会话一个 agent」宿主：模型配置（vault 密封存储，
//! 由 src-tauri 解出后传入）+ SSH 工具桥（[`SshOps`] 同步 trait，src-tauri 侧
//! block_on 适配 SessionManager——工具跑在 agent 的工作线程上，天然容忍审批
//! 阻塞）+ 事件流（[`HostEvent`]，经 src-tauri 桥成 tauri 事件到 FE）+ 转写
//! 缓存（FE 重挂载重建对话）+ 取消。
//!
//! 安全边界（与既有审批链的关系）：agent 以 `Actor::Agent{client_id: AGENT_CLIENT_ID}`
//! 走 SessionManager 的同一批方法——exec 的危险命令审批、**传输必审**、send_keys
//! 的会话级授权与人类输入优先窗、审计、夺权语义全部在 core-session 层自动继承，
//! 本 crate 不做任何放行。工具集只装配八个 SSH 操作（exec/read_screen/read_blocks/
//! wait_output + upload/download/transfer_status + send_keys）+ 可选技能库工具
//! load_skill（装配了资产源时；提示词/技能资产化轮），本地 shell/file
//! 内置工具一律不装配（tiny-a config `tools: []`）。
//! 每会话串行对话（一次一个运行）；取消在工具/轮次间隙生效（tiny-a 语义）。

use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tiny_agent::{Block, CallbackTool, Tool, ToolDef, ToolOutput};

/// 内嵌 agent 的 actor 身份（审批卡/审计按它归属；FE 侧同名常量对应）。
pub const AGENT_CLIENT_ID: &str = "tinyssh-embedded";

/// 模型服务配置（FE 设置卡录入；api_key 只在内存，落盘走 vault 密封）。
#[derive(Debug, Clone)]
pub struct ModelConfig {
    /// "openai"（OpenAI 兼容：GLM/DeepSeek/Qwen/Kimi…）| "anthropic"。
    pub provider: String,
    pub base_url: Option<String>,
    pub model: String,
    pub api_key: String,
}

/// FE 可见事件（serde 序列化后走 tauri emit 与转写缓存两条路）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum HostEvent {
    /// 用户消息（转写完整性：FE 重挂载重建对话不能丢用户气泡）。
    User(String),
    Turn(u32),
    /// 文本增量（流式）。
    Text(String),
    /// 推理增量（思考块）。
    Thinking(String),
    ToolStart {
        name: String,
        input: serde_json::Value,
    },
    ToolResult {
        name: String,
        is_error: bool,
        content: String,
    },
    /// 非致命告警（tiny-a Warning）。
    Notice(String),
    Usage {
        input: u64,
        output: u64,
    },
    Done {
        stop_reason: String,
    },
    Failed {
        message: String,
    },
}

/// SSH 工具桥：同步阻塞签名——调用方（agent 工作线程）容忍审批/执行耗时。
/// 返回值为**工具文本**（JSON 字符串，形状与 MCP 同名工具对齐），Err 文本成为
/// 模型看到的 is_error 结果。
pub trait SshOps: Send + Sync {
    /// `mode`: None=适配器默认（shell）；"shell"|"fresh"。fresh=独立通道执行
    ///（可靠退出码，不延续现场）——未启用 shell 集成的主机上 shell 模式不可用。
    fn exec(
        &self,
        sid: &str,
        cmd: &str,
        timeout_secs: Option<u64>,
        output_cap: Option<u64>,
        mode: Option<&str>,
    ) -> Result<String, String>;
    fn read_screen(&self, sid: &str) -> Result<String, String>;
    fn read_blocks(&self, sid: &str, limit: u32) -> Result<String, String>;
    fn wait_output(
        &self,
        sid: &str,
        quiet_ms: Option<u64>,
        regex: Option<String>,
        timeout_secs: Option<u64>,
    ) -> Result<String, String>;
    // ---- 传输原语（流程编排在本 crate [`transfer_flow`]，可离线单测；
    // src-tauri 适配器只做 SessionApi 翻译）----

    /// 远端目标 stat（upload 冲突预检；Ok(None)=不存在）。
    fn stat_remote(&self, sid: &str, path: &str) -> Result<Option<StatInfo>, String>;
    /// 本地目标 stat（download 冲突预检；Ok(None)=不存在）。
    fn stat_local(&self, path: &str) -> Result<Option<StatInfo>, String>;
    /// 发起传输并返回 transfer_id——**审批在此阻塞**（传输必审语义在
    /// core-session，拒绝/超时即 Err 文本，模型看到的是 is_error 结果）。
    fn transfer_start(
        &self,
        sid: &str,
        local: &str,
        remote: &str,
        is_upload: bool,
        collision: Option<&str>,
    ) -> Result<String, String>;
    /// 任务状态对账（宿主流程轮询 + transfer_status 工具共用）。
    fn transfer_status(&self, tid: &str) -> Result<TransferPoll, String>;
    /// 注入按键到会话终端——core-session 侧套完整夺权语义（人类控制权拒/
    /// 危险模式引擎/**会话级授权一次审批**/人类输入 2s 优先窗/审计）。
    fn send_keys(&self, sid: &str, keys: &str) -> Result<String, String>;
    /// 已连接会话清单（编排者选目标用；core-session 只读，任何 Actor 可查）。
    fn list_sessions(&self) -> Result<String, String>;
}

/// stat 摘要（冲突卡用；Option 字段=源数据未必报）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct StatInfo {
    pub size: Option<u64>,
    pub mtime: Option<i64>,
    pub is_dir: bool,
}

/// 传输任务轮询快照。status 为小写下划线串（与 MCP wire 的 PascalCase 不同——
/// 本工具的描述即模型唯一契约）：queued/running/committing/succeeded/failed/
/// cancelled/cancelling/awaiting_decision/outcome_unknown/skipped/interrupted。
#[derive(Debug, Clone)]
pub struct TransferPoll {
    pub status: String,
    pub error: Option<String>,
    pub bytes_done: u64,
    pub total: Option<u64>,
}

/// 工具结果文本的保尾截断：错误堆栈在尾部，保尾不保头。
const TAIL_CAP: usize = 4000;
/// 每会话转写缓存条目上限（FE 重建对话用；更早的靠模型自己的历史延续）。
const TRANSCRIPT_CAP: usize = 400;
/// 传输轮询节奏（500ms×120 = 60s 上限；测试缩为 5ms 让超时路径秒级跑完）。
const TRANSFER_POLL_MS: u64 = if cfg!(test) { 5 } else { 500 };
const TRANSFER_POLL_CAP: u32 = 120;

/// collision 参数解析：缺省 fail（None）；仅接受 skip|overwrite，其余即工具错误。
fn parse_collision(input: &serde_json::Value) -> Result<Option<String>, String> {
    match input.get("collision").and_then(|v| v.as_str()) {
        None | Some("") => Ok(None),
        Some("skip") => Ok(Some("skip".into())),
        Some("overwrite") => Ok(Some("overwrite".into())),
        Some(other) => Err(format!(
            "collision 仅支持 skip|overwrite（缺省 fail），得到 {other:?}"
        )),
    }
}

fn poll_json(tid: &str, p: &TransferPoll) -> serde_json::Value {
    json!({
        "transfer_id": tid,
        "status": p.status,
        "bytes_done": p.bytes_done,
        "total": p.total,
        "error": p.error,
    })
}

/// 按键串的字面转义解释（send_keys 契约落地）：模型双重转义时 JSON 解码后仍剩
/// `\r` 两个字符——按工具描述把它们翻成真实控制字节。识别 \r \n \t \\ 与
/// \xHH（十六进制字节，如 \x1b Esc、\x03 Ctrl+C）；未知转义原样保留（诚实）。
/// 真实控制字节（JSON 正确解码的产物）不含反斜杠、天然直通不受影响。
fn interpret_key_escapes(s: &str) -> String {
    if !s.contains('\\') {
        return s.to_string();
    }
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'\\' || i + 1 >= b.len() {
            out.push(b[i]);
            i += 1;
            continue;
        }
        match b[i + 1] {
            b'r' => {
                out.push(b'\r');
                i += 2;
            }
            b'n' => {
                out.push(b'\n');
                i += 2;
            }
            b't' => {
                out.push(b'\t');
                i += 2;
            }
            b'\\' => {
                out.push(b'\\');
                i += 2;
            }
            b'x' | b'X' if i + 4 <= b.len() => {
                match s
                    .get(i + 2..i + 4)
                    .and_then(|h| u8::from_str_radix(h, 16).ok())
                {
                    Some(v) => {
                        out.push(v);
                        i += 4;
                    }
                    None => {
                        out.push(b'\\');
                        i += 1;
                    }
                }
            }
            other => {
                out.push(b'\\');
                out.push(other);
                i += 2;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// upload/download 共用流程：DF6.2 同款「缺省 fail」预检（upload 查远端目标、
/// download 查本地目标；已存在的普通文件直接结构化报冲突，不建任务——审批卡
/// 都不出现；目录目标放行=下载进目录语义）→ 发起（审批在 core-session 内阻塞，
/// 拒绝即 is_error 文本）→ 轮询到终态或 60s 上限（超时交回 transfer_id，模型用
/// transfer_status 工具对账，不盲目重试）。
fn transfer_flow(
    ops: &Arc<dyn SshOps>,
    sid: &str,
    local: &str,
    remote: &str,
    is_upload: bool,
    collision: Option<&str>,
) -> Result<ToolOutput, anyhow::Error> {
    if collision.is_none() {
        let target = if is_upload { remote } else { local };
        let st = if is_upload {
            ops.stat_remote(sid, remote)
        } else {
            ops.stat_local(local)
        }
        .map_err(|e| anyhow::anyhow!(e))?;
        if let Some(st) = st {
            if !st.is_dir {
                return Ok(ToolOutput::error(
                    json!({
                        "kind": "conflict_detected",
                        "target": target,
                        "size": st.size,
                        "mtime": st.mtime,
                        "hint": "目标已存在；与用户确认后用 collision=\"skip\"（同名跳过）或 \"overwrite\"（覆盖，仍需审批）重试",
                    })
                    .to_string(),
                ));
            }
        }
    }
    let tid = ops
        .transfer_start(sid, local, remote, is_upload, collision)
        .map_err(|e| anyhow::anyhow!(e))?;
    for _ in 0..TRANSFER_POLL_CAP {
        std::thread::sleep(std::time::Duration::from_millis(TRANSFER_POLL_MS));
        let p = ops.transfer_status(&tid).map_err(|e| anyhow::anyhow!(e))?;
        match p.status.as_str() {
            "succeeded" | "skipped" => {
                return Ok(ToolOutput::text(poll_json(&tid, &p).to_string()))
            }
            "failed" | "cancelled" | "interrupted" | "outcome_unknown" => {
                return Ok(ToolOutput::error(poll_json(&tid, &p).to_string()))
            }
            _ => {} // queued/running/committing/cancelling/awaiting_decision → 继续等
        }
    }
    Ok(ToolOutput::text(
        json!({
            "transfer_id": tid,
            "status": "running",
            "note": "传输仍在进行（已等60s）；稍后用 transfer_status 查这个 transfer_id，不要盲目重试（会重复占用带宽）",
        })
        .to_string(),
    ))
}

fn tail(s: &str) -> String {
    if s.len() <= TAIL_CAP {
        return s.to_string();
    }
    let mut cut = s.len() - TAIL_CAP;
    while !s.is_char_boundary(cut) {
        cut += 1;
    }
    format!("…（前段略）{}", &s[cut..])
}

/// 内置系统提示词已资产化（assets/*.md，include_str! 静态内嵌，随二进制分发）。
/// 安全契约行（审批/不虚构/简体中文）由测试钉住：tests/prompt_assets.rs。
const SYS_PROMPT: &str = include_str!("../assets/system-prompt.md");

/// 编排者（Fleet）系统提示：跨会话派发，不直接碰机器（Fleet 契约——目标会话的
/// 审批/危险扫描/控制权独立生效，编排者没有任何绕过路径）。
const FLEET_SYS_PROMPT: &str = include_str!("../assets/fleet-system-prompt.md");

/// 用户附加提示词上限（字节，截断保头）。UI 侧 maxLength 同值。
const PROMPT_EXTRA_CAP: usize = 8192;

/// 提示词/技能资产源：宿主装配时注入（src-tauri 侧实现，读 vault settings）。
/// None（测试直连 `new`）= 无附加段、无技能库，行为与资产化前完全一致。
pub trait PromptAssets: Send + Sync {
    /// 会话助手提示词的追加段（空串=不追加）。
    fn session_extra(&self) -> String;
    /// Fleet 编排者提示词的追加段（空串=不追加）。
    fn fleet_extra(&self) -> String;
    /// 技能库快照（名称 → 正文）。load_skill 工具每次调用现读，编辑即生效、无需重建。
    fn skills(&self) -> Vec<(String, String)>;
}

/// 按字节上限截断（保头，字符边界安全）——附加段超长时的兜底，UI 已 maxLength 同值。
fn clamp_utf8_head(s: &str, cap: usize) -> String {
    if s.len() <= cap {
        return s.to_string();
    }
    let mut cut = cap;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…（附加段超长，已截断）", &s[..cut])
}

/// 组装最终系统提示词：内置资产为底；有资产源时按会话/Fleet 取对应附加段，
/// 非空则追加（标注「与安全铁律冲突时以铁律为准」）；会话面追加技能库用法一行。
/// Fleet 不给技能库——编排者只派发自包含任务，机器侧流程归目标 agent 现场加载。
fn compose_sys_prompt(fleet: bool, assets: Option<&dyn PromptAssets>) -> String {
    let mut base = if fleet {
        FLEET_SYS_PROMPT.to_string()
    } else {
        SYS_PROMPT.to_string()
    };
    let Some(a) = assets else {
        return base;
    };
    if !fleet {
        base.push_str(
            "\n- 技能库：任务涉及组织标准流程时，先不带参数调用 load_skill 列出可用技能，命中就加载后照做。",
        );
    }
    let raw = if fleet {
        a.fleet_extra()
    } else {
        a.session_extra()
    };
    let extra = raw.trim();
    if !extra.is_empty() {
        base.push_str("\n\n## 用户附加约定（现场/组织约定；与上方安全铁律冲突时以铁律为准）\n");
        base.push_str(&clamp_utf8_head(extra, PROMPT_EXTRA_CAP));
    }
    base
}

/// load_skill 无参调用返回的清单文本：名称 + 正文首行作简介。
fn skills_list_text(skills: &[(String, String)]) -> String {
    if skills.is_empty() {
        return "技能库为空（可在 设置 → Agent → 提示词与技能 里添加）。".into();
    }
    let mut out = String::from("可用技能：\n");
    for (name, body) in skills {
        let intro = body.lines().next().unwrap_or("").trim();
        out.push_str(&format!("- {name}——{intro}\n"));
    }
    out
}

// ── 工具装配：sid 在装配时绑死进闭包（每会话一次），模型无法选会话 ──

fn build_tools(
    ops: Arc<dyn SshOps>,
    sid: String,
    assets: Option<Arc<dyn PromptAssets>>,
) -> Vec<Box<dyn Tool>> {
    let o2 = ops.clone();
    let s2 = sid.clone();
    let exec = CallbackTool::new(
        ToolDef {
            name: "exec".into(),
            description: "在会话上执行命令。缺省 shell 模式（持久 shell，cwd/env 延续）；主机未启用 shell 集成时 shell 模式不可用，用 mode:\"fresh\"（独立通道，可靠退出码，不延续现场）。危险命令需人工审批，等待期间此调用阻塞；被拒绝时如实报告，不要换着花样重试。".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "要执行的命令" },
                    "mode": { "type": "string", "enum": ["shell", "fresh"], "description": "执行模式：shell（缺省，持久 shell 现场）| fresh（独立通道；未启用 shell 集成的主机必须用这个）" },
                    "timeout_secs": { "type": "integer", "description": "超时秒数（缺省 30，审批等待不计入）" },
                    "output_cap_bytes": { "type": "integer", "description": "stdout/stderr 返回上限字节（缺省 128KiB，超限截断）" }
                },
                "required": ["command"]
            }),
        },
        move |input, _ctx| {
            let cmd = input.get("command").and_then(|v| v.as_str()).ok_or_else(|| anyhow::anyhow!("缺少 command"))?;
            let mode = input.get("mode").and_then(|v| v.as_str());
            if let Some(m) = mode {
                if m != "shell" && m != "fresh" {
                    return Err(anyhow::anyhow!("mode 仅支持 shell|fresh，得到 {m:?}"));
                }
            }
            let t = input.get("timeout_secs").and_then(|v| v.as_u64());
            let cap = input.get("output_cap_bytes").and_then(|v| v.as_u64());
            o2.exec(&s2, cmd, t, cap, mode).map(ToolOutput::text).map_err(|e| anyhow::anyhow!(e))
        },
    );
    let o3 = ops.clone();
    let s3 = sid.clone();
    let screen = CallbackTool::new(
        ToolDef {
            name: "read_screen".into(),
            description:
                "读取终端当前画面（渲染后文本，含滚回）。交互式程序（vim/htop）的输出用这个看。"
                    .into(),
            schema: json!({"type": "object", "properties": {}}),
        },
        move |_input, _ctx| {
            o3.read_screen(&s3)
                .map(ToolOutput::text)
                .map_err(|e| anyhow::anyhow!(e))
        },
    );
    let o4 = ops.clone();
    let s4 = sid.clone();
    let blocks = CallbackTool::new(
        ToolDef {
            name: "read_blocks".into(),
            description: "读取本会话最近的命令块（shell 集成采集：命令 + 退出码 + 输出）——了解这台机器上刚发生过什么的最快途径。".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "description": "最近 N 块（缺省 20，上限 200）" }
                }
            }),
        },
        move |input, _ctx| {
            let limit = input.get("limit").and_then(|v| v.as_u64()).unwrap_or(20).min(200) as u32;
            o4.read_blocks(&s4, limit).map(ToolOutput::text).map_err(|e| anyhow::anyhow!(e))
        },
    );
    let o5 = ops.clone();
    let s5 = sid.clone();
    let wait = CallbackTool::new(
        ToolDef {
            name: "wait_output".into(),
            description: "等待会话出现新输出（静默期/正则/超时三重条件）——长命令启动后跟踪其进度的正确姿势，不要盲等。".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "quiet_ms": { "type": "integer", "description": "静默判定毫秒（缺省 1000）" },
                    "regex": { "type": "string", "description": "渲染文本上的正则，匹配即提前返回" },
                    "timeout_secs": { "type": "integer", "description": "总超时秒（缺省 10）" }
                }
            }),
        },
        move |input, _ctx| {
            let q = input.get("quiet_ms").and_then(|v| v.as_u64());
            let r = input.get("regex").and_then(|v| v.as_str()).map(String::from);
            let t = input.get("timeout_secs").and_then(|v| v.as_u64());
            o5.wait_output(&s5, q, r, t).map(ToolOutput::text).map_err(|e| anyhow::anyhow!(e))
        },
    );
    let o6 = ops.clone();
    let s6 = sid.clone();
    let upload = CallbackTool::new(
        ToolDef {
            name: "upload".into(),
            description: "上传本地文件到远程主机。local=用户本机绝对路径，remote=主机上的绝对路径。缺省冲突即失败：目标已存在返回 conflict_detected（含目标大小/时间）；与用户确认后用 collision=\"skip\"（同名跳过）或 \"overwrite\"（覆盖）重试。传输需人工审批，等待期间此调用阻塞；被拒绝时如实报告。".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "local": { "type": "string", "description": "本机文件绝对路径" },
                    "remote": { "type": "string", "description": "主机目标绝对路径" },
                    "collision": { "type": "string", "enum": ["skip", "overwrite"], "description": "目标已存在时的处置（缺省 fail）" }
                },
                "required": ["local", "remote"]
            }),
        },
        move |input, _ctx| {
            let local = input.get("local").and_then(|v| v.as_str()).ok_or_else(|| anyhow::anyhow!("缺少 local"))?;
            let remote = input.get("remote").and_then(|v| v.as_str()).ok_or_else(|| anyhow::anyhow!("缺少 remote"))?;
            let c = parse_collision(input).map_err(|e| anyhow::anyhow!(e))?;
            transfer_flow(&o6, &s6, local, remote, true, c.as_deref())
        },
    );
    let o7 = ops.clone();
    let s7 = sid.clone();
    let download = CallbackTool::new(
        ToolDef {
            name: "download".into(),
            description: "从远程主机下载文件到本机。remote=主机上的绝对路径，local=用户本机绝对路径。缺省冲突即失败：本地目标已存在返回 conflict_detected（目录目标放行=下载进目录）；与用户确认后用 collision=\"skip\"/\"overwrite\" 重试。传输需人工审批，等待期间此调用阻塞；被拒绝时如实报告。".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "remote": { "type": "string", "description": "主机源文件绝对路径" },
                    "local": { "type": "string", "description": "本机目标绝对路径" },
                    "collision": { "type": "string", "enum": ["skip", "overwrite"], "description": "目标已存在时的处置（缺省 fail）" }
                },
                "required": ["remote", "local"]
            }),
        },
        move |input, _ctx| {
            let remote = input.get("remote").and_then(|v| v.as_str()).ok_or_else(|| anyhow::anyhow!("缺少 remote"))?;
            let local = input.get("local").and_then(|v| v.as_str()).ok_or_else(|| anyhow::anyhow!("缺少 local"))?;
            let c = parse_collision(input).map_err(|e| anyhow::anyhow!(e))?;
            transfer_flow(&o7, &s7, local, remote, false, c.as_deref())
        },
    );
    let o8 = ops.clone();
    let tstatus = CallbackTool::new(
        ToolDef {
            name: "transfer_status".into(),
            description: "查询传输任务当前状态——upload/download 返回了 transfer_id 但仍在进行时用这个对账，不要盲目重试。".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "transfer_id": { "type": "string", "description": "upload/download 返回的任务 id" }
                },
                "required": ["transfer_id"]
            }),
        },
        move |input, _ctx| {
            let tid = input
                .get("transfer_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 transfer_id"))?;
            let p = o8.transfer_status(tid).map_err(|e| anyhow::anyhow!(e))?;
            Ok(ToolOutput::text(poll_json(tid, &p).to_string()))
        },
    );
    let o9 = ops;
    let s9 = sid;
    let keys = CallbackTool::new(
        ToolDef {
            name: "send_keys".into(),
            description: "向会话终端注入按键——驱动交互式程序（vim/htop、sudo 密码、y/n 确认）。回车写 \\r、Tab 写 \\t、Ctrl+C 写 \\x03、Esc 写 \\x1b、方向键 \\x1b[A 等；字面反斜杠序列（模型双重转义时）与真实控制字节都接受。首次使用需一次会话级授权（一次审批，本会话内后续按键免审）；控制权在人类手里时被拒（如实告知用户需要交托会话）。每次发送后用 read_screen/wait_output 确认效果，不要盲发。".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "keys": { "type": "string", "description": "要注入的按键序列（\\r 回车 \\t Tab \\x03 Ctrl+C \\x1b Esc）" }
                },
                "required": ["keys"]
            }),
        },
        move |input, _ctx| {
            let k = input
                .get("keys")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 keys"))?;
            if k.is_empty() {
                return Err(anyhow::anyhow!("keys 不能为空"));
            }
            o9.send_keys(&s9, &interpret_key_escapes(k))
                .map(ToolOutput::text)
                .map_err(|e| anyhow::anyhow!(e))
        },
    );
    // 技能库工具（提示词/技能资产化轮）：仅在装配了资产源时挂载；正文每次调用现读
    //（设置里改技能无需重建 agent），无参=清单（名称+首行简介），带 name=全文。
    if let Some(src) = assets {
        let skills = CallbackTool::new(
            ToolDef {
                name: "load_skill".into(),
                description: "技能库（用户在 设置 → Agent → 提示词与技能 里维护的组织标准流程/操作手册）。不带参数调用=列出全部技能与简介；带 name=返回该技能全文，命中任务就按其步骤执行。".into(),
                schema: json!({
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "技能名称；缺省=列出全部" }
                    }
                }),
            },
            move |input, _ctx| {
                let skills = src.skills();
                match input.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                    None => Ok(ToolOutput::text(skills_list_text(&skills))),
                    Some(n) => skills
                        .iter()
                        .find(|(name, _)| name == n)
                        .map(|(_, body)| ToolOutput::text(body.clone()))
                        .ok_or_else(|| anyhow::anyhow!("技能库中没有「{n}」——不带参数调用可列出全部")),
                }
            },
        );
        return vec![
            Box::new(exec),
            Box::new(screen),
            Box::new(blocks),
            Box::new(wait),
            Box::new(upload),
            Box::new(download),
            Box::new(tstatus),
            Box::new(keys),
            Box::new(skills),
        ];
    }
    vec![
        Box::new(exec),
        Box::new(screen),
        Box::new(blocks),
        Box::new(wait),
        Box::new(upload),
        Box::new(download),
        Box::new(tstatus),
        Box::new(keys),
    ]
}

// ── 编排者（Fleet）工具装配：不绑机器，只派发/等待/汇总 ──

/// 编排者会话的槽位键与事件 sid（FE 用同一常量打开编排视图）。
pub const FLEET_KEY: &str = "fleet";

/// dispatch_task 的背后：Real=用编排者自己的模型配置把任务文本作为用户消息
/// 发给目标会话的执行 agent（agent-host::send，事件仍以目标 sid 桥给 FE，
/// 目标对话在 Agent 视图可见）；Test=弹出预置 mock provider（离线全链测试）。
pub type DispatchFn = Arc<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>;

/// wait_task 轮询节奏（与传输轮询同款测试/生产分叉）。
const WAIT_POLL_MS: u64 = if cfg!(test) { 5 } else { 500 };

fn build_fleet_tools(
    ops: Arc<dyn SshOps>,
    host: std::sync::Weak<AgentHost>,
    self_key: String,
    dispatch: DispatchFn,
) -> Vec<Box<dyn Tool>> {
    let o1 = ops;
    let sessions = CallbackTool::new(
        ToolDef {
            name: "fleet_sessions".into(),
            description: "列出当前已连接的会话（编排目标清单）：session_id、主机名、状态、控制权。派发前先看这个。".into(),
            schema: json!({"type": "object", "properties": {}}),
        },
        move |_input, _ctx| {
            o1.list_sessions()
                .map(ToolOutput::text)
                .map_err(|e| anyhow::anyhow!(e))
        },
    );
    let d2 = dispatch.clone();
    let k2 = self_key.clone();
    let dispatch_tool = CallbackTool::new(
        ToolDef {
            name: "dispatch_task".into(),
            description: "把一条自包含任务派发给目标会话的执行 agent（它有自己的工具面：exec/传输/键入，全部走该会话的既有审批链）。返回即受理（异步执行）；目标正忙会报错，不要丢弃。".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "目标会话 id（fleet_sessions 里拿）" },
                    "task": { "type": "string", "description": "自包含任务描述（目标 agent 看不到你们的对话）" }
                },
                "required": ["session_id", "task"]
            }),
        },
        move |input, _ctx| {
            let sid = input
                .get("session_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 session_id"))?;
            let task = input
                .get("task")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 task"))?;
            if sid == k2 {
                return Err(anyhow::anyhow!("不能派发给编排者自己"));
            }
            d2(sid, task)
                .map(|_| ToolOutput::text(json!({ "dispatched": true, "session_id": sid }).to_string()))
                .map_err(|e| anyhow::anyhow!(e))
        },
    );
    let wait_tool = CallbackTool::new(
        ToolDef {
            name: "wait_task".into(),
            description: "等待目标会话当前任务结束并取回结果（state=done|failed|running + 它最后的文本回复）。并行派发后逐个调用；超时返回 running 可再次调用继续等。".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "目标会话 id" },
                    "timeout_secs": { "type": "integer", "description": "最多等多少秒（缺省 300，上限 900）" }
                },
                "required": ["session_id"]
            }),
        },
        move |input, _ctx| {
            let sid = input
                .get("session_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 session_id"))?;
            let cap = input
                .get("timeout_secs")
                .and_then(|v| v.as_u64())
                .unwrap_or(300)
                .min(900);
            let h = host
                .upgrade()
                .ok_or_else(|| anyhow::anyhow!("宿主已释放"))?;
            let polls = (cap * 1000 / WAIT_POLL_MS).max(1);
            for _ in 0..polls {
                if !h.busy(sid) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(WAIT_POLL_MS));
            }
            let running = h.busy(sid);
            let state = if running {
                "running"
            } else {
                match h.history(sid).iter().rev().find_map(|e| match e {
                    HostEvent::Done { .. } => Some("done"),
                    HostEvent::Failed { .. } => Some("failed"),
                    _ => None,
                }) {
                    Some(s) => s,
                    None => "unknown",
                }
            };
            let mut payload = json!({ "session_id": sid, "state": state });
            if state == "failed" {
                if let Some(HostEvent::Failed { message }) = h
                    .history(sid)
                    .iter()
                    .rev()
                    .find(|e| matches!(e, HostEvent::Failed { .. }))
                {
                    payload["error"] = json!(message);
                }
            }
            if !running {
                if let Some(t) = h.last_final_text(sid) {
                    payload["result"] = json!(tail(&t));
                }
            }
            if running {
                payload["note"] = json!("仍在运行；稍后再次 wait_task 继续等");
            }
            Ok(ToolOutput::text(payload.to_string()))
        },
    );
    vec![
        Box::new(sessions),
        Box::new(dispatch_tool),
        Box::new(wait_tool),
    ]
}

// ── 宿主 ──

#[derive(Default)]
struct SlotState {
    busy: bool,
    cancel: Option<Arc<AtomicBool>>,
    /// 当前 agent 对应的模型配置签名（Real=配置哈希；Test=递增唯一值）——
    /// send 时签名不符即重建 agent（换模型/换 key 生效；对话记忆随之重置，
    /// FE 转写仍在、如实呈现）。
    cfg_sig: Option<u64>,
}

fn sig_of(cfg: &ModelConfig) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    cfg.provider.hash(&mut h);
    cfg.base_url.hash(&mut h);
    cfg.model.hash(&mut h);
    cfg.api_key.hash(&mut h);
    h.finish()
}

/// 任意字符串指纹（附加段折进重建签名用）。
fn hash_str(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

#[cfg(test)]
fn next_test_sig() -> u64 {
    use std::sync::atomic::AtomicU64;
    static TEST_SIG: AtomicU64 = AtomicU64::new(1);
    TEST_SIG.fetch_add(1, Ordering::SeqCst)
}

struct SessionSlot {
    agent: Mutex<Option<tiny_agent::Agent>>,
    state: Mutex<SlotState>,
}

/// 事件回调：`(sid, event)`。Send+Sync——src-tauri 侧闭包里只借 AppHandle。
pub type EventSink = Arc<dyn Fn(&str, &HostEvent) + Send + Sync>;

pub struct AgentHost {
    ops: Arc<dyn SshOps>,
    // 提示词/技能资产源（提示词/技能资产化轮）：Some 时系统提示词追加用户附加段、
    // 会话工具面多出 load_skill；None（测试直连）保持无附加段。
    assets: Option<Arc<dyn PromptAssets>>,
    sessions: Mutex<HashMap<String, Arc<SessionSlot>>>,
    // Arc：运行线程持有句柄写转写，宿主侧 close/history 经 self 访问同一份
    transcripts: Arc<Mutex<HashMap<String, Vec<HostEvent>>>>,
    // 编排者工具要回呼宿主（dispatch→send / wait→busy+history）：由 new_arc
    // 装配的 Weak 自引用；new()（测试直连）不装配，fleet 工具届时报「宿主未装配」。
    self_weak: Mutex<std::sync::Weak<AgentHost>>,
}

enum SendCfg<'a> {
    Real(&'a ModelConfig),
    #[cfg(test)]
    Test(Box<dyn tiny_agent::Provider>),
}

/// 编排者装配包：Some=本次构建用 fleet 工具面（build_fleet_tools）与
/// FLEET_SYS_PROMPT；None=普通会话（八个 SSH 工具 + 可选 load_skill + SYS_PROMPT）。
struct FleetAssemble {
    host: std::sync::Weak<AgentHost>,
    dispatch: DispatchFn,
}

impl AgentHost {
    pub fn new(ops: Arc<dyn SshOps>) -> Self {
        Self {
            ops,
            assets: None,
            sessions: Mutex::new(HashMap::new()),
            transcripts: Arc::new(Mutex::new(HashMap::new())),
            self_weak: Mutex::new(std::sync::Weak::new()),
        }
    }

    /// 应用入口：装配 Weak 自引用（编排者 dispatch/wait 工具回呼宿主用）。
    pub fn new_arc(ops: Arc<dyn SshOps>) -> Arc<Self> {
        Self::new_arc_with(ops, None)
    }

    /// 应用入口（带资产源）：系统提示词追加用户附加段 + 会话面挂 load_skill。
    pub fn new_arc_with(ops: Arc<dyn SshOps>, assets: Option<Arc<dyn PromptAssets>>) -> Arc<Self> {
        let host = Arc::new(Self {
            assets,
            ..Self::new(ops)
        });
        *host.self_weak.lock().unwrap() = Arc::downgrade(&host);
        host
    }

    fn slot(&self, sid: &str) -> Arc<SessionSlot> {
        self.sessions
            .lock()
            .unwrap()
            .entry(sid.to_string())
            .or_insert_with(|| {
                Arc::new(SessionSlot {
                    agent: Mutex::new(None),
                    state: Mutex::new(SlotState::default()),
                })
            })
            .clone()
    }

    /// 会话是否在运行（编排者 wait_task 的完成判定）。get 而非 entry——模型
    /// 喂来任意 sid 不再往 sessions 表塞空槽（幽灵条目累积）。
    pub fn busy(&self, sid: &str) -> bool {
        match self.sessions.lock().unwrap().get(sid) {
            Some(s) => s.state.lock().unwrap().busy,
            None => false,
        }
    }

    /// 目标会话最后一条**封口**的 assistant 文本（编排者 wait_task 取结果用）：
    /// 转写重放——Text/Thinking 增量聚入当前缓冲，任何其他事件封口；只认已封口
    /// 的缓冲（流式中未完的 tail 不算，避免把半截话当结论）。
    pub fn last_final_text(&self, sid: &str) -> Option<String> {
        let list = self.transcripts.lock().unwrap().get(sid)?.clone();
        let mut cur = String::new();
        let mut in_text = false;
        let mut last: Option<String> = None;
        for ev in list {
            match ev {
                HostEvent::Text(t) | HostEvent::Thinking(t) => {
                    cur.push_str(&t);
                    in_text = true;
                }
                _ => {
                    if in_text {
                        if !cur.trim().is_empty() {
                            last = Some(cur);
                        }
                        cur = String::new();
                        in_text = false;
                    }
                }
            }
        }
        last
    }

    /// 发送一条用户消息并启动（或延续）该会话的 agent 运行。
    /// 同会话上一次运行未结束时报错（串行对话——一个终端一个指挥）。
    pub fn send(
        &self,
        sid: &str,
        text: &str,
        cfg: &ModelConfig,
        sink: EventSink,
    ) -> Result<(), String> {
        self.send_inner(sid, text, SendCfg::Real(cfg), sink, None)
    }

    /// 编排者会话：跨会话派发工具面 + FLEET_SYS_PROMPT。dispatch 闭包用编排者
    /// 自己的模型配置把任务发给目标会话（目标对话与审批都在目标侧原样呈现）。
    pub fn send_fleet(&self, text: &str, cfg: &ModelConfig, sink: EventSink) -> Result<(), String> {
        let weak = self.self_weak.lock().unwrap().clone();
        let weak2 = weak.clone();
        let cfg2 = cfg.clone();
        let sink2 = sink.clone();
        let self_key = FLEET_KEY.to_string();
        let dispatch: DispatchFn = Arc::new(move |sid: &str, task: &str| {
            if sid == self_key {
                return Err("不能派发给编排者自己".into());
            }
            let host = weak.upgrade().ok_or_else(|| "宿主已释放".to_string())?;
            host.send(sid, task, &cfg2, sink2.clone())
        });
        self.send_inner(
            FLEET_KEY,
            text,
            SendCfg::Real(cfg),
            sink,
            Some(FleetAssemble {
                host: weak2,
                dispatch,
            }),
        )
    }

    /// 测试专用：注入脚本化 provider 离线驱动全链（依赖 dev-dependencies 的
    /// mock feature——release 构建不含此路径）。
    #[cfg(test)]
    pub fn send_with_mock(
        &self,
        sid: &str,
        text: &str,
        provider: Box<dyn tiny_agent::Provider>,
        sink: EventSink,
    ) -> Result<(), String> {
        self.send_inner(sid, text, SendCfg::Test(provider), sink, None)
    }

    /// 测试专用：编排者离线全链——编排者 provider 脚本化，dispatch 弹出预置的
    /// 目标 provider 队列驱动目标会话（每次派发一个）。
    #[cfg(test)]
    pub fn send_fleet_with_mock(
        &self,
        text: &str,
        provider: Box<dyn tiny_agent::Provider>,
        targets: Arc<Mutex<std::collections::VecDeque<Box<dyn tiny_agent::Provider>>>>,
        sink: EventSink,
    ) -> Result<(), String> {
        let weak = self.self_weak.lock().unwrap().clone();
        let weak2 = weak.clone();
        let sink2 = sink.clone();
        let self_key = FLEET_KEY.to_string();
        let dispatch: DispatchFn = Arc::new(move |sid: &str, task: &str| {
            if sid == self_key {
                return Err("不能派发给编排者自己".into());
            }
            let host = weak.upgrade().ok_or_else(|| "宿主已释放".to_string())?;
            let p = targets
                .lock()
                .unwrap()
                .pop_front()
                .ok_or("测试目标 provider 已耗尽")?;
            host.send_with_mock(sid, task, p, sink2.clone())
        });
        self.send_inner(
            FLEET_KEY,
            text,
            SendCfg::Test(provider),
            sink,
            Some(FleetAssemble {
                host: weak2,
                dispatch,
            }),
        )
    }

    fn send_inner(
        &self,
        sid: &str,
        text: &str,
        cfg: SendCfg<'_>,
        sink: EventSink,
        fleet: Option<FleetAssemble>,
    ) -> Result<(), String> {
        let slot = self.slot(sid);
        let cancel = Arc::new(AtomicBool::new(false));
        // 系统提示词先于 sig 组装：附加段改动折进重建指纹（改设置→下一条消息即重建生效）。
        let sys = compose_sys_prompt(fleet.is_some(), self.assets.as_ref().map(|a| a.as_ref()));
        #[cfg(test)]
        let sig_opt: Option<u64> = match &cfg {
            SendCfg::Real(c) => Some(sig_of(c) ^ hash_str(&sys)),
            SendCfg::Test(_) => Some(next_test_sig()),
        };
        #[cfg(not(test))]
        let sig_opt: Option<u64> = match &cfg {
            SendCfg::Real(c) => Some(sig_of(c) ^ hash_str(&sys)),
        };
        let needs_rebuild;
        {
            let mut st = slot.state.lock().unwrap();
            if st.busy {
                return Err("上一条还在运行（工具执行/审批等待中）——可点停止或稍候".into());
            }
            needs_rebuild = st.cfg_sig != sig_opt;
            st.busy = true;
            st.cancel = Some(cancel.clone());
            st.cfg_sig = sig_opt;
        }

        let transcripts = self.transcripts.clone();
        let sid_owned = sid.to_string();
        let slot2 = slot.clone();
        let ops = self.ops.clone();
        let sid_for_build = sid_owned.clone();
        let assets_for_tools = self.assets.clone();
        let build = move || -> Result<tiny_agent::Agent, String> {
            let tools = match &fleet {
                Some(ft) => build_fleet_tools(
                    ops,
                    ft.host.clone(),
                    sid_for_build.clone(),
                    ft.dispatch.clone(),
                ),
                None => build_tools(ops, sid_for_build, assets_for_tools),
            };
            let (ta_cfg, provider) = match cfg {
                SendCfg::Real(c) => {
                    let mut cfg_json = json!({
                        "provider": c.provider,
                        "api_key_env": "TINYSSH_EMBEDDED_KEY_UNUSED",
                        "model": c.model,
                        "system_prompt": sys,
                        "tools": [],
                        "inject_environment": false,
                    });
                    if let Some(b) = &c.base_url {
                        cfg_json["base_url"] = json!(b);
                    }
                    let ta_cfg: tiny_agent::Config = serde_json::from_value(cfg_json)
                        .map_err(|e| format!("模型服务配置无效：{e}"))?;
                    let client = tiny_agent::provider::new_client(120);
                    let provider = tiny_agent::provider::build(&ta_cfg, &c.api_key, client.clone());
                    (ta_cfg, provider)
                }
                #[cfg(test)]
                SendCfg::Test(p) => {
                    let ta_cfg: tiny_agent::Config = serde_json::from_value(json!({
                        "provider": "openai",
                        "api_key_env": "UNUSED",
                        "model": "mock",
                        "system_prompt": sys,
                        "tools": [],
                        "inject_environment": false,
                    }))
                    .map_err(|e| format!("测试配置无效：{e}"))?;
                    (ta_cfg, p)
                }
            };
            let client = tiny_agent::provider::new_client(120);
            // 无 task 工具（tools: []）→ 自定义 provider 场景，api_key 传空串即可
            tiny_agent::build_agent_with_provider(&ta_cfg, provider, Vec::new(), &client, tools, "")
                .map_err(|e| format!("agent 构建失败：{e}"))
        };

        // 首建/换配置重建在 send 线程做：失败当场回报并清 busy 位，不留僵尸占位
        {
            let mut cell = slot.agent.lock().unwrap();
            if needs_rebuild || cell.is_none() {
                match build() {
                    Ok(agent) => *cell = Some(agent),
                    Err(e) => {
                        let mut st = slot.state.lock().unwrap();
                        st.busy = false;
                        st.cancel = None;
                        st.cfg_sig = None;
                        return Err(e);
                    }
                }
            }
            // push_user 在 run 线程接手前完成（busy 位保证此刻无并发持有者）
            if let Some(agent) = cell.as_mut() {
                agent.push_user(vec![Block::Text(text.to_string())]);
            }
        }

        // 用户消息先入转写 + 推给 FE（乐观气泡之外的事实源——重建对话不能丢用户行）
        sink(&sid, &HostEvent::User(text.to_string()));
        transcripts
            .lock()
            .unwrap()
            .entry(sid.to_string())
            .or_default()
            .push(HostEvent::User(text.to_string()));

        std::thread::spawn(move || {
            let emit = |ev: HostEvent| {
                sink(&sid_owned, &ev);
                let mut t = transcripts.lock().unwrap();
                // close 已撤键则不再回插：会话关闭后运行线程的残余事件曾把
                // 已清空的转写键复活（串扰新会话）。FE 侧 sink 照发（自行忽略）。
                if !t.contains_key(&sid_owned) {
                    return;
                }
                let list = t.get_mut(&sid_owned).expect("key checked above");
                list.push(ev);
                if list.len() > TRANSCRIPT_CAP {
                    let over = list.len() - TRANSCRIPT_CAP;
                    list.drain(..over);
                }
            };
            // catch_unwind 包住运行体：tiny-a 内部 panic 默认只杀线程不杀进程，
            // 但 busy 位焊死会让该会话永远「上一条还在运行」只能重启应用——
            // panic 也走正常收尾（Failed 事件 + busy 复位）
            let outcome =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
                    let mut cell = slot2.agent.lock().unwrap();
                    let Some(agent) = cell.as_mut() else {
                        return Err("会话 agent 已不存在".into());
                    };
                    agent.set_cancel(cancel);
                    // Rust 侧合帧（稳定轮余量项）：真模型每秒可吐百级 TextDelta/
                    // ThinkingDelta，逐条 emit = 逐条 tauri IPC + 转写 push。80ms 窗口
                    // 内合并（或 8KB 上限即冲），换事件种类/工具卡/Done 前先冲尾保序；
                    // 文本是拼接不变量，转写重放与 FE 侧 120ms 合帧行为不变。
                    const COALESCE_WINDOW: std::time::Duration =
                        std::time::Duration::from_millis(80);
                    const COALESCE_CAP: usize = 8 * 1024;
                    let mut text_buf = String::new();
                    let mut think_buf = String::new();
                    let mut last_flush = std::time::Instant::now();
                    let r = agent.run(&mut |ev: tiny_agent::AgentEvent| {
                        let mapped = match ev {
                            tiny_agent::AgentEvent::TurnStart(n) => Some(HostEvent::Turn(n)),
                            tiny_agent::AgentEvent::TextDelta(t) => Some(HostEvent::Text(t)),
                            tiny_agent::AgentEvent::ThinkingDelta(t) => {
                                Some(HostEvent::Thinking(t))
                            }
                            tiny_agent::AgentEvent::ToolCall { name, input } => {
                                Some(HostEvent::ToolStart { name, input })
                            }
                            tiny_agent::AgentEvent::ToolResult {
                                name,
                                is_error,
                                content,
                            } => Some(HostEvent::ToolResult {
                                name,
                                is_error,
                                content: tail(&content),
                            }),
                            tiny_agent::AgentEvent::Warning(w) => Some(HostEvent::Notice(w)),
                            tiny_agent::AgentEvent::Usage {
                                input_tokens,
                                output_tokens,
                                ..
                            } => Some(HostEvent::Usage {
                                input: input_tokens,
                                output: output_tokens,
                            }),
                            tiny_agent::AgentEvent::Done { stop_reason } => {
                                Some(HostEvent::Done { stop_reason })
                            }
                            _ => None,
                        };
                        if let Some(e) = mapped {
                            let now = std::time::Instant::now();
                            let due = now.duration_since(last_flush) >= COALESCE_WINDOW;
                            match e {
                                HostEvent::Text(t) => {
                                    if !think_buf.is_empty() {
                                        let b = std::mem::take(&mut think_buf);
                                        emit(HostEvent::Thinking(b));
                                    }
                                    text_buf.push_str(&t);
                                    if due || text_buf.len() >= COALESCE_CAP {
                                        let b = std::mem::take(&mut text_buf);
                                        emit(HostEvent::Text(b));
                                        last_flush = now;
                                    }
                                }
                                HostEvent::Thinking(t) => {
                                    if !text_buf.is_empty() {
                                        let b = std::mem::take(&mut text_buf);
                                        emit(HostEvent::Text(b));
                                    }
                                    think_buf.push_str(&t);
                                    if due || think_buf.len() >= COALESCE_CAP {
                                        let b = std::mem::take(&mut think_buf);
                                        emit(HostEvent::Thinking(b));
                                        last_flush = now;
                                    }
                                }
                                other => {
                                    if !text_buf.is_empty() {
                                        let b = std::mem::take(&mut text_buf);
                                        emit(HostEvent::Text(b));
                                    }
                                    if !think_buf.is_empty() {
                                        let b = std::mem::take(&mut think_buf);
                                        emit(HostEvent::Thinking(b));
                                    }
                                    last_flush = now;
                                    emit(other);
                                }
                            }
                        }
                    });
                    if !text_buf.is_empty() {
                        let b = std::mem::take(&mut text_buf);
                        emit(HostEvent::Text(b));
                    }
                    if !think_buf.is_empty() {
                        let b = std::mem::take(&mut think_buf);
                        emit(HostEvent::Thinking(b));
                    }
                    match r {
                        Ok(_) => Ok(()),
                        Err(e) => Err(tail(&e.to_string())),
                    }
                }))
                .unwrap_or_else(|p| {
                    Err(format!(
                        "agent 运行线程 panic：{}",
                        p.downcast_ref::<&str>()
                            .map(|s| s.to_string())
                            .or_else(|| p.downcast_ref::<String>().cloned())
                            .unwrap_or_else(|| "unknown panic".into())
                    ))
                });
            if let Err(msg) = outcome {
                emit(HostEvent::Failed { message: msg });
            }
            let mut st = slot2.state.lock().unwrap();
            st.busy = false;
            st.cancel = None;
        });
        Ok(())
    }

    /// 请求取消当前运行（工具/轮次间隙生效——tiny-a 的取消语义）。
    /// 返回是否确有运行在途。get 而非 entry：未知 sid 不建空槽。
    pub fn cancel(&self, sid: &str) -> bool {
        let slot = match self.sessions.lock().unwrap().get(sid) {
            Some(s) => s.clone(),
            None => return false,
        };
        let st = slot.state.lock().unwrap();
        match &st.cancel {
            Some(f) => {
                f.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// 会话关闭：撤槽位 + 清转写（运行中的线程持 Arc 自然收尾；取消先发）。
    pub fn close(&self, sid: &str) {
        self.cancel(sid);
        self.sessions.lock().unwrap().remove(sid);
        self.transcripts.lock().unwrap().remove(sid);
    }

    /// FE 重挂载重建对话：转写缓存（最旧在前）。
    pub fn history(&self, sid: &str) -> Vec<HostEvent> {
        self.transcripts
            .lock()
            .unwrap()
            .get(sid)
            .cloned()
            .unwrap_or_default()
    }

    /// 测试/关停同步：等待会话空闲（上限 30s，防挂死）。
    pub fn wait_idle(&self, sid: &str) -> bool {
        for _ in 0..1500 {
            if !self.busy(sid) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tiny_agent::provider::mock::{self, MockProvider};

    #[derive(Default)]
    struct FakeOps {
        cmds: Mutex<Vec<String>>,
        /// 预置一次性闸门：首个 exec 阻塞直到收到信号（并发/busy 测试用）。
        gate: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
        // ---- 传输面预置/记录（None 预置=缺省行为：stat 不存在、start 成功 t-N、
        // status 按 polls 队列，耗尽即 running）----
        remote_stat: Mutex<Option<Result<Option<StatInfo>, String>>>,
        local_stat: Mutex<Option<Result<Option<StatInfo>, String>>>,
        start_results: Mutex<std::collections::VecDeque<Result<String, String>>>,
        polls: Mutex<std::collections::VecDeque<TransferPoll>>,
        /// send_keys 预置结果队列（耗尽即成功）+ 键序记录。
        send_keys_results: Mutex<std::collections::VecDeque<Result<String, String>>>,
        keys_sent: Mutex<Vec<String>>,
        calls: Mutex<Vec<String>>,
    }
    impl SshOps for FakeOps {
        fn exec(
            &self,
            _sid: &str,
            cmd: &str,
            _t: Option<u64>,
            _c: Option<u64>,
            _mode: Option<&str>,
        ) -> Result<String, String> {
            self.cmds.lock().unwrap().push(cmd.to_string());
            if let Some(rx) = self.gate.lock().unwrap().take() {
                let _ = rx.recv();
            }
            Ok(json!({"exec_id":"e1","exit_code":0,"stdout":"hi\n","stderr":"","truncated":false,"duration_ms":5,"approval":"auto"}).to_string())
        }
        fn read_screen(&self, _sid: &str) -> Result<String, String> {
            Ok(json!({"cols":120,"rows":30,"text":"$ ","cursor_row":1,"cursor_col":3,"alt_screen":false}).to_string())
        }
        fn read_blocks(&self, _sid: &str, limit: u32) -> Result<String, String> {
            Ok(json!([{"command":"old","exit_code":0,"limit":limit}]).to_string())
        }
        fn wait_output(
            &self,
            _sid: &str,
            _q: Option<u64>,
            _r: Option<String>,
            _t: Option<u64>,
        ) -> Result<String, String> {
            Ok(json!({"text":"done","matched":false,"truncated_to_cap":false}).to_string())
        }
        fn stat_remote(&self, _sid: &str, path: &str) -> Result<Option<StatInfo>, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("stat_remote:{path}"));
            match self.remote_stat.lock().unwrap().take() {
                Some(r) => r,
                None => Ok(None),
            }
        }
        fn stat_local(&self, path: &str) -> Result<Option<StatInfo>, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("stat_local:{path}"));
            match self.local_stat.lock().unwrap().take() {
                Some(r) => r,
                None => Ok(None),
            }
        }
        fn transfer_start(
            &self,
            _sid: &str,
            local: &str,
            remote: &str,
            is_upload: bool,
            collision: Option<&str>,
        ) -> Result<String, String> {
            self.calls.lock().unwrap().push(format!(
                "start:{}:{local}:{remote}:{collision:?}",
                if is_upload { "up" } else { "down" }
            ));
            self.start_results
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Ok("t-1".into()))
        }
        fn transfer_status(&self, tid: &str) -> Result<TransferPoll, String> {
            self.calls.lock().unwrap().push(format!("status:{tid}"));
            Ok(self
                .polls
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(TransferPoll {
                    status: "running".into(),
                    error: None,
                    bytes_done: 0,
                    total: None,
                }))
        }
        fn send_keys(&self, _sid: &str, keys: &str) -> Result<String, String> {
            self.keys_sent.lock().unwrap().push(keys.to_string());
            self.send_keys_results
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Ok(json!({"sent": true}).to_string()))
        }
        fn list_sessions(&self) -> Result<String, String> {
            Ok(json!([
                {"session_id": "t1", "host": "web-1", "kind": "ssh", "state": "Ready", "control_owner": "Agent"},
                {"session_id": "t2", "host": "db-1", "kind": "ssh", "state": "Ready", "control_owner": "Agent"}
            ])
            .to_string())
        }
    }

    fn collect() -> (Arc<Mutex<Vec<HostEvent>>>, EventSink) {
        let ev = Arc::new(Mutex::new(Vec::new()));
        let ev2 = ev.clone();
        (
            ev,
            Arc::new(move |_sid: &str, e: &HostEvent| ev2.lock().unwrap().push(e.clone())),
        )
    }

    fn kinds(ev: &[HostEvent]) -> Vec<&'static str> {
        ev.iter()
            .map(|e| match e {
                HostEvent::User(_) => "user",
                HostEvent::Turn(_) => "turn",
                HostEvent::Text(_) => "text",
                HostEvent::Thinking(_) => "thinking",
                HostEvent::ToolStart { .. } => "tool_start",
                HostEvent::ToolResult { .. } => "tool_result",
                HostEvent::Notice(_) => "notice",
                HostEvent::Usage { .. } => "usage",
                HostEvent::Done { .. } => "done",
                HostEvent::Failed { .. } => "failed",
            })
            .collect()
    }

    #[test]
    fn scripted_turn_execs_streams_and_continues_session() {
        let ops = Arc::new(FakeOps::default());
        let host = AgentHost::new(ops.clone());
        let (ev, sink) = collect();
        let (prov, _state) = MockProvider::new(vec![
            mock::resp_tool("t1", "exec", json!({"command": "echo hi"}), None),
            mock::resp_text("完成了，退出码 0。", None),
        ]);
        host.send_with_mock("s1", "跑一下 echo", Box::new(prov), sink)
            .expect("send");
        assert!(host.wait_idle("s1"), "运行未在期限内结束");
        let k = kinds(&ev.lock().unwrap());
        assert!(
            k.contains(&"tool_start") && k.contains(&"tool_result") && k.contains(&"done"),
            "事件序列缺件：{k:?}"
        );
        assert_eq!(*ops.cmds.lock().unwrap(), vec!["echo hi".to_string()]);
        // 转写与事件一一对应（FE 重建语义）
        assert_eq!(host.history("s1").len(), ev.lock().unwrap().len());

        // 同会话第二条：注入新 provider（每次 mock 发送都换新 agent——签名语义），
        // 断言第二轮恰好一轮请求
        let (ev2, sink2) = collect();
        let (prov2, state2) = MockProvider::new(vec![mock::resp_text("继续答", None)]);
        host.send_with_mock("s1", "再问一句", Box::new(prov2), sink2)
            .expect("send2");
        assert!(host.wait_idle("s1"));
        assert!(kinds(&ev2.lock().unwrap()).contains(&"done"));
        assert_eq!(state2.captured().len(), 1, "第二次运行应恰好一轮请求");
    }

    #[test]
    fn concurrent_send_is_rejected_until_idle() {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let ops = Arc::new(FakeOps {
            cmds: Mutex::new(vec![]),
            gate: Mutex::new(Some(rx)),
            ..Default::default()
        });
        let host = AgentHost::new(ops);
        let (_ev, sink) = collect();
        let (prov, _s) = MockProvider::new(vec![
            mock::resp_tool("t1", "exec", json!({"command": "sleep"}), None),
            mock::resp_text("done", None),
        ]);
        host.send_with_mock("s2", "第一条", Box::new(prov), sink.clone())
            .expect("send1");
        // exec 卡在闸门上 → 第二条必须被拒
        let (prov2, _s2) = MockProvider::new(vec![mock::resp_text("x", None)]);
        let err = host
            .send_with_mock("s2", "第二条", Box::new(prov2), sink)
            .unwrap_err();
        assert!(err.contains("还在运行"), "应报运行中：{err}");
        tx.send(()).unwrap(); // 放行第一条
        assert!(host.wait_idle("s2"));
        // 空闲后可再次发送
        let (prov3, _s3) = MockProvider::new(vec![mock::resp_text("ok", None)]);
        host.send_with_mock("s2", "第三条", Box::new(prov3), Arc::new(|_, _| {}))
            .expect("send3");
        assert!(host.wait_idle("s2"));
    }

    #[test]
    fn tool_error_becomes_is_error_result_and_run_fails_gracefully() {
        struct ErrOps;
        impl SshOps for ErrOps {
            fn exec(
                &self,
                _s: &str,
                _c: &str,
                _t: Option<u64>,
                _o: Option<u64>,
                _mode: Option<&str>,
            ) -> Result<String, String> {
                Err("会话不存在".into())
            }
            fn read_screen(&self, _: &str) -> Result<String, String> {
                Err("会话不存在".into())
            }
            fn read_blocks(&self, _: &str, _: u32) -> Result<String, String> {
                Err("会话不存在".into())
            }
            fn wait_output(
                &self,
                _: &str,
                _: Option<u64>,
                _: Option<String>,
                _: Option<u64>,
            ) -> Result<String, String> {
                Err("会话不存在".into())
            }
            fn stat_remote(&self, _: &str, _: &str) -> Result<Option<StatInfo>, String> {
                Err("会话不存在".into())
            }
            fn stat_local(&self, _: &str) -> Result<Option<StatInfo>, String> {
                Err("会话不存在".into())
            }
            fn transfer_start(
                &self,
                _: &str,
                _: &str,
                _: &str,
                _: bool,
                _: Option<&str>,
            ) -> Result<String, String> {
                Err("会话不存在".into())
            }
            fn transfer_status(&self, _: &str) -> Result<TransferPoll, String> {
                Err("会话不存在".into())
            }
            fn send_keys(&self, _: &str, _: &str) -> Result<String, String> {
                Err("会话不存在".into())
            }
            fn list_sessions(&self) -> Result<String, String> {
                Err("会话不存在".into())
            }
        }
        let host = AgentHost::new(Arc::new(ErrOps));
        let (ev, sink) = collect();
        let (prov, _s) = MockProvider::new(vec![
            mock::resp_tool("t1", "exec", json!({"command": "boom"}), None),
            mock::resp_text("工具报错了", None),
        ]);
        host.send_with_mock("s3", "试一下", Box::new(prov), sink)
            .expect("send");
        assert!(host.wait_idle("s3"));
        let evs = ev.lock().unwrap();
        let tr = evs.iter().find_map(|e| match e {
            HostEvent::ToolResult {
                is_error, content, ..
            } => Some((*is_error, content.as_str())),
            _ => None,
        });
        assert_eq!(
            tr,
            Some((true, "会话不存在")),
            "ops 错误应成为 is_error 工具结果"
        );
    }

    #[test]
    fn close_clears_transcript_and_slot() {
        let ops = Arc::new(FakeOps::default());
        let host = AgentHost::new(ops);
        let (_ev, sink) = collect();
        let (prov, _s) = MockProvider::new(vec![mock::resp_text("x", None)]);
        host.send_with_mock("s4", "hi", Box::new(prov), sink)
            .unwrap();
        assert!(host.wait_idle("s4"));
        assert!(!host.history("s4").is_empty());
        host.close("s4");
        assert!(host.history("s4").is_empty());
        assert!(!host.cancel("s4"), "关闭后无运行可取消");
    }

    #[test]
    fn upload_conflict_overwrite_then_deny_paths() {
        let ops = Arc::new(FakeOps {
            remote_stat: Mutex::new(Some(Ok(Some(StatInfo {
                size: Some(3),
                mtime: Some(1),
                is_dir: false,
            })))),
            start_results: Mutex::new(std::collections::VecDeque::from(vec![
                Ok("t-9".into()),
                Err("审批被拒绝（transfer）：人类拒绝".into()),
            ])),
            polls: Mutex::new(std::collections::VecDeque::from(vec![TransferPoll {
                status: "succeeded".into(),
                error: None,
                bytes_done: 3,
                total: Some(3),
            }])),
            ..Default::default()
        });
        let host = AgentHost::new(ops.clone());
        let (ev, sink) = collect();
        let (prov, _s) = MockProvider::new(vec![
            mock::resp_tool(
                "t1",
                "upload",
                json!({"local": "C:\\a.txt", "remote": "/tmp/a.txt"}),
                None,
            ),
            mock::resp_tool(
                "t2",
                "upload",
                json!({"local": "C:\\a.txt", "remote": "/tmp/a.txt", "collision": "overwrite"}),
                None,
            ),
            mock::resp_tool(
                "t3",
                "upload",
                json!({"local": "C:\\a.txt", "remote": "/tmp/a.txt"}),
                None,
            ),
            mock::resp_tool(
                "t4",
                "upload",
                json!({"local": "C:\\a.txt", "remote": "/tmp/a.txt", "collision": "nuke"}),
                None,
            ),
            mock::resp_text("结束", None),
        ]);
        host.send_with_mock("s5", "传个文件", Box::new(prov), sink)
            .expect("send");
        assert!(host.wait_idle("s5"));

        let results: Vec<(bool, String)> = ev
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                HostEvent::ToolResult {
                    is_error, content, ..
                } => Some((*is_error, content.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(results.len(), 4, "应有 4 个工具结果：{results:?}");
        // ① 缺省 fail：结构化冲突，且不建任务（start 未被调用）
        assert!(results[0].0, "冲突应为 is_error");
        assert!(
            results[0].1.contains("conflict_detected"),
            "{}",
            results[0].1
        );
        // JSON 转义后反斜杠成对出现，断言只锚文件名
        assert!(results[0].1.contains("a.txt"), "{}", results[0].1);
        // ② overwrite：预检放行 → start → 终态 succeeded
        assert!(!results[1].0);
        assert!(results[1].1.contains("t-9") && results[1].1.contains("succeeded"));
        // ③ 审批拒绝透传为 is_error（模型据此如实报告，不换花样重试）
        assert!(results[2].0 && results[2].1.contains("审批被拒绝"));
        // ④ 非法 collision 即参数错误
        assert!(results[3].0 && results[3].1.contains("collision 仅支持"));

        let calls = ops.calls.lock().unwrap().clone();
        let first_start = calls
            .iter()
            .find(|c| c.starts_with("start:"))
            .expect("应有 start 调用");
        assert!(
            first_start.contains("Some(\"overwrite\")"),
            "首个 start 必须是 overwrite（缺省冲突路径不得建任务）：{calls:?}"
        );
        assert!(
            calls.iter().any(|c| c == "status:t-9"),
            "应轮询终态：{calls:?}"
        );
    }

    #[test]
    fn download_local_conflict_timeout_then_status_tool() {
        let ops = Arc::new(FakeOps {
            local_stat: Mutex::new(Some(Ok(Some(StatInfo {
                size: Some(7),
                mtime: Some(2),
                is_dir: false,
            })))),
            ..Default::default()
        });
        let host = AgentHost::new(ops.clone());
        let (ev, sink) = collect();
        // polls 预置为空 → start 后一直 running → 走满轮询上限（测试 5ms×120）交回
        // transfer_id；下一轮 transfer_status 工具对账。
        let (prov, _s) = MockProvider::new(vec![
            mock::resp_tool(
                "t1",
                "download",
                json!({"remote": "/r/log.txt", "local": "C:\\b.txt"}),
                None,
            ),
            mock::resp_tool(
                "t2",
                "download",
                json!({"remote": "/r/log.txt", "local": "C:\\b.txt", "collision": "skip"}),
                None,
            ),
            mock::resp_tool("t3", "transfer_status", json!({"transfer_id": "t-1"}), None),
            mock::resp_text("还在传", None),
        ]);
        host.send_with_mock("s6", "拉个日志", Box::new(prov), sink)
            .expect("send");
        assert!(host.wait_idle("s6"), "超时路径应在轮询上限内结束");

        let results: Vec<(bool, String)> = ev
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                HostEvent::ToolResult {
                    is_error, content, ..
                } => Some((*is_error, content.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(results.len(), 3, "应有 3 个工具结果：{results:?}");
        // ① 本地目标冲突（download 预检查的是本地，不是远端）
        assert!(results[0].0 && results[0].1.contains("conflict_detected"));
        assert!(results[0].1.contains("b.txt"));
        // ② skip 预检放行 → 60s（测试窗）内仍在 running → 交回 transfer_id + 对账指引
        assert!(!results[1].0, "超时交回不是错误：{}", results[1].1);
        assert!(results[1].1.contains("t-1") && results[1].1.contains("仍在进行"));
        // ③ transfer_status 工具对账同一 id
        assert!(
            results[2].1.contains("\"transfer_id\":\"t-1\"") && results[2].1.contains("running")
        );

        let calls = ops.calls.lock().unwrap().clone();
        assert!(
            calls.iter().any(|c| c == "stat_local:C:\\b.txt"),
            "download 预检应 stat 本地：{calls:?}"
        );
        assert!(
            calls
                .iter()
                .any(|c| c.contains("start:down:") && c.contains("Some(\"skip\")")),
            "skip 应带 collision 发起：{calls:?}"
        );
    }

    #[test]
    fn send_keys_records_and_error_passthrough() {
        let ops = Arc::new(FakeOps {
            // 预置两次成功占位 + 一次拒绝（会话级授权被人类拒绝）→ 第三拍 is_error 透传
            send_keys_results: Mutex::new(std::collections::VecDeque::from(vec![
                Ok(json!({"sent": true}).to_string()),
                Ok(json!({"sent": true}).to_string()),
                Err("审批被拒绝（send_keys）：人类拒绝会话级授权".into()),
            ])),
            ..Default::default()
        });
        let host = AgentHost::new(ops.clone());
        let (ev, sink) = collect();
        // JSON 里的 \r \x03 由 serde 解成真实控制字符再进 SshOps（转义契约）
        let (prov, _s) = MockProvider::new(vec![
            mock::resp_tool("t1", "send_keys", json!({"keys": "j"}), None),
            mock::resp_tool("t2", "send_keys", json!({"keys": "\r"}), None),
            mock::resp_tool("t3", "send_keys", json!({"keys": "\x03"}), None),
            mock::resp_text("退出了", None),
        ]);
        host.send_with_mock("s7", "操作一下 vim", Box::new(prov), sink)
            .expect("send");
        assert!(host.wait_idle("s7"));

        let results: Vec<(bool, String)> = ev
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                HostEvent::ToolResult {
                    is_error, content, ..
                } => Some((*is_error, content.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(results.len(), 3, "应有 3 个工具结果：{results:?}");
        assert!(!results[0].0 && results[0].1.contains("sent"));
        assert!(!results[1].0 && results[1].1.contains("sent"));
        assert!(results[2].0 && results[2].1.contains("审批被拒绝"));
        // 键序按序到达 SshOps；JSON 转义已解成真实控制字符
        assert_eq!(
            *ops.keys_sent.lock().unwrap(),
            vec!["j".to_string(), "\r".to_string(), "\x03".to_string()]
        );
    }

    #[test]
    fn key_escapes_interpreted() {
        // 字面转义（模型双重转义、JSON 解码后残留 "\r" 两字符）→ 真实控制字节
        assert_eq!(interpret_key_escapes("echo ok\\r"), "echo ok\r");
        assert_eq!(interpret_key_escapes("a\\tb"), "a\tb");
        assert_eq!(interpret_key_escapes("\\x1b"), "\x1b");
        assert_eq!(interpret_key_escapes("\\x03"), "\x03");
        assert_eq!(interpret_key_escapes("\\x41\\x42\\x43"), "ABC");
        // \\\\ 字面反斜杠自身 → 单个反斜杠
        assert_eq!(interpret_key_escapes("a\\\\b"), "a\\b");
        // 真实控制字节（JSON 正确解码）直通不受影响
        assert_eq!(interpret_key_escapes("j\r"), "j\r");
        assert_eq!(interpret_key_escapes("\x1b[A"), "\x1b[A");
        // 未知转义原样保留（诚实）；非转义反斜杠尾不崩
        assert_eq!(interpret_key_escapes("\\q"), "\\q");
        assert_eq!(interpret_key_escapes("a\\"), "a\\");
        // CJK 与无反斜杠文本原样
        assert_eq!(interpret_key_escapes("普通文本"), "普通文本");
        assert_eq!(interpret_key_escapes(""), "");
    }

    #[test]
    fn fleet_dispatch_wait_and_aggregate() {
        let ops = Arc::new(FakeOps::default());
        // new_arc：装配 Weak 自引用（dispatch/wait 工具回呼宿主）
        let host = AgentHost::new_arc(ops.clone());
        let (ev, sink) = collect();
        // 编排者脚本：看清单 → 并行派发两台 → 逐个等待 → 自派发被拒 → 汇总
        let (fleet_prov, _fs) = MockProvider::new(vec![
            mock::resp_tool("f1", "fleet_sessions", json!({}), None),
            mock::resp_tool(
                "f2",
                "dispatch_task",
                json!({"session_id": "t1", "task": "查磁盘占用"}),
                None,
            ),
            mock::resp_tool(
                "f3",
                "dispatch_task",
                json!({"session_id": "t2", "task": "查内存"}),
                None,
            ),
            mock::resp_tool("f4", "wait_task", json!({"session_id": "t1"}), None),
            mock::resp_tool("f5", "wait_task", json!({"session_id": "t2"}), None),
            mock::resp_tool(
                "f6",
                "dispatch_task",
                json!({"session_id": "fleet", "task": "自派发应被拒"}),
                None,
            ),
            mock::resp_text("两台都完成了", None),
        ]);
        // 目标机脚本：各自 exec + 文本总结（每次派发弹出一个 provider）
        let (p1, _s1) = MockProvider::new(vec![
            mock::resp_tool("a1", "exec", json!({"command": "df -h"}), None),
            mock::resp_text("磁盘 40% 已用", None),
        ]);
        let (p2, _s2) = MockProvider::new(vec![
            mock::resp_tool("a2", "exec", json!({"command": "free -m"}), None),
            mock::resp_text("内存 2G/8G", None),
        ]);
        let targets: Arc<Mutex<std::collections::VecDeque<Box<dyn tiny_agent::Provider>>>> =
            Arc::new(Mutex::new(std::collections::VecDeque::from(vec![
                Box::new(p1) as Box<dyn tiny_agent::Provider>,
                Box::new(p2) as Box<dyn tiny_agent::Provider>,
            ])));
        host.send_fleet_with_mock("盘点两台机器", Box::new(fleet_prov), targets, sink)
            .expect("send fleet");
        assert!(host.wait_idle(FLEET_KEY), "编排运行未在期限内结束");
        assert!(
            host.wait_idle("t1") && host.wait_idle("t2"),
            "目标运行未结束"
        );

        // 目标机真实执行了各自任务（Session 工具面，非编排面）
        assert_eq!(
            *ops.cmds.lock().unwrap(),
            vec!["df -h".to_string(), "free -m".to_string()]
        );
        let evs = ev.lock().unwrap();
        let result_texts: Vec<String> = evs
            .iter()
            .filter_map(|e| match e {
                HostEvent::ToolResult { content, .. } => Some(content.clone()),
                _ => None,
            })
            .collect();
        // 清单给到编排者
        assert!(
            result_texts
                .iter()
                .any(|t| t.contains("web-1") && t.contains("db-1")),
            "fleet_sessions 结果应有目标清单：{result_texts:?}"
        );
        // 两个 wait_task 都 done 且带回目标最后文本
        assert!(
            result_texts
                .iter()
                .any(|t| t.contains("\"session_id\":\"t1\"")
                    && t.contains("\"state\":\"done\"")
                    && t.contains("磁盘 40% 已用")),
            "wait t1 应 done 带结果：{result_texts:?}"
        );
        assert!(
            result_texts
                .iter()
                .any(|t| t.contains("\"session_id\":\"t2\"")
                    && t.contains("\"state\":\"done\"")
                    && t.contains("内存 2G/8G")),
            "wait t2 应 done 带结果：{result_texts:?}"
        );
        // 自派发被拒（编排者不能指使自己）
        assert!(
            result_texts
                .iter()
                .any(|t| t.contains("不能派发给编排者自己")),
            "自派发应被拒：{result_texts:?}"
        );
        // 编排者转写独立成键（FE 编排视图重建用）
        let fleet_hist = host.history(FLEET_KEY);
        assert!(fleet_hist
            .iter()
            .any(|e| matches!(e, HostEvent::User(t) if t == "盘点两台机器")));
        // last_final_text：目标总结可提取（wait_task 的数据源）
        assert_eq!(host.last_final_text("t1").as_deref(), Some("磁盘 40% 已用"));
        assert_eq!(host.last_final_text("t2").as_deref(), Some("内存 2G/8G"));
    }

    // ── 提示词/技能资产化 ──

    /// 测试资产源：固定内容。
    struct FixedAssets {
        session: String,
        fleet: String,
        skills: Vec<(String, String)>,
    }
    impl Default for FixedAssets {
        fn default() -> Self {
            Self {
                session: String::new(),
                fleet: String::new(),
                skills: Vec::new(),
            }
        }
    }
    impl PromptAssets for FixedAssets {
        fn session_extra(&self) -> String {
            self.session.clone()
        }
        fn fleet_extra(&self) -> String {
            self.fleet.clone()
        }
        fn skills(&self) -> Vec<(String, String)> {
            self.skills.clone()
        }
    }

    #[test]
    fn builtin_prompt_contract_keeps_safety_lines() {
        // 资产文件是「可改的」——安全契约行必须钉死，改丢即测试红
        for kw in [
            "审批",
            "不虚构",
            "简体中文",
            "exec",
            "upload",
            "download",
            "send_keys",
        ] {
            assert!(SYS_PROMPT.contains(kw), "SYS_PROMPT 丢失关键契约行：{kw}");
        }
        for kw in ["不直接操作任何机器", "自包含", "如实", "简体中文"] {
            assert!(
                FLEET_SYS_PROMPT.contains(kw),
                "FLEET_SYS_PROMPT 丢失关键契约行：{kw}"
            );
        }
    }

    #[test]
    fn compose_without_assets_is_builtin_verbatim() {
        // 无资产源（测试直连路径）行为与资产化前一致
        assert_eq!(compose_sys_prompt(false, None), SYS_PROMPT);
        assert_eq!(compose_sys_prompt(true, None), FLEET_SYS_PROMPT);
    }

    #[test]
    fn compose_appends_extra_and_skills_line() {
        let a = FixedAssets {
            session: "  生产库只读优先，改动先报备  ".into(),
            fleet: "汇总用表格".into(),
            skills: vec![],
        };
        let with = compose_sys_prompt(false, Some(&a));
        assert!(
            with.starts_with(SYS_PROMPT),
            "附加段只能追加在内置提示词之后"
        );
        assert!(with.contains("用户附加约定"));
        assert!(with.contains("生产库只读优先，改动先报备"), "trim 后再追加");
        assert!(with.contains("load_skill"), "会话面要教模型用技能库");
        let fleet = compose_sys_prompt(true, Some(&a));
        assert!(fleet.starts_with(FLEET_SYS_PROMPT));
        assert!(fleet.contains("汇总用表格"));
        assert!(
            !fleet.contains("load_skill"),
            "Fleet 不挂技能库（任务自包含契约）"
        );
        // 无附加段：不加约定标题，但会话面仍保留技能库引导行
        let b = FixedAssets::default();
        let plain = compose_sys_prompt(false, Some(&b));
        assert!(!plain.contains("用户附加约定"));
        assert!(plain.contains("load_skill"));
    }

    #[test]
    fn extra_cap_truncates_on_char_boundary() {
        let long = "测".repeat(PROMPT_EXTRA_CAP); // 每字 3 字节，必超限
        let out = clamp_utf8_head(&long, PROMPT_EXTRA_CAP);
        assert!(out.len() < long.len() + 64, "超限必须截断");
        assert!(out.ends_with("…（附加段超长，已截断）"));
        assert!(out.contains("测"), "保头截断");
        assert!(!out.ends_with('\u{FFFD}'), "截断不得落在字符中间");
        // 上限内原样通过
        assert_eq!(clamp_utf8_head("abc", 100), "abc");
    }

    #[test]
    fn skills_list_text_formats_and_handles_empty() {
        assert!(skills_list_text(&[]).contains("技能库为空"));
        let s = skills_list_text(&[
            (
                "nginx 排障".into(),
                "先看 error.log 的 upstream 超时\n再查端口".into(),
            ),
            ("备份".into(), "rsync 快照".into()),
        ]);
        assert!(s.contains("- nginx 排障——先看 error.log 的 upstream 超时"));
        assert!(s.contains("- 备份——rsync 快照"), "简介只取首行");
        assert!(!s.contains("再查端口"), "清单不携带正文");
    }
}
