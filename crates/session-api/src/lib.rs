//! # session-api — 核心门面契约（v1 冻结子集）
//!
//! 双前端（GUI/Tauri 与 MCP）唯一入口契约。本 crate 只含类型与 trait，
//! 无实现、无重依赖（L1 §1 依赖规则）。审批契约类型（Policy/Decision/Actor）
//! 定义于此；`tinyssh-approval` 只做实现。

pub mod transport;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::broadcast;

// ---------------------------------------------------------------------------
// 标识符
// ---------------------------------------------------------------------------

pub type HostId = String;
pub type SessionId = String;
pub type ExecId = String;
pub type ApprovalId = String;
pub type TransferId = String;
pub type IdentityId = String;
pub type AgentClientId = String;

// ---------------------------------------------------------------------------
// Actor 与审批契约（L1 §2 / §3.3）
// ---------------------------------------------------------------------------

/// 请求发起者。GUI 传 `Human`（短路审批）；MCP 层从 Bearer Token 解析出
/// `Agent { client_id }` —— 身份仅来自 Token，协议参数不可指定（L1 §3.5）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Actor {
    Human,
    Agent { client_id: AgentClientId },
}

impl Actor {
    pub fn is_human(&self) -> bool {
        matches!(self, Actor::Human)
    }
    pub fn agent_id(&self) -> Option<&AgentClientId> {
        match self {
            Actor::Human => None,
            Actor::Agent { client_id } => Some(client_id),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ExecMode {
    /// 持久 shell 执行（V1 默认）：现场延续（cwd/env），边界由命令块判定。
    #[default]
    Shell,
    /// 独立通道执行：可靠退出码，不延续现场；结果镜像回放屏幕。
    Fresh,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecOpts {
    pub mode: ExecMode,
    /// 超时；自审批放行起算（不含审批等待）。None = 使用默认 30s。
    pub timeout: Option<Duration>,
    /// stdout/stderr 返回上限（字节）。None = 128 KiB，超限截断并标 truncated。
    pub output_cap: Option<usize>,
    /// 仅 Fresh 模式生效。
    pub env: BTreeMap<String, String>,
}

impl Default for ExecOpts {
    fn default() -> Self {
        Self {
            mode: ExecMode::default(),
            timeout: None,
            output_cap: None,
            env: BTreeMap::new(),
        }
    }
}

/// 审批留痕（进 ExecResult 与审计）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalTrace {
    pub approval_id: Option<ApprovalId>,
    pub outcome: ApprovalOutcome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApprovalOutcome {
    /// 人类身份短路审批。
    HumanActor,
    /// 命中 allow 规则 / TTL 窗口，逐段求值全通过。
    Auto,
    /// 人类批准。
    Approved,
    /// 人类批准并编辑了命令（实际执行 edited_command）。
    ApprovedEdited,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecResult {
    pub exec_id: ExecId,
    /// Fresh 模式必为 Some（含信号映射）；Shell 模式来自命令块（OSC 133）。
    pub exit_code: Option<i32>,
    /// UTF-8；无效序列以替换符呈现并置 has_binary。
    pub stdout: String,
    pub stderr: String,
    pub has_binary: bool,
    pub truncated: bool,
    /// 自放行起算。
    pub duration: Duration,
    pub approval: ApprovalTrace,
}

// ---------------------------------------------------------------------------
// 控制权 / 接管契约（PRD FR-6 v0.5，L1 §3.1）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ControlOwner {
    Human,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum StopPolicy {
    /// 仅冻结：运行中任务继续跑完，结果照常呈现。
    #[default]
    None,
    /// 尽力停止运行中任务：SIGINT→SIGTERM→SIGKILL 升级，逐条呈现真实结果。
    BestEffort,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub struct ControlOpts {
    pub stop_running: StopPolicy,
}

/// 停止单个运行中任务的真实结果，不谎报成功（L1 §3.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StopOutcome {
    /// 收到退出（Shell 模式：命令块 D；Fresh：通道关闭前拿到 exit status）。
    Exited(i32),
    /// 需要升级（SIGTERM/SIGKILL 或强拆通道）后才停止。
    Escalated,
    /// 升级后仍未响应。
    Unresponsive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TakeoverReport {
    pub frozen: bool,
    /// 接管生效时被作废的排队（未开始）exec。
    pub paused_queue: Vec<ExecId>,
    pub stopped: Vec<(ExecId, StopOutcome)>,
    /// 接管即附现场简报。
    pub brief: SessionBrief,
}

// ---------------------------------------------------------------------------
// 现场简报（交接核心工件，PRD FR-6；三层认知状态）
// ---------------------------------------------------------------------------

/// 三层认知状态：Confirmed=系统可直接观察；NeedsRecheck=发生过操作但结果需重读；
/// Unobservable=屏幕之外、系统未追踪的状态——明确留空，不冒充已知。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Epistemic {
    Confirmed,
    NeedsRecheck,
    Unobservable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BriefFact {
    pub subject: String,
    pub detail: String,
    pub status: Epistemic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionBrief {
    /// Confirmed（SSH 重连后降级 NeedsRecheck）。
    pub cwd: Option<String>,
    pub env_summary: String,
    /// 命令块/操作/控制权变迁归并的事实清单，逐条带认知状态。
    pub facts: Vec<BriefFact>,
    /// 运行中任务。断线后置 Unobservable（状态未知：nohup/systemd 可能仍在跑，
    /// 不得当作已结束、不得自动重试）——见 facts 中对应条目。
    pub running: Vec<ExecId>,
    pub pending_approvals: Vec<ApprovalId>,
    pub screen_summary: String,
    /// 人类给 Agent 的任务目标/交接留言（R9 委托入口；None=未设定）。
    /// 随会话存亡（会话现场本就易失），Agent 在交还/操作前经本简报读取。
    pub goal: Option<String>,
}

// ---------------------------------------------------------------------------
// 审批队列类型（读取路径契约）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalItem {
    pub id: ApprovalId,
    pub session_id: SessionId,
    pub agent_id: AgentClientId,
    pub command: String,
    /// ApproveEdited 后的实际执行文。
    pub edited_command: Option<String>,
    /// 命令本身的破坏性提示（如「删除 /tmp/x」），供卡片展示。
    pub target_summary: String,
    /// 逐段求值结果（人类可读），含每段命中/未命中情况。
    pub segment_report: Vec<SegmentReport>,
    /// 会话 busy 状态提示（该会话正在交互程序中）。
    pub session_busy: bool,
    /// 该卡是否支持「编辑后批准」（T44 复核中-2）：仅 exec 类可编辑——
    /// 转发/传输参数无法从人类编辑后的中文描述回解，ApproveEdited 会被
    /// 后端拒绝。UI 依此隐藏编辑钮（卡片可编辑性由后端声明，UI 不猜）。
    /// serde default：旧持久化行/旧前端缺省视为不可编辑（保守侧）。
    #[serde(default)]
    pub editable: bool,
    pub created_at: DateTime<Utc>,
    pub status: ApprovalStatus,
    /// C1：该卡所属建连 attempt（serde default——旧卡/非建连审批恒 None）。
    #[serde(default)]
    pub attempt_id: Option<AttemptId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApprovalStatus {
    Pending,
    Approved,
    ApprovedEdited,
    Denied,
    Timeout,
    Voided,
}

/// 主机指纹待决事项（路线图⑤ TOFU）：首连确认 / 变更告警。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HostKeyIssue {
    /// 首次连接该主机：指纹尚未被信任。
    FirstSeen,
    /// 与已信任指纹不一致：可能的中间人攻击或服务器换钥。
    Changed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingHostKey {
    pub id: String,
    pub host_id: HostId,
    pub host_name: String,
    pub address: String,
    pub port: u16,
    pub issue: HostKeyIssue,
    /// SHA256:... 形式的服务器公钥指纹。
    pub fingerprint: String,
    /// 变更告警时的原指纹。
    pub previous_fingerprint: Option<String>,
    pub created_at: DateTime<Utc>,
    /// C1：门所属 attempt（serde default——旧事件消费方兼容）。
    #[serde(default)]
    pub attempt_id: Option<AttemptId>,
}

/// 服务器 keyboard-interactive 认证提示（路线图⑩ 2FA）：密码类提示由
/// transport 层用库内密码自动应答，其余（OTP/验证码等）挂起等人类应答。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingAuthPrompt {
    pub id: String,
    pub host_name: String,
    /// 服务器给的请求名与说明（可为空）。
    pub name: String,
    pub instructions: String,
    pub prompt: String,
    /// false = 应答不应回显（服务器语义）。
    pub echo: bool,
    pub created_at: DateTime<Utc>,
    /// C1：门所属 attempt（serde default——旧事件消费方兼容）。
    #[serde(default)]
    pub attempt_id: Option<AttemptId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentReport {
    pub segment: String,
    /// deny 命中 / allow 命中 / 未命中需审批 / 无法解析。
    pub verdict: String,
}

#[derive(Debug, Clone, Default)]
pub struct ApprovalFilter {
    pub session_id: Option<SessionId>,
    pub agent_id: Option<AgentClientId>,
    pub pending_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ApprovalEvent {
    /// 新的待审批条目（含会话 busy 提示）。
    New(ApprovalItem),
    /// 状态变化（批准/拒绝/超时/作废）。
    Updated(ApprovalItem),
}

/// 转发状态变化回调（T44 真机冒烟补口）：transport 层各状态写口触发，
/// 参数为 forward id；由装配层注入（core-session 把它桥到 ForwardEvent 广播）。
pub type ForwardStateCb = std::sync::Arc<dyn Fn(&ForwardId) + Send + Sync>;

/// 转发事件（subscribe_forwards 订阅）：粗粒度 Changed——UI 收到后全量拉
/// 该会话转发列表（与轮询兜底同语义，事件驱动）。动机：真机冒烟实测
/// WKWebView 会节流 JS timer，3s 盲轮询挂起时 Agent 建的转发对人工不可见
/// （Degraded 数据面可见性缺口）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ForwardEvent {
    Changed { session_id: SessionId },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Decision {
    Approve,
    /// 批准编辑后的命令；只作用于被批准的那一条。
    ApproveEdited(String),
    Deny,
}

// ---------------------------------------------------------------------------
// 人类预配置策略（存 vault；ApprovalMode 由人类配置，MCP 不可指定）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ApprovalMode {
    /// 每条命令需审批（默认）。
    #[default]
    PerCommand,
    /// 完全信任该 client（仍保留危险模式拒绝）。V0 不在 UI 开放。
    TrustClient,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllowRule {
    /// 命令模式：前缀（结尾 `*`）、正则（开头 `^`）、否则精确匹配。
    pub pattern: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtlWindow {
    pub pattern: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DenyRule {
    /// 正则；命中即拒绝（内置项不可删除）。
    pub pattern: String,
    pub reason: String,
    pub builtin: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Policy {
    pub allow_rules: Vec<AllowRule>,
    pub ttl_windows: Vec<TtlWindow>,
    /// 追加 deny 规则（内置项在引擎内，不出现在此）。
    pub deny_rules: Vec<DenyRule>,
    pub default_mode: ApprovalMode,
}

// ---------------------------------------------------------------------------
// 主机 / 凭据 / 会话
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Host {
    pub id: HostId,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    pub identity_id: Option<IdentityId>,
    pub tags: Vec<String>,
    /// 已信任的主机指纹（TOFU，路线图⑤）；None = 信任尚未建立（首连确认前）。
    pub fingerprint: Option<String>,
    /// 远端字节编码（路线图⑩后半）：默认 UTF-8；Gbk 用于中文 Windows/老旧设备。
    /// 解码发生在传输出口（vt 解析之前）——GBK 尾字节与 ASCII 冲突，裸喂会腐蚀屏态。
    #[serde(default)]
    pub charset: Charset,
}

/// 会话字节编码。线格式 "utf-8"/"gbk"（显式逐变体 rename——serde kebab-case 对
/// `Utf8` 数字边界分词有歧义风险；vault hosts.charset 列与 UI select 同口径）；
/// 缺省 Utf8。UI（App.tsx）/demo shim/CLI 均按此三态字符串收发，改动即 wire 契约变更。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Charset {
    #[default]
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "gbk")]
    Gbk,
}

impl Charset {
    pub fn as_str(self) -> &'static str {
        match self {
            Charset::Utf8 => "utf-8",
            Charset::Gbk => "gbk",
        }
    }
    /// 持久化/外部输入解析：未知值回落 Utf8（老库行/手改库不炸连接）。
    pub fn parse(s: &str) -> Charset {
        match s.to_ascii_lowercase().as_str() {
            "gbk" | "gb2312" | "gb18030" => Charset::Gbk,
            _ => Charset::Utf8,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AuthType {
    Key,
    Password,
    KeyboardInteractive,
    /// 连接时经本机 ssh-agent（SSH_AUTH_SOCK）签名，私钥不出 agent。
    Agent,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HostDraft {
    pub id: Option<HostId>,
    pub name: String,
    pub address: String,
    pub port: Option<u16>,
    pub username: String,
    pub auth: AuthDraft,
    pub tags: Vec<String>,
    #[serde(default)]
    pub charset: Charset,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub enum AuthDraft {
    /// 编辑主机时保持现有凭据（UI 不持明文，不能回传重发）；新建主机回落为无凭据占位
    /// （仅本机 PTY 的 local 主机使用，SSH 建连前必须改绑凭据）。
    #[default]
    #[serde(rename = "Keep")]
    None,
    Key { identity_id: IdentityId },
    Password { password: String },
    /// 引用本机 ssh-agent（不落任何密钥材料）。
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentityMeta {
    pub id: IdentityId,
    pub label: String,
    pub kind: IdentityKind,
    pub fingerprint: String,
}

/// ~/.ssh/config 单条目预览（导入面板一行）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfigPreview {
    pub name: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    /// 条目带 IdentityFile（导入将读私钥建身份；false 则走 ssh-agent）
    pub has_identity: bool,
    /// 主机列表已有同名或同 address+port+user 条目
    pub already_imported: bool,
}

/// 导入逐条结果（error 为 None 表示成功）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshImportOutcome {
    pub name: String,
    pub host_id: Option<HostId>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IdentityKind {
    Ed25519,
    Rsa,
    Ecdsa,
    Password,
}

/// 生成或导入凭据；任何方法不返回私钥明文。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum IdentityReq {
    Generate { label: String, kind: KeyKind },
    Import { label: String, pem: String, passphrase: Option<String> },
    Password { label: String, password: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum KeyKind {
    Ed25519,
    Rsa,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: SessionId,
    pub host_id: HostId,
    pub host_name: String,
    /// local | ssh
    pub kind: String,
    pub state: SessionState,
    pub control_owner: ControlOwner,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionState {
    Connected,
    Degraded,
    Reconnecting,
    Disconnected,
    Reconfirming,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSessionReq {
    pub host_id: HostId,
}

// ---------------------------------------------------------------------------
// C1 建连尝试（R19）：attempt 状态机、取消与查询
// ---------------------------------------------------------------------------

pub type AttemptId = String;

/// wire 错误载荷（C1 attempt/事件内嵌；kind 与桥层 WireError.kind 同表——
/// `Error::wire_parts` 单点映射）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorPayload {
    pub kind: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

/// attempt 相位。终态（Ready/Failed/Cancelled/CancelCloseFailed）后不再变化，
/// `connection_status` 恒返回终态快照。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum AttemptPhase {
    Connecting,
    TrustRequired,
    Authenticating,
    ChallengeRequired,
    Ready,
    Failed,
    Cancelled,
    CancelCloseFailed,
}

impl AttemptPhase {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            AttemptPhase::Ready
                | AttemptPhase::Failed
                | AttemptPhase::Cancelled
                | AttemptPhase::CancelCloseFailed
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttemptInfo {
    pub attempt_id: AttemptId,
    pub host_id: HostId,
    /// "human" | "agent:<client_id>"——合并与取消权限的身份域（DC1.5）。
    pub actor: String,
    pub phase: AttemptPhase,
    pub session_id: Option<SessionId>,
    pub created_at: DateTime<Utc>,
    pub error: Option<crate::ErrorPayload>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BeginConnectionOpts {
    /// 显式绕过 (host_id, actor) 幂等合并（DC1.5）。
    #[serde(default)]
    pub new_session: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum CancelOutcome {
    /// 取消受理（终态以 connection-event 为准——DC1.2）。
    Cancelled,
    /// 取消落在「已提交未投递」窗口：刚创建且从未投递的会话被核心立即关闭后返回。
    AlreadyReady { session_id: SessionId },
    /// 竞态窗口自动关闭失败：attempt 终态 CancelCloseFailed，会话保留（恢复入口）。
    CancelCloseFailed { session_id: SessionId },
    /// 已投递（Ready 后迟到取消）、已终态、不存在或跨 Actor 身份域。
    NotFound,
}

/// connection-event 广播载荷（沿 approval-event 桥模式：核心 broadcast → 桥 emit）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionEvent {
    pub attempt_id: AttemptId,
    pub phase: AttemptPhase,
    pub session_id: Option<SessionId>,
    pub error: Option<crate::ErrorPayload>,
}

// ---------------------------------------------------------------------------
// 交互式（read_screen / send_keys / wait_output）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenSnapshot {
    pub cols: u16,
    pub rows: u16,
    /// 渲染后文本（含 scrollback）。
    pub text: String,
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub alt_screen: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WaitOpts {
    /// 静默期（毫秒）：无损缓冲尾时间戳超过该值视为安静。None=1000ms。
    pub quiet_ms: Option<u64>,
    /// 渲染后文本上的正则（匹配即提前返回）。
    pub regex: Option<String>,
    /// 总超时。None=10s。
    pub timeout: Option<Duration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputChunk {
    pub text: String,
    pub matched: bool,
    pub truncated_to_cap: bool,
}

/// UI 输出流事件（broadcast，可丢块；慢消费者走 resync，L0 ADR-2/7）。
/// Raw.seq 为会话内单调递增字节事件序号（C10）；桥层打包为 8 字节 LE 帧头 + 原始字节。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum OutputEvent {
    Raw { sid: SessionId, seq: u64, data: Vec<u8> },
    /// 屏幕状态大幅变化（resync 提示）。
    Resync { sid: SessionId },
}

// ---------------------------------------------------------------------------
// 输出订阅恢复（C10：检查点 + 重放；实现 R11）
// ---------------------------------------------------------------------------

/// 颜色规格（CellRun 属性）。None = 终端默认色；Indexed = 256 色；
/// Rgb = 真彩色。命名色由核心归一为 Indexed(0-15) 或 None。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ColorSpec {
    Indexed(u8),
    Rgb(u8, u8, u8),
}

/// 单元格属性位集（CellRun.flags）。位定义前后端契约固定：
/// bit0=粗体 1=暗淡 2=斜体 3=下划线 4=双下划线 5=删除线 6=反显 7=隐藏。
pub mod cell_flags {
    pub const BOLD: u32 = 1 << 0;
    pub const DIM: u32 = 1 << 1;
    pub const ITALIC: u32 = 1 << 2;
    pub const UNDERLINE: u32 = 1 << 3;
    pub const DOUBLE_UNDERLINE: u32 = 1 << 4;
    pub const STRIKEOUT: u32 = 1 << 5;
    pub const INVERSE: u32 = 1 << 6;
    pub const HIDDEN: u32 = 1 << 7;
}

/// 同属性连续单元格 run（C10 BufferCheckpoint 的序列化单元）。
/// text 内宽字符只出现一次（占位 spacer 省略，终端恢复时自动占两格）；
/// 行尾默认属性空格裁剪。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CellRun {
    pub text: String,
    pub fg: Option<ColorSpec>,
    pub bg: Option<ColorSpec>,
    pub flags: u32,
}

/// 单个缓冲的检查点：全网格行（历史 + 可视）自顶向下的属性 run 串行化。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BufferCheckpoint {
    pub lines: Vec<Vec<CellRun>>,
}

/// 光标状态（可视区坐标，0 基；y 自顶向下）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorState {
    pub x: u32,
    pub y: u32,
    pub visible: bool,
    /// "block" | "underline" | "beam"；隐藏时仍有值（恢复后由 visible 决定显示）。
    pub style: String,
}

/// 恢复所需的终端模式（C10 按实现支持面枚举）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScreenModes {
    pub autowrap: bool,
    pub application_cursor: bool,
    pub bracketed_paste: bool,
    pub origin_mode: bool,
}

/// 屏幕检查点（C10 恢复载体；DF10.4）。
/// buffers 恒两元素 [主缓冲, 备用缓冲]；active_buffer ∈ {0,1}。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScreenCheckpoint {
    pub cols: u16,
    pub rows: u16,
    pub buffers: [BufferCheckpoint; 2],
    pub active_buffer: u8,
    pub cursor: CursorState,
    pub modes: ScreenModes,
    /// 终端标题（OSC 0/2）。核心侧暂不追踪（alacritty 0.26 Term 不持有标题），
    /// 恒 None；字段为 wire 前向兼容保留。
    pub title: Option<String>,
}

/// subscribe_output 返回（DF10.2）：订阅身份 + 原子捕获的检查点与水位。
/// start_seq = 检查点最后已包含的事件序号（包含该序号；无输出为 0）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachOutput {
    pub subscription_id: String,
    pub checkpoint: ScreenCheckpoint,
    pub start_seq: u64,
}

/// 重放单元：带 seq 的原始字节事件。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeqFrame {
    pub seq: u64,
    pub data: Vec<u8>,
}

/// resync_output 响应（DF10.3）：优先无损原始字节重放，
/// 不可重放（淘汰/alt_screen 活跃/检查点更近）退检查点。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResyncOutput {
    Replayed {
        subscription_id: String,
        events: Vec<SeqFrame>,
        /// 重放最后已包含的事件序号（包含）；应用后丢弃缓存 seq <= end_seq。
        end_seq: u64,
    },
    Checkpointed {
        subscription_id: String,
        checkpoint: ScreenCheckpoint,
        end_seq: u64,
    },
}

/// debug_subscriptions 返回（P6 测量口径：每存活会话 ≤1；退订后归零）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSubs {
    pub session_id: SessionId,
    pub subscription_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugSubscriptions {
    pub active_count: usize,
    pub per_session: Vec<SessionSubs>,
}

// ---------------------------------------------------------------------------
// 传输（upload/download）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferHandle {
    pub id: TransferId,
    pub session_id: SessionId,
    pub kind: TransferKind,
    pub local: PathBuf,
    pub remote: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransferKind {
    Upload,
    Download,
}

/// SFTP 目录条目（T41 FR-7 浏览器）。wire 三端一致（Rust/UI/demo）：
/// transport 按名称排序（目录在前）返回，UI 直接渲染。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntryS {
    pub name: String,
    pub is_dir: bool,
    /// 字节数；目录为 0
    pub size: u64,
    /// Unix 秒；未知为 0
    pub mtime: i64,
}

// ---------------------------------------------------------------------------
// 端口转发（T42 FR-8）
// ---------------------------------------------------------------------------

pub type ForwardId = String;

/// 转发规格。wire 三端一致（Rust/UI/demo）。
/// - Local：本地监听 listen_addr:listen_port，经 SSH 通道到远端 target_host:target_port（-L）
/// - Remote：SSH 服务器监听 listen_addr:listen_port，回程到本地 target_host:target_port（-R）
/// - Dynamic：本地 SOCKS5 代理 listen_addr:listen_port（-D；目标由每个连接的握手决定）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ForwardSpec {
    Local {
        listen_addr: String,
        listen_port: u16,
        target_host: String,
        target_port: u16,
    },
    Remote {
        listen_addr: String,
        listen_port: u16,
        target_host: String,
        target_port: u16,
    },
    Dynamic {
        listen_addr: String,
        listen_port: u16,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForwardInfo {
    pub id: ForwardId,
    pub spec: ForwardSpec,
    /// 线格式 PascalCase："Listening" | "Degraded" | "Failed"
    /// （T44 起 Degraded = 隧道/目标侧数据面暂不可用，可自动恢复）
    pub state: String,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    pub seq: i64,
    pub ts: DateTime<Utc>,
    pub actor_kind: String,
    pub agent_id: Option<AgentClientId>,
    pub action: String,
    pub session_id: Option<SessionId>,
    pub command: Option<String>,
    /// 输出摘要（截断、无凭据）。
    pub payload_json: serde_json::Value,
    pub approval_id: Option<ApprovalId>,
    pub prev_hash: Option<String>,
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct AuditFilter {
    pub session_id: Option<SessionId>,
    pub agent_id: Option<AgentClientId>,
    pub action: Option<String>,
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    pub offset: i64,
    pub limit: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditPage {
    pub total: i64,
    pub events: Vec<AuditEvent>,
}

// ---------------------------------------------------------------------------
// 错误模型（封闭枚举，新增走 ADR；MCP 层原样映射）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
pub enum Error {
    #[error("审批拒绝: {reason:?}")]
    ApprovalDenied { reason: DeniedReason },
    /// 会话控制权在人类（exec/send_keys/close 等被拒）。
    #[error("控制权在人类（已接管）")]
    ControlTakenByHuman,
    /// 交接前未开始的请求因接管作废（不自动执行），附最新简报。
    #[error("请求已作废（人工接管或会话关闭）——如需继续请重新发起")]
    VoidedByHandback { brief: Box<SessionBrief> },
    /// 会话处于重确认态：仅允许内置只读核实命令白名单。
    #[error("重连后需重确认：当前仅允许内置只读核实命令")]
    ReconfirmingPending,
    #[error("会话不存在")]
    SessionNotFound,
    #[error("会话已关闭")]
    SessionClosed,
    #[error("认证失败")]
    AuthFailed,
    #[error("连接失败: {0}")]
    ConnectFailed(String),
    /// 主机指纹门未放行（用户拒绝或确认超时；路线图⑤ TOFU）。
    #[error("主机指纹验证失败（{0}）")]
    HostKeyRejected(String),
    /// 执行超时（与 ApprovalTimeout 区分）。
    #[error("执行超时")]
    ExecTimeout,
    /// cancel_exec / cancel_transfer。
    #[error("已取消")]
    Cancelled,
    /// exec 串行队列积压（前端可提示排队位置）。
    #[error("执行队列繁忙，位于第 {position} 位")]
    QueueBusy { position: u32 },
    #[error("调用者身份无效")]
    InvalidActor,
    #[error("无效输入: {0}")]
    InvalidInput(String),
    /// 凭据仍被主机引用，不可删除（DF8.4）：附引用主机名列表。
    #[error("凭据正在被主机引用（{host_names:?}），无法删除")]
    IdentityInUse { host_names: Vec<String> },
    #[error("存储错误: {0}")]
    Storage(String),
    #[error("IO 错误: {0}")]
    Io(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeniedReason {
    /// 人类明确拒绝。
    Denied,
    /// 审批等待超时（默认 120s）。
    ApprovalTimeout,
    /// 命中内置/追加危险模式，不可批准。
    DangerousPattern,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// wire kind 与 detail 的单点映射（tauri WireError::from 与 C1 attempt
    /// 错误载荷共用此表，防止两份映射漂移）。
    pub fn wire_parts(&self) -> (&'static str, Option<serde_json::Value>) {
        use Error as E;
        match self {
            E::ApprovalDenied { reason } => (
                "approval_denied",
                Some(serde_json::json!({ "reason": reason })),
            ),
            E::ControlTakenByHuman => ("control_taken_by_human", None),
            E::VoidedByHandback { .. } => ("voided_by_handback", None),
            E::ReconfirmingPending => ("reconfirming_pending", None),
            E::SessionNotFound => ("session_not_found", None),
            E::SessionClosed => ("session_closed", None),
            E::AuthFailed => ("auth_failed", None),
            E::ConnectFailed(r) => ("connect_failed", Some(serde_json::json!({ "reason": r }))),
            E::HostKeyRejected(_) => ("host_key_rejected", None),
            E::ExecTimeout => ("exec_timeout", None),
            E::Cancelled => ("cancelled", None),
            E::QueueBusy { position } => {
                ("queue_busy", Some(serde_json::json!({ "position": position })))
            }
            E::InvalidActor => ("invalid_actor", None),
            E::InvalidInput(_) => ("invalid_input", None),
            E::IdentityInUse { host_names } => (
                "identity_in_use",
                Some(serde_json::json!({ "host_names": host_names })),
            ),
            E::Storage(_) => ("storage", None),
            E::Io(_) => ("io", None),
        }
    }

    /// C1 attempt/事件内嵌错误载荷（kind 与桥层 WireError.kind 同表）。
    pub fn payload(&self) -> ErrorPayload {
        let (kind, detail) = self.wire_parts();
        ErrorPayload {
            kind: kind.to_string(),
            message: self.to_string(),
            detail,
        }
    }
}

// ---------------------------------------------------------------------------
// C8 偏好与主机元数据（实现 R15；消费 R20/R27/R44）
// ---------------------------------------------------------------------------

/// 应用工作区偏好（DF8.1）：`ui.v2.workspace` 单键 JSON blob，整取整存原子写。
/// 不含秘密/终端输出/会话目标；schemaVersion 前向演进（R44 升级演练据此定路径）。
/// 终端配色四预设仍在 `ui.theme` 键（值不变）；chrome 是 DF8.3 映射的镜像字段。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    pub schema_version: u32,
    /// 应用外观：dark | light（DF8.3 由终端主题映射；R27 消费）
    #[serde(default = "default_chrome")]
    pub chrome: String,
    /// 主机栏开合与宽度（§4.2；R12 的浏览器 localStorage 暂存迁入；None = 尚未写入）
    #[serde(default)]
    pub hostbar: Option<HostbarPrefs>,
}

fn default_chrome() -> String {
    "dark".into()
}

impl Default for Workspace {
    fn default() -> Self {
        Workspace { schema_version: 1, chrome: default_chrome(), hostbar: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostbarPrefs {
    pub open: bool,
    pub width: u32,
}

/// 主机元数据（DF8.2：V5 `host_metadata` 表，一行一主机）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostMeta {
    pub host_id: HostId,
    pub favorite: bool,
    /// 最近一次成功建连时间；None = 从未连接。
    pub last_connected_at: Option<DateTime<Utc>>,
}

/// 最近连接（DF8.5）：sessions 表派生——排除 local、每主机取最近一次、时间倒序、上限 5。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecentHost {
    pub host_id: HostId,
    pub host_name: String,
    pub connected_at: DateTime<Utc>,
}

// ---------------------------------------------------------------------------
// 核心门面 trait（v1 标注 = V0 末冻结范围）
// ---------------------------------------------------------------------------

#[async_trait]
pub trait SessionApi: Send + Sync {
    // ---- 主机与凭据（v1；PRD FR-2）----
    async fn list_hosts(&self, ctx: &Actor) -> Result<Vec<Host>>;
    async fn upsert_host(&self, ctx: &Actor, host: HostDraft) -> Result<HostId>;
    async fn delete_host(&self, ctx: &Actor, id: HostId) -> Result<()>;
    async fn list_identities(&self, ctx: &Actor) -> Result<Vec<IdentityMeta>>;
    async fn create_identity(&self, ctx: &Actor, req: IdentityReq) -> Result<IdentityMeta>;
    async fn delete_identity(&self, ctx: &Actor, id: IdentityId) -> Result<()>;

    // ---- 偏好与主机元数据（C8/R15；消费 R20/R27/R44）----
    /// 工作区偏好整取（ui.v2.workspace blob）；从未写入 → Default。
    async fn get_workspace(&self, ctx: &Actor) -> Result<Workspace>;
    /// 工作区偏好整存（原子覆盖；schemaVersion 由核心归一为当前版本）。
    async fn set_workspace(&self, ctx: &Actor, ws: Workspace) -> Result<()>;
    /// 收藏/取消收藏主机（host_metadata upsert；未知主机 InvalidInput）。
    async fn set_host_favorite(&self, ctx: &Actor, host_id: HostId, favorite: bool) -> Result<()>;
    /// 主机元数据列表（收藏 + 最近连接时间；无行 = 未收藏且从未连接，不虚构）。
    async fn list_host_metadata(&self, ctx: &Actor) -> Result<Vec<HostMeta>>;
    /// 最近连接（DF8.5：sessions 派生、排除 local、每主机最近一次、倒序上限 5）。
    async fn list_recent_hosts(&self, ctx: &Actor) -> Result<Vec<RecentHost>>;

    // ---- 会话（v1；PRD FR-1/FR-4）----
    async fn list_sessions(&self, ctx: &Actor) -> Result<Vec<SessionInfo>>;
    async fn create_session(&self, ctx: &Actor, req: CreateSessionReq) -> Result<SessionId>;
    async fn close_session(&self, ctx: &Actor, sid: SessionId) -> Result<()>;
    async fn resize(&self, ctx: &Actor, sid: SessionId, cols: u16, rows: u16) -> Result<()>;

    // ---- C1 建连尝试（实现 R19；消费 R21/R23/R26）----
    /// 发起建连 attempt：(host_id, actor) 幂等合并（`new_session` 显式绕过）。
    /// 立即返回 AttemptInfo（连接在核心后台推进），相位经 connection-event 表达。
    async fn begin_connection(
        &self,
        ctx: &Actor,
        host_id: HostId,
        opts: BeginConnectionOpts,
    ) -> Result<AttemptInfo>;
    /// attempt 快照查询；终态后恒返回终态（不设历史查询——DC1）。
    async fn connection_status(&self, ctx: &Actor, attempt_id: AttemptId) -> Result<AttemptInfo>;
    /// 取消建连。Cancelled=受理（终态以事件为准）；AlreadyReady/CancelCloseFailed=
    /// 竞态窗口结算；NotFound=已投递/已终态/不存在/跨 Actor 身份域。
    async fn cancel_connection(&self, ctx: &Actor, attempt_id: AttemptId) -> Result<CancelOutcome>;
    /// connection-event 广播（沿 approval-event 桥模式）。
    fn subscribe_connections(&self) -> broadcast::Receiver<ConnectionEvent>;

    // ---- exec（v1；PRD FR-3/FR-4）----
    async fn exec(
        &self,
        ctx: &Actor,
        sid: SessionId,
        cmd: &str,
        opts: ExecOpts,
    ) -> Result<ExecResult>;
    async fn cancel_exec(&self, ctx: &Actor, sid: SessionId, exec_id: ExecId) -> Result<()>;

    // ---- 交互式（v1；PRD FR-6）----
    async fn read_screen(&self, ctx: &Actor, sid: SessionId) -> Result<ScreenSnapshot>;
    async fn send_keys(&self, ctx: &Actor, sid: SessionId, keys: &str) -> Result<()>;
    async fn wait_output(&self, ctx: &Actor, sid: SessionId, opts: WaitOpts) -> Result<OutputChunk>;
    async fn set_control(
        &self,
        ctx: &Actor,
        sid: SessionId,
        owner: ControlOwner,
        opts: ControlOpts,
    ) -> Result<TakeoverReport>;

    // ---- 传输（v1；PRD FR-7）----
    async fn upload(
        &self,
        ctx: &Actor,
        sid: SessionId,
        local: &std::path::Path,
        remote: &str,
    ) -> Result<TransferHandle>;
    async fn download(
        &self,
        ctx: &Actor,
        sid: SessionId,
        remote: &str,
        local: &std::path::Path,
    ) -> Result<TransferHandle>;
    async fn cancel_transfer(&self, ctx: &Actor, t: TransferId) -> Result<()>;

    /// 人类浏览远端目录（FR-7 SFTP 浏览器，只读）。path 为绝对路径；
    /// 条目按名称排序（目录在前）由 transport 层保证。
    async fn sftp_list(&self, ctx: &Actor, sid: SessionId, path: &str) -> Result<Vec<DirEntryS>>;

    // ---- 端口转发（FR-8，T42）----
    /// 列出会话的转发（任何 Actor 可查——PRD「MCP 可查询状态」口径）。
    async fn list_forwards(&self, ctx: &Actor, sid: SessionId) -> Result<Vec<ForwardInfo>>;
    /// 创建并启动转发。人类直建；Agent 创建需授权——审批版留 V1/MCP 侧（当前无 Agent 入口）。
    async fn start_forward(&self, ctx: &Actor, sid: SessionId, spec: ForwardSpec) -> Result<ForwardId>;
    async fn stop_forward(&self, ctx: &Actor, sid: SessionId, fid: ForwardId) -> Result<()>;
    /// 转发状态变化事件（T44 真机冒烟补口）：start/stop/Degraded/恢复/Failed
    /// 状态写口广播——UI 事件驱动刷新转发面板，替代纯盲轮询。
    fn subscribe_forwards(&self) -> broadcast::Receiver<ForwardEvent>;

    // ---- 审批（v1 读取路径；PRD FR-4）----
    async fn list_approvals(&self, ctx: &Actor, f: ApprovalFilter) -> Result<Vec<ApprovalItem>>;
    fn subscribe_approvals(&self) -> broadcast::Receiver<ApprovalEvent>;
    async fn decide_approval(&self, ctx: &Actor, id: ApprovalId, d: Decision) -> Result<()>;
    // ---- 主机指纹门（路线图⑤ TOFU）----
    async fn pending_host_keys(&self, ctx: &Actor) -> Result<Vec<PendingHostKey>>;
    fn subscribe_host_keys(&self) -> broadcast::Receiver<PendingHostKey>;
    /// 人类对首连确认/变更告警作出决定；accept=true 时指纹入库。
    async fn decide_host_key(&self, ctx: &Actor, id: &str, accept: bool) -> Result<()>;

    // ---- 2FA 人工应答门（路线图⑩：keyboard-interactive 非密码类提示）----
    async fn pending_auth_prompts(&self, ctx: &Actor) -> Result<Vec<PendingAuthPrompt>>;
    fn subscribe_auth_prompts(&self) -> broadcast::Receiver<PendingAuthPrompt>;
    /// 人类应答服务器认证提示；answer 为空串视为取消（认证失败）。
    async fn answer_auth_prompt(&self, ctx: &Actor, id: &str, answer: &str) -> Result<()>;

    // ---- 审计（v1；PRD FR-5）----
    async fn query_audit(&self, ctx: &Actor, f: AuditFilter) -> Result<AuditPage>;
    async fn export_audit(&self, ctx: &Actor, f: AuditFilter, to: &std::path::Path) -> Result<()>;

    // ---- 现场简报（v1；交接核心工件，PRD FR-3/FR-6）----
    async fn get_session_brief(&self, ctx: &Actor, sid: SessionId) -> Result<SessionBrief>;

    /// 设定会话任务目标/交接留言（R9：人类→Agent 委托入口；None=清除，仅人类）。
    /// Agent 经 get_session_brief 的 goal 字段读取；设定/清除全程审计留痕。
    async fn set_session_goal(&self, ctx: &Actor, sid: SessionId, goal: Option<String>) -> Result<()>;

    // ---- 人类专属：输出流订阅（IPC Bridge 用；MCP 不提供流，只提供快照/等待）----
    // C10 起订阅带检查点与订阅身份（AttachOutput），桥层另需 broadcast receiver——
    // 签名含非 trait 载体，收口为 SessionManager 固有方法 subscribe_output_channel；
    // wire 类型（AttachOutput/ResyncOutput/ScreenCheckpoint）仍冻结在本 crate。
}

// ---------------------------------------------------------------------------
// 通用默认值（L1 常量）
// ---------------------------------------------------------------------------

pub const DEFAULT_EXEC_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_OUTPUT_CAP: usize = 128 * 1024;
pub const DEFAULT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
pub const DEFAULT_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
pub const DEFAULT_QUIET_MS: u64 = 1000;
/// exec 串行队列积压上限：超过则立即返回 QueueBusy（背压）。
pub const MAX_EXEC_QUEUE: usize = 8;
/// 人类输入优先窗口：人类 2s 内有输入时，agent send_keys 延迟。
pub const HUMAN_INPUT_PRIORITY_WINDOW: Duration = Duration::from_secs(2);

#[cfg(test)]
mod wire_format_tests {
    use super::*;

    /// 锁定 ApprovalStatus 的线上格式：PascalCase（serde 无 rename_all）。
    /// UI（ui/src/App.tsx normApprovalStatus）与 demo shim 都依赖这一形态：
    /// 改动即 MCP/Tauri wire 契约变更，须走 L1 契约评审，不得顺手 rename。
    #[test]
    fn approval_status_wire_format_is_pascal_case() {
        assert_eq!(serde_json::to_value(ApprovalStatus::Pending).unwrap(), "Pending");
        assert_eq!(serde_json::to_value(ApprovalStatus::Approved).unwrap(), "Approved");
        assert_eq!(serde_json::to_value(ApprovalStatus::ApprovedEdited).unwrap(), "ApprovedEdited");
        assert_eq!(serde_json::to_value(ApprovalStatus::Denied).unwrap(), "Denied");
        assert_eq!(serde_json::to_value(ApprovalStatus::Timeout).unwrap(), "Timeout");
        assert_eq!(serde_json::to_value(ApprovalStatus::Voided).unwrap(), "Voided");
    }

    /// 锁定 ApprovalItem.editable 的线上行为（T44 复核中-2）：字段随卡下发；
    /// 旧持久化行/旧前端载荷缺失该字段时缺省 false（不可编辑，保守侧）。
    /// UI 隐藏编辑钮依赖此字段——后端声明可编辑性，UI 不从 command 文本猜。
    #[test]
    fn approval_item_editable_field_wire_behavior() {
        let item = ApprovalItem {
            id: "a-1".into(), session_id: "s-1".into(), agent_id: "opencode".into(),
            command: "ls".into(), edited_command: None, target_summary: String::new(),
            segment_report: vec![], session_busy: false, editable: true,
            created_at: DateTime::parse_from_rfc3339("1970-01-01T00:00:00Z").unwrap().with_timezone(&Utc),
            status: ApprovalStatus::Pending,
            attempt_id: None,
        };
        let v = serde_json::to_value(&item).unwrap();
        assert_eq!(v["editable"], true);
        // 旧载荷（vault 旧行/旧前端）无 editable 字段 → 反序列化为 false
        let legacy = serde_json::json!({
            "id": "a-1", "session_id": "s-1", "agent_id": "opencode",
            "command": "ls", "edited_command": null, "target_summary": "",
            "segment_report": [], "session_busy": false,
            "created_at": "1970-01-01T00:00:00Z", "status": "Pending",
        });
        let item: ApprovalItem = serde_json::from_value(legacy).unwrap();
        assert!(!item.editable);
    }

    /// 锁定 Charset 的线上格式："utf-8"/"gbk"（与 vault hosts.charset 列、UI select、
    /// demo shim 同口径）。T38 独立审核（B1）实锤：曾用 rename_all="lowercase" 产出
    /// "utf8"，UI 发送 "utf-8" 即被 tauri serde 拒收——真实 app 保存任何主机必失败，
    /// 而 demo shim 按错误口径放行掩住了它（demo.ts 头部警告的伪影类别）。
    /// 本测试按 UI upsert_host 实际载荷形态断言，防再次漂移。
    #[test]
    fn charset_wire_format_matches_ui_and_vault() {
        // 序列化：list_hosts → UI 的 Host
        let host_value = serde_json::to_value(Charset::Utf8).unwrap();
        assert_eq!(host_value, "utf-8");
        assert_eq!(serde_json::to_value(Charset::Gbk).unwrap(), "gbk");
        // 反序列化：UI upsert_host 的 HostDraft 载荷（tauri command serde 边界）
        let draft: HostDraft = serde_json::from_value(serde_json::json!({
            "id": null, "name": "n", "address": "a", "port": 22, "username": "u",
            "auth": { "Password": { "password": "p" } }, "tags": [],
            "charset": "utf-8",
        })).unwrap();
        assert_eq!(draft.charset, Charset::Utf8);
        let draft: HostDraft = serde_json::from_value(serde_json::json!({
            "id": null, "name": "n", "address": "a", "port": 22, "username": "u",
            "auth": { "Password": { "password": "p" } }, "tags": [],
            "charset": "gbk",
        })).unwrap();
        assert_eq!(draft.charset, Charset::Gbk);
        // 缺省：老客户端不带 charset 字段
        let draft: HostDraft = serde_json::from_value(serde_json::json!({
            "id": null, "name": "n", "address": "a", "port": 22, "username": "u",
            "auth": { "Password": { "password": "p" } }, "tags": [],
        })).unwrap();
        assert_eq!(draft.charset, Charset::Utf8);
        // 错误口径必须被拒绝（曾经的 bug 形态 "utf8" 不再是合法值）
        let bad = serde_json::from_value::<HostDraft>(serde_json::json!({
            "id": null, "name": "n", "address": "a", "port": 22, "username": "u",
            "auth": { "Password": { "password": "p" } }, "tags": [],
            "charset": "utf8",
        }));
        assert!(bad.is_err());
    }

    /// 锁定 IdentityReq / AuthDraft / IdentityMeta 的线上格式（T40 UI 生成 ed25519 与
    /// Agent 登录依赖）：外部标签保持 PascalCase，KeyKind 无 rename（"Ed25519"/"Rsa"），
    /// AuthDraft::None 线上名为 "Keep"。UI create_identity 载荷
    /// `{ Generate: { label, kind: "Ed25519" } }` 与 upsert_host 的 `"Agent"` /
    /// `{ Key: { identity_id } }` 均按此断言——防 B1 类 wire 漂移重演。
    #[test]
    fn identity_and_auth_draft_wire_format_matches_ui() {
        assert_eq!(
            serde_json::to_value(IdentityReq::Generate { label: "k".into(), kind: KeyKind::Ed25519 }).unwrap(),
            serde_json::json!({ "Generate": { "label": "k", "kind": "Ed25519" } })
        );
        assert_eq!(
            serde_json::to_value(IdentityReq::Import { label: "k".into(), pem: "PEM".into(), passphrase: None }).unwrap(),
            serde_json::json!({ "Import": { "label": "k", "pem": "PEM", "passphrase": null } })
        );
        // UI upsert_host 的三种 auth 载荷形态
        let draft: HostDraft = serde_json::from_value(serde_json::json!({
            "id": null, "name": "n", "address": "a", "port": 22, "username": "u",
            "auth": "Agent", "tags": [],
        })).unwrap();
        assert!(matches!(draft.auth, AuthDraft::Agent));
        let draft: HostDraft = serde_json::from_value(serde_json::json!({
            "id": null, "name": "n", "address": "a", "port": 22, "username": "u",
            "auth": { "Key": { "identity_id": "id-1" } }, "tags": [],
        })).unwrap();
        assert!(matches!(draft.auth, AuthDraft::Key { .. }));
        let draft: HostDraft = serde_json::from_value(serde_json::json!({
            "id": null, "name": "n", "address": "a", "port": 22, "username": "u",
            "auth": "Keep", "tags": [],
        })).unwrap();
        assert!(matches!(draft.auth, AuthDraft::None));
        // create_identity 回包形态（UI 指纹确认直接展示 fingerprint 字段）
        let meta: IdentityMeta = serde_json::from_value(serde_json::json!({
            "id": "i", "label": "l", "kind": "Ed25519", "fingerprint": "SHA256:x",
        })).unwrap();
        assert_eq!(meta.fingerprint, "SHA256:x");
    }

    /// 锁定 DirEntryS 的线上格式（T41 FR-7 SFTP 浏览器）：UI/demo shim 按
    /// {name,is_dir,size,mtime} 渲染，字段名漂移即渲染断裂。
    #[test]
    fn dir_entry_wire_format_matches_ui() {
        let e: DirEntryS = serde_json::from_value(serde_json::json!({
            "name": "a.txt", "is_dir": false, "size": 6, "mtime": 1790956800,
        })).unwrap();
        assert_eq!((e.name.as_str(), e.is_dir, e.size, e.mtime), ("a.txt", false, 6, 1790956800));
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            serde_json::json!({ "name": "a.txt", "is_dir": false, "size": 6, "mtime": 1790956800 })
        );
    }

    // T42 端口转发：ForwardSpec 外部标签三变体 + ForwardInfo 往返，锁 UI 的
    // { Local: {...} } / { Remote: {...} } / { Dynamic: {...} } 构造形态
    fn forward_wire_format_matches_ui() {
        let local: ForwardSpec = serde_json::from_value(serde_json::json!({
            "Local": { "listen_addr": "127.0.0.1", "listen_port": 18080, "target_host": "10.0.0.5", "target_port": 80 }
        })).unwrap();
        let remote: ForwardSpec = serde_json::from_value(serde_json::json!({
            "Remote": { "listen_addr": "", "listen_port": 2223, "target_host": "127.0.0.1", "target_port": 9527 }
        })).unwrap();
        let dynamic: ForwardSpec = serde_json::from_value(serde_json::json!({
            "Dynamic": { "listen_addr": "127.0.0.1", "listen_port": 11080 }
        })).unwrap();
        assert_eq!(
            serde_json::to_value(&local).unwrap(),
            serde_json::json!({ "Local": { "listen_addr": "127.0.0.1", "listen_port": 18080, "target_host": "10.0.0.5", "target_port": 80 } })
        );
        assert_eq!(
            serde_json::to_value(&remote).unwrap(),
            serde_json::json!({ "Remote": { "listen_addr": "", "listen_port": 2223, "target_host": "127.0.0.1", "target_port": 9527 } })
        );
        assert_eq!(
            serde_json::to_value(&dynamic).unwrap(),
            serde_json::json!({ "Dynamic": { "listen_addr": "127.0.0.1", "listen_port": 11080 } })
        );
        // ForwardInfo 往返（list_forwards 返回形态）：state/error 字段名与小写状态值锁定
        let info: ForwardInfo = serde_json::from_value(serde_json::json!({
            "id": "f-1", "spec": { "Dynamic": { "listen_addr": "127.0.0.1", "listen_port": 11080 } },
            "state": "Listening", "error": null
        })).unwrap();
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            serde_json::json!({
                "id": "f-1", "spec": { "Dynamic": { "listen_addr": "127.0.0.1", "listen_port": 11080 } },
                "state": "Listening", "error": null
            })
        );
        let info2: ForwardInfo = serde_json::from_value(serde_json::json!({
            "id": "f-2", "spec": { "Remote": { "listen_addr": "", "listen_port": 2223, "target_host": "10.0.0.9", "target_port": 5432 } },
            "state": "Failed", "error": "RequestDenied: 地址已在使用"
        })).unwrap();
        assert_eq!(info2.state, "Failed");
        assert_eq!(info2.error.as_deref(), Some("RequestDenied: 地址已在使用"));
    }
}
