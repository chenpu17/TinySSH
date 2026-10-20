//! TinySSH 内置 Agent 宿主（Round 2，接真模型轮）。
//!
//! tiny-agent-core 驱动的「每会话一个 agent」宿主：模型配置（vault 密封存储，
//! 由 src-tauri 解出后传入）+ SSH 工具桥（[`SshOps`] 同步 trait，src-tauri 侧
//! block_on 适配 SessionManager——工具跑在 agent 的工作线程上，天然容忍审批
//! 阻塞）+ 事件流（[`HostEvent`]，经 src-tauri 桥成 tauri 事件到 FE）+ 转写
//! 缓存（FE 重挂载重建对话）+ 取消。
//!
//! 安全边界（与既有审批链的关系）：agent 以 `Actor::Agent{client_id: AGENT_CLIENT_ID}`
//! 走 SessionManager 的同一批方法——exec 的危险命令审批、审计、夺权语义全部
//! 在 core-session 层自动继承，本 crate 不做任何放行。工具集只装配四个
//! SSH 操作，本地 shell/file 内置工具一律不装配（tiny-a config `tools: []`）。
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
    fn exec(
        &self,
        sid: &str,
        cmd: &str,
        timeout_secs: Option<u64>,
        output_cap: Option<u64>,
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
}

/// 工具结果文本的保尾截断：错误堆栈在尾部，保尾不保头。
const TAIL_CAP: usize = 4000;
/// 每会话转写缓存条目上限（FE 重建对话用；更早的靠模型自己的历史延续）。
const TRANSCRIPT_CAP: usize = 400;

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

const SYS_PROMPT: &str = "你是 TinySSH 内置的运维助手，通过工具操作一台已连接的远程 SSH 主机（工具的会话由宿主绑定，不需要也不能指定会话）。要点：\n\
- exec 在该会话的持久 shell 里执行（cwd/env 延续）；危险命令会被人工审批，此调用会阻塞等待决定；被拒绝时如实告知用户并给出更安全的替代，绝不换着花样重试被拒命令。\n\
- 了解现场优先 read_blocks（最近的命令与结果）与 read_screen（当前画面）；长命令用 wait_output 跟踪。\n\
- 输出可能被截断（保尾），如实转述；不确定的事实不虚构，报得出来的 exit code 就报。\n\
- 面向用户的回复用简体中文，简洁，可用 markdown（代码块标注语言）。";

// ── 工具装配：sid 在装配时绑死进闭包（每会话一次），模型无法选会话 ──

