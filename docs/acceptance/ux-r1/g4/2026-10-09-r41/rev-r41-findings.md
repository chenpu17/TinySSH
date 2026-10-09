# rev-r41 独立复核（G4 首轮：连接详情 / 活动记录 / 凭据设置）

复核人：rev-r41（独立 subagent，非作者）。作者自查不计入本报告任何结论。

## 0. 复核对象与版本（**重要：审核期作者并行改树**）

| 时点 | `git diff | md5`（全树未提交改动） | 说明 |
|---|---|---|
| 审核开始 | `ac00356d12fed283fb0d534c3b996218` | 11 改 + 1 新（`crates/core-session/src/r41_tests.rs`） |
| 18:53:46 | `b135321121dd4b78e85f4f6b408eeeae` | 作者并行修树：`ui/src/App.tsx` +18 行、`ui/src/styles.css` +22 行 |
| 19:09:57（复核结束时） | `b1353211…`（**产品码面不变**） | 作者仅更新登记文档 `docs/ux/ux-r1-execution-status.md`（+2/-2）；`git diff -- . ':(exclude)docs/ux/ux-r1-execution-status.md' | md5` 仍为 `b135321121dd4b78e85f4f6b408eeeae` |

并行改动内容（我逐处读过）：
- `ui/src/App.tsx:1699` 新增 `if (detail || detailErr) { closeDetail(); return true; }`，并把 `closeDetail` 提升为 `ui/src/App.tsx:887` 的 `useCallback`（tsc 通过，作用域正确）。
  → 这正是我在**旧版**（`ac00356d…`）实测到的缺陷（Esc 关不掉连接详情，且 Esc 事件未被消费）。**该缺陷在当前版本已修复**，见 §3.1 的实测复验。
- `ui/src/styles.css` 新增 `--accent-text`（深/浅两套主题）与 `.cred-new button.ghost`、`.term-settings .cred-empty` 对比度规则（注释标注 `vis-r41 L2`/`B3`）。

**本报告的结论以当前版本 `b1353211…` 为准**；凡在旧版测得、当前版本已复验的，均标注版本。

## 1. 结论

**可签（无阻断项）。** 三面子面（连接详情 / 活动记录 / 凭据设置）的验收要点我逐条独立复现通过；Rust 侧与前端类型检查全绿；未发现数据损坏、半写、跨会话串台、注入面或越权类缺陷。

登记 3 项低问题（§4）与 2 项证据完整性观察（§8），均不阻断，建议下轮清理。

## 2. 阻断项

无。

## 3. 红侧判别实验（我自己做，Edit 改、Edit 还原，全程未用 cp）

### 3.1 连接详情必须是「连接时快照」而非按 host_id 现查（§6.1）

改动：`crates/core-session/src/lib.rs` `session_detail` 的返回体由 `h.host.*` 改为 `self.list_hosts(ctx)` 现查（`find(|x| x.id == h.host.id)`）。

```
running 3 tests
test r41_tests::r41_detail_unknown_session ... ok
test r41_tests::r41_detail_is_connection_time_snapshot ... FAILED
test r41_tests::r41_detail_created_at_is_real_and_stable ... ok

---- r41_tests::r41_detail_is_connection_time_snapshot stdout ----
panicked at crates/core-session/src/r41_tests.rs:103:5:
assertion `left == right` failed: 详情必须显示连接时的地址，不是现在的配置
  left: "10.0.0.9"   right: "10.0.0.5"
```

判别力成立：**恰好 1 项变红**，且失败信息正是「快照 vs 现查」的语义差异（改址后现查得 10.0.0.9）。
还原后：`cargo test -p core-session --lib r41_detail` → `3 passed; 0 failed`；`git diff --stat crates/core-session/src/lib.rs` 回到 `34 insertions(+), 1 deletion(-)`（与作者原值一致），全树 md5 亦回到基线。

补充独立确认（非仅信任该测试）：
- `grep` 全仓：`SessionHandle.host` 无任何 `.host =` 赋值点，`SessionHandle::new` 收到的是建会话时 `vault.list_hosts()` 的克隆 → 快照语义由构造期保证。
- `ui/src/demo.ts:978-990` 的 `session_detail` 镜像同样取 `s.host_snapshot`（`hostSnapOf(h)` 在建会话时冻结），**不是**按 host_id 回查 → 不存在「demo 绿、后端红」的假绿。

### 3.2 连接详情对话框的 Esc 语义（旧版红 → 当前版绿）

旧版（`ac00356d…`）实测：连接详情打开时按 Esc 不关闭，且事件未被消费（冒泡期监听计数 = 1，对照：设置对话框 Esc 关闭且计数 = 0）。代码面原因：`closeTopOverlayRef` 未登记 `detail`，且 `modal` 不含 `detail`（`ui/src/App.tsx:2059`），Esc 落到终端层。

当前版（`b1353211…`）复验：

```
PASS 1 Esc 关闭连接详情且事件被消费  [{"open1":true,"still":false,"bubble":0}]
```

**结论：该缺陷已在审核期并行修复，当前版本不存在。**

## 4. 中/低问题清单（当前版本 `b1353211…` 实测）

### 低-1｜「事件类型」下拉里 `goal_set` 显示为原始键名

- 位置：`ui/src/App.tsx:167`（`LOG_ACTION_OPTIONS = [...Object.keys(AUDIT_LABELS), "goal_set"].map(v => ({v, label: auditLabel(v)}))`）+ `ui/src/App.tsx:121`（`auditLabel` 查不到即回落原键）。
- 实测：下拉项 `goal_set=goal_set`（原始键），而同一条记录在列表里渲染为「更新任务目标/清除任务目标」（`decisionLabel`，`ui/src/App.tsx:126-129`）。
- 具体失败场景：用户在「事件类型」里看到一项名为 `goal_set` 的英文键，与列表中该事件的中文名对不上，无法确认筛的就是它。后端确实会发 `action="goal_set"`（`crates/core-session/src/lib.rs:2248`），故不是死项。
- 复现：连任一主机 → 工具 → 活动记录 → 打开「事件类型」下拉 → 观察末项。

### 低-2｜无会话时「共 N 条」与空态自相矛盾（计数取的是全局总数）

