# 2026-10-27 README 图廊扩容 + 出厂色板切东京夜 · UX 台账

用户两连拍板：「整几个截图放到 README」（4 张 v0.10.0 旧图太寒酸）→「深色，东京夜的配色似乎更加好看」（审美判定转产品默认）。

## README 图廊 4 → 8 张（docs/img/readme-*.png，全部深色 · 东京夜）

新增：**readme-md.png**（Agent 富渲染 mermaid 架构图 + KaTeX 公式）、**readme-fleet.png**（跨主机编排：派发→exec 工具卡完成态→巡检结果表）、**readme-files.png**（远程文件多选批量下载）、**readme-records.png**（记录审计泳道时间线）；四张旧图（terminal/agent/monitor/blocks）重拍到 v0.10.3 现状。截图全部 demo 域合成数据（迁移轮截图泄 IP 全史重写的教训零重演），逐张目检。

**capture-readme.cjs 升级为八图脚本**，四个可复用技法：

- **demo CPU 正弦相位门控**：demo 忙占比 ∝ `cos(t/17)`（周期 ~107s，负半相 ~53s 全是 0% 观感如坏）。等 `sin<-0.7 && cos>0`（相位 −90° 附近，每周期 ~13s 窗口）再开监控大屏——此后 40–53s 全是正相位，24s 采样窗拍摄点恰在峰值。第一版门控 `cos>0.15 && sin>0` 错在 π/2 附近也能通过、正相位余量只剩几秒。
- **记录审计走全新 context**：左栏四向互斥视图开关持久化（KV），监控大屏开着时 reload 会自动续开并藏掉主机栏（.hb-settings 不可达）——`browser.newContext()` 拿干净 localStorage 才是 spec 59 的初始态。
- **fleet 图滚工具卡居中**（不是跟着 mock 摘要滚到 mermaid）——mock 脚本对所有消息返回同一富摘要，不滚则 fleet 图与 md 图内容雷同。
- **connect 产生的重复标签延后**：staging-1 连接挪到文件面板之后、大屏之前，前六张图标签条保持两标签。

## 出厂色板族切东京夜（graphite → tokyo）+ 启动默认路径 bug 修复

- `PALETTE_DEFAULT = "tokyo"`（app-data.ts，2026-10-27 用户拍板）；终端 ANSI 16 色按族从 styles.css `--ansi-0..15` 派生（tokyo 真值在，ansi-gen 生成），切族即整体换装。
- **实锤一个隐性 bug**：启动装载 `loadPalette` 只在「有存储值且异于当前」时 `applyPalette`——全新安装（无 KV）**从不写 `data-theme` 属性**，CSS 落回 `:root` 石墨基底：改常量后设置页芯片选中的是东京夜、画面却还是石墨（首批深色截图 accent 仍是青色即此症）。修 = `loadPalette` 尾部无条件 `applyPalette(paletteRef.current)`（幂等写属性；demo/真实两路装载都过这里）。

## 验证

- `npm run build`（tsc + vite）30.65s 绿；UI 全套 820/822——2 失败均为「browser has been closed」基础设施抖动（坑 66 同族），单跑 41+50 复核 24/24 全绿，非色板回归。
- 八图目检：东京夜靛夜底 × 晴空蓝 accent、终端 ANSI 绿、泳道/徽标深色对比度全部成立。
- spec 25「十一族芯片在场」按列出的 id 计数不锁总数，15 族在场不炸；无任何 spec 钉默认选中族。

## 未竟

- 未提交等指令（README×2 + 8 PNG + agent-mock.ts 过时文案修正 + capture-readme.cjs + app-data.ts + App.tsx 启动修复）。
- 改 UI 后若发版：先 `npm run build` 再重打 release（custom-protocol 内嵌 ui/dist）——本轮 build 已刷。