fn build_tools(ops: Arc<dyn SshOps>, sid: String) -> Vec<Box<dyn Tool>> {
    let o2 = ops.clone();
    let s2 = sid.clone();
    let exec = CallbackTool::new(
        ToolDef {
            name: "exec".into(),
            description: "在会话的持久 shell 中执行命令（cwd/env 延续）。危险命令需人工审批，等待期间此调用阻塞；被拒绝时如实报告，不要换着花样重试。".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "要执行的命令" },
                    "timeout_secs": { "type": "integer", "description": "超时秒数（缺省 30，审批等待不计入）" },
                    "output_cap_bytes": { "type": "integer", "description": "stdout/stderr 返回上限字节（缺省 128KiB，超限截断）" }
                },
                "required": ["command"]
            }),
        },
        move |input, _ctx| {
            let cmd = input.get("command").and_then(|v| v.as_str()).ok_or_else(|| anyhow::anyhow!("缺少 command"))?;
            let t = input.get("timeout_secs").and_then(|v| v.as_u64());
            let cap = input.get("output_cap_bytes").and_then(|v| v.as_u64());
            o2.exec(&s2, cmd, t, cap).map(ToolOutput::text).map_err(|e| anyhow::anyhow!(e))
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
    let o5 = ops;
    let s5 = sid;
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
    vec![
        Box::new(exec),
        Box::new(screen),
        Box::new(blocks),
        Box::new(wait),
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
    sessions: Mutex<HashMap<String, Arc<SessionSlot>>>,
    // Arc：运行线程持有句柄写转写，宿主侧 close/history 经 self 访问同一份
    transcripts: Arc<Mutex<HashMap<String, Vec<HostEvent>>>>,
}

enum SendCfg<'a> {
    Real(&'a ModelConfig),
    #[cfg(test)]
    Test(Box<dyn tiny_agent::Provider>),
}

impl AgentHost {
    pub fn new(ops: Arc<dyn SshOps>) -> Self {
        Self {
            ops,
            sessions: Mutex::new(HashMap::new()),
            transcripts: Arc::new(Mutex::new(HashMap::new())),
        }
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

    /// 发送一条用户消息并启动（或延续）该会话的 agent 运行。
    /// 同会话上一次运行未结束时报错（串行对话——一个终端一个指挥）。
    pub fn send(
        &self,
        sid: &str,
        text: &str,
        cfg: &ModelConfig,
        sink: EventSink,
    ) -> Result<(), String> {
        self.send_inner(sid, text, SendCfg::Real(cfg), sink)
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
        self.send_inner(sid, text, SendCfg::Test(provider), sink)
    }

    fn send_inner(
        &self,
        sid: &str,
        text: &str,
        cfg: SendCfg<'_>,
        sink: EventSink,
    ) -> Result<(), String> {
        let slot = self.slot(sid);
        let cancel = Arc::new(AtomicBool::new(false));
        #[cfg(test)]
        let sig_opt: Option<u64> = match &cfg {
            SendCfg::Real(c) => Some(sig_of(c)),
            SendCfg::Test(_) => Some(next_test_sig()),
        };
        #[cfg(not(test))]
        let sig_opt: Option<u64> = match &cfg {
            SendCfg::Real(c) => Some(sig_of(c)),
        };
        let mut needs_rebuild = false;
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

        let build = move || -> Result<tiny_agent::Agent, String> {
            let tools = build_tools(ops, sid_for_build);
            let (ta_cfg, provider) = match cfg {
                SendCfg::Real(c) => {
                    let mut cfg_json = json!({
                        "provider": c.provider,
                        "api_key_env": "TINYSSH_EMBEDDED_KEY_UNUSED",
                        "model": c.model,
                        "system_prompt": SYS_PROMPT,
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
                        "system_prompt": SYS_PROMPT,
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
                let list = t.entry(sid_owned.clone()).or_default();
                list.push(ev);
                if list.len() > TRANSCRIPT_CAP {
                    let over = list.len() - TRANSCRIPT_CAP;
                    list.drain(..over);
                }
            };
            let outcome = (|| -> Result<(), String> {
                let mut cell = slot2.agent.lock().unwrap();
                let Some(agent) = cell.as_mut() else {
                    return Err("会话 agent 已不存在".into());
                };
                agent.set_cancel(cancel);
                let r = agent.run(&mut |ev: tiny_agent::AgentEvent| {
                    let mapped = match ev {
                        tiny_agent::AgentEvent::TurnStart(n) => Some(HostEvent::Turn(n)),
                        tiny_agent::AgentEvent::TextDelta(t) => Some(HostEvent::Text(t)),
                        tiny_agent::AgentEvent::ThinkingDelta(t) => Some(HostEvent::Thinking(t)),
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
                        emit(e);
                    }
                });
                match r {
                    Ok(_) => Ok(()),
                    Err(e) => Err(tail(&e.to_string())),
                }
            })();
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
    /// 返回是否确有运行在途。
    pub fn cancel(&self, sid: &str) -> bool {
        let slot = self.slot(sid);
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
            if !self.slot(sid).state.lock().unwrap().busy {
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
    }
    impl SshOps for FakeOps {
        fn exec(
            &self,
            _sid: &str,
            cmd: &str,
            _t: Option<u64>,
            _c: Option<u64>,
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
}