- 位置：`ui/src/App.tsx:829`（`sid: logScope === "current" ? (sidRef.current || null) : null` → 无会话时退化为 `null`，即**不过滤会话**）、`ui/src/App.tsx:4700-4702`（note 恒显 `共 {logTotal} 条`）、`ui/src/App.tsx:4705-4708`（`current && !sid` 时直接渲染「未接入会话」空态，不看 logTotal）。
- 实测（当前版本，两次独立复跑一致）：

```
AFTER-ALL-CLOSED {"note":"本机时间（UTC+08:00）· 共 10 条","rows":0,"nosession":true,
                  "text":"未接入会话——切到「全部会话」可查看历史记录。","tabs":0}
```

- 具体失败场景：范围停在「当前会话」（默认），关闭全部会话后，标题行宣称「共 10 条」而正文说「未接入会话」且 0 行；因 `sid` 已为 null，连「（当前会话）」限定词都不显示，用户会误以为当前范围内真有 10 条记录。
- 复现：连 prod-1 → 工具 → 活动记录（默认当前会话）→ 逐个点会话标签 ✕ → 确认「关闭会话」→ 等 3s 轮询 → 观察 `.log-note` 与 `.log-empty-nosession`。

### 低-3｜`timeline` 已成死状态，但 3 秒轮询仍在查（多余 IPC）

- 位置：`ui/src/App.tsx:672`（`const [timeline, setTimeline]`）、`ui/src/App.tsx:782`（`refreshLists` 每 3s `invoke("audit_query", {sid:null, limit:60})` → `setTimeline`）、`ui/src/App.tsx:3128`（`visibleTimeline` 定义后再无读取点）、`ui/src/App.tsx:141`（`HIDDEN_AUDIT_ACTIONS` 仅被 `visibleTimeline` 使用）。
- 事实：R41 把「操作记录」从协作面板移出后，这三个符号只剩定义没有消费点（tsc 未开 `noUnusedLocals`，故不报错）。
- 影响：每次轮询多一次审计查询，结果无人渲染。无用户可见错误，属浪费与死码。

### 低-4（推断，未实测）｜`loadLog` 缺过期响应守卫，快速切换筛选可能显示不匹配的行

- 位置：`ui/src/App.tsx:824-843`。对比：`openSessionDetail` 用 `sidRef.current !== sid` 丢弃过期响应（`ui/src/App.tsx:813`），`refreshBrief` 有「审核 H1」守卫（`ui/src/App.tsx:894`）；`loadLog` **没有**任何请求代次/守卫，直接 `setLogEvents(page.events)`。
- 具体失败场景（推断）：在原生（Tauri IPC 多线程执行命令）下，用户切「人类/Agent」或「事件类型」后立刻再切一次，先发请求的响应若后到，会用旧筛选结果覆盖新筛选结果 → 列表内容与下拉选中项不符。
- **诚实标注**：demo 域的 `invoke` 实际串行，我无法在不改产品代码的前提下制造乱序，故**未实测**；这是代码面推断，不是实测结论。

## 5. 独立复核：`before_seq` 只是翻页游标（我自己写的临时测试，已删除）

按要求**不信任仓库自带测试**，我另写 `crates/audit/tests/rev_r41_tmp.rs`（2 项，跑完后已 `rm`，全树 md5 回到 `b1353211…`）：

```
running 2 tests
test rev_unknown_session_and_empty_store ... ok
test rev_before_seq_is_cursor_only_total_stable_and_pages_continuous ... ok
test result: ok. 2 passed; 0 failed
```

覆盖与结果（10 条种子事件，`limit=3` 沿游标下翻 5 页）：
- **total 不缩水**：5 页 `total` 恒为 10（=过滤后总数），带 `before_seq` 时仍是过滤后总数。
- **不重不漏**：5 页并集 10 条、去重后仍 10 条、严格 seq 降序、序列与全量查询逐项相等。
- **过滤语义**：`session_id`=5、`actor_kind=human`=6、`action=exec`=2、`agent∧exec`=1；**未知 `actor_kind`/`action` 得 0**（精确匹配，不是「不过滤」）。
- **边界**：`before_seq=0` 与 `before_seq=-5` → 0 行但 total 仍 10；`limit=0` / `limit=-3` → 回落 100 上限而非空页。
- **注入面**：`"s-a' OR '1'='1"`、`"human'; DROP TABLE audit_events;--"` 一律按字面量（结果 0），且随后全量查询仍为 10（表未被破坏）→ 过滤值全部走绑定参数。

（我第一次跑该临时测试时有 2 处**我自己**的期望值算错（human 写成 7、agent∧exec 写成 2），修正期望后全绿；这是我的测试算错，非产品缺陷。）

demo 镜像同口径独立复测（浏览器内直调 `audit_query`）：

```
{"fullTotal":4,"p1":{"total":4,"n":3},"p2":{"total":4,"n":1},"p3":{"total":4,"n":0},
 "noDup":true,"matchesTop":true,"before0":4,"beforeNeg":4,"beforeNegN":0,
 "actorUnknown":0,"actorHuman":2,"actionUnknown":0,"limit0N":4,"limitNegN":0,
 "sidUnknown":0,"filterTotalStable":true}
```

镜像与后端**唯一**分歧：`ui/src/demo.ts:1000` `const limit = (args?.limit as number) || 100;` —— 负数 limit 在 demo 会传给 `slice(0, limit)`（丢尾部 N 条），后端则回落 100。UI 只发 40（`LOG_PAGE`）与 60（旧轮询），**从 UI 不可达**，故不构成假绿，登记为潜在分歧。

## 6. 逐条验收对账（全部为我在当前版本实测/读码所得）

### 6.1 连接详情 = 独立可关闭对话框，连接时身份快照

```
PASS A1 连接详情=对话框（role=dialog）且字段齐全
  [{"host":"prod-1","user":"ops","addr":"10.0.0.11","port":"22","auth":"密码",
    "fp":"SHA256:hVvBTD1MEAi8sdrrIXVLdpXH9SL8MKdHmZ6geX2U4YI","cs":"UTF-8",
    "created":"2026-10-09 18:53:01（UTC+08:00）","sid":"s-demo-0101","copy":true,
    "hint":"以上为连接时的身份快照——主机配置此后被修改或删除，都不影响这里显示的信息。","role":"dialog"}]
PASS A2 技术详情含可复制会话 ID（与 sid 一致）
PASS A3 复制按钮给出反馈
PASS 1  Esc 关闭连接详情且事件被消费
```

