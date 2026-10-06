# R04 原生基线 — 环境记录（进行中）

> 日期：2026-10-06 · 代码基线：`7c4502e`（= 8491d06 + 设计文档，产品源码与 8491d06 一致）
> 状态：采样已出结果——P1/P3/P6 实测、P5 试点完成，P2/P4/P7 环境阻塞延期；数字与判定见 [r04-baseline.md](r04-baseline.md)。本文只记环境与方法。

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

**采样会话采用方法 v2（差分归属，2026-10-06 按用户约束修订：浏览器类应用保持运行）**：①启动前快照 WebKit 辅助进程全集 S0；②launch 目标应用 → 窗口加载完成 → 快照 S1，候选 = S1−S0（预期 WebContent/GPU/Networking 各 1）；③**采样期间只合计应用进程 + 候选 PID 的 RSS**（用户浏览器中途新增的辅助进程不在候选集，不影响合计）；④会话末退出应用 → 快照 S2，**候选中仍存活于 S2 的剔除且该会话作废重跑**。P1–P4/P6/P7 为计时/计数口径，不依赖进程归属，无需任何退出操作。已按用户要求放弃零基线方案。

**v2 实证（2026-10-06 16:23，release 二进制 + 隔离 DB `/tmp/r4sample/`）**：启动后新增 WebContent/GPU/Networking 三候选；TERM 退出后 `grep` 全部消失；宿主系统既有 16 个 WebContent 辅助进程全程无扰。注意：裸二进制不响应 AppleScript `quit by name`，采样脚本统一用 `kill -TERM`（退出干净，辅助进程随之消失）。DB 隔离（TINYSSH_DB/TINYSSH_MASTER_KEY）在 release 二进制下生效。

## 3. 已完成

- [x] 工具链构建验证（上表）
- [x] 硬件/OS/容器/冒烟工具盘点
- [x] 既有 e2e sshd 容器健康（Up 24h）
- [x] PID 归属方法实证与采样会话方法冻结（§2.1）
- [x] P5 采样器 `scripts/perf/memsample.py`（**v2 差分法**：snapshot/candidates/record/verify；初版 v1 的零基线 --validate 与全系统合计口径经独立审核废弃重写）

## 4. 待完成（本阶段出口条件）

- [x] 采样会话——按 §2.1 差分归属执行（零基线方案因用户"浏览器保持运行"约束废弃）
- [x] P1/P3/P6 采样脚本（scripts/perf/p1_launch.py、p3_connect.py、p6_cycles.py）+ P5 试点 p5_pilot.py
- [x] 统计方法说明（P95 inclusive、样本数、异常值处理——见 r04-baseline.md §2）
- [x] 环境限制登记（§2.1 sudo/launchctl；另见 r04-baseline.md §5 事故与 §6 替代口径）
- [ ] P2/P4/P7 复测（键注入延期，复测条件已在 r04-baseline.md §5.4 冻结）

## 5. 已知注意项（继承 T40 实测）

窗口重启位置漂移、WKWebView timer 节流（延时走 beacon 服务端）、真机坐标需重新标定、CGWindowList 为窗口权威。采样脚本必须遵守：Rust 侧编译/测试顺序执行，避免构建锁争用污染计时。
