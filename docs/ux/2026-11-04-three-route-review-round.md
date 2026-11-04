# 三路 subagent 审查轮：八轮未提交叠加批次（2026-11-04）

用户指令：「最近多个需求改动内容比较多，最好安排subagent多审核，并做好端到端验证与视觉验证。」对工作树里 8 个未提交轮次（tmux 面板 / Ctrl+B 拖拽布局 / 焦点 IME F5 / 重命名跟随 / 监控墙 / 墙键入+格子缩放 / 工具栏净化+新建 tmux 会话 / 26-keymap）做 A(Rust)/B(前端)/C(视觉) 三路串行审查，diff 规模 +4849/−509（Rust 1827 行、UI 1960 行、spec 63 单文件 +792）。

## 一、Findings 与处置（逐条亲核后修）

### A 路（Rust）— P0 ×1，P1 ×1，P2 ×2，P3 ×5

- **[P0] 改名跟随把远端可控会话名写进 `tmux_attached`，接通 `tmux_switch_client` 单引号裸插值 → shell 命令注入**。链路：远端把被主视图 attach 的会话改名成 `x'; touch /tmp/pwned; '`（tmux 合法名）→ 3s 探针 reconcile 原样写入 → 用户再 attach 别的会话 → `list-clients -t '{cur_sel}'` 注入。`clients[0]`（tmux 回包 client_name，同样远端可控）与 `capture-pane -t '{sel}:'`（清单名）也是同类口子。**修**：新增统一 `SessionManager::tmux_sq`（POSIX 单引号转义）+ `tmux_sh`（复合命令包 `sh -c`），替换全部 8 处裸插值（capture-pane×2 / list-clients / switch-client 双参数 / PTY attach 注入 / has-session / handle.rs display-message / handle.rs 格子 `tmux -u attach`）；attach 名进 PTY 明文命令同样 sq。**回归测试**：`tmux_sq_roundtrip_in_real_sh`——把恶意形名字经双层转义后交给**真实 sh** 执行 `printf %s`，断言逐字节还原原文（`x'; touch /tmp/pwned; '` 只能当字符串活着）。
- **[P1] 监控墙两条复合命令（POSIX for/case/$()）直落 login shell，fish/csh 用户整特性静默失效**（载荷缺 END → 每拍作废 → 永远空墙）。探针特意做成全平台零复合恰恰说明 fish 用户能拿到入口。**修**：`tmux_sh` 包裹墙抓取/墙输入/has-session 预检/new-session 创建四条复合串；单命令（探针/capture/display-message）不包。形状测试改「剥壳还原后与原 POSIX 串逐字一致」（`unwrap_sh_c` helper）。
- **[P2] 墙帧协议按远端 wc -c 的原始字节数切片，解析却在 from_utf8_lossy 之后的 String 上切——坏字节膨胀 U+FFFD 后帧界错位**。**修**：`tmux_exec_raw`（字节域）+ `parse_tmux_wall(&[u8])`，帧标记行 ASCII 解析、格内文本逐段 lossy；新增坏字节用例（0xFF/0xC3 断言成帧不错位）。
- **[P2] 引号/反斜杠是合法 tmux 名，但开格闸与 attach 闸按黑名单拒掉——改名跟随把这类名字写进愿望清单后，重建判 Fatal、格子无声蒸发**。**修**：`pane_open_inner` 与 `tmux_attach` 闸放宽到只拒控制字符（命令构造侧 sq 全覆盖后闸过严只会残废功能）；demo 镜像同步；`pane_quote_name_allowed` 新测试。
- **[P3]** 退避注释 0.5s/1s/2s 与实值 5s/10s/20s/40s 矛盾（勘误）；server_pid 死存储（删）；reconcile 恒真条件（删）；`tmux_session_create` 无审计（补 `tmux_session_create` 审计与 demo 对齐）；list-clients exec 失败吞成「有 0 个客户端接入」误导文案（区分通道失败=「连接不稳」与真 0 客户端）。

### B 路（前端）— P2 ×4，P3 ×4

