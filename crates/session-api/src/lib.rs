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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExecOpts {
    pub mode: ExecMode,
    /// 超时；自审批放行起算（不含审批等待）。None = 使用默认 30s。
    pub timeout: Option<Duration>,
    /// stdout/stderr 返回上限（字节）。None = 128 KiB，超限截断并标 truncated。
    pub output_cap: Option<usize>,
    /// 仅 Fresh 模式生效。
    pub env: BTreeMap<String, String>,
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
    /// ② 自主模式：人类按 Agent 显式授权期间跳过逐条审批（deny 名单仍硬拦）。
    Autonomous,
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

/// FR-10 V2（P1-b 命令块轮）：命令块查询行——term-core BlockIndex 的只读投影。
/// 人类与 Agent 同权（与简报同口径）；输出区间不在此暴露（grid 绝对行号仅供
/// 索引展示，跨实现不保证与前端缓冲区对齐——前端定位走文本搜索）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockInfo {
    pub command: String,
    pub start: Option<DateTime<Utc>>,
    pub end: Option<DateTime<Utc>>,
    /// OSC 133 D 提供的退出码；断线强制收尾/未完成块为 None（如实未知）。
    pub exit_code: Option<i32>,
    /// `BlockSource::describe()`：human / agent:<client> / replay[:<client>]。
    pub source: String,
    /// Shell 模式 exec 关联的执行记录 id；人类键入块为 None。
    pub exec_id: Option<String>,
}

// ---------------------------------------------------------------------------
// P2-b 输出触发器：规则（人类设置项）与命中事件
// ---------------------------------------------------------------------------

/// 触发器规则在 vault settings 表的 KV 键（JSON `Vec<TriggerRule>`）。
pub const TRIGGERS_KV_KEY: &str = "triggers.v1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum TriggerAction {
    /// 命中即通知：UI toast + 标签铃 + 审计 `trigger_fired`。无副作用。
    Notify,
    /// 命中后**请求**向会话发送键序——建审批卡等人类裁决（可编辑键序），批准才
    /// 写通道。绝不静默自动执行；Agent 在控/停用协作不拦截（裁决权在人类）。
    SendKeys,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TriggerRule {
    /// `t-` 前缀短 id；保存端归一（空则补），冷却历史按 (id, session) 记。
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// 按**完整行**匹配的正则（匹配前剥离 ANSI CSI/OSC；跨行不命中——如实边界）。
    pub pattern: String,
    pub action: TriggerAction,
    /// SendKeys 必填；**转义原文**（`\r` `\n` `\t` `\0` `\\`，存原文可保真回显/再编辑），
    /// 发送前解码并经 PTY 直写（非命令文本，不记命令块——归因不撒谎）。
    #[serde(default)]
    pub keys: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 同规则同会话两次触发的最小间隔（秒）；存端 clamp 5..=3600，缺省 60。
    #[serde(default = "default_cooldown_secs")]
    pub cooldown_secs: u32,
}
fn default_true() -> bool {
    true
}
fn default_cooldown_secs() -> u32 {
    60
}

/// 触发命中事件（broadcast → UI toast/铃）；SendKeys 动作另有审批卡事件流。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerEvent {
    pub sid: SessionId,
    pub rule_id: String,
    pub rule_name: String,
    /// `notify` | `send`
    pub action: String,
    /// 命中行摘录（≤160 字符，已剥离 ANSI）——toast 与审批卡的上下文。
    pub matched: String,
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
    /// R42（§6.7）**可用目的**：该会话当前的委托目标（人类写给 Agent 的任务留言），
    /// 作为审批时的意图上下文。None = 无法获知目的，UI 须明确显示缺失而不是留白
    /// （不得把未知解释成「无风险」）。读取时按会话**当前**目标投影，故目标后补也可见。
    #[serde(default)]
    pub purpose: Option<String>,
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
    /// R23（R21-L6 勘误闭环）：门挂起期间按主机精确判他机门（gatesBusy），
    /// 不再借 host_name 字符串匹配。serde default——旧事件消费方兼容。
    #[serde(default)]
    pub host_id: String,
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

/// 「批准并记住」的记忆范围（审批减摩擦①）：TTL=按卡上命令逐段**精确**记忆
/// （无通配，语义零漂移，到期自动失效）；Persistent=人类确认过的 pattern
/// （UI 预填可编辑，写 allow 规则）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RememberScope {
    Ttl { minutes: u32 },
    Persistent { pattern: String },
}

/// 自主模式授权视图（②）：expires_at=None=手动关闭前有效。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutonomyGrant {
    pub agent_id: AgentClientId,
    pub expires_at: Option<DateTime<Utc>>,
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
    /// C3（R24）：shell 集成显式开关。None=历史行/未设置（迁移前）；Some(v)=显式。
    /// 语义：false 不注入不等 OSC（DC3.2）；V6 迁移为存量 SSH 主机写 Some(true)。
    #[serde(default)]
    pub shell_integration: Option<bool>,
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
    /// 连接时经本机 ssh-agent 签名（unix=SSH_AUTH_SOCK；windows=OpenSSH 服务命名
    /// 管道 \\.\pipe\openssh-ssh-agent），私钥不出 agent。
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
    /// C3：None=编辑保原值/新建 false；Some(v)=显式设置（DC3.2，serde default 防旧客户端缺字段）。
    #[serde(default)]
    pub shell_integration: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub enum AuthDraft {
    /// 编辑主机时保持现有凭据（UI 不持明文，不能回传重发）；新建主机回落为无凭据占位
    /// （仅本机 PTY 的 local 主机使用，SSH 建连前必须改绑凭据）。
    #[default]
    #[serde(rename = "Keep")]
    None,
    Key {
        identity_id: IdentityId,
    },
    Password {
        password: String,
    },
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
/// C7（R22）：DF7.1 分级指令记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SshUnsupportedDirective {
    pub directive: String,
    pub level: SshUnsupportedLevel,
    pub line: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SshUnsupportedLevel {
    Blocking,
    Warning,
}

/// C7（R22）：导入跳过原因（DF7.3 默认跳过重复 / 阻断条目不可导入）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SshSkipReason {
    Duplicate,
    Blocked,
}

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
    // ---- C7（R22）增量，serde default 全量对旧消费方兼容 ----
    /// 来源文件（path 原文）
    #[serde(default)]
    pub source_file: String,
    /// Host 行行号（1 起）
    #[serde(default)]
    pub source_line: u32,
    /// DF7.1 分级：阻断 + 警告（忽略级不列）
    #[serde(default)]
    pub unsupported: Vec<SshUnsupportedDirective>,
    /// = 无阻断指令且已指定用户（DF7.5：无 User → false）
    #[serde(default = "crate::serde_true")]
    pub directly_importable: bool,
    /// DF7.5：false = 配置未写 User（username 为 $USER 兜底猜测，UI 显示「未指定
    /// 用户」并以空值进手工表单，不静默 root）
    #[serde(default = "crate::serde_true")]
    pub user_specified: bool,
}

/// 导入逐条结果（error 为 None 表示成功或跳过）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshImportOutcome {
    pub name: String,
    pub host_id: Option<HostId>,
    pub error: Option<String>,
    /// C7（R22）：跳过原因（host_id 为 None 且 error 为 None 时必有）
    #[serde(default)]
    pub skipped_reason: Option<SshSkipReason>,
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
    Generate {
        label: String,
        kind: KeyKind,
    },
    Import {
        label: String,
        pem: String,
        passphrase: Option<String>,
    },
    Password {
        label: String,
        password: String,
    },
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
    /// C3（R24）：shell 集成态（serde default 防旧消费方——DC3.5 Ready≠集成就绪，此为独立字段）。
    #[serde(default)]
    pub integration: IntegrationState,
    /// R42（§6.7）该会话是否**曾被 Agent 持有**过控制权：人类新建的会话恒 false，
    /// 由 Agent 建立、或人类委托/交还过之后为 true。UI 依此区分「首次委托（交给
    /// Agent）」与「曾被接管后交还（交还 Agent）」——两者是同一受控转换，仅入口措辞
    /// 不同。serde default：旧消费方缺省 false（保守侧，按首次委托处理）。
    #[serde(default)]
    pub ever_agent_owned: bool,
    /// 十八轮：会话日志记录中（落盘 tap 在 pump；路径不随列表下发——本地路径
    /// 只经开关命令的返回值/toast 呈现）。serde default 防旧载荷。
    #[serde(default)]
    pub logging: bool,
}

