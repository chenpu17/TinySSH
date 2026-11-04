// 26 键位配置轮：设置 → 快捷键——动作行渲染、默认绑定展示、录入流（Esc 取消 /
// 改绑生效 / 冲突拒绝）、localStorage 持久化跨 reload、单条重置。resolveAction 的
// 键位表解析与豁免推导由单测（keymap-cfg/shortcuts-keys）覆盖；此处断言 UI 面。
// 本地终端一等公民轮起七个动作（term-local 默认 Ctrl+Shift+T）。
// tmux 前缀优先（2026-11-02）：Win/Linux 主机栏默认 Ctrl+Shift+B、Ctrl+B 录入被拒、
// 存量旧表里的 Ctrl+B 载入迁移（mac 仍 ⌘B，三条断言按平台取期望值）。
// 审查轮二：单条重置撞键拒绝、两遍解析（冲突按终态判）、载入撞键一次性告知并回写、
// 直发层豁免路由（DEV 钩子 __t_keymapExempt 让 demo 走 Tauri-only 分支，真键盘按键）。
// 平台中立：主修饰键在 mac 是 ⌘(metaKey)、Win/Linux 是 Ctrl——展示文案与录入
// 派发的修饰键都按运行平台取（UI 的 formatBinding 同源判定）
const isMac = (page) => page.evaluate(() => /mac/i.test(navigator.platform));
const pressCombo = (page, b) => page.evaluate(({ key, code, ctrlKey, shiftKey, altKey, metaKey }) => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, code, ctrlKey, shiftKey, altKey, metaKey: !!metaKey, bubbles: true, cancelable: true }));
}, b);
const keyTextOf = (page, id) => page.evaluate((t) => {
  const e = document.querySelector(`[data-testid="keymap-key-${t}"]`);
  return e ? e.textContent.trim() : "";
}, id);

