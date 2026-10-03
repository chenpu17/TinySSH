const { chromium } = require("playwright-core");

(async () => {
  const browser = await chromium.launch({
    executablePath: "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("http://localhost:5183", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: "/tmp/pv_gbk_00_home.png" });

  // 1) 打开「添加主机」表单
  await page.click('button[aria-label="添加主机"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/pv_gbk_01_form_default.png" });

  // 读取编码 select 默认值与选项文案
  const selInfo = await page.evaluate(() => {
    const sels = [...document.querySelectorAll(".add-host select")];
    return sels.map((s) => ({
      label: s.closest(".ah-field")?.querySelector("label")?.innerText,
      value: s.value,
      options: [...s.options].map((o) => ({ value: o.value, text: o.innerText })),
    }));
  });
  console.log("=== SELECTS (default form) ===");
  console.log(JSON.stringify(selInfo, null, 1));

  // 2) 新建一台 GBK 主机
  const fill = async (name, address, username) => {
    const fields = await page.$$(".add-host .ah-field");
    for (const f of fields) {
      const label = await f.$eval("label", (el) => el.innerText).catch(() => "");
      const input = await f.$("input");
      if (!input) continue;
      if (label.includes("名称")) await input.fill(name);
      else if (label.includes("地址")) await input.fill(address);
      else if (label.includes("用户名")) await input.fill(username);
    }
  };
  await fill("老财务机-GBK", "192.168.9.21", "administrator");
  // 密码（demo 里 upsert 需要 auth；密码模式默认）
  const pwd = await page.$('.add-host input[type="password"]');
  if (pwd) await pwd.fill("demo-pass-123");
  // 选 GBK
  await page.selectOption('.add-host .ah-field:has(label:text("远端编码")) select', "gbk");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/pv_gbk_02_form_gbk_selected.png" });
  await page.click('.add-host button:has-text("保存并连接")');
  await page.waitForTimeout(1200);
  // TOFU 首连指纹确认——真人操作：点「信任并连接」
  const tofu = page.locator('.hk-mask button:has-text("信任并连接")');
  if (await tofu.count()) {
    await page.screenshot({ path: "/tmp/pv_gbk_02b_tofu.png" });
    await tofu.click();
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: "/tmp/pv_gbk_03_after_save.png" });

  // 3) 打开该主机编辑表单：编码应回填 gbk
  const openEdit = async (name) => {
    const card = page.locator(".host-card", { hasText: name }).first();
    await card.hover();
    await page.waitForTimeout(300);
    await card.locator('button[title^="编辑主机"]').click();
    await page.waitForTimeout(400);
  };
  await openEdit("老财务机-GBK");
  await page.screenshot({ path: "/tmp/pv_gbk_04_edit_gbk.png" });
  const editVal1 = await page.evaluate(() => {
    const sel = document.querySelector('.add-host .ah-field:has(label) select:last-of-type');
    const all = [...document.querySelectorAll(".add-host select")].map((s) => ({
      label: s.closest(".ah-field")?.querySelector("label")?.innerText, value: s.value,
    }));
    return all;
  });
  console.log("=== EDIT FORM selects (expect charset=gbk) ===");
  console.log(JSON.stringify(editVal1, null, 1));

  // 4) 改回 UTF-8 保存，再进编辑
  await page.selectOption('.add-host .ah-field:has(label:text("远端编码")) select', "utf-8");
  await page.waitForTimeout(200);
  await page.click('.add-host button:has-text("保存修改")');
  await page.waitForTimeout(800);
  await openEdit("老财务机-GBK");
  await page.screenshot({ path: "/tmp/pv_gbk_05_edit_utf8.png" });
  const editVal2 = await page.evaluate(() =>
    [...document.querySelectorAll(".add-host select")].map((s) => ({
      label: s.closest(".ah-field")?.querySelector("label")?.innerText, value: s.value,
    }))
  );
  console.log("=== EDIT FORM selects after UTF-8 save (expect charset=utf-8) ===");
  console.log(JSON.stringify(editVal2, null, 1));
  // 关掉表单
  await page.click('button[aria-label="收起表单"]').catch(() => {});
  await page.waitForTimeout(300);

  // 5) 列表 GBK 辨识度：导出主机卡文本与 title
  const hostCards = await page.evaluate(() =>
    [...document.querySelectorAll(".host-card")].map((c) => ({
      text: c.innerText.replace(/\s+/g, " ").slice(0, 120),
      title: c.getAttribute("title"),
    }))
  );
  console.log("=== HOST CARDS ===");
  console.log(JSON.stringify(hostCards, null, 1));
  await page.screenshot({ path: "/tmp/pv_gbk_06_list.png" });

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