七项身份（用户/地址/端口/认证类型/指纹/编码/创建时间）+ 主机名齐全；`data-testid="conn-detail"`、`role="dialog"`、`aria-modal="true"`，**不是**右侧面板（`.task-panel` 的 `rightPanel` 枚举里没有 detail）。快照语义见 §3.1。

### 6.2 活动记录 = 工作区可展开视图

```
PASS 1a 活动记录是工作区视图（tp-title=活动记录）
PASS 1b 时间戳含日期+时区说明  [2026-10-09 18:48:58 · prod-1（s-demo-0101） || 本机时间（UTC+08:00）· 共 1 条（当前会话）]
FAIL 2  goal_set 事件类型有中文标签  [label=goal_set]      ← 见 §4 低-1
```

- 是右侧工作区面板（`[data-testid="tp-title"]="活动记录"`），非对话框；`操作记录` 长滚动段已从协作面板移除——我独立复核：有会话时「工具 → 审批与记录」→ `title=协作` 且 `.task-panel` 文本不含「操作记录」。
- 默认当前会话、可切全部（`log-scope-current/all`，无会话时 current 按钮 `disabled`）。
- 可筛人类/Agent（`log-actor`）与事件类型（`log-action`，候选来自 `AUDIT_LABELS` 全集 + `goal_set`，不从结果集反推）。
- 时间戳 `YYYY-MM-DD HH:MM:SS` + `UTC+08:00` 说明。
- 主机/会话身份保留：`sessionIdent` **只增不删**（`ui/src/App.tsx:791-800`），会话关闭后其记录仍显示主机名（作者探针 G2 亦覆盖，我复跑通过）。
- 记录连续：见 §5（后端 + demo 镜像双向实测）。
- 空态与总数矛盾：见 §4 低-2。

### 6.3 凭据设置 = S11 左分类设置对话框；显式提交 + 未绑定态 + 草稿处置 + 引用不损坏

```
PASS 4a 输入私钥不落库（显式提交）  [0 -> 0 pemLen=74]
PASS 4b 敏感草稿未提交时切分类被拦截
  [{"shown":true,"stillCred":true,"text":"凭据表单里还有未提交的私钥内容——切到「外观」会丢弃它。丢弃草稿并切换留下继续编辑"}]
PASS 4c 「留下继续编辑」保留草稿且仍在凭据页  [{"pane":true,"pemLen":74,"draft":false}]
PASS 4d 「丢弃草稿并切换」切到外观且草稿提示消失
PASS 4e 全程未产生半成品凭据
PASS B1 未绑定凭据有明确状态徽章  [{"unbound":true,"bound":false,...}]
PASS B3 被引用后徽章变「使用中」（1.5s 内随 3s 轮询刷新；实测 1 台主机 → "用于：probe-host"）
PASS B4 被引用凭据删除被拒且无半删除
  [{"err":"✕ 凭据仍被 1 台主机使用（probe-host）——请先为这些主机改绑凭据或删除主机",
    "rows":1,"has":true,"bound":"使用中"}]
```

- 左分类设置对话框：`.settings-nav` 四类（外观/终端/凭据/关于），`settings-pane-*` 切换。
- 创建：**只有**点「生成 Ed25519/RSA」或「导入并保存」才落库；仅输入私钥/口令时 `list_identities` 长度不变（0→0）。
- 删除：走确认弹层（`confirm.kind="deleteIdentity"`，显式提交），被引用时后端拒删并列出占用主机，凭据仍在库中、主机绑定未受影响（无半删除）。
- 草稿处置：切分类被拦截并给出「丢弃草稿并切换 / 留下继续编辑」二选一；「留下」保留明文并留在凭据页。
- 关闭设置销毁草稿（Esc 与点遮罩两条路径实测）：重开后 `cred-new-pem` 为 `null`、表单收起、无残留 `cred-draft`。

## 7. 命令输出（原文摘录，当前版本）

```
$ cargo test -p tinyssh-audit
test tests::chain_detects_tamper ... ok
test tests::seq_cursor_paging_is_continuous_and_total_is_stable ... ok
test tests::append_query_verify_chain ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

$ cargo test -p core-session --lib
test result: ok. 93 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 12.56s

$ cargo test --workspace      # 32 个测试二进制
grep -c "test result: ok" → 32      grep -c "FAILED" → 0      grep -c "^error" → 0
WORKSPACE_EXIT=0

$ cd ui && npx tsc --noEmit
TSC_EXIT=0

$ node docs/acceptance/ux-r1/g4/2026-10-09-r41/r41-demo-probe.js     # 作者本轮探针
== R41 demo 探针 38/39 ==        （唯一 FAIL = H1，见 §8.1）

$ node docs/acceptance/ux-r1/g3/2026-10-09-e29df10-r35/r34-regress.js
35/35 passed

$ node docs/acceptance/ux-r1/g3/2026-10-09-e29df10-r35/r35-demo-probe.js
34/34 passed

$ node docs/acceptance/ux-r1/g4/2026-10-09-97035c8-r40/r40-demo-probe.js
23/23
```

已知警告（非本轮引入）：`crates/audit/src/lib.rs:3` 未使用的 `DateTime` import；`session-api` 2 条 `unused variable` 提示。

## 8. 证据完整性观察（不阻断，但影响下轮对账）

### 8.1 本轮自带探针 `r41-demo-probe.js` 的 H1 是**探针缺陷**，不是产品缺陷

H1 断言「协作面板里不再有操作记录长滚动段」，但它在该步之前用 `demoInvoke('close_session')` 关掉了会话——关掉后 `session-toolbar`（承载「工具」按钮）整条不渲染（设计如此，`ui/src/App.tsx:3606-3607` 注释「活动会话才出现——欢迎页不放失效的终端工具」），于是 H1 的 `find(工具)` 找不到按钮、工具菜单根本没打开、面板停在「活动记录」，`title=活动记录` 判红。

实测证据：

