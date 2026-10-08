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
  created_at: string;
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

export interface DirEntryS {
  name: string;
  is_dir: boolean;
  size: number;
  mtime: number;
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
}

export interface HostbarPrefs {
  open: boolean;
  width: number;
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