/// R41（§6.6/S09）连接详情：**连接当时**的完整身份快照 + 会话运行时态。
///
/// 与 `SessionInfo` 分开的理由：详情要展示地址/端口/用户/认证类型/指纹/编码，这些字段
/// 都在 `Host` 上；而主机配置在会话存续期内可被编辑或删除（§6.1「删除配置不停止已存在
/// 会话，在活动标签保留连接时的主机信息」）。故建会话时对 Host 取快照，**不能**在查看时
/// 按 host_id 回查当前配置——那会把「连接时的身份」换成「现在的配置」。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionDetail {
    pub id: SessionId,
    pub host_id: HostId,
    pub host_name: String,
    /// local | ssh
    pub kind: String,
    pub state: SessionState,
    pub control_owner: ControlOwner,
    /// 会话**真实创建时刻**（非查询时刻；R41 修 SessionInfo.created_at 的同源缺陷）。
    pub created_at: DateTime<Utc>,
    /// C3（R24）：shell 集成态（独立字段，Ready≠集成就绪）。
    #[serde(default)]
    pub integration: IntegrationState,
    // ---- 连接时身份快照 ----
    pub address: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    /// 连接时已信任的主机指纹；None = 首连确认前/未记录（不虚构）。
    pub fingerprint: Option<String>,
    pub charset: Charset,
}

/// C3：shell 集成态机（R24）。Disabled=host_setting 关（不注入）；Pending=已注入等标记；
/// Ready=集成标记在屏；Unavailable=注入后超时未见标记。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "PascalCase")]
pub enum IntegrationState {
    #[default]
    Disabled,
    Pending,
    Ready,
    Unavailable,
}

/// C3：shell 能力快照（DC3.3 只读查询；执行时入口重查不信任缓存）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ShellCapability {
    pub integration_present: bool,
    pub prompt_ready: bool,
    pub host_setting: bool,
}

/// C3 事件：shell-integration-event { session_id, state }（DC3.5 就绪独立事件）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellIntegrationEvent {
    pub session_id: SessionId,
    pub state: IntegrationState,
}

/// R26（§6.4）会话状态事件：断线/自动重连/重确认对 UI 的即时推送
/// （state 序列化串与 SessionInfo.state 同源；attempt/max_attempts 仅
/// Reconnecting 携带——「显示实际重试次数」的数据面）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionStateEvent {
    pub session_id: SessionId,
    pub state: SessionState,
    #[serde(default)]
    pub attempt: Option<u32>,
    #[serde(default)]
    pub max_attempts: Option<u32>,
    #[serde(default)]
    pub detail: Option<String>,
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
    Raw {
        sid: SessionId,
        seq: u64,
        data: Vec<u8>,
    },
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

/// C5（§6.5）传输生命周期。wire 形状与既有 UI 卡状态（PascalCase）一致。
/// R32 产生子集：Queued/Running/Cancelling/Succeeded/Failed/Cancelled；
/// R34（C6）起提交语义全量启用：Committing=提交窗口（journal 先行+发布原语）、
/// AwaitingDecision=冲突待人类裁决（仅人类路径）、OutcomeUnknown=发布应答丢失
/// 待证据复核、Skipped=冲突决定 skip 的终态（复审 H1）、Interrupted=重启恢复
/// 对提交前活动行的分类（§560 绝不虚构成败）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransferStatus {
    Queued,
    Running,
    Committing,
    Succeeded,
    Failed,
    Cancelled,
    Cancelling,
    AwaitingDecision,
    OutcomeUnknown,
    Skipped,
    Interrupted,
}

impl TransferStatus {
    /// 终态：不再变化，可安全从注册表归档（R32 不清_registry_，仅 journal 归档）。
    /// OutcomeUnknown 终态性=任务本身停止推进（复核只在其上出 Succeeded/保持未知，
    /// 无自动重发/覆盖/清理——C6）；Interrupted 终态性=重启恢复面定格，重试=新任务。
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            TransferStatus::Succeeded
                | TransferStatus::Failed
                | TransferStatus::Cancelled
                | TransferStatus::OutcomeUnknown
                | TransferStatus::Skipped
                | TransferStatus::Interrupted
        )
    }
}

/// C6（R34）冲突裁决。skip=不发布 temp 删除；overwrite=显式覆盖（受发布能力
/// 约束——能力不足 ReplaceUnsupported 阻止，不改动原目标）；keep-both=换名
/// name.tinyssh-N.ext 后按新文件发布（仅人类路径）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CollisionDecision {
    Skip,
    Overwrite,
    KeepBoth,
}

/// C6/R34：冲突询问载荷（仅 AwaitingDecision 态非空）。target_stat 为进入
/// 冲突时所见（复检不一致重回询问时刷新）；reason ∈ {"target_exists",
/// "stat_changed_since_preflight"}（C-04 原因可查落字段）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionPrompt {
    pub target_path: String,
    pub target_stat: Option<TargetStat>,
    pub reason: String,
}

/// C6/R34：冲突目标快照（存在性+size+mtime 三比对 DF6.3 的载体）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetStat {
    pub size: Option<u64>,
    pub mtime: Option<i64>,
}

/// C6/R34 DF6.1：发布原语四值结果（见 transport::ChannelHandle::publish_hardlink）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PublishOutcome {
    /// 链接已原子建立——本次发布确定提交。
    Committed,
    /// 能力未声明——按 ReplaceUnsupported 阻止发布。
    Unsupported,
    /// 确定未提交（含目标竞态已存在；链接失败绝不改动目标）。
    Rejected(String),
    /// 请求已发出、应答丢失——提交与否不可知，必须落 OutcomeUnknown。
    Ambiguous,
}

/// 本地文件系统命名空间的 stat/publish/remove 语义（rev-r34 高-1）：
/// 下载任务的预检/temp 核对/复检/发布/清理全部落在**本地**路径上——不得经
/// ChannelHandle（SSH 通路=远端 SFTP 语义）路由。这里提供唯一语义源，
/// transport-pty 的同名 trait 实现委托至此；core-session 下载分支直调。
pub fn local_stat_entry(path: &str) -> Result<EntryStat> {
    let lst = std::fs::symlink_metadata(path).map_err(|e| Error::from_fs_err(path, &e))?;
    let ft = lst.file_type();
    let kind = Some(if ft.is_dir() {
        EntryKind::Dir
    } else if ft.is_file() {
        EntryKind::File
    } else if ft.is_symlink() {
        EntryKind::Symlink
    } else {
        EntryKind::Other
    });
    let symlink_target = if ft.is_symlink() {
        std::fs::read_link(path)
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    } else {
        None
    };
    // 尺寸/目录位对 symlink 跟随目标（与 R30 sftp_stat 语义对齐）
    let md = if ft.is_symlink() {
        std::fs::metadata(path).unwrap_or(lst)
    } else {
        lst
    };
    Ok(EntryStat {
        canonical: std::fs::canonicalize(path)
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
        kind,
        is_dir: md.is_dir(),
        size: Some(md.len()),
        mtime: md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64),
        symlink_target,
    })
}

/// 本地 hardlink 原子发布：链接要么建立要么失败，绝不改动目标（无 Ambiguous——
/// 本地 syscall 无「应答丢失」形态）。
pub fn local_publish_hardlink(existing: &str, new: &str) -> PublishOutcome {
    match std::fs::hard_link(existing, new) {
        Ok(()) => PublishOutcome::Committed,
        Err(e) => PublishOutcome::Rejected(format!("{e}")),
    }
}

/// 本地文件删除（temp 清理；不存在=幂等 Ok）。
pub fn local_remove_file(path: &str) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Error::from_fs_err(path, &e)),
    }
}

/// C5（§547/§560）任务注册表行——查询与事件的统一载荷。
/// revision 单调递增（事件可合并，UI 按 id+revision 幂等对账；重挂后 list_transfers
/// 拿到的每行 revision 与事件流连续）。source/dest 与方向绑定：upload 为
/// source=本地 dest=远端；download 反之（与 TransferHandle.local/remote 语义一致）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferTask {
    pub id: TransferId,
    pub session_id: SessionId,
    pub kind: TransferKind,
    pub source: String,
    pub dest: String,
    pub status: TransferStatus,
    pub bytes_done: u64,
    /// 总字节数未知为 None（§352 不伪造；目录递归上传常未知）
    pub total: Option<u64>,
    pub revision: u64,
    /// Unix 秒
    pub created_at: i64,
    pub finished_at: Option<i64>,
    pub error: Option<String>,
    /// §6.5 重试链：本任务重试自哪个任务
    pub retry_of: Option<TransferId>,
    /// C6/R34：冲突裁决（决定提交后随任务留存）
    #[serde(default)]
    pub collision_decision: Option<CollisionDecision>,
    /// C6/R34：冲突询问（仅 AwaitingDecision 态非空）；serde default 兼容旧载荷
    #[serde(default)]
    pub decision_prompt: Option<DecisionPrompt>,
}

/// SFTP 条目类型（C4 §352）：符号链接/其他与普通文件/目录可区别；
/// None = 旧载荷或服务端未报类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Dir,
    File,
    Symlink,
    Other,
}