- **[P2] 大屏键入键名前后端口径劈叉且静默吞**：前端 specialKeyOf 产 `C-[`、`M-.` 等，核心白名单一律拒 → catch 吞掉零反馈（对照面板格有内联报错）。**修**：specialKeyOf 与白名单同口径（C-[→Escape、C-@/C-Space→C-Space、Ctrl/Alt+其余标点不拦截）；核心白名单放行 `M-`+单可打印（readline M-. yank-last-arg 真实需求）；sendNow 失败给 2.5s 一次性提示（`.tw-err` role=alert）；demo 镜像补同款白名单。
- **[P2] demo `tmux_session_create` 写了核心没有的审计 / 状态门比核心严**——审计对账口径劈叉、错误面劈叉。**修**：核心补状态门（Disconnected/Closed→「会话未连接：请先重连再建 tmux 会话」）+ 补审计，demo 不动（镜像以核心为准收齐）。
- **[P2] spec 65「关屏即停拍」前置条件（重开后至少一拍完成）断言被丢弃可恒真**。**修**：pollAsync 结果落独立 ck.check。
- **[P3]** settings-panel 757 文案改了 EN 字典没跟（旧键死键→换新句+EN）；格子 OSC52 闭包钉建格时名（→现取 `paneTermsRef.get(`${sid}:${paneId}`).name`）；墙 tick 把新清单 zip 到旧回包（→fetchCells 返回**请求时配好键**的 [key, cell] 对，tick 只认键不按下标）；`.tw-screen` 死规则（删）。

### C 路（视觉）— P1 ×2，P2 ×1，P3 ×7

- **[P1] 快接钮 accent 样式被本轮新增的「工具栏钮统一」块静默全灭**（统一块 :is 容器+button.ghost = (0,3,1) > 快接钮 (0,2,0)；hover/ts-open 同败）——**本轮核心目标「tmux 显眼」从未渲染**，spec 64 只断言元素在场测不出。**修**：`.session-toolbar .st-tools > button.ghost.tmux-quick-btn` 提到 (0,4,1)，hover 加 :not(:disabled) 到 (0,6,1) 硬赢，不赌源序。
- **[P1] 墙快照 ANSI 16 基本色硬编码 VGA 暗底值**：SGR 37/97 白字（rgb(229,229,229)/rgb(255,255,255)）在 eink 亮面/浅色板底上对比 1:1 隐形；且与 xterm 终端两套色板。**修**：palette256 前 16 项返回 `var(--ansi-N)`（inline style 直接吃变量，16 族自动成立、与终端同源）；256 cube/灰阶保留直出。
- **[P2] `.tw-gsz` 规格钮按下态零视觉指示**（统一块只管工具栏容器）。**修**：`.tw-head button.ghost.ts-open` accent 实底规则。
- **[P3]** 作曲行输入矮 6px（补 min-height:28px）；「创建」被菜单统一块剥成纯灰字（并入 .tm-act accent 组）；快接菜单长会话名撑破菜单盒（quick-row 主项补 min-width:0+ellipsis）；tw-hint 双降对比（去 opacity）；tw-off 半透底压对比（78%→92%）；eink 补偿漏 `.sftp-tools`（并入）；tile-drop-hint 圆角 8px 对格子直角露尾巴（→2px）。

### 三路共同结论

状态机/并发修复（双回包、EOF 宽限、临界区、退避、纪元闸、二段式改名）质量扎实；问题集中在**名字/键名这类「显示数据」进命令与协议时的口径统一**（P0/P1 同源）与**新样式的特异度/主题变量纪律**（P1 同源）。

## 二、验证

- core-session：**189/189**（187 基线 + tmux_sq_roundtrip_in_real_sh + pane_quote_name_allowed；形状测试改剥壳还原断言；坏字节帧用例）。
- 全套 Rust workspace（修复后复跑）：**全绿 exit 0**（全 crate 0 failed；core-session 189/189 含两新测试）。
- release 重建（custom-protocol）✓（core-session 7 警告全为 records/vault 传递的依赖弃用，diff hunk 零新增）；WebView 运行时缓存清理（Local Storage 保留）+ 重启 PID 17160，netstat 验证零 5183 连接（嵌入资产生效）。
- tsc 0；npm build ✓；**UI 全套 1114/1114 一次全绿**（63=122、65 含新前置断言，57 本轮无 flake）。
- 视觉截图 8 张（demo 域，edge headless）：工具栏×2 板 / 快接菜单+作曲行 / 作曲错误 / 大屏 tokyo+eink 暗+eink 亮+sakura 暗 + **--ansi 变量运行时解析断言**（tokyo ansi-7=rgb(140,141,147)、eink 暗 ansi-7=rgb(140,138,133)、eink 亮 ansi-15=rgb(252,252,250)——全是主题值，无一命中 VGA 硬编码 rgb(229,229,229)）。目检结论：快接钮 accent 在 tokyo/eink 都真渲染（P1 修复实证）；作曲行高度齐平、「创建」accent 权重；错误红字 role=alert 在场；大屏四板全可读、规格钮 2×2 按下态可见。
- **截图揪出一个新问题并顺手修**：作曲行错误文案被 session-toolbar 的 nowrap 继承链顶出菜单右缘（长文案不折行）——`.tmux-create-err` 补 white-space:normal（C 路「长名溢出」的同根延伸，走查阶段才现形）。
- **eink 亮面的如实备注**：SGR 97 亮白 var(--ansi-15)=#fcfcfa 在纸白底上仍近不可读——这是终端主题语义（亮白=SGR 97 的字面义），xterm 真终端在同板同内容同样表现。修复目标=墙与终端**同源一致**（不再有独立于终端的暗底 VGA 硬编码），不是「亮白变可读」；后者属终端主题层设计。

## 三、教训

1. **审查轮的产出大头不是新 bug 数，是「自审盲区定位」**：P0 的注入面是我自己在这批轮次里亲手扩出来的（改名跟随引入新数据流没重审下游拼接面）——引入「远端可控数据流」时必须重扫它的一切下游消费点。
2. **同一轮新增的两个 CSS 块互相打架**（统一块 vs 快接钮 accent）：新增「高特异度统一规则」时必须扫一遍同 diff 里后续覆盖块，特异度账要当面算（(0,3,1) vs (0,2,0)）。
3. **终端语义色没有「硬编码」豁免**：ANSI 16 基本色也是主题数据，一旦画到随色板走的底色上就必须走 --ansi-N 变量。
4. **demo 镜像的缺口专门掩盖前后端口径劈叉**（键名白名单缺失让 spec 65 全绿）：镜像补齐=测试网眼补齐。