```
{"tag":"connected","nodes":[ … {"parentCls":"tabbar-row","btns":["标签列表"]},
                             {"parentCls":"session-toolbar","btns":["工具"]} ]}
{"tag":"after-close","nodes":[ {"parentCls":"tabbar-row","btns":["标签列表"]} ]}   ← 工具按钮消失
```

作者自存的 `probe-run1/2/3.txt`（18:27-18:29）同样记 `38/39`，即该 FAIL 在作者跑的时候就在。**底层验收点我独立复核通过**（有会话时「工具 → 审批与记录」→ `title=协作`、面板文本无「操作记录」），故 H1 应判为探针时序缺陷；但作者的轮次总结若写「探针全绿」，则属**证据超出主张**，需按 38/39 如实登记。

### 8.2 我更正自己先前的一个误判（R34 回归）

我最初用 `docs/acceptance/ux-r1/g3/2026-10-09-2ad8fbb-r34/r34-demo-probe.js` 复跑得 **12/35**，一度怀疑作者 `reg-r34.txt` 的 35/35 不可复现。**该怀疑是我选错了探针**：R34 轮那份探针是 §194 抽屉化**之前**的版本（它只 `click('.st-file')` 后找 `.xfer-row`，而当前树 `.xfer-row` 仅在 `{queueOpen && …}` 抽屉内渲染，`App.tsx:4809-4822`；我实测抽屉打开前 `.xfer-row` = 0、打开后 = 1）。R35 轮已另存抽屉感知版 `…/e29df10-r35/r34-regress.js`（第 68 行 `click('[data-testid="sb-transfer"]')`），我复跑 **35/35**，与作者记录一致。**作者的 reg-r34 数字成立，我先前的疑问撤回。**

（附带观察：`…/2ad8fbb-r34/r34-demo-probe.js` 在 R35 之后已失效，属仓库卫生问题，建议标注或删除，避免后续轮次误用。）

## 9. 未跑 / 未验证清单（如实声明，不得当作已验）

| 项 | 状态 |
|---|---|
| 原生冒烟 r41a/r41b/r41c（15199 beacon、真 sshd + 真 vault） | **未跑**。未使用作者 `smoke-run*-beacon-r41*.txt` 作为我的结论依据 |
| `sshd_e2e` 之外的其它原生 GUI 走查（真实窗口/键盘/焦点链） | **未跑**（仅 demo 域 playwright + 读码） |
| 视觉复验（对比度、240px 抽屉、几何 960×600 等）与 `vis-r41-*.png` | **未跑**。作者 `styles.css` 里 `--accent-text` 等改动我只做了读码，未做像素/对比度测量 |
| `reg-r31` 48/48、`reg-r32` 22/22、`reg-r33` 36/36、`reg-race` | **本轮未复跑**（只复跑了 r34-regress / r35 / r40 与本轮 r41） |
| 旧码判别（基线 worktree 跑本轮探针） | **未跑** |
| `loadLog` 过期响应竞态（§4 低-4） | **未实测**，仅代码面推断；demo 域无法在不改产品代码的前提下制造乱序 |
| MCP `query_audit` 新字段（`actor_kind`/`action`/`before_seq`）经真实 MCP 客户端调用 | **未跑**（只读码确认字段 `#[serde(default)]` + 透传 `AuditFilter`） |
| `src-tauri` 命令 `session_detail` 的真实 IPC 往返 | **未跑**（demo 域走 `demo.ts` 镜像） |

## 10. 复核方法与纪律

- 红侧改动一律用 Edit 反向改回，**未使用 cp 整文件写回**；还原后逐项核对 `git diff --stat` 与全树 `git diff | md5`。
- 临时测试文件 `crates/audit/tests/rev_r41_tmp.rs` 用完即删，删除后全树 md5 回到 `b1353211…`。
- 未提交 git，未改动任何产品代码（仅上述已还原的红侧临时改动 + 已删除的临时测试）。
- 判定前重新取 `git diff`/`md5`/mtime：审核期发现作者并行改树（18:53），已据新版重跑受影响项（r41/r34/r35/r40 探针、Esc 复验、tsc、core-session、workspace）。

---

# 增补：按 `b1353211…`（产品码面）复核后

本节为 team-lead 通知「审核期树已移动」后，我**重取 diff/mtime 并对并行改动逐项独立复验**的结果。结论：**仍为可签（无阻断项）**；§4 的低问题在移动后的版本上**依然存在**（低-1、低-2 已在新版重测确认）。

## A. 指纹对账（两个口径，请按此入档）

| 口径 | `git diff | md5` | 规模 |
|---|---|---|
| 全树（含作者 19:09 更新的登记文档） | `02cace4b3307bb5a78f9078a8e9f5c3d` | 12 文件 +1140/-65 |
| **产品码面**（`git diff -- . ':(exclude)docs/ux/ux-r1-execution-status.md'`） | **`b135321121dd4b78e85f4f6b408eeeae`** | 11 文件 +1138/-63 |
| 我审核开始时的快照 | `ac00356d12fed283fb0d534c3b996218` | 11 文件 +1098/-63（已过期） |

**我判定所依据的指纹 = 产品码面 `b135321121dd4b78e85f4f6b408eeeae`**（工作树本身，非自建隔离副本；Rust 侧我另做过临时红侧改动，均已 Edit 还原并核对 md5 回位）。作者 19:09 的 `docs/ux/ux-r1-execution-status.md`（+2/-2）为登记文档，不影响产品码面。

## B. 并行改动逐项独立复验

### B.1 `ui/src/App.tsx`

| 改动 | 我的复验 | 结果 |
|---|---|---|
| `closeDetail` 提为 `useCallback`（`:887`）+ 接入 Esc 浮层链（`:1699`，位于 `confirm`/`pasteConfirm` 之后、`splitMenu` 之前） | 打开连接详情后按 Esc：对话框关闭**且**事件被消费（冒泡期监听计数 0；对照设置对话框同为 0）；tsc 通过（作用域正确） | **PASS** |
| 新增 `useEffect([credDraftTo, showSettings])`（`:2036-2042`）：草稿确认框消解后把焦点收回对话框 | 4/4 PASS（见下） | **PASS** |
| `cred-empty` 补类名（`:4156`） | 实测 `className = "dim cred-empty"`；计算色 `rgb(77,91,104)` = 浅色 `--text-sub` `#4d5b68`，**不是** `--dim` `#5c6875` → 覆盖生效 | **PASS** |

