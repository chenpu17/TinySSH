# 提交前复审轮（commit-review-round）——2026-11-01

## 背景

用户指令：「安排 subagent 审核下最近的修改，并要保证最近验证的全面。」对象=工作树全部未提交改动（39 文件 +1392/−259 + 7 未跟踪：5 份台账 + locale-resolver.mjs/.d.mts；对应找茬三轮 + 下载覆盖轮 + 界面语言/墨水屏主题轮的叠加）。

## 三路子代理复审

| 路 | 范围 | 结论 |
|---|---|---|
| Rust | core-session/session-api/transport-pty/transport-ssh/main.rs 逐 hunk + 两份设计台账对照 | 无 P0/P1；4 P2 + 3 P3；14 项「已查无问题」清单（回环终止性/replace_approved 生命周期/session-api 连锁/main.rs 超时链等） |
| 前端 | ui/src 全部改动 + locale-resolver 新文件 | 无 P0；3 P1 + 3 P2；覆盖清单含 eink 两面 44 变量齐备、nuke 副作用逐动画排查、localeP 接线、Esc 链、TDZ 等 |
| 测试+文档 | spec 05/09/60 + 两校验器 + README×2 + 5 台账 | 无 P0；2 P1（文档数字）+ 4 P2；计数链对账 909→914→928 自洽，README 状态行可信 |

## 修复（本轮落笔）

**Rust**
- R-1（P2-1）代际闸窗口未闭合：respawn/reconnect 先 `alive.store(true)` 后 `gen.fetch_add`——旧泵 teardown 恰在两步之间执行闸检查时 gen 未变仍等于其 my_gen，会把刚武装的 `alive=true` 撤销（R2-2 要消灭的症状的残余）。修=PTY respawn（transport-pty/src/lib.rs）gen 推进+领号前移到武装之前；SSH reconnect 同款前移，establish 开头的推进收口删除（职责注释归 reconnect）。
- R-2（P3-5）SSH 泵 my_gen 从 `load` 改 `fetch_add(1)+1` 领独立号（与 PTY 同款）——handle 锁 take 后 establish 全程无锁，并发 establish 下 load 会共享同号。
- R-3（P2-3）core_local.rs 探针注释对齐单探针语义——「轮询式探针/等 200ms 重探」是 never_loop 修复时漏删的旧话，实际行为=单次判定落败走 assert。

**前端**
- F-1（P1-1）realignAfterFit 回归收口：R3-C-1 的修复在每次 attach 无条件 `scrollToLine`——标签切换会把用户上翻的阅读位拽回内容尾（主线路径行为回归）。修=`ensureSessionTerm` 改返「本次是否新建 term」（`Promise<boolean>`，三分屏调用方不消费不受影响），realign（含 400ms 补拍）只挂 fresh——fit 缩行 reflow 只发生在新建路径（检查点按接入前高度预对齐+attach 后工具条压矮），焦点切换/重连复用实例 rows 未变无 reflow。几何门控方案被否：清屏（ED2 不清 scrollback）等边界无法从 buffer 区分「毁损空区」与「真实空屏」。
- F-2（P1-2）真→演练回切空面板：清场 effect 删 `convs[sid]` 后种子 effect deps 未变不重跑，当前打开的会话停在零消息空面板（注释宣称的「重播欢迎语」未发生）。修=清场即补种——被删 sid 直接落欢迎语种子（真模式会话不入仓，MOCK_CONVS 必无此 sid，补种即干净欢迎语，与种子 effect 同源同语义）。
- F-3（P1-3）EN 词条补漏：「面板关闭时中断，未完成」（R3-B-2 消毒文案）——全量 1177 个 t() 键扫描的唯一缺漏。

**文档**
- D-1（P1-2）README 双语 quick-start 旧计数 48 spec/789 断言 → 54 spec/928 断言（与状态行自相矛盾；除这两处外无第三处旧计数，复审全文件 grep 核实）。
- D-2（P1-1）download-overwrite 台账「+7 断言」勘误为「+5 断言」并删「skip 收尾」（实数 5 条 ck.check，skip 收尾是无断言的清理点击）。
- D-3（P2-2）「CI runner navigator.language=en-US」理由失实（harness 实际对每个上下文固定 `newContext({locale:"zh-CN"})`——demo 即便跟 OS 也不打穿断言）：统一改为「套件确定性基座」口径，共 4 处（locale-resolver.mjs 头注释、i18n.ts 头注释、spec 60 D 段注释、locale 台账关键决定段）。决定本身（demo 固定 zh）不变。

