//! 审批引擎实现（L1 §3.3）：deny → allow/TTL → default；tree-sitter-bash 逐段求值。
//! 内置危险模式默认拒绝且不可删除；TTL 授权窗口到期自动失效。

use chrono::Utc;
use regex::Regex;
use session_api::{
    ApprovalMode, ApprovalStatus, Decision, Policy, SegmentReport,
};
use std::sync::{Arc, Mutex};
use tree_sitter::{Parser, Tree};

/// 内置危险模式（不可删除；命中直接 DangerousPattern，ApproveEdited 不可绕过）。
pub const BUILTIN_DENY_PATTERNS: &[(&str, &str)] = &[
    (r"^\s*rm\b[^\n;|&]*(?:\s|\A)/(?:\s|$)", "删除根目录"),
    (r"^\s*rm\b[^\n;|&]*\s/(?:\s|$)", "删除根目录"),
    (r"^\s*mkfs(\.\w+)?\b", "格式化文件系统"),
    (r"^\s*dd\b[^\n]*\bof=/dev/(?:sd|nvme|vd|hd|disk|mapper)", "dd 覆写块设备"),
    (r">\s*/dev/(?:sd|nvme|vd|hd)[a-z]", "覆写块设备"),
    (r"^\s*shutdown\b", "关机"),
    (r"^\s*reboot\b", "重启"),
    (r"^\s*halt\b", "停机"),
    (r"^\s*poweroff\b", "断电"),
    (r"^\s*init\s+[06]\b", "切换运行级"),
    (r":\(\)\s*\{.*\};\s*:", "fork 炸弹"),
    (r"^\s*chmod\s+(-[a-zA-Z]+\s+)*777\s+/(?:\s|$)", "根目录开放权限"),
    (r"^\s*wipefs\b", "擦除文件系统签名"),
    (r"^\s*(?:fdisk|cfdisk|sfdisk|sgdisk|parted)\s+/dev/", "分区工具作用于块设备"),
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
            let text = node.utf8_text(src.as_bytes()).unwrap_or("").trim().to_string();
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
        if !matches!(k, "list" | "pipeline" | "command" | "comment" | "variable_assignment") {
            complex = true;
        }
    }
    let unparseable = unparseable || complex;
    if unparseable {
        return (vec![source.trim().to_string()], unparseable, has_substitution);
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
        self.deny_reason(agent_id, edited).is_none()
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
                    AllowRule { pattern: "systemctl status*".into(), note: "查看状态".into() },
                    AllowRule { pattern: "docker ps".into(), note: "列容器".into() },
                    AllowRule { pattern: "^git (status|diff)".into(), note: "git 只读".into() },
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
        assert_eq!(engine().evaluate("agent-a", "docker ps").verdict, SegmentVerdict::AutoAllow);
    }

    #[test]
    fn prefix_allow() {
        assert_eq!(engine().evaluate("agent-a", "systemctl status nginx").verdict, SegmentVerdict::AutoAllow);
        assert_eq!(engine().evaluate("agent-a", "systemctl stop nginx").verdict, SegmentVerdict::NeedsApproval);
    }

    #[test]
    fn regex_allow() {
        let e = engine();
        assert_eq!(e.evaluate("agent-a", "git status").verdict, SegmentVerdict::AutoAllow);
        assert_eq!(e.evaluate("agent-a", "git push").verdict, SegmentVerdict::NeedsApproval);
    }

    #[test]
    fn ttl_allow_and_expiry() {
        let e = engine();
        assert_eq!(e.evaluate("agent-a", "echo hi").verdict, SegmentVerdict::AutoAllow);
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
        assert_eq!(e.evaluate("agent-a", "echo hi").verdict, SegmentVerdict::NeedsApproval);
    }

    #[test]
    fn compound_command_requires_all_segments() {
        // L1 §3.3：`systemctl status; reboot` 不得因前缀放行 reboot（deny 优先 → Dangerous）
        let e = engine();
        assert_eq!(e.evaluate("agent-a", "systemctl status; reboot").verdict, SegmentVerdict::Dangerous);
        // 未命中段阻止整体放行
        assert_eq!(e.evaluate("agent-a", "docker ps && docker inspect x").verdict, SegmentVerdict::NeedsApproval);
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
            assert_eq!(e.evaluate("agent-a", cmd).verdict, SegmentVerdict::Dangerous, "cmd={cmd}");
        }
    }

    #[test]
    fn safe_commands_not_flagged() {
        let e = engine();
        for cmd in ["rm -rf /tmp/build", "df -h", "echo reboot-is-a-word"] {
            assert_ne!(e.evaluate("agent-a", cmd).verdict, SegmentVerdict::Dangerous, "cmd={cmd}");
        }
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
            assert_eq!(e.evaluate("agent-a", cmd).verdict, SegmentVerdict::Dangerous, "cmd={cmd}");
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
            assert_ne!(e.evaluate("agent-a", cmd).verdict, SegmentVerdict::Dangerous, "cmd={cmd}");
        }
    }

    #[test]
    fn unparseable_goes_to_approval() {
        let e = engine();
        assert_eq!(e.evaluate("agent-a", "if [ -f x ]; then").verdict, SegmentVerdict::NeedsApproval);
    }

    #[test]
    fn builtin_denies_not_deletable() {
        // 即便 allow_rules 全放行，deny 优先
        let e = engine();
        e.set_policy(
            "agent-b",
            Policy {
                allow_rules: vec![AllowRule { pattern: "*".into(), note: "全放行".into() }],
                ..Default::default()
            },
        );
        assert_eq!(e.evaluate("agent-b", "reboot").verdict, SegmentVerdict::Dangerous);
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
        assert_eq!(e.evaluate("agent-a", "reboot $(echo hi)").verdict, SegmentVerdict::Dangerous);
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
        assert_eq!(e.evaluate("agent-a", "curl example.com").verdict, SegmentVerdict::Dangerous);
        assert_eq!(e.evaluate("agent-b", "curl example.com").verdict, SegmentVerdict::NeedsApproval);
    }
}