焦点效果实测（`ui/src/App.tsx:2036-2042`）：

```
PASS F1 「留下继续编辑」后焦点收回对话框（不落 body）
     [{"tag":"TEXTAREA","testid":"cred-new-pem","inBox":true,"isBody":false}]
PASS F2 陷阱有效：12 次 Tab 焦点未逃出对话框  [escaped=0
     seq=["cred-new-pass","cred-new-import","cred-new-cancel","settings-close","settings-cat-appearance",...]]
PASS F3 「丢弃草稿并切换」后焦点收回对话框  [{"tag":"BUTTON","testid":"settings-close","inBox":true}]
PASS F4 干净打开设置：初始焦点在框内（未被新效果改写）  [{"testid":"settings-close","inBox":true}]
PAGE-ERRORS []
```

F1 的落点是原 textarea（明文草稿保留），F3/F4 落点是 `settings-close`（与干净打开的落点一致）——与代码注释所述语义相符。未发现该效果在「设置未打开」「模态叠开」时抢焦点（提前 return 的两个条件我都读码确认，且 F4 覆盖干净打开路径）。

### B.2 `ui/src/styles.css`

| 改动 | 我的复验 | 结果 |
|---|---|---|
| `--accent-text` 深 `#46aab5` / 浅 `#1f767c` | 读码确认两套主题各一条 | 已确认（**像素/对比度未测**，见 §9） |
| `.cred-new button.ghost { color: var(--accent-text) }` | 读码确认 | 已确认（对比度未测） |
| `.term-settings .cd-hint`、`.term-settings .cred-empty` 由 `--dim` 改 `--text-sub` | `cred-empty` 实测计算色 = `--text-sub` 值（见 B.1），覆盖确实生效 | **PASS** |
| `.seg button:not(.on):not(:disabled):hover` | 读码确认存在 | 已确认 |
| `.term-settings.conn-detail` / `.term-settings.settings-wide` 由 `absolute` 改 `fixed` | 三档视口实测两个对话框均 `position: fixed`、完全落在视口内、水平居中 | **PASS** |

fixed 定位实测（`getBoundingClientRect`）：

```
960x600   conn-detail={"top":109,"bottom":491,"left":265,"right":695,"pos":"fixed"} inViewport=true
          settings={"top":146,"bottom":454,"left":170,"right":790,"pos":"fixed"} inViewport=true
1024x768  conn-detail={"top":193,"bottom":575,"left":297,"right":727,"pos":"fixed"} inViewport=true
          settings={"top":230,"bottom":538,"left":202,"right":822,"pos":"fixed"} inViewport=true
1440x900  conn-detail={"top":259,"bottom":641,"left":505,"right":935,"pos":"fixed"} inViewport=true
          settings={"top":296,"bottom":604,"left":410,"right":1030,"pos":"fixed"} inViewport=true
```

960×600 下 top=109/bottom=491（此前被终端窗格裁到上界之外的问题不复现）；三档水平中心分别 480/512/720 = 视口宽一半，即**相对视口**居中而非相对 `.term-wrap`。fixed 语义成立的前提（祖先无 transform/filter/perspective/contain）我另行 grep 核过：`ui/src/styles.css` 中这些属性只出现在关键帧与小尺寸叶子元素上，容器类均无，故不存在包含块被改写导致偏移/裁剪的风险。

## C. 与通知描述的一处口径差异（请入档时按事实修正）

通知称本轮并行改动「不含任何逻辑/契约/测试面改动」。**测试面/契约面（Rust、`r41_tests.rs`、wire）确实未动**，我复核一致；但 `App.tsx` 的 Esc 浮层链那一处是**前端行为改动**，而且它恰好修掉了一个真实缺陷：我在移动前的版本（`ac00356d…`）实测到「连接详情打开时 Esc 不关闭，且 Esc 事件未被消费（冒泡计数 1，对照设置对话框 0）」。因此该 hunk 应记为「修复连接详情 Esc 缺陷」，而非纯样式/无逻辑改动——这有利于本轮对账（否则该缺陷会被记成从未存在）。

## D. 移动后版本的复测结论（§4 各项）

- 低-1（`goal_set` 下拉显示原始键名）：**仍存在**，新版实测 `label=goal_set`。
- 低-2（无会话 + 范围=当前会话时「共 10 条」与「未接入会话/0 行」矛盾）：**仍存在**，新版实测 `note="本机时间（UTC+08:00）· 共 10 条"`、`rows=0`、`nosession=true`。
- 低-3（`timeline` 死码 + 3s 冗余查询）：新版行号未变（`App.tsx:141/672/782/3128`），仍存在。
- 低-4（`loadLog` 缺过期响应守卫）：**仍为推断，未实测**（原因同前：demo 域 `invoke` 串行）。

## E. 移动后版本的全量回归（我在新版重跑）

```
r41-demo-probe.js（作者本轮）        38/39（唯一 FAIL = H1 探针时序缺陷，见 §8.1）
r34-regress.js                       35/35
r35-demo-probe.js                    34/34
r40-demo-probe.js                    23/23
cargo test -p tinyssh-audit          3 passed / 0 failed
cargo test -p core-session --lib     93 passed / 0 failed
cargo test --workspace               32 个测试二进制全 ok，FAILED=0，exit 0
cd ui && npx tsc --noEmit            exit 0
```

## F. 本次增补的未跑项（沿用 §9，未变）

视觉复验与对比度**像素级测量**（我只做了「类名/计算色/几何框」三项目标化验证，未做 WCAG 对比度计算与截图比对）、原生冒烟 r41a/b/c、原生 GUI 键盘/焦点走查、reg-r31/r32/r33/race、旧码判别、MCP 与 `src-tauri` 真实 IPC 往返。

---

# 增补二：处置后定向复验（5 项处置）

复验对象：team-lead 交办的 5 项处置（低-1~低-4 + vis-r41 阻断 B5）。只验这 5 项，未重跑全量。

## A. 指纹对账（本轮**发生了第二次树移动**）

