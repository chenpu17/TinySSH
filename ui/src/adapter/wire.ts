// R10 统一 wire DTO——与 crates/session-api/src/lib.rs 序列化形态逐字段对齐。
// 本文件是前端唯一的 wire 类型来源；App/demo 不得各自再声明同形类型。
// 枚举一律后端 serde 实际线格式：PascalCase 单元变体（无 rename_all）直接
// PascalCase 字符串；结构变体 externally tagged（如 ForwardSpec/IdentityReq）。

export type HostId = string;
export type SessionId = string;
export type IdentityId = string;
export type TransferId = string;
export type ForwardId = string;
export type ExecId = string;
export type ApprovalId = string;
export type AgentClientId = string;

export type AuthType = "Key" | "Password" | "KeyboardInteractive" | "Agent";
/** 线格式显式 rename："utf-8" / "gbk"（session-api Charset） */
export type Charset = "utf-8" | "gbk";
export type ControlOwner = "Human" | "Agent";
/** C3（R24）：shell 集成态——Ready≠集成就绪，独立于 SessionState。 */
export type IntegrationState = "Disabled" | "Pending" | "Ready" | "Unavailable";
export type SessionState =
  | "Connected" | "Degraded" | "Reconnecting" | "Disconnected" | "Reconfirming" | "Closed";
export type ApprovalStatus = "Pending" | "Approved" | "ApprovedEdited" | "Denied" | "Timeout" | "Voided";
export type Epistemic = "Confirmed" | "NeedsRecheck" | "Unobservable";
export type HostKeyIssue = "FirstSeen" | "Changed";
export type TransferKind = "Upload" | "Download";
export type IdentityKind = "Ed25519" | "Rsa" | "Ecdsa" | "Password";
export type KeyKind = "Ed25519" | "Rsa";

// StopOutcome：externally tagged（App.stopOutcomeText 按此判读）
export type StopOutcome = { Exited: number } | "Escalated" | "Unresponsive";

export interface Host {
  id: HostId;
  name: string;
  address: string;
  port: number;
  username: string;
  auth_type: AuthType;
  identity_id: IdentityId | null;
  tags: string[];
  /** 已信任指纹（TOFU）；null = 信任未建立 */
  fingerprint: string | null;
  charset: Charset;
}

export type AuthDraft =
  | "Keep"
  | "Agent"
  | { Key: { identity_id: IdentityId } }
  | { Password: { password: string } };

export interface HostDraft {
  id: HostId | null;
  name: string;
  address: string;
  port: number | null;
  username: string;
  auth: AuthDraft;
  tags: string[];
  charset: Charset;
  /** C3：null/缺省=新建默认（快速连接由核心兜底 Some(true)）；显式开关走 boolean。 */
  shell_integration?: boolean | null;
}

export type IdentityReq =
  | { Generate: { label: string; kind: KeyKind } }
  | { Import: { label: string; pem: string; passphrase: string | null } }
  | { Password: { label: string; password: string } };

export interface IdentityMeta {
  id: IdentityId;
  label: string;
  kind: IdentityKind;
  fingerprint: string;
}

export type SshUnsupportedLevel = "Blocking" | "Warning";

export interface SshUnsupportedDirective {
  directive: string;
  level: SshUnsupportedLevel;
  line: number;
}

export type SshSkipReason = "Duplicate" | "Blocked";

export interface SshConfigPreview {
  name: string;
  address: string;
  port: number;
  username: string;
  has_identity: boolean;
  already_imported: boolean;
  /** 溯源：来自哪个 config 文件哪一行 */
  source_file: string;
  source_line: number;
  /** 未支持指令分级（阻断=不可直接导入；警告=连通性无关仅提示） */
  unsupported: SshUnsupportedDirective[];
  /** 无阻断项且 User 已指定才可直接导入（DF7.5 不静默 root） */
  directly_importable: boolean;
  user_specified: boolean;
}

export interface SshImportOutcome {
  name: string;
  host_id: HostId | null;
  error: string | null;
  /** 跳过原因：Duplicate=同名或同地址+端口+用户；Blocked=含阻断级指令 */
  skipped_reason: SshSkipReason | null;
}