/// SFTP 目录条目（T41 FR-7 浏览器；C4 §352 R30 扩充）。wire 三端一致（Rust/UI/demo）：
/// transport 按名称排序（目录在前）返回，UI 直接渲染。
/// §352「未知大小/时间显示 —，不伪造零值」：size/mtime 为 Option——None=服务端未报，
/// UI 呈示「—」；is_dir 保留（消费方广，= kind==Dir；symlink 条目为 false，kind 区分）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntryS {
    pub name: String,
    pub is_dir: bool,
    /// 条目类型；None = 旧载荷（升级兼容）或服务端未报
    #[serde(default)]
    pub kind: Option<EntryKind>,
    /// 字节数；None = 未知（目录/服务端未报——不以 0 冒充）
    pub size: Option<u64>,
    /// Unix 秒；None = 未知
    pub mtime: Option<i64>,
}

/// C4（§546/§352）：路径解析结果——canonical path 由服务端 SFTP realpath 返回，
/// 前端不得字符串拼接猜测。path 省略时 = SFTP 会话初始目录（不靠 shell cwd）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathResolved {
    pub canonical: String,
}

/// C4（§546/§352）：单条目元数据。kind 取 lstat 语义（符号链接本身→Symlink）；
/// canonical 为 realpath 跟随结果——canonicalize 失败（如严格实现上的悬空链接）
/// 时为 None（可解释，不猜路径；OpenSSH 宽容 realpath 则返回归一化目标路径——
/// 服务端依赖，前端两态同待）；symlink_target 仅 lstat 为 Symlink 时尝试 read_link，
/// 非链接或读取失败为 None。size/mtime 跟随 stat（follow）；follow 失败（悬空）
/// 回落 lstat 值。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntryStat {
    pub canonical: Option<String>,
    pub kind: Option<EntryKind>,
    /// stat（follow）语义：是否目录
    pub is_dir: bool,
    pub size: Option<u64>,
    pub mtime: Option<i64>,
    pub symlink_target: Option<String>,
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
    /// R41（§6.6「可筛人类/Agent」）：按 `actor_kind` 过滤（"human" | "agent"）。
    /// 与 `agent_id` 正交：后者定位**某个** Agent，前者只分「人类 / Agent」两类；
    /// 未知值不匹配任何行（如实返回空，不静默降级为「不过滤」）。
    pub actor_kind: Option<String>,
    pub action: Option<String>,
    /// R41（「记录连续」）：按 seq 游标翻页——只取 `seq < before_seq` 的记录。
    /// 用 offset 分页会在新事件入链后错位/重复，seq 是主键自增，游标才连续。
    pub before_seq: Option<i64>,
    /// rev-r46：反方向游标——只取 `seq > after_seq` 的记录（跟随新事件，如等
    /// 审批时轮询增量）。与 before_seq 同为翻页游标，不计入 total。
    pub after_seq: Option<i64>,
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
    /// C3（R24）：无 shell 集成主机拒绝 Shell 模式执行（副作用前；禁止自动 Fresh 降级）。
    #[error(
        "该主机未启用 shell 集成，Shell 模式不可用——可显式指定 Fresh 模式执行（不继承终端现场）"
    )]
    ShellIntegrationUnavailable { available: ShellCapability },
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
    /// C4（R30）：远端路径不存在（SFTP NO_SUCH_FILE——与权限拒绝可区别）。
    #[error("远端路径不存在: {path}")]
    SftpPathNotFound { path: String },
    /// C4（R30）：远端路径权限不足（SFTP PERMISSION_DENIED）。
    #[error("权限不足: {path}")]
    SftpPermissionDenied { path: String },
    /// C6/R34：预检发现同名目标（Agent 路径缺省 fail；含目标 stat 供结构化对账）。
    #[error("目标已存在（冲突未裁决）: {target_path}")]
    ConflictDetected {
        target_path: String,
        target_stat: Option<TargetStat>,
    },
    /// C6/R34 DF6.1：发布能力不足阻止发布（不改动原目标、无降级/回滚）。
    /// capability ∈ {"hardlink@openssh.com", "target_version_constraint"}。
    #[error("发布能力不足，已阻止（原目标未改动）: {capability}")]
    ReplaceUnsupported { capability: String },
    /// C5/R34：决定提交乐观锁失配——expect_revision=注册表当前 revision
    ///（调用方以此重同步；任务未因本次提交推进）。
    #[error("决定已过期（任务 revision 已推进至 {expect_revision}）")]
    StaleDecision { expect_revision: u64 },
    /// C5/R34：非法状态下的决定提交（非 AwaitingDecision / Agent 任务）。
    #[error("传输状态不允许该决定（task={task_id}, state={state:?}）")]
    InvalidTransferState {
        task_id: TransferId,
        state: TransferStatus,
    },
    /// R40（§6.6/D02）：转发监听建立失败——`field` 把错误定位到表单字段
    /// （"listen"=监听地址/端口，含端口占用与非法地址；"target"=目标侧），
    /// 供 FE 就地高亮对应输入而非只弹通用提示。
    #[error("转发监听失败（{field}）：{reason}")]
    ForwardListenFailed { field: String, reason: String },
    /// C9/R43：协作服务已停用（admission 关闭）——拒绝新的 Agent 请求。
    /// 与 `ControlTakenByHuman` 区分：这是**服务级**封禁，非某会话控制权变更。
    #[error("协作服务已停用，拒绝新的 Agent 请求——请在「设置 → Agent 接入」显式重新启用")]
    CollabDisabled,
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
            E::ShellIntegrationUnavailable { available } => (
                "shell_integration_unavailable",
                Some(serde_json::json!({ "available": available })),
            ),
            E::Cancelled => ("cancelled", None),
            E::QueueBusy { position } => (
                "queue_busy",
                Some(serde_json::json!({ "position": position })),
            ),
            E::InvalidActor => ("invalid_actor", None),
            E::InvalidInput(_) => ("invalid_input", None),
            E::IdentityInUse { host_names } => (
                "identity_in_use",
                Some(serde_json::json!({ "host_names": host_names })),
            ),
            E::Storage(_) => ("storage", None),
            E::Io(_) => ("io", None),
            E::SftpPathNotFound { path } => (
                "sftp_path_not_found",
                Some(serde_json::json!({ "path": path })),
            ),
            E::SftpPermissionDenied { path } => (
                "sftp_permission_denied",
                Some(serde_json::json!({ "path": path })),
            ),
            E::ConflictDetected {
                target_path,
                target_stat,
            } => (
                "conflict_detected",
                Some(serde_json::json!({
                    "target_path": target_path,
                    "target_stat": target_stat,
                })),
            ),
            E::ReplaceUnsupported { capability } => (
                "replace_unsupported",
                Some(serde_json::json!({ "capability": capability })),
            ),
            E::StaleDecision { expect_revision } => (
                "stale_decision",
                Some(serde_json::json!({ "expect_revision": expect_revision })),
            ),
            E::InvalidTransferState { task_id, state } => (
                "invalid_transfer_state",
                Some(serde_json::json!({ "task_id": task_id, "state": state })),
            ),
            E::ForwardListenFailed { field, reason } => (
                "forward_listen_failed",
                Some(serde_json::json!({ "field": field, "reason": reason })),
            ),
            E::CollabDisabled => ("collab_disabled", None),
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

    /// C4（R30）：fs 层错误 → 可区别错误（不存在/权限不足 → 专用变体，前端按
    /// kind 呈现可解释信息而非猜路径）。SFTP 与本地 fs 两个 transport 共用。
    pub fn from_fs_err(path: &str, e: &std::io::Error) -> Error {
        match e.kind() {
            std::io::ErrorKind::NotFound => Error::SftpPathNotFound { path: path.into() },
            std::io::ErrorKind::PermissionDenied => {
                Error::SftpPermissionDenied { path: path.into() }
            }
            _ => Error::Io(format!("{path}: {e}")),
        }
    }
}

// ---------------------------------------------------------------------------
// C8 偏好与主机元数据（实现 R15；消费 R20/R27/R44）
// ---------------------------------------------------------------------------