| 时点 | 产品码面 `git diff -- . ':(exclude)docs/ux/ux-r1-execution-status.md' \| md5` | `ui/src/App.tsx` | `ui/src/styles.css` | 说明 |
|---|---|---|---|---|
| 交办指纹（我复核一致） | `36f149dd68ce2243fa3dd5afa76d90f9`（11 文件 +1168/-74） | `a53150588f3f6accd579636b015a5a40` | `52d2b42698616438fd08dc67cec642a0` | z-index 遮罩 41 / 对话框 42 |
| 20:07:42 起的当前树 | `3c034e88449ed5dc914cfbd941f85803` | `a53150588f3f6accd579636b015a5a40`（未变） | `961d09a3bce2fb35cd6c4660c090a9e6` | `.pop-mask`/`.term-settings` 的 z-index **退回 HEAD 原值 29/30**，注释仍写「41/42」 |

- 全树 diff（含登记文档）：`6dfb13191b52768f5b824b9a785aafb9`（起始）→ `c06dcd94abd8545491b54008db7955f6`（当前）。
- 我这一侧**未写入 29**：我的 z-index 红侧实验（41→29，验完用 Edit 改回 41）在 20:01 前完成并核对 md5=`52d2b426…`，其后的 20/20 定向探针实测 `tp-full=40 / pop-mask=41 / term-settings=42`。20:07:42 这次写入来源不明（非本审核侧）。
- 判定纪律：按「判定前重取 diff/mtime」，本增补**不对移动中的树出终裁**，两个状态分别记录。

## B. 5 项处置的实测结果（在 `36f149dd…` 指纹上）

| 项 | 处置内容 | 我的实测 | 红侧判别（我用 Edit 反向改回） |
|---|---|---|---|
| 低-1 | `LOG_ACTION_OPTIONS` 对 `goal_set` 给中文合并名 | PASS：下拉末项=`更新/清除任务目标`，无任何项回落成 `goal_set`；列表同一条仍走 `decisionLabel`（更新分支「更新任务目标」/ cleared 分支「清除任务目标」） | 摘掉中文名映射 → **仅 1a/1b 红**，1c/1d 仍绿 ⇒ 列表渲染确与下拉改名解耦 |
| 低-2 | ①无会话不查 + 作废在途；②note 改「未接入会话，无可显示记录」 | PASS：经 UI（标签 ✕ → 确认「关闭会话」）关掉全部会话后，标题=`本机时间（UTC+08:00）· 未接入会话，无可显示记录`、行 0、`log-empty-nosession` 在 | 还原守卫 + note → **复现原矛盾**：`共 10 条（当前会话）` 且 rows=0 |
| 低-3 | 删 4 个死符号 + `refreshLists` 里的 3s `audit_query` | PASS：全仓无 `HIDDEN_AUDIT_ACTIONS`/`visibleTimeline`/`setTimeline`/`timeline` 定义（仅剩注释）；`refreshLists` 无 `audit_query`。demo.ts 插桩实测：面板关闭 7s 内 `audit_query=0`（同期 `list_sessions=2`，证明插桩有效）；开活动记录后 `audit_query=1` | 未做红侧（负向实测 + 单调用点 grep 已足；插桩的正向能力由 3c 证明） |
| 低-4 | `logGenRef` 代次守卫 | **代码面确认、未实测**（demo 域 invoke 串行，制造不出乱序）——进入 `++`、await 后比对丢弃、`finally` 同代才清 busy、「无会话」分支 `++` 作废在途 | 未做（无法在 demo 域观测） |
| B5 | `.pop-mask` 29→41、`.term-settings` 30→42 | PASS：`tp-full=40 < pop-mask=41 < term-settings=42`；1024×768 下连接详情中心点命中对话框内部、可交互元素 2/2 可达；设置对话框同样可达；确认框(90) 压住设置(42) 的删除凭据路径可点 | 改回 29/30 → **5b/5c/5d 独红**（中心点命中 `log-sid`，0/2 可达） |

## C. 本轮新发现的两个问题

### C-1（阻断，当前树）：B5 的代码修复不在当前工作树上
`ui/src/styles.css` 当前 `.pop-mask` / `.term-settings` 的 z-index = **29 / 30**（= HEAD 原值），而其上方注释仍宣称「遮罩 41、对话框 42」。后果：**作者自己探针的 M1 断言当前为红**：

```
FAIL M1 右栏完整视图态下连接详情仍可达（未被面板盖住）  [{"fullView":true,"hitTop":{"inDetail":false,"top":201,"w":430}}]
== R41 demo 探针 41/42 ==
```

我独立复现：`zDialog=30 / zMask=29 / tp-full=40`，中心点 `elementsFromPoint` 栈顶为 `log-sid`（活动记录行）。即 vis-r41 的 B5 阻断项在**当前树**上依然存在。

### C-2（阻断，`36f149dd…` 指纹下的 41/42 修法）：抬 `.pop-mask` 会打死「分屏」菜单
`.split-menu` 是 z-index **30**，且与 `.pop-mask` **同父兄弟**。遮罩抬到 41 后盖住自己的菜单：

- 41/42 状态实测：菜单项中心 hit-test 命中 `pop-mask`（`hitSelf=false`）；**真鼠标点击**该点，capture 期 target = `["ghost icon-btn","pop-mask"]`，菜单关闭，按钮标题保持「分屏：在右侧显示已有会话，或在右侧新建会话」——**从未进入分屏**。窗口 1280×800 亦然，与宽窄无关。
- 反向对照（29/30 状态）：同一点 `hitClass="ghost sm-item"`、`hitSelf=true`，可正常选中 ⇒ 该破坏由 41/42 这次改动**引入**。
- 同用 `.pop-mask` 的另两处（连接详情、设置）是 `.term-settings`(42)，不受影响；`.split-menu` 是唯一受害者。若维持 41/42 修法，需同时把 `.split-menu` 抬到 42 以上。

## D. 本轮终裁

**不可签。** 两个独立理由：① 当前工作树上 B5 未修（注释/代码不一致，M1 实测红）；② 在 `36f149dd…` 指纹的 41/42 修法下，分屏菜单被自身遮罩整块盖死（真鼠标点击实证）。其余 4 项（低-1/2/3/5 中的层叠正向项）在该指纹上已验绿并做了红侧判别；低-4 仍如实标为「代码面确认、未实测」。