export interface SessionInfo {
  id: SessionId;
  host_id: HostId;
  host_name: string;
  /** "local" | "ssh" */
  kind: string;
  state: SessionState;
  control_owner: ControlOwner;
  /** 会话**真实创建时刻**（非查询时刻）。 */
  created_at: string;
  /** C3（R24）：shell 集成态——Ready≠集成就绪，独立字段。 */
  integration: IntegrationState;
  /**
   * R42（§6.7）该会话是否**曾被 Agent 持有**过控制权（人类建会话恒 false）。
   * UI 据此把入口措辞分开：「首次委托」用「交给 Agent」，曾被接管后用「交还 Agent」。
   * 缺省（旧后端）按 false 处理——保守侧，即当作首次委托。
   */
  ever_agent_owned?: boolean;
  /** 十八轮：会话日志记录中（真实核心 SessionInfo.logging；缺省=旧后端视为关）。 */
  logging?: boolean;
}

/**
 * R41（§6.6/S09）连接详情：**连接当时**的身份快照 + 运行时态。
 *
 * 与 `SessionInfo` 分开：地址/端口/用户/认证类型/指纹/编码取自建会话时对 Host 的
 * 快照（§6.1「删除配置不停止已存在会话，在活动标签保留连接时的主机信息」），
 * 主机配置此后被编辑/删除都不影响本值。
 */
export interface SessionDetail {
  id: SessionId;
  host_id: HostId;
  host_name: string;
  /** "local" | "ssh" */
  kind: string;
  state: SessionState;
  control_owner: ControlOwner;
  created_at: string;
  integration: IntegrationState;
  address: string;
  port: number;
  username: string;
  auth_type: AuthType;
  /** 连接时已信任的主机指纹；null = 首连确认前/未记录（不虚构）。 */
  fingerprint: string | null;
  charset: Charset;
}

// ---- R26（§6.4）会话状态事件：断线/自动重连次数/重确认即时推送 ----

export interface SessionStateEvent {
  session_id: SessionId;
  state: SessionState;
  attempt?: number | null;
  max_attempts?: number | null;
  detail?: string | null;
}

// ---- C1 建连尝试（R19）----

export type AttemptId = string;

export type AttemptPhase =
  | "Connecting"
  | "TrustRequired"
  | "Authenticating"
  | "ChallengeRequired"
  | "Ready"
  | "Failed"
  | "Cancelled"
  | "CancelCloseFailed";

/** wire 错误载荷（kind 与 WireError.kind 同表）。 */
export interface ErrorPayload {
  kind: string;
  message: string;
  detail?: unknown;
}

export interface AttemptInfo {
  attempt_id: AttemptId;
  host_id: HostId;
  /** "human" | "agent:<client_id>" */
  actor: string;
  phase: AttemptPhase;
  session_id: SessionId | null;
  created_at: string;
  error: ErrorPayload | null;
}

export interface BeginConnectionOpts {
  /** 显式绕过 (host_id, actor) 幂等合并（DC1.5）。 */
  new_session?: boolean;
}

export type CancelOutcome =
  | { outcome: "cancelled" }
  | { outcome: "already_ready"; session_id: SessionId }
  | { outcome: "cancel_close_failed"; session_id: SessionId }
  | { outcome: "not_found" };

export interface ConnectionEvent {
  attempt_id: AttemptId;
  phase: AttemptPhase;
  session_id: SessionId | null;
  error: ErrorPayload | null;
}

export interface ExecResult {
  exec_id: ExecId;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  has_binary: boolean;
  truncated: boolean;
  /** serde Duration：{secs, nanos} */
  duration: { secs: number; nanos: number };
  approval: unknown;
}

export interface SessionBrief {
  cwd: string | null;
  env_summary: string;
  facts: { subject: string; detail: string; status: Epistemic }[];
  running: ExecId[];
  pending_approvals: ApprovalId[];
  screen_summary: string;
  goal: string | null;
}

/** FR-10 V2（P1-b）：命令块查询行（read_blocks，最近 N 条旧→新）。
 *  source 为 BlockSource::describe()：human / agent:<client> / replay[:<client>]；
 *  exit_code null=断线强制收尾/未完成（如实未知）。 */
