//! `~/.ssh/config` 导入：路径解析、与现有主机对账、身份落库。
//!
//! 解析在 `tinyssh_vault::sshcfg`（纯函数）；这里只做组合逻辑。
//! 从 lib.rs 整块抽出（第二波结构拆分），CLI 与 GUI 共用。

use crate::*;
use session_api::*;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// ~/.ssh/config 导入（路线图⑨）：CLI 与 GUI 共用的组合逻辑。
// 解析在 vault::sshcfg（纯函数）；这里做路径解析、与现有主机对账、
// 身份落库（IdentityFile → Key）或 ssh-agent 引用（无 IdentityFile → Agent）。
// ---------------------------------------------------------------------------

impl SessionManager {
    fn ssh_config_path(explicit: Option<&Path>) -> PathBuf {
        match explicit {
            Some(p) => p.to_path_buf(),
            // Windows 原生环境无 HOME → 回退 USERPROFILE（审计 W1 同族；OpenSSH for
            // Windows 的配置就在 %USERPROFILE%\.ssh\config）
            None => std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|h| PathBuf::from(h).join(".ssh/config"))
                .unwrap_or_else(|| PathBuf::from(".ssh/config")),
        }
    }

    fn load_entries(
        explicit: Option<&Path>,
    ) -> Result<(PathBuf, Vec<tinyssh_vault::sshcfg::SshConfigEntry>)> {
        let path = Self::ssh_config_path(explicit);
        let content = std::fs::read_to_string(&path)
            .map_err(|e| Error::InvalidInput(format!("读取 {} 失败: {e}", path.display())))?;
        let mut entries = tinyssh_vault::sshcfg::parse_ssh_config(&content);
        // 同名 Host 块会被 ssh 合并；去重避免重复导入
        entries.dedup_by(|a, b| a.name == b.name);
        Ok((path, entries))
    }

    fn default_username(entry: &tinyssh_vault::sshcfg::SshConfigEntry) -> String {
        entry
            .username
            .clone()
            .or_else(|| std::env::var("USER").ok())
            .unwrap_or_else(|| "root".into())
    }

    /// C7/DF7.1+DF7.5：无阻断指令且已指定用户才可直接导入
    fn directly_importable(entry: &tinyssh_vault::sshcfg::SshConfigEntry) -> bool {
        entry.unsupported.iter().all(|u| !u.blocking) && entry.username.is_some()
    }

    /// 预览（C7）：解析 + DF7.1 分级 + 与现有主机对账（同名或同 address+port+user
    /// 视为已导入）。无 User 条目不静默 root——user_specified=false、
    /// directly_importable=false（DF7.5），username 仅作兜底猜测值。
    pub async fn ssh_config_preview(&self, path: Option<&Path>) -> Result<Vec<SshConfigPreview>> {
        let (cfg_path, entries) = Self::load_entries(path)?;
        let existing = self.list_hosts(&Actor::Human).await?;
        Ok(entries
            .into_iter()
            .map(|e| {
                let username = Self::default_username(&e);
                let port = e.port.unwrap_or(22);
                let unsupported = e
                    .unsupported
                    .iter()
                    .map(|u| SshUnsupportedDirective {
                        directive: u.directive.clone(),
                        level: if u.blocking {
                            SshUnsupportedLevel::Blocking
                        } else {
                            SshUnsupportedLevel::Warning
                        },
                        line: u.line,
                    })
                    .collect();
                SshConfigPreview {
                    already_imported: existing.iter().any(|h| {
                        h.name == e.name
                            || (h.address == e.address && h.port == port && h.username == username)
                    }),
                    has_identity: e.identity_path.is_some(),
                    directly_importable: Self::directly_importable(&e),
                    user_specified: e.username.is_some(),
                    source_file: cfg_path.display().to_string(),
                    source_line: e.source_line,
                    unsupported,
                    name: e.name,
                    address: e.address,
                    port,
                    username,
                }
            })
            .collect())
    }

    /// 勾选导入（C7）：阻断条目拒绝（skipped=Blocked）；重复（同名 OR
    /// address+port+user）默认跳过（skipped=Duplicate），overwrite=true 时以既有
    /// 主机 id 覆盖写入（DF7.3）。逐条出结果，单条失败不阻塞其余。
    pub async fn ssh_config_import(
        &self,
        ctx: &Actor,
        path: Option<&Path>,
        names: &[String],
        overwrite: bool,
    ) -> Vec<SshImportOutcome> {
        let load = Self::load_entries(path);
        let (entries, existing) = match load {
            Ok((_, e)) => match self.list_hosts(ctx).await {
                Ok(h) => (e, h),
                Err(err) => {
                    return names
                        .iter()
                        .map(|n| SshImportOutcome {
                            name: n.clone(),
                            host_id: None,
                            error: Some(err.to_string()),
                            skipped_reason: None,
                        })
                        .collect();
                }
            },
            Err(e) => {
                return names
                    .iter()
                    .map(|n| SshImportOutcome {
                        name: n.clone(),
                        host_id: None,
                        error: Some(e.to_string()),
                        skipped_reason: None,
                    })
                    .collect();
            }
        };
        let mut out = Vec::new();
        // rev-r22 M3：批内可见性——成功导入的主机立即并入查重集，同批后续
        // 同三元组条目按 Duplicate 跳过（不双落库），与重新预览的对账一致
        let mut known: Vec<(String, String, String, u16, String)> = existing
            .iter()
            .map(|h| {
                (
                    h.id.clone(),
                    h.name.clone(),
                    h.address.clone(),
                    h.port,
                    h.username.clone(),
                )
            })
            .collect();
        for name in names {
            let skipped = |reason: SshSkipReason| SshImportOutcome {
                name: name.clone(),
                host_id: None,
                error: None,
                skipped_reason: Some(reason),
            };
            let Some(entry) = entries.iter().find(|e| &e.name == name) else {
                out.push(SshImportOutcome {
                    name: name.clone(),
                    host_id: None,
                    error: Some("配置中找不到该条目".into()),
                    skipped_reason: None,
                });
                continue;
            };
            if !Self::directly_importable(entry) {
                out.push(skipped(SshSkipReason::Blocked));
                continue;
            }
            let port = entry.port.unwrap_or(22);
            let username = Self::default_username(entry);
            let dup = known.iter().find(|(_, n, a, p, u)| {
                n == &entry.name || (a == &entry.address && *p == port && u == &username)
            });
            // DF7.3：重复默认跳过；overwrite=true 以既有 id 覆盖写入
            let host_id = if overwrite {
                dup.map(|h| h.0.clone())
            } else {
                if dup.is_some() {
                    out.push(skipped(SshSkipReason::Duplicate));
                    continue;
                }
                None
            };
            let r = async {
                let auth = match &entry.identity_path {
                    Some(p) => {
                        let pem = tokio::fs::read_to_string(p).await.map_err(|e| {
                            Error::InvalidInput(format!("读取私钥 {} 失败: {e}", p.display()))
                        })?;
                        let meta = self
                            .create_identity(
                                ctx,
                                IdentityReq::Import {
                                    label: name.clone(),
                                    pem,
                                    passphrase: None,
                                },
                            )
                            .await
                            .map_err(|e| match e {
                                // 加密私钥无口令解不开：明说，不静默降级
                                Error::InvalidInput(m) if m.contains("passphrase") => {
                                    Error::InvalidInput("私钥有口令，请先在应用内手工导入".into())
                                }
                                other => other,
                            })?;
                        AuthDraft::Key {
                            identity_id: meta.id,
                        }
                    }
                    None => AuthDraft::Agent,
                };
                self.upsert_host(
                    ctx,
                    HostDraft {
                        id: host_id,
                        name: name.clone(),
                        address: entry.address.clone(),
                        port: Some(port),
                        username: username.clone(),
                        auth,
                        tags: vec!["ssh-config".into()],
                        charset: Charset::Utf8,
                        shell_integration: Some(true), // ssh-config 导入=存量 SSH 主机同口径（DC3.2）
                        jump_host_id: None, // ProxyJump 指令 V1 阻断导入（sshcfg_import fixture 锁）
                        startup_command: None,
                    },
                )
                .await
            }
            .await;
            match r {
                Ok(hid) => {
                    known.push((
                        hid.clone(),
                        name.clone(),
                        entry.address.clone(),
                        port,
                        username.clone(),
                    ));
                    out.push(SshImportOutcome {
                        name: name.clone(),
                        host_id: Some(hid),
                        error: None,
                        skipped_reason: None,
                    });
                }
                Err(e) => out.push(SshImportOutcome {
                    name: name.clone(),
                    host_id: None,
                    error: Some(e.to_string()),
                    skipped_reason: None,
                }),
            }
        }
        out
    }
}
