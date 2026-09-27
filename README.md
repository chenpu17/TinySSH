# TinySSH

> 人机协同的 SSH 客户端：工程师与 AI Agent 在同一套终端会话上协作——Agent 操作，人类旁观、审批、随时接管。

## 文档

| 文档 | 内容 | 何时读 |
|---|---|---|
| [PRD](docs/prd.md) | 愿景、设计理念（决策过滤器）、需求与验收标准、里程碑 | 任何功能取舍前 |
| [L0 总体设计](docs/architecture/l0-system-design.md) | 系统上下文、容器视图、技术选型、ADR、Spike 清单 | 动手写代码前 |
| [L1 模块设计](docs/architecture/l1-component-design.md) | crate 划分、SessionApi 接口、审批/凭据/MCP 设计、数据模型、威胁模型 | 实现各模块前 |
| [产品验证计划](docs/validation-plan.md) | PV 用户研究设计、观察指标、决策 gate | V0 阶段先于一切功能投入 |

## 治理约定

1. **PRD §5 设计理念是决策过滤器**：实现争议用它裁决；违反任何一条的方案默认否决。
2. **PRD §6.2 非目标**：未修订该节而引入范围内的能力视为偏离愿景。
3. **文档修订**：PRD / L0 / L1 的变更须更新对应文档的「修订记录」；**PRD 变更后，L0/L1 须在合并前同步评审一致性**；新的关键技术决策在 L0 §6 追加 ADR（触发标准：换库、跨 crate 契约变更、安全边界变更）。
4. **V0 双验证先于一切功能投入**：技术 Spike 达标 **且** 产品验证（PV）gate 通过（docs/validation-plan.md），才进入 V1。先证明「把远程现场交给 Agent，再拿回来」确实更好用，再扩大客户端功能。

## 状态

文档 v0.5（已吸收三路内部评审与外部专家三轮评审；专家结论：理念通过，可启动 V0）。定位：人机协作 SSH 工作台；核心体验：交接闭环。契约已闭合（作废含待审批、重确认白名单机制、PV gate 唯一权威归 validation-plan §6）。下一步：V0（技术 Spike + thin-slice 原型 + 三段式用户研究）。

## 技术栈（概览）

Tauri v2 · Rust（tokio / russh ≥0.61 / portable-pty / alacritty_terminal / tree-sitter-bash）· React + xterm.js · SQLite · MCP（rmcp ≥2.0.0，streamable HTTP + stdio shim）
