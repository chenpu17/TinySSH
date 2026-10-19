//! P2-b 输出触发器：按行匹配终端输出的规则引擎。
//!
//! 设置存 vault KV（`triggers.v1`，人类专属 API），引擎只持编译快照；tap 在
//! spawn_pump 的解码后 UTF-8（与会话日志同点、同字符集语义）。
//!
//! 边界（如实）：只匹配**完整行**（跨行正则不命中）；匹配前剥离 ANSI CSI/OSC
//!（颜色码不干扰命中）；同规则同会话受冷却节流；`SendKeys` 动作只是**请求**——
//! 建审批卡等人类裁决（120s 超时/接管/会话关闭都会作废），批准才写通道，
//! 绝不静默自动执行。

use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};

use session_api::{
    ApprovalItem, ApprovalStatus, Decision, SegmentReport, TriggerAction, TriggerEvent,
    TriggerRule, DEFAULT_APPROVAL_TIMEOUT, TRIGGERS_KV_KEY,
};

use crate::{
    charset::encode,
    handle::{DecisionMsg, SessionHandle},
    ApprovalCenter, Error, Result,
};

/// 规则条数上限（设置卡是有意的小工具，不是规则引擎平台）。
pub const MAX_RULES: usize = 32;
/// 每会话滚动行缓冲上限（字符）——防超长无换行输出拖爆内存。
const ROLLING_CAP: usize = 8192;
/// 单次 chunk 最多处理的完整行数（洪泛保护；超出部分随缓冲淘汰，不补匹配）。
const MAX_LINES_PER_CHUNK: usize = 64;
/// 审批卡摘要里引用的命中行长度。
const EXCERPT_CHARS: usize = 160;

/// 键序转义解码：`\r` `\n` `\t` `\0` `\\` → 控制字符；其余 `\x` 形态拒绝。
/// 规则里存**转义原文**（HTML 输入框装不下真实 CR；存原文才能保真回显/再编辑），
/// 发送前才解码。
fn decode_keys(s: &str) -> Result<String> {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('r') => out.push('\r'),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('0') => out.push('\0'),
            Some('\\') => out.push('\\'),
            other => {
                return Err(Error::InvalidInput(format!(
                    "无法识别的键序转义 \\{}（支持 \\r \\n \\t \\0 \\\\）",
                    other.map(String::from).unwrap_or_default()
                )));
            }
        }
    }
    Ok(out)
}

pub struct CompiledRule {
    pub rule: TriggerRule,
    pub re: regex::Regex,
}

/// 一次命中（已过冷却）。
pub struct Fire {
    pub rule: TriggerRule,
    /// 剥离 ANSI 后的命中行摘录。
    pub matched: String,
}

#[derive(Default)]
pub struct TriggerEngine {
    rules: Arc<Vec<CompiledRule>>,
    /// (rule_id, sid) → 上次触发时刻（冷却节流）。
    last_fired: HashMap<(String, String), Instant>,
    /// 每会话滚动缓冲：攒完整行（跨 chunk 的行也拼得回来）。
    rolling: HashMap<String, String>,
}

