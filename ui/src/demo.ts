// 浏览器演示模式的 invoke shim。**与真实后端语义对齐是硬要求**——本仓库三次
// UI 走查被 shim 伪影误导（全局输出串台、接管不翻 chip、审批状态小写掩住
// PascalCase 契约断点），浏览器走查发现的问题必须先对照本文件甄别。
// T27 对齐项：按会话隔离输出与 screen（真实 subscribe_output 按 sid 订阅）、
// set_control 翻转该会话控制权并作废其待审批、审计随操作动态追加、
// ssh_config 预览/导入、TOFU 指纹门（create_session 内挂起等决定，与真实
// 后端同构，拒绝走 HostKeyRejected）、未知命令显式报错（不再静默 null）。

type Handler = (data: Uint8Array) => void;

type DemoSession = {
  id: string; host_name: string; kind: string;
  state: string; control_owner: "Human" | "Agent";
  out: string;             // 会话私有输出缓冲（read_screen 回放 + 订阅增量同源）
  handlers: Handler[];
};
type DemoEvent = {
  seq: number; ts: string; actor_kind: "human" | "agent";
  agent_id: string | null; action: string; command: string | null;
  session_id?: string | null; payload_json?: Record<string, unknown>;
};
type DemoApproval = {
  id: string; session_id: string; agent_id: string;
  command: string; edited_command: string | null;
  status: string; segment_report: { segment: string; verdict: string }[];
};
type PendingKey = {
  pk: {
    id: string; host_id: string; host_name: string; address: string; port: number;
    issue: "FirstSeen" | "Changed"; fingerprint: string; previous_fingerprint: string | null;
    created_at: string;
  };
  resolve: (ok: boolean) => void;
};

const demoState = {
  owner: "Agent" as "Human" | "Agent",
  hosts: [
    { id: "local", name: "本机", address: "local", port: 0, username: "ops", auth_type: "Password" },
    { id: "h-prod1", name: "prod-1", address: "10.0.0.11", port: 22, username: "ops", auth_type: "Password" },
    { id: "h-prod2", name: "prod-2（演示连接失败）", address: "10.0.0.12", port: 22, username: "ops", auth_type: "Password" },
    { id: "h-otp1", name: "otp-1（演示 2FA）", address: "otp.demo", port: 22, username: "ops", auth_type: "Password" },
  ] as { id: string; name: string; address: string; port: number; username: string; auth_type: string }[],
  sessions: [
    {
      id: "s-demo-0001", host_name: "prod-1", kind: "ssh",
      state: "Connected", control_owner: "Agent",
      out: "ops@prod-1:~$ df -h\r\nFilesystem  Size  Used Avail Use% Mounted on\r\n/dev/vda1    40G   37G  3.1G  93% /\r\nops@prod-1:~$ ",
      handlers: [] as Handler[],
    },
    {
      id: "s-demo-0002", host_name: "staging-1", kind: "ssh",
      state: "Disconnected", control_owner: "Agent",
      out: "ops@staging-1:~$ ",
      handlers: [] as Handler[],
    },
  ] as DemoSession[],
  approvals: [
    {
      id: "a-demo-1",
      session_id: "s-demo-0001",
      agent_id: "opencode",
      command: "rm -rf /tmp/old-build && tar czf /tmp/build.tgz dist/",
      edited_command: null,
      status: "pending",
      segment_report: [
        { segment: "rm -rf /tmp/old-build", verdict: "pending: 未命中任何允许规则" },
        { segment: "tar czf /tmp/build.tgz dist/", verdict: "pending: 未命中任何允许规则" },
      ],
    },
    {
      id: "a-demo-2",
      session_id: "s-demo-0001",
      agent_id: "opencode",
      command: "docker system prune -f",
      edited_command: null,
      status: "pending",
      segment_report: [
        { segment: "docker system prune -f", verdict: "pending: 未命中任何允许规则" },
      ],
    },
    {
      // 已决样例：展示「最近处理」的作废态（接管作废旧请求）
      id: "a-demo-0",
      session_id: "s-demo-0002",
      agent_id: "opencode",
      command: "systemctl restart nginx",
      edited_command: null,
      status: "voided",
      segment_report: [],
    },
  ] as DemoApproval[],
  events: [
    { seq: 42, ts: "2026-09-27T14:02:11Z", actor_kind: "human", agent_id: null, action: "takeover", command: null, session_id: "s-demo-0001" },
    { seq: 41, ts: "2026-09-27T14:01:58Z", actor_kind: "agent", agent_id: "opencode", action: "approval_requested", command: "rm -rf /tmp/old-build", session_id: "s-demo-0001" },
    { seq: 40, ts: "2026-09-27T14:01:30Z", actor_kind: "agent", agent_id: "opencode", action: "exec", command: "df -h", session_id: "s-demo-0001" },
    { seq: 39, ts: "2026-09-27T14:01:02Z", actor_kind: "human", agent_id: null, action: "session_created", command: null, session_id: "s-demo-0001" },
  ] as DemoEvent[],
  pendingKeys: [] as PendingKey[],
  // 2FA 认证提示待决（路线图⑩演示）：挂起的 create_session 应答器按 id 索引
  pendingPrompts: [] as { item: { id: string; host_name: string; name: string; instructions: string; prompt: string; echo: boolean; created_at: string }; resolve: (answer: string | null) => void }[],
  // TOFU 已信任主机地址（种子信任 prod-1：走查点「连接」不弹指纹窗，与真实一致）
  trusted: new Set(["10.0.0.11"]),
};

