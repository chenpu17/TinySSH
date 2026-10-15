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
- **UI specs 前冻结代码**：HMR 时序抖动会产生假红；套件红先单跑该 spec 复核（15-goal H1 是已知满载假红）。
- **core-session 单独成档**（tier2/3）：core_local 13 测试全并行且 PTY 重，混入全仓并行档被挤占时 spawn 时序崩、agent 动作级联进 120s 审批门（实测 1082s 假红、安静时 6.7s 绿）——单独跑 + `--test-threads=4`；残余噪声由两跑仲裁兜底（单跑/复跑绿=假红放行，两跑红=真红拦截）。
- 无 docker 时 e2e 用例自动 skip（env 门早退，core_local 余 2 例需 sshd 容器）。

## Provider 映射

- [.github/workflows/ci.yml](../../.github/workflows/ci.yml)：GitHub Actions 翻译（push→tier1；PR/手动→tier2；手动 tier=3→tier3）。**如实登记**：仓库现托管 gitee，Actions 未在真实 runner 实证；镜像到 GitHub 后首跑需核对（playwright chromium 路径、npm ci 与 ui/package-lock 同步）。
- Gitee Go 如启用，按 run.sh 同档位翻译即可。

## blame 归一

rustfmt 一次性归一提交（见 [.git-blame-ignore-revs](../../.git-blame-ignore-revs)）不计入 blame：
`git config blame.ignoreRevsFile .git-blame-ignore-revs`
