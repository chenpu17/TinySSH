# R04 原生基线 — 环境记录（进行中）

> 日期：2026-10-06 · 代码基线：`7c4502e`（= 8491d06 + 设计文档，产品源码与 8491d06 一致）
> 状态：环境与工具链已核验；采样脚本与旧版样本 **尚未采集**。本文件不构成任何性能门通过。

## 1. 基准环境（冻结）

| 项 | 值 |
|---|---|
| 机型 / 芯片 | MacBook Pro · Apple M4（4P+6E）/ 24 GB |
| macOS | 27.0 (26A428) |
| UI 构建 | `npm run build --prefix ui` ✓ 559ms（chunk >500kB 警告，非阻塞） |
| Rust 构建 | `cargo build --release --locked --workspace` ✓ 52.2s（4 个既有 mut 警告） |
| 测试 sshd | docker `tinyssh-e2e`：alpine 3.20，127.0.0.1:2222（root/testpass，AllowTcpForwarding yes，sftp 可用），2223 远程转发回程 |
| 冒烟工具 | scripts/native-smoke/（ev.py CGEvent 注入、beacon.py 127.0.0.1:15199 进度信标）+ `TINYSSH_SMOKE` dev harness + 隔离 DB（TINYSSH_DB/TINYSSH_MASTER_KEY） |
| 网络 | 本机回环到容器，RTT≈0；外网场景另行标注 |

## 2. 与交付文档 §4 口径的对齐

- P1–P7 统计口径、P5 固定测量协议按 [交付文档 §4](../../../ux/ssh-client-ux-refactor-delivery.md) 执行；本机为文档建议的 Apple Silicon 基准环境。
- 内存口径：应用进程 + 专属 WebContent/GPU 辅助进程 RSS 合计，PID 归属需在脚本中验证（R04 出口条件之一）。

## 3. 已完成

- [x] 工具链构建验证（上表）
- [x] 硬件/OS/容器/冒烟工具盘点
- [x] 既有 e2e sshd 容器健康（Up 24h）

## 4. 待完成（本阶段出口条件）

- [ ] P1–P7 采样脚本（含 P5 预热/静置/B/E 协议、PID 归属验证脚本）
- [ ] 旧版（当前 UI）原始样本：P1 冷/热启动、P2 切换/回显、P3 建连、P4 吞吐各 ≥N 次原始数据
- [ ] 统计方法说明（P95 计算方式、样本数、异常值处理）
- [ ] 环境限制登记（如有）

## 5. 已知注意项（继承 T40 实测）

窗口重启位置漂移、WKWebView timer 节流（延时走 beacon 服务端）、真机坐标需重新标定、CGWindowList 为窗口权威。采样脚本必须遵守：Rust 侧编译/测试顺序执行，避免构建锁争用污染计时。
