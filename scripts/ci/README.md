# CI 三档

档位定义以 [run.sh](run.sh) 为准（唯一事实源），任何 CI provider 都只是它的搬运：

| 档 | 命令 | 内容 | 时机 |
|---|---|---|---|
| 1 快门 | `scripts/ci/run.sh 1` | `cargo fmt --check` + `clippy`（报告不设门）+ 单元测试（lib+bins）+ `tsc` | 每次提交，目标 <5min |
| 2 集成门 | `scripts/ci/run.sh 2` | 快门 + cargo 全量测试 + UI specs 全量（自动复用/拉起 5183 dev server） | PR / 每日 |
| 3 e2e 门 | `scripts/ci/run.sh 3` | 集成门 + `TINYSSH_E2E_SSHD=1` 全量（[dev-sshd.sh](../dev-sshd.sh) 起 sshd 容器） | 发布前 |

## 环境约定

- **cargo 必须 `-j 4`**：默认并行会页面文件耗尽（os error 1455 假性编译错）。
- **UI specs 需 `TINYSSH_UI_CHROME`** 指向 Edge/Chrome；脚本会自动探测本机 Edge。
- **CI 的浏览器版本钉在 vendored `playwright-core`**（install 时读其 version）：不钉会随 `npx` 拿到最新 Chrome，计算样式断言的序列化随版本漂移（Chrome 159 把 flex 容器的 `justify-content: flex-end` 序列化成 `flow-end`，布局不变）；spec 里已按同义拼写放宽，升级 `playwright-core` 后仍需复核。
- **UI specs 前冻结代码**：HMR 时序抖动会产生假红；套件红先单跑该 spec 复核（15-goal H1 是已知满载假红）。
- **core-session 单独成档**（tier2/3）：core_local 13 测试全并行且 PTY 重，混入全仓并行档被挤占时 spawn 时序崩、agent 动作级联进 120s 审批门（实测 1082s 假红、安静时 6.7s 绿）——单独跑 + `--test-threads=4`；残余噪声由两跑仲裁兜底（单跑/复跑绿=假红放行，两跑红=真红拦截）。
- 无 docker 时 e2e 用例自动 skip（env 门早退，core_local 余 2 例需 sshd 容器）。
- **自跳 e2e 在 docker 下的夹具约定**：跳板与目标都用 `127.0.0.1:2222` 这一个契约地址，而 direct-tcpip 的目标在**容器内**解析——所以容器里起了两个 sshd：22（宿主 2222 映射过来的入口，转发 e2e 读它的 banner）与 2222（给容器内的 direct-tcpip 当目标），同配置、同主机密钥。改 `dev-sshd.sh` 时别把第二个实例删掉，否则自跳用例（`core_jump.rs`）的目标指纹门永远不出现（KI-142 首跑实锤）。
- **e2e 里走外部 MCP Agent 的夹具有四条要知道的**（KI-145 首跑实锤；前三条按代码走查，这三条 Agent 侧用例自 2026-10-09 协作默认关闭起就不可能通过）：① 新装默认关闭协作，`SessionManager::open` 开全新库的测试栈里外部 Agent 在 `admit_agent` 就被拒、审批卡不会出现——先 `m.collab_enable(&Actor::Human)`（`protocol.rs`、`e2e_acceptance.rs` 的 `spawn_stack`）；② 人类建的会话默认归人类所有，Agent 要在会话里动作先 `delegate_session`（或由 Agent 建会话）；③ `create_session` 不等集成（注入后台化），读屏类断言先等集成态 Ready，再等片段末尾的清屏把回显抹掉；④ Agent 在重确认期只有 `exec` 的白名单核实命令（`pwd` 等）放行、成功即退出重确认，`send_keys` / 传输 / 转发一律 `reconfirming_pending`；Connected 下提交、等审批期间才进入重确认的动作即使已批准也作废——两半各有一条回归护栏（`core-session` 的 `r26_tests::agent_*`），改 `exec_inner` 的复核前先看。
- **Android 16 KB 门默认不跑**：设 `TINYSSH_ANDROID_APK=1`（扫默认产物：`target/aarch64-linux-android/debug/libtinyssh_app_lib.so` + `src-tauri/gen/android/app/build/outputs/apk/**/*.apk`）或 `TINYSSH_ANDROID_APK=<apk/目录路径>` 时，[run.sh](run.sh) 额外调用 [check-android-16kb.sh](check-android-16kb.sh)（ELF `PT_LOAD` Align=0x4000 + APK 内 .so STORED/16384 偏移，KI-057 的固化验收）。
- **Android CI job 已在真实 runner 实证**（2026-11-24 首跑，run 45323336371；KI-109 / KI-115）：`ci.yml` 的 android 档（PR/手动）与 `gradle-wrapper.properties` 的腾讯镜像均跑通，原「首次运行未实证」的登记作废；未配置 release 签名，只产 debug APK。该档在 APK 构建与 16 KB 门之后还会跑 `./gradlew :app:lintUniversalDebug`（lint error 级即红，失败时上传 `lint-results-universalDebug.*`）。
- **Android release APK**（tag 发布、签名 Secrets、首跑演练与真机冒烟）见 [docs/release-android.md](../../docs/release-android.md)。

## Provider 映射

- [.github/workflows/ci.yml](../../.github/workflows/ci.yml)：GitHub Actions 翻译（push→tier1 + windows；PR/手动→加跑 tier2 + android；手动 `tier=3`→再加 tier3）。**实证状态**：tier1 / windows / UI specs / android 四档已在真实 runner 跑绿（run 45917062264、45931469527）；e2e 档（tier3）此前因触发条件读错上下文恒被跳过（KI-140），修正后手动 `tier=3` 首跑（run 45931469527）已进入运行——容器起得来、用例没被 env 门跳过，但档本身红在测试夹具（KI-142：自跳夹具在 docker 下不成立、跳板首连的指纹卡无人应答）；修复后复跑（run 45988382811）`core_jump` 已绿，`--no-fail-fast` 又带出 `mcp-server` 的 `e2e_acceptance` 四条（KI-145：测试栈没开协作、读屏竞态，另有一处产品回归——重确认期 Agent 的白名单核实被 `exec_inner` 的「开始前复核现场」误拦），修复待推送后再次复跑实证。这一档的 `cargo test` 带 `--no-fail-fast`：默认在第一个红的测试二进制处收工，后面的 e2e 二进制一个不跑，一次几十分钟的派发只看得到一个红点。只有 `main` 的 push 与 PR 会自动触发；验证功能分支用 `gh workflow run ci.yml --ref <分支> -f tier=2`（或 `3`）手动触发；取某个 job 的完整日志在本机要走 `gh api repos/chenpu17/TinySSH/actions/jobs/<job-id>/logs`（`gh run view --job --log` 不出内容）。
- Gitee Go 如启用，按 run.sh 同档位翻译即可。

## blame 归一

rustfmt 一次性归一提交（见 [.git-blame-ignore-revs](../../.git-blame-ignore-revs)）不计入 blame：
`git config blame.ignoreRevsFile .git-blame-ignore-revs`
