//! ~/.ssh/config 解析（C7 导入诊断用，R22/v2）。取与建连相关的字段：
//! Host / HostName / User / Port / IdentityFile；其余关键字按 DF7.1 三级分级：
//! 阻断（ProxyJump/ProxyCommand/Include/CertificateFile 等——值影响建连路径但
//! V1 不跟随）、警告（ServerAlive* / Compression / Forward* 等连通性无关——可导入、
//! 预览展示已忽略）、忽略（注释/空行/五个导入键）。
//! 语义对齐 OpenSSH 常用子集：`=` 或空白分隔、`#` 注释、关键字大小写不敏感、
//! 同块首值优先、**全文件首值优先（first-obtained-wins）**——因此更早出现的通配符
//! Host 块（或顶层 Include / 顶层五键）会对其后条目形成「影子」：被影子覆盖的键
//! 值不可信，条目按阻断上报（DF7.2：Include V1 不跟随）。Match 块整体跳过
//! （V1 子集：块内不产生条目，登记于任务文档）。

use std::path::PathBuf;

/// 条目无法直接导入/需提示的指令记录（vault 侧自持结构，session-api 转换）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshUnsupported {
    /// 指令原文关键字（小写）；影子继承统一记 `include`/`host *` 语义关键字
    pub directive: String,
    /// true = DF7.1 阻断（directly_importable=false）；false = 警告（可导入，预览展示）
    pub blocking: bool,
    /// 指令所在行（1 起）
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshConfigEntry {
    /// Host 模式原文（不含通配符，因通配符条目被跳过）
    pub name: String,
    /// HostName 值；未写时按 ssh 语义回落为 Host 名本身（被影子覆盖时不可信——
    /// 由 unsupported 阻断项表达，调用方据此拒绝直连导入）
    pub address: String,
    pub port: Option<u16>,
    pub username: Option<String>,
    /// IdentityFile 首个值，`~/` 已展开；文件存在与否由调用方判断
    pub identity_path: Option<PathBuf>,
    /// Host 行行号（1 起）
    pub source_line: u32,
    /// DF7.1 分级结果（阻断 + 警告；忽略级不记）
    pub unsupported: Vec<SshUnsupported>,
}

/// DF7.1 阻断级指令：影响建连路径/认证来源，V1 不跟随其语义
fn is_blocking_key(key: &str) -> bool {
    matches!(key, "proxyjump" | "proxycommand" | "proxyusefdpass" | "certificatefile" | "include")
}

/// 影子登记（first-obtained-wins：首现即胜，后续同名键不覆盖早前记录）
fn push_shadow(shadow: &mut Vec<(String, u32)>, key: &str, lineno: u32) {
    if !shadow.iter().any(|(k, _)| k == key) {
        shadow.push((key.to_string(), lineno));
    }
}

struct Draft {
    name: String,
    address: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    identity: Option<PathBuf>,
    source_line: u32,
    unsupported: Vec<SshUnsupported>,
}

impl Draft {
    fn finish(self) -> SshConfigEntry {
        SshConfigEntry {
            address: self.address.unwrap_or_else(|| self.name.clone()),
            name: self.name,
            port: self.port,
            username: self.username,
            identity_path: self.identity,
            source_line: self.source_line,
            unsupported: self.unsupported,
        }
    }
}

