# 原生冒烟工具（T40 起）

配合 `src-tauri/src/main.rs` 的 `TINYSSH_SMOKE` dev harness 使用（同 `TINYSSH_AUTOCONNECT` 模式，默认关闭）。

## 组件

- `ev.py` — CGEvent 注入（pyobjc Quartz）：`click/move/text/key`。屏幕绝对坐标（点）。宿主进程需具备辅助功能权限（T28 同通道）。
- `beacon.py` — 127.0.0.1:15199 进度信标 + 服务端延时：
  - `GET /t/<step>` 记录进度行到 `beacon.log`
  - `GET /w/<ms>` 服务端 sleep 指定毫秒（注入脚本的 sleep 原语——见下）

## 冒烟跑法（T40 密钥认证链）

```bash
# 1. 容器与密钥（一次性）
scripts/dev-sshd.sh                      # tinyssh-e2e @ 127.0.0.1:2222 root/testpass
ssh-keygen -t ed25519 -f /tmp/smoke_key -N ""
docker cp /tmp/smoke_key.pub tinyssh-e2e:/tmp/k && \
  docker exec tinyssh-e2e sh -c 'mkdir -p /root/.ssh && cat /tmp/k >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys'

# 2. 信标 + app（隔离 DB，避免污染真实 vault）
python3 scripts/native-smoke/beacon.py &
TINYSSH_DB=/tmp/smoke/tinyssh.db \
TINYSSH_MASTER_KEY=$(python3 -c "print('07'*32)") \
TINYSSH_SMOKE=1 TINYSSH_SMOKE_KEY=/tmp/smoke_key \
cargo tauri dev

# 3. 轮询 beacon.log 直到 DONE/FAIL（同时保持窗口前台——见坑③）

# 4. 终端验证：ev.py 点击终端区域后 text "whoami" + key 36（Return）
```

## 已知坑（T40 实测，2026-10-03）

1. **注入脚本的 timer 不可靠**：WKWebView 对 eval 注入脚本的 `setTimeout` 会节流/挂起（首 beacon 后静默死）。sleep 原语改走 beacon 服务端延时的 `fetch`——等待期间页面事件循环自由运转（React 可渲染），不依赖节流的 timer。
2. **page-load Finished 早于 React 挂载**：注入时 `querySelector` 查不到按钮（`?.click()` 空转）。脚本必须先轮询等待目标按钮出现再交互。
3. **窗口遮挡 + 位置漂移**：cargo tauri dev 每次重启窗口重新居中（坐标基线失效）；且被遮挡窗口的行为异常（点击落在叠在上面的窗口上——曾把浏览器 demo 页误当 app 驱动）。每次重启后用 AppleScript `set frontmost to true` + 重新截图标定；CGWindowList（Quartz）是窗口存在性/标题的权威来源，System Events 偶发枚举失败。
4. **坐标映射**：浏览器 demo 的 bbox ≠ 真机 WKWebView 布局（字体度量差异，实测偏差可达 ~100pt）。真机点击必须用真机截图标定。
5. **Rust `format!` 转义**：内嵌 JS 的 `{{`/`}}` 转义极易漏（曾漏一个 `)` 致整个脚本语法错误静默不执行）。生成脚本落盘 `/tmp/t40_smoke/last_smoke_script.js` 供 `node --check` 校验。
