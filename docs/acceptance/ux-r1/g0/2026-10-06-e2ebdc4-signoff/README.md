# G0 受托签署补充证据

日期：2026-10-06。输入 HEAD：`e2ebdc4401e6828bb00eb1dc75826a6707262146`。阶段决定见[签署单](../../../../ux/ux-r1-g0/g0-signoff.md)。原始团队证据仍在相邻 `2026-10-06-7c4502e` 目录。

- `memsample_probe.py` / `memsample-probe.json`：mock 进程数据调用实际采样函数，不查询系统进程、不启动应用、不注入输入。输出为缺陷观察，退出 0 仅说明探针完成，不表示采样器验收通过。RSS 算术分支仅在探针内归一 JSON PID，未修改生产脚本。
- `prototype_probe.cjs` / `prototype-probe.json`：隔离 headless Chrome、本地 HTML、页面上下文输入，检查窄窗返回、分屏目标、搜索；记录未知结果交互仍未获批准。首版探针误将工具栏显示假设为主机别名，实际为 user@address，已修正断言并重跑通过；未为测试修改原型。
- `terminal-search.png`：本次搜索无结果态截图，主审已查看。不是全面视觉或真人验收。
- `document-checks.json`：修改文档的本地链接、代码围栏及 diff 空白检查；不替代契约运行验证。
- `manifest.json`：输入 HEAD 的关键文件摘要与本次修改/新增文件摘要。清单本身不自哈希；任何后续变更须另记版本，不能继续声称与该摘要相同。

从仓库根目录重跑（输出到临时目录，保留已归档证据）：

```sh
python3 docs/acceptance/ux-r1/g0/2026-10-06-e2ebdc4-signoff/memsample_probe.py --out /tmp/tinyssh-memsample-recheck.json
node docs/acceptance/ux-r1/g0/2026-10-06-e2ebdc4-signoff/prototype_probe.cjs /tmp/tinyssh-prototype-recheck
```

Playwright/Chrome 路径沿用本机审核环境，异机重跑需配置实际安装路径。本次无原生输入、真实性能复测、产品代码修改或发布操作。
