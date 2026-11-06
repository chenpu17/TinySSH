//! C5 传输注册表：节流合并、journal 落库、终态清理。
//! C10 输出订阅恢复（R11；桥层专用，不在 SessionApi trait 面）。
//!
//! 从 lib.rs 整块抽出（第二波结构拆分）。方法由父模块调用，统一 `pub(crate)`；
//! 私有字段仍可直接访问（子模块可见父模块私有项）。

use crate::*;
use session_api::*;

impl SessionManager {
    // ---- C5（R32）注册表辅助：节流合并 + journal 落库 ----

    /// 注册新任务（Queued）并立即对外发一帧（revision 从 1 起）。
    pub(crate) fn transfer_register(&self, task: TransferTask, cancel: CancellationToken) {
        let tid = task.id.clone();
        let now = std::time::Instant::now();
        let _ = self.transfer_tx.send(task.clone());
        self.transfers.lock().unwrap().insert(
            tid,
            TransferRegEntry {
                task,
                cancel,
                last_emit: now,
                last_journal: now,
                decision_tx: None,
                verified: false,
            },
        );
    }

    /// C6/R34 DF6.4：同目标锁（canonical path 键；持有至任务终态——本客户端
    /// 内同目标任务串行；外部写入由预检/复检/发布原语防线兜底）。
    ///
    /// 十轮回收：条目原从不删除（泄漏点——每去重目标永久占一条）。顺手摘除
    /// 无外部持有者的死条目（`strong_count==1` = 仅 map 持有）：克隆只发生在
    /// 本临界区内，计数在持锁期间不会变化，无竞态窗口；仍在飞/等待的任务持
    /// 有克隆（计数 ≥2）不受影响。残留窗口 = 上一任务作用域未退出期间，由
    /// 下一次任意传输的回收补摘。
    pub(crate) fn target_lock(&self, key: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.target_locks.lock().unwrap();
        locks.retain(|_, v| Arc::strong_count(v) > 1);
        locks
            .entry(key.to_string())
            .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// 连接尝试登记上限（十轮）：attempts 原只插不删（AttemptEntry 含 watch
    /// 通道 + tokio Mutex，泄漏点）。超限按「终态优先、同组创建时间最旧先
    /// 淘汰」收缩；活动条目也被波及时说明并发尝试本身异常，宁误删不泄漏。
    /// 淘汰后 connection_status/cancel 对旧 attempt 返回 not-found（可接受）。
    pub(crate) fn gc_attempts(
        map: &mut HashMap<AttemptId, std::sync::Arc<AttemptEntry>>,
        cap: usize,
    ) {
        if map.len() <= cap {
            return;
        }
        let mut ordered: Vec<(chrono::DateTime<chrono::Utc>, bool, AttemptId)> = map
            .iter()
            .map(|(id, e)| {
                (
                    e.info.created_at,
                    e.term.load(AtomicOrdering::Acquire),
                    id.clone(),
                )
            })
            .collect();
        ordered.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let excess = map.len() - cap;
        for (_, _, id) in ordered.into_iter().take(excess) {
            map.remove(&id);
        }
    }

    /// 稳定轮（余量项）：终态传输条目最旧先淘汰，保 `TRANSFER_TERMINAL_KEEP` 条。
    /// 调用点 = list_transfers（FE 轮询/MCP 对账的唯一权威查询面），随查询顺带收。
    pub(crate) fn gc_transfers_terminal(
        map: &mut HashMap<TransferId, TransferRegEntry>,
        keep: usize,
    ) {
        let mut terminal: Vec<(i64, TransferId)> = map
            .iter()
            .filter(|(_, e)| {
                matches!(
                    e.task.status,
                    TransferStatus::Succeeded
                        | TransferStatus::Failed
                        | TransferStatus::Cancelled
                        | TransferStatus::Skipped
                        | TransferStatus::Interrupted
                )
            })
            .map(|(id, e)| (e.task.created_at, id.clone()))
            .collect();
        if terminal.len() <= keep {
            return;
        }
        terminal.sort_by(|a, b| a.0.cmp(&b.0));
        let excess = terminal.len() - keep;
        for (_, id) in terminal.into_iter().take(excess) {
            map.remove(&id);
        }
    }

    /// 变更任务并按节奏对外发帧/落 journal：状态变化即时发；进度合并 ≥200ms
    ///（§560 ~5 次/秒/任务）；journal 状态变化必写、纯进度 ≥1s 一写。
    /// R34：journal 行随写 verified 证据位（提交窗口同步）。
    pub(crate) fn transfer_apply(&self, tid: &TransferId, mutate: impl FnOnce(&mut TransferTask)) {
        self.transfer_apply_entry(tid, |t, _| mutate(t));
    }

    /// 条目级变体（决策窗原子化轮）：闭包可同时改任务快照与条目附件
    /// decision_tx——AwaitingDecision 的状态翻转与决策通道安装必须同锁原子，
    /// 否则两段加锁之间的竞窗里人类提交（take 到 None → InvalidTransferState）
    /// 与作废（take 到 None 后照旧收卡，真等待端 select 挂死在无人关闭的 rx）
    /// 都会走错。emit/journal 节流语义与 transfer_apply 完全一致。
    pub(crate) fn transfer_apply_entry(
        &self,
        tid: &TransferId,
        mutate: impl FnOnce(
            &mut TransferTask,
            &mut Option<tokio::sync::oneshot::Sender<CollisionDecision>>,
        ),
    ) {
        let now = std::time::Instant::now();
        let (emit_task, journal_task) = {
            let mut reg = self.transfers.lock().unwrap();
            let Some(e) = reg.get_mut(tid) else { return };
            let before = e.task.status;
            mutate(&mut e.task, &mut e.decision_tx);
            e.task.revision += 1;
            let changed = e.task.status != before;
            let mut emit = None;
            let mut journal = None;
            if changed || now.duration_since(e.last_emit).as_millis() >= 200 {
                e.last_emit = now;
                emit = Some(e.task.clone());
            }
            if changed || now.duration_since(e.last_journal).as_millis() >= 1000 {
                e.last_journal = now;
                // journal 编码：OutcomeUnknown 行保持 Committing（活动集成员——
                // 重启恢复分类与「未决任务保留 journal」依据；注册表面呈现真实状态）
                let mut snap = e.task.clone();
                let mut verified = e.verified;
                if snap.status == TransferStatus::OutcomeUnknown {
                    snap.status = TransferStatus::Committing;
                    verified = false;
                }
                journal = Some((snap, verified));
            }
            (emit, journal)
        };
        if let Some(t) = emit_task {
            let _ = self.transfer_tx.send(t);
        }
        if let Some((t, verified)) = journal_task {
            let _ = self
                .center
                .vault
                .transfer_journal_update(&t, Some(verified));
        }
    }

    /// 终态收尾：即时发帧 + journal 必写（审计由调用方按既有键追加）。
    /// rev-r32 中-1：仅 Succeeded 覆写字节数——取消/失败保留在途进度（「恢复不抹账、
    /// 运行时同样不抹账」；终态字节 = MCP 对账权威面数据，0 会冒充「没传过」）。
    /// R34：离开 AwaitingDecision 即清提示载荷（wire：仅待决态非空）与决策通道。
    pub(crate) fn transfer_finish(
        &self,
        tid: &TransferId,
        status: TransferStatus,
        bytes: u64,
        error: Option<String>,
    ) {
        let now = now_unix();
        {
            let mut reg = self.transfers.lock().unwrap();
            if let Some(e) = reg.get_mut(tid) {
                e.decision_tx = None;
            }
        }
        self.transfer_apply(tid, |t| {
            t.status = status;
            t.decision_prompt = None;
            if status == TransferStatus::Succeeded {
                t.bytes_done = bytes;
            }
            t.error = error;
            if t.finished_at.is_none() {
                t.finished_at = Some(now);
            }
        });
        // ③ 传输结局记录（发起时已记 actor，这里补终态；agent_id=None 可辨）
        let task = self
            .transfers
            .lock()
            .unwrap()
            .get(tid)
            .map(|e| e.task.clone());
        if let Some(t) = task {
            let (status_s, exit) = match status {
                TransferStatus::Succeeded => ("ok", Some(0)),
                TransferStatus::Failed => ("error", None),
                TransferStatus::Cancelled => ("cancelled", None),
                _ => return,
            };
            let duration_ms: Option<u64> = t
                .finished_at
                .map(|f| (f.saturating_sub(t.created_at)).saturating_mul(1000))
                .map(|d| u64::try_from(d).unwrap_or(0));
            let _ = self.center.records.append(tinyssh_records::RecordEvent {
                seq: 0,
                ts: chrono::Utc::now(),
                kind: tinyssh_records::RecordKind::Transfer,
                session_id: Some(t.session_id.clone()),
                agent_id: None,
                summary: format!(
                    "{} {} → {}",
                    match t.kind {
                        TransferKind::Upload => "upload",
                        TransferKind::Download => "download",
                    },
                    t.source,
                    t.dest
                ),
                status: status_s.into(),
                exit_code: exit,
                duration_ms,
                output_excerpt: None,
                meta: serde_json::json!({
                    "transfer": t.id, "bytes": bytes, "error": t.error,
                    "initiated_at": t.created_at,
                }),
            });
        }
    }

    /// C6/R34 DF5.2：发布原语成功 → verified 证据即时落 journal（先于收尾帧与
    /// temp 清理——「提交时退出重启」窗口内崩溃，重启恢复据此判 Succeeded{verified}）。
    pub(crate) fn transfer_mark_verified(&self, tid: &TransferId) {
        let t = {
            let mut reg = self.transfers.lock().unwrap();
            let Some(e) = reg.get_mut(tid) else { return };
            e.verified = true;
            e.last_journal = std::time::Instant::now(); // 状态未变也强制落账
            e.task.clone()
        };
        let _ = self.center.vault.transfer_journal_update(&t, Some(true));
    }

    /// C6/R34：进入 AwaitingDecision 并等待人类裁决（数据阶段前预检冲突——
    /// 不白传字节）。返回 Some(决定)=继续发布编排；None=取消/作废/超时收尾已落终态。
    pub(crate) async fn transfer_await_decision(
        &self,
        tid: &TransferId,
        target_path: &str,
        target_stat: Option<TargetStat>,
        reason: &str,
        cancel: &CancellationToken,
    ) -> Option<CollisionDecision> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        // 决策窗原子化轮：状态翻转与通道安装同锁——此前 transfer_apply 后二次
        // 加锁装 decision_tx，中间窗任务已可见 AwaitingDecision 而通道未装。
        self.transfer_apply_entry(tid, |t, slot| {
            t.status = TransferStatus::AwaitingDecision;
            t.decision_prompt = Some(DecisionPrompt {
                target_path: target_path.to_string(),
                target_stat: target_stat.clone(),
                reason: reason.to_string(),
            });
            *slot = Some(tx);
        });
        // 决策窗超时轮：无人裁决不能无限钉住传输——同目标锁与 staging temp 全被
        // 持有，同会话后续传输全部排队。超时=取消语义收尾（决策卡随事件帧翻
        // 终态；journal 终态行即留痕，与 cancel 不发审计同约定）。
        // select 用 &mut rx 借用——超时臂抢锁 take 失败=提交/作废竞窗先行拿走
        // 通道，此时 rx 还要继续等真结局（提交者会 send、作废者会 drop）。
        let sleep = tokio::time::sleep(DECISION_TTL);
        tokio::pin!(sleep);
        let mut rx = rx;
        let mut race_lost = false;
        let decision = loop {
            tokio::select! {
                r = &mut rx => break match r {
                    Ok(d) => Some(d),
                    // 通道被取走即关闭=提交决定/取消/作废。关闭而非投递（含取消竞窗
                    // 抢先关闭）→ 确未提交，统一 Cancelled 收尾（取消=「已取消」、
                    // 作废/超时=各自文案，留痕区分）
                    Err(_) => {
                        let msg = if cancel.is_cancelled() {
                            "已取消（冲突待决中）".to_string()
                        } else {
                            "决策卡已作废（过期决定显式收卡）".to_string()
                        };
                        self.transfer_finish(tid, TransferStatus::Cancelled, 0, Some(msg));
                        None
                    }
                },
                _ = cancel.cancelled() => {
                    // 取消竞窗：通道取走防悬挂写；确未提交 → Cancelled
                    if let Some(e) = self.transfers.lock().unwrap().get_mut(tid) {
                        e.decision_tx = None;
                    }
                    self.transfer_finish(tid, TransferStatus::Cancelled, 0, Some("已取消（冲突待决中）".into()));
                    break None;
                }
                _ = &mut sleep => {
                    // 抢锁 take 通道：take 到=确无人提交，超时收尾；没抢到=提交/
                    // 作废竞窗先行——出 select 后落回 rx 等真结局（rx 不能在本臂
                    // await：&mut rx 借用仍被 select 持有）
                    let took = self
                        .transfers
                        .lock()
                        .unwrap()
                        .get_mut(tid)
                        .map(|e| e.decision_tx.take().is_some())
                        .unwrap_or(false);
                    if took {
                        self.transfer_finish(tid, TransferStatus::Cancelled, 0, Some("决策超时（无人裁决，传输已收卡）".into()));
                        break None;
                    }
                    race_lost = true;
                }
            }
            if race_lost {
                break match rx.await {
                    Ok(d) => Some(d),
                    Err(_) => {
                        let msg = if cancel.is_cancelled() {
                            "已取消（冲突待决中）".to_string()
                        } else {
                            "决策卡已作废（过期决定显式收卡）".to_string()
                        };
                        self.transfer_finish(tid, TransferStatus::Cancelled, 0, Some(msg));
                        None
                    }
                };
            }
        };
        decision
    }

