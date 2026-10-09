// R45：浏览器可执行文件解析。
//
// 旧散落脚本各自写死 `/Users/<某人>/Library/Caches/ms-playwright/...` 与
// `/Applications/Google Chrome.app/...`——换机器、换用户、换 Playwright 版本即失效，
// 且把个人路径带进了仓库。这里改为**按优先级发现**，不含任何个人绝对路径：
//
//   1. 环境变量 `TINYSSH_UI_CHROME`（显式覆盖，CI/本机指定用）
//   2. Playwright 浏览器缓存目录扫描（取版本号最大的一个）
//   3. PATH 上的常见可执行名 / macOS 系统 Chrome 安装位置
//
// 注意：**不要**依赖 `playwright-core` 自带的默认解析。仓库里 vendored 的
// playwright-core 版本与缓存里的浏览器 revision 未必一致（实测 alpha 版本找
// `chromium_headless_shell-1186`，而缓存是 `-1243`），默认解析会直接报
// "Executable doesn't exist"。发现式解析对版本漂移免疫。

const fs = require("fs");
const os = require("os");
const path = require("path");

/** 缓存根目录（按平台）。 */
function cacheRoots() {
  const home = os.homedir();
  const roots = [];
  if (process.platform === "darwin") roots.push(path.join(home, "Library", "Caches", "ms-playwright"));
  else roots.push(path.join(home, ".cache", "ms-playwright"));
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.unshift(process.env.PLAYWRIGHT_BROWSERS_PATH);
  return roots;
}

/** `chromium-1243` → 1243；取不到给 -1。 */
function revision(dirName) {
  const m = /-(\d+)$/.exec(dirName);
  return m ? Number(m[1]) : -1;
}

/** 一个 chromium-<rev> 目录里的可执行文件（按平台）。 */
function chromiumBinary(dir) {
  const cands =
    process.platform === "darwin"
      ? [
          "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
          "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        ]
      : [
          "chrome-linux/chrome",
          "chrome-linux64/chrome",
          "chrome-linux/headless_shell",
        ];
  for (const c of cands) {
    const p = path.join(dir, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 一个 chromium_headless_shell-<rev> 目录里的可执行文件。 */
function headlessShellBinary(dir) {
  const cands =
    process.platform === "darwin"
      ? [
          "chrome-headless-shell-mac-arm64/chrome-headless-shell",
          "chrome-headless-shell-mac-x64/chrome-headless-shell",
        ]
      : ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell"];
  for (const c of cands) {
    const p = path.join(dir, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 扫描缓存，返回 { full, shell }——各自取 revision 最大者。 */
function scanCache() {
  const found = { full: null, shell: null, fullRev: -1, shellRev: -1 };
  for (const root of cacheRoots()) {
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = path.join(root, name);
      let isDir = false;
      try {
        isDir = fs.statSync(dir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const rev = revision(name);
      if (name.startsWith("chromium_headless_shell-")) {
        const bin = headlessShellBinary(dir);
        if (bin && rev > found.shellRev) {
          found.shell = bin;
          found.shellRev = rev;
        }
      } else if (name.startsWith("chromium-")) {
        const bin = chromiumBinary(dir);
        if (bin && rev > found.fullRev) {
          found.full = bin;
          found.fullRev = rev;
        }
      }
    }
  }
  return found;
}

/** PATH 上的常见名字 + macOS 系统安装位置。 */
function fromPath() {
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const n of names) {
    for (const d of dirs) {
      const p = path.join(d, n);
      if (fs.existsSync(p)) return p;
    }
  }
  if (process.platform === "darwin") {
    for (const app of [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]) {
      if (fs.existsSync(app)) return app;
    }
  }
  return null;
}

/**
 * 解析可执行文件路径。全部失败时抛错，报文列出试过的位置与补救办法
 * （而不是让 playwright 抛一句 "Executable doesn't exist"）。
 */
function resolveBrowser() {
  const env = process.env.TINYSSH_UI_CHROME;
  if (env) {
    if (!fs.existsSync(env)) {
      throw new Error(`TINYSSH_UI_CHROME 指向的文件不存在：${env}`);
    }
    return { path: env, source: "env:TINYSSH_UI_CHROME" };
  }
  const cache = scanCache();
  if (cache.full) return { path: cache.full, source: `ms-playwright chromium-${cache.fullRev}` };
  if (cache.shell) return { path: cache.shell, source: `ms-playwright headless_shell-${cache.shellRev}` };
  const p = fromPath();
  if (p) return { path: p, source: "PATH/系统安装" };
  throw new Error(
    [
      "找不到 Chromium 可执行文件。试过：",
      `  1. $TINYSSH_UI_CHROME（未设置）`,
      `  2. 缓存目录：${cacheRoots().join(" / ")}（无 chromium-* 或 chromium_headless_shell-*）`,
      "  3. PATH 上的 google-chrome / chromium / chromium-browser，以及 macOS /Applications",
      "补救：设置 TINYSSH_UI_CHROME=/path/to/chrome，或跑 `npx playwright install chromium`。",
    ].join("\n"),
  );
}

module.exports = { resolveBrowser, cacheRoots };
