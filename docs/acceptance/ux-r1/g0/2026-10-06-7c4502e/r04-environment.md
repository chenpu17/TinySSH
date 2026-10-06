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

### 2.1 PID 归属方法实证（2026-10-06，对运行中 dev 实例 PID 24901）

| 方法 | 结果 |
|---|---|
| PPID 父子链 | **失效**——WebKit XPC 辅助进程均挂 launchd（PPID=1） |
| `proc_pidinfo(PROC_PIDT_BSDINFO)` ctypes 全缓冲扫描 | **失效**——返回 232 字节中无 responsible_pid（对 dev 应用与无关 WebContent 双向验证均无） |
| `launchctl procinfo` | 需 root；R04 采样会话可用 sudo 尝试 |
| 时间相关性 | **不采信**——系统常驻多个 WebKit 辅助进程（Safari 等），启动时间相近易误归 |

**采样会话采用方法（两层验证）**：①受控环境——采样前退出全部 WebKit 宿主应用，基线断言 WebContent/GPU/Networking 辅助进程计数为 0；②启动目标应用后出现的全部 WebKit 辅助进程按计数（Tauri 预期 WebContent+GPU+Networking 各 1）+ 启动时间窗 + **退出应用后辅助进程随之消失** 三重核对后计入。核对失败 → 该项按交付文档 §4 记「未完成」，不得估算。

## 3. 已完成

- [x] 工具链构建验证（上表）
- [x] 硬件/OS/容器/冒烟工具盘点
- [x] 既有 e2e sshd 容器健康（Up 24h）
- [x] PID 归属方法实证与采样会话方法冻结（§2.1）
- [x] P5 采样器 `scripts/perf/memsample.py`（归属两层验证 fail-closed 实测：对 25 个系统常驻 WebKit 辅助进程正确拒采）

## 4. 待完成（本阶段出口条件）

- [ ] 受控采样会话（退出全部 WebKit 宿主 → 基线归零断言 → release 应用冷/热启动、切换/回显/建连/吞吐原始样本）
- [ ] P1–P4/P6/P7 采样脚本（复用 beacon/ev.py 冒烟链）
- [ ] 统计方法说明（P95 计算、样本数、异常值处理）
- [ ] 环境限制登记（如 sudo 不可用对 launchctl procinfo 的影响已在 §2.1 记录）

## 5. 已知注意项（继承 T40 实测）

窗口重启位置漂移、WKWebView timer 节流（延时走 beacon 服务端）、真机坐标需重新标定、CGWindowList 为窗口权威。采样脚本必须遵守：Rust 侧编译/测试顺序执行，避免构建锁争用污染计时。