## 登记立案（本轮不动代码）

- 立案A（Rust P2-2）：下载覆盖「目标在提交窗内消失」时 replace 发布既误记覆盖审计、又对窗口内重建文件无卡覆盖（stat 判缺席→rename 之间外部重建=任意内容无 CAS 约束）。修法方向=复检判缺席改走 ns_publish（本地 hardlink create-or-fail 原子，窗口内重建→Rejected→出卡），审计按实际走的发布分支记。
- 立案B（Rust P3-4）：replace 发布 Rejected 的原因可被吞（用户选 Skip 后那次失败 rename 零留痕）——reason 并入审计或卡面。
- 立案C（Rust P3-6）：同端口 Remote 转发查重 TOCTOU（服务端 bind 会拒绝第二个，风险窗口极小；可选 request_remote 成功后复核）。
- 立案D（Rust P3-7）：env 键白名单抽纯函数补测试（首字符数字/含 `$(` 拒绝）。
- 立案E（前端 P2-1 前端版）：决策卡「看见即标记」实现与三轮登记意图（抽屉开着不标记→关闭即顶回）相反——实现自洽且更优（多卡连关不骚扰 + .attn 兜底高亮），复审建议在台账登记口径拍板而非改回。
- 立案F（文档 P2-1）：spec 05「Esc 关抽屉」前置无断言（若关抽屉与自动展开同时回归则两条断言真空通过）+ skip 终态断言缺失。
- 立案G（文档 P2-4）：spec 60 真值表可选补 3 条（osLangs=null、列表含空串条目、显式值×osLangs=undefined）。
- 立案H（前端 P2-2/P2-3）：fmtUptime 默认 `tr=(s)=>s` 会把占位符原样吐出（现有调用点已全传 t，改必填防未来漏传）；aria-label 分段拼接硬编码全角「，」（既有模式非本轮引入）。

## 验证矩阵

| 项 | 结果 |
|---|---|
| 三主题校验器（ansi-gen 32态×16slot 双门 / wcag 42 档 / semantic-hues 32 态） | 全绿 |
| cargo fmt --all --check | 过 |
| cargo clippy --workspace --exclude tinyssh-app | 0 error；全部警告既存（逐条比对行号均不在本次 diff hunk 内） |
| cargo test --workspace --exclude tinyssh-app | 全绿 |
| cargo check -p tinyssh-app | 过（37.4s，debug check 不触 codegen 崩溃） |
| 定向 Rust（core-session/transport-pty/transport-ssh，R-1/R-2 修复后） | 全绿 |
| ui build（tsc+vite） | 29s 0 错 |
| 全套 UI（修复前基线） | 928/928（57-proxyjump 正常通过） |
| 定向 spec 09/30/51/60（前端 P1 修复后） | 126/126 |
| 全套 UI 终态（全部修复落笔后） | **928/928 全绿** |

## 教训

- **注释承诺与行为不符是复审的高产矿区**：R-3 的「等 200ms 重探」、F-2 的「重播欢迎语」都是代码改了注释没跟——never_loop 那次的立法本意就是「注释说重探、代码不重探」，结果只改了代码留了注释。改语义必须同步注释，复审时注释-行为一致性要当一类单独扫。
- **「修复」自身的回归面要按调用方清点**：R3-C-1 realign 挂在 attachSession（多入口共用）就吃了个主线路径回归——四类调用方（标签点击/键盘切换/⌘K 恢复/连接完成）语义不同，无差别挂行为钩子前先问「哪些入口本不该有这个行为」。
- **文档数字要跟断言实数对账**：+7 vs 实数 +5、quick-start 789 残留多轮——台账/README 的计数断言每轮写完当场 grep 旧值清残留，别留给复审来抓。
