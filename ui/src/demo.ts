// 浏览器演示模式：无 Tauri 环境时以演示数据驱动同一套 UI 代码（视觉验收/开发用）。
// 生产路径不受影响：@tauri-apps/api 直连核心。

type Handler = (msg: unknown) => void;

const demoState = {
  sid: "s-demo-0001",
  owner: "Agent" as "Human" | "Agent",
  outputHandlers: [] as Handler[],
  hosts: [
    { id: "local", name: "本机", address: "local", port: 0, username: "ops", auth_type: "Password" },
    { id: "h-prod1", name: "prod-1", address: "10.0.0.11", port: 22, username: "ops", auth_type: "Password" },
    { id: "h-prod2", name: "prod-2（演示连接失败）", address: "10.0.0.12", port: 22, username: "ops", auth_type: "Password" },
  ] as { id: string; name: string; address: string; port: number; username: string; auth_type: string }[],
  sessions: [
    {
      id: "s-demo-0001", host_name: "prod-1", kind: "ssh",
      state: "Connected", control_owner: "Agent",
    },
  ] as { id: string; host_name: string; kind: string; state: string; control_owner: string }[],
  approvals: [
    {
      id: "a-demo-1",
      session_id: "s-demo-0001",
      agent_id: "opencode",
      command: "rm -rf /tmp/old-build && tar czf /tmp/build.tgz dist/",
      status: "pending",
      segment_report: [
        { segment: "rm -rf /tmp/old-build", verdict: "pending: 未命中任何允许规则" },
        { segment: "tar czf /tmp/build.tgz dist/", verdict: "pending: 未命中任何允许规则" },
      ],
    },
  ],
  screen: "ops@prod-1:~$ df -h\r\nFilesystem  Size  Used Avail Use% Mounted on\r\n/dev/vda1    40G   37G  3.1G  93% /\r\nops@prod-1:~$ ",
};

function pushOutput(text: string) {
  for (const h of demoState.outputHandlers) h(new TextEncoder().encode(text));
}

let demoSeq = 2;

export async function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "mcp_status":
      return { endpoint: "http://127.0.0.1:8722/mcp（演示模式）", agents: [{ id: "opencode", label: "opencode（演示）" }] };
    case "bench_mode":
      return false;
    case "list_hosts":
      return demoState.hosts;
    case "list_sessions":
      return demoState.sessions;
    case "upsert_host": {
      const h = (args?.host ?? {}) as { name: string; address: string; port?: number; username: string };
      const id = "h-demo-" + demoSeq++;
      demoState.hosts.push({ id, name: h.name, address: h.address, port: h.port ?? 22, username: h.username, auth_type: "Password" });
      return id;
    }
    case "create_identity":
      return { id: "id-demo-" + demoSeq++, label: "demo", kind: "Ed25519", fingerprint: "SHA256:demofingerprint" };
    case "list_identities":
      return [];
    case "create_session": {
      const hid = args?.hostId as string;
      const h = demoState.hosts.find((x) => x.id === hid);
      if (h && h.address === "10.0.0.12") {
        throw new Error("AuthFailed（演示：认证失败）");
      }
      const sid = "s-demo-" + String(demoSeq++).padStart(4, "0");
      demoState.sessions.push({ id: sid, host_name: h?.name ?? "?", kind: "ssh", state: "Connected", control_owner: "Agent" });
      return sid;
    }
    case "close_session": {
      const sid = args?.sid as string;
      demoState.sessions = demoState.sessions.filter((s) => s.id !== sid);
      pushOutput("\r\n[会话已断开]\r\n");
      return null;
    }
    case "resize":
      return null;
    case "read_screen":
      return { text: demoState.screen, cols: 120, rows: 32, cursor_row: 3, cursor_col: 16, alt_screen: false };
    case "subscribe_output": {
      const channel = args?.onEvent as { onmessage?: Handler };
      demoState.outputHandlers.push((msg) => channel.onmessage?.(msg));
      return null;
    }
    case "session_brief":
      return {
        cwd: "/var/log/nginx",
        env_summary: "TERM=xterm-256color；env 变更未追踪（V0）——printenv 核实",
        facts: [
          { subject: "cwd", detail: "/var/log/nginx", status: "Confirmed" },
          { subject: "命令（human）", detail: "df -h → exit 0", status: "Confirmed" },
          { subject: "控制权", detail: "14:02:11 · 人类接管（交接前未开始的请求全部作废）", status: "Confirmed" },
          { subject: "SSH 现场", detail: "重连后进入重确认：仅内置只读白名单可用", status: "NeedsRecheck" },
        ],
        running: [],
        pending_approvals: ["a-demo-1"],
        screen_summary: "/dev/vda1 40G 37G 3.1G 93% / | ops@prod-1:~$",
      };
    case "list_approvals":
      return demoState.approvals;
    case "decide_approval": {
      const id = args?.id as string;
      const it = demoState.approvals.find((a) => a.id === id);
      if (it) {
        it.status = (args?.decision === "deny" ? "denied" : "approved") as string;
        pushOutput("\r\n[审批] " + it.command + " → " + it.status + "\r\n");
      }
      return null;
    }
    case "set_control": {
      demoState.owner = args?.owner as "Human" | "Agent";
      pushOutput(
        demoState.owner === "Human"
          ? "\r\n⏸ 控制权 → 人类（Agent 请求已冻结，旧请求作废）\r\n"
          : "\r\n▶ 控制权 → Agent（请先读取现场简报再决定后续动作）\r\n"
      );
      return { frozen: demoState.owner === "Human", paused_queue: [], stopped: [], brief: {} };
    }
    case "exec_human": {
      const command = args?.command as string;
      pushOutput("\r\n" + command + "\r\n（演示输出）total 48K\r\n");
      return { stdout: "", exit_code: 0 };
    }
    case "send_keys":
      pushOutput((args?.keys as string) ?? "");
      return null;
    case "audit_query": {
      const events = [
        { seq: 42, ts: "2026-09-27T14:02:11Z", actor_kind: "human", agent_id: null, action: "takeover", command: null },
        { seq: 41, ts: "2026-09-27T14:01:58Z", actor_kind: "agent", agent_id: "opencode", action: "approval_requested", command: "rm -rf /tmp/old-build" },
        { seq: 40, ts: "2026-09-27T14:01:30Z", actor_kind: "agent", agent_id: "opencode", action: "exec", command: "df -h" },
        { seq: 39, ts: "2026-09-27T14:01:02Z", actor_kind: "human", agent_id: null, action: "session_created", command: null },
      ];
      return { events: events.slice(0, (args?.limit as number) ?? 30) };
    }
    default:
      return null;
  }
}

export async function listen(_event: string, handler: Handler): Promise<() => void> {
  demoState.outputHandlers.push(handler);
  return () => {};
}

export class ChannelShim {
  onmessage?: Handler;
  constructor() {}
}
