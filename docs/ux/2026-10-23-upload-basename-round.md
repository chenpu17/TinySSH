# 上传文件名带 Windows 全路径（pathBasename 单点修复）

日期：2026-10-23 ｜ 基线：3f0318d（v0.10.4）｜ 状态：已修，随 v0.10.5 发布（2026-10-29）

## 现象

用户实测：上传文件后，远端落盘的文件名是 Windows 全路径——
`/var/log/nginx/archive/C:\Users\demo\Desktop\report.docx` 这样一个名字里带盘符与反斜杠的文件。

## 根因

`ui/src/app-data.ts` 的共享 helper：

```ts
export const pathBasename = (p: string): string => p.split("/").filter(Boolean).pop() ?? "file";
```

只切 `/`。Windows 下拖拽与文件选择器（Tauri dialog / webview drop）给的是
`C:\Users\demo\Desktop\report.docx` 全反斜杠路径，切不出 basename → `name` 就是整个全路径 →
`startUploads` 拼出 `remote = ${cwd}/${name}`，SFTP 端把整串当合法文件名落盘（POSIX 里 `\` 是普通字符）。

## 修复（单点）

```ts
export const pathBasename = (p: string): string => p.split(/[\\/]+/).filter(Boolean).pop() ?? "file";
```

POSIX/Windows 双分隔符（`+` 折叠连续分隔符，UNC `\\server\share\f` 同样正确）。
一处修复覆盖全部 5 个调用点：

| 调用点 | 影响 |
| --- | --- |
| App.tsx startUploads 上传名 → remote 拼接 | **本 bug 主现场**（拖窗/拖面板/上传按钮三入口同一函数） |
| App.tsx 拖拽确认卡文件列表 | 顺带修好（原来显示全路径列表） |
| App.tsx 传输卡显示名（Upload 源/Download 目标） | 顺带修好（Windows 本地路径原来也显示全名） |
| App.tsx 下载名（远端 POSIX 路径） | 无行为变化 |
| App.tsx 批量下载目录拼接（远端路径） | 无行为变化 |

Rust 侧核实：core-session 上传的远端名完全取自前端传的 `remote` 参数；下载本地分支用
`std::path::Path::file_name()`（Windows 原生解析反斜杠）——后端无同类问题，不动。

## 回归

- spec 05（文件面板属主）末尾新增 3 断言：`demo_pick_result` 预置
  `["C:\\Users\\demo\\Desktop\\report.docx", "/var/tmp/posix.txt"]` → 点上传按钮 →
  卡片名 === basename、remote = 浏览目录/basename 且不含反斜杠、POSIX 路径照常。
- **红绿验证**：stash 掉修复跑旧码，2 断言红，失败详情正是用户报的现象
  （remote=「/var/log/nginx/archive/C:\Users\demo\Desktop\report.docx」）；恢复修复 28/28 绿。
- 相关 spec 02/25/31 单跑绿（80/80）；全套 UI **845/845**（版本升 0.10.5 后 spec 09 版本断言同步）。
- 真实域行为未实测远端落盘名（demo 域断言的是前端拼的 remote 字符串；真实 SFTP
  端只是原样落盘该参数，无第二处派生）。

## 教训

- 跨平台路径 helper 的分隔符必须双认；「演示域 fixtures 全是 POSIX 路径」的测试面
  天然盖不住 Windows 输入——新断言特意混入 `C:\` 风格桩。