export interface BlockInfo {
  command: string;
  start: string | null;
  end: string | null;
  exit_code: number | null;
  source: string;
  exec_id: string | null;
  /** 块输出文本（P2：OSC 133 标记跨度采集，渲染后文本已剥 ANSI，≤8KB 保尾；无数据为空串） */
  output: string;
  /** true = 完整输出超 8KB，头部被裁（保留尾部） */
  output_truncated: boolean;
}

/** P2-b 输出触发器：规则（人类专属设置；匹配按完整行、剥 ANSI、冷却节流）。 */
export type TriggerAction = "Notify" | "SendKeys";
export interface TriggerRule {
  id: string;
  name: string;
  pattern: string;
  action: TriggerAction;
  /** SendKeys 必填；发送前建审批卡等人类裁决（可编辑键序）。 */
  keys: string | null;
  enabled: boolean;
  cooldown_secs: number;
}

export interface TakeoverReport {
  frozen: boolean;
  paused_queue: ExecId[];
  stopped: [ExecId, StopOutcome][];
  brief: SessionBrief;
}

export interface SegmentReport {
  segment: string;
  verdict: string;
}

export interface ApprovalItem {
  id: ApprovalId;
  session_id: SessionId;
  agent_id: AgentClientId;  // Rust 侧非 Option（rev-r10 注记 4 收紧）
  command: string;
  edited_command: string | null;
  /** 命令本身的破坏性提示，卡片展示用 */
  target_summary: string;
  segment_report: SegmentReport[];
  session_busy: boolean;
  /** 可编辑性由后端声明（仅 exec 类），UI 不猜 */
  editable: boolean;
  created_at: string;
  status: ApprovalStatus;
  /**
   * R42（§6.7）**可用目的**：该会话当前的委托目标（人类写给 Agent 的任务留言），
   * 作为审批时的意图上下文。`null`/缺省 = 无法获知目的——UI 必须**明确显示缺失**，
   * 不得留白让人误读为「无风险」。
   */
  purpose?: string | null;
}

/** C3（R24）：shell 能力只读查询（R42 首次委托对话框在转交前如实告知限制）。 */
export interface ShellCapability {
  integration_present: boolean;
  prompt_ready: boolean;
  host_setting: boolean;
}

/** C9（R43）：协作服务状态机。admission 门只在 `Enabled` 开放。 */
export type CollabState = "Enabled" | "Disabling" | "Disabled" | "DisableFailed";

/** C9（R43）：协作服务状态快照（区分「已配置」与「有活动请求」）。 */
export interface CollabStatus {
  state: CollabState;
  generation: number;
  /** 已配置 Agent 数（登记身份；不等于在线/有活动）。 */
  configured_agents: number;
  /** 有活动请求数（待审批 + Agent 持有会话）。 */
  active_requests: number;
  /** 应用拥有的 MCP 端点地址；空串 = 未启动。 */
  endpoint: string;
}

/** C9（R43）：停用影响预览。 */
export interface DisableImpact {
  agent_owned_sessions: number;
  pending_approvals: number;
  configured_agents: number;
}

/** C9（R43）：停用确认后的收敛报告。 */
export interface DisableReport {
  voided_approvals: number;
  converted_sessions: number;
}

export interface PendingHostKey {
  id: string;
  host_id: HostId;
  host_name: string;
  address: string;
  port: number;
  issue: HostKeyIssue;
  fingerprint: string;
  previous_fingerprint: string | null;
  created_at: string;
  attempt_id?: AttemptId | null;
}

export interface PendingAuthPrompt {
  id: string;
  /** R23（R21-L6 勘误闭环）：gatesBusy 按主机精确判他机门；旧载荷无此字段 */
  host_id?: string;
  host_name: string;
  name: string;
  instructions: string;
  prompt: string;
  echo: boolean;
  created_at: string;
}

export interface ScreenSnapshot {
  cols: number;
  rows: number;
  /** 渲染后文本（含 scrollback） */
  text: string;
  cursor_row: number;
  cursor_col: number;
  alt_screen: boolean;
}

