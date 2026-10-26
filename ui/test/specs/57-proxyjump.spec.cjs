// 57 ProxyJump（FR-9）：主机表单「跳板机（可选）」下拉——候选排除自身/本机/成环；
// 保存后主机卡「跳板」徽章；连接时逐跳 TOFU 门序（跳板卡先挂且标注「第1跳·跳板机」，
// 信任后目标卡再挂，均批后会话建立）；跳板被引用时删除被拒（conn-error 横幅）；
// 编辑回显/清除跳板后可删；ssh_config 导入面板 ProxyJump 指令保持阻断（V1 fixture）。

module.exports = {
  title: "ProxyJump：表单跳板下拉、卡面徽章、逐跳 TOFU 门序、删除保护、config 导入阻断不回退",
  async run({ page, ck }) {
    const vis = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      return !!el && el.getClientRects().length > 0;
    }, sel);
    const hostCard = (name) => page.evaluate((n) => {
      const card = [...document.querySelectorAll(".hostbar .host-card")]
        .find((x) => x.querySelector(".host-name")?.textContent === n);
      if (!card) return null;
      return {
        jumpBadge: [...card.querySelectorAll(".auth-tag")].some((x) => x.textContent === "跳板"),
      };
    }, name);
    // 连接一门：hk-dialog 当前展示的标题/主机名/是否有跳板标注
    const hkCard = () => page.evaluate(() => {
      const dlg = document.querySelector(".hk-dialog");
      if (!dlg) return null;
      const b = dlg.querySelector("b");
      return { title: dlg.querySelector(".hk-title")?.textContent ?? "", host: b?.textContent ?? "" };
    });
    const hkDecide = async (accept) => {
      await page.evaluate((a) => {
        const dlg = document.querySelector(".hk-dialog");
        const btn = [...dlg.querySelectorAll("button")]
          .find((x) => a ? x.textContent.includes("信任") : x.textContent.includes("取消"));
        if (!btn) throw new Error("hk button not found");
        btn.click();
      }, accept);
    };

    // ── 表单：跳板下拉在场、候选排除「本机」──
    await page.click('button[aria-label="新建连接"]');
    await page.waitForSelector('[data-testid="add-host-dialog"]', { timeout: 5000 });
    ck.check("主机表单有「跳板机（可选）」下拉（jump-select）",
      await vis('[data-testid="jump-select"]'));
    const opts = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="jump-select"] option')]
        .map((o) => ({ v: o.value, t: o.textContent })));
    ck.check("跳板候选含既有主机 prod-1/staging-1、不含「本机」",
      opts.some((o) => o.t.includes("prod-1")) && opts.some((o) => o.t.includes("staging-1"))
      && !opts.some((o) => o.t.includes("本机")),
      JSON.stringify(opts.map((o) => o.t)));

    // ── 新建 jump-target（10.9.9.30，跳板=staging-1）→ 保存并连接 ──
    const fill = (idx, val) => page.evaluate(([i, v]) => {
      const inputs = document.querySelectorAll('[data-testid="add-host-dialog"] input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(inputs[i], v);
      inputs[i].dispatchEvent(new Event("input", { bubbles: true }));
    }, [idx, val]);
    await fill(0, "jump-target");
    await fill(1, "10.9.9.30");
    await fill(2, "22");
    await fill(3, "ops");
    // 密码（第 5 个输入框：密码表单）——名称/地址/端口/用户名之后
    await page.evaluate(() => {
      const inputs = document.querySelectorAll('[data-testid="add-host-dialog"] input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      const pw = [...inputs].find((x) => x.type === "password");
      setter.call(pw, "pw-demo");
      pw.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.evaluate(() => {
      const sel = document.querySelector('[data-testid="jump-select"]');
      const prod1 = [...sel.options].find((o) => o.textContent.includes("staging-1"));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(sel, prod1.value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('[data-testid="add-host-dialog"] button')]
        .find((x) => x.textContent.includes("保存并连接"));
      b.click();
    });
    // 表单对话框先关（onSaved 同步 setShowAddHost(false)），再等逐跳门
    await page.waitForSelector('[data-testid="add-host-dialog"]', { state: "detached", timeout: 5000 })
      .catch(() => {});

    // ── 逐跳 TOFU 门序：跳板卡（staging-1，第1跳标注）先挂 ──
    await page.waitForSelector(".hk-dialog", { timeout: 5000 });
    const hop = await hkCard();
    ck.check("先挂跳板指纹卡：标题标注「第1跳·跳板机」且主机名是 staging-1",
      hop && hop.title.includes("第1跳") && hop.title.includes("跳板机") && hop.host === "staging-1",
      JSON.stringify(hop));
    await hkDecide(true);
    // 第一张卡先闭，再等目标卡（防同框竞态）
    await page.waitForSelector(".hk-dialog", { state: "detached", timeout: 5000 });
    await page.waitForSelector(".hk-dialog", { timeout: 5000 });
    const tgt = await hkCard();
    ck.check("后挂目标指纹卡：无跳板标注、主机名 jump-target",
      tgt && !tgt.title.includes("跳板") && tgt.host === "jump-target",
      JSON.stringify(tgt));
    await hkDecide(true);
    // 等本会话的标签出现（.tab-label 一开始就存在——必须等 jump-target 自己的）
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".tab-label")].some((x) => x.textContent.includes("jump-target")),
      { timeout: 8000 }).catch(() => {});
    ck.check("两门齐批后 jump-target 会话建立（标签在场）",
      await page.evaluate(() =>
        [...document.querySelectorAll(".tab-label")].some((x) => x.textContent.includes("jump-target"))));
    ck.check("jump-target 主机卡显示「跳板」徽章", (await hostCard("jump-target"))?.jumpBadge === true);

    // ── 删除保护：staging-1 被 jump-target 引用 → 删除被拒 ──
    // （主机卡 hover 删除钮 → .confirm-dialog 确认 → conn-error 横幅点名引用）
    await page.evaluate(() => {
      const card = [...document.querySelectorAll(".hostbar .host-card")]
        .find((x) => x.querySelector(".host-name")?.textContent === "staging-1");
      card.querySelector(".host-del").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForSelector(".confirm-dialog", { timeout: 5000 });
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll(".confirm-dialog button")]
        .find((x) => x.textContent.includes("删除"));
      btn.click();
    });
    await page.waitForSelector(".conn-error", { timeout: 5000 }).catch(() => {});
    const delErr = await page.evaluate(() => document.querySelector(".conn-error")?.textContent ?? "");
    ck.check("删除被引用的跳板机被拒：横幅点名「跳板机正在被主机引用」",
      delErr.includes("跳板机正在被主机引用"), delErr.slice(0, 120));
    ck.check("staging-1 主机卡仍在（未落删除）", !!(await hostCard("staging-1")));

    // ── 编辑回显 + 清除跳板 → 徽章消失、staging-1 可删 ──
    await page.evaluate(() => {
      const card = [...document.querySelectorAll(".hostbar .host-card")]
        .find((x) => x.querySelector(".host-name")?.textContent === "jump-target");
      card.querySelector('button[title^="编辑主机"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForSelector('[data-testid="add-host-dialog"]', { timeout: 5000 });
    const picked = await page.evaluate(() => {
      const sel = document.querySelector('[data-testid="jump-select"]');
      return sel.options[sel.selectedIndex]?.textContent ?? "";
    });
    ck.check("编辑表单跳板下拉回显 staging-1", picked.includes("staging-1"), picked);
    await page.evaluate(() => {
      const sel = document.querySelector('[data-testid="jump-select"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(sel, "");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      const b = [...document.querySelectorAll('[data-testid="add-host-dialog"] button')]
        .find((x) => x.textContent.includes("保存修改"));
      b.click();
    });
    await page.waitForTimeout(600);
    ck.check("清除跳板保存后 jump-target 徽章消失", (await hostCard("jump-target"))?.jumpBadge === false);
    // staging-1 现在无引用者 → 删除走通
    await page.evaluate(() => {
      const card = [...document.querySelectorAll(".hostbar .host-card")]
        .find((x) => x.querySelector(".host-name")?.textContent === "staging-1");
      card.querySelector(".host-del").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForSelector(".confirm-dialog", { timeout: 5000 });
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll(".confirm-dialog button")]
        .find((x) => x.textContent.includes("删除"));
      btn.click();
    });
    await page.waitForTimeout(600);
    ck.check("解引用后 staging-1 删除成功（主机卡消失）", !(await hostCard("staging-1")));

    // ── config 导入面板：ProxyJump 指令保持阻断（V1 边界不回退）──
    await page.click('button[aria-label="新建连接"]');
    await page.waitForSelector('[data-testid="add-host-dialog"]', { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => {
      // 关掉表单对话框，打开导入面板（主机栏内按钮内容是图标，按 aria-label 定位）
      const close = [...document.querySelectorAll('[data-testid="add-host-dialog"] button')]
        .find((x) => x.textContent.includes("取消"));
      close?.click();
    });
    await page.waitForTimeout(300);
    await page.click('button[aria-label="导入 ~/.ssh/config"]');
    await page.waitForSelector(".hostbar .add-host .sshcfg-row", { timeout: 5000 }).catch(() => {});
    const blocked = await page.evaluate(() => {
      const row = [...document.querySelectorAll(".hostbar .add-host .sshcfg-row")]
        .find((x) => x.textContent.includes("bastion-jump"));
      const cb = row?.querySelector('input[type="checkbox"]');
      return { found: !!row, disabled: !!cb?.disabled };
    });
    ck.check("ssh_config 导入面板 bastion-jump（ProxyJump 指令）仍不可勾选导入",
      blocked.found && blocked.disabled, JSON.stringify(blocked));
  },
};
