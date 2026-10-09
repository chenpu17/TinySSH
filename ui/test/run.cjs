// R45：可重复运行的前端回归入口。
//
//   npm test --prefix ui                 # 跑全部 spec
//   npm test --prefix ui -- 03 05        # 只跑编号/名字里含 "03" 或 "05" 的 spec
//   TINYSSH_UI_BASE=http://localhost:5184 npm test --prefix ui   # 打别的基址（如旧 UI）
//   TINYSSH_UI_CHROME=/path/to/chrome npm test --prefix ui      # 指定浏览器
//
// 退出码：全部通过 0；有失败 1；环境问题（dev server 未起 / 找不到浏览器）2。
// 结果同时写到 test/result.json，便于归档进验收证据包。

const fs = require("fs");
const path = require("path");
const { preflight, BASE, runSpec } = require("./harness.cjs");
const { resolveBrowser } = require("./browser.cjs");

const SPEC_DIR = path.join(__dirname, "specs");
const RESULT_PATH = path.join(__dirname, "result.json");

async function main() {
  const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));

  let browser;
  try {
    browser = resolveBrowser();
  } catch (e) {
    console.error(`\n[环境] ${e.message}\n`);
    process.exit(2);
  }
  console.log(`基址      ${BASE}`);
  console.log(`浏览器    ${browser.path}\n          （来源：${browser.source}）\n`);

  try {
    await preflight();
  } catch (e) {
    console.error(`\n[环境] ${e.message}\n`);
    process.exit(2);
  }

  let files = fs
    .readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith(".spec.cjs"))
    .sort();
  if (filters.length) {
    files = files.filter((f) => filters.some((q) => f.includes(q)));
  }
  if (!files.length) {
    console.error(`没有匹配的 spec（过滤词：${filters.join(", ") || "无"}）`);
    process.exit(2);
  }

  const all = [];
  for (const f of files) {
    const spec = require(path.join(SPEC_DIR, f));
    console.log(`\n── ${f}  ${spec.title || ""}`);
    const r = await runSpec(f, spec.run);
    all.push({ file: f, ...r });
  }

  const checks = all.flatMap((s) => s.results);
  const failed = checks.filter((c) => !c.ok);
  const byFile = all.map((s) => ({
    file: s.file,
    passed: s.results.length - s.failed.length,
    failed: s.failed.length,
  }));

  console.log("\n════════ 汇总 ════════");
  for (const s of byFile) {
    console.log(`${s.failed ? "FAIL" : " ok "}  ${s.file.padEnd(30)} ${s.passed} passed, ${s.failed} failed`);
  }
  console.log(`\n合计 ${checks.length} 项断言，${checks.length - failed.length} 通过，${failed.length} 失败`);
  if (failed.length) {
    console.log("\n失败项：");
    for (const s of all) {
      for (const f of s.failed) console.log(`  [${s.file}] ${f.name}${f.detail ? `  — ${f.detail}` : ""}`);
    }
  }

  fs.writeFileSync(
    RESULT_PATH,
    JSON.stringify(
      {
        base: BASE,
        browser: browser.path,
        browserSource: browser.source,
        ranAt: new Date().toISOString(),
        total: checks.length,
        passed: checks.length - failed.length,
        failed: failed.length,
        specs: all.map((s) => ({ file: s.file, results: s.results })),
      },
      null,
      2,
    ),
  );
  console.log(`\n结果已写入 ${path.relative(process.cwd(), RESULT_PATH)}`);

  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("运行器异常：", e);
  process.exit(2);
});