/// 应用工作区偏好（DF8.1）：`ui.v2.workspace` 单键 JSON blob，整取整存原子写。
/// 不含秘密/终端输出/会话目标；schemaVersion 前向演进（R44 升级演练据此定路径）。
/// 终端配色四预设仍在 `ui.theme` 键（值不变）；chrome 是应用外观（R27 起
/// system|dark|light 三态，与终端配色解耦；V5 迁移写 dark|light 映射值）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    pub schema_version: u32,
    /// 应用外观：system | dark | light（§7.1 新装默认跟随系统；旧值 dark|light 兼容）
    #[serde(default = "default_chrome")]
    pub chrome: String,
    /// 主机栏开合与宽度（§4.2；R12 的浏览器 localStorage 暂存迁入；None = 尚未写入）
    #[serde(default)]
    pub hostbar: Option<HostbarPrefs>,
    /// 终端偏好（R25 §318；None = 尚未写入，消费方按全默认解释）
    #[serde(default)]
    pub terminal: Option<TerminalPrefs>,
    /// 传输偏好（R33 §355；None = 尚未写入，下载落系统默认目录）
    #[serde(default)]
    pub transfers: Option<TransferPrefs>,
    /// 会话域（十五轮）：「重连上次会话」主机清单；None = 尚未写入
    #[serde(default)]
    pub sessions: Option<SessionPrefs>,
}

/// 终端偏好（§318）：粘贴保护默认开；选中即复制/响铃通知默认关（十五/十六轮）；
/// osc52 = 远端写剪贴板策略（P2-c，String 枚举：allow/ask/deny，消费方按缺省 ask 解释）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalPrefs {
    /// 多行粘贴保护：内容含换行且远端未开 bracketed paste 时预览确认后才发送
    #[serde(default = "serde_true")]
    pub paste_guard: bool,
    /// 选中即复制（十五轮，PuTTY/Xshell 惯例）：划选非空立即写系统剪贴板
    #[serde(default)]
    pub copy_on_select: bool,
    /// 终端响铃（BEL）且窗口失焦时发系统通知（十六轮，默认关）
    #[serde(default)]
    pub bell_notify: bool,
    /// 远端写剪贴板策略（P2-c）：allow/ask/deny；缺省或未知值由消费方按 ask 解释
    #[serde(default)]
    pub osc52: String,
}

/// 会话域（十五轮）：欢迎页「重连上次会话」的记忆
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionPrefs {
    /// 上次运行仍打开会话的主机 ID（去重、按标签序）；空 = 上次全部关闭
    #[serde(default)]
    pub last: Vec<String>,
}

fn default_chrome() -> String {
    "system".into()
}

/// 传输偏好（R33 §355）：下载默认目录记忆（首次=系统 Downloads；另存为后更新）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferPrefs {
    /// 上次下载目录（本地绝对路径；None = 未记忆，落系统默认）
    #[serde(default)]
    pub download_dir: Option<String>,
}

/// C7 增量字段的兼容默认（旧消费方反序列化旧载荷 = 可导入）
pub fn serde_true() -> bool {
    true
}

impl Default for Workspace {
    fn default() -> Self {
        Workspace {
            schema_version: 1,
            chrome: default_chrome(),
            hostbar: None,
            terminal: None,
            transfers: None,
            sessions: None,
        }
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
// C9 协作启用生命周期（实现 R43；消费 R42/R44）
// ---------------------------------------------------------------------------

/// C9：协作服务状态机。**admission 门**只在 `Enabled` 开放——其余三态（含
/// `Disabling`/`DisableFailed`）一律拒绝新的 Agent 请求（人类不受影响）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CollabState {
    /// 已启用：admission 开放，Agent 请求可进入原有审批/控制权流程。
    Enabled,
    /// 停用中：已封 admission，正在收敛存量（作废未开始请求、转回会话控制权、停端点）。
    Disabling,
    /// 已停用：admission 已关闭 **且** 应用拥有的 MCP 端点已停止（两层均确认）。
    Disabled,
    /// 停用失败：收敛未完成（如端点停止失败）。admission 继续关闭，允许重试。
    DisableFailed,
}

/// C9：协作服务状态快照。区分「已配置」（登记了 Agent 身份）与「有活动请求」
/// （待审批或 Agent 持有会话）——仅有登记身份不等于 Agent 在线。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CollabStatus {
    pub state: CollabState,
    /// 停用代次：每次停用递增。执行开始前核对代次，旧代次请求作废（不因旧审批继续）。
    pub generation: u64,
    /// 已配置 Agent 数（vault 中未撤销的登记身份）。
    pub configured_agents: usize,
    /// 有活动请求数（待审批 + Agent 持有控制权的会话）。
    pub active_requests: usize,
    /// 应用拥有的 MCP 端点地址；空串 = 未启动。
    pub endpoint: String,
}

/// C9：停用影响预览（用户确认前展示）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisableImpact {
    /// 当前由 Agent 持有控制权的会话数（停用将转回 Human）。
    pub agent_owned_sessions: usize,
    /// 待审批请求数（停用将作废）。
    pub pending_approvals: usize,
    /// 已配置 Agent 数。
    pub configured_agents: usize,
}