impl TriggerEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// 校验+归一+编译；任一规则非法即整体拒绝（引擎快照只在成功后替换）。
    /// 返回归一后的规则（保存端持久化这一份，UI 回显真实生效值）。
    pub fn set_rules(&mut self, rules: Vec<TriggerRule>) -> Result<Vec<TriggerRule>> {
        if rules.len() > MAX_RULES {
            return Err(Error::InvalidInput(format!("触发器最多 {MAX_RULES} 条")));
        }
        let mut norm = Vec::with_capacity(rules.len());
        let mut compiled: Vec<CompiledRule> = Vec::new();
        for (i, r) in rules.into_iter().enumerate() {
            let name = r.name.trim().to_string();
            if name.is_empty() {
                return Err(Error::InvalidInput(format!("第 {} 条规则缺少名称", i + 1)));
            }
            if name.chars().count() > 60 {
                return Err(Error::InvalidInput(format!(
                    "规则「{name}」名称过长（≤60 字符）"
                )));
            }
            let pattern = r.pattern.trim().to_string();
            let re = regex::Regex::new(&pattern)
                .map_err(|e| Error::InvalidInput(format!("规则「{name}」正则无效：{e}")))?;
            let keys = match &r.action {
                TriggerAction::SendKeys => {
                    let k = r.keys.clone().unwrap_or_default();
                    if k.is_empty() {
                        return Err(Error::InvalidInput(format!(
                            "规则「{name}」动作为「发送键序」，必须填写要发送的键序"
                        )));
                    }
                    // 存转义原文；此处只校验可解码（坏转义整体拒绝）
                    decode_keys(&k)?;
                    Some(k)
                }
                TriggerAction::Notify => None,
            };
            let rule = TriggerRule {
                id: if r.id.trim().is_empty() {
                    format!("t-{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
                } else {
                    r.id.trim().to_string()
                },
                name,
                pattern,
                action: r.action,
                keys,
                enabled: r.enabled,
                cooldown_secs: r.cooldown_secs.clamp(5, 3600),
            };
            if rule.enabled {
                compiled.push(CompiledRule {
                    re,
                    rule: rule.clone(),
                });
            }
            norm.push(rule);
        }
        self.rules = Arc::new(compiled);
        // 规则集变更即清冷却历史：编辑后的规则语义已变，旧冷却不该约束新语义。
        self.last_fired.clear();
        Ok(norm)
    }

    /// 会话收尾：清滚动缓冲与冷却记录（防缓慢泄漏）。key = (rule_id, sid)。
    pub fn drop_session(&mut self, sid: &str) {
        self.rolling.remove(sid);
        self.last_fired.retain(|(_rule_id, s), _| s != sid);
    }

    /// 喂解码后文本；抽完整行、逐规则匹配（已剥离 ANSI），登记冷却并返回命中。
    pub fn ingest(&mut self, sid: &str, text: &str) -> Vec<Fire> {
        let buf = self.rolling.entry(sid.to_string()).or_default();
        buf.push_str(text);
        if buf.len() > ROLLING_CAP {
            let mut cut = buf.len() - ROLLING_CAP;
            while cut < buf.len() && !buf.is_char_boundary(cut) {
                cut += 1;
            }
            buf.drain(..cut);
        }
        let mut lines: Vec<String> = Vec::new();
        while let Some(pos) = buf.find('\n') {
            let line: String = buf.drain(..=pos).collect();
            lines.push(line.trim_end_matches(['\n', '\r']).to_string());
            if lines.len() >= MAX_LINES_PER_CHUNK {
                break;
            }
        }
        let mut fires = Vec::new();
        if self.rules.is_empty() || lines.is_empty() {
            return fires;
        }
        let now = Instant::now();
        'rules: for cr in self.rules.iter() {
            for line in &lines {
                let plain = strip_ansi(line);
                if cr.re.is_match(&plain) {
                    let key = (cr.rule.id.clone(), sid.to_string());
                    let cd = Duration::from_secs(u64::from(cr.rule.cooldown_secs));
                    if self
                        .last_fired
                        .get(&key)
                        .map(|t| now.duration_since(*t) < cd)
                        .unwrap_or(false)
                    {
                        continue 'rules; // 冷却中：本 chunk 该规则不再触发
                    }
                    self.last_fired.insert(key, now);
                    fires.push(Fire {
                        rule: cr.rule.clone(),
                        matched: plain.chars().take(EXCERPT_CHARS).collect(),
                    });
                    continue 'rules; // 每规则每 chunk 触发一次即够
                }
            }
        }
        fires
    }

    pub fn rules_len(&self) -> usize {
        self.rules.len()
    }
}