    // ---- C10 输出订阅恢复（R11；桥层专用，不在 SessionApi trait 面）----

    /// 订阅会话输出：注册订阅身份 + 原子捕获检查点与水位（DF10.2）。
    /// 返回 (AttachOutput, broadcast receiver, 取消信号 receiver)；receiver 由桥层
    /// 转发为带 seq 帧头的 Raw 通道帧，取消信号触发桥 task 退出（显式退订即终结转发）。
    /// 注册起 broadcast 缓存 live——检查点应用前的早到帧由前端暂存。
    pub async fn subscribe_output_channel(
        &self,
        sid: SessionId,
    ) -> Result<(
        AttachOutput,
        broadcast::Receiver<OutputEvent>,
        tokio::sync::watch::Receiver<bool>,
    )> {
        let h = self.get(&sid)?;
        let rx = h.output_tx.subscribe();
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let (subscription_id, checkpoint, start_seq) = {
            // 锁序：screen → replay（与 pump 一致，防死锁）
            let s = h.screen.lock().await;
            let checkpoint = s.checkpoint();
            let start_seq = h.output_seq.load(std::sync::atomic::Ordering::Acquire);
            h.last_ckpt_seq
                .store(start_seq, std::sync::atomic::Ordering::Release);
            let sub = format!("sub-{}", uuid::Uuid::new_v4());
            h.subs.lock().unwrap().insert(sub.clone(), cancel_tx);
            (sub, checkpoint, start_seq)
        };
        Ok((
            AttachOutput {
                subscription_id,
                checkpoint,
                start_seq,
            },
            rx,
            cancel_rx,
        ))
    }

