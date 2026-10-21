//! 真模型实机验证（#[ignore]：默认套件不跑、不花钱）。
//! key 走环境变量、**绝不写进仓库任何文件**。用法：
//!
//! ```text
//! TINYSSH_LIVE_BASE=http://host:port/v1 \
//! TINYSSH_LIVE_MODEL=glm-5.3-flash \
//! TINYSSH_LIVE_KEY=sk-xxx \
//!   cargo test -p tinyssh-agent-host --test live_provider -- --ignored --nocapture
//! ```
//!
//! 验证面：OpenAI 兼容网关 × tiny-a 内核全链——流式 Text/Thinking 增量、
//! 工具调用（exec 经 SshOps 桩）、工具结果回灌后的第二轮作答、终态 Done
//! 与转写完整性。curl 级探针测不到的（400 自愈改名、SSE 增量解析、多轮
//! 工具回路）都在这里过。

use std::sync::{Arc, Mutex};
use tinyssh_agent_host::{AgentHost, HostEvent, ModelConfig, SshOps, StatInfo, TransferPoll};

/// 最小 SshOps 桩：exec 回显 canned 输出（验证模型真会调工具、参数正确），
/// 其余原语报错——本测试只针对对话×工具回路。
struct LiveOps {
    calls: Mutex<Vec<String>>,
}
impl SshOps for LiveOps {
    fn exec(
        &self,
        _sid: &str,
        cmd: &str,
        _timeout_secs: Option<u64>,
        _output_cap: Option<u64>,
        _mode: Option<&str>,
    ) -> Result<String, String> {
        self.calls.lock().unwrap().push(cmd.to_string());
        Ok(format!("live-ok-marker\n(来自 LiveOps 桩, 命令: {cmd})"))
    }
    fn read_screen(&self, _sid: &str) -> Result<String, String> {
        Err("本测试无屏幕".into())
    }
    fn read_blocks(&self, _sid: &str, _limit: u32) -> Result<String, String> {
        Err("本测试无块".into())
    }
    fn wait_output(
        &self,
        _sid: &str,
        _quiet_ms: Option<u64>,
        _regex: Option<String>,
        _timeout_secs: Option<u64>,
    ) -> Result<String, String> {
        Err("本测试无输出等待".into())
    }
    fn stat_remote(&self, _sid: &str, _path: &str) -> Result<Option<StatInfo>, String> {
        Ok(None)
    }
    fn stat_local(&self, _path: &str) -> Result<Option<StatInfo>, String> {
        Ok(None)
    }
    fn transfer_start(
        &self,
        _sid: &str,
        _local: &str,
        _remote: &str,
        _is_upload: bool,
        _collision: Option<&str>,
    ) -> Result<String, String> {
        Err("本测试不传输".into())
    }
    fn transfer_status(&self, _tid: &str) -> Result<TransferPoll, String> {
        Err("本测试不传输".into())
    }
    fn send_keys(&self, _sid: &str, _keys: &str) -> Result<String, String> {
        Err("本测试无终端".into())
    }
    fn list_sessions(&self) -> Result<String, String> {
        Ok("[]".into())
    }
}

fn kind_of(e: &HostEvent) -> &'static str {
    match e {
        HostEvent::User(_) => "User",
        HostEvent::Turn(_) => "Turn",
        HostEvent::Text(_) => "Text",
        HostEvent::Thinking(_) => "Thinking",
        HostEvent::ToolStart { .. } => "ToolStart",
        HostEvent::ToolResult { .. } => "ToolResult",
        HostEvent::Notice(_) => "Notice",
        HostEvent::Usage { .. } => "Usage",
        HostEvent::Done { .. } => "Done",
        HostEvent::Failed { .. } => "Failed",
    }
}

#[test]
#[ignore]
fn live_openai_compat_full_chain() {
    let base = std::env::var("TINYSSH_LIVE_BASE").unwrap_or_default();
    let model = std::env::var("TINYSSH_LIVE_MODEL").unwrap_or_default();
    let key = std::env::var("TINYSSH_LIVE_KEY").unwrap_or_default();
    assert!(!base.is_empty() && !key.is_empty(),
        "需要 TINYSSH_LIVE_BASE / TINYSSH_LIVE_MODEL / TINYSSH_LIVE_KEY 环境变量");
    let cfg = ModelConfig {
        provider: "openai".into(),
        base_url: Some(base),
        model: if model.is_empty() { "glm-5.3-flash".into() } else { model },
        api_key: key,
    };

    let ops = Arc::new(LiveOps { calls: Mutex::new(Vec::new()) });
    let host = AgentHost::new_arc(ops.clone() as Arc<dyn SshOps>);
    let events: Arc<Mutex<Vec<HostEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let ev2 = events.clone();
    let sink: tinyssh_agent_host::EventSink =
        Arc::new(move |_sid, ev| ev2.lock().unwrap().push(ev.clone()));

    host.send(
        "live-1",
        "请用 exec 工具执行命令 echo live-ok，然后回答输出里是否包含 live-ok-marker（是/否 + 简短说明）。",
        &cfg,
        sink,
    )
    .expect("send 应被受理");

    // 等运行终态：推理模型一轮工具调用（思考+调用+回灌+作答）可能要一两分钟，
    // wait_idle 的 30s 上限不够，这里自管 4 分钟预算。
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(240);
    while host.busy("live-1") {
        assert!(std::time::Instant::now() < deadline, "240s 内未回到空闲");
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    let evs = events.lock().unwrap().clone();
    let kinds: Vec<&str> = evs.iter().map(kind_of).collect();
    println!("事件序列: {kinds:?}");
    assert!(kinds.contains(&"Done"), "应有 Done 终态（实际 {kinds:?}）");
    assert!(!kinds.contains(&"Failed"), "不应 Failed（实际 {kinds:?}）");
    assert!(kinds.contains(&"ToolStart"), "模型应发起工具调用（实际 {kinds:?}）");

    // exec 真被调用且命令指向目标
    let calls = ops.calls.lock().unwrap();
    assert!(!calls.is_empty(), "SshOps::exec 应被调用");
    assert!(
        calls.iter().any(|c| c.contains("live-ok")),
        "exec 命令应包含目标标记（实际 {calls:?}）"
    );
    // 工具结果回灌模型（is_error=false 且内容含标记）
    let tr = evs.iter().find_map(|e| match e {
        HostEvent::ToolResult { content, is_error, .. } => Some((content.clone(), *is_error)),
        _ => None,
    });
    let (content, is_err) = tr.expect("应有 ToolResult 事件");
    assert!(!is_err, "工具结果不应是错误: {content}");
    assert!(content.contains("live-ok-marker"), "回灌内容应含标记: {content}");

    // 流式上屏：文本增量非空；思考增量（推理模型）只打印不强断言——非推理
    // provider 也应过本测试
    let text_len: usize = evs
        .iter()
        .map(|e| if let HostEvent::Text(t) = e { t.len() } else { 0 })
        .sum();
    let think_len: usize = evs
        .iter()
        .map(|e| if let HostEvent::Thinking(t) = e { t.len() } else { 0 })
        .sum();
    println!("文本增量 {text_len} 字符, 思考增量 {think_len} 字符");
    assert!(text_len > 0, "应有流式文本增量");

    // 转写完整性：User 消息在转写首位
    assert!(matches!(host.history("live-1").first(), Some(HostEvent::User(_))));
}
