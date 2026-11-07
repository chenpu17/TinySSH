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
#[derive(Clone)]
pub struct ModelConfig {
    /// "openai"（OpenAI 兼容：GLM/DeepSeek/Qwen/Kimi…）| "anthropic"。
    pub provider: String,
    pub base_url: Option<String>,
    pub model: String,
    pub api_key: String,
}

/// 手写 Debug：api_key 永远不进入日志/诊断包（derive 会把明文打出来）。
impl std::fmt::Debug for ModelConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ModelConfig")
            .field("provider", &self.provider)
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("api_key", &"***")
            .finish()
    }
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
        /// 给人看的展示文本（exec/read_screen 从 JSON 提取 stdout/stderr/屏幕文本）；
        /// None = 前端直接用 content。模型看到的内容仍是 content 的完整版。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display: Option<String>,
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
/// 单次模型请求的 SSE 空闲上限（秒）。TinyAgent 缺省 30s 对普通聊天模型够用，
/// 但推理模型（DeepSeek-R1/o-series/GLM 思考档）在首 token 前可能静默数分钟；
/// 30s 会把它误判成半开连接（stop_reason=stream_idle），用户看到「回答突然结束」。
/// 300s 覆盖长思考（R1 类模型偶发数分钟首 token），同时仍能回收真正卡死的连接。
const AGENT_STREAM_IDLE_SECS: u64 = 300;
/// 单次 Agent 运行的墙钟上限（秒）。TinyAgent 缺省 600s，长任务/多轮工具回路
/// 容易被无声截断；交互式 Agent 由用户「停止」兜底，放宽到 30 分钟。
const AGENT_RUN_TIMEOUT_SECS: u64 = 1800;
/// 传输轮询节奏（500ms×120 = 60s 上限；测试缩为 5ms 让超时路径秒级跑完）。
const TRANSFER_POLL_MS: u64 = if cfg!(test) { 5 } else { 500 };
const TRANSFER_POLL_CAP: u32 = 120;