const encoder = new TextEncoder();
function pushTo(sid: string, text: string) {
  const s = demoState.sessions.find((x) => x.id === sid);
  if (!s) return;
  s.out += text;
  for (const h of s.handlers) h(encoder.encode(text));
}
// 自增起点避开全部种子 id（曾用 2 与种子区段相邻，易在对比时混淆）
let demoSeq = 100;
let eventSeq = 42;
function audit(
  actor: "human" | "agent", action: string, command: string | null,
  agent_id: string | null = null, session_id: string | null = null,
  payload_json?: Record<string, unknown>,
) {
  demoState.events.unshift({ seq: ++eventSeq, ts: new Date().toISOString(), actor_kind: actor, agent_id, action, command, session_id, payload_json });
}

export async function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "mcp_status":
      return { endpoint: "http://127.0.0.1:8722/mcp（演示模式）", agents: [{ id: "opencode", label: "opencode（演示）" }] };
    case "bench_mode":
      return false;
    // 三个 list 必须返回新副本：真实后端每次 invoke 都是全新反序列化对象，
    // React 靠引用变化感知更新——shim 返回同一可变数组会让 setSessions 失效
    // （接管后 chip 不翻转的根因）。
    case "list_hosts":
      return demoState.hosts.map((h) => ({ ...h }));
    case "list_sessions":
      return demoState.sessions.map((s) => ({
        id: s.id, host_name: s.host_name, kind: s.kind,
        state: s.state, control_owner: s.control_owner,
      }));
    case "upsert_host": {
      const h = (args?.host ?? {}) as { id: string | null; name: string; address: string; port?: number; username: string; auth?: unknown };
      if (h.id) {
        const ex = demoState.hosts.find((x) => x.id === h.id);
        if (ex) {
          ex.name = h.name; ex.address = h.address; ex.port = h.port ?? 22; ex.username = h.username;
          audit("human", "host_upsert", h.name);
          return h.id;
        }
      }
      const id = h.id ?? "h-demo-" + demoSeq++;
      demoState.hosts.push({ id, name: h.name, address: h.address, port: h.port ?? 22, username: h.username, auth_type: "Password" });
      audit("human", "host_upsert", h.name);
      return id;
    }
    case "delete_host": {
      const id = args?.id as string;
      const h = demoState.hosts.find((x) => x.id === id);
      demoState.hosts = demoState.hosts.filter((x) => x.id !== id);
      if (h) audit("human", "host_delete", h.name);
      return null;
    }
    case "create_identity":
      audit("human", "identity_create", "demo");
      return { id: "id-demo-" + demoSeq++, label: "demo", kind: "Ed25519", fingerprint: "SHA256:demofingerprint" };
    case "list_identities":
      return [];
    case "ssh_config_preview":
      // 两可导入 + 一已导入（按主机名对账，与真实 already_imported 语义一致）
      return ["web-1", "db-1"].map((name) => ({
        name,
        address: name === "web-1" ? "web1.example.com" : "db1.internal",
        port: name === "web-1" ? 22 : 2222,
        username: name === "web-1" ? "ops" : "deploy",
        has_identity: name === "web-1",
        already_imported: demoState.hosts.some((h) => h.name === name),
      })).concat([{
        name: "prod-1", address: "10.0.0.11", port: 22, username: "ops",
        has_identity: false, already_imported: true,
      }]);
    case "ssh_config_import": {
      const names = (args?.names as string[]) ?? [];
      return names.map((name) => {
        if (demoState.hosts.some((h) => h.name === name)) {
          return { name, host_id: null, error: "已在主机列表" };
        }
        const isWeb = name === "web-1";
        const id = "h-demo-" + demoSeq++;
        demoState.hosts.push({
          id, name,
          address: isWeb ? "web1.example.com" : "db1.internal",
          port: isWeb ? 22 : 2222,
          username: isWeb ? "ops" : "deploy",
          auth_type: isWeb ? "Key" : "Agent",
        });
        audit("human", "host_upsert", name);
        return { name, host_id: id, error: null };
      });
    }
    case "create_session": {
      const hid = args?.hostId as string;
      const h = demoState.hosts.find((x) => x.id === hid);
      if (!h) throw new Error("HostNotFound（演示）");
      // 门序与真实 SSH 一致：先 TOFU 指纹门（密钥交换期），后 2FA 认证提示
      // TOFU 指纹门：未信任主机在门内挂起（弹窗决定），与真实后端同构——
      // 拒绝时 HostKeyRejected 从原始 createSession 调用抛出，主机卡红色失败态。
      // 本机（local）会话不经 SSH，无指纹门。
      if (h.address !== "local" && !demoState.trusted.has(h.address)) {
        const ok = await new Promise<boolean>((resolve) => {
          demoState.pendingKeys.push({
            pk: {
              id: "hk-demo-" + demoSeq++,
              host_id: h.id, host_name: h.name, address: h.address, port: h.port ?? 22,
              issue: "FirstSeen",
              fingerprint: "SHA256:DemoFingerprint-" + h.name,
              previous_fingerprint: null,
              created_at: new Date().toISOString(),
            },
            resolve,
          });
        });
        if (!ok) throw new Error("HostKeyRejected（演示：已拒绝该主机指纹）");
      }
      if (h.address === "otp.demo") {
        // 2FA 演示（路线图⑩）：认证提示挂起等人类应答（与真实挂起语义同构）
        const answer = await new Promise<string | null>((resolve) => {
          demoState.pendingPrompts.push({
            item: {
              id: "ap-demo-" + demoSeq++,
              host_name: h.name,
              name: "otp",
              instructions: "",
              prompt: "Verification code (OTP):",
              echo: true,
              created_at: new Date().toISOString(),
            },
            resolve,
          });
        });
        // 与真实 transport 同串（ConnectFailed 族）：friendlyError 由此区分「取消认证」
        // 与凭据错误——此前抛 AuthFailed 把取消误报成密码不对（PV R4 对齐）
        if (!answer) throw new Error("连接失败: 服务器要求额外交互认证（2FA），人工应答被取消或超时");
      }
      if (h.address === "10.0.0.12") throw new Error("AuthFailed（演示：认证失败）");
      const sid = "s-demo-" + String(demoSeq++).padStart(4, "0");
      demoState.sessions.push({ id: sid, host_name: h.name, kind: "ssh", state: "Connected", control_owner: "Agent", out: `ops@${h.name}:~$ `, handlers: [] });
      audit("human", "session_created", null, null, sid);
      return sid;
    }
    case "close_session": {
      const sid = args?.sid as string;
      const s = demoState.sessions.find((x) => x.id === sid);
      if (s) s.state = "Disconnected";
      pushTo(sid, "\r\n[会话已断开]\r\n");
      audit("human", "session_closed", null, null, sid ?? null);
      return null;
    }
    case "reconnect_session": {
      const sid = args?.sid as string;
      const s = demoState.sessions.find((x) => x.id === sid);
      if (!s) throw new Error("SessionNotFound（演示）");
      if (s.state !== "Disconnected") throw new Error("会话未处于断开状态，无需重连（演示）");
      s.state = "Reconfirming";
      pushTo(sid, "\r\n[演示] 重连成功，进入重确认（仅内置只读白名单可用）\r\n");
      audit("human", "session_reconnect", null, null, sid ?? null);
      return null;
    }
    case "resize":
      return null;
    case "read_screen": {
      const s = demoState.sessions.find((x) => x.id === args?.sid);
      return { text: s ? s.out.slice(-2048) : "", cols: 120, rows: 32, cursor_row: 3, cursor_col: 16, alt_screen: false };
    }
    case "subscribe_output": {
      const sid = args?.sid as string;
      const channel = args?.onEvent as { onmessage?: Handler };
      const s = demoState.sessions.find((x) => x.id === sid);
      if (s && channel?.onmessage) s.handlers.push((m) => channel.onmessage!(m));
      return null;
    }
    case "session_brief":
      return {
        cwd: "/var/log/nginx",
        running: [],
        pending_approvals: demoState.approvals.filter((a) => a.status === "pending").map((a) => a.id),
        env_summary: "TERM=xterm-256color；env 变更未追踪（V0）——printenv 核实",
        facts: [
          { subject: "cwd", detail: "/var/log/nginx", status: "Confirmed" },
          { subject: "命令（human）", detail: "df -h → exit 0", status: "Confirmed" },
          { subject: "控制权", detail: "14:02:11 · 人类接管（交接前未开始的请求全部作废）", status: "Confirmed" },
          { subject: "SSH 现场", detail: "重连后进入重确认：仅内置只读白名单可用", status: "NeedsRecheck" },
        ],
        screen_summary: "/dev/vda1 40G 37G 3.1G 93% / | ops@prod-1:~$",
      };
    case "list_approvals":
      return demoState.approvals.map((a) => ({ ...a, segment_report: a.segment_report.map((s) => ({ ...s })) }));
    case "decide_approval": {
      const id = args?.id as string;
      const it = demoState.approvals.find((a) => a.id === id);
      if (it) {
        // 镜像真实 mark_edited：原始请求保留在 command，实际放行文入 edited_command（PV R1 对齐）
        const edited = typeof args?.edited === "string" && args.edited ? args.edited : null;
        it.status = (args?.decision === "deny" ? "denied"
          : args?.decision === "edit" ? "approved_edited" : "approved") as string;
        if (args?.decision === "edit" && edited) it.edited_command = edited;
        const allowed = args?.decision === "edit" && edited ? edited : it.command;
        const label = it.status === "denied" ? "拒绝" : it.status === "approved_edited" ? "批准（编辑后）" : "批准";
        pushTo(it.session_id, "\r\n[审批] " + allowed + " → " + label + "\r\n");
        const deny = args?.decision === "deny";
        audit("human", deny ? "approval_denied" : "approval_decision",
          deny ? null : allowed, null, it.session_id,
          deny ? undefined : { decision: args?.decision === "edit" ? "approve_edited" : "approve" });
      }
      return null;
    }
    case "set_control": {
      const sid = args?.sid as string;
      const owner = args?.owner as "Human" | "Agent";
      const s = demoState.sessions.find((x) => x.id === sid);
      if (s) s.control_owner = owner;   // 焦点会话的「控制权」chip 随之翻转
      demoState.owner = owner;
      const stopping = args?.stopRunning === true;
      // 接管作废该会话的全部待审批（真实契约：作废范围 = 该会话旧请求）
      const voidedCount = owner === "Human"
        ? demoState.approvals.filter((a) => a.status === "pending" && (!sid || a.session_id === sid)).length
        : 0;
      if (voidedCount > 0) {
        for (const a of demoState.approvals) {
          if (a.status === "pending" && (!sid || a.session_id === sid)) a.status = "voided";
        }
      }
      pushTo(sid, owner === "Human"
        ? "\r\n⏸ 控制权 → 人类（Agent 请求已冻结，旧请求作废）\r\n"
        : "\r\n▶ 控制权 → Agent（请先读取现场简报再决定后续动作）\r\n");
      audit("human", owner === "Human" ? "takeover" : "handback", null, null, sid ?? null);
      return {
        frozen: owner === "Human",
        voided_approvals: voidedCount,
        paused_queue: stopping ? ["x-demo-9a"] : [],
        stopped: stopping ? [["x-demo-1f", { Exited: 0 }]] : [],
        brief: {},
      };
    }
    case "exec_human": {
      const sid = args?.sid as string;
      const command = args?.command as string;
      pushTo(sid, "\r\n" + command + "\r\n（演示输出）total 48K\r\n");
      audit("human", "exec", command, null, sid ?? null);
      return { stdout: "", exit_code: 0 };
    }
    case "send_keys":
      pushTo(args?.sid as string, (args?.keys as string) ?? "");
      return null;
    case "pending_host_keys":
      return demoState.pendingKeys.map((x) => x.pk);
    case "pending_auth_prompts":
      return demoState.pendingPrompts.map((x) => x.item);
    case "answer_auth_prompt": {
      const id = args?.id as string;
      const answer = (args?.answer as string) ?? "";
      const i = demoState.pendingPrompts.findIndex((x) => x.item.id === id);
      if (i < 0) return null;
      const it = demoState.pendingPrompts.splice(i, 1)[0];
      it.resolve(answer || null);
      return null;
    }
    case "decide_host_key": {
      const id = args?.id as string;
      const accept = args?.accept as boolean;
      const i = demoState.pendingKeys.findIndex((x) => x.pk.id === id);
      if (i < 0) return null;
      const item = demoState.pendingKeys.splice(i, 1)[0];
      if (accept) demoState.trusted.add(item.pk.address);
      audit("human", accept ? "host_key_trusted" : "host_key_decision", item.pk.host_name);
      item.resolve(accept);
      return null;
    }
    case "audit_query":
      return { events: demoState.events.slice(0, (args?.limit as number) ?? 30) };
    // 浏览器演示无法真实承载的操作：要么显式报错（传输类，UI 卡片如实显示失败），
    // 要么明确列为无操作（此前 default 静默 null 是「占位反馈」伪影的根源）。
    case "upload_file":
    case "download_file":
      throw new Error("演示模式不提供真实 SFTP 传输");
    case "cancel_transfer":
    case "note_terminal":
    case "open_url":
    case "get_setting":
    case "set_setting":
    case "bench_start":
    case "bench_report":
      return null;
    default:
      throw new Error("演示 shim 未实现该命令：" + cmd);
  }
}

export async function listen(_event: string, _handler: Handler): Promise<() => void> {
  // 浏览器演示模式不投递 Tauri 事件（审批/指纹队列经 invoke 轮询兜底）
  return () => {};
}

export class ChannelShim {
  onmessage?: Handler;
  constructor() {}
}
