// 36 P2-c：OSC 52 写剪贴板策略 + OSC 9 通知。查询（?）一律拒（连询问卡都不弹）；
// 写入三档——ask（默认）弹卡预览、allow 直写并 toast 告知、deny 静默吞；Esc=拒绝。
// OSC 9 走响铃闪烁通路（恒开）。注入走 __t_terms（dev 探针），剪贴板经 context 授权后断言。
const connect = async (page, name) => {
  const c = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  await c.hover();
  await page.waitForTimeout(250);
  await (await c.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1400);
};

module.exports = {
  title: "OSC 52 写剪贴板策略：查询恒拒 / ask 弹卡 / allow 直写 / deny 静默 / OSC 9 闪烁",
  async run({ page, ck }) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() => navigator.clipboard.writeText("seed"));
    const clip = () => page.evaluate(() => navigator.clipboard.readText());
    const inject = (payload) => page.evaluate((p) => {
      const terms = window.__t_terms;
      if (!terms) throw new Error("__t_terms probe missing (dev only)");
      const live = [...terms.values()].filter((t) => {
        const el = t.element;
        return !!el && el.isConnected && el.getBoundingClientRect().height > 0;
      });
      live[0].write("\x1b]52;c;" + p + "\x07");
    }, payload);
    const dialogOpen = () => page.evaluate(() => !!document.querySelector("[data-testid=osc52-dialog]"));

    await connect(page, "本机");

    // ── ask（默认）：弹卡带预览与会话名，未裁决不写 ──
    await inject(btoa("rm -rf /"));
    await page.waitForTimeout(400);
    ck.check("ask 默认策略：写入请求弹询问卡", await dialogOpen());
    const prev = await page.textContent("[data-testid=osc52-preview]");
    ck.check("询问卡预览展示解码内容", (prev ?? "").includes("rm -rf /"), prev ?? "");
    const dlgTxt = await page.evaluate(() => document.querySelector("[data-testid=osc52-dialog]")?.textContent ?? "");
    ck.check("询问卡标注来源会话（本机）", dlgTxt.includes("本机"), dlgTxt.slice(0, 60));
    ck.check("裁决前剪贴板未被改写", (await clip()) === "seed");

    // ── 拒绝：不写任何字节 ──
    await page.click("[data-testid=osc52-deny]");
    await page.waitForTimeout(300);
    ck.check("拒绝后卡关闭且剪贴板保持原值", !await dialogOpen() && (await clip()) === "seed");

    // ── Esc = 拒绝 ──
    await inject(btoa("second-try"));
    await page.waitForTimeout(400);
    ck.check("再次请求仍弹卡", await dialogOpen());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    ck.check("Esc 关卡=拒绝，剪贴板不变", !await dialogOpen() && (await clip()) === "seed");

    // ── 允许：写入 + toast 告知 ──
    await inject(btoa("rm -rf /"));
    await page.waitForTimeout(400);
    await page.click("[data-testid=osc52-allow]");
    await page.waitForTimeout(500);
    ck.check("允许后剪贴板被改写", (await clip()) === "rm -rf /");
    const toast = await page.evaluate(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent).join("|"));
    ck.check("写入后 toast 告知剪贴板被远端改写", toast.includes("远端已写入剪贴板（OSC 52）"), toast);

    // ── 查询（?）：连卡都不弹，一律拒绝 ──
    await inject("?");
    await page.waitForTimeout(400);
    ck.check("查询（读剪贴板）请求直接拒绝不弹卡", !await dialogOpen());

    // ── deny：静默吞 ──
    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    await page.click('[data-testid="settings-cat-terminal"]');
    await page.waitForTimeout(400);
    ck.check("设置卡有 OSC 52 策略下拉且默认 ask", await page.evaluate(() => document.querySelector('[data-testid="osc52-select"]')?.value === "ask"));
    await page.selectOption('[data-testid="osc52-select"]', "deny");
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('[data-testid="settings-close"]')?.click());
    await page.waitForTimeout(300);
    await inject(btoa("denied-payload"));
    await page.waitForTimeout(400);
    ck.check("deny 策略静默吞（无卡、剪贴板不变）", !await dialogOpen() && (await clip()) === "rm -rf /");

    // ── allow：直写 + toast，无卡 ──
    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    await page.selectOption('[data-testid="osc52-select"]', "allow");
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('[data-testid="settings-close"]')?.click());
    await page.waitForTimeout(300);
    await inject(btoa("hello52"));
    await page.waitForTimeout(500);
    ck.check("allow 策略直写不弹卡", !await dialogOpen() && (await clip()) === "hello52");
    ck.check("blob 持久化 osc52=allow",
      (await page.evaluate(() => JSON.parse(localStorage.getItem("ui.v2.workspace") ?? "{}").terminal?.osc52)) === "allow");

    // ── reload 后策略持久 ──
    await page.reload();
    await page.waitForTimeout(1500);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    await page.click('[data-testid="settings-cat-terminal"]');
    await page.waitForTimeout(400);
    ck.check("reload 后策略仍 allow", await page.evaluate(() => document.querySelector('[data-testid="osc52-select"]')?.value === "allow"));
    await page.selectOption('[data-testid="osc52-select"]', "ask");
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('[data-testid="settings-close"]')?.click());
    await page.waitForTimeout(300);

    // ── OSC 9：远端主动通知 → 标签闪烁（与 BEL 同通路，恒开）。
    // reload 后无会话——重连再注入，顺带覆盖「新终端实例同样注册了 OSC handler」 ──
    await connect(page, "本机");
    await page.evaluate(() => {
      const terms = window.__t_terms;
      const live = [...terms.values()].filter((t) => t.element && t.element.isConnected);
      live[0].write("\x1b]9;deploy done\x07");
    });
    await page.waitForTimeout(400);
    const flashing = await page.evaluate(() => document.querySelectorAll(".tab-bell").length);
    ck.check("OSC 9 触发标签闪烁", flashing >= 1, `flashing=${flashing}`);

    // ── 重连后的新实例：OSC 52 询问卡照常（handler 每实例注册）──
    await inject(btoa("fresh-instance"));
    await page.waitForTimeout(400);
    ck.check("重连后新实例 OSC 52 仍弹卡", await dialogOpen());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // 收尾：不留会话
    for (let i = 0; i < 3; i++) {
      const more = await page.evaluate(() => document.querySelectorAll(".tab").length);
      if (more === 0) break;
      await page.evaluate(() => {
        const tab = document.querySelector(".tab");
        tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 380, clientY: 130 }));
      });
      await page.waitForTimeout(350);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((x) => x.textContent.includes("关闭会话"));
        if (b) b.click();
      });
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
        if (b) b.click();
      });
      await page.waitForTimeout(900);
    }
  },
};
