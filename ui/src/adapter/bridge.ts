// R10 Tauri/demo 统一桥：App 的一切后端调用必须经本模块。
// - CmdMap 是命令面的唯一类型登记处（44 命令，与 src-tauri generate_handler 一致）；
//   App 调用点的命令名/实参/返回值由 TS 全量校验，demo 不再经 `as never` 绕过。
// - demo（浏览器演示后端）实现同一命令名空间；未实现命令在 demo.invoke 内显式报错。
// - 平台专属 API（clipboard/window/drag-drop/version）不属于 wire，仍在组件层直用。
import * as tauri from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as demo from "../demo";
import type * as wire from "./wire";

export { listen };
export type { wire };

/** 无 Tauri 环境（纯浏览器）= 演示模式 */
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface WireChannel {
  onmessage?: (msg: unknown) => void;
}

export function MkChannel(): WireChannel {
  // demo.ChannelShim 的 Handler 参数型别较宽（Uint8Array 历史签名），边界处归一
  return inTauri ? new tauri.Channel<unknown>() : new demo.ChannelShim() as unknown as WireChannel;
}

// ---------------------------------------------------------------------------
// 命令面登记（src-tauri/src/main.rs generate_handler 逐条对齐）
// ---------------------------------------------------------------------------

interface CmdArgs {
  note_terminal: { sid: string | null; focused: boolean };
  list_hosts: undefined;
  upsert_host: { host: wire.HostDraft };
  delete_host: { id: string };
  create_identity: { req: wire.IdentityReq };
  list_identities: undefined;
  delete_identity: { id: string };
  ssh_config_preview: { path?: string | null };
  ssh_config_import: { path?: string | null; names: string[]; overwrite?: boolean };
  list_sessions: undefined;
  session_detail: { sid: string };
  create_session: { hostId: string };  // tauri v2 JS 侧实参为 camelCase，自动映射 rust host_id
  begin_connection: { hostId: string; opts?: wire.BeginConnectionOpts };
  begin_connection_draft: { draft: wire.HostDraft; opts?: wire.BeginConnectionOpts };
  connection_status: { attemptId: string };
  cancel_connection: { attemptId: string };
  close_session: { sid: string };
  reconnect_session: { sid: string };
  stop_auto_reconnect: { sid: string };
  session_state_feed: undefined;
  resize: { sid: string; cols: number; rows: number };
  subscribe_output: { sid: string; onEvent: WireChannel };
  unsubscribe_output: { sid: string; subscriptionId: string };
  resync_output: { sid: string; subscriptionId: string; fromSeq: number | null };
  debug_subscriptions: undefined;
  open_url: { url: string };
  upload_file: { sid: string; local: string; remote: string };
  download_file: { sid: string; remote: string; local?: string | null };
  pick_upload_files: undefined;
  pick_save_file: { defaultName: string; defaultDir?: string | null };
  cancel_transfer: { id: string };
  retry_transfer: { id: string };
  reveal_path: { path: string };
  list_transfers: undefined;
  submit_collision_decision: { id: string; decision: wire.CollisionDecision; expectRevision: number };
  reject_expired_decision: { id: string };
  verify_transfer_outcome: { id: string };
  sftp_list: { sid: string; path: string };
  sftp_resolve_path: { sid: string; path?: string | null };
  sftp_stat: { sid: string; path: string };
  list_forwards: { sid: string };
  start_forward: { sid: string; spec: wire.ForwardSpec };
  stop_forward: { sid: string; id: string };
  get_setting: { key: string };
  set_setting: { key: string; value: string };
  // P0 终端品质轮：粘贴危险形态扫描（人类侧提示；判定在 Rust，同一张内置 deny 表）
  scan_paste_danger: { text: string };
  get_workspace: undefined;
  set_workspace: { ws: wire.Workspace };
  set_host_favorite: { hostId: string; favorite: boolean };
  list_host_metadata: undefined;
  list_recent_hosts: undefined;
  read_screen: { sid: string };
  pty_size: { sid: string };
  send_keys: { sid: string; keys: string };
  set_session_logging: { sid: string; enabled: boolean };
  session_log_path: { sid: string };
  exec_human: { sid: string; command: string };
  // 监控条（命令框退役轮）：只读采样，核心侧固定脚本、UI 不可注入命令
  read_host_metrics: { sid: string };
  // 自身开销监控（本轮）：本进程 CPU/内存，无参只读
  read_self_metrics: undefined;
  set_control: { sid: string; owner: wire.ControlOwner; stopRunning?: boolean };
  // R42（§6.7）：首次委托/交还的**受控转换**（Human-only）。goal 可选——None 时
  // 核心保留既有目标（与 set_session_goal 的 None=清除不同），故不得省略该参数语义。
  delegate_session: { sid: string; goal?: string | null };
  shell_capability: { sid: string };
  // C9（R43）：协作启用生命周期（人类专属）。
  collab_status: undefined;
  collab_disable_preview: undefined;
  collab_disable: undefined;
  collab_enable: undefined;
  session_brief: { sid: string };
  set_session_goal: { sid: string; goal: string | null };
  // P1-b（FR-10 V2）：命令块查询（最近 N 条旧→新；面板与交接引用块数据面）
  read_blocks: { sid: string; limit?: number };
  list_approvals: { pendingOnly: boolean };
  decide_approval: { id: string; decision: "approve" | "deny" | "edit"; edited?: string | null };
  // 「批准并记住」（审批减摩擦①）：ttlMinutes（精确记忆）或 pattern（持久放行）二选一
  remember_approval: { id: string; ttlMinutes?: number | null; pattern?: string | null };
  // ② 自主模式：按 Agent 开/关（人类专属）；ttlMinutes=null/undefined=手动关才失效
  set_autonomy: { agentId: string; enable: boolean; ttlMinutes?: number | null };
  autonomy_list: undefined;
  // ④ 记录审计：时间线查询（人类全量视角）+ 明文导出（落点固定 records-export/）
  query_records: { filter?: Partial<wire.RecordsQuery> };
  export_records: { filter?: Partial<wire.RecordsQuery> };
  // R41（§6.6）：过滤面全量过桥。sid=null → 全部会话；actor_kind ∈ {human, agent}；
  // action 精确匹配动作名；beforeSeq 供「加载更早」按 seq 游标翻页（连续，不重不漏）。
  audit_query: {
    sid: string | null;
    limit: number;
    actorKind?: string | null;
    action?: string | null;
    beforeSeq?: number | null;
  };
  issue_agent: { id: string; label: string; expires_days?: number | null };
  revoke_agent: { id: string };
  mcp_status: undefined;
  pending_host_keys: undefined;
  decide_host_key: { id: string; accept: boolean };
  pending_auth_prompts: undefined;
  answer_auth_prompt: { id: string; answer: string };
  bench_mode: undefined;
  bench_start: { onChunk: WireChannel };
  bench_report: { bytes: number; resyncs: number; seconds: number };
  quit_app: undefined;
}

