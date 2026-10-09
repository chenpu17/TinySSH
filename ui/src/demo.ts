// 浏览器演示模式的 invoke shim。**与真实后端语义对齐是硬要求**——本仓库三次
// UI 走查被 shim 伪影误导（全局输出串台、接管不翻 chip、审批状态小写掩住
// PascalCase 契约断点），浏览器走查发现的问题必须先对照本文件甄别。
// T27 对齐项：按会话隔离输出与 screen（真实 subscribe_output 按 sid 订阅）、
// set_control 翻转该会话控制权并作废其待审批、审计随操作动态追加、
// ssh_config 预览/导入、TOFU 指纹门（create_session 内挂起等决定，与真实
// 后端同构，拒绝走 HostKeyRejected）、未知命令显式报错（不再静默 null）。

import { apiError } from "./adapter/errors";
import type { AttachOutput, DebugSubscriptions, ResyncOutput, ScreenCheckpoint, SessionStateEvent } from "./adapter/wire";
type Handler = (data: Uint8Array) => void;

/** R41（§6.1/§6.6）连接详情要展示的连接时身份——地址/端口/用户/认证/指纹/编码。 */
type DemoHostSnap = {
  name: string; address: string; port: number; username: string;
  auth_type: string; fingerprint: string | null; charset: "utf-8" | "gbk";
};

type DemoSession = {
  id: string; host_id: string; host_name: string; kind: string;
  state: string; control_owner: "Human" | "Agent";
  created_at: string;
  // R41（§6.1/§6.6）：连接**当时**的主机身份快照——主机配置此后被编辑/删除都不影响
  // 连接详情（真实侧即 SessionHandle 持有的构造期 Host 副本，非按 host_id 回查现配置）。
  host_snapshot: DemoHostSnap;
  goal: string | null;   // R9 任务目标/交接留言（随会话存亡，与真实 SessionHandle.goal 对齐）
  // 控制权/目标变迁（与真实 SessionHandle.transitions 对齐：简报「控制权」fact 取最近 3 条按序展示）。
  // ts 统一 ISO-UTC——简报侧转本地渲染（与真实 brief.rs 修复后口径一致，防时区伪影）
  transitions: { ts: string; what: string }[];
  out: string;             // 会话私有输出缓冲（read_screen 回放 + 订阅增量同源）
  handlers: Handler[];
  // C10 订阅恢复（R11）：seq 单调计数 + 原始字节重放环 + 活跃订阅身份
  seq: number;
  ring: { seq: number; data: Uint8Array }[];
  subs: Set<string>;
  // 端口转发（T42 FR-8）：spec 为外部标签枚举（Local/Remote/Dynamic），wire 同口径；
  // demo 无法真实监听端口——仅做注册表状态演示，state 恒 "Listening"
  forwards: { id: string; spec: Record<string, Record<string, unknown>>; state: string; error: string | null }[];
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
  // 后端同款声明（T44 复核中-2）：exec 卡 true（可编辑后批准），转发/传输卡 false
  editable: boolean;
};
type PendingKey = {
  pk: {
    id: string; host_id: string; host_name: string; address: string; port: number;
    issue: "FirstSeen" | "Changed"; fingerprint: string; previous_fingerprint: string | null;
    created_at: string; attempt_id?: string | null;
  };
  resolve: (ok: boolean) => void;
};