module.exports = {
  title: "键位配置：设置分区、录入流、冲突拒绝、持久化、重置",
  async run({ page, ck }) {
    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    await page.click('[data-testid="settings-cat-keys"]');
    await page.waitForTimeout(400);

    const mac = await isMac(page);
    const MOD = mac ? { metaKey: true } : { ctrlKey: true };   // 主修饰键
    const fmt = (k, mods = {}) => mac                 // 期望展示文案
      ? `⌘${mods.shift ? "⇧" : ""}${k.toUpperCase()}` : `Ctrl+${mods.shift ? "Shift+" : ""}${k.toUpperCase()}`;
    for (const id of ["tab-new", "tab-close", "term-local", "split-toggle", "palette", "hostbar", "search"]) {
      ck.check(`绑定行在场：${id}`, await page.evaluate((t) => !!document.querySelector(`[data-testid="keymap-row-${t}"]`), id));
    }
    ck.check(`默认绑定展示（search=${fmt("f")}）`, (await keyTextOf(page, "search")) === fmt("f"), await keyTextOf(page, "search"));
    ck.check(`默认绑定展示（term-local=${fmt("t", { shift: true })}）`, (await keyTextOf(page, "term-local")) === fmt("t", { shift: true }), await keyTextOf(page, "term-local"));
    const HB = fmt("b", { shift: !mac });
    ck.check(`默认绑定展示（hostbar=${HB}）`, (await keyTextOf(page, "hostbar")) === HB, await keyTextOf(page, "hostbar"));
    ck.check("重置钮默认禁用（已是默认值）", await page.evaluate(() => document.querySelector('[data-testid="keymap-reset-search"]').disabled), "");

    // 录入流：Esc 取消
    await page.click('[data-testid="keymap-edit-search"]');
    await page.waitForTimeout(200);
    ck.check("录入态提示（按下新组合…）", (await keyTextOf(page, "search")) === "按下新组合…");
    await pressCombo(page, { key: "Escape", code: "Escape", ctrlKey: false, shiftKey: false, altKey: false });
    await page.waitForTimeout(200);
    ck.check("Esc 取消录入回到原绑定", (await keyTextOf(page, "search")) === fmt("f"), await keyTextOf(page, "search"));

    // 录入流：改绑 search → Ctrl+J，持久化落 localStorage
    await page.click('[data-testid="keymap-edit-search"]');
    await page.waitForTimeout(200);
    await pressCombo(page, { key: "j", code: "KeyJ", ctrlKey: false, shiftKey: false, altKey: false, ...MOD });
    await page.waitForTimeout(300);
    ck.check(`改绑生效（search=${fmt("j")}）`, (await keyTextOf(page, "search")) === fmt("j"), await keyTextOf(page, "search"));
    const stored = await page.evaluate(() => localStorage.getItem("ui.keymap.v1") ?? "");
    ck.check("键位表持久化（KV 串含 search:j）", stored.includes('"search"') && stored.includes('"j"'), stored);

    // 冲突拒绝：hostbar 改绑 Ctrl+J → toast 报冲突，绑定不变
    await page.click('[data-testid="keymap-edit-hostbar"]');
    await page.waitForTimeout(200);
    await pressCombo(page, { key: "j", code: "KeyJ", ctrlKey: false, shiftKey: false, altKey: false, ...MOD });
    await page.waitForTimeout(300);
    ck.check("冲突拒绝（toast 报冲突）", await page.evaluate(() => {
      const t = document.querySelector(".toast.err");
      return !!t && t.textContent.includes("冲突");
    }));
    // 冲突后保持录入态（用户可直接试别的组合）——Esc 退出后再验绑定未变
    await pressCombo(page, { key: "Escape", code: "Escape", ctrlKey: false, shiftKey: false, altKey: false });
    await page.waitForTimeout(200);
    ck.check(`冲突后 hostbar 保持 ${HB}`, (await keyTextOf(page, "hostbar")) === HB, await keyTextOf(page, "hostbar"));

    // 终端保留键：Win/Linux 录 Ctrl+B 被拒（tmux 前缀），保持录入态，Esc 后绑定不变
    if (!mac) {
      await page.click('[data-testid="keymap-edit-hostbar"]');
      await page.waitForTimeout(200);
      await pressCombo(page, { key: "b", code: "KeyB", ctrlKey: true, shiftKey: false, altKey: false });
      await page.waitForTimeout(300);
      ck.check("录 Ctrl+B 被拒（留给终端的 tmux 前缀键）", await page.evaluate(() =>
        [...document.querySelectorAll(".toast.err")].some((t) => t.textContent.includes("留给终端"))));
      ck.check("拒收后仍在录入态", (await keyTextOf(page, "hostbar")) === "按下新组合…", await keyTextOf(page, "hostbar"));
      await pressCombo(page, { key: "Escape", code: "Escape", ctrlKey: false, shiftKey: false, altKey: false });
      await page.waitForTimeout(200);
      ck.check(`拒收后 hostbar 仍 ${HB}`, (await keyTextOf(page, "hostbar")) === HB, await keyTextOf(page, "hostbar"));
    }

    // 存量迁移：旧版整表落盘的 hostbar 是「主修饰键+B」（Win/Linux 即 Ctrl+B），reload 后
    // 载入回落平台默认，同表里的其它改绑（search=J）原样保留
    await page.evaluate(() => {
      const km = JSON.parse(localStorage.getItem("ui.keymap.v1") ?? "{}");
      km.hostbar = { key: "b", primary: true, shift: false, alt: false };
      localStorage.setItem("ui.keymap.v1", JSON.stringify(km));
    });

    // 持久化跨 reload：改绑在重启后仍在
    await page.reload();
    await page.waitForTimeout(1200);
    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    await page.click('[data-testid="settings-cat-keys"]');
    await page.waitForTimeout(400);
    ck.check(`reload 后改绑仍在（search=${fmt("j")}）`, (await keyTextOf(page, "search")) === fmt("j"), await keyTextOf(page, "search"));
    ck.check(`存量旧 hostbar 载入迁移为 ${HB}`, (await keyTextOf(page, "hostbar")) === HB, await keyTextOf(page, "hostbar"));

    // 单条重置 → 回默认、KV 归默认串
    await page.click('[data-testid="keymap-reset-search"]');
    await page.waitForTimeout(300);
    ck.check(`重置后回 ${fmt("f")}`, (await keyTextOf(page, "search")) === fmt("f"), await keyTextOf(page, "search"));
    const stored2 = await page.evaluate(() => localStorage.getItem("ui.keymap.v1") ?? "");
    ck.check("重置后 KV search 归默认 f", (() => { try { return JSON.parse(stored2).search.key === "f"; } catch { return false; } })(), stored2);

    // 单条重置撞键（审查轮二）：主机栏改 H、搜索改成主机栏的默认键 → 点主机栏「重置」
    // 必须拒绝并说明（此前直接落出两条同键的表，分发只认先命中者、另一条静默失效）
    const HB_COMBO = mac
      ? { key: "b", code: "KeyB", ctrlKey: false, shiftKey: false, altKey: false, metaKey: true }
      : { key: "B", code: "KeyB", ctrlKey: true, shiftKey: true, altKey: false };
    await page.click('[data-testid="keymap-edit-hostbar"]');
    await page.waitForTimeout(200);
    await pressCombo(page, { key: "h", code: "KeyH", ctrlKey: false, shiftKey: false, altKey: false, ...MOD });
    await page.waitForTimeout(300);
    await page.click('[data-testid="keymap-edit-search"]');
    await page.waitForTimeout(200);
    await pressCombo(page, HB_COMBO);
    await page.waitForTimeout(300);
    ck.check(`搜索改到主机栏默认键（search=${HB}）`, (await keyTextOf(page, "search")) === HB, await keyTextOf(page, "search"));
    await page.click('[data-testid="keymap-reset-hostbar"]');
    await page.waitForTimeout(300);
    ck.check("重置撞键被拒（toast 指明占用者）", await page.evaluate(() =>
      [...document.querySelectorAll(".toast.err")].some((t) => t.textContent.includes("冲突") && t.textContent.includes("搜索终端内容"))));
    ck.check(`拒绝后主机栏保持 ${fmt("h")}、表内无同键`, (await keyTextOf(page, "hostbar")) === fmt("h")
      && (await keyTextOf(page, "search")) === HB, `${await keyTextOf(page, "hostbar")} / ${await keyTextOf(page, "search")}`);

    if (!mac) {
      const reloadToKeys = async () => {
        await page.reload();
        await page.waitForTimeout(1200);
        await page.click(".hb-settings");
        await page.waitForTimeout(700);
        await page.click('[data-testid="settings-cat-keys"]');
        await page.waitForTimeout(400);
      };
      const toastTexts = () => page.evaluate(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent ?? ""));
      // 两遍解析：主机栏已改 H、命令面板用 Ctrl+Shift+B（主机栏的默认键）——重载两条都保留
      //（旧实现逐条与「尚未覆盖的默认值」比较，命令面板表序在前，被误丢回 Ctrl+K）
      await page.evaluate(() => localStorage.setItem("ui.keymap.v1", JSON.stringify({
        hostbar: { key: "h", primary: true, shift: false, alt: false },
        palette: { key: "b", primary: true, shift: true, alt: false },
      })));
      await reloadToKeys();
      ck.check("重载：命令面板 Ctrl+Shift+B 与主机栏 Ctrl+H 两条自定义都保留",
        (await keyTextOf(page, "palette")) === "Ctrl+Shift+B" && (await keyTextOf(page, "hostbar")) === "Ctrl+H",
        `${await keyTextOf(page, "palette")} / ${await keyTextOf(page, "hostbar")}`);
      ck.check("无冲突不弹提示", !(await toastTexts()).some((x) => x.includes("快捷键冲突")));
      // 存量 hostbar=Ctrl+B（迁到 Ctrl+Shift+B）而搜索自定义了 Ctrl+Shift+B：默认优先、
      // 搜索回默认——一次性告知并回写，下次启动不再提示
      await page.evaluate(() => localStorage.setItem("ui.keymap.v1", JSON.stringify({
        hostbar: { key: "b", primary: true, shift: false, alt: false },
        search: { key: "b", primary: true, shift: true, alt: false },
      })));
      await reloadToKeys();
      const lostToast = (await toastTexts()).find((x) => x.includes("快捷键冲突")) ?? "";
      ck.check("载入撞键：toast 交代谁让给了谁、恢复成什么",
        lostToast.includes("搜索终端内容") && lostToast.includes("主机栏开关") && lostToast.includes("Ctrl+F"), lostToast);
      ck.check("载入撞键：主机栏 Ctrl+Shift+B、搜索 Ctrl+F",
        (await keyTextOf(page, "hostbar")) === "Ctrl+Shift+B" && (await keyTextOf(page, "search")) === "Ctrl+F",
        `${await keyTextOf(page, "hostbar")} / ${await keyTextOf(page, "search")}`);
      const rewritten = await page.evaluate(() => localStorage.getItem("ui.keymap.v1") ?? "");
      ck.check("解析结果已回写（search=f、hostbar=Ctrl+Shift+B）", (() => {
        try { const o = JSON.parse(rewritten); return o.search.key === "f" && o.hostbar.key === "b" && o.hostbar.shift === true; } catch { return false; }
      })(), rewritten);
      await reloadToKeys();
      ck.check("再次启动不再重复提示", !(await toastTexts()).some((x) => x.includes("快捷键冲突")));

      // 控制字符直发层的豁免（Tauri-only 路径；DEV 钩子 __t_keymapExempt 让 demo 走同一分支）。
      // demo 的动作分发只认 ⌘（Ctrl 系归浏览器，resolveAction 的 native 门），所以这里只能
      // 验「路由」：表内组合（Ctrl+Shift+B / Ctrl+K）不发往终端、交给动作层；保留键 Ctrl+B
      // 直达终端（\x02）。动作是否触发由 shortcuts-keys 单测（native）+ 真机键盘走查守门。
      await page.click('[data-testid="settings-close"]');
      await page.waitForTimeout(300);
      const tabPt = await page.evaluate(() => {
        const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent?.includes("prod-1"));
        const l = tab?.querySelector(".tab-label") ?? tab;
        if (!l) return null;
        const r = l.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      if (tabPt) await page.mouse.click(tabPt.x, tabPt.y);
      await page.waitForTimeout(800);
      const sid = await page.evaluate(() => document.querySelector(".term-session.active")?.dataset.sid ?? null);
      const outTail = async () => sid ? ((await page.evaluate((s) => window.__demoInvoke("read_screen", { sid: s }), sid))?.text ?? "") : "";
      const focusMain = () => page.evaluate(() => document.querySelector(".term-session.active .xterm-helper-textarea")?.focus());
      // 对照：钩子关（demo 默认不豁免）时 Ctrl+K 作为 \x0b 进终端——证明下面的「不发」来自豁免分支
      await focusMain();
      await page.keyboard.press("Control+k");
      await page.waitForTimeout(400);
      ck.check("对照：未开豁免时 Ctrl+K 进终端（\\x0b）", (await outTail()).endsWith("\x0b"), JSON.stringify((await outTail()).slice(-12)));
      await page.evaluate(() => { window.__t_keymapExempt = true; });
      await focusMain();
      const out0 = await outTail();
      await page.keyboard.press("Control+Shift+B");
      await page.waitForTimeout(400);
      ck.check("豁免层：终端聚焦下 Ctrl+Shift+B 不发往终端（归主机栏）", (await outTail()) === out0, JSON.stringify((await outTail()).slice(-12)));
      await focusMain();
      await page.keyboard.press("Control+k");
      await page.waitForTimeout(400);
      ck.check("豁免层：Ctrl+K 不发往终端（归命令面板）", (await outTail()) === out0, JSON.stringify((await outTail()).slice(-12)));
      await focusMain();
      await page.keyboard.press("Control+b");
      await page.waitForTimeout(400);
      ck.check("豁免层：Ctrl+B 直达终端（\\x02 进主视图，tmux 前缀可用）", (await outTail()).endsWith("\x02"), JSON.stringify((await outTail()).slice(-12)));
      await page.evaluate(() => { window.__t_keymapExempt = false; });
    }
  },
};
