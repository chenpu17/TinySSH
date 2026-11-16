# Android APK 发布（GitHub Release）

> 移动端 v1 只保 SSH + tmux，产物为 **aarch64 release APK**（侧载，不上架 Play）。
> CI 入口：`.github/workflows/release.yml` 的 `android` 作业；签名 Gradle 逻辑在
> [`src-tauri/gen/android/app/build.gradle.kts`](../src-tauri/gen/android/app/build.gradle.kts)。
> 桌面产物契约见 [release-single-binary.md](release-single-binary.md)。

## 产物契约

- 文件名 `TinySSH_<版本>_android_arm64.apk`，随其余 `dist-*` 产物进同一个 GitHub Release，
  并纳入 `SHA256SUMS.txt`。
- `applicationId = com.tinyssh.app`，`minSdk 24`（Android 7.0+），只含 arm64-v8a。
- 必须是 **release 签名** 包；CI 用 `apksigner verify --print-certs` 断言，并拒绝
  `CN=Android Debug` 证书。未签名包（`app-universal-release-unsigned.apk`）无法安装，
  绝不进 Release。
- 无自动更新：升级 = 下载新 APK 覆盖安装（同一签名、`versionCode` 递增）。
  签名一旦更换，旧包无法覆盖升级，必须先卸载（会清应用内数据）。
- R8 压缩开启（`isMinifyEnabled = true`）；JNI 反射入口靠
  `app/proguard-rules.pro` 显式 keep，改动反射调用点时同步补规则。

## Secrets / Variables（仓库 Settings → Secrets and variables → Actions）

| 名称 | 类型 | 说明 |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | Secret | release keystore（JKS/PKCS12）的单行 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | Secret | keystore 口令 |
| `ANDROID_KEY_ALIAS` | Secret | 密钥别名 |
| `ANDROID_KEY_PASSWORD` | Secret | 密钥口令 |
| `ANDROID_CERT_SHA256` | Variable（可选） | 证书 SHA-256 指纹，钉死签名身份；配置后 CI 校验 APK 证书指纹（大小写、冒号分隔均可） |

`secrets_probe` 作业先探 `ANDROID_KEYSTORE_BASE64`：**缺这一项就整段跳过 `android`
作业**（桌面 Release 照发）；其余三项在签名配置阶段缺失会让 `android` 作业红掉
（同样不阻断桌面 Release）。
证书与口令只存在于 GitHub Secrets、运行期 `$RUNNER_TEMP` 和 gitignored 的
`src-tauri/gen/android/key.properties`；作业结束的 `always()` 步骤全部删除。

## 本机生成 keystore（一次性）

证书和口令自己保管：**不入仓库、不进聊天、不写文档**。丢失 = 永远无法覆盖升级；
泄漏 = 他人可签你的更新。

```bash
keytool -genkeypair -v \
  -keystore tinyssh-release.jks \
  -alias tinyssh \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=TinySSH, O=TinySSH, C=CN"

# GitHub Secret 用的单行 base64
# macOS:
base64 -i tinyssh-release.jks | tr -d '\n'
# Linux:
base64 -w0 tinyssh-release.jks
```

离线备份 `.jks`。把输出整串贴进 `ANDROID_KEYSTORE_BASE64`。

## 本机构建/调试签名包

Gradle 的材料优先级：**环境变量 > `key.properties` > 无材料（unsigned）**。
`key.properties` 放在 `src-tauri/gen/android/`（已被 `.gitignore` 覆盖）：

```properties
storeFile=/absolute/path/to/tinyssh-release.jks
storePassword=****
keyAlias=tinyssh
keyPassword=****
```

Windows 路径注意：`.properties` 里 `\` 是转义符，写 `C:/keys/x.jks` 或 `C:\\keys\\x.jks`。
若口令含反斜杠、`#`、首尾空格或非 ASCII 字符，`.properties` 的转义与 ISO-8859-1 解码
可能改写口令——改用环境变量（CI 即走这条）更稳。也可用环境变量覆盖：
`TINYSSH_ANDROID_KEYSTORE` / `TINYSSH_ANDROID_KEYSTORE_PASSWORD` /
`TINYSSH_ANDROID_KEY_ALIAS` / `TINYSSH_ANDROID_KEY_PASSWORD`。

```bash
# release 是 tauri android build 的默认构建类型；-f mobile 必须显式
cargo tauri android build --target aarch64 --apk --ci -f mobile
```

没有材料时不回退 debug 证书（避免静默产出 debug 签名的 release 包），Gradle 直接产
unsigned APK。

## CI 触发与首跑演练

- `push` tag `v*`：`verify` → `build`（桌面三平台）与 `android` 并行 → `release`
  （`needs: build`，桌面构建成功即发布；`android` 跳过/失败都不阻断桌面 Release，
  APK 只是有则附上）。
- `workflow_dispatch`：只构建并上传 `dist-android` artifact；`release` 作业因非 tag
  跳过——用它做首跑演练。
- tag 与 `src-tauri/tauri.conf.json` 版本必须一致（三源同升），否则 `android` 作业
  在构建前失败。

首跑演练（配好 Secrets 后）：

1. Actions → release → Run workflow（分支选 `main`），等待 `android` 作业绿。
2. 下载 artifact `dist-android`，本机核对（`apksigner`/`aapt2` 在
   `$ANDROID_HOME/build-tools/<版本>/` 下）：
   ```bash
   apksigner verify --print-certs TinySSH_<VER>_android_arm64.apk
   aapt2 dump badging TinySSH_<VER>_android_arm64.apk | head -3
   ```
   确认证书 DN 不是 `CN=Android Debug`、`versionName` 与 conf 一致、
   `native-code: 'arm64-v8a'`。
3. 真机侧载冒烟（R8 首跑必做）：
   - 冷启动不闪退，欢迎页/主界面完整渲染；
   - 解锁 vault（主密钥读写正常）；
   - 新建 SSH 会话并输入命令（终端渲染 + 输入回显）；
   - 软键盘弹出/收起不白屏，IME inset 适配正常；
   - 系统返回键按栈：先关弹层/菜单，再退到上一级；
   - 长按标签/文件行/最近连接 → 右键语义菜单；
   - 覆盖安装（同签名新版）能升级，数据保留。
4. 演练绿后再打 `v*` tag 正式发布。

## 常见失败

| 现象 | 原因 / 处置 |
|---|---|
| `APK 未签名或签名无效` | Secrets 未配或 `storeFile` 路径错；本地则检查 `key.properties` |
| `keystore 口令或别名错误` | `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` 与生成时不一致 |
| `证书指纹与仓库变量 ANDROID_CERT_SHA256 不一致` | 换了签名密钥；确认是有意更换后再更新 Variable |
| `versionName != <VER>` | tag 与 `tauri.conf.json` / `ui/package.json` / 根 `Cargo.toml` 未同升 |
| 真机安装报「应用未安装」 | 旧包是不同签名（如 debug 签名），先卸载再装 |
| R8 首启崩溃 | 检查 JNI 反射入口是否被裁；在 `proguard-rules.pro` 补 `-keep` |
