# i18n 铺开轮（面板内文 + 主机表单 + 长尾 toast）

日期：2026-10-26。前情：同日 V1（i18n.ts 基建 + chrome 面 + spec 60）已随批次 971a5ae 落库；本轮按 V1 台账立案铺开，纯消费点 + 词条工作，零基建改动、零 Rust 改动。

## 覆盖面

- **组件面板内文**（11 文件）：add-host（主机表单全字段/错误/toast）、quick-connect、ssh-import、sftp-panel（浏览卡/传输队列抽屉/文件菜单）、blocks-panel、brief-card、conn-detail、collab-panel（审批/委托/任务目标/简报）、records-pane（时间线图表+筛选+保留期+导出）、monitor-view（大屏/卡片/NPU 行/空态）、agent-view（对话/Fleet/自主开关/委托条）。
- **App.tsx 长尾**：面板壳（tp-head/rb-rail）、端口转发面板全量、广播浮层、TOFU 指纹卡、双因素认证卡、主机/快速连接对话框头、断线横幅与 dead-overlay、接管停止结果卡、自主模式横幅、collab 徽标/ctl 徽标、搜索条、拖放上载提示、~70 条 toast、~27 条 title/aria-label、connError 全部、终端内联 ⚠ 写入、系统通知文案、窗口标题 fallback、collabStateText/sbLeft、fwdFieldErr 校验文案。
- **漏网两文件**：metrics.tsx（监控条）、window-controls.tsx（标题栏钮）；settings-panel 两处 aria-label。
- **时间列 locale**：sftp 面板日期 `toLocaleString("zh-CN")` → `dateLocale()`（localeNow 为 en 时用 en-US，月/日形态 5月3日→5/3）。
- **EN 表**：+656 词条（去重后 606+30 漏网补+20 收尾），总计 ~1219。

## 语义决定

- records 的 KIND_LABEL/STATUS_LABEL 沿用「数据表存原文、消费点包 t()」铁律（模块导入期禁 t()）。
- palette keywords（"重连 上次 会话 reconnect"）**不译**——搜索词表，英文词本就内嵌。
- agent 转写事件存进 state 的文案（argsLabel/失败块 md）按事件时刻翻译，历史消息不随 locale 回溯（与聊天记录同为"当时的记录"）。
- 「会话」键冲突再现：通知/详情的 host 兜底用 `t("该会话")`（V1 已定「会话」=Sessions 归命令面板组）。

## 坑 70-72

- **坑 70（TS2349 签名）**：`Type 'String' has no call signatures` = 局部 `t` 遮蔽 i18n t。本轮扫出 9 处：pasteTextInto(text 参数)、rerunCommand/locateBlock(cmd)、decideCollision/locateTransfer/openTransfer(card)、广播循环(bSid)、saveGoal(gv)、传输泵(tv)——改名收口；`pushToast("` 字符串本身含 `t("`，grep 过滤已包裹行不能用 `t\("`。
- **坑 71**：本地化函数返回值与 zh 字面量比较（`spanText === "积累中…"`) 在 en 下走错分支——比较目标也要 `t("积累中…")`。
- **坑 72**：批量替换脚本沿用「grep 全行内容作键 + 唯一匹配校验 + CRLF 自适应」打法，两批 92+57 对零误伤；搜索串必须从当前文件实况取（协作徽标两串凭记忆写错，脚本 MISS 列表兜住）。

## 验证

- tsc 0 错；i18n.ts 键 uniq -d 零重复。
- spec 60 扩到 16 断言（+文件面板 Remote files/空态、+命令块 No session.），16/16 绿。
- 全套 UI + vite build 见当日批次记录；Rust 零改动。

## 未覆盖（继续立案）

- demo.ts（演示域数据=用户数据语义，不译）；agent-mock.ts 脚本文案（演练数据）。
- xterm 内由远端数据驱动的面、README 截图、markdown 渲染内容。
- 设置面板内部仍有英文原文键（provider 类型等 aria 已补，纯英文原文本就无需翻译）。