    /// 显式退订（主清理路径，DF10.5）：幂等；重复或旧身份为 no-op。
    /// 会话不存在同样 Ok——UI 收尾顺序可能晚于会话关闭（close_session 已自动清理）。
    pub async fn unsubscribe_output(&self, sid: SessionId, subscription_id: &str) -> Result<()> {
        if let Some(h) = self.sessions.lock().unwrap().get(&sid).cloned() {
            let removed = h.subs.lock().unwrap().remove(subscription_id);
            if let Some(cancel_tx) = removed {
                let _ = cancel_tx.send(true); // 桥 task 退出（转发终结）
            } else {
                tracing::debug!(session = %sid, sub = %subscription_id, "unsubscribe: no such subscription (no-op)");
            }
        }
        Ok(())
    }

    /// resync（DF10.3）：绑定订阅身份；from_seq=None 请求检查点。
    /// Some(f)：优先 (f, cur] 连续原始字节重放（水位包含末事件）；
    /// 不可重放（淘汰/alt_screen 活跃/检查点更近）退检查点。
    /// 过期/未知 subscription_id 拒绝且不改任何状态。
    pub async fn resync_output(
        &self,
        sid: SessionId,
        subscription_id: &str,
        from_seq: Option<u64>,
    ) -> Result<ResyncOutput> {
        let h = self.get(&sid)?;
        if !h.subs.lock().unwrap().contains_key(subscription_id) {
            return Err(Error::InvalidInput(format!(
                "subscription 已过期或不存在：{subscription_id}"
            )));
        }
        // 锁序：screen → replay
        let s = h.screen.lock().await;
        let checkpoint_mode = match from_seq {
            None => true,
            Some(f) => {
                let cur = h.output_seq.load(std::sync::atomic::Ordering::Acquire);
                // seq 恰等于水位：已追平，空重放（不重放断言）
                if f >= cur {
                    return Ok(ResyncOutput::Replayed {
                        subscription_id: subscription_id.to_string(),
                        events: Vec::new(),
                        end_seq: cur,
                    });
                }
                let replayable = h.replay.lock().unwrap().covers_from(f);
                let ckpt_nearer = h.last_ckpt_seq.load(std::sync::atomic::Ordering::Acquire) > f;
                !replayable || s.alt_screen() || ckpt_nearer
            }
        };
        if checkpoint_mode {
            let checkpoint = s.checkpoint();
            let end_seq = h.output_seq.load(std::sync::atomic::Ordering::Acquire);
            h.last_ckpt_seq
                .store(end_seq, std::sync::atomic::Ordering::Release);
            return Ok(ResyncOutput::Checkpointed {
                subscription_id: subscription_id.to_string(),
                checkpoint,
                end_seq,
            });
        }
        let f = from_seq.expect("checked above");
        let cur = h.output_seq.load(std::sync::atomic::Ordering::Acquire);
        let ring = h.replay.lock().unwrap();
        let events: Vec<SeqFrame> = ring
            .q
            .iter()
            .filter(|(seq, _)| *seq > f && *seq <= cur)
            .map(|(seq, data)| SeqFrame {
                seq: *seq,
                data: data.clone(),
            })
            .collect();
        // 环内连续到 cur（covers_from 已验首帧；seq 逐帧连续推进，末帧即 cur）
        let end_seq = events.last().map(|e| e.seq).unwrap_or(cur);
        Ok(ResyncOutput::Replayed {
            subscription_id: subscription_id.to_string(),
            events,
            end_seq,
        })
    }

    /// P6 测量口径（DF10.5）：活跃订阅计数。
    pub fn debug_subscriptions(&self) -> DebugSubscriptions {
        let sessions = self.sessions.lock().unwrap();
        let mut per_session = Vec::with_capacity(sessions.len());
        let mut active_count = 0usize;
        for (sid, h) in sessions.iter() {
            let ids: Vec<String> = h.subs.lock().unwrap().keys().cloned().collect();
            active_count += ids.len();
            per_session.push(SessionSubs {
                session_id: sid.clone(),
                subscription_ids: ids,
            });
        }
        DebugSubscriptions {
            active_count,
            per_session,
        }
    }
}
