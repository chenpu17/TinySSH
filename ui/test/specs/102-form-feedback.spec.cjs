// 102 表单反馈与提示层级（视觉升级走查轮）：四处在别处已确立、却漏在未复核界面上的规则。
// ① 字段级错误态：添加主机/快速连接/tmux 新建只挂了 aria-invalid，画面上没有对应变化；
//    端口转发表单连属性也没挂。现在出错字段描边转危险色，悬停/聚焦不改写。
// ② Toast 语义只留在左侧色条：kind 类名 ok/err 与通用文字工具类 .ok/.err 同名，
//    整段提示曾被染成饱和语义色。
// ③ 快捷键行的「修改/重置」是行内辅助动作，取消静态描边（命令块/SFTP/tmux 大屏同款）。
// ④ 断线横幅的「仅重连」是次级动作，不再与「恢复现场」同为实心主操作。
// 不断言像素截图，只锁计算样式、无障碍关联与真实布局边界。
const style = (page, sel, props) => page.evaluate(([s, ps]) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const cs = getComputedStyle(el);
  return Object.fromEntries(ps.map((p) => [p, cs[p]]));
}, [sel, props]);

/** 主题变量解析后的颜色（探针元素读 computed color） */
const varColor = (page, name) => page.evaluate((n) => {
  const probe = document.createElement("span");
  probe.style.cssText = "position:fixed;visibility:hidden;color:var(" + n + ")";
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}, name);

/** 表单控件的描边/聚焦环带 --motion-fast 过渡（styles.css「交互反馈层」）：读计算样式前等过渡走完，
 *  否则读到的是起点色与终点色之间的插值（首轮实测 oklab 中间值）。 */
const settle = (page, sel) => page.evaluate(async (s) => {
  const drain = () => Promise.all([...document.querySelectorAll(s)]
    .flatMap((el) => el.getAnimations().map((a) => a.finished.catch(() => {}))));
  await drain();
  await new Promise((r) => setTimeout(r, 60)); // 焦点落位后的下一段过渡可能下一帧才建
  await drain();
}, sel);

const clickText = (page, sel, text) => page.evaluate(([s, t]) => {
  const b = [...document.querySelectorAll(s)].find((x) => x.textContent.trim() === t);
  if (!b) throw new Error(`找不到 ${s}「${t}」`);
  b.click();
}, [sel, text]);

const connectHost = async (page, name) => {
  const card = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  if (!card) throw new Error(`主机卡不在场：${name}`);
  await card.hover();
  await page.waitForTimeout(200);
  await (await card.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1300);
};

const activateTab = async (page, label) => {
  const ok = await page.evaluate((t) => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent?.includes(t));
    if (!tab) return false;
    tab.click();
    return true;
  }, label);
  if (!ok) throw new Error(`标签不在场：${label}`);
  await page.waitForTimeout(700);
};

