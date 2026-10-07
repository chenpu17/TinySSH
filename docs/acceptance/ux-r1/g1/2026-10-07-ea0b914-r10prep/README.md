# R10 开工准备归档（签署 §2 期限项）

> 日期：2026-10-07 · 基线 commit：`ea0b914`（git tag `old-ui-baseline-g0` 同点打标）
> 依据：交付文档 §构建条件 + [签署单](../../../ux/ux-r1-g0/g0-signoff.md) §2「R10 开工准备」行

## 归档内容

| 项 | 位置 | 说明 |
|---|---|---|
| 旧版源码版本 | git tag `old-ui-baseline-g0` = `ea0b914`；[source-snapshot.txt](source-snapshot.txt) | ui 5 文件 4379 行（App.tsx 为主），13 crates + src-tauri 全规模在案 |
| 构建配置摘要 | [build-config-sha256.txt](build-config-sha256.txt) | tauri.conf.json / Cargo.toml / Cargo.lock / ui/package.json SHA256 + 工作区二进制摘要 |
| 产物摘要 | 同上 binary 行 | `target/release/tinyssh-app` SHA256 `f23dd5b5…`（2026-10-06 21:46 构建，dev 门控 SMOKE 仪表版） |
| 隔离 DB fixture | [db-fixture-r04.sqlite](db-fixture-r04.sqlite) | R04 采样用隔离库原样副本（种子主机 20、`07*32` master key 环境约定见 r04-environment.md） |
| 测量环境 | r04-environment.md（2026-10-06-7c4502e 目录） | macOS 27.0 (26A428)、容器 tinyssh-e2e（127.0.0.1:2222）、vite 5183 前端条件——R04 全部数值的归属条件 |

## 产物哈希追溯注记

当前工作区二进制 `f23dd5b5…` 晚于 R04 采样用二进制（记录值 `8b021476…`，见 r04-baseline.md 文首）——其间 main.rs 仅 dev 门控 SMOKE 注入脚本差异（修订轮 `.host-card` 选择器修正后重建）。两者均为「release 后端 + dev 前端」工程基线产物，**均非打包 release**；G5 绝对门与新旧回归以打包产物为准（见 release-baseline-checklist.md）。

## 后续约束

- 本目录归档后为只读证据；R45 旧 UI 清理时不得删改本目录。
- 旧版源码留存以 git tag 为权威；R51 对比前如需旧版打包产物，从 tag 点构建并按冻结协议补测（交付文档 §构建条件）。
