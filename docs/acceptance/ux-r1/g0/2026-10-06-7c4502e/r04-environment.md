# R04 原生基线 — 环境记录（联审修订版）

> 日期：2026-10-06 · 代码基线：`7c4502e`（+ dev 门控 SMOKE 仪表修订，产品路径不变）
> 状态：联审 Q-01~Q-06 修订中；结果与关闭映射见 [r04-baseline.md](r04-baseline.md)。本文记环境与方法。

## 1. 基准环境（冻结）

| 项 | 值 |
|---|---|
| 机型 / 芯片 | MacBook Pro · Apple M4（4P+6E）/ 24 GB |
| macOS | 27.0 (26A428) |
| UI 构建 | `npm run build --prefix ui` ✓ 559ms（chunk >500kB 警告，非阻塞） |
| Rust 构建 | `cargo build --release --locked --workspace` ✓（4 个既有 mut 警告） |
| 采样二进制 | SHA256 `8b021476100a8940f1bf7d1201e6222e4714b0f35a3db76499d7a92b3a7c67fb`（SMOKE 仪表修订版；首轮采样为修订前构建，产品源码相同） |
| **前端服务（Q-04 调试发现，回溯登记）** | release 二进制按 `tauri.conf.json` devUrl 加载 `http://localhost:5183`（cargo 直构建不内嵌 ui 资产）。**全部 R04 采样在本地 vite dev server 存活条件下进行**（首轮：`cargo tauri dev` 会话；修订轮：`npm run dev --prefix ui`）。G5 对比必须同条件；真实打包产物差异需在 G5 前补一次同协议验证 |
| 测试 sshd | docker `tinyssh-e2e`：alpine 3.20，127.0.0.1:2222（root/testpass，AllowTcpForwarding yes，sftp 可用），2223 远程转发回程 |
| 冒烟工具 | scripts/native-smoke/（beacon.py 127.0.0.1:15199）+ `TINYSSH_SMOKE`/`TINYSSH_RUN_ID` dev harness + 隔离 DB（TINYSSH_DB/TINYSSH_MASTER_KEY） |
| 键鼠注入（延期执行） | **ev2.py PID 定向驱动**（CGEventPostToPid + 同进程守卫 + 拒绝路径负例自测通过）；旧 ev.py/keyguard.py 全局投递方案废弃，不再被引用。执行须受控环境（联审决议） |
| 网络 | 本机回环到容器，RTT≈0；外网场景另行标注 |

## 2. 与交付文档 §4 口径的对齐

- P1–P7 统计口径、P5 固定测量协议按 [交付文档 §4](../../../ux/ssh-client-ux-refactor-delivery.md) 执行；本机为文档建议的 Apple Silicon 基准环境。
- 内存口径：应用进程 + 专属 WebContent/GPU 辅助进程 RSS 合计，**fail-closed 归属**（lstart 身份 + 逐候选曲线 + 消失/复用作废——Q-05 修订）。

### 2.1 PID 归属方法（v3 差分 fail-closed）

零基线方案废弃（用户约束：浏览器不退出）→ v2 差分归属 → **联审 Q-05 指出 v2 非 fail-closed**（启动时冻结 PID；中途消失记 0/漏计；退出核验无 PID 复用检测）→ **v3**：候选带 `lstart` 启动身份、逐候选独立曲线落盘、采样中候选消失、身份变化或出现未知新 WebKit 进程（提供 --s0 即全封闭）→ 采样作废（exit 2 / voided 字段）；退出核验含残留 + lstart 复用双向检查。实现：memsample.py（CLI 四步）、p5_pilot.py（内置）。首轮 P5 试点数据（v2 归属）降级为参考，v3 重跑后归属出口再评。

## 3. 已完成

- [x] 工具链构建验证（上表）
- [x] 硬件/OS/容器/冒烟工具盘点
- [x] 既有 e2e sshd 容器健康（Up 24h）
- [x] PID 归属方法实证与采样会话方法冻结（§2.1）
- [x] P5 采样器 `scripts/perf/memsample.py`（**v3 差分法**：snapshot/candidates/record/verify；初版 v1 的零基线 --validate 与全系统合计口径经独立审核废弃重写）

## 4. 待完成（本阶段出口条件）

- [x] 采样会话——按 §2.1 差分归属执行（零基线方案因用户"浏览器保持运行"约束废弃）
- [x] P1/P3/P6 采样脚本（scripts/perf/p1_launch.py、p3_connect.py、p6_cycles.py）+ P5 试点 p5_pilot.py
- [x] 统计方法说明（P95 inclusive、样本数、异常值处理——见 r04-baseline.md §2）
- [x] 环境限制登记（§2.1 sudo/launchctl；另见 r04-baseline.md §5 事故与 §6 替代口径）
- [ ] P2/P4/P7 复测（键注入延期，复测条件已在 r04-baseline.md §5.4 冻结）

## 5. 已知注意项（继承 T40 实测）

窗口重启位置漂移、WKWebView timer 节流（延时走 beacon 服务端）、真机坐标需重新标定、CGWindowList 为窗口权威。采样脚本必须遵守：Rust 侧编译/测试顺序执行，避免构建锁争用污染计时。
