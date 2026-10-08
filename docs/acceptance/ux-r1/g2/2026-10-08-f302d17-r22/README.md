# R22 证据包：C7 SSH config 导入诊断（基线 f302d17，2026-10-08）

## 1. 冻结契约 → 实现映射

| 契约 | 实现 | 测试 |
|---|---|---|
| DF7.1 三级分类 | `vault/sshcfg.rs` is_blocking_key（proxyjump/proxycommand/proxyusefdpass/certificatefile/include）→ Blocking；连通性无关键（serveraliveinterval 等）→ Warning；导入五键/注释 → 忽略 | vault sshcfg 16 单测 |
| first-obtained-wins | 解析器 v2 shadow 追踪：通配块/顶层的键入影子，具体条目只继承自身 Host 行之前的影子；影子键 fail-closed 记 Blocking（被遮蔽键真 ssh 不生效，静默导入会连错地址） | wildcard_block_shadows_later_entries / after_entry_does_not_shadow / irrelevant_keys_do_not_shadow |
| 溯源 | 条目级 source_file/source_line（host 行号）；单指令级 line | c7_classification（source_line>0 断言）|
| DF7.5 | user 缺失 → user_specified=false + directly_importable=false（不静默 root） | c7_classification（nouser 断言）|
| DF7.3 | 重复（同名 OR 地址+端口+用户）默认 skipped_reason=Duplicate；`overwrite: bool` → upsert_host(id=既有id) 以 config 值覆盖 | c7_classification（dupx username old→root、id 不变、条数 1）|
| Blocked skip | 直接导入被拒（含阻断/无用户）→ skipped_reason=Blocked，不写库 | c7_classification（blocked/nouser）|
| DF7.4 转手工表单 | UI 用预览载荷预填 AddHostForm（name/address/port/username/tags=ssh-config/authMode）→ 既有 upsert_host，零新命令 | demo 探针 E1-E3 |
| CLI 默认 | 只导 directly_importable && !already_imported；跳过原因逐条打印 + 汇总（阻断/重复计数） | cargo build；语义同核心（核心测试承担）|

## 2. 测试与探针

- **核心**：`cargo test -p tinyssh-vault` 29/29（sshcfg 20 单测，含处置轮新增 4 项判别）+ `cargo test --workspace` **142/0**（处置后终数）。
  - 初版 c7_classification_skip_and_overwrite（Blocked/Duplicate/overwrite/DF7.5/溯源，旧语义代码必红）；
  - 处置轮新增：match_shadow_blocks_later_entry_user / match_shadow_blocks_later_entry_proxyjump（rev H1 判别 P1/P2，旧代码必红）/ match_warning_keys_do_not_shadow / shadow_push_dedups（L1 判别）/ c7_batch_internal_duplicate_skipped（M3 判别，旧代码必红）；
  - preview_and_import_local_parts 期望更新：e2e-agent 与 e2e-key 同三元组（127.0.0.1:2222 root）→ 按 DF7.3 判 Duplicate（原期望「两条都落库」与冻结契约冲突，随 M3 语义更正；Agent 认证路径断言移入 c7 用例）。