/// 解析 ssh config 文本。`Host a b c` 拆成多个条目（共享块内设置）。
/// 通配符块（任一模式含 `*`/`?`/`!`）除产出具体条目外，还把块内五键登记为
/// 「影子」（first-obtained-wins：更早块遮蔽其后条目同名键）。
pub fn parse_ssh_config(content: &str) -> Vec<SshConfigEntry> {
    let mut out: Vec<Draft> = Vec::new();
    let mut pending: Vec<Draft> = Vec::new();
    let mut in_match = false;
    let mut block_wildcard = false;
    // (键, 行号) —— 更早通配符块/顶层设置对后续条目的影子；行号用于「早于本条目」过滤
    let mut shadow: Vec<(String, u32)> = Vec::new();

    for (idx, raw) in content.lines().enumerate() {
        let lineno = (idx + 1) as u32;
        let line = strip_comment(raw).trim().to_string();
        if line.is_empty() {
            continue;
        }
        let Some((key_raw, value)) = split_kv(&line) else { continue };
        let key = key_raw.to_ascii_lowercase();
        match key.as_str() {
            "host" => {
                // Host 行开新块：上一块的所有条目落盘；Match 状态复位
                out.append(&mut pending);
                in_match = false;
                let patterns: Vec<&str> = value.split_whitespace().collect();
                let concrete: Vec<&str> = patterns
                    .iter()
                    .filter(|p| !p.contains('*') && !p.contains('?') && !p.starts_with('!'))
                    .copied()
                    .collect();
                block_wildcard = concrete.len() != patterns.len();
                pending = concrete
                    .into_iter()
                    .map(|p| Draft {
                        name: p.to_string(),
                        address: None,
                        port: None,
                        username: None,
                        identity: None,
                        source_line: lineno,
                        // 影子只含早于本条目的记录（first-obtained-wins）
                        unsupported: shadow
                            .iter()
                            .filter(|(_, l)| *l < lineno)
                            .map(|(k, l)| SshUnsupported {
                                directive: k.clone(),
                                blocking: true,
                                line: *l,
                            })
                            .collect(),
                    })
                    .collect();
            }
            "match" => {
                // 条件块：不导入；丢弃挂起条目直至下一个 Host（V1 子集，登记）
                out.append(&mut pending);
                pending.clear();
                in_match = true;
            }
            _ if in_match => {
                // Match 条件块（rev-r22 H1）：不产出条目；块内阻断键与五导入键
                // 保守入影子——解析期无法判定匹配条件，对命中该条件的后续连接
                // first-obtained-wins 成立，宁可阻断也不静默可导入。警告级键
                // 不入影子（不影响连通语义，避免对后续条目误标阻断）。
                if is_blocking_key(&key) {
                    push_shadow(&mut shadow, &key, lineno);
                }
                match key.as_str() {
                    "hostname" | "user" | "port" | "identityfile" => push_shadow(&mut shadow, &key, lineno),
                    _ => {}
                }
            }
            _ if is_blocking_key(&key) => {
                // 阻断指令：本块条目直接上报；通配符块/顶层（无挂起条目）则入影子
                if pending.is_empty() || block_wildcard {
                    push_shadow(&mut shadow, &key, lineno);
                }
                for d in pending.iter_mut() {
                    d.unsupported.push(SshUnsupported {
                        directive: key.clone(),
                        blocking: true,
                        line: lineno,
                    });
                }
            }
            "hostname" => {
                if pending.is_empty() || block_wildcard {
                    push_shadow(&mut shadow, "hostname", lineno);
                }
                for d in pending.iter_mut() {
                    if d.address.is_none() {
                        d.address = Some(value.clone());
                    }
                }
            }
            "user" => {
                if pending.is_empty() || block_wildcard {
                    push_shadow(&mut shadow, "user", lineno);
                }
                for d in pending.iter_mut() {
                    if d.username.is_none() {
                        d.username = Some(value.clone());
                    }
                }
            }
            "port" => {
                if let Ok(p) = value.parse::<u16>() {
                    if pending.is_empty() || block_wildcard {
                        push_shadow(&mut shadow, "port", lineno);
                    }
                    for d in pending.iter_mut() {
                        if d.port.is_none() {
                            d.port = Some(p);
                        }
                    }
                }
            }
            "identityfile" => {
                if pending.is_empty() || block_wildcard {
                    push_shadow(&mut shadow, "identityfile", lineno);
                }
                let p = expand_tilde(&value);
                for d in pending.iter_mut() {
                    if d.identity.is_none() {
                        d.identity = Some(p.clone());
                    } else {
                        // 同块多个 IdentityFile：只有首个生效导入，其余警告
                        d.unsupported.push(SshUnsupported {
                            directive: "identityfile+".into(),
                            blocking: false,
                            line: lineno,
                        });
                    }
                }
            }
            _ => {
                // 非阻断非导入键：警告级（连通性无关，可导入，预览展示已忽略）
                for d in pending.iter_mut() {
                    d.unsupported.push(SshUnsupported {
                        directive: key.clone(),
                        blocking: false,
                        line: lineno,
                    });
                }
            }
        }
    }
    out.append(&mut pending);
    out.into_iter().map(Draft::finish).collect()
}

/// 去 `#` 注释（ssh 语义：`#` 前有空白才是注释起始；值中不允许未转义 `#`）。
fn strip_comment(line: &str) -> &str {
    if line.trim_start().starts_with('#') {
        return "";
    }
    match line.find(" #") {
        Some(i) => &line[..i],
        None => line,
    }
}

/// 键值分隔：空白或 `=`（ssh config 允许 `Host=foo`）。值为键后余下的整行
/// （`Host a b c` 的多模式靠空格保留在 value 里，由 Host 分支再拆）。
fn split_kv(line: &str) -> Option<(&str, String)> {
    if let Some((k, v)) = line.split_once('=') {
        let k = k.trim();
        let v = v.trim();
        if k.is_empty() || v.is_empty() {
            return None;
        }
        return Some((k, v.to_string()));
    }
    let mut it = line.splitn(2, char::is_whitespace);
    let k = it.next()?.trim();
    let v = it.next()?.trim().to_string();
    if k.is_empty() || v.is_empty() {
        return None;
    }
    Some((k, v))
}

