//! 审批引擎实现（L1 §3.3）：deny → allow/TTL → default；tree-sitter-bash 逐段求值。
//! 内置危险模式默认拒绝且不可删除；TTL 授权窗口到期自动失效。

use chrono::Utc;
use regex::Regex;
use session_api::{ApprovalMode, ApprovalStatus, Decision, Policy, SegmentReport};
use std::sync::{Arc, Mutex};
use tree_sitter::{Parser, Tree};

/// 内置危险模式（不可删除；命中直接 DangerousPattern，ApproveEdited 不可绕过）。
pub const BUILTIN_DENY_PATTERNS: &[(&str, &str)] = &[
    (r"^\s*rm\b[^\n;|&]*(?:\s|\A)/(?:\s|$)", "删除根目录"),
    (r"^\s*rm\b[^\n;|&]*\s/(?:\s|$)", "删除根目录"),
    (r"^\s*mkfs(\.\w+)?\b", "格式化文件系统"),
    (
        r"^\s*dd\b[^\n]*\bof=/dev/(?:sd|nvme|vd|hd|disk|mapper)",
        "dd 覆写块设备",
    ),
    (r">\s*/dev/(?:sd|nvme|vd|hd)[a-z]", "覆写块设备"),
    (r"^\s*shutdown\b", "关机"),
    (r"^\s*reboot\b", "重启"),
    (r"^\s*halt\b", "停机"),
    (r"^\s*poweroff\b", "断电"),
    (r"^\s*init\s+[06]\b", "切换运行级"),
    (r":\(\)\s*\{.*\};\s*:", "fork 炸弹"),
    (
        r"^\s*chmod\s+(-[a-zA-Z]+\s+)*777\s+/(?:\s|$)",
        "根目录开放权限",
    ),
    (r"^\s*wipefs\b", "擦除文件系统签名"),
    (
        r"^\s*(?:fdisk|cfdisk|sfdisk|sgdisk|parted)\s+/dev/",
        "分区工具作用于块设备",
    ),
    (r"^\s*blkdiscard\b", "丢弃块设备扇区"),
    (r"^\s*shred\b[^;|&]*\s/dev/", "覆写块设备"),
    (r"^\s*systemctl\s+(?:reboot|poweroff|halt)\b", "关机/重启"),
];

/// 提权/包装前缀（十轮）：`sudo|doas|nohup|nice|time|env|command|exec`、
/// `VAR=值` 环境赋值、短选项及其参数（`sudo -u alice`）。锚定在 `^\s*` 的内置
/// deny 模式编译时统一前置此前缀——否则 `sudo rm -rf /` 直接绕过全部锚定模式
/// （九轮审计）。任意间接（`sudo bash -c 'reboot'` 的内层命令是字符串参数，
/// 无法用正则覆盖）仍由 tree-sitter 逐段求值 + 审批人看全文兜底。
const WRAPPER_PREFIX: &str = r"(?:(?:\s*(?:sudo|doas|nohup|nice|time|env|command|exec)\b|\s*[A-Za-z_]\w*=\S*|\s*-{1,2}[A-Za-z][\w-]*(?:\s+\S+)?)\s*)*";