module.exports = {
  title: "表单反馈与提示层级：字段错误态/Toast 配色/行内辅助动作/次级动作",
  async run({ page, ck }) {
    await page.waitForTimeout(1000);
    const danger = await varColor(page, "--danger");
    const accent = await varColor(page, "--accent");
    const control = await varColor(page, "--control-border");
    const transparent = "rgba(0, 0, 0, 0)";

    // ── ① 新建连接：空提交 ──
    await page.locator(".welcome-actions button", { hasText: "添加主机" }).click();
    await page.locator('[data-testid="add-host-dialog"]').waitFor({ state: "visible" });
    await clickText(page, '[data-testid="add-host-actions"] button', "保存并连接");
    await page.waitForSelector("#ah-error");
    await settle(page, "#ah-name, #ah-address");
    const ring = await varColor(page, "--accent-ring");
    const name = await style(page, "#ah-name", ["borderTopColor", "boxShadow"]);
    ck.check("新建连接空提交：出错的名称框描边转危险色，聚焦环仍是 accent",
      (await page.getAttribute("#ah-name", "aria-invalid")) === "true"
      && (await page.getAttribute("#ah-name", "aria-describedby")) === "ah-error"
      && name.borderTopColor === danger && name.boxShadow === `${ring} 0px 0px 0px 3px`,
      JSON.stringify({ danger, ring, ...name }));
    const addr = await style(page, "#ah-address", ["borderTopColor"]);
    ck.check("未关联错误的字段保持常规控件描边",
      (await page.getAttribute("#ah-address", "aria-invalid")) === null && addr.borderTopColor === control,
      JSON.stringify({ control, ...addr }));
    await page.fill("#ah-name", "我的服务器");
    await settle(page, "#ah-name");
    const cleared = await style(page, "#ah-name", ["borderTopColor"]);
    ck.check("修改出错字段后错误态解除（聚焦中的字段回到 accent 描边）",
      (await page.$("#ah-error")) === null
      && (await page.getAttribute("#ah-name", "aria-invalid")) === null
      && cleared.borderTopColor === accent,
      JSON.stringify({ accent, ...cleared }));
    await clickText(page, '[data-testid="add-host-actions"] button', "取消");
    await page.waitForTimeout(300);

    // ── ① 快速连接：同一表单错误契约 ──
    await page.locator(".welcome-actions button", { hasText: "快速连接" }).click();
    await page.locator('[data-testid="quick-connect-dialog"]').waitFor({ state: "visible" });
    await page.click('[data-testid="quick-connect-go"]');
    await page.waitForSelector("#qc-error");
    await settle(page, "#qc-address");
    const qc = await style(page, "#qc-address", ["borderTopColor"]);
    ck.check("快速连接空提交：地址框同契约转危险色",
      (await page.getAttribute("#qc-address", "aria-invalid")) === "true"
      && (await page.getAttribute("#qc-address", "aria-describedby")) === "qc-error"
      && qc.borderTopColor === danger,
      JSON.stringify({ danger, ...qc }));
    await page.click('[data-testid="quick-connect-cancel"]');
    await page.waitForTimeout(300);

    // ── ① 端口转发表单：按监听/目标两组定位 ──
    await connectHost(page, "prod-1");
    await page.click('.session-toolbar button:has-text("工具")');
    await page.waitForTimeout(350);
    await clickText(page, ".tools-menu [role=menuitem]", "端口转发");
    await page.waitForSelector(".task-panel .fwd-form");
    const readInputs = () => page.evaluate(() => [...document.querySelectorAll(".task-panel .fwd-form input")].map((el) => ({
      invalid: el.getAttribute("aria-invalid"), by: el.getAttribute("aria-describedby"), border: getComputedStyle(el).borderTopColor,
    })));
    const fwdInput = page.locator(".task-panel .fwd-form input");
    // 未挂错误态的字段：常规描边，或仍持焦点的 accent 描边（合成 click 不转移焦点）
    const normal = (x) => x.invalid === null && x.by === null && (x.border === control || x.border === accent);
    await clickText(page, ".task-panel button", "启动转发");
    await page.waitForSelector('[data-testid="fwd-err-listen"]');
    await page.waitForSelector('[data-testid="fwd-err-target"]');
    await settle(page, ".task-panel .fwd-form input");
    const empty = await readInputs();
    const errIdsOk = await page.evaluate(() => !!document.getElementById("fwd-err-listen") && !!document.getElementById("fwd-err-target"));
    ck.check("空提交：监听组与目标组四个输入框都挂错误态并指向各自错误行",
      empty.length === 4 && errIdsOk
      && empty.every((x, i) => x.invalid === "true" && x.by === (i < 2 ? "fwd-err-listen" : "fwd-err-target") && x.border === danger),
      JSON.stringify({ danger, empty }));
    await fwdInput.nth(2).hover();
    await page.waitForTimeout(250);
    const hovered = (await readInputs())[2];
    ck.eq("悬停不改写出错字段的危险描边", hovered.border, danger);
    await page.mouse.move(5, 895);

    await fwdInput.nth(1).fill("8080");
    await settle(page, ".task-panel .fwd-form input");
    const afterEdit = await readInputs();
    ck.check("修改任一字段后整组错误态先解除", afterEdit.every(normal), JSON.stringify({ control, accent, afterEdit }));
    await clickText(page, ".task-panel button", "启动转发");
    await page.waitForSelector('[data-testid="fwd-err-target"]');
    await settle(page, ".task-panel .fwd-form input");
    const targetOnly = await readInputs();
    const listenErrGone = (await page.$('[data-testid="fwd-err-listen"]')) === null;
    ck.check("只剩目标组出错时，监听组两个字段不背错误态",
      listenErrGone && normal(targetOnly[0]) && normal(targetOnly[1])
      && targetOnly[2].invalid === "true" && targetOnly[3].invalid === "true"
      && targetOnly[2].border === danger && targetOnly[3].border === danger,
      JSON.stringify(targetOnly));

    await fwdInput.nth(2).fill("example.internal");
    await fwdInput.nth(3).fill("80");
    await clickText(page, ".task-panel button", "启动转发");
    await page.waitForSelector(".task-panel .fwd-row");
    await settle(page, ".task-panel .fwd-form input");
    const clean = await readInputs();
    ck.check("合法提交后错误态全部清除，描边回到常规控件色", clean.every(normal), JSON.stringify(clean));

    // 路线不尾省略：默认面板宽度放不下整条路线时在箭头处折行，目标主机与端口完整可见
    const row = await page.evaluate(() => {
      const el = document.querySelector(".fwd-row .xfer-name");
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()];
      const box = el.getBoundingClientRect();
      return {
        text: el.textContent, ws: getComputedStyle(el).whiteSpace,
        sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight,
        lines: rects.length, lastRight: rects.at(-1)?.right ?? 0, boxRight: box.right,
      };
    });
    ck.check("转发行路线在箭头处折行、不做尾省略：目标主机与端口完整可见",
      row.text === "127.0.0.1:8080 → example.internal:80" && row.ws === "normal" && row.lines >= 2
      && row.sw <= row.cw + 1 && row.sh <= row.ch + 1 && row.lastRight <= row.boxRight + 0.5,
      JSON.stringify(row));
    const panel = await style(page, ".task-panel", ["overflowX"]);
    const panelOverflow = await page.evaluate(() => {
      const el = document.querySelector(".tp-scroll") ?? document.querySelector(".task-panel");
      return el.scrollWidth - el.clientWidth;
    });
    ck.check("折行不撑宽面板（无横向溢出）", panelOverflow <= 1, String(panelOverflow));

    // ── ② Toast ──
    const [text, ok] = await Promise.all([varColor(page, "--text"), varColor(page, "--ok")]);
    const toast = await style(page, ".toast.ok", ["color", "borderLeftColor", "borderLeftWidth"]);
    ck.check("成功 toast：语义色只在左侧色条，正文回归常规文字色",
      !!toast && toast.color === text && toast.borderLeftColor === ok && toast.borderLeftWidth === "3px" && ok !== text,
      JSON.stringify({ text, ok, ...toast }));
    const errRule = await page.evaluate(() => {
      const out = [];
      for (const sh of document.styleSheets) {
        let rules;
        try { rules = sh.cssRules; } catch { continue; }
        for (const r of rules) if (r.selectorText === ".toast.err") out.push(r.style.getPropertyValue("color").replace(/\s+/g, ""));
      }
      return out;
    });
    ck.check("失败 toast 同款：规则声明正文为常规文字色", errRule.includes("var(--text)"), JSON.stringify(errRule));

    // ── ③ 快捷键行 ──
    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    await page.click('[data-testid="settings-cat-keys"]');
    await page.waitForTimeout(700);
    const edit = page.locator('[data-testid="keymap-edit-search"]');
    const s0 = await edit.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { border: cs.borderTopColor, width: cs.borderTopWidth, style: cs.borderTopStyle, height: el.getBoundingClientRect().height };
    });
    ck.check("「修改」取消静态描边，边框盒（尺寸）保留",
      s0.border === transparent && s0.width === "1px" && s0.style === "solid" && s0.height >= 24, JSON.stringify(s0));
    const reset = await page.locator('[data-testid="keymap-reset-search"]').evaluate((el) => ({
      disabled: el.disabled, border: getComputedStyle(el).borderTopColor,
    }));
    ck.check("已是默认值的「重置」仍禁用且不再画空方框", reset.disabled === true && reset.border === transparent, JSON.stringify(reset));
    const all = await page.evaluate(() => [...document.querySelectorAll(".km-row button")].map((b) => getComputedStyle(b).borderTopColor));
    ck.check("全部快捷键行内动作均无静态描边", all.length >= 12 && all.every((c) => c === transparent), JSON.stringify(all));
    await edit.hover();
    await page.waitForTimeout(250);
    const quiet = await varColor(page, "--quiet-hover");
    const hv = await edit.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopColor }));
    ck.check("悬停给中性弱底，描边不回来", hv.bg === quiet && hv.border === transparent, JSON.stringify({ quiet, ...hv }));
    await page.mouse.move(5, 895);
    await page.waitForTimeout(200);
    // 键盘模态下程序化聚焦 → :focus-visible（全局 2px 焦点环是行内动作唯一的键盘指示）
    await page.keyboard.press("Shift");
    await edit.evaluate((el) => el.focus());
    const fv = await edit.evaluate((el) => ({
      visible: el.matches(":focus-visible"), outline: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth,
    }));
    ck.check("键盘焦点环保留", fv.visible === true && fv.outline === "solid" && fv.width === "2px", JSON.stringify(fv));
    await page.click('[data-testid="settings-close"]');
    await page.waitForTimeout(400);

    // ── ④ 断线横幅（staging-1 预置断线 + work/logs 双会话）──
    await activateTab(page, "staging-1");
    const btns = await page.evaluate(() => {
      const read = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, img: cs.backgroundImage, h: el.getBoundingClientRect().height, text: el.textContent.trim() };
      };
      return { pick: read('[data-testid="tmux-pick-work"]'), only: read('[data-testid="tmux-reconn-only-btn"]') };
    });
    ck.check("断线横幅：「恢复现场」仍是主操作，「仅重连」降为次级",
      !!btns.pick && !!btns.only && btns.pick.img.includes("gradient")
      && btns.only.bg === transparent && btns.only.img === "none" && btns.only.text === "仅重连"
      && Math.abs(btns.only.h - btns.pick.h) <= 2.5,
      JSON.stringify(btns));
    ck.check("「仅重连」点击区不缩水（高度与主操作同档）", btns.only.h >= btns.pick.h - 0.5, JSON.stringify(btns));
  },
};
