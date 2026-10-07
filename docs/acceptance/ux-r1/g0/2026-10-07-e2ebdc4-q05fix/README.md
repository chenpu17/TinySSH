# Q-05 采样器修复证据（memsample v4）

> 日期：2026-10-07 · 基线：签署提交 `bbd2341`（签署单 docs/ux/ux-r1-g0/g0-signoff.md §2「下次 P5 采样前」期限项）
> 修复对象：`scripts/perf/memsample.py` v3→v4 · 探针：`scripts/perf/memsample_selftest.py`

## 修复内容（对应签署探针 memsample-probe.json 四项发现）

| 签署探针发现 | 根因 | v4 修复 |
|---|---|---|
| S0 旧进程混入候选集（actual ["101","202"]） | `cmd_candidates` 的 s0 JSON 装载为 str 键，与 ps 采集 int 键永不相交 | 新增 `load_pid_map()`：所有 `{pid: …}` JSON 装载边界统一转 int（candidates/record/verify 三处共用） |
| 活候选被误判「消失」作废 | `cmd_record` 用 str 键 `cur.get(pid)` 查 int 键表恒 miss | cand 装载经 `load_pid_map` 归一 |
| 应用 RSS 计入两次（1+1=3 MiB） | `total_mb = app_kb + sum(per)` 而 per 已含 app 条目 | helper 合计显式排除 `app` 键，total = helper + app 恰一次 |
| 退出 PID 复用误 PASS（exit 0，应 2） | `cmd_verify` alive 检测键错配恒空；复用判定「任意进程同 lstart」语义错误 | alive 改为 int 键成员判定；复用改为「同 pid 存在但 lstart 变化」 |

另：record 输出新增 `sampler_version: "v4"`（签署 §3 脚本版本绑定要求）；协议字符串同步 v4。

## 探针结果

`probe-results.json`：**9/9 PASS**（P1 候选集排除 S0；P2a 活候选不误判 + P2b app 单计 2.0MiB；P3 消失作废；P4 换身份作废；P5 未知新 helper 作废；P6 干净退出 PASS；P7 残留 FAIL；P8 复用 FAIL）。纯数据、零注入、零真实 ps 依赖（monkeypatch 驱动真实 CLI 子命令，s0/cands 文件均经磁盘 JSON 往返）。

真实 CLI 冒烟（本机，无应用运行）：snapshot 20 个系统 helper → candidates = 当前 − S0 = **0**（修复前此处错误返回 20）→ exit 2「候选为空」为无应用运行时的正确 fail-closed 行为。

## 状态

- 复现命令：`python3 scripts/perf/memsample_selftest.py --out <results.json>`（exit 0 = 全 PASS）
- 独立复核：**rev-q05fix 对抗复核，裁决可签关闭**——四缺陷逐项实读验证 PASS；自测 9/9 复跑一致；自写对抗探针 10/10 PASS（非数字键 fail-closed、app 中途消失、零样本、snapshot→candidates→record→verify 全链路磁盘 str 键往返、sampler_version 绑定、重复键折叠）；p5_pilot.py 证实免疫；两条低危注记（损坏 cands/零样本为裸栈崩溃而非干净报错，方向均 fail-closed）不阻塞，随下次修订收口
- 边界：本证据仅证明**仪表有效性**；P5 性能门仍**不可判**，有效归属试点按签署期限 G1 退出前在受控环境执行
