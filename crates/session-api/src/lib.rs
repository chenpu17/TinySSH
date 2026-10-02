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
    pub created_at: DateTime<Utc>,
    pub status: ApprovalStatus,
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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum OutputEvent {
    Raw { sid: SessionId, data: Vec<u8> },
    /// 屏幕状态大幅变化（resync 提示）。
    Resync { sid: SessionId },
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
    #[error("请求已因人工接管作废，请读取简报后重新决定")]
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

    // ---- 会话（v1；PRD FR-1/FR-4）----
    async fn list_sessions(&self, ctx: &Actor) -> Result<Vec<SessionInfo>>;
    async fn create_session(&self, ctx: &Actor, req: CreateSessionReq) -> Result<SessionId>;
    async fn close_session(&self, ctx: &Actor, sid: SessionId) -> Result<()>;
    async fn resize(&self, ctx: &Actor, sid: SessionId, cols: u16, rows: u16) -> Result<()>;

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

    // ---- 人类专属：输出流订阅（IPC Bridge 用；MCP 不提供流，只提供快照/等待）----
    fn subscribe_output(&self, sid: SessionId) -> Result<broadcast::Receiver<OutputEvent>>;
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
}
