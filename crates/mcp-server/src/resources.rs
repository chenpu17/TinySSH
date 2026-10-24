//! 资源 / 提示 / 订阅推送（能力面补齐第二轮）：Agent 除工具外还可
//! `resources/list`+`read` 拉现场状态、`resources/subscribe` 订阅变化
//! （推 `notifications/resources/updated`）、`prompts/get` 取引导模板。
//!
//! 事件源分两类：审批/转发/连接走核心 broadcast（真推送，T44 同一桥）；
//! 传输在核心无事件面（UI 同为轮询+revision 对账），订阅侧 2s 差分兜底——
//! 对 Agent 而言合同都是「订阅即推送」，内部手段是实现细节。
//!
//! 订阅绑定 (client_id, uri)：同一 Token 重复订阅替换旧任务；unsubscribe
//! 或会话关闭（send 失败）即回收。通知只含 uri（"去重读"语义），不带载荷——
//! 现场数据仍走 resources/read，权限模型（Actor 域）不被订阅旁路。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rmcp::model::{
    Prompt, PromptArgument, Resource, ResourceTemplate, ResourceUpdatedNotification,
    ResourceUpdatedNotificationParam, ServerNotification,
};
use rmcp::service::Peer;
use rmcp::RoleServer;
use session_api::{Actor, ApprovalFilter, Error, SessionApi};
use tokio::sync::broadcast;

/// 订阅注册表：(client_id, uri) → 看护任务句柄。重复订阅替换（旧任务 abort）。
pub type SubRegistry =
    Arc<Mutex<std::collections::HashMap<(String, String), tokio::task::JoinHandle<()>>>>;

/// 可订阅/可读的资源查询（URI 解析结果）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResQuery {
    Sessions,
    Session(String),
    Transfers,
    Transfer(String),
    Forwards,
    ApprovalsPending,
    Records,
}

/// `tinyssh://` 资源 URI 解析。未知 scheme/路径 → None（调用方回 invalid_params）。
pub fn parse_resource_uri(uri: &str) -> Option<ResQuery> {
    let rest = uri.strip_prefix("tinyssh://")?;
    if rest == "sessions" {
        return Some(ResQuery::Sessions);
    }
    if rest == "transfers" {
        return Some(ResQuery::Transfers);
    }
    if rest == "forwards" {
        return Some(ResQuery::Forwards);
    }
    if rest == "approvals/pending" {
        return Some(ResQuery::ApprovalsPending);
    }
    if rest == "records" || rest == "records/recent" {
        return Some(ResQuery::Records);
    }
    if let Some(id) = rest.strip_prefix("sessions/") {
        if !id.is_empty() && !id.contains('/') {
            return Some(ResQuery::Session(id.to_string()));
        }
    }
    if let Some(id) = rest.strip_prefix("transfers/") {
        if !id.is_empty() && !id.contains('/') {
            return Some(ResQuery::Transfer(id.to_string()));
        }
    }
    None
}

/// 静态资源目录（list 不含 per-id 实例——那些走 templates）。
pub fn resource_catalog() -> Vec<Resource> {
    vec![
        Resource::new("tinyssh://sessions", "活动会话")
            .with_description("当前所有共享会话（id/主机/用户/状态）")
            .with_mime_type("application/json"),
        Resource::new("tinyssh://transfers", "传输任务")
            .with_description("SFTP 传输任务列表（状态/进度/revision）")
            .with_mime_type("application/json"),
        Resource::new("tinyssh://forwards", "端口转发")
            .with_description("各会话已建端口转发汇总")
            .with_mime_type("application/json"),
        Resource::new("tinyssh://approvals/pending", "待审批队列")
            .with_description("等待人类逐条裁决的操作（建议订阅此资源获得推送）")
            .with_mime_type("application/json"),
        Resource::new("tinyssh://records/recent", "执行记录（最近）")
            .with_description(
                "你自己的最近 100 条执行记录（命令/传输/转发 + 输出摘录 + 耗时）；复盘与自查",
            )
            .with_mime_type("application/json"),
    ]
}

/// 资源模板（per-id 实例）。
pub fn resource_template_catalog() -> Vec<ResourceTemplate> {
    vec![
        ResourceTemplate::new("tinyssh://sessions/{session_id}", "单个会话")
            .with_description("按 id 读取一个会话详情")
            .with_mime_type("application/json"),
        ResourceTemplate::new("tinyssh://transfers/{transfer_id}", "单个传输任务")
            .with_description("按 id 读取一个传输任务（状态/进度）")
            .with_mime_type("application/json"),
    ]
}

