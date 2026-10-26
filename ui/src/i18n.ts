// 界面语言（i18n 轮）：字典反转 t() 包裹——**中文原文即键**，EN 表查得到译英文，
// 查不到原样透传（铺开是渐进的，缺口如实显示中文，不虚构半截翻译）。
// 默认 zh：全部既有 spec 的中文断言零扰动。
// - 存储与既有设置同通路：vault settings KV（真实域）/ demo 镜像（演示域），
//   键 ui.v2.locale；localStorage 只作 t() 模块初值的即时读（demo 域持久落点）。
// - 刷新语义：t() 读模块级 current，locale 是 App 的 state——切换后 App 重渲染，
//   全部渲染期 t() 调用重读。**不 remount**：xterm 实例与会话原样保留。
// - 铁律：**模块 import 期不得调用 t()**（数据表如 PALETTES 的 label 存原中文，
//   在渲染期消费点套 t()；取值函数如 stateLabel 内部套是安全的——它们只在渲染期被调）。

export type Locale = "zh" | "en";

export const SETTING_LOCALE = "ui.v2.locale";
const LS_KEY = "ui.v2.locale";

/** 模块初值：localStorage 即时读（真实域随后会被 KV 装载覆盖；demo 域这就是持久层）。 */
export function readLocale(): Locale {
  try {
    return localStorage.getItem(LS_KEY) === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

export function writeLocale(l: Locale): void {
  try {
    localStorage.setItem(LS_KEY, l);
  } catch {
    /* 裸 localStorage 包 try（稳定性轮惯例） */
  }
}

let current: Locale = readLocale();

export function localeNow(): Locale {
  return current;
}

/** 切换语言（设置面板唯一调用口）：写模块态 + 双域持久化。渲染刷新由 App 的
 *  locale state 触发，这里不碰 React。 */
export function setLocale(l: Locale): void {
  current = l;
  writeLocale(l);
}

/** 翻译：中文原文即键。带参时 zh/en 文案里的 {0}{1}… 按位替换（zh 键本身含占位符，
 *  不会原样渲染——查表替换后返回）。 */
export function t(zh: string, ...args: (string | number)[]): string {
  let s = current === "en" ? (EN[zh] ?? zh) : zh;
  if (args.length > 0) s = s.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m));
  return s;
}

