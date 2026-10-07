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

export interface SshConfigPreview {
  name: string;
  address: string;
  port: number;
  username: string;
  has_identity: boolean;
  already_imported: boolean;
}

export interface SshImportOutcome {
  name: string;
  host_id: HostId | null;
  error: string | null;
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

/** subscribe_output/bench_start 通道实况（rev-r10 注记 2 修正）：通道只送未包装的
 *  原始字节（Uint8Array，serde OutputEvent::Raw 的 data 字段内容）；Resync 提示不经
 *  通道，走 window "resync" 事件（App 现未监听——基线即如此，登记归 R11/R26）。 */
export type OutputChannelMessage = Uint8Array;