- **UI 类型**：tsc 0 错误。
- **demo 探针**（真实 Chromium + :5183，r22-demo-probe.js）：**15/15 ×4 轮**（r22-probe1/2/3 初版代码，probe4 处置后代码）——A1-A3 分级标注+溯源；B1-B4 默认勾选=可直接导入且未导入、阻断/无用户勾选禁用+转手工表单钮；C1-C2 导入成功+主机卡刷出；D1-D2 已在列表「勾选即覆盖」（反证设计：若 overwrite 未随请求发送，核心回 Duplicate、行内必现「跳过：重复」兜底文案）；E1-E3 转手工表单预填（blocked 提示含不兼容指令、nouser 提示未指定用户且**用户名恒空**（处置后：FE 按 user_specified 置空，mock 值 currentuser 模拟核心 $USER 兜底形状）、标签 ssh-config、面板关闭）；Z1 零 JS 错误。
- **rev 自建对抗探针**（/tmp/rev-r22-probe/rev-r22-fe-probe.js）：处置后 **5/5**（D2=M1 实证：编辑「本机」后转手工表单 → 全新表单+预填+无编辑态指纹区）。
- **原生冒烟**（release tinyssh-app + 隔离 DB + 口令 env，无钥匙串）：
  - `beacon-r22a.txt`（RUN_ID=r22a，初版代码）：preview-ok / skip-ok / overwrite-ok / panel-ok（真实 ~/.ssh/config 2 行）/ DONE，零 FAIL 零 JS-ERROR。
  - `beacon-r22b.txt`（RUN_ID=r22b，全新 DB 复跑）：同链路全绿 DONE。
  - `beacon-r22c.txt`（RUN_ID=r22c，**终签轮**，处置后代码+重建 dist/release）：全链 DONE——preview-ok 含 H1 原生实证（前置 Match 段 User 遮蔽 → r22-mblocked directly_importable=false + user Blocking）与 M2 核心形状断言（nouser username 兜底非空且 user_specified=false）；skip-ok/overwrite-ok/panel-ok 同前；零 FAIL 零 JS-ERROR。
  - 合成 config 归档 `smoke-config.txt`（含 Match 影子段；通配/Match 块自身不出现在 names 断言内）。

## 3. 取向登记

1. **原生冒烟语义链走显式 path**（/tmp/smoke-r22/config 经 inv 传入）：UI 面板 path:null 指向用户真实 config，数据不可控——面板自身仅弱断言（打开/渲染行数/收起无错），默认勾选/分级徽章/预填渲染语义由 demo 探针以确定性 mock 承担。
2. **「勾选即覆盖」**：UI 勾中已导入行 → 整批 overwrite=true（DF7.3 显式覆盖入口，L6 批粒度已在 footer 文案明示）；Duplicate/Blocked 行内文案保留作预览过期竞态兜底（预览后他端写库时核心回跳过原因；Duplicate 兜底提示「收起面板重开后勾选可覆盖」——重开后 already_imported 对账命中，覆盖闭环）。CLI 不提供覆盖（默认集=可直接导入且未导入），覆盖路径在 GUI。
3. **影子键 fail-closed 记 Blocking**（含 hostname/user/port/identityfile 被遮蔽）：真 ssh first-obtained-wins 下被遮蔽键不生效，静默导入会以显示值连错目标——归阻断而非警告。
4. **Match 块处置（rev-r22 H1 处置取向）**：块内阻断键+五导入键保守入影子（解析期无法判定匹配条件，对命中条件的后续连接 first-obtained-wins 成立，宁可阻断不静默可导入——A09）；**警告级键不入影子**（不影响连通语义，避免对后续条目误标阻断——保守度仅让步于连通无关键，rev 复证项）。
5. **DF7.5 预填取向（rev-r22 M2 处置）**：核心 preview.username 保持 v1 兜底当前用户（展示面），FE 手工表单按 user_specified 置空用户名强制补全——兜底值不透传表单。
6. **Match 块维持不产出条目**（V1 子集），但键值经影子生效（H1 处置前仅跳过，属违约，已修）。

## 3b. rev-r22 处置台账（初判 1高3中6低 → 复证**可签**）