const EN: Record<string, string> = {
  // —— app-data：设置分类（导航） ——
  "外观": "Appearance",
  "色板 · 字号 · 缩放": "Palette · font size · zoom",
  "快捷键": "Keyboard shortcuts",
  "新建 · 关签 · 分屏 · 面板": "New tab · close · split · panels",
  "终端": "Terminal",
  "粘贴 · 复制 · 通知": "Paste · copy · notifications",
  "输出触发器": "Output triggers",
  "输出正则 → 通知 / 键序": "Output regex → notify / keys",
  "凭据": "Credentials",
  "密钥与口令": "Keys and passphrases",
  "Agent 接入": "Agent access",
  "MCP 协作": "MCP collaboration",
  "记录审计": "Records & audit",
  "时间线 · 导出": "Timeline · export",
  "关于": "About",
  "版本与数据": "Version & data",

  // —— app-data：审计动作（活动记录/记录时间线/事件类型筛选） ——
  "连接主机": "Connect host",
  "断开会话": "Close session",
  "重连会话": "Reconnect session",
  "注入 Shell 集成": "Inject shell integration",
  "保存主机": "Save host",
  "删除主机": "Delete host",
  "添加凭据": "Add credential",
  "删除凭据": "Delete credential",
  "执行命令": "Run command",
  "中断命令": "Interrupt command",
  "拦截危险命令": "Block dangerous command",
  "发送按键": "Send keys",
  "请求审批": "Approval requested",
  "审批决定": "Approval decision",
  "拒绝审批": "Approval denied",
  "作废审批": "Approval voided",
  "接管会话": "Take over session",
  "交还会话": "Hand back session",
  "传输完成": "Transfer done",
  "传输作废": "Transfer voided",
  "传输失败": "Transfer failed",
  "启动端口转发": "Start port forward",
  "停止端口转发": "Stop port forward",
  "请求认证输入": "Auth input requested",
  "应答认证输入": "Auth input answered",
  "请求指纹确认": "Host-key confirm requested",
  "指纹确认决定": "Host-key decision",
  "信任主机指纹": "Host key trusted",
  "拒绝主机指纹": "Host key rejected",
  "委托会话": "Session delegated",
  "停止重连": "Stop reconnecting",
  "审批超时": "Approval timeout",
  "停用协作": "Disable collaboration",
  "停用协作失败": "Disable collaboration failed",
  "连接失败": "Connection failed",
  "取消连接": "Connection cancelled",
  "取消连接（会话已闭）": "Connection cancelled (session closed)",
  "取消连接收尾失败": "Connection cancel cleanup failed",
  "转发监听失败": "Forward listen failed",
  "收藏主机": "Favorite host",
  "认证失败": "Authentication failed",
  "上传文件": "Upload file",
  "下载文件": "Download file",
  "查看文件信息": "Stat file",
  "取消传输": "Cancel transfer",
  "重试传输": "Retry transfer",
  "传输中断": "Transfer interrupted",
  "查看传输列表": "List transfers",
  "传输冲突决定": "Transfer conflict decision",
  "冲突决定被拒": "Conflict decision rejected",
  "传输结果未知": "Transfer outcome unknown",
  "传输结果已核实": "Transfer outcome verified",
  "传输结果复检": "Transfer outcome re-verified",
  "重启恢复传输完成": "Transfer restored after restart",
  "传输发布被阻": "Transfer publish blocked",
  "临时文件清理失败": "Temp file cleanup failed",
  "更新/清除任务目标": "Update/clear task goal",
  "清除任务目标": "Clear task goal",
  "更新任务目标": "Update task goal",
  "作废审批（接管）": "Approval voided (takeover)",
  "作废审批（会话关闭）": "Approval voided (session closed)",
  "批准（编辑后）": "Approved (edited)",
  "批准": "Approve",

  // —— app-data：状态/相位/审批/退出码 ——
  "连接中…": "Connecting…",
  "等待指纹确认": "Waiting for host-key confirmation",
  "认证中…": "Authenticating…",
  "等待验证码": "Waiting for verification code",
  "✓ 批准": "✓ Approved",
  "✓ 批准（编辑后）": "✓ Approved (edited)",
  "✕ 拒绝": "✕ Denied",
  "⏱ 超时未审": "⏱ Timed out",
  "⊘ 已作废（接管/会话关闭）": "⊘ Voided (takeover/close)",
  "已核实": "Verified",
  "需复核": "Needs recheck",
  "未观测": "Not observed",
  "成功": "Success",
  "Ctrl+C 中断": "Interrupted (Ctrl+C)",
  "已结束（退出码未知）": "Finished (exit code unknown)",
  "退出码 {0}": "Exit code {0}",
  "已连接": "Connected",
  "连接中断": "Disconnected",
  "重连中…": "Reconnecting…",
  "重确认": "Re-confirming",
  "已断开": "Disconnected",
  "已停止（exit {0}）": "Stopped (exit {0})",
  "升级后仍未停止": "Still not stopped after upgrade",
  "升级后停止": "Stopped after upgrade",

  // —— app-data：friendlyError（后端错误 → 人话） ——
  "凭据仍被 {0} 台主机使用（{1}）——请先为这些主机改绑凭据或删除主机":
    "Credential still used by {0} host(s) ({1}) — rebind or delete those hosts first",
  "凭据仍被主机使用——请先解除引用后再删除": "Credential still in use — remove references before deleting",
  "认证失败：用户名或密码/密钥不正确": "Authentication failed: wrong username, password or key",
  "2FA 认证未完成：人工应答被取消或超时，连接已中止（凭据未被改动，可重新连接）":
    "2FA incomplete: manual answer cancelled or timed out, connection aborted (credentials untouched, you can retry)",
  "连接被拒绝：端口不对，或主机上的 SSH 服务没有运行":
    "Connection refused: wrong port, or no SSH service running on the host",
  "连接超时：主机不可达（地址错误、网络不通或防火墙拦截）":
    "Connection timed out: host unreachable (wrong address, network down, or firewall)",
  "地址无法解析：请检查主机名/IP 是否写对": "Cannot resolve address: check the hostname/IP",
  "凭据库解锁失败：": "Failed to unlock credential store: ",
  "凭据解密失败：本机主密钥与保存密码时不一致。编辑该主机重新输入密码并保存即可（会用当前密钥重新加密）；若多台主机同时如此，通常与应用启动方式变更有关":
    "Credential decryption failed: this machine's master key differs from the one used when the password was saved. Edit the host, re-enter the password and save (it re-encrypts with the current key); if many hosts are affected, the app's launch method probably changed",

  // —— keymap 动作（设置 → 快捷键 键位卡） ——
  "新建连接": "New connection",
  "打开主机栏添加表单": "Open the hosts panel add form",
  "关闭当前标签": "Close current tab",
  "活动会话先确认影响": "Confirm impact first for live sessions",
  "新建本地终端": "New local terminal",
  "直接连接「本机」开本地 shell": "Connect to \"This machine\" for a local shell",
  "分屏 / 退出分屏": "Split / exit split",
  "未分屏时弹会话选择（左右/上下方向）": "Pick a session when not split (side-by-side / top-bottom)",
  "命令面板": "Command palette",
  "命令与跳转": "Commands & navigation",
  "主机栏开关": "Toggle hosts panel",
  "表单编辑焦点下不劫持": "Never hijacks while a form field has focus",
  "搜索终端内容": "Search terminal content",
  "当前会话缓冲内查找": "Find in the current session's buffer",

  // —— 设置面板：框架与导航 ——
  "设置": "Settings",
  "外观、终端与凭据——预览即时生效，凭据显式提交": "Appearance, terminal and credentials — previews apply instantly; credentials save on submit",
  "关闭": "Close",
  "关闭设置": "Close settings",
  "设置分类": "Settings categories",

  // —— 设置面板：外观 ——
  "应用外观": "App appearance",
  "主题同时决定应用外壳与终端配色（底色/前景/光标/ANSI 16 色全部随当前色板与深浅派生，终端八色按族调相）；主按钮与指示件走鲜艳填充档（浅色下不再为可读性压暗）；「跟随系统」随系统深浅实时切换。":
    "The theme decides both app chrome and terminal colors (background/foreground/cursor/ANSI-16 all derive from the active palette and light-dark mode); primary buttons use vivid fills; \"Follow system\" tracks the OS in real time.",
  "跟随系统": "Follow system",
  "深色": "Dark",
  "浅色": "Light",
  "主题": "Theme",
  "字号与缩放": "Font size & zoom",
  "字号作用于全部终端；缩放作用于整个界面（webview）。": "Font size applies to all terminals; zoom scales the whole UI (webview).",
  "减小字号": "Decrease font size",
  "增大字号": "Increase font size",
  "重置": "Reset",
  "界面缩放": "UI zoom",
  "界面缩放：Ctrl/⌘ + 放大 · − 缩小 · 0 复位 · Ctrl+滚轮（原生窗口生效）":
    "Zoom: Ctrl/⌘ + in · − out · 0 reset · Ctrl+wheel (native window)",
  "界面语言": "Interface language",
  "中文（默认）": "中文 (default)",
  "English": "English",
  "切换立即生效；界面铺开翻译中，未覆盖文案保持中文。": "Applies immediately; translation coverage is growing — untranslated strings stay Chinese.",

  // —— 设置面板：快捷键 ——
  "应用快捷键": "App shortcuts",
  "点「修改」后按下新组合（Ctrl/⌘ + 字母，可加 Shift），Esc 取消。被占用的字母不再发往终端——同名 shell 控制键让位（如 Ctrl+D=分屏后，EOF 请用 exit）。Ctrl+1-9 切换标签 · Ctrl+Tab 循环 · Ctrl/⌘ ±/0 缩放 · Esc 关浮层为固定键位。":
    "Click \"Edit\" then press the new combo (Ctrl/⌘ + letter, Shift allowed); Esc cancels. Bound letters no longer reach the terminal — the matching shell control key yields (e.g. after Ctrl+D = split, use exit for EOF). Fixed: Ctrl+1-9 switch tabs · Ctrl+Tab cycle · Ctrl/⌘ ±/0 zoom · Esc closes overlays.",
  "快捷键绑定": "Shortcut bindings",
  "按下新组合…": "Press new combo…",
  "取消": "Cancel",
  "修改": "Edit",
  "全部恢复默认": "Restore all defaults",

  // —— 设置面板：终端行为 ——
  "终端行为": "Terminal behavior",
  "多行粘贴保护": "Multi-line paste guard",
  "内容含换行且远端未开启 bracketed paste 时，先预览确认再发送，防止把本地多行文本误当命令流灌进远端；内容命中危险形态（如 rm -rf /、mkfs、dd 覆写块设备——与 Agent 审批同一张内置规则表）时同样先确认。关闭后立即发送。":
    "When content has newlines and the remote lacks bracketed paste, preview and confirm before sending, so local multi-line text isn't dumped into the remote as a command stream; dangerous patterns (rm -rf /, mkfs, dd over block devices — same built-in rule table as agent approvals) also confirm first. Off = send immediately.",
  "选中即复制": "Copy on select",
  "划选终端文字立即写入系统剪贴板（PuTTY/Xshell 惯例，默认关）；关闭后用 ⌘C 或右键「复制」。":
    "Selecting terminal text copies it to the system clipboard (PuTTY/Xshell convention, off by default); when off use ⌘C or right-click \"Copy\".",
  "终端响铃时系统通知": "System notification on terminal bell",
  "窗口不在前台时收到远端 BEL（如长命令完成）即发系统通知，每会话 10 秒至多一条；标签闪烁提醒恒开。远端 OSC 9 主动通知、后台会话命令失败（shell 集成 OSC 133 退出码）走同一开关与节流。":
    "When the window is not focused, a remote BEL (e.g. a long command finishing) raises a system notification — at most one per session per 10s; tab flashing is always on. Remote OSC 9 notifications and background command failures (shell-integration OSC 133 exit codes) share this switch and throttle.",
  "远端写剪贴板（OSC 52）": "Remote clipboard writes (OSC 52)",
  "远端程序可用转义序列改写你本机剪贴板——tmux/ssh 里复制回本地靠它，也可能被用来投毒（悄悄替换你将要粘贴的内容）。读取类请求（查询）一律拒绝；写入按此策略执行，「拒绝」为静默丢弃。":
    "Remote programs can rewrite your local clipboard via escape sequences — how tmux/ssh copy-back works, and also a poisoning vector (silently replacing what you'll paste next). Read requests (queries) are always denied; writes follow this policy, \"Deny\" drops silently.",
  "每次询问（默认）": "Ask every time (default)",
  "允许": "Allow",
  "拒绝": "Deny",
  "本地 Shell": "Local shell",
  "本地终端（含启动时自动打开的那个）使用的 shell。标注「无命令块」的 shell（cmd、WSL）无 shell 集成——命令块、现场延续与 Shell 模式执行不可用，如实降级为纯终端。":
    "The shell local terminals use (including the one auto-opened at startup). Shells marked \"no command blocks\" (cmd, WSL) lack shell integration — command blocks, session continuity and shell-mode exec are unavailable, honestly downgraded to a plain terminal.",
  "系统默认（$SHELL / PowerShell）": "System default ($SHELL / PowerShell)",
  "（无命令块）": " (no command blocks)",

  // —— 设置面板：终端外观 ——
  "终端外观": "Terminal appearance",
  "作用于全部终端，改动即时生效；字体族/字距改变字符度量，会重排版并按新尺寸校准远端 PTY。":
    "Applies to all terminals, effective immediately; font family/letter-spacing change character metrics — the layout reflows and the remote PTY is re-calibrated to the new size.",
  "字体": "Font",
  "默认内置 Maple Mono 圆润中文等宽（中文输出对齐不落宋体）；JetBrains Mono 全量字形（框线/箭头/powerline）；其余选项按系统是否安装回落，中文一律垫 MiSans/雅黑。":
    "Bundled Maple Mono CN is the default (CJK stays monospace, never falls to SimSun); JetBrains Mono ships full glyphs (box-drawing/arrows/powerline); other options fall back by availability, CJK always backed by MiSans/YaHei.",
  "连字（ligatures）": "Ligatures",
  "把 =&gt;、!=、&gt;= 等合成连字图形（字体需含连字字形）。开启即改用 DOM 渲染器（关闭 GPU 合成），高吞吐输出时 CPU 占用更高——默认关。":
    "Renders =>, !=, >= etc. as ligature glyphs (font must contain them). Enabling switches to the DOM renderer (GPU compositing off) — higher CPU on heavy output. Off by default.",
  "光标样式": "Cursor style",
  "默认光标形状；vim 等程序可在其运行期自行覆盖。": "Default cursor shape; programs like vim may override it while running.",
  "方块": "Block",
  "竖线": "Bar",
  "下划线": "Underline",
  "光标闪烁": "Cursor blink",
  "关闭后光标恒亮不闪。": "Off = cursor stays solid.",
  "滚动历史": "Scrollback",
  "每会话回滚缓冲行数；越大越吃内存（长构建 / 大日志建议 5 万行以上）。":
    "Scrollback lines per session; more lines use more memory (long builds / big logs: 50k+ recommended).",
  "10,000 行（默认）": "10,000 lines (default)",
  "{0} 行": "{0} lines",
  "字距": "Letter spacing",
  "额外字符间距（px）；0 为字体原生度量。": "Extra spacing between characters (px); 0 = font-native metrics.",
  "0（默认）": "0 (default)",

  // —— 设置面板：输出触发器 ——
  "载入中…": "Loading…",
  "终端输出按<b>完整行</b>匹配正则（匹配前剥离颜色码；跨行不命中——如实边界）。命中「通知」= toast + 标签铃；命中「发送键序」= 建审批卡等你裁决，批准才会发送，绝不静默自动执行。键序支持转义：\\r 回车、\\n 换行、\\t 制表、\\\\ 反斜杠。同规则同会话受冷却节流（5–3600 秒）；最多 32 条。":
    "Terminal output is matched by regex against <b>whole lines</b> (color codes stripped first; no cross-line matches — an honest limit). \"Notify\" = toast + tab bell; \"Send keys\" = an approval card awaits your decision, nothing is sent without approval, never silently auto-run. Keys support escapes: \\r enter, \\n newline, \\t tab, \\\\ backslash. Per rule+session cooldown (5–3600s); max 32 rules.",
  "还没有规则——用「新增规则」建第一条。": "No rules yet — use \"Add rule\" to create the first one.",
  "规则名": "Rule name",
  "启用": "Enabled",
  "删除规则": "Delete rule",
  "删除规则 {0}": "Delete rule {0}",
  "正则（按行匹配，如 BUILD FAILED）": "Regex (line match, e.g. BUILD FAILED)",
  "触发动作": "Trigger action",
  "动作：通知（toast + 标签铃）": "Action: notify (toast + tab bell)",
  "动作：发送键序（需审批）": "Action: send keys (requires approval)",
  "要发送的键序（如 y\\r）": "Keys to send (e.g. y\\r)",
  "新增规则": "Add rule",
  "保存中…": "Saving…",
  "保存": "Save",
  "已保存 {0} 条（发送键序 {1} 条）。命中即生效；发送动作仍会建审批卡等你裁决。":
    "Saved {0} rule(s) ({1} send-keys). Matches take effect at once; send actions still raise an approval card for you to decide.",

  // —— 设置面板：凭据 ——
  "凭据库": "Credential store",
  "收起": "Collapse",
  "新建凭据…": "New credential…",
  "名称": "Name",
  "例如 prod-key": "e.g. prod-key",
  "生成 Ed25519": "Generate Ed25519",
  "生成 RSA": "Generate RSA",
  "新密钥": "New key",
  "粘贴私钥（OpenSSH / PEM）": "Paste private key (OpenSSH / PEM)",
  "私钥口令（没有可留空）": "Key passphrase (leave empty if none)",
  "导入密钥": "Imported key",
  "处理中…": "Working…",
  "导入并保存": "Import & save",
  "只有点「生成」或「导入并保存」才落库；取消或关闭对话框都不会留下半成品。":
    "Only \"Generate\" or \"Import & save\" writes to the store; cancel or closing the dialog leaves nothing behind.",
  "已保存「{0}」·": "Saved \"{0}\" ·",
  "指纹": "fingerprint",
  "凭据表单里还有未提交的私钥内容——切到「{0}」会丢弃它。":
    "The credential form still holds an unsubmitted private key — switching to \"{0}\" will discard it.",
  "丢弃草稿并切换": "Discard draft & switch",
  "留下继续编辑": "Keep editing",
  "还没有凭据——用右上角的「新建凭据…」生成或导入私钥，也可以在连接表单里保存。":
    "No credentials yet — use \"New credential…\" (top right) to generate or import a key, or save one in the connect form.",
  "使用中": "In use",
  "未被任何主机引用——保留在库中，可在表单里绑定": "Not referenced by any host — kept in the store, bindable in forms",
  "未绑定": "Unbound",
  "删除凭据（被引用会被拒绝并列出主机）": "Delete credential (referenced ones are rejected with a host list)",
  "删除凭据 {0}": "Delete credential {0}",
  "密码": "Password",
  "RSA 密钥": "RSA key",
  "Ed25519 密钥": "Ed25519 key",
  "用于：{0}（换绑请到对应主机的编辑表单）": "Used by: {0} (rebind in each host's edit form)",
  "删除前自动检查引用；指纹用于核对库里存的是哪把钥匙，不会出现在日志里。":
    "References are checked before deletion; the fingerprint identifies which key is stored — it never appears in logs.",

  // —— 设置面板：Agent 接入 ——
  "Agent 接入（MCP）": "Agent access (MCP)",
  "已配置 {0}": "{0} configured",
  "有活动请求 {0}": "{0} active requests",
  "MCP 端点随本应用自动运行。为 Agent 签发 Token 后，它的操作请求会进入协作面板逐条审批。":
    "The MCP endpoint runs automatically with this app. After you issue an agent token, its operation requests arrive in the collaboration panel for per-item approval.",
  "id（如 my-codex）": "id (e.g. my-codex)",
  "Agent id": "Agent id",
  "名称（可选）": "Name (optional)",
  "Agent 名称": "Agent name",
  "Token 有效期": "Token validity",
  "永不过期": "Never expires",
  "{0} 天有效": "Valid {0} days",
  "签发 Token": "Issue token",
  "请填写 Agent id（如 my-codex）": "Enter an agent id (e.g. my-codex)",
  "Token 已签发（{0}）——仅此一次展示": "Token issued ({0}) — shown only once",
  "现在复制并填入 Agent 配置；关闭后无法再次查看（可吊销后重签）。":
    "Copy it into the agent's config now; it cannot be viewed again (revoke and re-issue if lost).",
  "我已保存，关闭": "Saved, close",
  " · 最近使用 {0}": " · last used {0}",
  " · 从未使用": " · never used",
  "已过期": "expired",
  "过期 {0}": "expires {0}",
  "立即收回该 Agent 的免逐条审批授权": "Revoke this agent's per-item approval exemption now",
  "关闭自主": "Autonomy off",
  "自主模式时长": "Autonomy duration",
  "{0} 分钟": "{0} min",
  "{0} 小时": "{0} h",
  "手动关闭": "Manual off",
  "确认开启？": "Confirm enable?",
  "开启后该 Agent 的命令不再逐条审批（危险命令仍拦截、全量记录）":
    "Once on, this agent's commands skip per-item approval (dangerous commands still blocked, everything recorded)",
  "免逐条审批的自主运行（危险命令仍拦截、全量记录、可急停）":
    "Autonomous operation without per-item approval (dangerous commands still blocked, fully recorded, kill switch available)",
  "自主模式": "Autonomy",
  "确认吊销？": "Confirm revoke?",
  "吊销后 token 立即失效（Agent 侧报 invalid_actor）": "Revoking invalidates the token immediately (agent sees invalid_actor)",
  "吊销": "Revoke",
  "暂无 Agent 接入——上方表单签发 Token 即完成登记。": "No agents yet — issue a token with the form above to register one.",
  "自主模式下的文件传输": "File transfers during autonomy",
  "默认传输逐条审批（最保守）。打开后：自主模式在效期间的传输不再逐条弹卡——审计与记录照常，随时刻关。":
    "By default transfers are approved one by one (most conservative). Once on: transfers during autonomy skip per-item cards — audit and records continue; toggle off anytime.",
  "免逐条审批（点击恢复审批）": "Approval-free (click to restore approval)",
  "逐条审批（点击改免审）": "Per-item approval (click to exempt)",
  "端点": "Endpoint",
  "未启动": "Not running",
  "接入文档": "Integration doc",
  "（把这个 URL 扔给 Agent，即可自助完成接入）": "(hand this URL to the agent and it onboards itself)",
  "收起接入说明": "Hide setup steps",
  "接入新 Agent": "Onboard a new agent",
  "1. MCP 端点已随本应用自动运行（地址如上，被占自动递增，无需另起 serve）；":
    "1. The MCP endpoint runs automatically with this app (address above; auto-increments if taken, no separate serve needed);",
  "2. 用上方表单签发 Token（仅展示一次；也可 CLI ": "2. Issue a token with the form above (shown once; or via CLI ",
  "）；": ");",
  "3. 在 Agent 的 MCP 配置里填入端点与 Token：": "3. Fill the endpoint and token into the agent's MCP config:",
  "或者更省事：把上面「接入文档」链接直接发给 Agent，它会按文档自助完成接入。只支持 stdio 的客户端用自带 shim（应用同目录）：":
    "Or easier: send the \"integration doc\" link to the agent and it onboards itself. For stdio-only clients use the bundled shim (next to the app):",
  "接入后，Agent 的操作请求会出现在协作面板的审批队列逐段裁决。":
    "Once onboarded, the agent's operation requests appear in the collaboration panel's approval queue for stepwise decisions.",
  "登记 Agent **不会**转移任何会话的控制权。要把某个会话交给 Agent，在会话工具栏或协作面板点「交给 Agent…」并明确确认。":
    "Registering an agent **never** transfers control of any session. To hand a session to an agent, click \"Hand to agent…\" in the session toolbar or collaboration panel and confirm explicitly.",
  "停用协作…": "Disable collaboration…",
  "协作正在停用——新 Agent 请求已被拒绝，正在收敛存量。":
    "Collaboration is being disabled — new agent requests are rejected; existing ones are draining.",
  "上次停用未完全收敛（协作保持封闭，新 Agent 请求仍被拒绝）——请先「重试停用收敛」，收敛后才可重新启用。":
    "The last disable didn't fully converge (collaboration stays closed, new agent requests still rejected) — \"Retry disable convergence\" first; re-enable only after it converges.",
  "协作已停用——MCP 端点未运行，Agent 请求一律被拒绝。要使用协作请显式启用。":
    "Collaboration is disabled — the MCP endpoint isn't running and agent requests are all rejected. Enable it explicitly to use collaboration.",
  "已配置的 Agent（Token 保留，重新启用后继续可用）：{0}": "Configured agents (tokens kept, usable again after re-enabling): {0}",
  "重试停用收敛": "Retry disable convergence",
  "启用协作": "Enable collaboration",

  // —— 设置面板：模型服务/提示词技能卡 ——
  "模型服务（内置 Agent 对话）": "Model service (built-in agent chat)",
  "配置后左侧 Agent 视图从演练外壳切换为真实模型。agent 的 exec 等操作仍走本应用既有审批链（危险命令需人工批准）。":
    "Once configured, the agent view on the left switches from the rehearsal shell to a real model. The agent's exec etc. still go through the app's existing approval chain (dangerous commands need human approval).",
  "OpenAI 兼容（GLM / DeepSeek / Qwen / Kimi…）": "OpenAI-compatible (GLM / DeepSeek / Qwen / Kimi…)",
  "base_url（可选，缺省官方端点）": "base_url (optional; official endpoint by default)",
  "模型名（如 glm-4.7）": "Model name (e.g. glm-4.7)",
  "已配置（重填可更换）": "Configured (re-enter to replace)",
  "已保存（api_key 加密入库，不回显）": "Saved (api_key stored encrypted, never echoed)",
  "提示词与技能（内置 Agent）": "Prompt & skills (built-in agent)",
  "在内置系统提示词之上追加的组织/现场约定——不改内置安全铁律（审批/不虚构等），冲突时以铁律为准。会话助手与 Fleet 编排者各一段，保存后 agent 的下一条消息即生效。技能库供 agent 用 load_skill 工具按名加载。":
    "Organization/engagement conventions appended on top of the built-in system prompt — the built-in safety rules (approvals, no fabrication, etc.) always win on conflict. Separate sections for the session assistant and the Fleet orchestrator; effective from the agent's next message. Skills are loaded by name via the agent's load_skill tool.",
  "会话助手附加提示词": "Session assistant extra prompt",
  "例如：生产库只读优先，改动先报备；机器统一 Ubuntu，用 apt 而非 yum。":
    "e.g. Production databases are read-first; report before changes. Machines are Ubuntu — use apt, not yum.",
  "清空": "Clear",
  "Fleet 编排者附加提示词": "Fleet orchestrator extra prompt",
  "例如：汇总一律用表格；失败项单独列出并给复跑建议。":
    "e.g. Summaries always as tables; list failures separately with rerun advice.",
  "技能库（{0}/32）": "Skills ({0}/32)",
  "暂无技能——添加后 agent 可用 load_skill 工具按名加载（名称 + 操作手册正文）。":
    "No skills yet — added ones are loaded by name via the agent's load_skill tool (name + playbook body).",
  "技能名（如 nginx 排障）": "Skill name (e.g. nginx troubleshooting)",
  "技能 {0} 名称": "Skill {0} name",
  "操作手册正文：步骤、验收标准、注意事项（agent 加载后照做）。":
    "Playbook body: steps, acceptance criteria, caveats (the agent follows it after loading).",
  "技能 {0} 正文": "Skill {0} body",
  "删除技能 {0}": "Delete skill {0}",
  "添加技能": "Add skill",
  "保存技能库": "Save skills",
  "技能最多 32 条": "At most 32 skills",
  "技能名称不能为空": "Skill names cannot be empty",
  "技能名称重复": "Duplicate skill names",
  "已保存（{0} 条）": "Saved ({0} entries)",

  // —— 设置面板：关于 ——
  "（{0} 编译）": " (built {0})",
  "（浏览器演示模式）": " (browser demo mode)",
  "作者：陈普": "Author: Chen Pu",
  "本地优先的 SSH 客户端：终端、主机库与凭据都留在本机。":
    "A local-first SSH client: terminals, host library and credentials all stay on this machine.",
  "凭据以加密形式存于本机凭据库，界面与日志只显示指纹。":
    "Credentials are stored encrypted in the local vault; UI and logs show fingerprints only.",
  "新版本 {0} 已发布": "New version {0} released",
  "打开发布页": "Open release page",
  "下载中…完成后自动重启": "Downloading… restarts automatically",
  "自动更新（下载并重启）": "Auto-update (download & restart)",
  "导出中…": "Exporting…",
  "导出诊断包": "Export diagnostics",
  "版本/平台/日志尾/审计条数——不含凭据与主机信息": "Version/platform/log tail/audit counts — no credentials or host info",

  "终端字体": "Terminal font",
  "滚动历史行数": "Scrollback lines",
  "字符间距": "Character spacing",
  "OSC 52 写剪贴板策略": "OSC 52 clipboard-write policy",

  // —— 右键/弹出菜单群 ——
  "下侧": "bottom",
  "右侧": "right",
  "下": "bottom",
  "右": "right",
  "上": "top",
  "左": "left",
  "左右": "side-by-side",
  "上下": "top-bottom",
  "分屏": "Split",
  "分屏方向": "Split direction",
  "左右分屏：当前会话在左，副格在右": "Side-by-side: current session left, second pane right",
  "左右分屏": "Side-by-side split",
  "上下分屏：当前会话在上，副格在下": "Top-bottom: current session on top, second pane below",
  "上下分屏": "Top-bottom split",
  "在{0}显示已有会话": "Show an existing session in the {0}",
  "（复用现有连接，不新建）": " (reuses the existing connection, no new one)",
  "暂无其他会话": "No other sessions",
  "新建的会话先落在标签栏——右键标签选「与当前会话分屏」即可。": "New sessions land in the tab bar first — right-click a tab and choose \"Split with current session\".",
  "会话操作：{0}": "Session actions: {0}",
  "退出分屏（两个会话都保留）": "Exit split (both sessions kept)",
  "改为{0}分屏": "Switch to {0} split",
  "放到{0}侧分屏（替换{0}格）": "Split into the {0} pane (replaces it)",
  "与当前会话分屏（放到{0}侧）": "Split with current session (into the {0})",
  "分屏（选择{0}侧会话）…": "Split (pick the {0} session)…",
  "新建一条同主机连接并放入{0}侧窗格（当前会话留在{1}侧）": "Opens a new connection to the same host in the {0} pane (current session stays {1})",
  "分屏：复制标签页到{0}侧（新会话）": "Split: duplicate tab to the {0} (new session)",
  "停止自动重连": "Stop auto-reconnect",
  "用同一台主机新建一条会话（现有会话不受影响）": "New session on the same host (existing sessions untouched)",
  "复制标签页（同主机新会话）": "Duplicate tab (new session, same host)",
  "自定义标签显示名（清空恢复主机名）；也可双击标签": "Custom tab display name (empty restores the host name); double-click the tab also works",
  "重命名标签…": "Rename tab…",
  "把该会话收到的全部输出记录到本地日志文件（data/logs 目录，追加写入）": "Record all output of this session to a local log file (data/logs, appended)",
  "停止记录会话日志": "Stop session log",
  "记录会话日志": "Record session log",
  "打开日志文件夹": "Open log folder",
  "连接详情…": "Connection details…",
  "关闭会话…": "Close session…",
  "主机操作：{0}": "Host actions: {0}",
  "用 {0} 新开本地终端": "Open a new local terminal with {0}",
  "用 {0} 新开（无 shell 集成：命令块/现场延续不可用）": "Open with {0} (no shell integration: no command blocks / session continuity)",
  "用 {0} 新开": "Open with {0}",
  "取消收藏": "Unfavorite",
  "收藏（置顶分组）": "Favorite (pin to top group)",
  "编辑主机…": "Edit host…",
  "删除主机…": "Delete host…",
  "终端操作": "Terminal actions",
  "复制": "Copy",
  "粘贴": "Paste",
  "全选": "Select all",
  "查找…": "Find…",
  "清屏": "Clear screen",
  "最近连接操作：{0}": "Recent connection actions: {0}",
  "从最近连接隐藏": "Hide from recent connections",
  "窗口高度不足——分屏临时退化为单窗格，另一个会话仍在标签中；拉高窗口自动恢复。":
    "Window too short — split temporarily degrades to one pane; the other session stays in its tab. Taller window restores automatically.",
  "窗口宽度不足——分屏临时退化为单窗格，另一个会话仍在标签中；加宽窗口自动恢复。":
    "Window too narrow — split temporarily degrades to one pane; the other session stays in its tab. Wider window restores automatically.",
  "关闭提示": "Dismiss hint",

  // —— 活动记录面板 ——
  "记录范围": "Record scope",
  "只看当前会话": "Current session only",
  "未接入会话": "No attached session",
  "当前会话": "Current session",
  "全部会话": "All sessions",
  "刷新": "Refresh",
  "刷新活动记录": "Refresh records",
  "主体": "Actor",
  "全部": "All",
  "人类": "Human",
  "事件类型": "Event type",
  "本机时间（{0}）· {1}": "Local time ({0}) · {1}",
  "未接入会话，无可显示记录": "No attached session — nothing to show",
  "共 {0} 条": "{0} events in total",
  "（当前会话）": " (current session)",
  "未接入会话——切到「全部会话」可查看历史记录。": "No attached session — switch to \"All sessions\" to browse history.",
  "暂无记录。所有连接与命令都会留痕在这里。": "No events yet. All connections and commands will be traced here.",
  "我": "Me",
  "Agent · {0}": "Agent · {0}",
  "加载更早（已显示 {0}/{1}）": "Load earlier ({0}/{1} shown)",

  // —— 欢迎页 ——
  "人机协同 SSH 工作台": "Human–AI collaborative SSH workbench",
  "连接": "Connect",
  "操作": "Operate",
  "多会话": "Multi-session",
  "专注": "Focus",
  "主机栏「＋」填入地址和密码（或粘贴私钥），保存后自动连接": "Click ＋ in the hosts panel, enter address and password (or paste a key); saving connects automatically",
  "点击终端区直接打字：Ctrl+C 中断、↑↓ 历史、Tab 补全、⌘C/⌘V 复制粘贴": "Click the terminal and type: Ctrl+C interrupt, ↑↓ history, Tab completion, ⌘C/⌘V copy-paste",
  "一屏一签，点标签切换、分屏对照，各自的滚动历史和 vim 界面都会保留": "One tab per session — switch tabs or split to compare; each keeps its scrollback and vim state",
  "拖文件进窗口上传：拖到文件面板直接传到正在浏览的目录，拖到终端先确认目标": "Drag files in to upload: onto the file panel sends them to the browsed directory, onto the terminal asks for the target first",
  "F11 进入全屏专注：界面全让位给终端，标签条常驻顶部（Ctrl+K 面板可切自动隐藏），再按 F11 退出": "F11 enters fullscreen focus: everything yields to the terminal with the tab bar on top (Ctrl+K palette can toggle auto-hide); F11 again to exit",
  "添加主机": "Add host",
  "快速连接": "Quick connect",
  "从 ~/.ssh/config 导入": "Import from ~/.ssh/config",
  "打开本地终端": "Open local terminal",
  "上次会话": "Last session",
  "重连 {0}": "Reconnect {0}",
  "⟳ 重连上次会话（{0}）": "⟳ Reconnect last session ({0})",
  "恢复现场": "Restore scene",
  "上次现场": "Last scene",
  "快照 {0}": "snapshot {0}",
  "另有 {0} 个主机已删的条目将跳过。": "{0} entries whose hosts were deleted will be skipped. ",
  "恢复后终端回到快照画面（滚回保留尾部 300 行）": "After restore the terminal returns to the snapshot screen (scrollback keeps the last 300 lines)",
  "⏮ 恢复上次现场（{0}）": "⏮ Restore last scene ({0})",
  "恢复": "Restore",
  "连接 {0}（{1}）；右键更多操作": "Connect {0} ({1}); right-click for more",
  "最近连接": "Recent connections",
  "已有 {0} 个会话未接入终端——点击上方标签或「标签列表」继续。": "{0} session(s) are not attached — click a tab above or \"Tab list\" to continue.",
  "暂无会话——从主机栏连接主机开始，或导入 ~/.ssh/config。": "No sessions yet — connect a host from the hosts panel, or import ~/.ssh/config.",

  // —— 主机栏 ——
  "主机栏": "Hosts panel",
  "搜索主机": "Search hosts",
  "搜索主机（名称 / 地址 / 用户 / 标签）": "Search hosts (name / address / user / tag)",
  "收起导入": "Hide import",
  "导入 ~/.ssh/config": "Import ~/.ssh/config",
  "收起表单": "Hide form",
  "按标签筛选": "Filter by tag",
  "取消筛选「{0}」": "Clear filter \"{0}\"",
  "只看带「{0}」标签的主机": "Show only hosts tagged \"{0}\"",
  "主机 {0}（{1}）——Enter 切换到最近会话": "Host {0} ({1}) — Enter switches to the latest session",
  "主机 {0}（{1}）——Enter 连接": "Host {0} ({1}) — Enter connects",
  "本机 PTY——内置条目：不可编辑、不可删除\n默认 shell 在 设置 → 终端 选择；右键可用指定 shell 新开":
    "This machine's PTY — a built-in entry: cannot be edited or deleted\nPick the default shell in Settings → Terminal; right-click to open with a specific shell",
  "指纹：": "Fingerprint: ",
  "首次连接时确认": "confirmed on first connect",
  "编码：": "Encoding: ",
  "GBK（中文 Windows / 老旧设备）": "GBK (Chinese Windows / legacy devices)",
  "GBK（中文 Windows / 老设备）": "GBK (Chinese Windows / legacy)",
  "远端编码：GBK": "Remote encoding: GBK",
  "已有 {0} 个本地终端——点击切换到最近会话，右侧「连接」可另开": "{0} local terminal(s) open — click to switch to the latest; \"Connect\" on the right opens another",
  "该主机已有会话——点击切换到最近会话，右侧「连接」可另开新会话": "This host has sessions — click to switch to the latest; \"Connect\" on the right opens a new one",
  "已有 {0} 个会话（存活 {1}）——点击主行切换到最近会话": "{0} session(s) ({1} alive) — click the main row to switch to the latest",
  "本机 PTY——内置条目，不可编辑或删除": "This machine's PTY — built-in, cannot be edited or deleted",
  "本地": "Local",
  "密钥": "Key",
  "跳板": "Jump",
  "经跳板转发连接（跳板：{0}）": "Connects via jump host ({0})",
  "本地 shell ·": "Local shell ·",
  "上次连接失败——检查地址与凭据后重试": "Last connection failed — check address and credentials, then retry",
  "取消收藏（移出「收藏」分组）": "Unfavorite (leave the \"Favorites\" group)",
  "收藏（置顶「收藏」分组）": "Favorite (pin to the \"Favorites\" group)",
  "编辑主机（名称/地址/端口/用户名/编码/标签，凭据保持不变）": "Edit host (name/address/port/user/encoding/tags; credentials unchanged)",
  "连接（新开本地终端）——shell 在 设置 → 终端 选择，右键可指定 shell 新开": "Connect (new local terminal) — pick the shell in Settings → Terminal; right-click to open with a specific one",
  "连接（新建会话）——其他主机的连接不受影响": "Connect (new session) — other hosts' connections are untouched",
  "取消本次连接（终态由核心裁决：已取消/已完成可见）": "Cancel this connection (final state is decided by the core: cancelled/visible as done)",
  "还没有主机。点上方「＋」填入地址和密码即可连接。": "No hosts yet. Click ＋ above, enter address and password, and connect.",
  "无匹配主机——可清除搜索/标签筛选，或直接添加：": "No matching hosts — clear the search/tag filter, or add one directly:",
  "本机": "This machine",
  "收藏": "Favorites",
  "其他主机": "Other hosts",
  "全部主机": "All hosts",
  "设置（外观 / 终端 / 凭据）": "Settings (appearance / terminal / credentials)",
  "拖动调整主机栏宽度（200–300 px）": "Drag to resize the hosts panel (200–300 px)",
  "拖动调整宽度（200–300 px）": "Drag to resize (200–300 px)",

  // —— 粘贴/OSC52/拖放确认卡 ——
  "……（预览截断，共 {0} 字符）": "…… (preview truncated, {0} chars in total)",
  "\n……（预览截断，共 {0} 字符）": "\n…… (preview truncated, {0} chars in total)",
  "⚠ 危险命令重跑到 {0}？": "⚠ Re-run dangerous command on {0}?",
  "⚠ 危险内容粘贴到 {0}？": "⚠ Paste dangerous content into {0}?",
  "重跑多行命令到 {0}？": "Re-run multi-line command on {0}?",
  "粘贴多行内容到 {0}？": "Paste multi-line content into {0}?",
  "重跑命令命中危险形态（与 Agent 审批同一张内置规则表）——确认后重新执行，取消则不发送任何字节。":
    "The command hits a dangerous pattern (same built-in rule table as agent approvals) — confirm to re-run, cancel sends nothing.",
  "粘贴内容命中危险形态（与 Agent 审批同一张内置规则表）——确认后才会发送，取消则不发送任何字节。":
    "The content hits a dangerous pattern (same built-in rule table as agent approvals) — confirm to send, cancel sends nothing.",
  "命令含多行——重跑会按行依次执行。请确认；取消则不发送任何字节。":
    "The command has multiple lines — re-run executes them one by one. Please confirm; cancel sends nothing.",
  "目标终端未开启 bracketed paste——换行会被远端立即执行。请确认内容；取消则不发送任何字节。":
    "The target terminal lacks bracketed paste — newlines will execute immediately on the remote. Please confirm; cancel sends nothing.",
  "仍然重跑": "Re-run anyway",
  "重跑": "Re-run",
  "仍然发送": "Send anyway",
  "发送": "Send",
  "远端请求写入剪贴板 ·": "Remote requests clipboard write ·",
  "远端程序通过 OSC 52 转义序列请求改写你本机的剪贴板——允许后现有内容会被覆盖，拒绝则不写入任何字节。「始终允许」本次照写且此后不再询问（设置→终端 可改回）。读取类请求（查询）一律拒绝，不经此卡。":
    "A remote program asks to rewrite your local clipboard via the OSC 52 escape sequence — allowing overwrites the current content, denying writes nothing. \"Always allow\" writes now and stops asking (change back in Settings → Terminal). Read requests (queries) are always denied without this card.",
  "允许写入": "Allow write",
  "始终允许": "Always allow",
  "上传到": "Upload to",
  "该会话": "this session",
  "：": ": ",
  "远端目标目录": "Remote target directory",
  "远端目录（绝对路径，必填）": "Remote directory (absolute path, required)",
  "{0} 个文件：": "{0} file(s): ",
  " 等 {0} 个": " and {0} more",
  "该会话无可信工作目录（shell 集成未上报 cwd）——请填写远端目录。":
    "This session has no trusted working directory (shell integration didn't report cwd) — enter the remote directory.",
  "上传到此处": "Upload here",

  // —— 会话工具栏 / rail ——
  "接管会话：Agent 冻结、待审批请求作废，终端归你操作。Agent 正在跑的命令不会被中断":
    "Take over: the agent freezes, pending approvals void, the terminal is yours. Commands the agent is running are not interrupted",
  "接管": "Take over",
  "接管并额外尝试停止 Agent 正在运行的命令；停止结果逐条显示，未停下的会标红":
    "Take over and additionally try to stop the agent's running commands; results are listed one by one — survivors are shown in red",
  "接管并停止任务": "Take over & stop tasks",
  "交还会话：Agent 恢复操作（后续请求重新走审批）。已作废的请求不会自动重发——Agent 会收到作废通知，由它决定是否重新提交":
    "Hand back: the agent resumes (later requests go through approval again). Voided requests are not re-sent — the agent is notified and decides whether to resubmit",
  "首次委托：把会话交给 Agent 执行。需在对话框中查看主机/会话/能力与现有授权范围后明确提交；取消不改动控制权":
    "First delegation: hand the session to the agent. Review host/session/capabilities and existing grants in the dialog and submit explicitly; cancel changes nothing",
  "交还 Agent": "Hand back to agent",
  "交给 Agent…": "Hand to agent…",
  "搜索终端内容（⌘F）": "Search terminal content (⌘F)",
  "退出分屏（Ctrl+D；会话保留不断开）": "Exit split (Ctrl+D; sessions stay connected)",
  "分屏（Ctrl+D）：在右侧/下侧显示已有会话（方向可在菜单选择）": "Split (Ctrl+D): show an existing session on the right / below (direction picked in the menu)",
  "协作：审批、任务目标与现场简报（有 Agent 活动时必须可达）": "Collaboration: approvals, task goal and situation brief (must be reachable while an agent is active)",
  "协作": "Collab",
  "文件：远程目录浏览与传输": "Files: remote directory browsing and transfers",
  "文件": "Files",
  "工具": "Tools",
  "端口转发": "Port forwards",
  "广播输入…": "Broadcast input…",
  "命令块": "Command blocks",
  "活动记录": "Activity",
  "侧栏视图": "Sidebar views",
  "连接（⌘B）": "Connections (⌘B)",
  "Agent 对话（演练）": "Agent chat (rehearsal)",
  "跨主机编排（Fleet）：派发任务给各会话的执行 agent 并汇总": "Cross-host orchestration (Fleet): dispatch tasks to per-session agents and summarize",
  "资源监控大屏：多服务器 CPU/内存/网络 与 Ascend NPU{0}": "Resource monitor: multi-server CPU/memory/network and Ascend NPU{0}",
  "（后台采集中）": " (sampling in background)",
  "设置（外观 / 终端 / 凭据 / Agent）": "Settings (appearance / terminal / credentials / agent)",

  // —— ⌘K 命令面板 / 状态栏 ——
  "命令面板搜索": "Command palette search",
  "搜索会话、主机与命令…（↑↓ 选择，Enter 执行，Esc 关闭）": "Search sessions, hosts and commands… (↑↓ select, Enter run, Esc close)",
  "无匹配——试试会话名、主机地址或「设置」「快速连接」。": "No matches — try a session name, host address, or \"Settings\" / \"Quick connect\".",
  "当前": "current",
  "会话": "Sessions",
  "切换到 {0}": "Switch to {0}",
  "本机 PTY": "This machine's PTY",
  "恢复上次现场（{0}）": "Restore last scene ({0})",
  "受控退出时的屏幕快照——恢复走完整建连流程": "Screen snapshot from a controlled exit — restore goes through the full connect flow",
  "重连上次会话（{0}）": "Reconnect last session ({0})",
  "快速连接（不存主机，临时连接一次）": "Quick connect (not saved; one-off connection)",
  "复制标签页（同主机新会话：{0}）": "Duplicate tab (new session, same host: {0})",
  "输出落 data/logs": "output goes to data/logs",
  "关闭文件面板": "Close files panel",
  "打开文件面板": "Open files panel",
  "关闭端口转发面板": "Close port-forwards panel",
  "打开端口转发面板": "Open port-forwards panel",
  "关闭命令块面板": "Close command-blocks panel",
  "打开命令块面板": "Open command-blocks panel",
  "广播输入（已勾选 {0} 个会话）": "Broadcast input ({0} sessions ticked)",
  "接管（冻结 Agent，待审批作废）": "Take over (freeze agent, void pending approvals)",
  "接管并停止任务（尝试停止正在运行的命令）": "Take over & stop tasks (try to stop running commands)",
  "交还 Agent…": "Hand back to agent…",
  "关闭会话（{0}）": "Close session ({0})",
  "应用": "App",
  "打开设置": "Open settings",
  "外观切换为「{0}」": "Switch appearance to \"{0}\"",
  "跟随系统 / 深色 / 浅色 循环": "cycles follow-system / dark / light",
  "隐藏主机栏": "Hide hosts panel",
  "显示主机栏": "Show hosts panel",
  "关闭 Agent 对话": "Close agent chat",
  "打开 Agent 对话（演练）": "Open agent chat (rehearsal)",
  "关闭跨主机编排": "Close cross-host orchestration",
  "打开跨主机编排（Fleet）": "Open cross-host orchestration (Fleet)",
  "关闭资源监控大屏": "Close resource monitor",
  "打开资源监控大屏（多服务器 + Ascend NPU）": "Open resource monitor (multi-server + Ascend NPU)",
  "退出专注模式": "Exit focus mode",
  "进入专注模式（界面全让位给终端）": "Enter focus mode (everything yields to the terminal)",
  "专注模式标签条：改为常驻": "Focus-mode tab bar: keep always visible",
  "专注模式标签条：改为自动隐藏": "Focus-mode tab bar: switch to auto-hide",
  "当前：自动隐藏（顶缘浮标唤出）": "Now: auto-hide (summon from the top edge)",
  "当前：常驻": "Now: always visible",
  "专注模式标签条已改为常驻": "Focus-mode tab bar set to always visible",
  "专注模式标签条已改为自动隐藏（顶缘浮标唤出）": "Focus-mode tab bar set to auto-hide (summon from the top edge)",
  "广播输入：同一键入同时发到勾选的会话（点开选择目标）": "Broadcast: the same keystrokes go to all ticked sessions (click to pick targets)",
  "广播": "Broadcast",
  "命令块：最近命令时间线（shell 集成 OSC 133）": "Command blocks: recent-command timeline (shell integration OSC 133)",
  "块": "Blocks",
  "转发": "Forwards",
  "传输队列（底部抽屉；后台事件只更新计数不自动展开）": "Transfer queue (bottom drawer; background events update the count without auto-expanding)",
  "传输": "Transfers",

  // —— 委托/停用/关闭/退出/删除确认框 ——
  "交还 {0} 给 Agent？": "Hand {0} back to the agent?",
  "把 {0} 交给 Agent？": "Hand {0} to the agent?",
  "Agent 持有控制权期间，它的每个操作仍逐条经你审批；你随时可以接管（接管会作废尚未开始的请求）。":
    "While the agent holds control, every one of its operations still goes through your approval; you can take over at any time (taking over voids requests that haven't started).",
  "主机": "Host",
  "能力": "Capabilities",
  "查询中…": "Checking…",
  "持久 Shell 可用——Agent 可在当前目录与环境执行": "Persistent shell available — the agent executes in the current directory and environment",
  "无持久 Shell——委托后 Agent 只能走 exec 模式（不继承当前目录/环境）": "No persistent shell — after delegation the agent can only use exec mode (no inherited directory/environment)",
  "现有授权范围": "Existing grants",
  "已接入 {0}；所有操作逐条审批（控制权是角色，不承诺某一 Agent 独占）": "Connected: {0}; every operation is approved item by item (control is a role, no single-agent exclusivity promised)",
  "尚未登记任何 Agent": "No agents registered yet",
  "任务目标（可选）": "Task goal (optional)",
  "写给 Agent 的委托留言，例：把日志打包放到 /tmp 后交还给我": "A note for the agent, e.g. pack the logs into /tmp then hand back to me",
  "留空也可以转交；留空不会清除会话上已有的目标。": "You can hand over with this empty; an empty goal doesn't clear an existing goal on the session.",
  "协作服务未启用——先到「设置 → Agent 接入」登记 Agent。返回后仍需在此单独确认转交。":
    "Collaboration is off — register an agent in Settings → Agent access first. After returning you still confirm the hand-over here.",
  "打开设置 → Agent 接入": "Open Settings → Agent access",
  "提交中…": "Submitting…",
  "交给 Agent": "Hand to agent",
  "停用协作？": "Disable collaboration?",
  "确认后立即封闭入口——新 Agent 请求一律被拒绝，不等待你逐个接管；已有请求在执行开始前核对停用代际，作废留痕，不会因旧审批决定继续执行。":
    "Confirming closes the door immediately — new agent requests are all rejected without waiting for takeovers; existing requests re-check the disable generation before execution starts, voided with a trace, never proceeding on stale approvals.",
  "受影响的 Agent 会话": "Affected agent sessions",
  "（转为你的控制，不自动终止已开始的任务）": " (become yours; started tasks are not auto-terminated)",
  "待审批请求": "Pending approvals",
  "（作废）": " (voided)",
  "已配置 Agent": "Configured agents",
  "（身份与 Token 保留）": " (identities and tokens kept)",
  "运行中的 Agent 任务不会被自动终止；应用拥有的 MCP 端点随之停止（外部 shim 是独立进程，不受影响）。重新启用须显式操作，先前作废的请求不会复活。":
    "Running agent tasks are not auto-terminated; the app-owned MCP endpoint stops with it (external shims are separate processes, unaffected). Re-enabling requires an explicit action; previously voided requests do not revive.",
  "停用中…": "Disabling…",
  "确认停用": "Confirm disable",
  "关闭与 {0} 的会话？": "Close the session with {0}?",
  "终端现场不可恢复——重连会是全新现场（记录保留）。": "The terminal state cannot be restored — reconnecting starts fresh (records are kept).",
  "将受影响的转发：": "Affected forwards: ",
  "{0} 条（随会话关闭）": "{0} (close with the session)",
  "无": "none",
  "状态未知（查询失败）": "unknown (query failed)",
  "正在运行的任务/传输：状态未知——如有重要作业请先确认": "Running tasks/transfers: unknown — confirm important jobs first",
  "关闭会话": "Close session",
  "退出 TinySSH？": "Quit TinySSH?",
  "活动会话 {0} 个": "{0} active session(s)",
  "，转发 {0} 条。": ", {0} forward(s).",
  "正在运行的命令与传输会被终止；传输处于提交中/结果待核实时不代表已全部取消。":
    "Running commands and transfers will be terminated; transfers mid-commit / pending verification are not necessarily all cancelled.",
  "会话不跨启动保留——下次启动可在欢迎页「重连上次会话」一键恢复届时仍打开的主机。":
    "Sessions don't survive restarts — next launch, \"Reconnect last session\" on the welcome page restores the hosts that were open in one click.",
  "结束会话并退出": "End sessions & quit",
  "删除主机 {0}？": "Delete host {0}?",
  "凭据与指纹记录一并移除，之后无法再从它新建连接；已建立的会话不受影响。":
    "Its credential and fingerprint records are removed too; you can't connect anew from it afterwards. Established sessions are unaffected.",
  "删除": "Delete",
  "删除凭据 {0}？": "Delete credential {0}?",
  "仍被主机引用的凭据会被拒绝并列出主机；已保存的凭据独立存在，删除前请确认没有主机依赖它。":
    "Credentials still referenced by hosts are rejected with a host list; saved credentials exist independently — make sure no host depends on it before deleting.",

  // —— 常用 toast / 专注模式 ——
  "命令": "command",
  "已复制{0}": "Copied {0}",
  "已复制路径 {0}": "Copied path {0}",
  "复制路径失败（权限拒绝或窗口无焦点）": "Failed to copy path (permission denied or window unfocused)",
  "已进入专注模式（浏览器演示不切系统全屏）": "Focus mode on (browser demo doesn't switch system fullscreen)",
  "已退出专注模式": "Focus mode off",
  "专注模式：F11 退出 · 鼠标移到顶部唤出标签": "Focus mode: F11 to exit · move the mouse to the top for tabs",
  "专注模式：F11 退出 · 标签条常驻（Ctrl+K 可切自动隐藏）": "Focus mode: F11 to exit · tab bar always visible (Ctrl+K toggles auto-hide)",
  "已恢复专注模式 · F11 退出": "Focus mode restored · F11 to exit",
};

export const LOCALE_OPTIONS: { id: Locale; label: string }[] = [
  { id: "zh", label: "中文（默认）" },
  { id: "en", label: "English" },
];
