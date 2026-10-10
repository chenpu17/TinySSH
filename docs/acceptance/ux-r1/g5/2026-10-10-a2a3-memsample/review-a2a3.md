# A2/A3 独立复核报告（`a2a3-review`，2026-10-10）

> 归档自复核 subagent 的最终报告原文（未改一字）。锚点：`HEAD=4602917`；
> `memsample.py` md5=`cc4c099a7e803cd5edbb493c8a7f1c2a`；`memsample_selftest.py` md5=`ea1fe409b2e95f2c8ae1f11cf41f217c`。

复核完成。以下是裁决与证据。

---

# A2/A3 独立复核裁决：**处置后可签**

代码侧（A2/A3）无阻塞缺陷，可签；但 checklist 的「独立复核可签」主张目前**无支撑**，须处置后方可成立。

## 锚点（自取）
- `rev-parse HEAD` = `4602917249d41b10c7a5420f6af6c627199aeef4`
- `md5 memsample.py` = `cc4c099a7e803cd5edbb493c8a7f1c2a`（与作者报一致）
- `md5 memsample_selftest.py` = `ea1fe409b2e95f2c8ae1f11cf41f217c`（一致）
- `git log 2f91bb6..HEAD` 两文件 **无后续提交**；`git diff 2f91bb6 HEAD` 两文件为空 → 工作树即 2f91bb6 版本。

## Q1 两条注记是否真收口 —— 是（CLI 端到端实测）

五条路径全部 rc=2 + 可读中文 stderr + **无产物文件**：

| 输入 | 命令 | rc | stderr |
|---|---|---|---|
| 损坏 cands JSON | `record --cands bad.json` | 2 | `FAIL: 无法读取 PID 映射 bad.json：JSONDecodeError: Expecting property name...` |
| 损坏 s0 JSON | `record --s0 bad_s0.json` | 2 | `FAIL: 无法读取 PID 映射 bad_s0.json：JSONDecodeError: Expecting value...` |
| 非对象 JSON 根 | `candidates --s0 list.json` | 2 | `FAIL: PID 映射 list.json 不是 JSON 对象（得到 list）` |
| 非数字 pid 键 | `verify --cands badkey.json` | 2 | `FAIL: PID 映射 badkey.json 含非数字键 'abc'——文件损坏或非本采样器产物` |
| 零样本 duration | `record --duration 0` | 2 | `FAIL: record 未产生任何样本（--duration 0s / --interval 5s）——...` |

附加：缺失文件（`FileNotFoundError`，OSError 族）同样 rc=2 干净报错。

产物文件核查：`o1.json / o2.json / o3.json / o5.json` **全部 NO**——`cmd_record` 的落盘在零样本守卫之后，损坏输入在 `load_pid_map` 即抛，均不会写出被误当门证据的文件。

`--duration 0` 是 `type=int` 的合法值，确凿走到被测分支（非 argparse 拒参）。任务提示的 `--interval 0.1` 陷阱已规避。

## Q2 selftest 13/13 是否真断言 —— 是（变异测试三项全红）

独立复现：`13/13 PASS`，exit 0。变异（镜像到 `/tmp`，**未动仓库**）：

| 变异 | 摘除的修复 | 变红项 | 症状 |
|---|---|---|---|
| M1 | `load_pid_map` 非数字键守卫 → 裸 `int()` | **P9** | `<ValueError> invalid literal for int() with base 10: 'not-a-pid'` |
| M2 | 零样本 duration 守卫 | **P10** | `<StatisticsError> no median for empty data` |
| M3 | `json.load` 的 try/except | **P12 + P11** | P12: 裸 `UnicodeDecodeError`；P11: rc=1 且 stderr 含 `Traceback` |

三项变异各命中预期测试项，无恒真/空转项。13 项 = P1,P2a,P2b,P3,P4,P5,P6,P7,P8,P9,P10,P11,P12。

## Q3 主张与证据一致性 —— **主张无支撑**（高，阻塞该主张）

`release-baseline-checklist.md:51`：「采样器 v4→v4.1 收口两条 fail-closed 注记（2026-10-10，**独立复核可签**）」。全仓核查：

- 无任何文件引用 `2f91bb6`（`grep -rln 2f91bb6` 空）。
- `docs/**` 中 `v4.1` 仅出现在该 checklist 自身；`b1-build.log` 的 `v4.1` 是无关 Rust crate `objc2-encode v4.1.0`。
- `docs/acceptance/ux-r1/g5/` 下只有 `a1`、`b1`、`primitives` 三个包，**无 memsample/A2/A3 复核包**。
- 唯一的「独立复核」字样在 `2f91bb6` 的 commit message 内，作者为 `cppupu`——属作者自述，非可归档复核报告，不构成「可签」证据（违反本项目「作者自查不算数」纪律）。

**结论**：该主张当前无据。本复核报告（即本文）归档后，主张方可成立——我不代为回填。

## Q4 新引入缺陷 —— 无阻塞项

- **非数字键取舍**：干净报错（非静默跳过），方向 fail-closed，与模块声明一致，报错文案自足。合规。
- **异常链**：JSON 读路径 `from e` 保留（实测 `__cause__ = JSONDecodeError`）；非数字键路径用 `from None`（有意抑制，因 `int()` 的 ValueError 已被中文文案覆盖）。非缺陷。
- **低（不阻塞）**：`memsample.py:14` 模块 docstring 写「自测 **12/12**」，实际 13/13（commit 标题亦写 13）；同句「新增 P9/P10/P11」漏了 P12。纯文档陈旧，建议随下一次触碰改正。

## 仓库未改动声明

`git status --porcelain`（复核前后一致，脏项均与 memsample 无关，系他 agent 并行产物）：
```
 M scripts/perf/ev2.py
?? docs/acceptance/ux-r1/g5/2026-10-10-primitives/
?? scripts/native-smoke/winsize.py
```
变异测试全部在 `/tmp` 副本进行，已删除；两文件 md5 复核后不变。