fn expand_tilde(p: &str) -> PathBuf {
    if p == "~" {
        if let Some(h) = std::env::var_os("HOME") {
            return PathBuf::from(h);
        }
    } else if let Some(rest) = p.strip_prefix("~/") {
        if let Some(h) = std::env::var_os("HOME") {
            return PathBuf::from(h).join(rest);
        }
    }
    PathBuf::from(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_block() {
        let cfg = "Host web\n  HostName 10.0.0.5\n  User deploy\n  Port 2222\n";
        let e = &parse_ssh_config(cfg)[0];
        assert_eq!(e.name, "web");
        assert_eq!(e.address, "10.0.0.5");
        assert_eq!(e.username.as_deref(), Some("deploy"));
        assert_eq!(e.port, Some(2222));
        assert_eq!(e.source_line, 1);
        assert!(e.unsupported.is_empty());
    }

    #[test]
    fn defaults_and_multi_pattern() {
        let cfg = "Host a b\n  Port 2200\n";
        let es = parse_ssh_config(cfg);
        assert_eq!(es.len(), 2);
        assert_eq!(es[1].name, "b");
        assert_eq!(es[1].address, "b");
        assert_eq!(es[1].port, Some(2200));
    }

    #[test]
    fn equals_separator_and_case_insensitive() {
        let cfg = "HOST=x\n  HOSTNAME = y\n";
        let e = &parse_ssh_config(cfg)[0];
        assert_eq!(e.name, "x");
        assert_eq!(e.address, "y");
    }

    #[test]
    fn first_value_wins() {
        let cfg = "Host a\n  Port 1\n  Port 2\n";
        assert_eq!(parse_ssh_config(cfg)[0].port, Some(1));
    }

    #[test]
    fn comments_and_unknown_keys_ignored() {
        let cfg = "# c\nHost a\n  # mid\n  Compression yes\n";
        let e = &parse_ssh_config(cfg)[0];
        assert_eq!(e.address, "a");
        // v2：连通性无关键改记警告（DF7.1），不再静默
        assert_eq!(e.unsupported.len(), 1);
        assert!(!e.unsupported[0].blocking);
        assert_eq!(e.unsupported[0].directive, "compression");
        assert_eq!(e.unsupported[0].line, 4);
    }

    #[test]
    fn match_block_skipped() {
        let cfg = "Host a\n  Port 1\nMatch all\n  Port 9\n  HostName zzz\nHost b\n  Port 2\n";
        let es = parse_ssh_config(cfg);
        assert_eq!(es.len(), 2);
        assert_eq!(es[0].name, "a");
        assert_eq!(es[1].name, "b");
        assert_eq!(es[1].port, Some(2));
    }

    /// rev-r22 H1 判别（旧代码必红）：Match 段键对命中条件的后续连接同样
    /// first-obtained-wins——保守入影子，使后续条目阻断不可直接导入（A09
    /// 「不静默变成可连接的错误配置」）。
    #[test]
    fn match_shadow_blocks_later_entry_user() {
        // 真实 ssh 有效用户 = corpuser（Match 段先取得），条目面写的 ci 不生效
        let cfg = "Match originalhost build*\n  User corpuser\n\nHost build.corp\n  HostName 10.0.0.9\n  User ci\n";
        let es = parse_ssh_config(cfg);
        assert_eq!(es.len(), 1);
        let e = &es[0];
        assert_eq!(e.username.as_deref(), Some("ci"), "条目自身值照常解析展示");
        assert!(
            e.unsupported
                .iter()
                .any(|u| u.directive == "user" && u.blocking && u.line == 2),
            "user 键须以阻断级入条目 unsupported（影子）: {:?}",
            e.unsupported
        );
    }

    #[test]
    fn match_shadow_blocks_later_entry_proxyjump() {
        // Match all + ProxyJump：其后条目若可直接导入 = 绕过跳板直连（rev P2 形态）
        let cfg = "Match all\n  ProxyJump jumphost\n\nHost web\n  HostName 10.0.0.8\n  User ops\n";
        let es = parse_ssh_config(cfg);
        assert_eq!(es.len(), 1);
        assert!(
            es[0].unsupported
                .iter()
                .any(|u| u.directive == "proxyjump" && u.blocking),
            "{:?}",
            es[0].unsupported
        );
    }

    #[test]
    fn match_warning_keys_do_not_shadow() {
        // 警告级键不入影子（不影响连通语义，避免后续条目误标阻断）
        let cfg = "Match all\n  ServerAliveInterval 30\n\nHost web\n  HostName 10.0.0.8\n  User ops\n";
        let es = parse_ssh_config(cfg);
        assert_eq!(es.len(), 1);
        assert!(es[0].unsupported.is_empty(), "{:?}", es[0].unsupported);
    }

    /// rev-r22 L1 判别：影子登记首现即胜——多个通配块设同名键只记一次
    #[test]
    fn shadow_push_dedups() {
        let cfg = "Host *.a\n  User one\n\nHost *.b\n  User two\n\nHost real\n  HostName 10.0.0.7\n";
        let es = parse_ssh_config(cfg);
        let e = es.iter().find(|e| e.name == "real").unwrap();
        let users: Vec<_> = e.unsupported.iter().filter(|u| u.directive == "user").collect();
        assert_eq!(users.len(), 1, "影子 user 只登记首个: {:?}", e.unsupported);
        assert_eq!(users[0].line, 2);
    }

    #[test]
    fn identity_only_first_per_block() {
        let cfg = "Host a\n  IdentityFile ~/k1\n  IdentityFile ~/k2\n";
        let e = &parse_ssh_config(cfg)[0];
        assert_eq!(e.identity_path, Some(expand_tilde("~/k1")));
        assert_eq!(e.unsupported.len(), 1);
        assert_eq!(e.unsupported[0].directive, "identityfile+");
    }

    #[test]
    fn bad_port_ignored() {
        let cfg = "Host a\n  Port xx\n";
        assert_eq!(parse_ssh_config(cfg)[0].port, None);
    }

    // ---- v2 C7 分级 ----

    #[test]
    fn proxyjump_is_blocking() {
        let cfg = "Host a\n  HostName 10.0.0.1\n  ProxyJump bastion\n";
        let e = &parse_ssh_config(cfg)[0];
        assert_eq!(e.unsupported.len(), 1);
        assert!(e.unsupported[0].blocking);
        assert_eq!(e.unsupported[0].directive, "proxyjump");
        assert_eq!(e.unsupported[0].line, 3);
    }

    #[test]
    fn include_in_block_is_blocking() {
        let cfg = "Host a\n  Include ~/.ssh/config.d/work\n";
        let e = &parse_ssh_config(cfg)[0];
        assert!(e.unsupported.iter().any(|u| u.blocking && u.directive == "include"));
    }

    #[test]
    fn wildcard_block_shadows_later_entries() {
        // first-obtained-wins：`Host *` 在前，其后条目被同名键遮蔽 → 阻断
        let cfg = "Host *\n  User ops\n  Port 2222\nHost web\n  HostName 10.0.0.9\n  User real\n";
        let e = &parse_ssh_config(cfg)[0];
        assert_eq!(e.name, "web");
        let blocks: Vec<_> = e.unsupported.iter().filter(|u| u.blocking).collect();
        assert_eq!(blocks.len(), 2, "user+port 被遮蔽：{:?}", e.unsupported);
        assert!(blocks.iter().any(|u| u.directive == "user" && u.line == 2));
        assert!(blocks.iter().any(|u| u.directive == "port" && u.line == 3));
        // HostName 未被遮蔽（通配块没设）
        assert!(!e.unsupported.iter().any(|u| u.directive == "hostname"));
    }

    #[test]
    fn wildcard_block_after_entry_does_not_shadow() {
        // 通配块在后：先到先得，条目自值生效 → 无阻断
        let cfg = "Host web\n  User real\nHost *\n  User ops\n";
        let e = &parse_ssh_config(cfg)[0];
        assert!(e.unsupported.is_empty(), "{:?}", e.unsupported);
    }

    #[test]
    fn wildcard_block_irrelevant_keys_do_not_shadow() {
        // 通配块只有非导入键：警告级，不产生阻断影子
        let cfg = "Host *\n  Compression yes\nHost web\n  User u\n";
        let e = &parse_ssh_config(cfg)[0];
        assert_eq!(e.name, "web");
        assert!(e.unsupported.iter().all(|u| !u.blocking), "{:?}", e.unsupported);
    }

    #[test]
    fn toplevel_include_shadows_all() {
        // DF7.2：顶层 Include V1 不跟随——其后所有条目阻断（值可能来自被包含文件）
        let cfg = "Include ~/.ssh/config.d/*\n\nHost web\n  User u\n";
        let e = &parse_ssh_config(cfg)[0];
        assert!(e.unsupported.iter().any(|u| u.blocking && u.directive == "include"));
        assert_eq!(e.unsupported[0].line, 1);
    }

    #[test]
    fn mixed_pattern_block_is_shadowing() {
        // `Host web web-*`：web-* 可匹配后续主机 → 块内五键入影子
        let cfg = "Host web web-*\n  User ops\nHost web2\n  User u\n";
        let e = &parse_ssh_config(cfg)[1];
        assert!(e.unsupported.iter().any(|u| u.blocking && u.directive == "user"));
    }

    #[test]
    fn no_user_preserved_as_none() {
        let cfg = "Host a\n  HostName 10.0.0.1\n";
        assert_eq!(parse_ssh_config(cfg)[0].username, None);
    }
}