export interface TransferHandle {
  id: TransferId;
  session_id: SessionId;
  kind: TransferKind;
  local: string;
  remote: string;
}

// ---- C5（R32）任务注册表：查询/事件统一载荷 ----

/** §6.5 生命周期；Committing/AwaitingDecision/OutcomeUnknown 为前向占位
 * （R33/R34 启用——旧 UI 收到未知状态按「进行中」同待） */
export type TransferStatus =
  | "Queued"
  | "Running"
  | "Committing"
  | "Succeeded"
  | "Failed"
  | "Cancelled"
  | "Cancelling"
  | "AwaitingDecision"
  | "OutcomeUnknown"
  | "Skipped"
  | "Interrupted";

/** C6/R34：冲突裁决（MCP collision 参数同形小写） */
export type CollisionDecision = "skip" | "overwrite" | "keepboth";

/** C6/R34：冲突询问载荷（仅 AwaitingDecision 态非空；reason=target_exists |
 * stat_changed_since_preflight——原因可查落字段 C-04） */
export interface DecisionPrompt {
  target_path: string;
  target_stat?: { size?: number | null; mtime?: number | null } | null;
  reason: string;
}

/** revision 单调递增（事件可合并可丢，按 id+revision 幂等对账；漏收由
 * list_transfers 查询兜底——UI 重挂后对账的权威面） */
export interface TransferTask {
  id: TransferId;
  session_id: SessionId;
  kind: TransferKind;
  source: string;
  dest: string;
  status: TransferStatus;
  bytes_done: number;
  total?: number | null;
  revision: number;
  created_at: number;
  finished_at?: number | null;
  error?: string | null;
  retry_of?: TransferId | null;
  /** C6/R34：冲突裁决（决定提交后随任务留存；serde default 兼容旧载荷） */
  collision_decision?: CollisionDecision | null;
  /** C6/R34：冲突询问（仅待决态非空） */
  decision_prompt?: DecisionPrompt | null;
}

export function transferTerminal(s: TransferStatus): boolean {
  return s === "Succeeded" || s === "Failed" || s === "Cancelled" || s === "OutcomeUnknown"
    || s === "Skipped" || s === "Interrupted";
}

/** 条目种类（C4 R30）：null = 旧载荷/服务端未报（升级兼容） */
export type EntryKind = "dir" | "file" | "symlink" | "other";

export interface DirEntryS {
  name: string;
  is_dir: boolean;
  kind?: EntryKind | null;
  /** 未知为 null/缺省（§352 不伪造零值，UI 显「—」） */
  size?: number | null;
  mtime?: number | null;
}

// ---- C4（R30）路径规范化与条目元数据 ----

export interface PathResolved {
  canonical: string;
}

export interface EntryStat {
  /** realpath 不可得为 null（严格实现的悬空链接等；OpenSSH 宽容实现返回归一化目标——服务端依赖，前端两态同待） */
  canonical: string | null;
  kind?: EntryKind | null;
  is_dir: boolean;
  size?: number | null;
  mtime?: number | null;
  /** 仅 kind=symlink 时可能存在 */
  symlink_target?: string | null;
}

export type ForwardSpec =
  | { Local: { listen_addr: string; listen_port: number; target_host: string; target_port: number } }
  | { Remote: { listen_addr: string; listen_port: number; target_host: string; target_port: number } }
  | { Dynamic: { listen_addr: string; listen_port: number } };

export interface ForwardInfo {
  id: ForwardId;
  spec: ForwardSpec;
  /** PascalCase："Listening" | "Degraded" | "Failed" */
  state: string;
  error: string | null;
}

/** 审计 payload 已知字段子集；wire 实为任意 JSON（新字段在此追加） */
export interface AuditPayload {
  decision?: string;
  cleared?: boolean;
  reason?: string;
  transfer?: string;
  bytes?: number;
  error?: string;
}

export interface AuditEvent {
  seq: number;
  ts: string;
  actor_kind: string;
  agent_id: string | null;
  action: string;
  session_id: SessionId | null;
  command: string | null;
  payload_json: AuditPayload | null;
  approval_id: ApprovalId | null;
  prev_hash: string | null;
  hash: string | null;
}