/// collision 参数解析：缺省 fail（None）；仅接受 skip|overwrite，其余即工具错误。
fn parse_collision(input: &serde_json::Value) -> Result<Option<String>, String> {
    if let Some(v) = input.get("collision") {
        if !v.is_string() {
            return Err("collision 必须是字符串（skip）".into());
        }
    }
    match input.get("collision").and_then(|v| v.as_str()) {
        None | Some("") => Ok(None),
        Some("skip") => Ok(Some("skip".into())),
        // core-session 的 Agent 传输路径对 overwrite 一律 ReplaceUnsupported
        //（远端无原子替换原语/本地覆盖只对人类决策开放）。在工具层就明确拒绝，
        // 不浪费一次审批再失败。
        Some("overwrite") => Err(
            "Agent 传输不支持覆盖（core 对 Agent 一律拒绝 overwrite）——请用 collision=\"skip\" 或换一个目标路径".into(),
        ),
        Some(other) => Err(format!(
            "collision 仅支持 skip（缺省 fail），得到 {other:?}"
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
    cancel: Option<&AtomicBool>,
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
                        "hint": "目标已存在；与用户确认后用 collision=\"skip\"（同名跳过）重试，或换一个目标路径（Agent 路径不支持覆盖）",
                    })
                    .to_string(),
                ));
            }
        }
    }
    let cancelled = || cancel.is_some_and(|c| c.load(Ordering::Relaxed));
    if cancelled() {
        return Ok(ToolOutput::error("已停止（传输未发起）"));
    }
    let tid = ops
        .transfer_start(sid, local, remote, is_upload, collision)
        .map_err(|e| anyhow::anyhow!(e))?;
    for _ in 0..TRANSFER_POLL_CAP {
        std::thread::sleep(std::time::Duration::from_millis(TRANSFER_POLL_MS));
        if cancelled() {
            return Ok(ToolOutput::error(
                json!({"transfer_id": tid, "status": "cancelled_by_user", "note": "用户已停止；传输可能仍在后台继续，可用 transfer_status 对账"}).to_string(),
            ));
        }
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

/// 工具入口的取消检查。工具本身是同步阻塞的（审批/长命令），无法在中途打断；
/// 至少保证用户点停止后不再发起新工具，并把已返回的结果标成取消而不是继续喂给模型。
fn tool_cancelled(ctx: &tiny_agent::ToolCtx) -> bool {
    ctx.cancel
        .as_ref()
        .is_some_and(|c| c.load(Ordering::Relaxed))
}

/// 工具结果的「给人看」文本：SSH 桥返回的是 JSON，直接塞进 UI 会显示
/// `{"exec_id":...}` 转义串。只做展示层提取，不改变模型看到的 content。
fn display_tool_result(name: &str, content: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(content).ok()?;
    match name {
        "exec" => {
            let code = v.get("exit_code").and_then(|x| x.as_i64());
            let stdout = v.get("stdout").and_then(|x| x.as_str()).unwrap_or("");
            let stderr = v.get("stderr").and_then(|x| x.as_str()).unwrap_or("");
            let mut out = String::new();
            if let Some(c) = code {
                out.push_str(&format!("exit {c}\n"));
            }
            out.push_str(stdout);
            if !stderr.is_empty() {
                if !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str("[stderr]\n");
                out.push_str(stderr);
            }
            Some(tail(&out))
        }
        "read_screen" => v.get("text").and_then(|x| x.as_str()).map(|s| tail(s)),
        "read_blocks" => {
            let arr = v.as_array()?;
            let mut out = String::new();
            for b in arr {
                let cmd = b.get("command").and_then(|x| x.as_str()).unwrap_or("");
                let code = b.get("exit_code").and_then(|x| x.as_i64());
                out.push_str(&format!(
                    "$ {cmd}{}\n",
                    code.map(|c| format!("  [exit {c}]")).unwrap_or_default()
                ));
                if let Some(o) = b.get("output").and_then(|x| x.as_str()) {
                    out.push_str(o);
                    if !o.ends_with('\n') {
                        out.push('\n');
                    }
                }
            }
            Some(tail(&out))
        }
        _ => None,
    }
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
            description: "在会话上执行命令。缺省 shell 模式（持久 shell，cwd/env 延续）；主机未启用 shell 集成时 shell 模式不可用，用 mode:\"fresh\"（独立通道，可靠退出码，不延续现场）。会话已接入 tmux 时，shell 模式自动落进远端专属窗口（tinyssh-agent）执行——用户随时可切到该窗口旁观，命令输出照常返回。危险命令需人工审批，等待期间此调用阻塞；被拒绝时如实报告，不要换着花样重试。".into(),
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
        move |input, ctx| {
            if tool_cancelled(ctx) {
                return Ok(ToolOutput::error("已停止（命令未执行）"));
            }
            let cmd = input.get("command").and_then(|v| v.as_str()).ok_or_else(|| anyhow::anyhow!("缺少 command"))?;
            let mode = input.get("mode").and_then(|v| v.as_str());
            if let Some(m) = mode {
                if m != "shell" && m != "fresh" {
                    return Err(anyhow::anyhow!("mode 仅支持 shell|fresh，得到 {m:?}"));
                }
            }
            // 模型可能传 0/极大值：0 在 core 里是「立即超时」，极大值会让
            // Instant + Duration 溢出或把工具永久挂起。在工具边界钳到可用域。
            let t = input
                .get("timeout_secs")
                .and_then(|v| v.as_u64())
                .map(|v| v.clamp(1, 1800));
            let cap = input
                .get("output_cap_bytes")
                .and_then(|v| v.as_u64())
                .map(|v| v.clamp(1, 128 * 1024));
            let out = o2
                .exec(&s2, cmd, t, cap, mode)
                .map_err(|e| anyhow::anyhow!(e))?;
            // 非零退出是失败，不是「完成」：模型和 UI 都按 is_error 处理
            //（此前一律 ToolOutput::text，前端显示绿色完成）。
            let failed = serde_json::from_str::<serde_json::Value>(&out)
                .ok()
                .and_then(|v| v.get("exit_code").and_then(|x| x.as_i64()))
                .is_some_and(|code| code != 0);
            Ok(if failed {
                ToolOutput::error(out)
            } else {
                ToolOutput::text(out)
            })
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
        move |_input, ctx| {
            if tool_cancelled(ctx) {
                return Ok(ToolOutput::error("已停止"));
            }
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
        move |input, ctx| {
            if tool_cancelled(ctx) {
                return Ok(ToolOutput::error("已停止"));
            }
            let limit = input
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(20)
                .clamp(1, 200) as u32;
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
        move |input, ctx| {
            if tool_cancelled(ctx) {
                return Ok(ToolOutput::error("已停止"));
            }
            let q = input
                .get("quiet_ms")
                .and_then(|v| v.as_u64())
                .map(|v| v.clamp(1, 60_000));
            let r = input.get("regex").and_then(|v| v.as_str()).map(String::from);
            let t = input
                .get("timeout_secs")
                .and_then(|v| v.as_u64())
                .map(|v| v.clamp(1, 600));
            o5.wait_output(&s5, q, r, t).map(ToolOutput::text).map_err(|e| anyhow::anyhow!(e))
        },
    );
    let o6 = ops.clone();
    let s6 = sid.clone();
    let upload = CallbackTool::new(
        ToolDef {
            name: "upload".into(),
            description: "上传本地文件到远程主机。local=用户本机绝对路径，remote=主机上的绝对路径。缺省冲突即失败：目标已存在返回 conflict_detected（含目标大小/时间）；与用户确认后用 collision=\"skip\"（同名跳过）或换目标路径（Agent 路径不支持覆盖）。传输需人工审批，等待期间此调用阻塞；被拒绝时如实报告。".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "local": { "type": "string", "description": "本机文件绝对路径" },
                    "remote": { "type": "string", "description": "主机目标绝对路径" },
                    "collision": { "type": "string", "enum": ["skip"], "description": "目标已存在时的处置（缺省 fail；Agent 不支持 overwrite）" }
                },
                "required": ["local", "remote"]
            }),
        },
        move |input, ctx| {
            let local = input.get("local").and_then(|v| v.as_str()).ok_or_else(|| anyhow::anyhow!("缺少 local"))?;
            let remote = input.get("remote").and_then(|v| v.as_str()).ok_or_else(|| anyhow::anyhow!("缺少 remote"))?;
            let c = parse_collision(input).map_err(|e| anyhow::anyhow!(e))?;
            transfer_flow(&o6, &s6, local, remote, true, c.as_deref(), ctx.cancel.as_deref())
        },
    );
    let o7 = ops.clone();
    let s7 = sid.clone();
    let download = CallbackTool::new(
        ToolDef {
            name: "download".into(),
            description: "从远程主机下载文件到本机。remote=主机上的绝对路径，local=用户本机绝对路径。缺省冲突即失败：本地目标已存在返回 conflict_detected（目录目标放行=下载进目录）；与用户确认后用 collision=\"skip\" 或换目标路径（Agent 路径不支持覆盖）。传输需人工审批，等待期间此调用阻塞；被拒绝时如实报告。".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "remote": { "type": "string", "description": "主机源文件绝对路径" },
                    "local": { "type": "string", "description": "本机目标绝对路径" },
                    "collision": { "type": "string", "enum": ["skip"], "description": "目标已存在时的处置（缺省 fail；Agent 不支持 overwrite）" }
                },
                "required": ["remote", "local"]
            }),
        },
        move |input, ctx| {
            let remote = input.get("remote").and_then(|v| v.as_str()).ok_or_else(|| anyhow::anyhow!("缺少 remote"))?;
            let local = input.get("local").and_then(|v| v.as_str()).ok_or_else(|| anyhow::anyhow!("缺少 local"))?;
            let c = parse_collision(input).map_err(|e| anyhow::anyhow!(e))?;
            transfer_flow(&o7, &s7, local, remote, false, c.as_deref(), ctx.cancel.as_deref())
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
        move |input, ctx| {
            if tool_cancelled(ctx) {
                return Ok(ToolOutput::error("已停止（按键未发送）"));
            }
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
            move |input, ctx| {
                if tool_cancelled(ctx) {
                    return Ok(ToolOutput::error("已停止"));
                }
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
pub type DispatchFn = Arc<dyn Fn(&str, &str) -> Result<u64, String> + Send + Sync>;

/// wait_task 轮询节奏（与传输轮询同款测试/生产分叉）。
const WAIT_POLL_MS: u64 = if cfg!(test) { 5 } else { 500 };

fn build_fleet_tools(
    ops: Arc<dyn SshOps>,
    host: std::sync::Weak<AgentHost>,
    self_key: String,
    dispatch: DispatchFn,
) -> Vec<Box<dyn Tool>> {
    let o_dispatch = ops.clone();
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
            let task = task.trim();
            if task.is_empty() {
                return Err(anyhow::anyhow!("task 不能为空"));
            }
            // 目标存在性/控制权预检：避免对幻觉 sid 或人类持有的会话启动一整轮
            // 模型请求（token 白烧，最终工具全报 ControlTakenByHuman）。
            let list = o_dispatch
                .list_sessions()
                .map_err(|e| anyhow::anyhow!("读取会话清单失败：{e}"))?;
            let arr: serde_json::Value = serde_json::from_str(&list)
                .map_err(|e| anyhow::anyhow!("会话清单格式异常：{e}"))?;
            let target = arr
                .as_array()
                .and_then(|a| {
                    a.iter().find(|s| {
                        s.get("session_id").and_then(|v| v.as_str()) == Some(sid)
                    })
                })
                .ok_or_else(|| anyhow::anyhow!("目标会话不存在：{sid}（先用 fleet_sessions 确认）"))?;
            if let Some(owner) = target.get("control_owner").and_then(|v| v.as_str()) {
                if owner == "Human" {
                    return Err(anyhow::anyhow!(
                        "目标会话 {sid} 由人类持有控制权——请先在目标会话把控制权交给 Agent"
                    ));
                }
            }
            if let Some(state) = target.get("state").and_then(|v| v.as_str()) {
                if matches!(
                    state,
                    "Disconnected" | "Closed" | "Reconfirming" | "Reconnecting"
                ) {
                    return Err(anyhow::anyhow!(
                        "目标会话 {sid} 当前状态为 {state}，不能派发（先重连/完成重确认）"
                    ));
                }
            }
            d2(sid, task)
                .map(|run_id| {
                    ToolOutput::text(
                        json!({ "dispatched": true, "session_id": sid, "run_id": run_id })
                            .to_string(),
                    )
                })
                .map_err(|e| anyhow::anyhow!(e))
        },
    );
    let k3 = self_key.clone();
    let wait_tool = CallbackTool::new(
        ToolDef {
            name: "wait_task".into(),
            description: "等待目标会话当前任务结束并取回结果（state=done|failed|running|cancelled + stop_reason + 它最后的文本回复）。并行派发后逐个调用；超时返回 running 可再次调用继续等。可传 dispatch_task 返回的 run_id 防止把上一轮结果当本轮。".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "目标会话 id" },
                    "run_id": { "type": "integer", "description": "dispatch_task 返回的运行代际（可选；传了就只认这一轮）" },
                    "timeout_secs": { "type": "integer", "description": "最多等多少秒（缺省 300，上限 900）" }
                },
                "required": ["session_id"]
            }),
        },
        move |input, ctx| {
            let sid = input
                .get("session_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 session_id"))?;
            if sid == k3 {
                return Err(anyhow::anyhow!(
                    "不能 wait_task 编排者自己（会等待自身运行到超时）"
                ));
            }
            let want_run = input.get("run_id").and_then(|v| v.as_u64());
            let mut cap = input
                .get("timeout_secs")
                .and_then(|v| v.as_u64())
                .unwrap_or(300)
                .min(900);
            if let Some(d) = ctx.deadline {
                let left = d
                    .saturating_duration_since(std::time::Instant::now())
                    .as_secs();
                cap = cap.min(left.max(1));
            }
            let h = host
                .upgrade()
                .ok_or_else(|| anyhow::anyhow!("宿主已释放"))?;
            if let Some(rid) = want_run {
                if let Some(cur) = h.run_id(sid) {
                    if cur != rid {
                        return Err(anyhow::anyhow!(
                            "目标会话已开始新一轮运行（期望 run_id={rid}，当前={cur}）——请重新 dispatch_task 或省略 run_id"
                        ));
                    }
                }
            }
            let polls = (cap * 1000 / WAIT_POLL_MS).max(1);
            let mut cancelled = false;
            for _ in 0..polls {
                if !h.busy(sid) {
                    break;
                }
                if ctx
                    .cancel
                    .as_ref()
                    .is_some_and(|c| c.load(Ordering::Relaxed))
                {
                    cancelled = true;
                    break;
                }
                if ctx
                    .deadline
                    .is_some_and(|d| std::time::Instant::now() >= d)
                {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(WAIT_POLL_MS));
            }
            let running = h.busy(sid);
            if cancelled {
                return Ok(ToolOutput::text(
                    json!({
                        "session_id": sid,
                        "state": "cancelled",
                        "note": "用户已停止编排运行；目标任务可能仍在执行，可稍后再查",
                    })
                    .to_string(),
                ));
            }
            let mut payload = json!({ "session_id": sid });
            if running {
                payload["state"] = json!("running");
                payload["note"] = json!("仍在运行；稍后再次 wait_task 继续等");
                if let Some(rid) = want_run {
                    payload["run_id"] = json!(rid);
                }
                return Ok(ToolOutput::text(payload.to_string()));
            }
            let outcome = h.last_outcome(sid);
            if let Some(rid) = want_run {
                match &outcome {
                    Some((got, ..)) if *got == rid => {}
                    Some((got, ..)) => {
                        return Err(anyhow::anyhow!(
                            "目标会话已开始新一轮运行（期望 run_id={rid}，当前={got}）——请重新 dispatch_task 或省略 run_id"
                        ));
                    }
                    None => {
                        return Err(anyhow::anyhow!(
                            "目标会话没有可对账的运行结果（run_id={rid}）"
                        ));
                    }
                }
            }
            let (rid, stop_reason, final_text, error) = match outcome {
                Some(o) => o,
                None => {
                    payload["state"] = json!("unknown");
                    payload["note"] = json!("目标会话没有运行记录");
                    return Ok(ToolOutput::text(payload.to_string()));
                }
            };
            // 只有模型正常收口（end_turn/stop）才算 done；timeout/stream_idle/
            // max_tokens/max_turns_reached/budget_exceeded/stuck_loop/cancelled
            // 都必须如实报 failed，不能把半截结果当成功。
            let ok = matches!(stop_reason.as_str(), "end_turn" | "stop" | "stop_sequence");
            payload["state"] = json!(if ok { "done" } else { "failed" });
            payload["run_id"] = json!(rid);
            payload["stop_reason"] = json!(stop_reason);
            if !final_text.trim().is_empty() {
                payload["result"] = json!(tail(&final_text));
            }
            if let Some(err) = error {
                payload["error"] = json!(err);
            } else if !ok {
                payload["error"] = json!(format!("运行未正常结束（stop_reason={stop_reason}）"));
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

/// 一次运行的可查询结果（Fleet wait_task 用）。不存完整消息历史，只保留
/// 终态原因与最后一段文本——避免把模型内部思考/半截工具调用当成结论。
#[derive(Clone)]
struct RunOutcomeLite {
    run_id: u64,
    stop_reason: String,
    final_text: String,
    error: Option<String>,
}

#[derive(Default)]
struct SlotState {
    busy: bool,
    cancel: Option<Arc<AtomicBool>>,
    /// 当前 agent 对应的模型配置签名（Real=配置哈希；Test=递增唯一值）——
    /// send 时签名不符即重建 agent（换模型/换 key 生效；对话记忆随之重置，
    /// FE 转写仍在、如实呈现）。
    cfg_sig: Option<u64>,
    /// 运行代际：每次受理 send 自增；dispatch_task 返回、wait_task 可按 id 对账，
    /// 防止把上一轮结果当本轮结果。
    run_seq: u64,
    /// 最近一次**已结束**运行的结果。busy 期间不更新；新 send 受理时清空，
    /// 保证 wait_task 不会读到上一轮答案。
    last_outcome: Option<RunOutcomeLite>,
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
    /// close 后置位：旧运行线程即使还持有这个 Arc，也不得再把事件写进
    /// 转写/FE（close 后同 sid 可能已建新槽位，否则两个对话会串线）。
    closed: AtomicBool,
}

/// 运行线程的收尾守卫：即使 emit(Failed)/sink 回调 panic，busy 位也会复位、
/// 最近结果也会落槽——否则该会话永久提示「上一条还在运行」，只能重启应用。
struct SlotRunGuard {
    slot: Arc<SessionSlot>,
    outcome: Option<RunOutcomeLite>,
}

impl Drop for SlotRunGuard {
    fn drop(&mut self) {
        let mut st = self.slot.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(o) = self.outcome.take() {
            st.last_outcome = Some(o);
        }
        st.busy = false;
        st.cancel = None;
    }
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
                    closed: AtomicBool::new(false),
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

    /// 最近一次已结束运行的结果（run_id/stop_reason/final_text/error）。
    /// `None` = 没有运行过或新运行已受理（旧结果已作废）。
    pub fn last_outcome(&self, sid: &str) -> Option<(u64, String, String, Option<String>)> {
        match self.sessions.lock().unwrap().get(sid) {
            Some(s) => s.state.lock().unwrap().last_outcome.as_ref().map(|o| {
                (
                    o.run_id,
                    o.stop_reason.clone(),
                    o.final_text.clone(),
                    o.error.clone(),
                )
            }),
            None => None,
        }
    }

    /// 当前/最近一次运行的代际号（dispatch_task 返回给编排者做对账）。
    pub fn run_id(&self, sid: &str) -> Option<u64> {
        match self.sessions.lock().unwrap().get(sid) {
            Some(s) => Some(s.state.lock().unwrap().run_seq),
            None => None,
        }
    }

    /// 目标会话最后一条**封口**的 assistant 文本（旧版 wait_task 取结果用；
    /// 现在 wait_task 优先读 last_outcome）。转写重放——只聚合 Text 增量，
    /// Thinking 不是结论；任何其他事件封口，流式中未完的 tail 不算。
    pub fn last_final_text(&self, sid: &str) -> Option<String> {
        let list = self.transcripts.lock().unwrap().get(sid)?.clone();
        let mut cur = String::new();
        let mut in_text = false;
        let mut last: Option<String> = None;
        let seal = |cur: &mut String, in_text: &mut bool, last: &mut Option<String>| {
            if *in_text {
                if !cur.trim().is_empty() {
                    *last = Some(std::mem::take(cur));
                } else {
                    cur.clear();
                }
                *in_text = false;
            }
        };
        for ev in list {
            match ev {
                // 只聚合最终回答文本；思考内容不是结论，不能回灌给编排者。
                HostEvent::Text(t) => {
                    cur.push_str(&t);
                    in_text = true;
                }
                HostEvent::Thinking(_) => seal(&mut cur, &mut in_text, &mut last),
                HostEvent::User(_) => {
                    seal(&mut cur, &mut in_text, &mut last);
                    cur.clear();
                }
                _ => seal(&mut cur, &mut in_text, &mut last),
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
    ) -> Result<u64, String> {
        self.send_inner(sid, text, SendCfg::Real(cfg), sink, None)
    }

    /// 编排者会话：跨会话派发工具面 + FLEET_SYS_PROMPT。dispatch 闭包用编排者
    /// 自己的模型配置把任务发给目标会话（目标对话与审批都在目标侧原样呈现）。
    pub fn send_fleet(
        &self,
        text: &str,
        cfg: &ModelConfig,
        sink: EventSink,
    ) -> Result<u64, String> {
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
    ) -> Result<u64, String> {
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
    ) -> Result<u64, String> {
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
    ) -> Result<u64, String> {
        let slot = self.slot(sid);
        if slot.closed.load(Ordering::SeqCst) {
            return Err("会话已关闭".into());
        }
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
        let run_id;
        {
            let mut st = slot.state.lock().unwrap();
            if st.busy {
                return Err("上一条还在运行（工具执行/审批等待中）——可点停止或稍候".into());
            }
            needs_rebuild = st.cfg_sig != sig_opt;
            st.busy = true;
            st.cancel = Some(cancel.clone());
            st.cfg_sig = sig_opt;
            st.run_seq = st.run_seq.saturating_add(1);
            st.last_outcome = None; // 新一轮开始：上一轮结果不可再被 wait_task 取回
            run_id = st.run_seq;
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
                        // 交互式 Agent 的时限：推理模型首 token 可能静默数分钟，
                        // 30s 空闲会把长思考误判成断流；运行上限也从 600s 放宽，
                        // 长任务由用户「停止」兜底（取消语义见 cancel()）。
                        "limits": {
                            "stream_idle_secs": AGENT_STREAM_IDLE_SECS,
                            "timeout_secs": AGENT_RUN_TIMEOUT_SECS,
                        },
                    });
                    if let Some(b) = &c.base_url {
                        cfg_json["base_url"] = json!(b);
                    }
                    let ta_cfg: tiny_agent::Config = serde_json::from_value(cfg_json)
                        .map_err(|e| format!("模型服务配置无效：{e}"))?;
                    // 0 = 不设 client 级总超时：每次 chat 请求都由 TinyAgent 按
                    // 运行剩余预算设置 per-request timeout（含无预算时的 10min
                    // backstop），这里再叠一个 120s 总超时只会让长回答被截断。
                    let client = tiny_agent::provider::new_client(0);
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
            let client = tiny_agent::provider::new_client(0);
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
                // close 已撤键/槽位已关闭则连 sink 都不发：会话关闭后运行线程的
                // 残余事件不应继续写 FE（此前先 sink 后检查，已关会话的对话还会
                // 增长；close 后同 sid 新建槽位时旧线程还会串写新对话）。
                if slot2.closed.load(Ordering::SeqCst) {
                    return;
                }
                {
                    let t = transcripts.lock().unwrap();
                    if !t.contains_key(&sid_owned) {
                        return;
                    }
                }
                sink(&sid_owned, &ev);
                let mut t = transcripts.lock().unwrap();
                if let Some(list) = t.get_mut(&sid_owned) {
                    list.push(ev);
                    if list.len() > TRANSCRIPT_CAP {
                        let over = list.len() - TRANSCRIPT_CAP;
                        list.drain(..over);
                    }
                }
            };
            // catch_unwind 包住运行体：tiny-a 内部 panic 默认只杀线程不杀进程，
            // 但 busy 位焊死会让该会话永远「上一条还在运行」只能重启应用——
            // panic 也走正常收尾（Failed 事件 + busy 复位）
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                || -> Result<tiny_agent::RunOutcome, String> {
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
                                display: display_tool_result(&name, &content),
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
                        Ok(out) => Ok(out),
                        Err(e) => Err(tail(&e.to_string())),
                    }
                },
            ))
            .unwrap_or_else(|p| {
                Err(format!(
                    "agent 运行线程 panic：{}",
                    p.downcast_ref::<&str>()
                        .map(|s| s.to_string())
                        .or_else(|| p.downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "unknown panic".into())
                ))
            });
            // 运行结果落槽：Fleet wait_task 只认这次运行的 stop_reason/final_text，
            // 不再靠扫描整条转写猜「最后一段文本」（会把上一轮答案或思考内容当结论）。
            let (lite, failure) = match outcome {
                Ok(out) => (
                    Some(RunOutcomeLite {
                        run_id,
                        stop_reason: out.stop_reason.clone(),
                        final_text: out.final_text,
                        error: None,
                    }),
                    None,
                ),
                Err(msg) => (
                    Some(RunOutcomeLite {
                        run_id,
                        stop_reason: "error".into(),
                        final_text: String::new(),
                        error: Some(msg.clone()),
                    }),
                    Some(msg),
                ),
            };
            let _guard = SlotRunGuard {
                slot: slot2.clone(),
                outcome: lite,
            };
            if let Some(msg) = failure {
                // 即使这里 panic（sink/tauri emit 异常），_guard 的 Drop 仍会
                // 落 last_outcome 并复位 busy。
                emit(HostEvent::Failed { message: msg });
            }
        });
        Ok(run_id)
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
        // 先置 closed 再撤槽/转写：旧运行线程的 emit 一旦看到 closed 就停，
        // 不会在撤键与回插之间把残余事件写进新对话。get+remove 在同一把锁内
        // 完成，避免 close 与 send 竞态时误删刚建的新槽。
        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(slot) = sessions.get(sid) {
                slot.closed.store(true, Ordering::SeqCst);
            }
            sessions.remove(sid);
        }
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
            start_results: Mutex::new(std::collections::VecDeque::from(vec![Err(
                "审批被拒绝（transfer）：人类拒绝".into(),
            )])),
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
        // ② overwrite：Agent 路径明确不支持——工具层直接报错，不建任务/不弹审批
        assert!(results[1].0, "overwrite 应为参数错误");
        assert!(results[1].1.contains("不支持覆盖"), "{}", results[1].1);
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
            !first_start.contains("Some(\"overwrite\")"),
            "Agent 路径不得把 overwrite 发进 core：{calls:?}"
        );
        assert!(
            !calls.iter().any(|c| c == "status:t-9"),
            "overwrite 被拒后不得建传输任务：{calls:?}"
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
    fn tool_result_display_extracts_exec_and_blocks() {
        let exec = json!({
            "exec_id": "e1",
            "exit_code": 2,
            "stdout": "out\n",
            "stderr": "err\n",
            "truncated": false,
            "duration_ms": 5
        })
        .to_string();
        let d = display_tool_result("exec", &exec).expect("exec display");
        assert!(d.contains("exit 2"));
        assert!(d.contains("out"));
        assert!(d.contains("[stderr]"));
        assert!(d.contains("err"));

        let blocks = json!([
            {"command": "echo hi", "exit_code": 0, "output": "hi\n"},
            {"command": "false", "exit_code": 1, "output": ""}
        ])
        .to_string();
        let d = display_tool_result("read_blocks", &blocks).expect("blocks display");
        assert!(d.contains("$ echo hi"));
        assert!(d.contains("[exit 1]"));

        // 非 JSON（工具错误文本）不做展示层改写
        assert!(display_tool_result("exec", "not json").is_none());
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
        // last_final_text：目标总结可提取（旧版 wait_task 数据源；新版走 last_outcome）
        assert_eq!(host.last_final_text("t1").as_deref(), Some("磁盘 40% 已用"));
        assert_eq!(host.last_final_text("t2").as_deref(), Some("内存 2G/8G"));
    }

    #[test]
    fn wait_task_reports_abnormal_stop_and_rejects_self_or_stale_run() {
        let ops = Arc::new(FakeOps::default());
        let host = AgentHost::new_arc(ops);
        // 目标会话：半截文本 + stream_idle（推理模型长静默/半开连接的典型终态）
        let (target, _ts) = MockProvider::new(vec![mock::MockTurn::Ok(
            tiny_agent::provider::ChatResponse {
                blocks: vec![tiny_agent::provider::Block::Text("半截回答".into())],
                stop_reason: "stream_idle".into(),
                usage: None,
            },
        )]);
        let run_id = host
            .send_with_mock("s-bad", "做个任务", Box::new(target), Arc::new(|_, _| {}))
            .expect("send target");
        assert!(host.wait_idle("s-bad"));
        let (got, reason, text, err) = host.last_outcome("s-bad").expect("outcome");
        assert_eq!(got, run_id);
        assert_eq!(reason, "stream_idle");
        assert_eq!(text, "半截回答");
        assert!(err.is_none());

        // 编排者：等目标（异常态）→ 等自己（应拒）→ 用错 run_id（应拒）→ 汇总
        let (fleet, _fs) = MockProvider::new(vec![
            mock::resp_tool("w1", "wait_task", json!({"session_id": "s-bad"}), None),
            mock::resp_tool("w2", "wait_task", json!({"session_id": "fleet"}), None),
            mock::resp_tool(
                "w3",
                "wait_task",
                json!({"session_id": "s-bad", "run_id": run_id + 99}),
                None,
            ),
            mock::resp_text("汇总", None),
        ]);
        let (ev, sink) = collect();
        host.send_fleet_with_mock(
            "汇总任务",
            Box::new(fleet),
            Arc::new(Mutex::new(Default::default())),
            sink,
        )
        .expect("send fleet");
        assert!(host.wait_idle(FLEET_KEY));
        let evs = ev.lock().unwrap();
        let results: Vec<(bool, String)> = evs
            .iter()
            .filter_map(|e| match e {
                HostEvent::ToolResult {
                    is_error, content, ..
                } => Some((*is_error, content.clone())),
                _ => None,
            })
            .collect();
        assert!(
            results.iter().any(|(is_err, c)| !*is_err
                && c.contains("\"state\":\"failed\"")
                && c.contains("\"stop_reason\":\"stream_idle\"")
                && c.contains("半截回答")),
            "异常终态必须报 failed + stop_reason：{results:?}"
        );
        assert!(
            results
                .iter()
                .any(|(is_err, c)| *is_err && c.contains("不能 wait_task 编排者自己")),
            "wait_task 自己应被拒：{results:?}"
        );
        assert!(
            results
                .iter()
                .any(|(is_err, c)| *is_err && c.contains("已开始新一轮运行")),
            "run_id 不匹配应被拒：{results:?}"
        );
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