| # | 级 | 发现 | 处置 |
|---|---|---|---|
| H1 | 高 | Match 块影子完全缺失，错误值可静默直连导入（P1 错误用户 / P2 绕过跳板） | 已修：Match 键入影子（见取向 4）+ P1/P2 判别测试 + r22c 原生实证 |
| M1 | 中 | onManual 不清 editingHost → 编辑表单劫持转手工表单（保存篡改本机） | 已修 setEditingHost(null)；rev FE 探针 D2 复证 5/5；欢迎页添加钮同病属 R22 前既有 → 登记 R23 前置清单 |
| M2 | 中 | DF7.5 预填兜底值架空必填；demo mock 与核心分歧掩蔽真实行为 | 已修：FE 按 user_specified 置空；mock 对齐核心形状（currentuser）；r22c 补核心形状断言 |
| M3 | 中 | 导入循环批内快照不更新 → 同批同三元组双落库 + UI 覆盖死循环 | 已修：known 集成功即并入 + c7_batch_internal_duplicate_skipped；UI Duplicate 文案改重开面板闭环 |
| L1 | 低 | 影子五键 push 不查重 → 重复阻断项渲染 | 已修 push_shadow 首现即胜 + 判别测试 |
| L2 | 低 | dedup_by 只去相邻同名（非相邻同名块两行、第二行 address 回落 name） | 登记（v1 沿袭），归后续解析器加固 |
| L3 | 低 | is_import_key 死代码 | 已删 |
| L4 | 低 | strip_comment 不认 tab+# | 登记（v1 沿袭） |
| L5 | 低 | DF7.1 点名 @cert-authority 无 config 侧指令可检（仅 CertificateFile 实装） | 登记契约勘误候选归 R23 勘误清单 |
| L6 | 低 | 整批 overwrite 粒度 UI 文案未示 | 已补 footer 批粒度文案 |

## 4. 独立审核与视觉复验

### vis-r22（独立视觉复验）：**可签**

- 新面：面板 5 行 280px/224px 双栏宽无叠印/截断/溢出（盒测量：checkbox 右缘 36 vs 文本左缘 45、转手工表单钮左缘 179 vs 文本右缘 173，均分离）；prefill 提示行两变体正确、盒宽 241px 与表单行 6px 不叠；亮色抽验诊断色可读；零 pageerror。
- 零回归：双树同操作逐像素（base=f302d17 worktree vite:5184 vs r22 :5183），同侧噪声底 diff_px=0；添加表单/设置弹窗（r21 已签面）/亮色欢迎页逐位一致，欢迎页仅 6 像素 AA 抖动（单像素、8 邻域全同）；面板态差异 bbox 右缘 215/271 严格落在 hostbar 宽内（两树 demo seed 3 vs 5 行，预期 diff）。
- 登记不阻签：L1 224px 窄栏 bastion 诊断文本逐词换行可读性一般（280px 正常，归后续打磨）；L2 复验脚本字段名 bug 致 intersect 全误报，按原始盒数字手算修正（非产品面）。
- 证据：`vis/`（base/ 9 图 + r22/ 13 图 + vis-r22-diff.txt + vis-r22-drivereport.json）。
- **处置后定向复验（postfix-*）：维持可签**——footer 追加文案 280/224 态换行不溢出；Duplicate 兜底文案盒 215×34px 两行换行不破版（并勘误：该文案为预览过期竞态兜底，正常勾选路径必置 overwrite=true 不可触发，与 §3-2 登记一致）；nouser 预填负向探针成立（未置空即现 currentuser，实证 FE 置空生效）、面板行不泄漏兜底值。证据 postfix-P1/P2a/P2b/P3*.png + postfix-report.json。

### rev-r22（独立代码审核）：初判**处置后可签**（1高3中6低）→ 处置后复证升级 **可签**

契约核心面达标认定：分级/溯源 wire 一致、Blocked 服务端强制、overwrite 缺省安全、转手工表单零新命令、label 误触不可能（D1 实证）；违约点 = Match 影子缺失（H1，A09 点名形态，rev 以真实 crate 判别探针 P1/P2 活体实证）。

**复证（全链独立重跑，未采信自查）**：①判别探针复跑 P1/P2 影子在位、P3 去重生效、M3 批内用例核实为真判别（旧代码双落库必红）+ 实现读核 known 集并入点；FE 探针 5/5。②老测试期望改动成立——e2e-agent/e2e-key 确同三元组，旧期望双落库产出互为 already_imported 的两条主机、与去重语义自相矛盾，属契约一致化非放宽。③警告级不入影子可接受——警告键从不进 HostDraft、first-obtained 分歧无可观察导入后果，入影子反而违背 DF7.1 警告级「可导入」定义；兜底桶（CanonicalizeHostname 类）属 DF7.1 冻结清单层面事项维持登记。复跑：vault 29/29、sshcfg_import 4/4、workspace 142/0、tsc 0；r22c 冒烟门与独立探针互证。L2/L4/L5 维持登记。