export interface AuditPage {
  total: number;
  events: AuditEvent[];
}

/** mcp_status 返回（main.rs json! 形状） */
export interface McpStatus {
  endpoint: string;
  agents: { id: string; label: string }[];
  /** rev-r47：生命周期明细（最近使用/过期；epoch ms，null=未用/不过期） */
  agents_detail?: {
    id: string;
    label: string;
    last_used_at: number | null;
    expires_at: number | null;
  }[];
  /** rev-r47：stdio shim 绝对路径（便携安装不在 PATH，配置须给全路径） */
  shim_path?: string;
}

/** 输出通道实况（R11 起带 seq 帧头）：通道送 <u64 LE seq（8 字节头）><原始字节>；
 *  Resync 提示走 window "resync" 事件 {session_id, from_seq, subscription_id}。 */
export type OutputChannelMessage = Uint8Array;

// ---------------------------------------------------------------------------
// C10 输出订阅恢复（R11）
// ---------------------------------------------------------------------------

/** 颜色规格。None（默认色）= null；Indexed = 256 色；Rgb = 真彩色。 */
export type ColorSpec = { Indexed: number } | { Rgb: [number, number, number] };

/** 单元格属性位集（与 session_api::cell_flags 一一对应）。 */
export const CELL_FLAGS = {
  BOLD: 1 << 0,
  DIM: 1 << 1,
  ITALIC: 1 << 2,
  UNDERLINE: 1 << 3,
  DOUBLE_UNDERLINE: 1 << 4,
  STRIKEOUT: 1 << 5,
  INVERSE: 1 << 6,
  HIDDEN: 1 << 7,
} as const;

/** 同属性连续单元格 run。宽字符只出现一次（spacer 省略）；行尾默认属性空格已裁。 */
export interface CellRun {
  text: string;
  fg: ColorSpec | null;
  bg: ColorSpec | null;
  flags: number;
}

export interface BufferCheckpoint {
  lines: CellRun[][];
}

export interface CursorState {
  x: number;
  y: number;
  visible: boolean;
  /** "block" | "underline" | "beam" */
  style: string;
}

export interface ScreenModes {
  autowrap: boolean;
  application_cursor: boolean;
  bracketed_paste: boolean;
  origin_mode: boolean;
}

/** 恢复载体（DF10.4）。buffers 恒 [主, 备]；active_buffer ∈ {0,1}。
 *  边界：非活动缓冲当前为核心侧空形（alacritty 0.26 无公开访问器，登记偏差）。 */
export interface ScreenCheckpoint {
  cols: number;
  rows: number;
  buffers: [BufferCheckpoint, BufferCheckpoint];
  active_buffer: 0 | 1;
  cursor: CursorState;
  modes: ScreenModes;
  title: string | null;
}

/** subscribe_output 返回（DF10.2）：订阅身份 + 原子捕获的检查点与水位。 */
export interface AttachOutput {
  subscription_id: string;
  checkpoint: ScreenCheckpoint;
  start_seq: number;
}

export interface SeqFrame {
  seq: number;
  data: Uint8Array;
}

/** resync_output 响应（DF10.3）：serde tag="kind" snake_case。 */
export type ResyncOutput =
  | { kind: "replayed"; subscription_id: string; events: SeqFrame[]; end_seq: number }
  | { kind: "checkpointed"; subscription_id: string; checkpoint: ScreenCheckpoint; end_seq: number };

/** debug_subscriptions 返回（P6 测量口径）。 */
export interface DebugSubscriptions {
  active_count: number;
  per_session: { session_id: SessionId; subscription_ids: string[] }[];
}

// ---------------------------------------------------------------------------
// C8 偏好与主机元数据（R15；与 session-api 同名类型逐字段对齐）
// ---------------------------------------------------------------------------

