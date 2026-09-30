//! ~/.ssh/config 解析（导入用）。只取与建连相关的字段：
//! Host / HostName / User / Port / IdentityFile；其余关键字忽略。
//! 语义对齐 OpenSSH 的常用子集：`=` 或空白分隔、`#` 注释、关键字大小写不敏感、
//! 同一块内首值优先、通配符条目（*/?）跳过、Match 块整体跳过（条件导入有误伤风险）。

use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshConfigEntry {
    /// Host 模式原文（不含通配符，因通配符条目被跳过）
    pub name: String,
    /// HostName 值；未写时按 ssh 语义回落为 Host 名本身
    pub address: String,
    pub port: Option<u16>,
    pub username: Option<String>,
    /// IdentityFile 首个值，`~/` 已展开；文件存在与否由调用方判断
    pub identity_path: Option<PathBuf>,
}

struct Draft {
    name: String,
    address: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    identity: Option<PathBuf>,
}

impl Draft {
    fn finish(self) -> SshConfigEntry {
        SshConfigEntry {
            address: self.address.unwrap_or_else(|| self.name.clone()),
            name: self.name,
            port: self.port,
            username: self.username,
            identity_path: self.identity,
        }
    }
}

/// 解析 ssh config 文本。`Host a b c` 会拆成多个条目（共享同一块内设置）。
pub fn parse_ssh_config(content: &str) -> Vec<SshConfigEntry> {
    let mut out: Vec<Draft> = Vec::new();
    let mut pending: Vec<Draft> = Vec::new();
    let mut in_match = false;

    for raw in content.lines() {
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
                pending = value
                    .split_whitespace()
                    .filter(|p| !p.contains('*') && !p.contains('?') && !p.starts_with('!'))
                    .map(|p| Draft {
                        name: p.to_string(),
                        address: None,
                        port: None,
                        username: None,
                        identity: None,
                    })
                    .collect();
            }
            "match" => {
                // 条件块：不导入；丢弃挂起条目直至下一个 Host
                out.append(&mut pending);
                pending.clear();
                in_match = true;
            }
            _ if in_match => {}
            "hostname" => {
                for d in pending.iter_mut() {
                    if d.address.is_none() {
                        d.address = Some(value.clone());
                    }
                }
            }
            "user" => {
                for d in pending.iter_mut() {
                    if d.username.is_none() {
                        d.username = Some(value.clone());
                    }
                }
            }
            "port" => {
                if let Ok(p) = value.parse::<u16>() {
                    for d in pending.iter_mut() {
                        if d.port.is_none() {
                            d.port = Some(p);
                        }
                    }
                }
            }
            "identityfile" => {
                let p = expand_tilde(&value);
                for d in pending.iter_mut() {
                    if d.identity.is_none() {
                        d.identity = Some(p.clone());
                    }
                }
            }
            _ => {}
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
        assert_eq!(
            parse_ssh_config(cfg),
            vec![SshConfigEntry {
                name: "web".into(),
                address: "10.0.0.5".into(),
                port: Some(2222),
                username: Some("deploy".into()),
                identity_path: None,
            }]
        );
    }

    #[test]
    fn defaults_and_multi_pattern() {
        // 无 HostName → 用 Host 名；多模式拆条目；通配符跳过
        let cfg = "Host web db * !secret\n  User u1\n  Port 2200\n";
        let got = parse_ssh_config(cfg);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "web");
        assert_eq!(got[0].address, "web");
        assert_eq!(got[0].username.as_deref(), Some("u1"));
        assert_eq!(got[1].name, "db");
    }

    #[test]
    fn equals_separator_and_case_insensitive() {
        let cfg = "HOST=prod\nHOSTNAME=prod.example.com\nUSER=ops\nPORT=22\n";
        let got = parse_ssh_config(cfg);
        assert_eq!(got[0].address, "prod.example.com");
        assert_eq!(got[0].username.as_deref(), Some("ops"));
    }

    #[test]
    fn first_value_wins() {
        let cfg = "Host a\n  User one\n  User two\n  Port 1111\n  Port 2222\n";
        let got = parse_ssh_config(cfg);
        assert_eq!(got[0].username.as_deref(), Some("one"));
        assert_eq!(got[0].port, Some(1111));
    }

    #[test]
    fn comments_and_unknown_keys_ignored() {
        let cfg = "# top comment\nHost a # trailing\n  ForwardAgent yes\n  # nested\n  IdentityFile ~/.ssh/id_ed25519\n";
        let got = parse_ssh_config(cfg);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "a");
        assert!(got[0]
            .identity_path
            .as_ref()
            .unwrap()
            .to_string_lossy()
            .ends_with(".ssh/id_ed25519"));
    }

    #[test]
    fn match_block_skipped() {
        let cfg = "Host a\n  User u\nMatch host b\n  HostName 1.2.3.4\n  User nope\nHost c\n  Port 23\n";
        let got = parse_ssh_config(cfg);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "a");
        assert_eq!(got[1].name, "c");
        assert_eq!(got[1].port, Some(23));
    }

    #[test]
    fn identity_only_first_per_block() {
        let cfg = "Host a\n  IdentityFile ~/.ssh/k1\n  IdentityFile ~/.ssh/k2\n";
        let got = parse_ssh_config(cfg);
        assert!(got[0]
            .identity_path
            .as_ref()
            .unwrap()
            .to_string_lossy()
            .ends_with("k1"));
    }

    #[test]
    fn bad_port_ignored() {
        let cfg = "Host a\n  Port notanumber\n";
        assert_eq!(parse_ssh_config(cfg)[0].port, None);
    }
}