const demoState = {
  owner: "Agent" as "Human" | "Agent",
  // R26（§6.4）：每会话最近一条状态事件（session_state_feed 轮询面；真实核心走
  // session-state 事件通道——C1 connection-event/demo 轮询双路的同款镜像）
  stateEvents: new Map<string, SessionStateEvent>(),
  // C4（R30）C02 判别钩子：预置 sftp_list 慢响应（path 命中即延迟 ms）
  sftpSlow: null as { path: string; ms: number } | null,
  // C5（R32）演示传输注册表（创建倒序；真实核心同契约）
  transfers: [] as DemoTransfer[],
  // C6/R33（§353-355）原生选择器模拟：demo 域无真实对话框，由探针经 demo_pick_result
  // 预置返回值（null=走默认桩，模拟用户取消/直接确认）
  pickResult: null as string[] | null,
  saveResult: null as string | null,
  // R33 判别钩子：session_brief cwd 覆写（undefined=未覆写走默认；null=模拟 shell
  // 集成未上报无可信 cwd——§354「没有可信 cwd」分支在 demo 域的可达面）
  briefCwdOverride: undefined as string | null | undefined,
  // R40（§6.6/D02）判别钩子：预置「端口占用」集合——start_forward 命中即回
  // forward_listen_failed{field:"listen"}（demo 无真实监听，故以钩子模拟冲突）
  forwardConflictPorts: new Set<number>(),
  // C8 主机元数据（DF8.2）：收藏/最近连接，演示态内存域（真实核心在 host_metadata 表）
  hostMeta: new Map<string, { favorite: boolean; last_connected_at: string | null }>(),
  // R21 凭据基础管理：演示态凭据域（真实核心在 vault identities 表）+ 主机→凭据绑定
  //（真实 HostDraft.auth Key 携带 identity_id，demo 同语义存 ident_id）
  identities: [] as { id: string; label: string; kind: string; fingerprint: string }[],
  hosts: [
    { id: "local", name: "本机", address: "local", port: 0, username: "ops", auth_type: "Password" },
    { id: "h-prod1", name: "prod-1", address: "10.0.0.11", port: 22, username: "ops", auth_type: "Password", fingerprint: "SHA256:hVvBTD1MEAi8sdrrIXVLdpXH9SL8MKdHmZ6geX2U4YI" },
    { id: "h-prod2", name: "prod-2（演示连接失败）", address: "10.0.0.12", port: 22, username: "ops", auth_type: "Password" },
    { id: "h-otp1", name: "otp-1（演示 2FA）", address: "otp.demo", port: 22, username: "ops", auth_type: "Password" },
    // R21（§306）：echo=false 演示主机——验证码输入不回显（遮蔽断言面）
    { id: "h-otp2", name: "otp-2（演示 2FA 隐）", address: "otp2.demo", port: 22, username: "ops", auth_type: "Password" },
    // R26（R24-L5 指引面）：集成显式关的演示主机——命令框 Shell 模式拒绝 + Fresh 指引
    { id: "h-noint", name: "noint-1（无集成）", address: "noint.demo", port: 22, username: "ops", auth_type: "Password", shell_integration: false },
    { id: "h-staging1", name: "staging-1", address: "10.0.0.13", port: 22, username: "ops", auth_type: "Password" },
  ] as { id: string; name: string; address: string; port: number; username: string; auth_type: string; fingerprint?: string; charset?: "utf-8" | "gbk"; tags?: string[]; ident_id?: string | null }[],
  sessions: [
    {
      id: "s-demo-0001", host_id: "h-prod1", host_name: "prod-1", kind: "ssh",
      state: "Connected", control_owner: "Agent", created_at: "2026-09-27T13:50:00Z",
      host_snapshot: { name: "prod-1", address: "10.0.0.11", port: 22, username: "ops", auth_type: "Password", fingerprint: "SHA256:hVvBTD1MEAi8sdrrIXVLdpXH9SL8MKdHmZ6geX2U4YI", charset: "utf-8" },
      goal: "把 /tmp/old-build 清理掉并重新打包 dist 到 /tmp/build.tgz",
      transitions: [{ ts: "2026-09-27T14:02:11Z", what: "人类接管（交接前未开始的请求全部作废）" }],
      out: "ops@prod-1:~$ df -h\r\nFilesystem  Size  Used Avail Use% Mounted on\r\n/dev/vda1    40G   37G  3.1G  93% /\r\nops@prod-1:~$ ",
      handlers: [] as Handler[],
      seq: 0, ring: [], subs: new Set<string>(),
      forwards: [],
    },
    {
      id: "s-demo-0002", host_id: "h-staging1", host_name: "staging-1", kind: "ssh",
      state: "Disconnected", control_owner: "Agent", created_at: "2026-09-27T13:40:00Z",
      host_snapshot: { name: "staging-1", address: "10.0.0.13", port: 22, username: "ops", auth_type: "Password", fingerprint: null, charset: "utf-8" },
      goal: null,
      transitions: [],
      out: "ops@staging-1:~$ ",
      handlers: [] as Handler[],
      seq: 0, ring: [], subs: new Set<string>(),
      forwards: [],
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
      editable: true,
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
      editable: true,
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
      editable: true,
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
  pendingPrompts: [] as { item: { id: string; host_id?: string; host_name: string; name: string; instructions: string; prompt: string; echo: boolean; created_at: string; attempt_id?: string | null }; resolve: (answer: string | null) => void }[],
  // TOFU 已信任主机地址（种子信任 prod-1：走查点「连接」不弹指纹窗，与真实一致）
  trusted: new Set(["10.0.0.11"]),
  // C1 建连尝试（R19 demo 同契约）：attempt 表 + 已受理取消集合
  attempts: new Map<string, { info: import("./adapter/wire").AttemptInfo; hostId: string; actor: string }>(),
  cancelledAttempts: new Set<string>(),
};

const encoder = new TextEncoder();

// C10：live 帧格式 = <u64 LE seq（8 字节头）><原始字节>（与桥层一致，UI 剥头取 seq）
function frameBytes(seq: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, seq >>> 0, true);
  dv.setUint32(4, Math.floor(seq / 4294967296) >>> 0, true);
  out.set(data, 8);
  return out;
}

function pushTo(sid: string, text: string) {
  const s = demoState.sessions.find((x) => x.id === sid);
  if (!s) return;
  s.out += text;
  s.seq += 1;
  const raw = encoder.encode(text);
  s.ring.push({ seq: s.seq, data: raw });
  if (s.ring.length > 8192) s.ring.shift();
  const framed = frameBytes(s.seq, raw);
  for (const h of s.handlers) h(framed);
}

// demo 检查点合成：会话输出缓冲 → 单缓冲属性网格（demo 无颜色/备用屏状态）。
// 光标合成在最后非空行行尾（vis-r11 R2：rows-1 会让光标悬浮空白行、键入落点错位）
/** R41：建会话时对主机取快照（真实侧 = SessionHandle 构造期持有的 Host 副本）。 */
function hostSnapOf(h: { name: string; address: string; port: number; username: string; auth_type: string; fingerprint?: string; charset?: "utf-8" | "gbk" }): DemoHostSnap {
  return { name: h.name, address: h.address, port: h.port, username: h.username, auth_type: h.auth_type, fingerprint: h.fingerprint ?? null, charset: h.charset ?? "utf-8" };
}

function demoCheckpoint(s: DemoSession): ScreenCheckpoint {
  const rows = 32;
  const lines = s.out.split(/\r?\n/);
  const grid = lines.slice(-rows).map((l) => (l ? [{ text: l, fg: null, bg: null, flags: 0 }] : []));
  while (grid.length < rows) grid.push([]);
  let curY = 0;
  let curX = 0;
  for (let i = grid.length - 1; i >= 0; i--) {
    const text = grid[i].map((r) => r.text).join("");
    if (text) {
      curY = i;
      curX = Math.min(text.length, 120);
      break;
    }
  }
  return {
    cols: 120,
    rows,
    buffers: [{ lines: grid }, { lines: Array.from({ length: rows }, () => []) }],
    active_buffer: 0,
    cursor: { x: curX, y: curY, visible: true, style: "block" },
    modes: { autowrap: true, application_cursor: false, bracketed_paste: false, origin_mode: false },
    title: null,
  };
}
// 自增起点避开全部种子 id（曾用 2 与种子区段相邻，易在对比时混淆）
let demoSeq = 100;
// R26：自动重连模拟链（demo_drop_session 建链，stop_auto_reconnect 断链）
const dropChains = new Map<string, { stop: boolean; timers: number[] }>();

// C5（R32）演示传输注册表：与真实核心同契约（任务创建即注册 Queued → Running
// 分片推进 → Succeeded/Failed/Cancelled；事件面 = 800ms 轮询 list_transfers 双路
// 镜像）。文件名含 fail-demo 注入失败。内存域（真实核心落 transfer_journal）。
type DemoTransfer = {
  id: string; session_id: string; kind: "Upload" | "Download";
  source: string; dest: string; status: string; bytes_done: number; total: number | null;
  revision: number; created_at: number; finished_at: number | null;
  error: string | null; retry_of: string | null;
  // C6/R34：冲突域（wire 同形）
  collision_decision: string | null;
  decision_prompt: {
    target_path: string;
    target_stat: { size: number | null; mtime: number | null } | null;
    reason: string;
  } | null;
};
const TRANSFER_TERMINAL = ["Succeeded", "Failed", "Cancelled", "OutcomeUnknown", "Skipped", "Interrupted"];

// R35 §366 演示域同款并发闸：窗口全局 4、每会话 2，其余保持 Queued 排队。
// 持闸态=非 Queued 非终态（核心同语义：闸在预检/决策等待之前获取，AwaitingDecision
// 占位；排队中取消即时落 Cancelled 不等闸）。
function demoTransferSlotHolders(): DemoTransfer[] {
  return demoState.transfers.filter((x) => x.status !== "Queued" && !TRANSFER_TERMINAL.includes(x.status));
}
function demoLaunchTransferSteps(t: DemoTransfer) {
  const step = () => {
    const cur = demoState.transfers.find((x) => x.id === t.id);
    if (!cur) return;
    const now = Math.floor(Date.now() / 1000);
    if (cur.status === "Cancelling") {
      cur.status = "Cancelled"; cur.error = "已取消"; cur.finished_at = now; cur.revision += 1;
      return;
    }
    if (cur.status !== "Running" && cur.status !== "Queued") return;
    cur.status = "Running";
    cur.bytes_done = Math.min(cur.total ?? Infinity, cur.bytes_done + 196608);
    cur.revision += 1;
    if (cur.source.includes("fail-demo") && cur.bytes_done >= 393216) {
      cur.status = "Failed"; cur.error = "演示注入：远端写入失败"; cur.finished_at = now; cur.revision += 1;
      return;
    }
    if (cur.source.includes("unknown-demo") && cur.total != null && cur.bytes_done >= cur.total) {
      // C13 提交响应丢失：temp 与恢复资料保留，不自动重发/回滚
      cur.status = "OutcomeUnknown";
      cur.error = "提交结果未知（temp 与恢复资料保留；可在卡片「重新核实」）";
      cur.finished_at = now; cur.revision += 1;
      return;
    }
    if (cur.source.includes("interrupt-demo") && cur.bytes_done >= 196608) {
      // 提交前中断（应用退出）：恢复面统一 Interrupted
      cur.status = "Interrupted"; cur.error = "应用重启时传输中断";
      cur.finished_at = now; cur.revision += 1;
      return;
    }
    if (cur.total != null && cur.bytes_done >= cur.total) {
      cur.status = "Succeeded"; cur.finished_at = now; cur.revision += 1;
      return;
    }
    window.setTimeout(step, 150);
  };
  const tryStart = () => {
    const cur = demoState.transfers.find((x) => x.id === t.id);
    if (!cur || TRANSFER_TERMINAL.includes(cur.status)) return;
    if (cur.status === "Cancelling") {
      cur.status = "Cancelled"; cur.error = "已取消（排队中）";
      cur.finished_at = Math.floor(Date.now() / 1000); cur.revision += 1;
      return;
    }
    const holders = demoTransferSlotHolders();
    if (holders.length >= 4 || holders.filter((x) => x.session_id === t.session_id).length >= 2) {
      window.setTimeout(tryStart, 120);
      return;
    }
    step();
  };
  // 同步首次尝试：有槽即刻 Running（与 R32 基线同序——发起即 Running，取消窗口
  // 落在在途态）；无槽则退避重试保 Queued。
  tryStart();
}
function demoEmitState(sid: string, state: string,
  attempt: number | null, max: number | null, detail: string | null) {
  demoState.stateEvents.set(sid, {
    session_id: sid, state: state as SessionStateEvent["state"],
    attempt, max_attempts: max, detail,
  });
}
let demoSubCounter = 0;
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
      // identity_id 为 wire Host 契约字段（凭据绑定，R21 凭据库「使用中」标记的消费面）
      return demoState.hosts.map((h) => ({ ...h, identity_id: h.ident_id ?? null }));
    case "list_sessions":
      return demoState.sessions.map((s) => ({
        id: s.id, host_id: s.host_id, host_name: s.host_name, kind: s.kind,
        state: s.state, control_owner: s.control_owner, created_at: s.created_at,
        // C3（R24）：demo 不做 shell 集成注入，恒 Disabled（真实侧 Ready≠集成就绪）
        integration: "Disabled",
      }));
    case "upsert_host": {
      const h = (args?.host ?? {}) as { id: string | null; name: string; address: string; port?: number; username: string; auth?: unknown; charset?: "utf-8" | "gbk"; tags?: string[] };
      // 真实后端按 HostDraft.auth 推导 auth_type，demo 同口径（修复：此前新建一律
      // 硬编码 Password——密钥/Agent 主机在浏览器走查里会顶错徽章，属头部警告的对账类别）
      const a = h.auth;
      const authType = typeof a === "string"
        ? (a === "Agent" ? "Agent" : "Keep")
        : a && typeof a === "object" && "Key" in (a as Record<string, unknown>)
          ? "Key"
          : "Password";
      // R21：Key 凭据绑定（真实 HostDraft.auth.Key.identity_id 的 demo 同语义）
      const identId = a && typeof a === "object" && "Key" in (a as Record<string, unknown>)
        ? ((a as Record<string, unknown>).Key as { identity_id?: string } | undefined)?.identity_id ?? null
        : null;
      if (h.id) {
        const ex = demoState.hosts.find((x) => x.id === h.id);
        if (ex) {
          ex.name = h.name; ex.address = h.address; ex.port = h.port ?? 22; ex.username = h.username;
          ex.charset = h.charset ?? "utf-8";
          if (h.tags) ex.tags = h.tags.filter((t) => t.trim()).map((t) => t.trim());
          if (authType !== "Keep") ex.auth_type = authType;
          ex.ident_id = authType === "Key" ? identId : null;
          audit("human", "host_upsert", h.name);
          return h.id;
        }
      }
      const id = h.id ?? "h-demo-" + demoSeq++;
      demoState.hosts.push({ id, name: h.name, address: h.address, port: h.port ?? 22, username: h.username,
        auth_type: authType === "Keep" ? "Password" : authType, charset: h.charset ?? "utf-8",
        tags: (h.tags ?? []).filter((t: string) => typeof t === "string" && t.trim()).map((t: string) => t.trim()),
        ident_id: authType === "Key" ? identId : null });
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
    case "create_identity": {
      // 与真实 vault 同语义：Generate 生成新钥（kind 随请求）、Import 存粘贴私钥、
      // Password 存密码——均只回元数据（指纹 SHA256: 前缀），绝不回私钥/密码明文
      const req = args?.req as
        | { Generate?: { label: string; kind: string }; Import?: { label: string }; Password?: { label: string } }
        | undefined;
      const label = req?.Generate?.label ?? req?.Import?.label ?? req?.Password?.label ?? "demo";
      audit("human", "identity_create", label);
      const kind = req?.Generate
        ? (req.Generate.kind === "Rsa" ? "Rsa" : "Ed25519")
        : req?.Import ? "Ed25519" : "Password";
      const meta = { id: "id-demo-" + demoSeq++, label, kind, fingerprint: `SHA256:demoKey${demoSeq}qZ3tN7vBw9xQmFpL2sKd==` };
      demoState.identities.push(meta);
      return meta;
    }
    case "list_identities":
      return [...demoState.identities];
    case "delete_identity": {
      // R21 凭据基础管理：与真实 vault 同语义——被主机引用拒删并列出主机名
      const id = args?.id as string;
      const used = demoState.hosts.filter((x) => x.ident_id === id);
      if (used.length > 0) {
        throw apiError("identity_in_use", "凭据仍被主机引用", { host_names: used.map((x) => x.name) });
      }
      const before = demoState.identities.length;
      demoState.identities = demoState.identities.filter((x) => x.id !== id);
      if (demoState.identities.length === before) throw apiError("invalid_input", "凭据不存在（演示）");
      audit("human", "identity_delete", id);
      return null;
    }
    case "ssh_config_preview":
      // C7 分级演示：ok（警告级）/ blocked（ProxyJump 阻断）/ nouser（DF7.5）
      // / prod-1（已导入对账）。blocked/nouser 直接导入钮不可勾，可转手工表单。
      return [
        {
          name: "web-1", address: "web1.example.com", port: 22, username: "ops",
          has_identity: true, already_imported: demoState.hosts.some((h) => h.name === "web-1"),
          source_file: "~/.ssh/config", source_line: 3,
          unsupported: [{ directive: "serveraliveinterval", level: "Warning" as const, line: 4 }],
          directly_importable: true, user_specified: true,
        },
        {
          name: "db-1", address: "db1.internal", port: 2222, username: "deploy",
          has_identity: false, already_imported: demoState.hosts.some((h) => h.name === "db-1"),
          source_file: "~/.ssh/config", source_line: 8,
          unsupported: [], directly_importable: true, user_specified: true,
        },
        {
          name: "bastion-jump", address: "10.9.8.7", port: 22, username: "ops",
          has_identity: false, already_imported: false,
          source_file: "~/.ssh/config", source_line: 12,
          unsupported: [{ directive: "proxyjump", level: "Blocking" as const, line: 13 }],
          directly_importable: false, user_specified: true,
        },
        {
          name: "nouser", address: "10.9.8.8", port: 22, username: "currentuser",
          has_identity: false, already_imported: false,
          source_file: "~/.ssh/config", source_line: 16,
          unsupported: [], directly_importable: false, user_specified: false,
        },
        {
          name: "prod-1", address: "10.0.0.11", port: 22, username: "ops",
          has_identity: false, already_imported: true,
          source_file: "~/.ssh/config", source_line: 20,
          unsupported: [], directly_importable: true, user_specified: true,
        },
      ];
    case "ssh_config_import": {
      const names = (args?.names as string[]) ?? [];
      const overwrite = Boolean(args?.overwrite);
      return names.map((name) => {
        const spec = (["web-1", "db-1", "bastion-jump", "nouser", "prod-1"] as const)
          .map((n) => ({ n, imp: n === "web-1" || n === "db-1" || n === "prod-1" }))
          .find((x) => x.n === name);
        if (!spec || !spec.imp) {
          // 阻断/未指定用户：与真实核心同语义，不可直接导入即跳过
          return { name, host_id: null, error: null, skipped_reason: "Blocked" as const };
        }
        const existing = demoState.hosts.find((h) => h.name === name);
        if (existing && !overwrite) {
          return { name, host_id: null, error: null, skipped_reason: "Duplicate" as const };
        }
        const spec2: Record<string, { address: string; port: number; username: string; auth: string }> = {
          "web-1": { address: "web1.example.com", port: 22, username: "ops", auth: "Key" },
          "db-1": { address: "db1.internal", port: 2222, username: "deploy", auth: "Agent" },
          "prod-1": { address: "10.0.0.11", port: 22, username: "ops", auth: "Agent" },
        };
        const s = spec2[name];
        if (existing && overwrite) {
          existing.username = s.username;
          audit("human", "host_upsert", name);
          return { name, host_id: existing.id, error: null, skipped_reason: null };
        }
        const id = "h-demo-" + demoSeq++;
        demoState.hosts.push({
          id, name,
          address: s.address,
          port: s.port,
          username: s.username,
          auth_type: s.auth,
        });
        audit("human", "host_upsert", name);
        return { name, host_id: id, error: null, skipped_reason: null };
      });
    }
    case "create_session": {
      const hid = args?.hostId as string;
      const h = demoState.hosts.find((x) => x.id === hid);
      if (!h) throw apiError("invalid_input", "HostNotFound（演示）");
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
        if (!ok) throw apiError("host_key_rejected", "主机指纹验证失败（演示：已拒绝该主机指纹）");
      }
      if (h.address === "otp.demo" || h.address === "otp2.demo") {
        // 2FA 演示（路线图⑩）：认证提示挂起等人类应答（与真实挂起语义同构）；
        // R21：otp2.demo 走 echo=false（服务器语义不回显），覆盖输入遮蔽分支
        const answer = await new Promise<string | null>((resolve) => {
          demoState.pendingPrompts.push({
            item: {
              id: "ap-demo-" + demoSeq++,
              host_id: h.id,
              host_name: h.name,
              name: "otp",
              instructions: "",
              prompt: "Verification code (OTP):",
              echo: h.address !== "otp2.demo",
              created_at: new Date().toISOString(),
            },
            resolve,
          });
        });
        // 与真实 transport 同串（ConnectFailed 族）：friendlyError 由此区分「取消认证」
        // 与凭据错误——此前抛 AuthFailed 把取消误报成密码不对（PV R4 对齐）
        if (!answer) throw apiError("connect_failed", "连接失败: 服务器要求额外交互认证（2FA），人工应答被取消或超时");
      }
      if (h.address === "10.0.0.12") throw apiError("auth_failed", "AuthFailed（演示：认证失败）");
      const sid = "s-demo-" + String(demoSeq++).padStart(4, "0");
      demoState.sessions.push({ id: sid, host_id: h.id, host_name: h.name, kind: "ssh", state: "Connected", control_owner: "Agent", created_at: new Date().toISOString(), host_snapshot: hostSnapOf(h), goal: null, transitions: [], out: `ops@${h.name}:~$ `, handlers: [], seq: 0, ring: [], subs: new Set<string>(), forwards: [] });
      audit("human", "session_created", null, null, sid);
      // C8 镜像：成功建连打点（真实核心 touch_host_connection 同语义）
      {
        const m = demoState.hostMeta.get(h.id) ?? { favorite: false, last_connected_at: null };
        m.last_connected_at = new Date().toISOString();
        demoState.hostMeta.set(h.id, m);
      }
      // 镜像真实（C3/R24）：host shell_integration=false → Disabled 不注入（DC3.2）
      if ((h as { shell_integration?: boolean }).shell_integration !== false) {
        audit("human", "shell_integration_inject", "OSC133+OSC7", null, sid);
      }
      return sid;
    }
    case "close_session": {
      const sid = args?.sid as string;
      const s = demoState.sessions.find((x) => x.id === sid);
      if (s) {
        // R23（§342 对齐真实核心）：关闭成功=会话移除（Closed 语义）——标签随之消失，
        // 不留「已断开」死标签（断线保留是 R26 网络中断语义，非用户关闭）
        pushTo(sid, "\r\n[会话已关闭]\r\n");
        const si = demoState.sessions.findIndex((x) => x.id === sid);
        if (si >= 0) demoState.sessions.splice(si, 1);
        s.subs.clear(); // 会话关闭自动清理全部订阅（C10 主路径兜底）
      }
      // 镜像真实 close_session：作废该会话待审批并逐条留痕（reason=session_closed）
      for (const a of demoState.approvals) {
        if (a.status === "pending" && a.session_id === sid) {
          a.status = "voided";
          audit("human", "approval_voided", a.command, a.agent_id, a.session_id, { reason: "session_closed", agent: a.agent_id });
        }
      }
      audit("human", "session_closed", null, null, sid ?? null);
      return null;
    }
    case "reconnect_session": {
      const sid = args?.sid as string;
      const s = demoState.sessions.find((x) => x.id === sid);
      if (!s) throw apiError("session_not_found", "会话不存在（演示）");
      if (s.state !== "Disconnected") throw apiError("invalid_input", "会话未处于断开状态，无需重连（演示）");
      // 镜像真实：手动重连异步完成——Reconnecting{1/3} 事件 + 800ms 完成窗
      //（核心手动循环 3 次尝试期间同样发 Reconnecting；invoke 完成后才算成功）
      demoEmitState(sid, "Reconnecting", 1, 3, null);
      s.state = "Reconnecting";
      await new Promise((r) => setTimeout(r, 800));
      s.state = "Reconfirming";
      demoEmitState(sid, "Reconfirming", null, null, null);
      pushTo(sid, "\r\n[演示] 重连成功，进入重确认（仅内置只读白名单可用）\r\n");
      audit("human", "session_reconnect", null, null, sid ?? null);
      return null;
    }
    // R26（§6.4）：模拟网络断线 + 自动重连（探针驱动；recoverOnAttempt=N 第 N 次
    // 重连成功，0=永不）。节奏：Degraded 即刻 → 每 700ms 一次 attempt（每次状态
    // 驻留 ≥350ms，300ms 轮询不漏采）→ 3 次耗尽 Disconnected。
    case "demo_drop_session": {
      const sid = args?.sid as string;
      const s = demoState.sessions.find((x) => x.id === sid);
      if (!s) throw apiError("session_not_found", "会话不存在（演示）");
      if (s.state === "Disconnected") throw apiError("invalid_input", "会话已断开（演示）");
      const old = dropChains.get(sid);
      if (old) { old.stop = true; for (const t of old.timers) clearTimeout(t); dropChains.delete(sid); }
      const recover = Number(args?.recoverOnAttempt ?? 0);
      const chain = { stop: false, timers: [] as number[] };
      dropChains.set(sid, chain);
      s.state = "Degraded";
      demoEmitState(sid, "Degraded", null, null, null);
      s.transitions.push({ ts: new Date().toISOString(), what: "连接退化，尝试重连" });
      let a = 0;
      const step = () => {
        const c = dropChains.get(sid);
        if (!c || c.stop) return;
        a += 1;
        if (a > 3) {
          s.state = "Disconnected";
          demoEmitState(sid, "Disconnected", null, null, "自动重连 3 次均失败");
          s.transitions.push({ ts: new Date().toISOString(), what: "重连失败（Disconnected）" });
          dropChains.delete(sid);
          return;
        }
        s.state = "Reconnecting";
        demoEmitState(sid, "Reconnecting", a, 3, null);
        if (recover === a) {
          chain.timers.push(window.setTimeout(() => {
            const c2 = dropChains.get(sid);
            if (!c2 || c2.stop) return;
            s.state = "Reconfirming";
            demoEmitState(sid, "Reconfirming", null, null, null);
            s.transitions.push({ ts: new Date().toISOString(), what: "重连成功，进入重确认（仅内置只读白名单可用）" });
            pushTo(sid, "\r\n[演示] 自动重连成功，进入重确认\r\n");
            dropChains.delete(sid);
          }, 350));
          return;
        }
        chain.timers.push(window.setTimeout(step, 700));
      };
      chain.timers.push(window.setTimeout(step, 400));
      return null;
    }
    // R26（§6.4「可停止重试」）：断链 + 立即 Disconnected（真实核心 ≤250ms 分片睡眠）
    case "stop_auto_reconnect": {
      const sid = args?.sid as string;
      const s = demoState.sessions.find((x) => x.id === sid);
      if (!s) throw apiError("session_not_found", "会话不存在（演示）");
      const chain = dropChains.get(sid);
      if (chain) { chain.stop = true; for (const t of chain.timers) clearTimeout(t); dropChains.delete(sid); }
      s.state = "Disconnected";
      demoEmitState(sid, "Disconnected", null, null, "已停止自动重连");
      s.transitions.push({ ts: new Date().toISOString(), what: "用户停止自动重连（Disconnected）" });
      audit("human", "session_reconnect_stop", null, null, sid ?? null);
      return null;
    }
    // R26：状态事件轮询面（demo 无事件通道——C1 connection_status 同款兜底）
    case "session_state_feed":
      return [...demoState.stateEvents.values()];
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
      if (!s) throw apiError("session_not_found", "会话不存在（演示）");
      demoSubCounter += 1;
      const sub = `sub-demo-${demoSubCounter}`;
      if (channel?.onmessage) {
        s.handlers.push((m) => channel.onmessage!(m));
        s.subs.add(sub);
      }
      const attach: AttachOutput = { subscription_id: sub, checkpoint: demoCheckpoint(s), start_seq: s.seq };
      return attach;
    }
    case "unsubscribe_output": {
      const s = demoState.sessions.find((x) => x.id === args?.sid);
      s?.subs.delete(args?.subscriptionId as string);
      return null;
    }
    case "resync_output": {
      const sid = args?.sid as string;
      const sub = args?.subscriptionId as string;
      const fromSeq = (args?.fromSeq ?? null) as number | null;
      const s = demoState.sessions.find((x) => x.id === sid);
      if (!s) throw apiError("session_not_found", "会话不存在（演示）");
      if (!s.subs.has(sub)) throw apiError("invalid_input", `subscription 已过期或不存在：${sub}（演示）`);
      // 与真实口径一致：淘汰（环首已越过 from+1）→ checkpoint 路径
      if (fromSeq === null || s.ring.length === 0 || s.ring[0].seq > fromSeq + 1) {
        const r: ResyncOutput = { kind: "checkpointed", subscription_id: sub, checkpoint: demoCheckpoint(s), end_seq: s.seq };
        return r;
      }
      const events = s.ring.filter((r) => r.seq > (fromSeq ?? 0) && r.seq <= s.seq).map((r) => ({ seq: r.seq, data: r.data }));
      const r2: ResyncOutput = { kind: "replayed", subscription_id: sub, events, end_seq: s.seq };
      return r2;
    }
    case "debug_subscriptions": {
      const per = demoState.sessions
        .filter((s) => s.subs.size > 0)
        .map((s) => ({ session_id: s.id, subscription_ids: [...s.subs] }));
      const d: DebugSubscriptions = {
        active_count: per.reduce((a, p) => a + p.subscription_ids.length, 0),
        per_session: per,
      };
      return d;
    }
    case "session_brief": {
      const bs = demoState.sessions.find((x) => x.id === args?.sid);
      const cwd = demoState.briefCwdOverride === undefined ? "/var/log/nginx" : demoState.briefCwdOverride;
      return {
        cwd,
        running: [],
        pending_approvals: demoState.approvals.filter((a) => a.status === "pending").map((a) => a.id),
        env_summary: "TERM=xterm-256color；env 变更未追踪（V0）——printenv 核实",
        facts: [
          ...(cwd !== null ? [{ subject: "cwd", detail: cwd, status: "Confirmed" }] : []),
          { subject: "命令（human）", detail: "df -h → exit 0", status: "Confirmed" },
          // 与真实 brief::compute 对齐：控制权 fact = transitions 最近 3 条按序（无变迁则无此 fact）；
          // ISO-UTC → 本地 HH:MM:SS（与真实修复后口径一致，和操作记录时间线同区）
          ...(bs ? bs.transitions.slice(-3).map((t) => ({
            subject: "控制权",
            detail: `${new Date(t.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · ${t.what}`,
            status: "Confirmed",
          })) : []),
          { subject: "SSH 现场", detail: "重连后进入重确认：仅内置只读白名单可用", status: "NeedsRecheck" },
        ],
        screen_summary: "/dev/vda1 40G 37G 3.1G 93% / | ops@prod-1:~$",
        goal: bs ? bs.goal : null,
      };
    }
    // R9：人类→Agent 委托入口。镜像真实后端语义——trim 后空串归一为 null（清除）、
    // 仅人类可设、goal_set 审计留痕（command 位记目标文本，payload 记 cleared）。
    case "set_session_goal": {
      const sid = args?.sid as string;
      const s = demoState.sessions.find((x) => x.id === sid);
      if (!s) throw apiError("session_not_found", "会话不存在（演示）");
      const raw = args?.goal as string | null | undefined;
      const trimmed = raw == null ? null : raw.trim();
      s.goal = trimmed ? trimmed : null;
      // 与真实 set_session_goal 的 note_transition 对齐（文案逐字同 core-session）
      s.transitions.push({
        ts: new Date().toISOString(),
        what: s.goal ? "人类更新任务目标（Agent 读简报可见）" : "人类清除任务目标",
      });
      audit("human", "goal_set", s.goal, null, sid, { cleared: s.goal === null });
      return null;
    }
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
        // 镜像真实修复：拒绝同样留命令全文（审计对称，拒的是什么可核对）。
        // 真机 deny 是两条：approval_decision{decision:"deny"} + approval_denied（都带命令）
        audit("human", "approval_decision", allowed, null, it.session_id,
          { decision: args?.decision === "deny" ? "deny" : args?.decision === "edit" ? "approve_edited" : "approve" });
        if (deny) audit("human", "approval_denied", allowed, null, it.session_id);
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
      // 与真实 set_control 的 note_transition 对齐（文案逐字同 core-session）
      if (s) s.transitions.push({
        ts: new Date().toISOString(),
        what: owner === "Human"
          ? "人类接管（交接前未开始的请求全部作废）"
          : "人类交还（Agent 先读简报，再重新决定动作）",
      });
      // 接管作废该会话的全部待审批（真实契约：作废范围 = 该会话旧请求）
      const voidedCount = owner === "Human"
        ? demoState.approvals.filter((a) => a.status === "pending" && (!sid || a.session_id === sid)).length
        : 0;
      if (voidedCount > 0) {
        for (const a of demoState.approvals) {
          if (a.status === "pending" && (!sid || a.session_id === sid)) {
            a.status = "voided";
            // 镜像真实修复：作废逐条留痕（reason=takeover）
            audit("human", "approval_voided", a.command, a.agent_id, a.session_id, { reason: "takeover", agent: a.agent_id });
          }
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
      // 镜像真实（C3/B12）：集成关闭主机的命令框（Shell 模式）执行前拒绝——
      // available 载荷与核心同形状（FE 据此呈示 Fresh 指引）
      const s0 = demoState.sessions.find((x) => x.id === sid);
      const h0 = s0 ? demoState.hosts.find((x) => x.id === s0.host_id) : null;
      if (h0 && (h0 as { shell_integration?: boolean }).shell_integration === false) {
        throw apiError("shell_integration_unavailable",
          "Shell 模式不可用：该主机未启用 shell 集成", { available: { integration_present: false, prompt_ready: false, host_setting: false } });
      }
      pushTo(sid, "\r\n" + command + "\r\n（演示输出）total 48K\r\n");
      audit("human", "exec", command, null, sid ?? null);
      return { stdout: "", exit_code: 0 };
    }
    case "send_keys":
      pushTo(args?.sid as string, (args?.keys as string) ?? "");
      return null;
    // ---- C1 建连尝试（R19；demo 同契约，无事件机制——探针经 connection_status 轮询）----
    case "begin_connection": {
      const hid = args?.hostId as string;
      const opts = (args?.opts ?? {}) as { new_session?: boolean };
      const TERMINAL = ["Ready", "Failed", "Cancelled", "CancelCloseFailed"];
      if (!opts.new_session) {
        for (const a of demoState.attempts.values()) {
          if (a.hostId === hid && a.actor === "human" && !TERMINAL.includes(a.info.phase)) return a.info;
        }
      }
      const aid = "at-demo-" + String(demoSeq++).padStart(4, "0");
      const entry = { info: { attempt_id: aid, host_id: hid, actor: "human", phase: "Connecting", session_id: null, created_at: new Date().toISOString(), error: null } as import("./adapter/wire").AttemptInfo, hostId: hid, actor: "human" };
      demoState.attempts.set(aid, entry);
      const setPhase = (phase: import("./adapter/wire").AttemptPhase) => { entry.info.phase = phase; };
      void (async () => {
        try {
          const h = demoState.hosts.find((x) => x.id === hid);
          if (!h) throw apiError("invalid_input", "HostNotFound（演示）");
          if (h.address !== "local" && !demoState.trusted.has(h.address)) {
            setPhase("TrustRequired");
            const ok = await new Promise<boolean>((resolve) => {
              demoState.pendingKeys.push({
                pk: {
                  id: "hk-demo-" + demoSeq++, host_id: h.id, host_name: h.name, address: h.address,
                  port: h.port ?? 22, issue: "FirstSeen", fingerprint: "SHA256:DemoFingerprint-" + h.name,
                  previous_fingerprint: null, created_at: new Date().toISOString(), attempt_id: aid,
                },
                resolve,
              });
            });
            if (demoState.cancelledAttempts.has(aid)) throw apiError("cancelled", "已取消");
            if (!ok) throw apiError("host_key_rejected", "主机指纹验证失败（演示：已拒绝该主机指纹）");
            setPhase("Authenticating");
          }
          if (h.address === "otp.demo" || h.address === "otp2.demo") {
            setPhase("ChallengeRequired");
            const answer = await new Promise<string | null>((resolve) => {
              demoState.pendingPrompts.push({
                item: { id: "ap-demo-" + demoSeq++, host_id: h.id, host_name: h.name, name: "otp", instructions: "", prompt: "Verification code (OTP):", echo: h.address !== "otp2.demo", created_at: new Date().toISOString(), attempt_id: aid },
                resolve,
              });
            });
            if (demoState.cancelledAttempts.has(aid)) throw apiError("cancelled", "已取消");
            if (!answer) throw apiError("connect_failed", "连接失败: 服务器要求额外交互认证（2FA），人工应答被取消或超时");
            setPhase("Authenticating");
          }
          if (h.address === "10.0.0.12") throw apiError("auth_failed", "AuthFailed（演示：认证失败）");
          // 与 create_session 同构建会话（同步快路径）
          const sid = "s-demo-" + String(demoSeq++).padStart(4, "0");
          demoState.sessions.push({ id: sid, host_id: h.id, host_name: h.name, kind: "ssh", state: "Connected", control_owner: "Agent", created_at: new Date().toISOString(), host_snapshot: hostSnapOf(h), goal: null, transitions: [], out: `ops@${h.name}:~$ `, handlers: [], seq: 0, ring: [], subs: new Set<string>(), forwards: [] });
          {
            const m = demoState.hostMeta.get(h.id) ?? { favorite: false, last_connected_at: null };
            m.last_connected_at = new Date().toISOString();
            demoState.hostMeta.set(h.id, m);
          }
          audit("human", "session_created", null, null, sid);
          if (demoState.cancelledAttempts.has(aid)) {
            // 已提交未投递窗口取消：核心立即关闭刚创建会话（DC1.2）
            const si = demoState.sessions.findIndex((x) => x.id === sid);
            if (si >= 0) demoState.sessions.splice(si, 1);
            entry.info.session_id = null;
            setPhase("Cancelled");
            audit("human", "connection_cancelled_closed", null, null, null);
            return;
          }
          entry.info.session_id = sid;
          setPhase("Ready");
        } catch (e) {
          const err = e as { kind?: string; message?: string };
          if (demoState.cancelledAttempts.has(aid) || err?.kind === "cancelled") {
            entry.info.session_id = null;
            entry.info.error = null;
            setPhase("Cancelled");
            audit("human", "connection_cancelled", null, null, null);
          } else {
            entry.info.error = { kind: err?.kind ?? "connect_failed", message: err?.message ?? "建连失败" };
            setPhase("Failed");
            audit("human", "connection_failed", err?.kind ?? "connect_failed", null, null);
          }
        }
      })();
      return entry.info;
    }
    case "connection_status": {
      const aid = args?.attemptId as string;
      const a = demoState.attempts.get(aid);
      if (!a) throw apiError("session_not_found", "AttemptNotFound（演示）");
      return a.info;
    }
    case "cancel_connection": {
      const aid = args?.attemptId as string;
      const a = demoState.attempts.get(aid);
      if (!a) return { outcome: "not_found" };
      const TERMINAL = ["Ready", "Failed", "Cancelled", "CancelCloseFailed"];
      if (TERMINAL.includes(a.info.phase) || (a.info.phase === "Ready" && a.info.session_id)) return { outcome: "not_found" };
      if (a.info.session_id && a.info.phase !== "Ready") {
        // 已提交未投递窗口：立即关闭刚创建会话
        const sid = a.info.session_id;
        const si = demoState.sessions.findIndex((x) => x.id === sid);
        if (si >= 0) demoState.sessions.splice(si, 1);
        a.info.session_id = null;
        a.info.phase = "Cancelled";
        demoState.cancelledAttempts.add(aid);
        audit("human", "connection_cancelled_closed", null, null, null);
        return { outcome: "already_ready", session_id: sid };
      }
      demoState.cancelledAttempts.add(aid);
      // 作废该 attempt 挂起的门（以拒绝/空应答结算并移除待决卡——与核心一致：
      // 受理即从 hk_pending/ap_pending 移除，查询面不返回死卡）
      for (let i = demoState.pendingKeys.length - 1; i >= 0; i--) {
        if (demoState.pendingKeys[i].pk.attempt_id === aid) {
          demoState.pendingKeys.splice(i, 1)[0].resolve(false);
        }
      }
      for (let i = demoState.pendingPrompts.length - 1; i >= 0; i--) {
        if (demoState.pendingPrompts[i].item.attempt_id === aid) {
          demoState.pendingPrompts.splice(i, 1)[0].resolve(null);
        }
      }
      return { outcome: "cancelled" };
    }
    case "pending_host_keys":
      return demoState.pendingKeys.map((x) => x.pk);
    case "quit_app":
      // demo（浏览器）无窗口生命周期：no-op（真实环境由 tauri quit_app 退出进程）
      return null;
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
    case "session_detail": {
      // R41（§6.6/S09）：身份取自**连接时快照**（host_snapshot），不按 host_id 回查现配置
      // ——主机被改名/改址/删除后，详情仍显示连接当时的值（§6.1 语义，与真实侧同）。
      const sid = String(args?.sid ?? "");
      const s = demoState.sessions.find((x) => x.id === sid);
      if (!s) throw apiError("session_not_found", "会话不存在或已关闭");
      const snap = s.host_snapshot;
      return {
        id: s.id, host_id: s.host_id, host_name: s.host_name, kind: s.kind,
        state: s.state, control_owner: s.control_owner, created_at: s.created_at,
        integration: "Disabled",
        address: snap.address, port: snap.port, username: snap.username,
        auth_type: snap.auth_type, fingerprint: snap.fingerprint, charset: snap.charset,
      };
    }
    case "audit_query": {
      // R41（§6.6）：过滤面与真实 AuditFilter 同口径（sid / actor_kind / action）；
      // beforeSeq 是**翻页游标**而非过滤条件——total 报过滤后总数，不随翻页缩水（同后端）。
      const sid = (args?.sid as string | null | undefined) ?? null;
      const actorKind = (args?.actorKind as string | null | undefined) ?? null;
      const action = (args?.action as string | null | undefined) ?? null;
      const beforeSeq = (args?.beforeSeq as number | null | undefined) ?? null;
      const limit = (args?.limit as number) || 100;
      const filtered = demoState.events
        .filter((e) => (sid === null ? true : e.session_id === sid))
        .filter((e) => (actorKind === null ? true : e.actor_kind === actorKind))
        .filter((e) => (action === null ? true : e.action === action))
        .sort((a, b) => b.seq - a.seq);
      const page = beforeSeq === null ? filtered : filtered.filter((e) => e.seq < beforeSeq);
      return { total: filtered.length, events: page.slice(0, limit) };
    }
    // T41 FR-7 + C4（R30）：目录浏览演示树（与真实 wire 契约同口径——目录在前、
    // 名称序、过滤 . / ..；kind/symlink 与未知字段 size/mtime=null 同 §352 语义；
    // mtime 为演示固定时间戳）。传输类仍如实报错（见下）。
    case "sftp_list": {
      const p = ((args?.path as string) ?? "").replace(/\/+$/, "") || "/";
      // C02 判别钩子（R30）：demo_sftp_slow 预置慢目录——命中即延迟再返回，
      // 供「晚到旧响应不得覆盖新路径」的代际守卫判别（旧码必红）
      const sl = demoState.sftpSlow;
      if (sl && sl.path === p && sl.ms > 0) await new Promise((r) => setTimeout(r, sl.ms));
      type Ent = { name: string; is_dir: boolean; kind: "dir" | "file" | "symlink" | "other"; size: number | null; mtime: number | null };
      const d = (name: string, mtime = 1790870400): Ent => ({ name, is_dir: true, kind: "dir", size: null, mtime });
      const f = (name: string, size: number, mtime = 1790870400): Ent => ({ name, is_dir: false, kind: "file", size, mtime });
      const l = (name: string, mtime = 1790870400): Ent => ({ name, is_dir: false, kind: "symlink", size: null, mtime });
      const nginx: Ent[] = [
        d("archive"),
        f("access.log", 73400320, 1790956800),
        f("error.log", 2097152, 1790956800),
        // 未知字段呈现面：socket 无大小无时间（§352 显「—」不伪造零值）
        { name: "php-fpm.sock", is_dir: false, kind: "other", size: null, mtime: null },
        // 隐藏项（R31 显示隐藏项判别：默认不显示，开启后可见）
        f(".rotate.state", 128, 1790784000),
        // 符号链接：latest → archive（目录，点击 stat 探明后进入）
        l("latest", 1790956800),
      ];
      const releases: Ent[] = [
        d("v2", 1790611200),
        d("v3", 1790956800),
        f("CHANGELOG.md", 2048, 1790908800),
      ];
      const v3: Ent[] = [
        f("app.tar.gz", 48250470, 1790956800),
        f("app.yml", 640, 1790908800),
      ];
      const tree: Record<string, Ent[]> = {
        // /var/log/nginx = demo 简报 cwd（session_brief），浏览器首载即有内容
        "/var/log/nginx": nginx,
        "/var/log/nginx/archive": [
          f("access-202609.log.gz", 8912896, 1790611200),
        ],
        // latest → archive（跟随语义：list 符号链接路径 = 列目标）
        "/var/log/nginx/latest": nginx.filter((e) => e.name !== "latest"),
        "/root": [
          d("deploy"),
          d("logs"),
          d("releases", 1790956800),
          d(".ssh", 1790784000),
          f("nginx.conf", 2048, 1790908800),
          f("backup-0930.tar.gz", 48250470, 1790870400),
          f("readme.md", 312, 1790611200),
          // current → /root/releases/v3（可进入）；gone-link → 悬空（stat canonical=null）
          l("current", 1790956800),
          l("gone-link", 1790784000),
        ],
        "/root/deploy": [
          d("scripts"),
          f("release.sh", 1841, 1790956800),
          f("app.yml", 640, 1790908800),
          f(".env", 220, 1790784000),
        ],
        "/root/deploy/scripts": [
          f("migrate.sh", 733, 1790908800),
        ],
        "/root/logs": [
          f("app.log", 15204351, 1790956800),
          f("error.log", 94208, 1790956800),
        ],
        "/root/releases": releases,
        "/root/releases/v2": [f("app.tar.gz", 42198123, 1790611200)],
        "/root/releases/v3": v3,
        // current → v3（跟随语义）
        "/root/current": v3,
        // 拒绝路径演示（C4：权限不足可区别错误，非笼统 io）
        "/var/private": [],
      };
      if (p === "/var/private") throw apiError("sftp_permission_denied", "演示模式：权限不足（/var/private）", { path: p });
      if (!(p in tree)) throw apiError("sftp_path_not_found", `演示模式：目录不存在（${p}）`, { path: p });
      return tree[p].slice().sort((a, b) => (b.is_dir ? 1 : 0) - (a.is_dir ? 1 : 0) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    }
    // C4（R30）：路径规范化。null → SFTP 初始目录（演示固定 /var/log/nginx）；
    // 已知路径 → 解析 . / .. 与尾斜杠；未知 → sftp_path_not_found（前端不猜路径）。
    case "sftp_resolve_path": {
      const raw = args?.path;
      const know = new Set(["/", "/var", "/var/log", "/var/log/nginx", "/var/log/nginx/archive", "/var/log/nginx/latest", "/root", "/root/deploy", "/root/deploy/scripts", "/root/logs", "/root/releases", "/root/releases/v2", "/root/releases/v3", "/root/current", "/var/private"]);
      if (raw == null) return { canonical: "/var/log/nginx" };
      const p = String(raw);
      if (p === "/var/private") throw apiError("sftp_permission_denied", "演示模式：权限不足（/var/private）", { path: p });
      const parts: string[] = [];
      for (const seg of p.split("/")) {
        if (!seg || seg === ".") continue;
        if (seg === "..") parts.pop();
        else parts.push(seg);
      }
      const norm = "/" + parts.join("/");
      if (!know.has(norm)) throw apiError("sftp_path_not_found", `演示模式：路径不存在（${p}）`, { path: p });
      return { canonical: norm };
    }
    // C4（R30）：条目元数据。lstat 语义 kind/symlink_target；is_dir/size/mtime 跟随；
    // 悬空链接 canonical=null（§352 可解释不猜路径）。
    case "sftp_stat": {
      const p = String(args?.path ?? "").replace(/\/+$/, "") || "/";
      const symlinks: Record<string, { target: string; is_dir: boolean; canonical: string | null }> = {
        "/var/log/nginx/latest": { target: "archive", is_dir: true, canonical: "/var/log/nginx/archive" },
        "/root/current": { target: "/root/releases/v3", is_dir: true, canonical: "/root/releases/v3" },
        "/root/gone-link": { target: "/var/gone", is_dir: false, canonical: null },
      };
      if (p in symlinks) {
        const s = symlinks[p];
        return { canonical: s.canonical, kind: "symlink", is_dir: s.is_dir, size: null, mtime: 1790956800, symlink_target: s.target };
      }
      const dirs = new Set(["/", "/var", "/var/log", "/var/log/nginx", "/var/log/nginx/archive", "/root", "/root/deploy", "/root/deploy/scripts", "/root/logs", "/root/releases", "/root/releases/v2", "/root/releases/v3"]);
      if (p === "/var/private") throw apiError("sftp_permission_denied", "演示模式：权限不足（/var/private）", { path: p });
      if (!dirs.has(p)) {
        // 已知文件（列目录树里出现过的非目录项）
        const files = new Set(["/var/log/nginx/access.log", "/var/log/nginx/error.log", "/var/log/nginx/php-fpm.sock", "/root/nginx.conf", "/root/readme.md", "/root/backup-0930.tar.gz", "/root/deploy/release.sh", "/root/deploy/app.yml", "/root/deploy/scripts/migrate.sh", "/root/logs/app.log", "/root/logs/error.log", "/root/releases/CHANGELOG.md", "/root/releases/v2/app.tar.gz", "/root/releases/v3/app.tar.gz", "/root/releases/v3/app.yml"]);
        if (!files.has(p)) throw apiError("sftp_path_not_found", `演示模式：路径不存在（${p}）`, { path: p });
        if (p.endsWith(".sock")) return { canonical: p, kind: "other", is_dir: false, size: null, mtime: null, symlink_target: null };
        return { canonical: p, kind: "file", is_dir: false, size: 1024, mtime: 1790956800, symlink_target: null };
      }
      return { canonical: p, kind: "dir", is_dir: true, size: null, mtime: 1790870400, symlink_target: null };
    }
    // C02 判别钩子注册（R30）：{ path, ms } 预置后 sftp_list 命中该路径即延迟
    case "demo_sftp_slow": {
      demoState.sftpSlow = { path: String(args?.path ?? ""), ms: Number(args?.ms ?? 0) };
      return null;
    }
    // R33（§353-355）选择器与拖放判别钩子：demo 无真实原生对话框/无 OS 拖放事件，
    // 探针预置返回值 / 直接触发 App 注册的 window.__demoDrop(paths) 回调
    case "demo_pick_result": {
      // "paths"/"path" 键存在才覆写（缺键=恢复默认桩）；path 空串=模拟用户取消
      demoState.pickResult = args && "paths" in args ? [...((args.paths as string[] | undefined) ?? [])] : null;
      demoState.saveResult = args && "path" in args ? String(args.path ?? "") : null;
      return null;
    }
    case "demo_brief_cwd": {
      // {cwd: string|null} 覆写 brief cwd；无 cwd 键=恢复默认（/var/log/nginx）
      demoState.briefCwdOverride = args && "cwd" in args ? (args.cwd == null ? null : String(args.cwd)) : undefined;
      return null;
    }
    case "demo_forward_conflict": {
      // R40 判别钩子：{ports: number[]} 预置占用端口集合（缺键=清空）；start_forward 命中回
      // forward_listen_failed{field:"listen"}——§6.6「端口冲突关联到对应字段」的 demo 可达面
      demoState.forwardConflictPorts = new Set(((args?.ports as number[] | undefined) ?? []).map((x) => Number(x)));
      return null;
    }
    case "demo_drag_drop": {
      const paths = (args?.paths as string[]) ?? [];
      const cb = (window as unknown as { __demoDrop?: (paths: string[], x?: number, y?: number) => void }).__demoDrop;
      if (!cb) throw apiError("invalid_input", "演示拖放回调未注册（面板未挂载？）");
      cb(paths, args?.x as number | undefined, args?.y as number | undefined);
      return null;
    }
    case "pick_upload_files": {
      // 默认桩模拟一次普通选择；demo_pick_result 预置 [] 可判别取消路径
      return demoState.pickResult ?? ["/Users/demo/Desktop/deploy.tar.gz", "/Users/demo/Desktop/app.yml"];
    }
    case "pick_save_file": {
      if (demoState.saveResult !== null) return demoState.saveResult;
      const name = String(args?.defaultName ?? "file");
      const dir = String(args?.defaultDir ?? "/Users/demo/Downloads");
      return `${dir}/${name}`;
    }
    // T42 FR-8：端口转发注册表演示。demo 无法真实监听端口/建隧道——仅按会话
    // 维护转发条目（wire 契约同口径：外部标签 spec + state/error），审计随操作
    // 追加，与真实 core-session 的 forward_start/forward_stop 事件对齐。
    case "list_forwards": {
      const s = demoState.sessions.find((x) => x.id === args?.sid);
      if (!s) throw apiError("session_not_found", "会话不存在（演示）");
      return s.forwards.map((f) => ({ ...f, spec: { ...f.spec } }));
    }
    case "start_forward": {
      const s = demoState.sessions.find((x) => x.id === args?.sid);
      if (!s) throw apiError("session_not_found", "会话不存在（演示）");
      const spec = args?.spec as Record<string, Record<string, unknown>>;
      const k = "Local" in spec ? "Local" : "Remote" in spec ? "Remote" : "Dynamic";
      const v = spec[k];
      // R40（§6.6）：契约同口径校验——字段可定位错误（field 定位到表单字段）
      const lport = Number(v.listen_port);
      if (!Number.isInteger(lport) || lport <= 0 || lport > 65535) {
        throw apiError("forward_listen_failed", `转发监听失败（listen）：监听端口须为 1–65535`, { field: "listen", reason: "监听端口须为 1–65535" });
      }
      if (String(v.listen_addr ?? "").trim() === "") {
        throw apiError("forward_listen_failed", `转发监听失败（listen）：监听地址不能为空（默认 127.0.0.1）`, { field: "listen", reason: "监听地址不能为空" });
      }
      if (k !== "Dynamic" && (String(v.target_host ?? "").trim() === "" || !(Number(v.target_port) > 0 && Number(v.target_port) <= 65535))) {
        throw apiError("forward_listen_failed", `转发监听失败（target）：目标主机与端口（1–65535）都要填`, { field: "target", reason: "目标主机与端口（1–65535）都要填" });
      }
      if (demoState.forwardConflictPorts.has(lport)) {
        throw apiError("forward_listen_failed", `转发监听失败（listen）：本地监听 ${v.listen_addr}:${lport} 失败：Address already in use（演示：端口占用）`, { field: "listen", reason: `本地监听 ${v.listen_addr}:${lport} 失败：端口已被占用（演示）` });
      }
      const f = { id: "f-demo-" + demoSeq++, spec, state: "Listening", error: null };
      s.forwards.push(f);
      audit("human", "forward_start", null, null, s.id, { forward: f.id, spec });
      return f.id;
    }
    case "stop_forward": {
      const s = demoState.sessions.find((x) => x.id === args?.sid);
      if (!s) throw apiError("session_not_found", "会话不存在（演示）");
      const i = s.forwards.findIndex((f) => f.id === args?.id);
      if (i < 0) throw apiError("invalid_input", "转发不存在或已停止（演示）");
      const [f] = s.forwards.splice(i, 1);
      audit("human", "forward_stop", null, null, s.id, { forward: f.id });
      return null;
    }
    // ---- C5（R32）传输注册表模拟：真实核心同契约（创建先注册返回任务 ID 再开始
    // 读写；进度分片推进 ~6.7 片/秒，前端 200ms 合并幂等吸收；取消 → Cancelling →
    // 下一片 Cancelled）。fail-demo 文件名注入失败；demo 模拟不走审批。 ----
    case "upload_file":
    case "download_file": {
      const s = demoState.sessions.find((x) => x.id === args?.sid);
      if (!s) throw apiError("session_not_found", "会话不存在（演示）");
      const kind = cmd === "upload_file" ? "Upload" : "Download";
      const source = kind === "Upload" ? String(args?.local) : String(args?.remote);
      const dest = kind === "Upload"
        ? String(args?.remote)
        : String(args?.local ?? `~/Downloads/${String(args?.remote).split("/").pop() ?? "file"}`);
      const t: DemoTransfer = {
        id: "t-demo-" + demoSeq++,
        session_id: s.id, kind, source, dest,
        status: "Queued", bytes_done: 0,
        total: 3 * 1024 * 1024 + (demoSeq % 5) * 131072,
        revision: 1,
        created_at: Math.floor(Date.now() / 1000),
        finished_at: null, error: null, retry_of: null,
        collision_decision: null, decision_prompt: null,
      };
      demoState.transfers.unshift(t);
      audit("human", "transfer_start", null, null, s.id, { transfer: t.id, kind: kind.toLowerCase(), source, dest });
      // R35 源侧目录判别（生产契约：目录明确不支持，源侧先行，零 staging）：
      // dir-demo 标记即如实失败（真实面=core ns_stat is_dir 拒绝）
      if (source.includes("dir-demo")) {
        t.status = "Failed"; t.error = "目录传输不支持：仅支持单文件（目录请先打包）";
        t.finished_at = Math.floor(Date.now() / 1000); t.revision += 1;
        return {
          id: t.id, session_id: s.id, kind,
          local: kind === "Upload" ? source : dest,
          remote: kind === "Upload" ? dest : source,
        };
      }
      // C6/R34 冲突判别面：目标名注入标记即触发预检冲突（预检在数据阶段之前——
      // 与真实核心同序，冲突不发生字节传输，故不走 step 链）。recheck-demo 首轮
      // 裁决后再触发一次「预检后已变化」冲突（stat_changed_since_preflight）。
      const base = dest.split("/").pop() ?? "";
      if (base.includes("conflict-demo") || base.includes("recheck-demo")) {
        t.status = "AwaitingDecision"; t.revision += 1;
        t.decision_prompt = {
          target_path: dest,
          target_stat: { size: 2048, mtime: 1790000000 },
          reason: "target_exists",
        };
        return {
          id: t.id, session_id: s.id, kind,
          local: kind === "Upload" ? source : dest,
          remote: kind === "Upload" ? dest : source,
        };
      }
      // R35 §366：经演示域并发闸启动（全局 4/每会话 2，排队保持 Queued）
      demoLaunchTransferSteps(t);
      return {
        id: t.id, session_id: s.id, kind,
        local: kind === "Upload" ? source : dest,
        remote: kind === "Upload" ? dest : source,
      };
    }
    case "list_transfers":
      // 与核心全量快照一致（rev-r32 低-4：截断会让演示域对账面失真）
      return [...demoState.transfers];
    // ---- C6（R34）冲突裁决命令（人类域）。守卫同核心：仅 AwaitingDecision 可决
    // （invalid_transfer_state）；expect_revision 陈旧 → stale_decision 带当前
    // revision（UI 判别后按「已过期」处置：toast+作废留痕）。 ----
    case "submit_collision_decision": {
      const t = demoState.transfers.find((x) => x.id === args?.id);
      if (!t) throw apiError("invalid_input", "transfer not found（演示）");
      if (t.status !== "AwaitingDecision") {
        throw apiError("invalid_transfer_state", `任务不在待决状态（当前 ${t.status}）`, { task_id: t.id, state: t.status });
      }
      const expect = args?.expectRevision as number | undefined;
      if (expect !== t.revision) {
        throw apiError("stale_decision", "决策基于的版本已过期（任务已变化）", { current_revision: t.revision });
      }
      const d = args?.decision as string;
      if (d !== "skip" && d !== "overwrite" && d !== "keepboth") {
        throw apiError("invalid_input", "decision 取值非法（演示）");
      }
      const now = Math.floor(Date.now() / 1000);
      const base = t.dest.split("/").pop() ?? "";
      t.collision_decision = d;
      if (d === "skip") {
        t.status = "Skipped"; t.decision_prompt = null;
        t.error = "已跳过：同名目标未改动"; t.finished_at = now; t.revision += 1;
      } else if (d === "overwrite") {
        // DF6.1 能力矩阵冻结：覆盖发布需目标版本约束——SFTP v3+OpenSSH 扩展不
        // 提供，一律阻止（不双改名/bak/回滚；文案与核心 ReplaceUnsupported 一致）
        t.status = "Failed"; t.decision_prompt = null;
        t.error = "发布能力不足，已阻止（原目标未改动）: target_version_constraint";
        t.finished_at = now; t.revision += 1;
      } else {
        // keepboth：recheck-demo 首轮 → 复检发现目标已变化（原因可查落字段），
        // 二次裁决后才发布；其余直接以新名发布 name.tinyssh-1.ext
        if (base.includes("recheck-demo") && t.decision_prompt?.reason === "target_exists") {
          t.status = "AwaitingDecision"; t.revision += 1;
          t.decision_prompt = {
            target_path: t.dest,
            target_stat: { size: 777, mtime: Math.floor(Date.now() / 1000) },
            reason: "stat_changed_since_preflight",
          };
        } else {
          const dot = base.lastIndexOf(".");
          const candidate = dot > 0
            ? `${base.slice(0, dot)}.tinyssh-1${base.slice(dot)}`
            : `${base}.tinyssh-1`;
          t.dest = t.dest.slice(0, t.dest.length - base.length) + candidate;
          t.status = "Running"; t.decision_prompt = null; t.revision += 1;
          const step2 = () => {
            const cur = demoState.transfers.find((x) => x.id === t.id);
            if (!cur) return;
            const now2 = Math.floor(Date.now() / 1000);
            if (cur.status === "Cancelling") {
              cur.status = "Cancelled"; cur.error = "已取消"; cur.finished_at = now2; cur.revision += 1;
              return;
            }
            if (cur.status !== "Running") return;
            cur.bytes_done = Math.min(cur.total ?? Infinity, cur.bytes_done + 393216);
            cur.revision += 1;
            if (cur.total != null && cur.bytes_done >= cur.total) {
              cur.status = "Succeeded"; cur.finished_at = now2; cur.revision += 1;
              return;
            }
            window.setTimeout(step2, 150);
          };
          window.setTimeout(step2, 150);
        }
      }
      audit("human", "transfer_decision", null, null, t.session_id, { transfer: t.id, decision: d });
      return { ...t };
    }
    case "reject_expired_decision": {
      // 决策卡作废：仅待决态落终态（Cancelled），否则幂等 no-op
      const t = demoState.transfers.find((x) => x.id === args?.id);
      if (!t) return null;
      if (t.status === "AwaitingDecision") {
        const now = Math.floor(Date.now() / 1000);
        t.status = "Cancelled"; t.error = "决策卡已作废";
        t.decision_prompt = null; t.finished_at = now; t.revision += 1;
        audit("human", "transfer_decision_rejected", null, null, t.session_id, { transfer: t.id });
      }
      return null;
    }
    case "verify_transfer_outcome": {
      // 重新核实（仅 OutcomeUnknown）：演示域无绑定证据（temp 不可达、恢复面
      // journal 不可达）——重核仅刷新提示与 revision，状态保持未知（不虚构已核实）
      const t = demoState.transfers.find((x) => x.id === args?.id);
      if (!t) throw apiError("invalid_input", "transfer not found（演示）");
      if (t.status !== "OutcomeUnknown") {
        throw apiError("invalid_transfer_state", `仅结果未知任务可重新核实（当前 ${t.status}）`, { task_id: t.id, state: t.status });
      }
      t.error = "重新核实完成：演示域无法确证提交结果，任务保持未知（temp 与恢复资料保留）";
      t.revision += 1;
      audit("human", "transfer_outcome_reverify", null, null, t.session_id, { transfer: t.id });
      return { ...t };
    }
    case "cancel_transfer": {
      const t = demoState.transfers.find((x) => x.id === args?.id);
      if (!t) throw apiError("invalid_input", "transfer not found（演示）");
      if (t.status === "AwaitingDecision") {
        // 待决中无 step 链可走：直接落终态（提交尚未开始，取消线性化在前）
        const now = Math.floor(Date.now() / 1000);
        t.status = "Cancelled"; t.error = "已取消（冲突待决中）";
        t.decision_prompt = null; t.finished_at = now; t.revision += 1;
        audit("human", "transfer_cancel", null, null, t.session_id, { transfer: t.id });
      } else if (!TRANSFER_TERMINAL.includes(t.status)) {
        t.status = "Cancelling"; t.revision += 1;
        audit("human", "transfer_cancel", null, null, t.session_id, { transfer: t.id });
      }
      return null;
    }
    // ---- C5/R35 失败重试：以原参数创建新任务（retry_of=旧任务）重新走编排
    //（演示域=重新过闸+注入标记仍在，fail-demo 重试会再次失败=「重新校验」语义）。
    // 仅 Failed/Cancelled/Skipped/Interrupted；unknown 结构化拒绝（§374）。 ----
    case "retry_transfer": {
      const old = demoState.transfers.find((x) => x.id === args?.id);
      if (!old) throw apiError("invalid_input", "transfer not found（演示）");
      if (old.status === "OutcomeUnknown") {
        throw apiError("invalid_transfer_state", "结果未知：请先「重新核实」（重试不能代替核实）",
          { task_id: old.id, state: old.status });
      }
      if (!["Failed", "Cancelled", "Skipped", "Interrupted"].includes(old.status)) {
        throw apiError("invalid_transfer_state", `仅失败/已取消/已跳过/中断的任务可重试（当前 ${old.status}）`,
          { task_id: old.id, state: old.status });
      }
      const s = demoState.sessions.find((x) => x.id === old.session_id);
      if (!s) throw apiError("session_not_found", "原会话不存在——重试需重新校验连接（演示）");
      const t: DemoTransfer = {
        id: "t-demo-" + demoSeq++,
        session_id: s.id, kind: old.kind, source: old.source, dest: old.dest,
        status: "Queued", bytes_done: 0, total: old.total, revision: 1,
        created_at: Math.floor(Date.now() / 1000),
        finished_at: null, error: null, retry_of: old.id,
        collision_decision: null, decision_prompt: null,
      };
      demoState.transfers.unshift(t);
      audit("human", "transfer_retry", null, null, s.id, { retry_of: old.id, new: t.id });
      demoLaunchTransferSteps(t);
      return {
        id: t.id, session_id: s.id, kind: t.kind,
        local: t.kind === "Upload" ? t.source : t.dest,
        remote: t.kind === "Upload" ? t.dest : t.source,
      };
    }
    // R35 S08「定位」下载分支（访达显示本地目标）：演示域无真实 Finder——no-op，
    // 真实面=原生 reveal_path（open -R）
    case "reveal_path":
      return null;
    case "note_terminal":
    case "open_url":
    case "get_setting":
    case "set_setting":
    case "bench_start":
    case "bench_report":
      return null;
    // ---- C8 偏好与主机元数据（R15 同契约）----
    case "get_workspace": {
      // 浏览器域：localStorage 同键承载（与真实核心的 settings 表同为整取整存）
      try {
        const raw = localStorage.getItem("ui.v2.workspace");
        if (raw) return JSON.parse(raw);
      } catch { /* 损坏自愈回落默认 */ }
      return { schema_version: 1, chrome: "system", hostbar: null, terminal: null };
    }
    case "set_workspace": {
      const ws = { ...(args?.ws as Record<string, unknown>), schema_version: 1 };
      localStorage.setItem("ui.v2.workspace", JSON.stringify(ws));
      return ws;
    }
    case "set_host_favorite": {
      const hid = args?.hostId as string;
      const h = demoState.hosts.find((x) => x.id === hid);
      if (!h) throw apiError("invalid_input", "HostNotFound（演示）");
      const m = demoState.hostMeta.get(hid) ?? { favorite: false, last_connected_at: null };
      m.favorite = args?.favorite as boolean;
      demoState.hostMeta.set(hid, m);
      audit("human", "host_favorite", null, null, null, { host: h.name, favorite: m.favorite });
      return null;
    }
    case "list_host_metadata":
      return [...demoState.hostMeta.entries()].map(([host_id, m]) => ({
        host_id,
        favorite: m.favorite,
        last_connected_at: m.last_connected_at,
      }));
    case "list_recent_hosts": {
      // DF8.5：sessions 派生、排除 local、每主机最近一次、倒序上限 5
      const lastByHost = new Map<string, string>();
      for (const s of demoState.sessions) {
        if (s.kind === "local" || !s.host_id) continue;
        const prev = lastByHost.get(s.host_id);
        if (!prev || s.created_at > prev) lastByHost.set(s.host_id, s.created_at);
      }
      return [...lastByHost.entries()]
        .map(([host_id, at]) => {
          const h = demoState.hosts.find((x) => x.id === host_id);
          return { host_id, host_name: h?.name ?? host_id, connected_at: at };
        })
        .sort((a, b) => (a.connected_at < b.connected_at ? 1 : -1))
        .slice(0, 5);
    }
    default:
      throw apiError("invalid_input", "演示 shim 未实现该命令：" + cmd);
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