/** 工作区偏好（ui.v2.workspace blob，DF8.1）：整取整存原子写；不含秘密。 */
export interface Workspace {
  schema_version: number;
  /** 应用外观 dark | light（DF8.3 由终端主题映射的镜像字段） */
  chrome: string;
  /** 主机栏开合与宽度；null = 尚未写入（R12 localStorage 暂存迁入） */
  hostbar: HostbarPrefs | null;
  /** 终端偏好（R25 §318）；null = 尚未写入，消费方按全默认解释 */
  terminal?: TerminalPrefs | null;
  /** 传输偏好（R33 §355）；null = 尚未写入，下载落系统默认目录 */
  transfers?: TransferPrefs | null;
  /** 会话域（十五轮）：上次运行打开的主机清单（去重有序）；null = 尚未写入 */
  sessions?: SessionPrefs | null;
}

export interface HostbarPrefs {
  open: boolean;
  width: number;
}

/** 终端偏好（R25 §318）：粘贴保护默认开；选中即复制/响铃通知默认关（十五/十六轮）；
 * osc52 = 远端写剪贴板策略（P2-c，缺省/"ask" 外非法值均按 ask 解释） */
export interface TerminalPrefs {
  paste_guard: boolean;
  copy_on_select?: boolean;
  bell_notify?: boolean;
  osc52?: string;
}

/** 会话域（十五轮）：「重连上次会话」记忆 */
export interface SessionPrefs {
  /** 上次运行仍打开会话的主机 ID（去重、按标签序）；空数组 = 上次全部关闭 */
  last: string[];
}

/** 传输偏好（R33 §355）：下载默认目录记忆（首次=系统 Downloads；另存为后更新） */
export interface TransferPrefs {
  /** 上次下载目录（本地绝对路径；null = 未记忆，落系统默认） */
  download_dir: string | null;
}

/** 主机元数据（DF8.2 host_metadata 表行）。 */
export interface HostMeta {
  host_id: HostId;
  favorite: boolean;
  /** RFC3339；null = 从未连接 */
  last_connected_at: string | null;
}

/** 最近连接（DF8.5）：sessions 派生、排除 local、每主机最近一次、倒序上限 5。 */
export interface RecentHost {
  host_id: HostId;
  host_name: string;
  connected_at: string;
}

// 自身开销监控（本轮）：tinyssh-app 进程级资源快照（read_self_metrics）。
// cpu_pct null=首样基线未立；非 Windows 核心恒 null/0（FE 据此整块隐藏）。
export interface SelfMetrics {
  cpu_pct: number | null;
  ws_mb: number;
  commit_mb: number;
}

/** ② 自主模式授权视图：expires_at=null=手动关闭前有效（重启即失效，只存核心内存） */
export interface AutonomyGrant {
  agent_id: string;
  expires_at: string | null;
}

// ---- ④ 记录审计（核心 tinyssh_records::RecordEvent 直通，serde snake_case 契约）----

export type ActionRecordKind = "exec" | "transfer" | "forward";

/** 一条结构化动作记录：摘要 + 状态 + 脱敏输出摘录（≤4KB，写入侧已启发式擦密钥）。 */
export interface ActionRecord {
  seq: number;
  ts: string;
  kind: ActionRecordKind;
  session_id: string | null;
  /** null = 人类动作。 */
  agent_id: string | null;
  summary: string;
  /** ok | error | denied | timeout | cancelled | dangerous */
  status: string;
  exit_code: number | null;
  duration_ms: number | null;
  output_excerpt: string | null;
  meta: Record<string, unknown>;
}

/** 时间范围档位（App 在拉取时刻换算成 since ISO；「今天」按本机零点）。 */
export type RecordsRange = "all" | "today" | "24h" | "7d" | "30d";

/** 粘贴危险形态命中（P0 终端品质轮）：命中段 + 原因（内置 deny 表，与审批同一张）。 */
export interface PasteHit {
  segment: string;
  reason: string;
}

/** 时间线查询面（App 持有的完整形态；过桥时同形直传，range 由宿主换算为 since）。
 * until 供「加载更早」翻页：传已载最旧 ts−1ms（核心 until 为 <= 含端点）。 */
export interface RecordsQuery {
  agentId: string | null;
  kind: ActionRecordKind | null;
  limit: number;
  range: RecordsRange;
  sessionId: string | null;
}