/// 读资源错误：核心错误原样上抛；找不到实例（会话/任务 id）单独成类——
/// 消息里带上具体 id，映射为协议层 invalid_params。
#[derive(Debug)]
pub enum ReadErr {
    Core(Error),
    NotFound { what: &'static str, id: String },
}

impl std::fmt::Display for ReadErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadErr::Core(e) => write!(f, "{e}"),
            ReadErr::NotFound { what, id } => write!(f, "{what}不存在或已回收: {id}"),
        }
    }
}

/// 读资源 → JSON 值。错误由调用方映射协议错误。
pub async fn read_resource_value(
    api: &Arc<dyn SessionApi>,
    actor: &Actor,
    q: &ResQuery,
) -> Result<serde_json::Value, ReadErr> {
    Ok(match q {
        ResQuery::Sessions => {
            serde_json::to_value(api.list_sessions(actor).await.map_err(ReadErr::Core)?)
                .unwrap_or_default()
        }
        ResQuery::Session(id) => {
            let all = api.list_sessions(actor).await.map_err(ReadErr::Core)?;
            let one = all.into_iter().find(|s| s.id == *id);
            match one {
                Some(s) => serde_json::to_value(s).unwrap_or_default(),
                None => {
                    return Err(ReadErr::NotFound {
                        what: "会话",
                        id: id.clone(),
                    })
                }
            }
        }
        ResQuery::Transfers => {
            serde_json::to_value(api.list_transfers(actor).await.map_err(ReadErr::Core)?)
                .unwrap_or_default()
        }
        ResQuery::Records => {
            // Agent 恒只见自己的（服务端强制）；人类经资源读=全量最近 100
            serde_json::to_value(
                api.query_records(
                    actor,
                    tinyssh_records::RecordFilter {
                        limit: Some(100),
                        ..Default::default()
                    },
                )
                .await
                .map_err(ReadErr::Core)?,
            )
            .unwrap_or_default()
        }
        ResQuery::Transfer(id) => {
            let all = api.list_transfers(actor).await.map_err(ReadErr::Core)?;
            let one = all.into_iter().find(|t| t.id == *id);
            match one {
                Some(t) => serde_json::to_value(t).unwrap_or_default(),
                // 终态任务会从注册表归档（R32）：读到不存在 ≈ 已回收
                None => {
                    return Err(ReadErr::NotFound {
                        what: "传输任务",
                        id: id.clone(),
                    })
                }
            }
        }
        ResQuery::Forwards => {
            // 转发按会话列举：逐会话聚合，单个会话失败不影响整体（会话可能在关闭中）
            let sessions = api.list_sessions(actor).await.map_err(ReadErr::Core)?;
            let mut out = Vec::new();
            for s in sessions {
                if let Ok(fs) = api.list_forwards(actor, s.id.clone()).await {
                    for f in fs {
                        out.push(serde_json::json!({ "session_id": s.id, "forward": f }));
                    }
                }
            }
            serde_json::Value::Array(out)
        }
        ResQuery::ApprovalsPending => {
            let items = api
                .list_approvals(
                    actor,
                    ApprovalFilter {
                        pending_only: true,
                        ..Default::default()
                    },
                )
                .await
                .map_err(ReadErr::Core)?;
            serde_json::to_value(items).unwrap_or_default()
        }
    })
}

async fn notify_updated(peer: &Peer<RoleServer>, uri: &str) -> Result<(), rmcp::ServiceError> {
    peer.send_notification(ServerNotification::ResourceUpdatedNotification(
        ResourceUpdatedNotification::new(ResourceUpdatedNotificationParam::new(uri)),
    ))
    .await
}