## E. 本轮未跑（沿用前文，未变）

视觉对比度像素级测量与截图比对、原生冒烟 r41a/b/c、原生 GUI 键盘/焦点走查、reg-r31/r32/r33/race、旧码判别、MCP 与 `src-tauri` 真实 IPC 往返。本轮只跑了 demo 域定向探针（`/tmp/r41-fix-probe.js` 20/20、`/tmp/r41-split-probe.js`、`/tmp/r41-split-func.js`、`/tmp/r41-m1-repro.js`）、仓库自带 `r41-demo-probe.js`（41/42）与 `npx tsc --noEmit`（exit 0）。

---

# 增补三：C-2 处置后的定向复验（终裁）

复验对象：team-lead 就 C-2 的处置（`.split-menu` 30→43 落成产品码）+ 指定的 3 项复验面。只验这 3 项。

## A. 指纹（第三次移动，已按此出终裁）

| 项 | 值 |
|---|---|
| 产品码面 `git diff -- . ':(exclude)docs/ux/ux-r1-execution-status.md' \| md5` | `bb3fa4ce193f59080b2630ba0e5e5e1d` |
| 全树 `git diff \| md5` | `81f27ce8a8fa7d480f79db49d73f1bf4` |
| `ui/src/App.tsx` | `a53150588f3f6accd579636b015a5a40`（自 20:01:37 未变） |
| `ui/src/styles.css` | `c22384e21cdda239212c33e9230e9c34`（20:16:23） |

**我判定所依据的指纹 = 上述产品码面 `bb3fa4ce…`，取自工作树本身**（非自建隔离副本；本轮红侧改动已用 Edit 反向还原并逐字节核对 md5 回位）。复核结束时指纹未再变动。

磁盘 z-index 全表（读码）：`tp-full 40 < .pop-mask 41 < .term-settings 42 < .split-menu 43 < .tools-menu 70 < .confirm-mask 90 < .hk-mask 100 < .toast-stack 120 < .sftp-menu 200`。dev server 所服务的 `/src/styles.css` 与磁盘逐项一致（无陈旧缓存）。

## B. 指定 3 项复验（全部 PASS）

**① `.split-menu` 真鼠标点击能进分屏（产品码，非注入）** — PASS
- hit-test：菜单项中心命中 `ghost sm-item`，`zMenu=43 / zMask=41`。
- **真鼠标点击**（`page.mouse.click` 于菜单项中心）：capture 期记录到的 target = `["ghost icon-btn","ghost sm-item"]`（**不是** `pop-mask`），随后按钮标题由「分屏：在右侧显示已有会话，或在右侧新建会话」变为「**退出分屏（会话保留不断开）**」——**确实进入了分屏**。
- **红侧判别**（用 Edit 把 `.split-menu` 改回 30）：真鼠标点击 target 变为 `["ghost icon-btn","pop-mask"]`，标题不变（未进分屏）；仓库探针 **N1/N2 独红**，总分 42/44。改回 43 后 44/44，md5 逐字节还原。⇒ N1/N2 判别力成立，该修复是承重的。

**② B5：1024×768 下连接详情仍可达** — PASS
- `tp-full=40 < pop-mask=41 < term-settings=42`；详情中心点 `elementFromPoint` 命中 `cd-v cd-fp`（`inDetail=true`），详情内可交互元素 **2/2** 可达。
- 仓库探针 **M1 转绿**：`PASS M1 … {"fullView":true,"hitTop":{"inDetail":true,"top":201,"w":430}}`。

**③ 确认框(90)/toast(120)/`.tools-menu`(70) 未被这次抬高反压** — PASS
- `.tools-menu`(70)：打开工具菜单，菜单项中心 hit-test 命中自身（`hitSelf=true`）。
- toast(120)：`.toast-stack` 为 `pointer-events:none`（toast 本不可交互，`elementFromPoint` 会按其设计跳过它），故**先临时注入 `pointer-events:auto`** 再 hit-test —— 命中 `toast ok`（文本「会话 ID 已复制」），即 toast 绘制在对话框之上。栈 z-index 实测 120。
- `.confirm-mask`(90)：设置(42) 打开时删除凭据的确认钮可命中（`hitSelf=true`，`zMask=90`）——确认框仍压住设置对话框。

## C. 本轮整体回归（同一指纹）

| 项 | 结果 |
|---|---|
| `/tmp/r41-fix-probe.js`（低-1/2/3 + 层叠 5 项，20 断言） | **20/20** |
| `/tmp/r41-layering-probe.js`（③ 专项，6 断言） | **6/6** |
| 仓库 `r41-demo-probe.js` | **44/44**（含 M1、N1、N2） |
| `cd ui && npx tsc --noEmit` | **exit 0** |

低-1（下拉中文名 + 列表 `decisionLabel` 细分）、低-2（无会话标题/空态一致）在**新指纹**上复测仍为绿。

## D. 终裁

**可签（无阻断项）。** C-1 与 C-2 均已闭合：C-1 的「当前树退回 29/30」已被重新落为 41/42/43 且注释同步更新（我在新指纹上实测 z-index 全表与 M1 转绿）；C-2 的 `.split-menu` 已抬到 43，真鼠标点击实证可进分屏，并有红侧判别背书（N1/N2 摘 43 即独红）。指定的 3 项复验面全部通过。

遗留（非阻断，如实登记，未变）：
- **低-4**（`loadLog` 过期响应代次守卫）仍为**「代码面确认、未实测」**——demo 域 invoke 串行，制造不出乱序；本轮同样未实测。
- 上一轮登记的低-1/低-2 已修；低-3 已修（负向实测）。

## E. 本轮未跑（沿用前文，未变）

视觉对比度**像素级测量**与截图比对、原生冒烟 r41a/b/c、原生 GUI 键盘/焦点走查、reg-r31/r32/r33/race、旧码判别、MCP 与 `src-tauri` 真实 IPC 往返。本轮全部结论限于 demo 域探针 + `tsc`。

---

# 增补四：二轮定向复验（C-1 + C-2，终裁）

复验对象：team-lead 指定的 C-1（B5 修复是否真在树上）与 C-2（分屏菜单），以及作者新增的 M/N 四项判别面。

## A. 指纹对账（与交办一致，本轮未移动）