/// C9：停用确认后的收敛报告。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct DisableReport {
    /// 作废的待审批请求数（留痕，不可复活）。
    pub voided_approvals: usize,
    /// 转回 Human 的会话数（不自动终止已开始任务）。
    pub converted_sessions: usize,
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
    /// R41（§6.6/S09）：连接详情——连接时身份快照 + 运行时态。未注册会话 → SessionNotFound。
    async fn session_detail(&self, ctx: &Actor, sid: SessionId) -> Result<SessionDetail>;
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
    /// 十七轮「快速连接」：不落 vault 直接建连——主机与凭据仅存内存（应用退出即失），
    /// TOFU 信任同样只在内存（快速连接不记忆信任）。主机列表/最近连接不出现该目标。
    /// 仅 Human 可调（Agent 走已存主机的审计路径）；id 分配 `quick-` 前缀。
    async fn begin_connection_draft(
        &self,
        ctx: &Actor,
        draft: HostDraft,
        opts: BeginConnectionOpts,
    ) -> Result<AttemptInfo>;
    /// attempt 快照查询；终态后恒返回终态（不设历史查询——DC1）。
    async fn connection_status(&self, ctx: &Actor, attempt_id: AttemptId) -> Result<AttemptInfo>;
    /// 十八轮：会话日志开关。开启=在 data_dir/logs 建 `<主机>_<时间戳>.log` 追加
    /// （pump tap 写解码后 UTF-8），返回日志路径；关闭=落盘收口并冲刷，返回 None。
    /// 未注册会话 → SessionNotFound。
    async fn set_session_logging(
        &self,
        ctx: &Actor,
        sid: SessionId,
        enabled: bool,
    ) -> Result<Option<String>>;
    /// 十八轮：查询会话日志路径（未开启 → None）。供「打开日志文件夹」。
    async fn session_log_path(&self, ctx: &Actor, sid: SessionId) -> Result<Option<String>>;
    /// 取消建连。Cancelled=受理（终态以事件为准）；AlreadyReady/CancelCloseFailed=
    /// 竞态窗口结算；NotFound=已投递/已终态/不存在/跨 Actor 身份域。
    async fn cancel_connection(&self, ctx: &Actor, attempt_id: AttemptId) -> Result<CancelOutcome>;
    /// connection-event 广播（沿 approval-event 桥模式）。
    fn subscribe_connections(&self) -> broadcast::Receiver<ConnectionEvent>;

    /// C3（R24）：shell 集成态事件（Ready/Unavailable 流转；DC3.5 独立事件）。
    fn subscribe_shell_integration(&self) -> broadcast::Receiver<ShellIntegrationEvent>;

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
    /// 五轮架构（FE 尺寸对账看门狗）：PTY 宽高轻探针。UI 每 3s 校正 xterm↔PTY
    /// 尺寸失配，此前误用 read_screen——每 pane 每 3s 序列化整屏网格只为读
    /// cols/rows 两个数。默认不支持（mock/无终端实现不必陪跑）；真实实现覆盖。
    async fn pty_size(&self, _ctx: &Actor, _sid: SessionId) -> Result<(u16, u16)> {
        Err(Error::InvalidInput(
            "pty_size: not supported by this backend".into(),
        ))
    }
    async fn send_keys(&self, ctx: &Actor, sid: SessionId, keys: &str) -> Result<()>;
    async fn wait_output(&self, ctx: &Actor, sid: SessionId, opts: WaitOpts)
        -> Result<OutputChunk>;
    async fn set_control(
        &self,
        ctx: &Actor,
        sid: SessionId,
        owner: ControlOwner,
        opts: ControlOpts,
    ) -> Result<TakeoverReport>;

    /// C2（R24）：首次委托——人类把会话交 Agent 执行并附目标（DC2.2 独立于裸 set_control，
    /// 承载确认语义与 session_delegated 审计）。仅 Human 可调。
    async fn delegate_session(
        &self,
        ctx: &Actor,
        sid: SessionId,
        goal: Option<String>,
    ) -> Result<()>;

    /// C3（R24）：shell 能力只读查询（DC3.3 任何 Actor 可查；执行时入口另重查）。
    async fn shell_capability(&self, ctx: &Actor, sid: SessionId) -> Result<ShellCapability>;

    // ---- 传输（v1；PRD FR-7）----
    /// collision（C6/R34 DF6.2）：Agent 预冲突处置——None=人类路径（冲突进
    /// AwaitingDecision）；Some(skip/overwrite/fail 等价 None 之外的显式处置)
    /// 仅 Agent 传（fail 缺省在 MCP 侧落地为 None→按 fail 结构化报错；此处
    /// Some(Skip)/Some(Overwrite) 为显式裁决）。人类 UI 一律传 None。
    async fn upload(
        &self,
        ctx: &Actor,
        sid: SessionId,
        local: &std::path::Path,
        remote: &str,
        collision: Option<CollisionDecision>,
    ) -> Result<TransferHandle>;
    async fn download(
        &self,
        ctx: &Actor,
        sid: SessionId,
        remote: &str,
        local: &std::path::Path,
        collision: Option<CollisionDecision>,
    ) -> Result<TransferHandle>;
    async fn cancel_transfer(&self, ctx: &Actor, t: TransferId) -> Result<()>;

    /// C6/R34：冲突裁决提交（仅人类 UI；仅 AwaitingDecision 可调）。
    /// expect_revision 乐观锁：不匹配 → StaleDecision{当前 revision}；
    /// 非法状态 → InvalidTransferState。生效 = 冲突通道投递决定，任务按
    /// 唯一发布决策表推进（revision +1，事件帧随之）。
    async fn submit_collision_decision(
        &self,
        ctx: &Actor,
        task_id: TransferId,
        decision: CollisionDecision,
        expect_revision: u64,
    ) -> Result<TransferTask>;

    /// C5/R34：人类 UI 显式作废过期决策卡。任务在 AwaitingDecision → 作废为
    /// Cancelled（temp 清理+审计 transfer_decision_rejected）；否则幂等 no-op。
    async fn reject_expired_decision(&self, ctx: &Actor, task_id: TransferId) -> Result<()>;

    /// C6/R34：OutcomeUnknown 复核（仅人类 UI）。只有 journal 证据（verified
    /// 标记）能绑定本次发布 → Succeeded{verified}；无绑定证据保持 OutcomeUnknown
    ///（同大小/temp 消失/摘要等单独不足——契约明文）。不自动重发/覆盖/清理。
    async fn verify_transfer_outcome(
        &self,
        ctx: &Actor,
        task_id: TransferId,
    ) -> Result<TransferTask>;

    /// C5（§547）：任务注册表查询——全量快照（新建时间倒序），UI 重挂后对账与
    /// 事件漏收兜底（事件可合并可丢失，查询是权威）。任何 Actor 可查（只读）。
    async fn list_transfers(&self, ctx: &Actor) -> Result<Vec<TransferTask>>;

    /// C5/R35 失败重试（§364）：以原参数创建新任务（retry_of=旧任务），重新
    /// 校验连接、源文件与冲突；不承诺断点续传，不自动重试已授权覆盖（重试
    /// 不携带 collision）。仅 Failed/Cancelled/Skipped/Interrupted 可重试；
    /// OutcomeUnknown 只能 verify_transfer_outcome 重新核实（§374）。
    async fn retry_transfer(&self, ctx: &Actor, task_id: TransferId) -> Result<TransferHandle>;

    /// 人类浏览远端目录（FR-7 SFTP 浏览器，只读）。path 为绝对路径；
    /// 条目按名称排序（目录在前）由 transport 层保证。
    async fn sftp_list(&self, ctx: &Actor, sid: SessionId, path: &str) -> Result<Vec<DirEntryS>>;

    /// C4（R30）：路径解析——canonical path 经 SFTP realpath（§352 不靠 shell 拼
    /// 命令、前端不猜）。path=None 时返回 SFTP 会话初始目录。不存在/权限可区别
    /// （SftpPathNotFound/SftpPermissionDenied）。只读、Human 浏览口径（同 sftp_list）。
    async fn sftp_resolve_path(
        &self,
        ctx: &Actor,
        sid: SessionId,
        path: Option<String>,
    ) -> Result<PathResolved>;

    /// C4（R30）：单条目元数据（类型/大小/时间/符号链接目标，未知字段为 None）。
    /// 只读、Human 浏览口径（同 sftp_list）。
    async fn sftp_stat(&self, ctx: &Actor, sid: SessionId, path: String) -> Result<EntryStat>;

    // ---- 端口转发（FR-8，T42）----
    /// 列出会话的转发（任何 Actor 可查——PRD「MCP 可查询状态」口径）。
    async fn list_forwards(&self, ctx: &Actor, sid: SessionId) -> Result<Vec<ForwardInfo>>;
    /// 创建并启动转发。人类直建；Agent 创建需授权——审批版留 V1/MCP 侧（当前无 Agent 入口）。
    async fn start_forward(
        &self,
        ctx: &Actor,
        sid: SessionId,
        spec: ForwardSpec,
    ) -> Result<ForwardId>;
    async fn stop_forward(&self, ctx: &Actor, sid: SessionId, fid: ForwardId) -> Result<()>;
    /// 转发状态变化事件（T44 真机冒烟补口）：start/stop/Degraded/恢复/Failed
    /// 状态写口广播——UI 事件驱动刷新转发面板，替代纯盲轮询。
    fn subscribe_forwards(&self) -> broadcast::Receiver<ForwardEvent>;

    // ---- 审批（v1 读取路径；PRD FR-4）----
    async fn list_approvals(&self, ctx: &Actor, f: ApprovalFilter) -> Result<Vec<ApprovalItem>>;
    fn subscribe_approvals(&self) -> broadcast::Receiver<ApprovalEvent>;
    async fn decide_approval(&self, ctx: &Actor, id: ApprovalId, d: Decision) -> Result<()>;
    /// 「批准并记住」（审批减摩擦①）：为审批卡写放行策略（vault 单一事实源，
    /// 下次 exec 自动刷新进引擎），随后人类再走常规 decide。只写策略、不动卡——
    /// 记忆失败不阻断批准，批准失败（如已作废）也不回滚已写的规则（规则对未来有益）。
    /// 返回实际写入的 pattern 列表（UI 可提示）。
    async fn remember_approval(
        &self,
        ctx: &Actor,
        id: ApprovalId,
        scope: RememberScope,
    ) -> Result<Vec<String>>;
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
    // ---- 执行记录（③ 时间线/自查：结构化、带输出摘录；与审计互补）----
    /// Agent 只能查**自己**的记录（强制 agent_id 过滤）；人类查全部。
    async fn query_records(
        &self,
        ctx: &Actor,
        f: tinyssh_records::RecordFilter,
    ) -> Result<Vec<tinyssh_records::RecordEvent>>;
    /// 导出明文 JSONL（人类专属——记录整体是敏感数据）。
    async fn export_records(
        &self,
        ctx: &Actor,
        f: tinyssh_records::RecordFilter,
        to: &std::path::Path,
    ) -> Result<u64>;

    // ---- 自主模式（② 审批减摩擦的延伸：事前拦截 → 事后全量记录）----
    /// 按 Agent 开/关自主模式（人类专属）。开启后该 Agent 的 exec 跳过逐条审批
    /// （内置 deny 名单仍硬拦；传输仍逐条审批；记录/审计照常）。`ttl_minutes`
    /// 为 Some 时到期自动失效（1..=1440）；None=手动关闭前一直有效。
    /// **授权只存内存**：应用重启即回审批模式（保守侧，失败安全）。
    async fn set_autonomy(
        &self,
        ctx: &Actor,
        agent_id: AgentClientId,
        enable: bool,
        ttl_minutes: Option<u32>,
    ) -> Result<()>;
    /// 自主模式状态（横幅/设置页）；Agent 可查自己，人类查全部。
    async fn autonomy_list(&self, ctx: &Actor) -> Result<Vec<AutonomyGrant>>;
    async fn export_audit(&self, ctx: &Actor, f: AuditFilter, to: &std::path::Path) -> Result<()>;

    // ---- 现场简报（v1；交接核心工件，PRD FR-3/FR-6）----
    async fn get_session_brief(&self, ctx: &Actor, sid: SessionId) -> Result<SessionBrief>;

    /// FR-10 V2（P1-b）：命令块查询——最近 `limit` 条（1..=200 截断），旧→新序。
    /// 人类与 Agent 同权只读（与简报同口径，交接引用块的数据面）；不产生副作用、
    /// 不进审计。数据唯一事实源在 term-core BlockIndex，这里只是投影。
    async fn read_blocks(&self, ctx: &Actor, sid: SessionId, limit: u32) -> Result<Vec<BlockInfo>>;

    /// P2-b 输出触发器：读取规则。**人类专属**——规则可自动请求键序发送，
    /// Agent 无读写 API（不让 Agent 自己写自动化入口）。
    async fn read_triggers(&self, ctx: &Actor) -> Result<Vec<TriggerRule>>;

    /// P2-b 输出触发器：整卡保存。校验+归一（补 id / 冷却 clamp / 上限）→ 持久化
    /// → 引擎热更快照；返回归一后的规则（UI 以此回显真实生效值）。
    async fn save_triggers(&self, ctx: &Actor, rules: Vec<TriggerRule>)
        -> Result<Vec<TriggerRule>>;

    /// 设定会话任务目标/交接留言（R9：人类→Agent 委托入口；None=清除，仅人类）。
    /// Agent 经 get_session_brief 的 goal 字段读取；设定/清除全程审计留痕。
    async fn set_session_goal(
        &self,
        ctx: &Actor,
        sid: SessionId,
        goal: Option<String>,
    ) -> Result<()>;

    // ---- C9 协作启用生命周期（R43；人类专属）----
    /// 协作服务状态（状态机 + 已配置 Agent 数 + 有活动请求数 + 端点地址）。
    async fn collab_status(&self, ctx: &Actor) -> Result<CollabStatus>;
    /// 停用影响预览（确认前展示：Agent 持有会话数 / 待审批数 / 已配置 Agent 数）。
    async fn collab_disable_preview(&self, ctx: &Actor) -> Result<DisableImpact>;
    /// 确认停用：**原子**进入 Disabling 并立即封 admission（拒绝所有新 Agent 请求），
    /// 作废交接前未开始的请求（留痕、不可复活），把所有 Agent 持有会话转回 Human
    /// （**不**自动终止已开始任务）。返回收敛报告；端点停止由外层完成后再转 Disabled。
    async fn collab_disable(&self, ctx: &Actor) -> Result<DisableReport>;
    /// 端点已停止确认 → Disabled（admission 已关闭 + 端点已停止两条件齐备才显示已停用）。
    async fn collab_mark_endpoint_stopped(&self, ctx: &Actor) -> Result<()>;
    /// 端点停止失败 → DisableFailed（admission 继续关闭，允许重试）。
    async fn collab_mark_disable_failed(&self, ctx: &Actor, reason: String) -> Result<()>;
    /// 显式重新启用：仅当旧停用处理已收敛（Disabled/DisableFailed）方可重开 gate，
    /// 递增代次（先前作废请求不复活）。
    async fn collab_enable(&self, ctx: &Actor) -> Result<()>;

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
        assert_eq!(
            serde_json::to_value(ApprovalStatus::Pending).unwrap(),
            "Pending"
        );
        assert_eq!(
            serde_json::to_value(ApprovalStatus::Approved).unwrap(),
            "Approved"
        );
        assert_eq!(
            serde_json::to_value(ApprovalStatus::ApprovedEdited).unwrap(),
            "ApprovedEdited"
        );
        assert_eq!(
            serde_json::to_value(ApprovalStatus::Denied).unwrap(),
            "Denied"
        );
        assert_eq!(
            serde_json::to_value(ApprovalStatus::Timeout).unwrap(),
            "Timeout"
        );
        assert_eq!(
            serde_json::to_value(ApprovalStatus::Voided).unwrap(),
            "Voided"
        );
    }

    /// 锁定 ApprovalItem.editable 的线上行为（T44 复核中-2）：字段随卡下发；
    /// 旧持久化行/旧前端载荷缺失该字段时缺省 false（不可编辑，保守侧）。
    /// UI 隐藏编辑钮依赖此字段——后端声明可编辑性，UI 不从 command 文本猜。
    #[test]
    fn approval_item_editable_field_wire_behavior() {
        let item = ApprovalItem {
            id: "a-1".into(),
            session_id: "s-1".into(),
            agent_id: "opencode".into(),
            command: "ls".into(),
            edited_command: None,
            target_summary: String::new(),
            segment_report: vec![],
            session_busy: false,
            editable: true,
            created_at: DateTime::parse_from_rfc3339("1970-01-01T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
            status: ApprovalStatus::Pending,
            attempt_id: None,
            purpose: None,
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

    /// 锁定 R42（§6.7）新增字段的线上行为：
    /// - `ApprovalItem.purpose`：随卡下发；旧载荷缺失 → None（「无法获知目的」，UI 明示缺失）。
    /// - `SessionInfo.ever_agent_owned`：随会话下发；旧载荷缺失 → false（按首次委托处理）。
    #[test]
    fn r42_purpose_and_ever_agent_owned_wire_compat() {
        let item = ApprovalItem {
            id: "a-1".into(),
            session_id: "s-1".into(),
            agent_id: "opencode".into(),
            command: "ls".into(),
            edited_command: None,
            target_summary: "读取目录".into(),
            segment_report: vec![],
            session_busy: false,
            editable: false,
            created_at: DateTime::parse_from_rfc3339("1970-01-01T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
            status: ApprovalStatus::Pending,
            attempt_id: None,
            purpose: Some("把日志打包放到 /tmp".into()),
        };
        let v = serde_json::to_value(&item).unwrap();
        assert_eq!(v["purpose"], "把日志打包放到 /tmp");
        // 旧载荷无 purpose → None（不得反序列化失败，也不得编造目的）
        let legacy = serde_json::json!({
            "id": "a-1", "session_id": "s-1", "agent_id": "opencode",
            "command": "ls", "edited_command": null, "target_summary": "",
            "segment_report": [], "session_busy": false,
            "created_at": "1970-01-01T00:00:00Z", "status": "Pending",
        });
        let old: ApprovalItem = serde_json::from_value(legacy).unwrap();
        assert!(old.purpose.is_none());

        // SessionInfo：缺省 false（旧消费方按「首次委托」措辞）
        let s: SessionInfo = serde_json::from_value(serde_json::json!({
            "id": "s-1", "host_id": "h-1", "host_name": "prod-1", "kind": "ssh",
            "state": "Connected", "control_owner": "Human",
            "created_at": "1970-01-01T00:00:00Z",
        }))
        .unwrap();
        assert!(!s.ever_agent_owned);
        let v = serde_json::to_value(SessionInfo {
            ever_agent_owned: true,
            ..s
        })
        .unwrap();
        assert_eq!(v["ever_agent_owned"], true);
    }

    /// 锁定 Workspace.transfers 域的兼容行为（R33 §355）：旧 blob（R25/R27/R31
    /// 写入，无 transfers 字段）反序列化 = None（下载落系统默认目录）；新载荷
    /// round-trip 保形——download_dir 缺失时 TransferPrefs 本身也要能反序列化
    ///（write-through 域：set_workspace 整取整存，部分域写入不虚构其他域默认值）。
    #[test]
    fn workspace_transfers_field_wire_compat() {
        // 旧载荷：chrome+hostbar 时代 / terminal 时代 blob 均无 transfers
        let legacy: Workspace = serde_json::from_value(serde_json::json!({
            "schema_version": 1, "chrome": "dark", "hostbar": { "open": true, "width": 224 }
        }))
        .unwrap();
        assert!(legacy.transfers.is_none());
        assert!(legacy.sessions.is_none());
        // 新载荷 round-trip
        let ws = Workspace {
            schema_version: 1,
            chrome: "system".into(),
            hostbar: None,
            terminal: None,
            transfers: Some(TransferPrefs {
                download_dir: Some("/Users/demo/Downloads".into()),
            }),
            sessions: None,
        };
        let v = serde_json::to_value(&ws).unwrap();
        assert_eq!(v["transfers"]["download_dir"], "/Users/demo/Downloads");
        let back: Workspace = serde_json::from_value(v).unwrap();
        assert_eq!(back, ws);
        // 十五轮：sessions 域 round-trip（未知主机容忍，Vec 原样保序）
        let r15: Workspace = serde_json::from_value(serde_json::json!({
            "schema_version": 1, "chrome": "system", "sessions": { "last": ["local", "h-prod1"] }
        }))
        .unwrap();
        assert_eq!(
            r15.sessions.as_ref().unwrap().last,
            vec!["local".to_string(), "h-prod1".to_string()]
        );
        // 旧载荷无 sessions / terminal 无 copy_on_select、bell_notify → 按缺省解释（None/false）
        let old_term: Workspace = serde_json::from_value(serde_json::json!({
            "schema_version": 1, "chrome": "system", "terminal": { "paste_guard": true }
        }))
        .unwrap();
        assert_eq!(old_term.terminal.unwrap().copy_on_select, false);
        // 十六轮：bell_notify round-trip（旧载荷缺键 = false）
        let r16: Workspace = serde_json::from_value(serde_json::json!({
            "schema_version": 1, "chrome": "system", "terminal": { "paste_guard": true, "bell_notify": true }
        })).unwrap();
        assert_eq!(r16.terminal.as_ref().unwrap().bell_notify, true);
        let serialized = serde_json::to_value(&r16).unwrap();
        assert_eq!(serialized["terminal"]["bell_notify"], true);
        // P2-c：osc52 round-trip（旧载荷缺键 = ""，消费方按 ask 解释；值原样透传不校验——
        // 校验在 UI 载入处做，这里只保证 round-trip 不丢键）
        let pc: Workspace = serde_json::from_value(serde_json::json!({
            "schema_version": 1, "chrome": "system", "terminal": { "paste_guard": true, "osc52": "deny" }
        })).unwrap();
        assert_eq!(pc.terminal.as_ref().unwrap().osc52, "deny");
        assert_eq!(
            serde_json::to_value(&pc).unwrap()["terminal"]["osc52"],
            "deny"
        );
        let old52: Workspace = serde_json::from_value(serde_json::json!({
            "schema_version": 1, "chrome": "system", "terminal": { "paste_guard": true }
        }))
        .unwrap();
        assert_eq!(old52.terminal.as_ref().unwrap().osc52, "");
        // transfers 域对象存在但 download_dir 未写入 → None（不虚构默认值）
        let partial: Workspace = serde_json::from_value(serde_json::json!({
            "schema_version": 1, "chrome": "system", "transfers": {}
        }))
        .unwrap();
        assert_eq!(
            partial
                .transfers
                .as_ref()
                .and_then(|t| t.download_dir.clone()),
            None
        );
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
        }))
        .unwrap();
        assert_eq!(draft.charset, Charset::Utf8);
        let draft: HostDraft = serde_json::from_value(serde_json::json!({
            "id": null, "name": "n", "address": "a", "port": 22, "username": "u",
            "auth": { "Password": { "password": "p" } }, "tags": [],
            "charset": "gbk",
        }))
        .unwrap();
        assert_eq!(draft.charset, Charset::Gbk);
        // 缺省：老客户端不带 charset 字段
        let draft: HostDraft = serde_json::from_value(serde_json::json!({
            "id": null, "name": "n", "address": "a", "port": 22, "username": "u",
            "auth": { "Password": { "password": "p" } }, "tags": [],
        }))
        .unwrap();
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
            serde_json::to_value(IdentityReq::Generate {
                label: "k".into(),
                kind: KeyKind::Ed25519
            })
            .unwrap(),
            serde_json::json!({ "Generate": { "label": "k", "kind": "Ed25519" } })
        );
        assert_eq!(
            serde_json::to_value(IdentityReq::Import {
                label: "k".into(),
                pem: "PEM".into(),
                passphrase: None
            })
            .unwrap(),
            serde_json::json!({ "Import": { "label": "k", "pem": "PEM", "passphrase": null } })
        );
        // UI upsert_host 的三种 auth 载荷形态
        let draft: HostDraft = serde_json::from_value(serde_json::json!({
            "id": null, "name": "n", "address": "a", "port": 22, "username": "u",
            "auth": "Agent", "tags": [],
        }))
        .unwrap();
        assert!(matches!(draft.auth, AuthDraft::Agent));
        let draft: HostDraft = serde_json::from_value(serde_json::json!({
            "id": null, "name": "n", "address": "a", "port": 22, "username": "u",
            "auth": { "Key": { "identity_id": "id-1" } }, "tags": [],
        }))
        .unwrap();
        assert!(matches!(draft.auth, AuthDraft::Key { .. }));
        let draft: HostDraft = serde_json::from_value(serde_json::json!({
            "id": null, "name": "n", "address": "a", "port": 22, "username": "u",
            "auth": "Keep", "tags": [],
        }))
        .unwrap();
        assert!(matches!(draft.auth, AuthDraft::None));
        // create_identity 回包形态（UI 指纹确认直接展示 fingerprint 字段）
        let meta: IdentityMeta = serde_json::from_value(serde_json::json!({
            "id": "i", "label": "l", "kind": "Ed25519", "fingerprint": "SHA256:x",
        }))
        .unwrap();
        assert_eq!(meta.fingerprint, "SHA256:x");
    }

    /// 锁定 DirEntryS 的线上格式（T41 FR-7 SFTP 浏览器；C4 R30 扩充）：UI/demo shim
    /// 按 {name,is_dir,kind,size,mtime} 渲染，字段名漂移即渲染断裂。
    /// 兼容：旧载荷（无 kind、size/mtime 必有数值）反序列化 kind=None。
    #[test]
    fn dir_entry_wire_format_matches_ui() {
        let e: DirEntryS = serde_json::from_value(serde_json::json!({
            "name": "a.txt", "is_dir": false, "size": 6, "mtime": 1790956800,
        }))
        .unwrap();
        assert_eq!(
            (e.name.as_str(), e.is_dir, e.size, e.mtime),
            ("a.txt", false, Some(6), Some(1790956800))
        );
        assert_eq!(e.kind, None); // 旧载荷升级兼容
                                  // 新载荷：symlink + 未知字段（§352 不伪造零值）
        let s: DirEntryS = serde_json::from_value(serde_json::json!({
            "name": "link", "is_dir": false, "kind": "symlink", "size": null, "mtime": null,
        }))
        .unwrap();
        assert_eq!(s.kind, Some(EntryKind::Symlink));
        assert_eq!((s.size, s.mtime), (None, None));
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({ "name": "link", "is_dir": false, "kind": "symlink", "size": null, "mtime": null })
        );
        let d: DirEntryS = serde_json::from_value(serde_json::json!({
            "name": "d", "is_dir": true, "kind": "dir", "size": null, "mtime": 1790956800,
        }))
        .unwrap();
        assert_eq!(d.kind, Some(EntryKind::Dir));
    }

    /// C4（R30）：PathResolved / EntryStat 线上格式锁定。
    #[test]
    fn c4_path_stat_wire_format() {
        let r: PathResolved =
            serde_json::from_value(serde_json::json!({ "canonical": "/root" })).unwrap();
        assert_eq!(r.canonical, "/root");
        let st: EntryStat = serde_json::from_value(serde_json::json!({
            "canonical": "/root/link-target", "kind": "symlink", "is_dir": false,
            "size": 12, "mtime": 1790956800, "symlink_target": "/root/link-target",
        }))
        .unwrap();
        assert_eq!(st.kind, Some(EntryKind::Symlink));
        assert_eq!(st.symlink_target.as_deref(), Some("/root/link-target"));
        // 悬空链接：canonical 不可知为 null（§352 可解释，不猜路径）
        let st2: EntryStat = serde_json::from_value(serde_json::json!({
            "canonical": null, "kind": "symlink", "is_dir": false,
            "size": null, "mtime": null, "symlink_target": "/gone",
        }))
        .unwrap();
        assert_eq!(st2.canonical, None);
        assert_eq!(
            serde_json::to_value(&st2).unwrap()["canonical"],
            serde_json::json!(null)
        );
    }

    // T42 端口转发：ForwardSpec 外部标签三变体 + ForwardInfo 往返，锁 UI 的
    // { Local: {...} } / { Remote: {...} } / { Dynamic: {...} } 构造形态
    #[test]
    fn forward_wire_format_matches_ui() {
        let local: ForwardSpec = serde_json::from_value(serde_json::json!({
            "Local": { "listen_addr": "127.0.0.1", "listen_port": 18080, "target_host": "10.0.0.5", "target_port": 80 }
        })).unwrap();
        let remote: ForwardSpec = serde_json::from_value(serde_json::json!({
            "Remote": { "listen_addr": "", "listen_port": 2223, "target_host": "127.0.0.1", "target_port": 9527 }
        })).unwrap();
        let dynamic: ForwardSpec = serde_json::from_value(serde_json::json!({
            "Dynamic": { "listen_addr": "127.0.0.1", "listen_port": 11080 }
        }))
        .unwrap();
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

    /// C5（R32 §547/§560）：TransferTask 线上格式锁定——status PascalCase 与既有
    /// UI 卡状态字符串一致；total/finished_at/error/retry_of 可空；revision 单调。
    #[test]
    fn c5_transfer_task_wire_format() {
        let running: TransferTask = serde_json::from_value(serde_json::json!({
            "id": "t-1", "session_id": "s-1", "kind": "Upload",
            "source": "/tmp/a.tar.gz", "dest": "/root/a.tar.gz",
            "status": "Running", "bytes_done": 512, "total": 1024,
            "revision": 7, "created_at": 1790956800,
            "finished_at": null, "error": null, "retry_of": null,
        }))
        .unwrap();
        assert_eq!(running.status, TransferStatus::Running);
        let v = serde_json::to_value(&running).unwrap();
        assert_eq!(v["status"], serde_json::json!("Running"));
        assert_eq!(v["kind"], serde_json::json!("Upload"));
        // 终态判定（归档/清 cancel 句柄依据）
        assert!(!running.status.is_terminal());
        assert!(serde_json::from_value::<TransferTask>(serde_json::json!({
            "id": "t-2", "session_id": "s-1", "kind": "Download",
            "source": "/var/log/x", "dest": "/tmp/x",
            "status": "Succeeded", "bytes_done": 9, "total": null,
            "revision": 9, "created_at": 1, "finished_at": 2,
            "error": null, "retry_of": null,
        }))
        .unwrap()
        .status
        .is_terminal());
        // 前向状态可反序列化（旧 UI 收到未知状态按「进行中」同待——R33/R34 载荷兼容面）；
        // OutcomeUnknown 例外=终态（无后续自动迁移，但恢复面按「提交结果未知」处置）
        for s in ["Committing", "AwaitingDecision"] {
            let t: TransferTask = serde_json::from_value(serde_json::json!({
                "id": "t", "session_id": "s", "kind": "Upload",
                "source": "a", "dest": "b", "status": s, "bytes_done": 0,
                "total": null, "revision": 1, "created_at": 0,
                "finished_at": null, "error": null, "retry_of": null,
            }))
            .unwrap();
            assert!(!t.status.is_terminal());
        }
        let ou: TransferStatus =
            serde_json::from_value(serde_json::json!("OutcomeUnknown")).unwrap();
        assert!(ou.is_terminal());
        // Cancelled 终态
        let c: TransferStatus = serde_json::from_value(serde_json::json!("Cancelled")).unwrap();
        assert!(c.is_terminal());
    }

    /// C6（R34）：冲突域 wire 锁定——CollisionDecision 小写三值、DecisionPrompt/
    /// TargetStat 载荷、TransferTask 新字段 serde default（旧载荷无
    /// collision_decision/decision_prompt 不炸）、Skipped/Interrupted 状态。
    #[test]
    fn c6_collision_wire_format() {
        use serde_json::json;
        // 决定值小写（MCP collision 参数同形；KeepBoth=无分隔小写，在此锁定）
        assert_eq!(
            serde_json::from_value::<CollisionDecision>(serde_json::json!("skip")).unwrap(),
            CollisionDecision::Skip
        );
        assert_eq!(
            serde_json::from_value::<CollisionDecision>(serde_json::json!("overwrite")).unwrap(),
            CollisionDecision::Overwrite
        );
        let kv = serde_json::to_value(CollisionDecision::KeepBoth).unwrap();
        assert_eq!(
            kv,
            serde_json::json!("keepboth"),
            "KeepBoth wire 值锁定（UI/MCP 三端一致）"
        );
        assert_eq!(
            serde_json::from_value::<CollisionDecision>(kv).unwrap(),
            CollisionDecision::KeepBoth
        );
        // 决定提示载荷
        let dp: DecisionPrompt = serde_json::from_value(json!({
            "target_path": "/root/a.conf", "target_stat": {"size": 12, "mtime": 1790000000},
            "reason": "target_exists"
        }))
        .unwrap();
        assert_eq!(dp.reason, "target_exists");
        assert_eq!(dp.target_stat.as_ref().unwrap().size, Some(12));
        // target_stat 可缺（预检 stat 失败如实 None，不虚构）
        let dp2: DecisionPrompt = serde_json::from_value(json!({
            "target_path": "/root/a.conf", "target_stat": null, "reason": "stat_changed_since_preflight"
        })).unwrap();
        assert!(dp2.target_stat.is_none());
        // 旧载荷（R32 形状，无新字段）反序列化不炸且新字段为 None
        let legacy: TransferTask = serde_json::from_value(json!({
            "id": "t", "session_id": "s", "kind": "Upload", "source": "a", "dest": "b",
            "status": "Running", "bytes_done": 0, "total": null, "revision": 1,
            "created_at": 0, "finished_at": null, "error": null, "retry_of": null,
        }))
        .unwrap();
        assert!(legacy.collision_decision.is_none() && legacy.decision_prompt.is_none());
        // 新载荷 round-trip 保形
        let full: TransferTask = serde_json::from_value(json!({
            "id": "t2", "session_id": "s", "kind": "Upload", "source": "a", "dest": "b",
            "status": "AwaitingDecision", "bytes_done": 0, "total": null, "revision": 3,
            "created_at": 0, "finished_at": null, "error": null, "retry_of": null,
            "collision_decision": "skip",
            "decision_prompt": {"target_path": "/b", "target_stat": {"size": null, "mtime": null}, "reason": "target_exists"},
        })).unwrap();
        assert_eq!(full.collision_decision, Some(CollisionDecision::Skip));
        assert_eq!(
            full.decision_prompt.as_ref().unwrap().reason,
            "target_exists"
        );
        let rt: TransferTask =
            serde_json::from_value(serde_json::to_value(&full).unwrap()).unwrap();
        assert_eq!(rt.collision_decision, full.collision_decision);
        assert_eq!(rt.decision_prompt, full.decision_prompt);
        // 新终态：Skipped / Interrupted（复审 H1 + §560 重启分类）
        assert!(serde_json::from_value::<TransferStatus>(json!("Skipped"))
            .unwrap()
            .is_terminal());
        assert!(
            serde_json::from_value::<TransferStatus>(json!("Interrupted"))
                .unwrap()
                .is_terminal()
        );
        // 错误 wire kind（结构化冲突/能力阻止/决定锁）
        assert_eq!(
            Error::ConflictDetected {
                target_path: "/b".into(),
                target_stat: None
            }
            .wire_parts()
            .0,
            "conflict_detected"
        );
        assert_eq!(
            Error::ReplaceUnsupported {
                capability: "target_version_constraint".into()
            }
            .wire_parts()
            .0,
            "replace_unsupported"
        );
        assert_eq!(
            Error::StaleDecision { expect_revision: 4 }.wire_parts().0,
            "stale_decision"
        );
        assert_eq!(
            Error::InvalidTransferState {
                task_id: "t".into(),
                state: TransferStatus::Running
            }
            .wire_parts()
            .0,
            "invalid_transfer_state"
        );
        // R40：转发监听失败字段定位（§6.6/D02）
        let (k, d) = Error::ForwardListenFailed {
            field: "listen".into(),
            reason: "端口占用".into(),
        }
        .wire_parts();
        assert_eq!(k, "forward_listen_failed");
        assert_eq!(d.unwrap()["field"], "listen");
    }

    /// R41（§6.6/S09）锁定连接详情的线上形态：字段名、枚举串、时间格式与「旧载荷兼容」。
    /// UI（ui/src/adapter/wire.ts SessionDetail）与 demo shim 按此形态收发——改动即 wire 变更。
    #[test]
    fn r41_session_detail_wire_format() {
        use serde_json::json;
        let d = SessionDetail {
            id: "s-1".into(),
            host_id: "h-1".into(),
            host_name: "生产机".into(),
            kind: "ssh".into(),
            state: SessionState::Connected,
            control_owner: ControlOwner::Human,
            created_at: DateTime::parse_from_rfc3339("2026-10-09T01:02:03Z")
                .unwrap()
                .with_timezone(&Utc),
            integration: IntegrationState::Ready,
            address: "10.0.0.5".into(),
            port: 2222,
            username: "root".into(),
            auth_type: AuthType::Key,
            fingerprint: Some("SHA256:abc".into()),
            charset: Charset::Gbk,
        };
        let v = serde_json::to_value(&d).unwrap();
        // 枚举/编码/时间格式三处都是既有 wire 口径，不得顺手改
        assert_eq!(v["state"], "Connected");
        assert_eq!(v["control_owner"], "Human");
        assert_eq!(v["auth_type"], "Key");
        assert_eq!(v["charset"], "gbk");
        assert_eq!(v["integration"], "Ready");
        assert_eq!(v["created_at"], "2026-10-09T01:02:03Z");
        assert_eq!(v["fingerprint"], "SHA256:abc");
        // 未建立信任的主机：fingerprint 如实 null（不虚构占位）
        let mut d2 = d.clone();
        d2.fingerprint = None;
        assert!(serde_json::to_value(&d2).unwrap()["fingerprint"].is_null());
        // 旧载荷（R41 前无 integration 字段）反序列化不炸，回落 Disabled
        let legacy = serde_json::from_value::<SessionDetail>(json!({
            "id": "s-1", "host_id": "h-1", "host_name": "h", "kind": "ssh",
            "state": "Connected", "control_owner": "Human",
            "created_at": "2026-10-09T01:02:03Z",
            "address": "a", "port": 22, "username": "u",
            "auth_type": "Password", "fingerprint": null, "charset": "utf-8"
        }))
        .unwrap();
        assert_eq!(legacy.integration, IntegrationState::Disabled);
        // R41：审计过滤新增 actor_kind（人类/Agent 两类过滤；缺省不过滤）
        assert!(AuditFilter::default().actor_kind.is_none());
    }
}