/// 剥离 ANSI CSI（`\x1b[ ... 终止字节`）与 OSC（`\x1b] ... BEL/ST`）序列。
/// 手写扫描：行级小串，引正则引擎反而慢且难覆盖 ST 变体。
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' {
            match it.peek() {
                Some('[') => {
                    it.next();
                    while let Some(&n) = it.peek() {
                        it.next();
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    it.next();
                    while let Some(&n) = it.peek() {
                        it.next();
                        if n == '\x07' {
                            break;
                        }
                        if n == '\x1b' {
                            // ESC \ (ST)
                            it.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    it.next(); // 其余两字节转义（\x1b7、\x1b= 等）丢弃
                }
                None => {}
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// pump tap：喂引擎并对命中执行动作（notify 直发事件；send 建审批卡异步等裁决）。
/// 全程同步、无锁跨 await——审批等待在独立任务里。
pub(crate) fn on_output(center: &Arc<ApprovalCenter>, h: &Arc<SessionHandle>, text: &str) {
    if text.is_empty() {
        return;
    }
    let fires = {
        let mut eng = center.triggers.lock().unwrap();
        eng.ingest(&h.id, text)
    };
    for f in fires {
        let action = match f.rule.action {
            TriggerAction::Notify => "notify",
            TriggerAction::SendKeys => "send",
        };
        let actor = session_api::Actor::Agent {
            client_id: "trigger".to_string(),
        };
        let _ = center.audit.append(
            &actor,
            "trigger_fired",
            Some(&h.id),
            Some(&f.rule.name),
            serde_json::json!({"action": action, "matched": f.matched}),
            None,
        );
        let _ = center.trigger_tx.send(TriggerEvent {
            sid: h.id.clone(),
            rule_id: f.rule.id.clone(),
            rule_name: f.rule.name.clone(),
            action: action.to_string(),
            matched: f.matched.clone(),
        });
        if let TriggerAction::SendKeys = f.rule.action {
            let keys = f.rule.keys.clone().unwrap_or_default();
            spawn_send_approval(center, h, &f.rule.name, &keys, &f.matched);
        }
    }
}

/// SendKeys 命中：装配审批卡（人类裁决，可编辑键序），批准后直写通道。
/// 键序**不** register_outgoing——它不是命令文本，记块会伪造归因
///（孤儿 C/D 由块索引忽略，见 term-core block 测试）。
fn spawn_send_approval(
    center: &Arc<ApprovalCenter>,
    h: &Arc<SessionHandle>,
    rule_name: &str,
    keys: &str,
    excerpt: &str,
) {
    let item = ApprovalItem {
        id: format!("a-{}", uuid::Uuid::new_v4()),
        session_id: h.id.clone(),
        agent_id: "trigger".to_string(),
        command: format!("send_keys {keys:?}（触发器「{rule_name}」自动请求）"),
        edited_command: None,
        target_summary: "输出命中触发器——请求向会话发送键序".to_string(),
        segment_report: vec![SegmentReport {
            segment: format!("发送键序 {keys:?} → {}", h.host.name),
            verdict: format!("触发器「{rule_name}」命中输出行：{excerpt}"),
        }],
        session_busy: false,
        editable: true, // 「编辑后批准」的文本即最终键序
        created_at: chrono::Utc::now(),
        status: ApprovalStatus::Pending,
        attempt_id: None,
        purpose: None,
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    center.decisions.lock().unwrap().insert(item.id.clone(), tx);
    center
        .items
        .lock()
        .unwrap()
        .insert(item.id.clone(), item.clone());
    let _ = center.vault.save_approval(&item);
    let _ = center
        .approvals_tx
        .send(session_api::ApprovalEvent::New(item.clone()));
    let _ = center.audit.append(
        &session_api::Actor::Agent {
            client_id: "trigger".to_string(),
        },
        "approval_requested",
        Some(&h.id),
        Some(&item.command),
        serde_json::json!({}),
        Some(&item.id),
    );
    let weak = Arc::downgrade(h);
    let center2 = center.clone();
    let item_id = item.id.clone();
    let keys_owned = keys.to_string();
    tokio::spawn(async move {
        match tokio::time::timeout(DEFAULT_APPROVAL_TIMEOUT, rx).await {
            Ok(Ok(DecisionMsg::Decide(Decision::Approve))) => {
                settle_item(&center2, &item_id, ApprovalStatus::Approved);
                do_trigger_send(&center2, &weak, &item_id, keys_owned.clone()).await;
            }
            Ok(Ok(DecisionMsg::Decide(Decision::ApproveEdited(ed)))) => {
                settle_item(&center2, &item_id, ApprovalStatus::ApprovedEdited);
                do_trigger_send(&center2, &weak, &item_id, ed).await;
            }
            Ok(Ok(DecisionMsg::Decide(Decision::Deny))) => {
                settle_item(&center2, &item_id, ApprovalStatus::Denied);
                let _ = center2.audit.append(
                    &session_api::Actor::Agent {
                        client_id: "trigger".to_string(),
                    },
                    "trigger_send_denied",
                    None,
                    Some(&keys_owned),
                    serde_json::json!({"approval": item_id}),
                    Some(&item_id),
                );
            }
            Ok(Ok(DecisionMsg::Voided)) | Ok(Err(_)) => {
                // 接管/停用协作/通道撤销：卡已被作废方更新，这里不重复落状态。
            }
            Err(_) => {
                // 120s 无人裁决：卡转 Voided（防永久 Pending），等待方（本任务）退出。
                void_expired(center2.clone(), item_id, keys_owned);
            }
        }
    });
}

/// 决策收尾：卡状态落内存 + vault + Updated 事件（请求方职责，与建会话审批同口径）。
fn settle_item(center: &Arc<ApprovalCenter>, item_id: &str, status: ApprovalStatus) {
    if let Some(it) = center.items.lock().unwrap().get_mut(item_id) {
        it.status = status;
    }
    let snap = center.items.lock().unwrap().get(item_id).cloned();
    if let Some(it) = snap {
        let _ = center.vault.save_approval(&it);
        let _ = center
            .approvals_tx
            .send(session_api::ApprovalEvent::Updated(it));
    }
}

async fn do_trigger_send(
    center: &Arc<ApprovalCenter>,
    weak: &std::sync::Weak<SessionHandle>,
    approval_id: &str,
    keys_raw: String,
) {
    let Some(h) = weak.upgrade() else {
        return; // 会话已关：卡在 close 路径已作废
    };
    // set_rules 已校验过可解码；此处的失败面只防御旧配置/手工改档——不发送、如实留痕
    let keys = match decode_keys(&keys_raw) {
        Ok(k) => k,
        Err(e) => {
            let _ = center.audit.append(
                &session_api::Actor::Agent {
                    client_id: "trigger".to_string(),
                },
                "trigger_send_failed",
                Some(&h.id),
                Some(&keys_raw),
                serde_json::json!({"approval": approval_id, "error": e.to_string()}),
                Some(approval_id),
            );
            return;
        }
    };
    let bytes = encode(h.host.charset, &keys);
    match h.channel.write(&bytes).await {
        Ok(_) => {
            let _ = center.audit.append(
                &session_api::Actor::Agent {
                    client_id: "trigger".to_string(),
                },
                "trigger_send",
                Some(&h.id),
                Some(&keys),
                serde_json::json!({"approval": approval_id}),
                Some(approval_id),
            );
        }
        Err(e) => {
            let _ = center.audit.append(
                &session_api::Actor::Agent {
                    client_id: "trigger".to_string(),
                },
                "trigger_send_failed",
                Some(&h.id),
                Some(&keys),
                serde_json::json!({"approval": approval_id, "error": e.to_string()}),
                Some(approval_id),
            );
        }
    }
}

fn void_expired(center: Arc<ApprovalCenter>, item_id: String, keys: String) {
    center.decisions.lock().unwrap().remove(&item_id);
    settle_item(&center, &item_id, ApprovalStatus::Voided);
    let _ = center.audit.append(
        &session_api::Actor::Agent {
            client_id: "trigger".to_string(),
        },
        "trigger_send_expired",
        None,
        Some(&keys),
        serde_json::json!({"approval": item_id}),
        Some(&item_id),
    );
}

/// 启动装载：读 KV → 引擎快照。坏配置不阻断启动（引擎空转，UI 读取显原样，
/// 重存即修复）；读取/解析失败静默跳过。
pub fn load_from_vault(center: &Arc<ApprovalCenter>) {
    let Ok(Some(raw)) = center.vault.get_setting(TRIGGERS_KV_KEY) else {
        return;
    };
    let Ok(rules) = serde_json::from_str::<Vec<TriggerRule>>(&raw) else {
        return;
    };
    if let Ok(mut eng) = center.triggers.lock() {
        let _ = eng.set_rules(rules);
    }
}

/// 引擎字段的 StdMutex 持有辅助（ApprovalCenter.triggers 的类型别名间接处）。
pub type TriggerEngineCell = StdMutex<TriggerEngine>;