/// Windows / PowerShell / cmd 内置危险形态（不可删除）。
///
/// 这张表与上面的 POSIX 表互补：Windows 是产品第一平台，而本地会话的 shell
/// 可能是 PowerShell、cmd、Git Bash 或 WSL。这里不依赖 shell 探测结果——按
/// “命令位置”匹配：行首、`; & | {` 之后，或 `powershell/pwsh/cmd -Command|/c`
/// 包装之后。这样既覆盖直接键入，也覆盖 Agent 常见的
/// `powershell -Command "Remove-Item ..."` 包装，同时不误伤
/// `Write-Host "Remove-Item ..."` 这类仅出现在字符串里的文本。
///
/// 注意：deny-list 只能守住高信号、不可逆的破坏形态，不能替代审批；自主模式
/// 仍应按 allowlist 方向演进（见 `ApprovalEngine` 注释）。
pub const BUILTIN_WINDOWS_DENY_PATTERNS: &[(&str, &str)] = &[
    (
        r#"remove-item\b[^\n;|&]*(?:-recurse|-force)"#,
        "PowerShell 递归/强制删除",
    ),
    (
        r#"(?:rm|ri)\b[^\n;|&]*(?:-recurse|-force)"#,
        "PowerShell 递归/强制删除",
    ),
    (
        r#"(?:del|erase|rd|rmdir)(?:\.exe)?\b[^\n;|&]*(?:-recurse|-force|\s/[sqf]\b)"#,
        "Windows 递归/强制删除",
    ),
    (r#"format(?:\.com)?\s+[a-z]:"#, "格式化磁盘"),
    (r#"diskpart(?:\.exe)?\b"#, "磁盘分区工具"),
    (
        r#"bcdedit(?:\.exe)?\b[^\n]*(?:/delete|/set|/create|/import|/export|/copy)"#,
        "修改引导配置",
    ),
    (
        r#"(?:vssadmin|wbadmin)(?:\.exe)?\b[^\n]*delete\b"#,
        "删除卷影副本/备份",
    ),
    (
        r#"cipher(?:\.exe)?\b[^\n]*\s/w(?:\s*:|\b)"#,
        "擦除磁盘空闲空间",
    ),
    (r#"reg(?:\.exe)?\s+delete\b"#, "删除注册表项"),
    (r#"wevtutil(?:\.exe)?\s+(?:cl|clear-log)\b"#, "清空事件日志"),
    (r#"auditpol(?:\.exe)?\s+/clear\b"#, "清空审计策略"),
    (
        r#"fsutil(?:\.exe)?\s+(?:deletejournal|setzerodata|usn\s+deletejournal)\b"#,
        "删除文件系统日志/零写数据",
    ),
    (
        r#"(?:clear-disk|initialize-disk|format-volume|remove-partition|remove-disk|new-partition|set-disk|resize-partition)\b"#,
        "磁盘管理操作",
    ),
    (r#"(?:stop-computer|restart-computer)\b"#, "关机/重启"),
    (r#"shutdown(?:\.exe)?\s+(?:/[srphf]\b|/sg\b)"#, "关机/重启"),
    (
        r#"(?:add-mppreference|set-mppreference)\b[^\n]*(?:disable|exclusion)"#,
        "关闭/绕过杀毒防护",
    ),
    (
        r#"(?:powershell|pwsh)(?:\.exe)?[^\n]*(?:-encodedcommand|-enc)\b"#,
        "PowerShell 编码命令（内容不可静态检查）",
    ),
    (
        r#"(?:wmic\s+shadowcopy\s+delete|diskshadow(?:\.exe)?\b)"#,
        "删除卷影副本/备份",
    ),
    (
        r#"set-executionpolicy\b[^\n]*(?:bypass|unrestricted)"#,
        "降低 PowerShell 执行策略",
    ),
    (
        r#"(?:iwr|invoke-webrequest|downloadstring|downloadfile)[^\n|]*\|\s*(?:iex|invoke-expression)\b"#,
        "下载并执行脚本",
    ),
    (
        r#"(?:invoke-expression|\biex)\b[^\n]*(?:downloadstring|downloadfile|invoke-webrequest|iwr|https?://)"#,
        "动态执行下载内容",
    ),
];

/// Windows 命令位置前缀：行首/复合命令分隔符后，或 PowerShell/cmd 包装后。
/// 组合时必须整体包一层 `(?:...)`，否则顶层 `|` 会把后续危险词排除在分支外。
const WINDOWS_CMD_PREFIX: &str = r#"(?:^|[;&|{]|&\s*\{)\s*(?:&\s*\{?\s*)?(?:["']?(?:(?:[A-Za-z]:|\\\\|\.{1,2})?[^\s"';&|]*?[\\/]))?(?:(?:(?:powershell|pwsh)(?:\.exe)?(?:\s+-[A-Za-z]+\b(?:\s+(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.\\/-]+))?)*?\s+(?:-command|-c)\s+|cmd(?:\.exe)?\s+(?:/[a-z]\s+)*/c\s+)\s*["']?\s*(?:&\s*\{?\s*)?)*"#;

/// 逐段求值结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SegmentVerdict {
    /// 全部段命中 allow/TTL：免审放行。
    AutoAllow,
    /// 存在段未命中：需要审批（附逐段报告）。
    NeedsApproval,
    /// 危险模式命中：不可批准。
    Dangerous,
}

#[derive(Debug)]
pub struct Evaluation {
    pub verdict: SegmentVerdict,
    pub segments: Vec<SegmentReport>,
}

/// 命令解析：段抽取（tree-sitter-bash）。
pub struct CommandParser {
    parser: Mutex<Parser>,
}

impl CommandParser {
    pub fn new() -> Result<Self, session_api::Error> {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_bash::LANGUAGE.into())
            .map_err(|e| session_api::Error::InvalidInput(format!("bash grammar: {e}")))?;
        Ok(Self {
            parser: Mutex::new(parser),
        })
    }

    pub fn parse(&self, cmd: &str) -> Option<Tree> {
        let mut guard = self.parser.lock().unwrap();
        guard.parse(cmd, None)
    }
}

impl Default for CommandParser {
    fn default() -> Self {
        Self::new().expect("bash parser")
    }
}

/// 提取命令段：复合命令（; && || |）逐段收集 `command` 节点；
/// 命令替换 → 标记不可预判；控制流/解析错误 → 保守整体报审。
/// 返回 (segments, unparseable, has_substitution)。
pub fn extract_segments(tree: &Tree, source: &str) -> (Vec<String>, bool, bool) {
    let root = tree.root_node();
    let mut segments = Vec::new();
    let mut has_substitution = false;

    fn collect_commands<'t>(
        node: tree_sitter::Node<'t>,
        src: &'t str,
        segments: &mut Vec<String>,
        sub: &mut bool,
        depth: usize,
    ) {
        if depth > 64 {
            return;
        }
        let kind = node.kind();
        if kind == "command_substitution" || kind == "process_substitution" {
            *sub = true;
            return;
        }
        if kind == "command" {
            let text = node
                .utf8_text(src.as_bytes())
                .unwrap_or("")
                .trim()
                .to_string();
            if !text.is_empty() {
                segments.push(text);
            }
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                collect_commands(child, src, segments, sub, depth + 1);
            }
            return;
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            collect_commands(child, src, segments, sub, depth + 1);
        }
    }

    let unparseable = root.has_error() || root.is_missing();
    collect_commands(root, source, &mut segments, &mut has_substitution, 0);

    // 控制流等复杂结构（program 直含 if/for/while/subshell/heredoc…）→ 保守报审
    let mut complex = false;
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        if !child.is_named() {
            continue; // ;、&&、|、\n 等匿名分隔符
        }
        let k = child.kind();
        if !matches!(
            k,
            "list" | "pipeline" | "command" | "comment" | "variable_assignment"
        ) {
            complex = true;
        }
    }
    let unparseable = unparseable || complex;
    if unparseable {
        return (
            vec![source.trim().to_string()],
            unparseable,
            has_substitution,
        );
    }
    (segments, unparseable, has_substitution)
}

/// 模式匹配：前缀（结尾 `*`）、正则（开头 `^`）、精确。
pub fn pattern_matches(pattern: &str, segment: &str) -> bool {
    let p = pattern.trim();
    if let Some(prefix) = p.strip_suffix('*') {
        return segment.starts_with(prefix.trim_end());
    }
    if p.starts_with('^') {
        return Regex::new(p).map(|r| r.is_match(segment)).unwrap_or(false);
    }
    segment == p
}

/// 审批引擎：策略 + 解析器 + 内置 deny。
pub struct ApprovalEngine {
    parser: Arc<CommandParser>,
    /// agent_id → policy
    policies: Mutex<std::collections::HashMap<String, Policy>>,
    builtin_denies: Vec<(Regex, &'static str)>,
}

impl ApprovalEngine {
    pub fn new() -> Result<Self, session_api::Error> {
        let builtin_denies = BUILTIN_DENY_PATTERNS
            .iter()
            .map(|(p, reason)| {
                // `^\s*` 锚定的模式统一前置 wrapper 前缀（提权绕过防线，见
                // WRAPPER_PREFIX 注释）；非锚定模式原样编译。
                let full = match p.strip_prefix(r"^\s*") {
                    Some(rest) => format!("^{WRAPPER_PREFIX}{rest}"),
                    None => (*p).to_string(),
                };
                (Regex::new(&full).expect("builtin deny regex"), *reason)
            })
            .chain(BUILTIN_WINDOWS_DENY_PATTERNS.iter().map(|(p, reason)| {
                // Windows 表统一加“命令位置”前缀；`(?i)` 让 cmdlet/参数
                // 大小写不敏感（PowerShell 本身不区分大小写）。
                let full = format!("(?i)(?:{WINDOWS_CMD_PREFIX})(?:{p})");
                (
                    Regex::new(&full).expect("windows builtin deny regex"),
                    *reason,
                )
            }))
            .collect();
        Ok(Self {
            parser: Arc::new(CommandParser::new()?),
            policies: Mutex::new(std::collections::HashMap::new()),
            builtin_denies,
        })
    }

    pub fn set_policy(&self, agent_id: &str, policy: Policy) {
        self.policies
            .lock()
            .unwrap()
            .insert(agent_id.to_string(), policy);
    }

    pub fn policy_of(&self, agent_id: &str) -> Policy {
        self.policies
            .lock()
            .unwrap()
            .get(agent_id)
            .cloned()
            .unwrap_or_default()
    }

    /// 整体危险模式检查（ApproveEdited 后的命令同样过这道）。
    /// 用户 deny 规则只作用于所属 agent；内置 deny 对所有人生效。
    pub fn deny_reason(&self, agent_id: &str, command: &str) -> Option<String> {
        for (re, reason) in &self.builtin_denies {
            if re.is_match(command) {
                return Some((*reason).to_string());
            }
        }
        let policies = self.policies.lock().unwrap();
        if let Some(policy) = policies.get(agent_id) {
            for rule in &policy.deny_rules {
                if let Ok(re) = Regex::new(&rule.pattern) {
                    if re.is_match(command) {
                        return Some(rule.reason.clone());
                    }
                }
            }
        }
        None
    }

    /// 多行/多键序的危险形态检查：先整串，再逐行、再按 shell 段。
    ///
    /// `send_keys` 的输入不是单条命令（可能含 Enter/CR），若只查整串，
    /// `Get-ChildItem\nRemove-Item -Recurse -Force C:\Windows` 的第二行会漏过
    /// 锚定模式。`exec` 侧仍走 `evaluate` 的逐段求值；本方法只用于键序与
    /// 其他非命令文本的兜底。
    pub fn deny_reason_any(&self, agent_id: &str, text: &str) -> Option<String> {
        if let Some(reason) = self.deny_reason(agent_id, text) {
            return Some(reason);
        }
        let trimmed = text.trim();
        for part in text.split(['\n', '\r']) {
            let part = part.trim();
            if part.is_empty() || part == trimmed {
                continue;
            }
            if let Some(reason) = self.deny_reason(agent_id, part) {
                return Some(reason);
            }
        }
        let (segments, unpredictable) = self.segments_of(text);
        // 命令替换/进程替换/解析失败：内容无法按静态规则判定。键序不是命令框，
        // 没有审批人看全文的兜底，必须 fail-closed（否则 `echo $(reboot)` 穿过）。
        if unpredictable {
            return Some("命令包含无法静态判定的替换或复合结构".to_string());
        }
        for seg in segments {
            let seg = seg.trim();
            if seg.is_empty() || seg == trimmed {
                continue;
            }
            if let Some(reason) = self.deny_reason(agent_id, seg) {
                return Some(reason);
            }
        }
        None
    }

    /// 逐段求值（deny → allow/TTL → default）。deny 检查整条命令与每个段。
    /// 命令替换或解析失败 → 内容不可预判，跳过 allow/TTL 直接报审（人能看到全文）。
    pub fn evaluate(&self, agent_id: &str, command: &str) -> Evaluation {
        let mut segments_report = Vec::new();

        let (segments, unpredictable) = self.segments_of(command);
        let mut deny_hit: Option<(String, String)> = None;
        if let Some(reason) = self.deny_reason(agent_id, command) {
            deny_hit = Some((command.to_string(), reason));
        } else {
            for seg in &segments {
                if let Some(reason) = self.deny_reason(agent_id, seg) {
                    deny_hit = Some((seg.clone(), reason));
                    break;
                }
            }
        }
        if let Some((seg, reason)) = deny_hit {
            segments_report.push(SegmentReport {
                segment: seg,
                verdict: format!("deny: {reason}"),
            });
            return Evaluation {
                verdict: SegmentVerdict::Dangerous,
                segments: segments_report,
            };
        }

        let policy = self.policy_of(agent_id);
        if policy.default_mode == ApprovalMode::TrustClient {
            for seg in self.segments_of(command).0 {
                segments_report.push(SegmentReport {
                    segment: seg,
                    verdict: "allow: trust_client".into(),
                });
            }
            return Evaluation {
                verdict: SegmentVerdict::AutoAllow,
                segments: segments_report,
            };
        }

        // 替换体/解析失败：deny 规则与 allow 规则都无法预判实际执行内容
        if unpredictable {
            for seg in &segments {
                segments_report.push(SegmentReport {
                    segment: seg.clone(),
                    verdict: "pending: 命令替换/解析失败，内容不可预判".into(),
                });
            }
            return Evaluation {
                verdict: SegmentVerdict::NeedsApproval,
                segments: segments_report,
            };
        }

        let now = Utc::now();
        let mut all_allowed = true;
        for seg in segments {
            if policy
                .allow_rules
                .iter()
                .any(|r| pattern_matches(&r.pattern, &seg))
            {
                segments_report.push(SegmentReport {
                    segment: seg,
                    verdict: "allow: 规则命中".into(),
                });
                continue;
            }
            if policy
                .ttl_windows
                .iter()
                .any(|w| w.expires_at > now && pattern_matches(&w.pattern, &seg))
            {
                segments_report.push(SegmentReport {
                    segment: seg,
                    verdict: "allow: TTL 窗口".into(),
                });
                continue;
            }
            all_allowed = false;
            segments_report.push(SegmentReport {
                segment: seg,
                verdict: "pending: 未命中任何允许规则".into(),
            });
        }

        Evaluation {
            verdict: if all_allowed {
                SegmentVerdict::AutoAllow
            } else {
                SegmentVerdict::NeedsApproval
            },
            segments: segments_report,
        }
    }

    /// 编辑后的命令是否可批准：不得命中危险模式（deny 不可被 ApproveEdited 绕过）。
    pub fn is_editable_decision(&self, agent_id: &str, edited: &str) -> bool {
        self.deny_reason_any(agent_id, edited).is_none()
    }

    /// 人类粘贴前的危险形态扫描（P0 终端品质轮）：只用**内置** deny 表——tree-sitter
    /// 逐段求值（解析失败或单段时整串即段），返回 (命中段, 原因) 去重列表。
    /// 与 Agent 审批同一张表、同一套 wrapper 前缀：人类粘贴与 Agent 执行同口径，
    /// 只是人类侧只提示、不阻断（确认后仍可发送；Agent 侧 deny 不可绕过）。
    /// 不含任何 agent 策略（人类粘贴借用别人的 allow/deny 规则没有语义）。
    pub fn scan_dangerous(&self, text: &str) -> Vec<(String, String)> {
        let mut hits: Vec<(String, String)> = Vec::new();
        {
            let mut consider = |seg: &str| {
                if let Some(reason) = self.builtin_hit(seg) {
                    if !hits.iter().any(|(s, r)| s == seg && r == &reason) {
                        hits.push((seg.to_string(), reason));
                    }
                }
            };
            // 内置 deny 全部锚定在行首且不吃换行——逐段扫即等价（整串扫会跨不了行，
            // 反而把多行粘贴文本当整段报出来把预览搅浑）；解析失败/单段时整串即段。
            let segments = self.segments_of(text).0;
            if segments.len() <= 1 {
                consider(text.trim());
            } else {
                for seg in segments {
                    consider(seg.trim());
                }
            }
        }
        hits
    }

    /// 内置 deny 表命中（单串；不含用户规则）。
    fn builtin_hit(&self, command: &str) -> Option<String> {
        self.builtin_denies
            .iter()
            .find(|(re, _)| re.is_match(command))
            .map(|(_, reason)| (*reason).to_string())
    }

    fn segments_of(&self, command: &str) -> (Vec<String>, bool) {
        match self.parser.parse(command) {
            Some(tree) => {
                let (segments, unparseable, sub) = extract_segments(&tree, command);
                (segments, unparseable || sub)
            }
            None => (vec![command.trim().to_string()], true),
        }
    }
}

impl Default for ApprovalEngine {
    fn default() -> Self {
        Self::new().expect("approval engine")
    }
}

/// 决策落库状态映射。
pub fn status_after_decision(d: &Decision) -> ApprovalStatus {
    match d {
        Decision::Approve => ApprovalStatus::Approved,
        Decision::ApproveEdited(_) => ApprovalStatus::ApprovedEdited,
        Decision::Deny => ApprovalStatus::Denied,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use session_api::{AllowRule, TtlWindow};

    fn engine() -> ApprovalEngine {
        let e = ApprovalEngine::new().unwrap();
        e.set_policy(
            "agent-a",
            Policy {
                allow_rules: vec![
                    AllowRule {
                        pattern: "systemctl status*".into(),
                        note: "查看状态".into(),
                    },
                    AllowRule {
                        pattern: "docker ps".into(),
                        note: "列容器".into(),
                    },
                    AllowRule {
                        pattern: "^git (status|diff)".into(),
                        note: "git 只读".into(),
                    },
                ],
                ttl_windows: vec![TtlWindow {
                    pattern: "echo *".into(),
                    expires_at: Utc::now() + chrono::Duration::hours(1),
                }],
                ..Default::default()
            },
        );
        e
    }

    #[test]
    fn single_allow() {
        assert_eq!(
            engine().evaluate("agent-a", "docker ps").verdict,
            SegmentVerdict::AutoAllow
        );
    }

    #[test]
    fn prefix_allow() {
        assert_eq!(
            engine()
                .evaluate("agent-a", "systemctl status nginx")
                .verdict,
            SegmentVerdict::AutoAllow
        );
        assert_eq!(
            engine().evaluate("agent-a", "systemctl stop nginx").verdict,
            SegmentVerdict::NeedsApproval
        );
    }

    #[test]
    fn regex_allow() {
        let e = engine();
        assert_eq!(
            e.evaluate("agent-a", "git status").verdict,
            SegmentVerdict::AutoAllow
        );
        assert_eq!(
            e.evaluate("agent-a", "git push").verdict,
            SegmentVerdict::NeedsApproval
        );
    }

    #[test]
    fn ttl_allow_and_expiry() {
        let e = engine();
        assert_eq!(
            e.evaluate("agent-a", "echo hi").verdict,
            SegmentVerdict::AutoAllow
        );
        e.set_policy(
            "agent-a",
            Policy {
                ttl_windows: vec![TtlWindow {
                    pattern: "echo *".into(),
                    expires_at: Utc::now() - chrono::Duration::hours(1),
                }],
                ..Default::default()
            },
        );
        assert_eq!(
            e.evaluate("agent-a", "echo hi").verdict,
            SegmentVerdict::NeedsApproval
        );
    }

    #[test]
    fn compound_command_requires_all_segments() {
        // L1 §3.3：`systemctl status; reboot` 不得因前缀放行 reboot（deny 优先 → Dangerous）
        let e = engine();
        assert_eq!(
            e.evaluate("agent-a", "systemctl status; reboot").verdict,
            SegmentVerdict::Dangerous
        );
        // 未命中段阻止整体放行
        assert_eq!(
            e.evaluate("agent-a", "docker ps && docker inspect x")
                .verdict,
            SegmentVerdict::NeedsApproval
        );
    }

    #[test]
    fn builtin_dangerous_patterns() {
        let e = engine();
        for cmd in [
            "rm -rf /",
            "rm -fr /tmp /",
            "dd if=/dev/zero of=/dev/sda",
            "reboot",
            ":(){ :|:& };:",
            "mkfs.ext4 /dev/sdb1",
            "shutdown now",
        ] {
            assert_eq!(
                e.evaluate("agent-a", cmd).verdict,
                SegmentVerdict::Dangerous,
                "cmd={cmd}"
            );
        }
    }

    #[test]
    fn safe_commands_not_flagged() {
        let e = engine();
        for cmd in ["rm -rf /tmp/build", "df -h", "echo reboot-is-a-word"] {
            assert_ne!(
                e.evaluate("agent-a", cmd).verdict,
                SegmentVerdict::Dangerous,
                "cmd={cmd}"
            );
        }
    }

    /// Windows 是产品第一平台：PowerShell/cmd 的不可逆破坏形态必须与 POSIX
    /// 表同口径硬拦；覆盖直接键入、分隔符后和 powershell/cmd 包装。
    #[test]
    fn builtin_windows_dangerous_patterns() {
        let e = engine();
        for cmd in [
            r"Remove-Item -Recurse -Force C:\Windows",
            r"Remove-Item C:\Windows -Recurse -Force",
            r"rm -Recurse -Force C:\Windows",
            r"del /s /q C:\*",
            r"rd /s /q C:\Windows",
            r"rd -Recurse -Force C:\Windows",
            r"format C:",
            r"diskpart",
            r"bcdedit /delete {current}",
            r"vssadmin delete shadows /all /quiet",
            r"wbadmin delete backup",
            r"cipher /w:C",
            r"reg delete HKLM\Software\Foo /f",
            r"wevtutil cl System",
            r"wevtutil clear-log System",
            r"auditpol /clear",
            r"fsutil usn deletejournal /d C:",
            r"Clear-Disk -Number 0 -RemoveData",
            r"Initialize-Disk -Number 1",
            r"Format-Volume -DriveLetter C",
            r"Remove-Partition -DriveLetter C",
            r"Stop-Computer -Force",
            r"Restart-Computer",
            r"shutdown /s /t 0",
            r"SHUTDOWN /F /S /T 0",
            r"Remove-Disk -Number 1",
            r"powershell -EncodedCommand ZgBvAG8A",
            r"Set-MpPreference -DisableRealtimeMonitoring $true",
            r"Set-ExecutionPolicy Bypass -Scope Process",
            r#"powershell -NoProfile -Command "Remove-Item -Recurse -Force C:\Windows""#,
            r#"powershell -ExecutionPolicy Bypass -Command "Remove-Item -Recurse -Force C:\Windows""#,
            r#"pwsh -c "Clear-Disk -Number 0 -RemoveData""#,
            r"cmd /c del /s /q C:\*",
            r#"cmd /d /s /c "del /s /q C:\*""#,
            r#"powershell -Command "cmd /c del /s /q C:\*""#,
            r"C:\Windows\System32\format.com C:",
            r".\format.com C:",
            r"Microsoft.PowerShell.Management\Clear-Disk -Number 0",
        ] {
            assert_eq!(
                e.evaluate("agent-a", cmd).verdict,
                SegmentVerdict::Dangerous,
                "cmd={cmd}"
            );
        }
    }

    /// Windows 安全命令不得误伤：只出现在字符串里、或没有破坏性参数的删除，
    /// 不应被硬拦（仍会按默认策略进入审批）。
    #[test]
    fn builtin_windows_safe_commands_not_flagged() {
        let e = engine();
        for cmd in [
            r"Get-ChildItem C:\Windows",
            r"Remove-Item .\build\*",
            r"del .\build\foo.txt",
            r"format --help",
            r"Write-Host 'diskpart is dangerous'",
            r"Write-Host 'Remove-Item -Recurse -Force C:\Windows'",
            r"echo cmd /c del /s /q C:\*",
            r"Get-Content C:\Windows\System32\drivers\etc\hosts",
            r#"powershell -Command "Get-ChildItem C:\Windows""#,
        ] {
            assert_ne!(
                e.evaluate("agent-a", cmd).verdict,
                SegmentVerdict::Dangerous,
                "cmd={cmd}"
            );
        }
    }

    /// send_keys 可能一次送入多行（含 Enter/CR）：第二行及以后也必须过 deny。
    #[test]
    fn multiline_keys_are_checked_per_line() {
        let e = engine();
        assert!(e
            .deny_reason_any(
                "agent-a",
                "Get-ChildItem\r\nRemove-Item -Recurse -Force C:\\Windows",
            )
            .is_some());
        assert!(e.deny_reason_any("agent-a", "Get-ChildItem\nls").is_none());
        // 命令替换无法静态判定：键序路径没有审批人看全文，必须 fail-closed
        assert!(e.deny_reason_any("agent-a", "echo $(reboot)").is_some());
        assert!(e.deny_reason_any("agent-a", "echo `reboot`").is_some());
        assert!(!e.is_editable_decision("agent-a", "echo hi\nreboot"));
    }

    /// 人类粘贴扫描与 Agent 审批同一张 Windows 表：多行粘贴命中第二行。
    #[test]
    fn scan_dangerous_windows_paste() {
        let e = engine();
        let hits = e.scan_dangerous("Get-ChildItem\nRemove-Item -Recurse -Force C:\\Windows");
        assert!(
            hits.iter()
                .any(|(seg, r)| seg.contains("Remove-Item") && r == "PowerShell 递归/强制删除"),
            "{hits:?}"
        );
    }

    /// P0 终端品质轮：人类粘贴危险形态扫描——多行逐段命中、wrapper 前缀穿透、
    /// 日常命令（含 `rm -rf ./build`、词中含 reboot）不误报。
    #[test]
    fn scan_dangerous_paste_guard() {
        let e = engine();
        assert!(e.scan_dangerous("echo hi\nls -la").is_empty());
        assert!(e
            .scan_dangerous("rm -rf ./build\ndocker compose up -d")
            .is_empty());

        let hits = e.scan_dangerous("ls\nsudo rm -rf /\n");
        assert!(
            hits.iter()
                .any(|(seg, r)| seg.contains("rm -rf /") && r == "删除根目录"),
            "{hits:?}"
        );
        // 段命中只报命中段，不把整段粘贴文本当成命中
        assert!(
            hits.iter().all(|(seg, _)| !seg.contains("ls\n")),
            "{hits:?}"
        );

        // 提权/包装前缀与审批同口径
        let hits = e.scan_dangerous("sudo reboot");
        assert!(hits.iter().any(|(_, r)| r == "重启"), "{hits:?}");

        // 整串单行（不做分段也能命中）
        let hits = e.scan_dangerous(":(){ :|:& };:");
        assert!(hits.iter().any(|(_, r)| r == "fork 炸弹"), "{hits:?}");

        // 去重：同一段多处出现只报一条
        let hits = e.scan_dangerous("reboot\nreboot");
        assert_eq!(hits.len(), 1, "{hits:?}");
    }

    /// 十轮：提权/包装前缀不得绕过锚定的内置 deny。
    #[test]
    fn wrapper_prefix_does_not_bypass_deny() {
        let e = engine();
        for cmd in [
            "sudo rm -rf /",
            "sudo -u alice rm -rf /",
            "doas reboot",
            "nohup shutdown now",
            "env FOO=1 dd if=/dev/zero of=/dev/sda",
            "PATH=/usr/sbin:/sbin init 0",
            "nice -n 19 mkfs.ext4 /dev/sdb1",
            "sudo systemctl reboot",
            "sudo shred -n 1 /dev/sda",
            "sudo cfdisk /dev/sdb",
        ] {
            assert_eq!(
                e.evaluate("agent-a", cmd).verdict,
                SegmentVerdict::Dangerous,
                "cmd={cmd}"
            );
        }
    }

    /// 提权前缀下的安全命令不得误伤（前缀引入后词边界语义保持）。
    #[test]
    fn wrapper_prefix_safe_commands_not_flagged() {
        let e = engine();
        for cmd in [
            "sudo rm -rf /tmp/build",
            "sudo apt install ripgrep",
            "sudo df -h",
            "env EDITOR=vim crontab -e",
        ] {
            assert_ne!(
                e.evaluate("agent-a", cmd).verdict,
                SegmentVerdict::Dangerous,
                "cmd={cmd}"
            );
        }
    }

    #[test]
    fn unparseable_goes_to_approval() {
        let e = engine();
        assert_eq!(
            e.evaluate("agent-a", "if [ -f x ]; then").verdict,
            SegmentVerdict::NeedsApproval
        );
    }

    #[test]
    fn builtin_denies_not_deletable() {
        // 即便 allow_rules 全放行，deny 优先
        let e = engine();
        e.set_policy(
            "agent-b",
            Policy {
                allow_rules: vec![AllowRule {
                    pattern: "*".into(),
                    note: "全放行".into(),
                }],
                ..Default::default()
            },
        );
        assert_eq!(
            e.evaluate("agent-b", "reboot").verdict,
            SegmentVerdict::Dangerous
        );
    }

    #[test]
    fn edited_command_still_checked() {
        let e = engine();
        assert!(!e.is_editable_decision("agent-a", "reboot"));
        assert!(e.is_editable_decision("agent-a", "systemctl status nginx"));
    }

    #[test]
    fn substitution_forces_approval() {
        // M2 回归：替换体是 deny/allow 双盲区 → 内容不可预判必须报审，
        // 不得借 `echo *` TTL/allow 规则免审执行。
        let e = engine();
        for cmd in ["echo $(reboot)", "echo `reboot`", "echo $(rm -rf /)"] {
            assert_eq!(
                e.evaluate("agent-a", cmd).verdict,
                SegmentVerdict::NeedsApproval,
                "cmd={cmd}"
            );
        }
        // deny 仍优先：即便内容不可预判，整体文本命中内置 deny → Dangerous
        assert_eq!(
            e.evaluate("agent-a", "reboot $(echo hi)").verdict,
            SegmentVerdict::Dangerous
        );
    }

    #[test]
    fn deny_rules_are_per_agent() {
        // m3 回归：A 的追加 deny 不得作用于 B（方向保守但语义应为逐 agent）
        let e = ApprovalEngine::new().unwrap();
        e.set_policy(
            "agent-a",
            Policy {
                deny_rules: vec![session_api::DenyRule {
                    pattern: "^curl".into(),
                    reason: "A 禁 curl".into(),
                    builtin: false,
                }],
                ..Default::default()
            },
        );
        assert_eq!(
            e.evaluate("agent-a", "curl example.com").verdict,
            SegmentVerdict::Dangerous
        );
        assert_eq!(
            e.evaluate("agent-b", "curl example.com").verdict,
            SegmentVerdict::NeedsApproval
        );
    }
}