| 项 | 值 |
|---|---|
| 产品码面 `git diff HEAD -- crates ui/src src-tauri \| md5` | `bb3fa4ce193f59080b2630ba0e5e5e1d` |
| 全树 `git diff HEAD \| md5` | `81f27ce8a8fa7d480f79db49d73f1bf4` |
| `ui/src/App.tsx` | `a53150588f3f6accd579636b015a5a40` |
| `ui/src/styles.css` | `c22384e21cdda239212c33e9230e9c34` |

**判定依据此指纹，取自工作树本身**（非隔离副本）。本轮红侧改动已用 Edit 反向还原并逐字节核对 md5。磁盘 z-index 全表（读码）：`tp-full 40 < .pop-mask 41 < .term-settings 42 < .split-menu 43 < .tools-menu 70 < .confirm-mask 90 < .hk-mask 100 < .toast-stack 120 < .sftp-menu 200`。

## B. C-1（B5 修复真在树上）— PASS

- `ui/src/styles.css` 实测 `.pop-mask` 41 / `.term-settings` 42 / `.split-menu` 43。
- **注释与代码一致**：`.pop-mask` 上方注释写「模态必须高于常驻面板：遮罩 41、对话框 42」并含 C-2 段；`.split-menu` 上方注释写「遮罩抬到 41（B5）后必须同步高于它……故 30 → 43」。无增补二中「注释说 41/42、代码是 29/30」的不一致。
- 上一轮我登记的 C-1（当前树退回 29/30）**已闭合**。

## C. C-2（分屏菜单）— PASS

- 真鼠标点击菜单项中心 → 命中 `ghost sm-item`（非 `pop-mask`），按钮标题变「退出分屏（会话保留不断开）」→ **进入分屏**（产品码，非注入）。
- 红侧（增补三已做）：`.split-menu` 改回 30 → 真点击 target 变 `pop-mask`、未进分屏，N1/N2 独红（42/44）。

## D. 独立复现作者新增的 M/N 四项 — 全部 PASS（含我自己另写的独立断言）

| 断言 | 作者探针 | 我的独立复现 |
|---|---|---|
| M1 详情中心点命中对话框 | PASS（`inDetail=true, top=201, w=430`） | PASS（增补三 5c/③d 同款） |
| **M2 遮罩压住 tp-full 面板** | PASS（取样点 (238,732) 命中 `pop-mask`） | **PASS（我自己另写 9×9 网格：面板内、对话框外 39 个取样点，39/39 全被 `.pop-mask` 接住，零泄漏）** |
| N1 菜单项**命中身份** | PASS（`hitCls=ghost sm-item`） | PASS（真鼠标点击 + capture 期 target 对账） |
| N2 `tp-full 40 < mask 41 < menu 43` | PASS | PASS（读码 + 计算样式） |

仓库 `r41-demo-probe.js` 独立复跑 **45/45**。

**M2 是必要补充**：只降遮罩（29）时 M1 仍绿（对话框自身可达），但面板仍可点、模态形同虚设——M1 单条测不出该退化。作者这条立得住。

## E. 对「`.split-menu`(43) > `.term-settings`(42) 语义反直觉」的判断

**结论：同意 vis-r41 的定性——不是缺陷，本轮不必改。** 但我不接受该结论只靠推断，做了独立可达性实证（`/tmp/r41-cooccur-probe.js`，6/6 PASS）：

- **方向 A（设置打开 → 想再开分屏菜单）**：分屏按钮中心 `elementFromPoint` = `pop-mask`；真鼠标点击该点 → 分屏菜单**未**打开，仅关闭设置。
- **方向 A 键盘**：穷举 ⌘\、⌘⇧\、⌘2、⌘d、⌘⇧d 均不打开分屏菜单；且全仓 keymap 的命令 id 只有 `bench/dark/light/search/settings/solar-*/system`——**根本没有开分屏菜单的键盘路径**（唯一入口是会话工具栏那个按钮的鼠标点击）。
- **方向 B（分屏菜单打开 → 想再开设置）**：设置钮中心命中 `pop-mask`；真点击 → 设置**未**打开，仅关闭分屏菜单；⌘, 亦被 `modal` 门控（`modal` 含 `splitMenu`）挡住。

⇒ 二者**双向都不可共存**，43 > 42 无任何可达后果。定性成立。

**但若想顺手消掉这个语义疙瘩，存在零成本重排**（我已用运行时注入实证，`/tmp/r41-m2-swap-probe.js` 4/4 PASS）：把两者**互换**为 `.split-menu` 42 / `.term-settings` 43——

- ② 分屏菜单仍可点（42 > 遮罩 41），真点击进入分屏；
- ③ B5 仍成立（详情可达 + 遮罩压面板）；
- ④ confirm(90) 仍压住设置(43)。

即「模态高于常驻浮层」的语义可以在**不牺牲任何功能**的前提下拿到（42/43 这条带此前是空的，互换无副作用）。**我的建议：本轮不改也可以（非阻断）；若要改，用互换而不是继续往上加。** 关键是要么留注释说明「不可共存故无序无害」（现状已写），要么互换取语义正确——不要只把 43 当作「更高就更安全」继续叠。

## F. 终裁

**可签（无阻断项）。** C-1 已闭合（注释与代码一致、41/42/43 就位）；C-2 已闭合（真鼠标点击实证进分屏 + 红侧判别背书）。作者新增的 M1/M2/N1/N2 四项我独立复现全部通过，M2 我另写了独立的 9×9 网格断言交叉验证。`.split-menu 43 > .term-settings 42` 经独立可达性实证（双向不可共存 + 无键盘路径）确认为非缺陷，**同意本轮不改**；若改，建议互换为 42/43（已实证零成本）。

遗留（非阻断，未变）：**低-4**（`loadLog` 代次守卫）仍为「代码面确认、未实测」——demo 域 invoke 串行，制造不出乱序。

## G. 本轮未跑（沿用前文，未变）

视觉对比度像素级测量与截图比对、原生冒烟 r41a/b/c、原生 GUI 键盘/焦点走查、reg-r31/r32/r33/race、旧码判别、MCP 与 `src-tauri` 真实 IPC 往返。本轮全部结论限于 demo 域探针 + 读码。