/// 订阅看护任务：事件到达 → 推一条 `notifications/resources/updated`（只带 uri）。
/// 退出条件：通知发送失败（会话/服务循环关闭，Peer 通道断开）或 broadcast 源关闭。
/// 注意不能锚定请求级 CancellationToken——rmcp 在该请求响应发出时即取消它
/// （service.rs ToSink 分支 remove+cancel），订阅必须活得比 subscribe 请求久。
/// 断连后未显式 unsubscribe 的看护任务由发送失败自清；同 (token,uri) 重订阅替换。
/// 稳定轮补两类滞留面：轮询读持续失败（无效 id 刷订阅）与广播分支长时间无匹配
/// 事件（静默断连/无人关注的 Session id）——原实现在这两类下任务与注册表条目
/// 永不回收；现一律周期性「通知探活」，peer 失活（发送失败）即退出自清。
pub fn spawn_watcher(
    api: Arc<dyn SessionApi>,
    actor: Actor,
    uri: String,
    q: ResQuery,
    peer: Peer<RoleServer>,
) -> tokio::task::JoinHandle<()> {
    const WATCH_PROBE_SECS: u64 = 60;
    tokio::spawn(async move {
        match q {
            // 传输/记录：核心无事件面，2s 差分（首次只建基线不通知）
            ResQuery::Transfers | ResQuery::Transfer(_) | ResQuery::Records => {
                let mut prev = String::new();
                let mut tick = tokio::time::interval(Duration::from_secs(2));
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                let mut errs: u32 = 0;
                loop {
                    tick.tick().await;
                    match read_resource_value(&api, &actor, &q).await {
                        Ok(v) => {
                            errs = 0;
                            let fp = v.to_string();
                            if !prev.is_empty() && fp != prev {
                                if notify_updated(&peer, &uri).await.is_err() {
                                    break;
                                }
                            }
                            prev = fp;
                        }
                        Err(_) => {
                            // 持续读失败：每 ~30s 通知探活，peer 没了就退出
                            errs += 1;
                            if errs >= 15 {
                                if notify_updated(&peer, &uri).await.is_err() {
                                    break;
                                }
                                errs = 0;
                            }
                        }
                    }
                }
            }
            ResQuery::ApprovalsPending => {
                let mut rx = api.subscribe_approvals();
                loop {
                    let changed = match tokio::time::timeout(
                        Duration::from_secs(WATCH_PROBE_SECS),
                        rx.recv(),
                    )
                    .await
                    {
                        Ok(Ok(_)) => true,
                        Ok(Err(broadcast::error::RecvError::Lagged(_))) => true,
                        Ok(Err(broadcast::error::RecvError::Closed)) => break,
                        Err(_silent) => notify_updated(&peer, &uri).await.is_ok(),
                    };
                    if changed && notify_updated(&peer, &uri).await.is_err() {
                        break;
                    }
                }
            }
            ResQuery::Forwards => {
                let mut rx = api.subscribe_forwards();
                loop {
                    let changed = match tokio::time::timeout(
                        Duration::from_secs(WATCH_PROBE_SECS),
                        rx.recv(),
                    )
                    .await
                    {
                        Ok(Ok(_)) => true,
                        Ok(Err(broadcast::error::RecvError::Lagged(_))) => true,
                        Ok(Err(broadcast::error::RecvError::Closed)) => break,
                        Err(_silent) => notify_updated(&peer, &uri).await.is_ok(),
                    };
                    if changed && notify_updated(&peer, &uri).await.is_err() {
                        break;
                    }
                }
            }
            ResQuery::Sessions | ResQuery::Session(_) => {
                let mut rx = api.subscribe_connections();
                loop {
                    let hit = match tokio::time::timeout(
                        Duration::from_secs(WATCH_PROBE_SECS),
                        rx.recv(),
                    )
                    .await
                    {
                        Ok(Ok(ev)) => match (&q, ev.session_id) {
                            (ResQuery::Sessions, _) => true,
                            (ResQuery::Session(want), Some(sid)) => *want == sid,
                            _ => false,
                        },
                        Ok(Err(broadcast::error::RecvError::Lagged(_))) => true,
                        Ok(Err(broadcast::error::RecvError::Closed)) => break,
                        // 长时间无匹配事件（无效 id / 关注的会话无动静）：探活，
                        // peer 失活即退出；活着则继续守（探活通知本身无害）
                        Err(_silent) => {
                            if notify_updated(&peer, &uri).await.is_err() {
                                break;
                            }
                            false
                        }
                    };
                    if hit && notify_updated(&peer, &uri).await.is_err() {
                        break;
                    }
                }
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Prompts：少量引导模板（参数注入，纯文本，无机密）
// ---------------------------------------------------------------------------

/// 提示模板目录（prompts/list）。
pub fn prompt_catalog() -> Vec<Prompt> {
    vec![
        Prompt::new(
            "onboarding",
            Some("刚接入后的第一步：了解现场、理解审批模型、向人确认目标"),
            None,
        ),
        Prompt::new(
            "session-triage",
            Some("对一个会话做体检：读现场 → 读屏 → 谨慎执行诊断命令"),
            Some(vec![required_arg(
                "session_id",
                "会话 id（list_sessions 或 tinyssh://sessions 得到）",
            )]),
        ),
        Prompt::new(
            "transfer-followup",
            Some("跟进一个传输任务：读状态 → 失败处置（核实/取消/重试）"),
            Some(vec![required_arg("transfer_id", "传输任务 id")]),
        ),
    ]
}

fn required_arg(name: &str, desc: &str) -> PromptArgument {
    let mut a = PromptArgument::new(name);
    a.description = Some(desc.to_string());
    a.required = Some(true);
    a
}

/// 生成提示文本。返回 Err = 参数缺失（调用方回 invalid_params）。
pub fn prompt_text(
    name: &str,
    arguments: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Result<String, String> {
    let arg = |k: &str| -> Result<String, String> {
        arguments
            .and_then(|m| m.get(k))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("缺少参数 {k}"))
    };
    match name {
        "onboarding" => Ok(r#"你是通过 TinySSH MCP 接入的运维助手。刚接入请按顺序：
1. 读资源 tinyssh://sessions 看有哪些活动会话（会话由人类建立并共享给你）。
2. 用 tools/list 过一遍工具面；读 tinyssh://approvals/pending 理解审批队列形态。
3. 关键约束：exec/传输等操作默认要人类逐条审批，工具调用会阻塞等待裁决（带 progressToken 可见心跳）；不要试图绕过审批，也没有绕过的路径。
4. 向人类确认本次目标与边界（可操作的会话、允许的命令范围），再开始干活。
需要盯状态变化时，对 tinyssh://approvals/pending 或 tinyssh://transfers 做 resources/subscribe，状态变化会推送给你。"#.to_string()),
        "session-triage" => {
            let sid = arg("session_id")?;
            Ok(format!(r#"对会话 {sid} 做一次体检，按顺序：
1. 读资源 tinyssh://sessions/{sid} 确认会话在位。若报 404/session_not_found：先读 tinyssh://sessions 核对——HTTP 404 是传输层会话过期（重新 initialize 即可，业务无损）；业务层 session_not_found 多为会话已关闭或应用重启过（会话不跨重启），不在列表就向人报告并建议重新连接。
2. 用 read_screen 读当前终端画面，理解现场（cwd、正在跑的进程、最近输出）。
3. 如需诊断命令，用 exec（shell 模式默认，现场延续；危险命令会进审批队列等人类裁决）。
4. 结论先讲事实（读到的现场），再讲判断，最后讲建议；每条建议注明是否需要人审批。"#
            ))
        }
        "transfer-followup" => {
            let tid = arg("transfer_id")?;
            Ok(format!(r#"跟进传输任务 {tid}：
1. 读资源 tinyssh://transfers/{tid} 看状态与进度。
2. 进行中：报告进度即可，勿重复发起同类传输。
3. 失败/状态不明：先 verify_transfer_outcome 核实真实结果（防重复传输副作用）；需要重试用 retry_transfer，需要止损用 cancel_transfer。
4. 向人汇报：任务、状态、你做了什么、还需要人决定什么。"#
            ))
        }
        other => Err(format!("未知提示: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_resource_uri_roundtrip() {
        assert_eq!(
            parse_resource_uri("tinyssh://sessions"),
            Some(ResQuery::Sessions)
        );
        assert_eq!(
            parse_resource_uri("tinyssh://sessions/s-1"),
            Some(ResQuery::Session("s-1".into()))
        );
        assert_eq!(
            parse_resource_uri("tinyssh://transfers"),
            Some(ResQuery::Transfers)
        );
        assert_eq!(
            parse_resource_uri("tinyssh://transfers/t-9"),
            Some(ResQuery::Transfer("t-9".into()))
        );
        assert_eq!(
            parse_resource_uri("tinyssh://forwards"),
            Some(ResQuery::Forwards)
        );
        assert_eq!(
            parse_resource_uri("tinyssh://approvals/pending"),
            Some(ResQuery::ApprovalsPending)
        );
        assert_eq!(
            parse_resource_uri("tinyssh://records/recent"),
            Some(ResQuery::Records)
        );
        assert_eq!(
            parse_resource_uri("tinyssh://records"),
            Some(ResQuery::Records)
        );
        // 未知 scheme / 空 id / 多段路径 / 相邻资源误匹配
        assert_eq!(parse_resource_uri("file:///etc/passwd"), None);
        assert_eq!(parse_resource_uri("tinyssh://sessions/"), None);
        assert_eq!(parse_resource_uri("tinyssh://sessions/a/b"), None);
        assert_eq!(parse_resource_uri("tinyssh://approvals"), None);
        assert_eq!(parse_resource_uri("tinyssh://"), None);
    }

    #[test]
    fn catalogs_are_shaped() {
        let rs = resource_catalog();
        assert_eq!(rs.len(), 5);
        assert!(rs
            .iter()
            .all(|r| r.mime_type.as_deref() == Some("application/json")));
        let ts = resource_template_catalog();
        assert_eq!(ts.len(), 2);
        assert!(ts[0].uri_template.contains("{session_id}"));
        let ps = prompt_catalog();
        assert_eq!(ps.len(), 3);
    }

    #[test]
    fn prompts_need_arguments() {
        assert!(prompt_text("onboarding", None).is_ok());
        let args = serde_json::json!({ "session_id": "s-1" })
            .as_object()
            .cloned();
        assert!(prompt_text("session-triage", args.as_ref())
            .unwrap()
            .contains("s-1"));
        assert!(
            prompt_text("session-triage", None).is_err(),
            "缺参数必须报错"
        );
        let targs = serde_json::json!({ "transfer_id": "t-1" })
            .as_object()
            .cloned();
        assert!(prompt_text("transfer-followup", targs.as_ref())
            .unwrap()
            .contains("t-1"));
        assert!(prompt_text("no-such-prompt", None).is_err());
    }
}
