# A2/A3 归档：memsample v4.1 fail-closed 收口与自测

> 计划阶段 A 的 A2（收口 rev-q05fix 留档的两条 fail-closed 注记）与 A3（复跑自测并归档）。
> 本目录为**证据包**：原始自测产物 + 独立复核报告原文。

## 1. 对象与锚点

- 提交：`2f91bb6`（UX-R1 G5（A2/A3）：memsample v4.1 收口两条 fail-closed 注记，负路径自测扩至 13 项）。
- 归档时 HEAD：`4602917`。`git diff 2f91bb6 HEAD` 对两文件**为空**，工作树即 `2f91bb6` 版本。
- 锚点哈希（归档时自取）：

| 文件 | md5 |
|---|---|
| `scripts/perf/memsample.py` | `cc4c099a7e803cd5edbb493c8a7f1c2a` |
| `scripts/perf/memsample_selftest.py` | `ea1fe409b2e95f2c8ae1f11cf41f217c` |

## 2. A2 —— 两条 fail-closed 注记已收口（独立复核实测，CLI 端到端）

五条损坏输入路径全部 **rc=2 + 可读中文 stderr + 无产物文件**：

| 输入 | 命令 | rc | stderr |
|---|---|---|---|
| 损坏 cands JSON | `record --cands bad.json` | 2 | `FAIL: 无法读取 PID 映射 bad.json：JSONDecodeError: …` |
| 损坏 s0 JSON | `record --s0 bad_s0.json` | 2 | `FAIL: 无法读取 PID 映射 bad_s0.json：JSONDecodeError: …` |
| 非对象 JSON 根 | `candidates --s0 list.json` | 2 | `FAIL: PID 映射 list.json 不是 JSON 对象（得到 list）` |
| 非数字 pid 键 | `verify --cands badkey.json` | 2 | `FAIL: PID 映射 badkey.json 含非数字键 'abc'——…` |
| 零样本 duration | `record --duration 0` | 2 | `FAIL: record 未产生任何样本（--duration 0s / --interval 5s）——…` |

附加：缺失文件（`FileNotFoundError`，OSError 族）同样 rc=2 干净报错。**产物文件核查**：
损坏输入在 `load_pid_map` 即抛、零样本守卫在落盘之前 → 均不会写出被误当门证据的文件。

## 3. A3 —— 自测复跑 13/13

```
python3 scripts/perf/memsample_selftest.py --out memsample-selftest.json   → rc=0
```
原始输出 `memsample-selftest.out`（逐项 PASS 行 + 汇总）与结构化结果
`memsample-selftest.json`（`sampler=memsample v4.1`、`all_pass=true`、13 项 checks）
存于本目录。13 项 = P1, P2a, P2b, P3, P4, P5, P6, P7, P8, P9, P10, P11, P12。

**变异测试（独立复核执行，仓库未动，副本在 `/tmp`）**——证明关键断言非恒真：

| 变异 | 摘除的修复 | 变红项 | 症状 |
|---|---|---|---|
| M1 | `load_pid_map` 非数字键守卫 | P9 | 裸 `ValueError` |
| M2 | 零样本 duration 守卫 | P10 | 裸 `StatisticsError: no median for empty data` |
| M3 | `json.load` 的 try/except | P12 + P11 | 裸 `UnicodeDecodeError` / stderr 含 `Traceback` |

## 4. 独立复核

| 轮次 | 复核者 | 结论 |
|---|---|---|
| 独立复核 | `a2a3-review` | **处置后可签**（代码侧无阻塞缺陷；checklist 的「独立复核可签」主张在报告归档后方成立） |

报告原文：`review-a2a3.md`（未改一字）。复核者自取锚点与本文 §1 一致；变异测试三项
全红、五条 CLI 路径端到端复现、`git status --porcelain` 复核前后一致。

## 5. 口径与未做（未覆盖项逐条登记，不主张）

- **低危文档陈旧（不阻塞）**：`scripts/perf/memsample.py` 模块 docstring 写「自测 **12/12**」，
  实际 **13/13**；同句「新增 P9/P10/P11」漏列 P12。复核者判定为纯文档陈旧，建议随
  **下一次触碰**该文件时改正——本轮**未改**（改则漂移 `2f91bb6` 已复核锚点）。
- **未验证**：真机运行路径（真实 `ps` / 内存压力 / 应用启动）——自测为**纯数据探针**
  （monkeypatch，不启动应用），只证明**仪表有效性**，**不**构成性能数据，也**不**证明
  真机采样行为。真机 P5 全量协议在阶段 C（C3）执行。
- 本目录证明的是 `2f91bb6` 两文件的行为；`release-baseline-checklist.md:51` 的
  「独立复核可签」主张由本目录 `review-a2a3.md` 支撑。
