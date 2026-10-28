// 26 键位配置轮：设置 → 快捷键——动作行渲染、默认绑定展示、录入流（Esc 取消 /
// 改绑生效 / 冲突拒绝）、localStorage 持久化跨 reload、单条重置。resolveAction 的
// 键位表解析与豁免推导由单测（keymap-cfg/shortcuts-keys）覆盖；此处断言 UI 面。
// 本地终端一等公民轮起七个动作（term-local 默认 Ctrl+Shift+T）。
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
    ck.check(`冲突后 hostbar 保持 ${fmt("b")}`, (await keyTextOf(page, "hostbar")) === fmt("b"), await keyTextOf(page, "hostbar"));

    // 持久化跨 reload：改绑在重启后仍在
    await page.reload();
    await page.waitForTimeout(1200);
    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    await page.click('[data-testid="settings-cat-keys"]');
    await page.waitForTimeout(400);
    ck.check(`reload 后改绑仍在（search=${fmt("j")}）`, (await keyTextOf(page, "search")) === fmt("j"), await keyTextOf(page, "search"));

    // 单条重置 → 回默认、KV 归默认串
    await page.click('[data-testid="keymap-reset-search"]');
    await page.waitForTimeout(300);
    ck.check(`重置后回 ${fmt("f")}`, (await keyTextOf(page, "search")) === fmt("f"), await keyTextOf(page, "search"));
    const stored2 = await page.evaluate(() => localStorage.getItem("ui.keymap.v1") ?? "");
    ck.check("重置后 KV search 归默认 f", (() => { try { return JSON.parse(stored2).search.key === "f"; } catch { return false; } })(), stored2);
  },
};
