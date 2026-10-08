// R10 Tauri/demo 统一桥：App 的一切后端调用必须经本模块。
// - CmdMap 是命令面的唯一类型登记处（42 命令，与 src-tauri generate_handler 一致）；
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
  create_session: { hostId: string };  // tauri v2 JS 侧实参为 camelCase，自动映射 rust host_id
  begin_connection: { hostId: string; opts?: wire.BeginConnectionOpts };
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
  cancel_transfer: { id: string };
  sftp_list: { sid: string; path: string };
  list_forwards: { sid: string };
  start_forward: { sid: string; spec: wire.ForwardSpec };
  stop_forward: { sid: string; id: string };
  get_setting: { key: string };
  set_setting: { key: string; value: string };
  get_workspace: undefined;
  set_workspace: { ws: wire.Workspace };
  set_host_favorite: { hostId: string; favorite: boolean };
  list_host_metadata: undefined;
  list_recent_hosts: undefined;
  read_screen: { sid: string };
  send_keys: { sid: string; keys: string };
  exec_human: { sid: string; command: string };
  set_control: { sid: string; owner: wire.ControlOwner; stopRunning?: boolean };
  session_brief: { sid: string };
  set_session_goal: { sid: string; goal: string | null };
  list_approvals: { pendingOnly: boolean };
  decide_approval: { id: string; decision: "approve" | "deny" | "edit"; edited?: string | null };
  audit_query: { sid: string | null; limit: number };
  issue_agent: { id: string; label: string };
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
  create_session: wire.SessionId;
  begin_connection: wire.AttemptInfo;
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
  cancel_transfer: void;
  sftp_list: wire.DirEntryS[];
  list_forwards: wire.ForwardInfo[];
  start_forward: wire.ForwardId;
  stop_forward: void;
  get_setting: string | null;
  set_setting: void;
  get_workspace: wire.Workspace;
  set_workspace: wire.Workspace;
  set_host_favorite: void;
  list_host_metadata: wire.HostMeta[];
  list_recent_hosts: wire.RecentHost[];
  read_screen: wire.ScreenSnapshot;
  send_keys: void;
  exec_human: wire.ExecResult;
  set_control: wire.TakeoverReport;
  session_brief: wire.SessionBrief;
  set_session_goal: void;
  list_approvals: wire.ApprovalItem[];
  decide_approval: void;
  audit_query: wire.AuditPage;
  issue_agent: string;
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