interface CmdRet {
  note_terminal: void;
  list_hosts: wire.Host[];
  upsert_host: wire.HostId;
  delete_host: void;
  create_identity: wire.IdentityMeta;
  list_identities: wire.IdentityMeta[];
  delete_identity: void;
  ssh_config_preview: wire.SshConfigPreview[];
  ssh_config_import: wire.SshImportOutcome[];
  list_sessions: wire.SessionInfo[];
  session_detail: wire.SessionDetail;
  create_session: wire.SessionId;
  begin_connection: wire.AttemptInfo;
  begin_connection_draft: wire.AttemptInfo;
  connection_status: wire.AttemptInfo;
  cancel_connection: wire.CancelOutcome;
  close_session: void;
  reconnect_session: void;
  stop_auto_reconnect: void;
  session_state_feed: wire.SessionStateEvent[];
  resize: void;
  subscribe_output: wire.AttachOutput;
  unsubscribe_output: void;
  resync_output: wire.ResyncOutput;
  debug_subscriptions: wire.DebugSubscriptions;
  open_url: void;
  upload_file: wire.TransferHandle;
  download_file: wire.TransferHandle;
  pick_upload_files: string[];
  pick_save_file: string | null;
  cancel_transfer: void;
  retry_transfer: wire.TransferHandle;
  reveal_path: void;
  list_transfers: wire.TransferTask[];
  submit_collision_decision: wire.TransferTask;
  reject_expired_decision: void;
  verify_transfer_outcome: wire.TransferTask;
  sftp_list: wire.DirEntryS[];
  sftp_resolve_path: wire.PathResolved;
  sftp_stat: wire.EntryStat;
  list_forwards: wire.ForwardInfo[];
  start_forward: wire.ForwardId;
  stop_forward: void;
  get_setting: string | null;
  set_setting: void;
  scan_paste_danger: wire.PasteHit[];
  get_workspace: wire.Workspace;
  set_workspace: wire.Workspace;
  set_host_favorite: void;
  list_host_metadata: wire.HostMeta[];
  list_recent_hosts: wire.RecentHost[];
  read_screen: wire.ScreenSnapshot;
  pty_size: [number, number];
  send_keys: void;
  set_session_logging: string | null;
  session_log_path: string | null;
  exec_human: wire.ExecResult;
  read_host_metrics: string;
  read_self_metrics: wire.SelfMetrics | null;
  set_control: wire.TakeoverReport;
  delegate_session: void;
  shell_capability: wire.ShellCapability;
  collab_status: wire.CollabStatus;
  collab_disable_preview: wire.DisableImpact;
  collab_disable: wire.DisableReport;
  collab_enable: wire.CollabStatus;
  session_brief: wire.SessionBrief;
  set_session_goal: void;
  read_blocks: wire.BlockInfo[];
  list_approvals: wire.ApprovalItem[];
  decide_approval: void;
  remember_approval: string[];
  set_autonomy: void;
  autonomy_list: wire.AutonomyGrant[];
  query_records: wire.ActionRecord[];
  export_records: { count: number; path: string };
  audit_query: wire.AuditPage;
  issue_agent: string;
  revoke_agent: void;
  mcp_status: wire.McpStatus;
  pending_host_keys: wire.PendingHostKey[];
  decide_host_key: void;
  pending_auth_prompts: wire.PendingAuthPrompt[];
  answer_auth_prompt: void;
  bench_mode: boolean;
  bench_start: void;
  bench_report: void;
  quit_app: void;
}

export type CmdName = keyof CmdArgs & keyof CmdRet;

/** 唯一后端调用入口：Tauri 真核心或 demo 后端，返回值/实参按 CmdMap 校验。
 *  错误 rejection 为 wire 结构化对象（见 adapter/errors.ts parseWireError）。 */
export const invoke = async <K extends CmdName>(
  cmd: K,
  ...rest: CmdArgs[K] extends undefined ? [args?: undefined] : [args: CmdArgs[K]]
): Promise<CmdRet[K]> => {
  const args = rest[0] as Record<string, unknown> | undefined;
  if (inTauri) return tauri.invoke(cmd, args) as Promise<CmdRet[K]>;
  return demo.invoke(cmd, args) as Promise<CmdRet[K]>;
};
