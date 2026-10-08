# rev-r19 复验报告（处置后，2026-10-08）

复验人：rev-r19（独立对抗审核 subagent 二轮）。对象：工作树处置后 diff（基线 99fec0e）。
方法：H1/M3/M4 全路径交错推演（含 both-ready select、双向锁竞争）、pending_sid/session_id
双字段全生命周期追踪、锁序全量排查、term 内存序分析、新增 6 测试逐个「会红吗」审查、
cargo test 复跑（c1 相关 21 过、workspace 32 套件全绿）、README 处置记录逐条比对、
beacon-r19c 标记核对。

## 结论：处置后可签（附条件）

- H1 ✓ 不变量「受理即置位 cancel_requested + 结算权唯一」在所有可达交错下成立
  （含 both-ready select 双臂逐一推演）；投递临界区与取消置位互斥，Ready-改写不可达。
- H2 ✓ 主体正确（复验时为微秒级残余窗口 N1，签前已关闭，见下）。
- M1/M2/M3/M4/M6/L2/L3/L5 ✓ 全部处置到位；M3 死锁自由（双锁嵌套全库唯一且同序）、
  term 内存序 Release/Acquire 配对正确；M5 部分修如实、勘误登记合规。
- 副产修复 ✓（审批卡写回两处 + 死锁规避注释）。

## 复验新发现与签后处置

- **N1（中）**：pending_sid 写入（await st 锁）在 sessions.insert 之后——insert 与写入间
  await 点 + select 双 ready 随机偏好可致 drop 早于写入（三重巧合微窗）。**签前已关闭**：
  写入移到 insert 之前（sid 预生成；两语句间无 await——drop 早于写入 ⟹ insert 未发生
  无幽灵；drop 晚于写入 ⟹ 清扫必拿到 sid），窗口完全消除。
- **N2（低-中）**：inner 失败（write/record_session Err）路径半会话幽灵（v1 既有缺陷面，
  attempt 化使其可见）。**签前已关闭（attempt 路径）**：Failed 结算前清扫 pending_sid；
  v1 直调同面缺陷登记归后续（R23 前置清单）。
- N3（低）：M3 测试 join! 无真并行（等价顺序调用）——代码正确性由同步临界区保证，
  登记测试强度项。
- N4（低）：M4 测试未驱动窗口态并发双 cancel（unreachable 主机恒 Connecting）——
  登记测试强度项。
- N5（低）：合并 TOCTOU（term 锁外预筛与锁内快照间可终态，begin 偶发返回终态快照；
  自愈、契约字面不违、处置引入）——登记已知豁免。
- 覆盖缺口登记 → R23 FE 接线前置清单：H1 让渡分支钩子变体回归网、H2 端到端
  （inner 中段取消全链）、窗口态并发双 cancel、v1 create_session 幽灵面。

## 复验时点证据

c1_tests 14/14；workspace 32 套件全绿（vault c8_favorites 同毫秒平局 flake 与 R19 无关，
登记）；beacon-r19c 全链 DONE。**签前关闭 N1/N2 后终轮**：workspace 32 套件全绿、
demo 探针 21/21、原生冒烟 r19d 全链 r19-DONE 零残留（beacon-r19d.txt）。
