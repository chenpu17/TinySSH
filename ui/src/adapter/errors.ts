// R10 统一错误映射（FE 侧）：后端以结构化 {kind, message, detail} 过桥
// （src-tauri WireError），本模块是前端唯一的错误归一出口。

/** wire 错误 kind 契约值。前 16 = session-api::Error 现有变体；§11 ADR-15 的
 * 11 个新 kind 为前向预留（真实后端实现前不会出现，但 demo 会以它们模拟目标
 * 行为，如 sftp_list 的 path_not_found）；kind 为开放集合——未知值原样保留、
 * 落 "unknown" 语义由调用方兜底。 */
export const WIRE_ERROR_KINDS = [
  // session-api::Error 现有 16 变体
  "approval_denied",
  "control_taken_by_human",
  "voided_by_handback",
  "reconfirming_pending",
  "session_not_found",
  "session_closed",
  "auth_failed",
  "connect_failed",
  "host_key_rejected",
  "exec_timeout",
  "cancelled",
  "queue_busy",
  "invalid_actor",
  "invalid_input",
  "storage",
  "io",
  // r03-contracts §11 ADR-15 前向预留（后端未实现前不会出现）
  "shell_integration_unavailable",
  "identity_in_use",
  "collaboration_disabled",
  "conflict_detected",
  "replace_unsupported",
  "stale_decision",
  "invalid_transfer_state",
  "stale_plan",
  "path_not_found",
  "permission_denied",
  "symlink_loop",
] as const;

export type WireErrorKind = (typeof WIRE_ERROR_KINDS)[number] | (string & {});

export interface ApiError {
  kind: WireErrorKind;
  message: string;
  detail?: unknown;
}

/** 任意 rejection（结构化 wire 错误对象 / Error / 字符串）→ ApiError。 */
export function parseWireError(raw: unknown): ApiError {
  if (raw && typeof raw === "object" && typeof (raw as { message?: unknown }).message === "string") {
    const o = raw as { kind?: unknown; message: string; detail?: unknown };
    return {
      kind: typeof o.kind === "string" ? o.kind : "unknown",
      message: o.message,
      detail: o.detail,
    };
  }
  return { kind: "unknown", message: String(raw) };
}

/** 取人话文案（term.write / connError.detail 等只要 message 的位点用）。 */
export function errMsg(raw: unknown): string {
  return parseWireError(raw).message;
}

/** demo 后端构造与 wire 同形的错误（demo 不绕过错误契约）。 */
export function apiError(kind: WireErrorKind, message: string): ApiError {
  return { kind, message };
}
