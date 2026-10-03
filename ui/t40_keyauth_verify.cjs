// T40（v1.38）FR-2 密钥认证收尾走查（浏览器 demo）：
//  1. 私钥模式三入口：从文件导入… / 生成新密钥（ed25519）/ 粘贴 + 「导入并确认指纹」
//  2. 绑定后出示指纹（PRD FR-2 指纹确认），保存只引用 identity_id
//  3. 无效粘贴被拦截；生成路径零输入即可绑定
//  4. demo upsert_host auth_type 修复：Key/Agent 主机卡片徽章正确（此前一律「密码」）
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const results = [];
  const check = (name, ok, detail = "") => { results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

  await page.goto("http://localhost:5183/", { waitUntil: "networkidle" });
  await page.waitForSelector(".host-card", { timeout: 8000 });

  // ── 1. 私钥模式三入口在场 ──
  await page.click('button[aria-label="添加主机"]');
  await page.waitForSelector(".add-host select");
  await page.selectOption(".add-host select >> nth=0", "key"); // 第一个 select = 认证方式
  check("key-mode-entries", (await page.$(".add-host label.file-btn")) !== null
    && (await page.$('.add-host button:has-text("生成新密钥（ed25519）")')) !== null
    && (await page.$('.add-host button:has-text("导入并确认指纹")')) !== null
    && (await page.$(".add-host textarea")) !== null,
    "file-btn / 生成 / 导入并确认 / textarea");

  // ── 2. 无效粘贴拦截 ──
  await page.fill(".add-host textarea", "这不是私钥");
  await page.click('.add-host button:has-text("导入并确认指纹")');
  check("invalid-pem-blocked", (await page.$('.add-host .err:has-text("请先粘贴")')) !== null);

  // ── 3. 从文件导入 → textarea 回填 → 导入并确认 → 指纹行 ──
  const fixture = path.join(__dirname, "t40_fixture_key.txt");
  fs.writeFileSync(fixture, "-----BEGIN OPENSSH PRIVATE KEY-----\nt40-demo-fixture-not-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n");
  try {
    await page.setInputFiles('.add-host label.file-btn input[type="file"]', fixture);
    // FileReader 回填是异步的——等值到位再断言
    await page.waitForFunction(() => ((document.querySelector(".add-host textarea") || {}).value ?? "").includes("PRIVATE KEY"), null, { timeout: 5000 });
    const pemFilled = await page.$eval(".add-host textarea", (el) => (el.value ?? "").includes("PRIVATE KEY"));
    check("file-import-fills-textarea", pemFilled);
    await page.click('.add-host button:has-text("导入并确认指纹")');
    await page.waitForSelector('.add-host .trust-row .fp', { timeout: 5000 });
    const fp = await page.$eval(".add-host .trust-row .fp", (el) => el.textContent ?? "");
    const label = await page.$eval(".add-host .trust-row .ok", (el) => el.textContent ?? "");
    check("fingerprint-shown", fp.includes("SHA256:"), `${fp.slice(0, 40)}…`);
    check("identity-label", label.includes("已加密存入凭据库"), label);
    check("textarea-hidden-after-bind", (await page.$(".add-host textarea")) === null);

    // ── 4. 保存 → Key 主机卡片徽章「密钥」（demo auth_type 修复的实证）──
    await page.fill('.add-host input[placeholder="例：我的服务器"]', "t40-key-导入");
    await page.fill('.add-host input[placeholder^="例：192"]', "10.0.0.40");
    await page.fill('.add-host input[placeholder="例：ops 或 root"]', "ops");
    await page.click('.add-host button:has-text("保存并连接")');
    await page.waitForSelector('.hk-dialog button:has-text("信任并连接")', { timeout: 8000 });
    await page.click('.hk-dialog button:has-text("信任并连接")');
    await page.waitForSelector('.host-card:has-text("t40-key-导入")', { timeout: 8000 });
    const badge1 = await page.$eval('.host-card:has-text("t40-key-导入") .auth-tag', (el) => el.textContent ?? "");
    check("key-host-badge", badge1.trim() === "密钥", `徽章=${JSON.stringify(badge1)}`);
  } finally {
    fs.rmSync(fixture, { force: true });
  }

  // ── 5. 生成路径：零输入绑定 → 指纹 → 保存 ──
  await page.click('button[aria-label="添加主机"]'); // 保存后表单收起，重新展开
  await page.waitForSelector(".add-host select");
  await page.selectOption(".add-host select >> nth=0", "key");
  await page.click('.add-host button:has-text("生成新密钥（ed25519）")');
  await page.waitForSelector('.add-host .trust-row .fp', { timeout: 5000 });
  const genFp = await page.$eval(".add-host .trust-row .fp", (el) => el.textContent ?? "");
  check("generate-binds-identity", genFp.includes("SHA256:"), genFp.slice(0, 40));
  await page.fill('.add-host input[placeholder="例：我的服务器"]', "t40-key-生成");
  await page.fill('.add-host input[placeholder^="例：192"]', "10.0.0.41");
  await page.fill('.add-host input[placeholder="例：ops 或 root"]', "ops");
  await page.click('.add-host button:has-text("保存并连接")');
  await page.waitForSelector('.hk-dialog button:has-text("信任并连接")', { timeout: 8000 });
  await page.click('.hk-dialog button:has-text("信任并连接")');
  await page.waitForSelector('.host-card:has-text("t40-key-生成")', { timeout: 8000 });
  const badge2 = await page.$eval('.host-card:has-text("t40-key-生成") .auth-tag', (el) => el.textContent ?? "");
  check("generated-host-badge-key", badge2.trim() === "密钥", `徽章=${JSON.stringify(badge2)}`);

  // ── 6. 未绑定直接保存被拦截 ──
  await page.click('button[aria-label="添加主机"]');
  await page.waitForSelector(".add-host select");
  await page.selectOption(".add-host select >> nth=0", "key");
  await page.fill('.add-host input[placeholder="例：我的服务器"]', "t40-未绑定");
  await page.fill('.add-host input[placeholder^="例：192"]', "10.0.0.42");
  await page.fill('.add-host input[placeholder="例：ops 或 root"]', "ops");
  await page.click('.add-host button:has-text("保存并连接")');
  check("save-blocked-without-identity", (await page.$('.add-host .err:has-text("请先")')) !== null);

  // ── 7. Agent 主机徽章（表单在步骤 6 保存被拦后仍开着，直接复用）──
  await page.selectOption(".add-host select >> nth=0", "agent");
  await page.fill('.add-host input[placeholder="例：我的服务器"]', "t40-agent");
  await page.fill('.add-host input[placeholder^="例：192"]', "10.0.0.43");
  await page.fill('.add-host input[placeholder="例：ops 或 root"]', "ops");
  await page.click('.add-host button:has-text("保存并连接")');
  await page.waitForSelector('.hk-dialog button:has-text("信任并连接")', { timeout: 8000 });
  await page.click('.hk-dialog button:has-text("信任并连接")');
  await page.waitForSelector('.host-card:has-text("t40-agent")', { timeout: 8000 });
  const badge3 = await page.$eval('.host-card:has-text("t40-agent") .auth-tag', (el) => el.textContent ?? "");
  check("agent-host-badge", badge3.trim() === "Agent", `徽章=${JSON.stringify(badge3)}`);

  await page.screenshot({ path: "../docs/acceptance/screenshots/t40_key_flow.png", fullPage: false });
  console.log(results.join("\n"));
  const fails = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - fails} PASS / ${fails} FAIL`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("WALKTHROUGH ERROR:", e.message); process.exit(1); });
