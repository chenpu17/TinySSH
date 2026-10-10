# A1 —— `vm_stat`/压力同步观测采集器（G5 阶段 A）

> 交付物：`scripts/perf/vmstat_probe.py`（新增，只读压力观测采集器）+ 其自测
> `scripts/perf/vmstat_selftest.py` + 试点接线 `scripts/perf/p5_pilot_ux1.py`。
> 依据：签署单 §3 增补——P5 须自预热贯穿到 E **同步**采集 `vm_stat`、只读压力状态、
> swap/压缩/页回收计数及时间戳，并**预先登记**采样频率与失效判据。

## 1. 提交

| commit | 内容 |
|---|---|
| `b28fdda` | P5 压力同步观测采集器与试点接线（初版） |
| `6e8564a` | A1 复核收口：判据集补齐相位/类型校验，试点清理陈旧点 |

`6e8564a` 改动面：`vmstat_probe.py` / `vmstat_selftest.py` / `p5_pilot_ux1.py` /
`release-baseline-checklist.md`（4 文件）。

## 2. 采集口径

- **只读**：`vm_stat`、`sysctl kern.memorystatus_vm_pressure_level`（1/2/4）、
  `sysctl vm.swapusage`、`memory_pressure`、压缩页/页回收计数。不写系统状态。
- **同频同步**：与 memsample 各相位同频（5s/点）；预热首点 `P0` 起，`warmup/B/load/E`
  逐相位成序列。
- **失效判据 I1–I8（预登记，任一触发则整轮不可判）**：含增长类判据逐相位相对 `P0`
  基线取最大增量；缺字段/缺基线/缺**整段相位**/类型非法/点位非对象/未喂入归属 →
  一律不可判（fail-closed，补集显式覆盖「无法评估」态）。

## 3. 独立复核

| 轮次 | 复核者 | 结论 |
|---|---|---|
| 初审 | `a1-review` | 提 F1–F6（判据集缺口），**不可签** |
| 收口复核 | `a1-recheck` | **可签**（F1–F6 全部关闭） |

`a1-recheck` 独立手段：自建五相位夹具经 **CLI 重放**（非单测路径）逐条复现反例；
**变异测试**证明 V16–V19 是真断言（杀死修复后各自 FAIL，其中杀类型检查时 `invalid=False`
证明无该检查则字符串被静默放过）；healthy 五相位按试点等价命令 → `rc=0`（未过度收紧）。
其证据目录 `/tmp/rc_a1_v2/`（夹具、裁决产物、变异副本、stderr 捕获）。

复核前重取确认：三文件工作树干净、`HEAD=6e8564a`；复核全程只读，仓库树无修改。

自测复现：`python3 scripts/perf/vmstat_selftest.py --out …` → **19/19 PASS**
（原始输出 `vmstat-selftest.out` / `vmstat-selftest.json`，本目录）。

## 4. 登记：非阻塞发现（不阻塞签署，留待 R51 执行时留意）

- **N1（低）`verdict --points` 绑定参数序**：I6 按**传入序**判时间单调。用 shell glob
  字母序（`B E P0 load warmup`）喂 healthy 数据会触发 I6 → 假「不可判」。方向
  **fail-closed**（不会假通过），试点用显式时序序（`p5_pilot_ux1.py:209-210`）不受影响；
  该语义早于 `6e8564a`，非本提交回归。**人工复核重放裁决时必须按时间序喂入。**
- **N2（低）多余相位不失效**：`expected_phases` 为子集校验（expected ⊆ present），
  多出的未知相位（如标签笔误 `Load`）不触发 I8；但多余相位仍受 I1–I5 全量扫描，
  笔误经缺失侧抓住。设计可辩护，仅需文档消歧。

两项均为文档/使用建议，未改动 `6e8564a` 已签文件（保签名完整）。

## 5. 口径与未做（未覆盖项逐条登记，不主张）

- **未跑试点端到端**：`p5_pilot_ux1.py` 的完整链路需 docker `tinyssh-e2e` + 被测应用 +
  已播种 DB，且**需屏幕解锁**（锁屏时 WKWebView 冻结）。F2 相关机制为**静态代码验证 +
  裁决步等价命令实测**，非端到端实测。
- **未验证**：试点实采时 wall clock 不回跳的假设——若回跳则触发 I6，方向 fail-closed，
  无假通过风险。
- 本目录**不含**试点实采产物（`press_*.json` / `pilot-result.json`）；全量协议归 R51。
