// 61 tmux 联动（恢复现场轮）：产品承诺「远端现场，断线也丢不了」——
// 断线横幅三态（多会话挑选 / 单键恢复 / 30 天压制后原样重连）、恢复=重连+补史+
// attach 一次点击（近史写进本地 scrollback、attach 回显可见）、「下次自动」记忆与
// 静默自动恢复（重连成功事件驱动，核心侧 2s 敲键守卫不在此验）、⌘K 按需切换条目
//（已挂过自动 switch-client）、主机表单「连接后执行的命令」落库与建连回显。
// demo 镜像：staging-1 预置 Disconnected+双会话、prod-1 带 tmux fixture、
// __demoInvoke 直达 demo_drop_session / stop_auto_reconnect 制造断线。

const bufText = (page, sid) =>
  page.evaluate((s) => {
    const t = window.__t_terms && window.__t_terms.get(s);
    if (!t) return null;
    const b = t.buffer.active;
    const out = [];
    for (let i = Math.max(0, b.length - 400); i < b.length; i++) {
      out.push(b.getLine(i) ? b.getLine(i).translateToString(true) : "");
    }
    return out.join("\n");
  }, sid);

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

/** 轮询等 toast 文案（坑 55：不 用 waitForFunction，evaluate 内轮询） */
const waitToast = async (page, substr, timeout = 7000) =>
  page.evaluate(async ({ s, tmo }) => {
    const dl = Date.now() + tmo;
    while (Date.now() < dl) {
      const els = [...document.querySelectorAll(".toast")];
      if (els.some((e) => (e.textContent ?? "").includes(s))) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }, { s: substr, tmo: timeout });

module.exports = {
  title: "tmux 恢复现场：横幅三态/一键恢复/自动记忆/30 天压制/⌘K 切换/启动命令",
  async run({ page, ck }) {
    await page.waitForTimeout(1200);

    // ── A. 断线横幅·多会话挑选（staging-1 预置 Disconnected + work/logs）──
    await activateTab(page, "staging-1");
    ck.check("横幅教学文案：检测到远端 tmux 会话（work、logs）",
      (await page.evaluate(() => document.querySelector(".dead-banner")?.textContent ?? "")).includes("检测到远端有 tmux 会话在运行（work、logs）"),
      await page.evaluate(() => document.querySelector(".dead-banner")?.innerText ?? "无横幅"));
    ck.check("多会话内联挑选：work/logs 两按钮 + 仅重连",
      await page.evaluate(() => !!document.querySelector('[data-testid="tmux-pick-work"]')
        && !!document.querySelector('[data-testid="tmux-pick-logs"]')
        && !!document.querySelector('[data-testid="tmux-reconn-only-btn"]')), "");

    // ── B. 挑选 work 恢复现场：重连 + 补史 + attach 一次点击 ──
    await page.click('[data-testid="tmux-pick-work"]');
    ck.check("恢复现场 toast（tmux work · 2 个窗口）",
      await waitToast(page, "已恢复现场（tmux work · 2 个窗口）"), "");
    await page.waitForTimeout(400);
    const bufA = await bufText(page, "s-demo-0002");
    ck.check("近史已写入本地 scrollback（capture-pane 补史）",
      !!bufA && bufA.includes("capture-pane 近史"), bufA?.slice(-200) ?? "无缓冲");
    ck.check("attach 回显进终端（tmux attach -t '=work'）",
      !!bufA && bufA.includes("tmux attach -t '=work'"), "");
    ck.check("断线横幅已随重连消失",
      await page.evaluate(() => !document.querySelector(".dead-overlay")), "");
    const prefsA = await page.evaluate(() => JSON.parse(localStorage.getItem("tmux.v1.prefs") ?? "{}"));
    ck.check("最后会话记忆：prefs.last[h-staging1]=work",
      prefsA?.last?.["h-staging1"] === "work", JSON.stringify(prefsA));

    // ── C. prod-1 断线 → 单键恢复（teach 文案 + 单会话直进）→ 勾「下次自动」──
    await page.evaluate(() => window.__demoInvoke?.("demo_drop_session", { sid: "s-demo-0001", recoverOnAttempt: 0 }));
    await page.waitForTimeout(3000); // 3 次 attempt × 700ms → Disconnected
    await activateTab(page, "prod-1");
    ck.check("单会话教学横幅：检测到 tmux（work）+ 恢复现场主键",
      (await page.evaluate(() => document.querySelector(".dead-banner")?.textContent ?? "")).includes("检测到远端有 tmux 会话在运行（work）")
        && await page.evaluate(() => !!document.querySelector('[data-testid="tmux-restore-btn"]')),
      await page.evaluate(() => document.querySelector(".dead-banner")?.innerText ?? "无横幅"));
    await page.click('[data-testid="tmux-auto-chk"]');
    await page.waitForTimeout(300);
    const prefsB = await page.evaluate(() => JSON.parse(localStorage.getItem("tmux.v1.prefs") ?? "{}"));
    ck.check("「下次自动」已记忆：prefs.auto 含 h-prod1",
      Array.isArray(prefsB?.auto) && prefsB.auto.includes("h-prod1"), JSON.stringify(prefsB));
    await page.click('[data-testid="tmux-restore-btn"]');
    ck.check("prod-1 恢复现场 toast", await waitToast(page, "已恢复现场（tmux work"), "");

    // ── D. 自动恢复：再断线 → 仅重连 → 重连成功事件驱动静默恢复（已挂改 switch-client）──
    await page.evaluate(() => window.__demoInvoke?.("stop_auto_reconnect", { sid: "s-demo-0001" }));
    await page.waitForTimeout(600);
    await activateTab(page, "prod-1");
    ck.check("有记忆后横幅不再教学（远端会话 work 仍在运行）",
      (await page.evaluate(() => document.querySelector(".dead-banner")?.textContent ?? "")).includes("远端会话 work 仍在运行"),
      await page.evaluate(() => document.querySelector(".dead-banner")?.innerText ?? "无横幅"));
    await page.click('[data-testid="tmux-reconn-only-btn"]');
    ck.check("自动恢复 toast（1.2s 延迟事件驱动）", await waitToast(page, "已恢复现场（tmux work"), 9000);
    // 自动恢复链路：补史 + switch-client 回显（feed 合帧有百 ms 级延迟，轮询等）
    const swOk = await page.evaluate(async () => {
      const dl = Date.now() + 4000;
      const read = () => {
        const t = window.__t_terms && window.__t_terms.get("s-demo-0001");
        if (!t) return "";
        const b = t.buffer.active;
        const out = [];
        for (let i = Math.max(0, b.length - 400); i < b.length; i++) {
          out.push(b.getLine(i) ? b.getLine(i).translateToString(true) : "");
        }
        return out.join("\n");
      };
      while (Date.now() < dl) {
        if (read().includes("tmux switch-client -t '=work'")) return true;
        await new Promise((r) => setTimeout(r, 150));
      }
      return read().includes("tmux switch-client -t '=work'");
    });
    const bufB = await bufText(page, "s-demo-0001");
    ck.check("已挂过 tmux 再挂自动 switch-client", swOk, bufB?.slice(-160) ?? "无缓冲");

    // ── E. ⌘K 按需切换条目（当前主机有 tmux 时才出现）──
    await page.click('[data-testid="palette-open"]');
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="palette-input"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "tmux");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(300);
    const titles = await page.evaluate(() => [...document.querySelectorAll(".palette-item .palette-title")].map((x) => x.textContent));
    ck.check("⌘K 出现「切换到 tmux 会话：work（2 窗口）」",
      titles.some((x) => x?.includes("切换到 tmux 会话：work（2 窗口）")), titles.join(" | "));
    await page.evaluate(() => {
      const item = [...document.querySelectorAll(".palette-item")].find((x) => x.textContent?.includes("切换到 tmux 会话"));
      item?.click();
    });
    ck.check("⌘K 切换执行：toast 已恢复现场", await waitToast(page, "已恢复现场（tmux work"), "");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // ── F.「仅重连」30 天压制：教学态点仅重连 → 再断线回普通重连横幅 ──
    await page.evaluate(() => window.__demoInvoke?.("demo_drop_session", { sid: "s-demo-0002", recoverOnAttempt: 0 }));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__demoInvoke?.("stop_auto_reconnect", { sid: "s-demo-0002" }));
    await activateTab(page, "staging-1");
    // staging 已有 last=work（B 步），压制只对无记忆主机生效——先清记忆再验教学压制
    await page.evaluate(() => {
      const j = JSON.parse(localStorage.getItem("tmux.v1.prefs") ?? "{}");
      delete j.last["h-staging1"];
      localStorage.setItem("tmux.v1.prefs", JSON.stringify(j));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1400);
    await activateTab(page, "staging-1");
    ck.check("清记忆后回到教学态（带 tmux 按钮）",
      await page.evaluate(() => !!document.querySelector('[data-testid="tmux-pick-work"]')), "");
    await page.click('[data-testid="tmux-reconn-only-btn"]');
    await page.waitForTimeout(2200);
    ck.check("仅重连后 staging 已重连（横幅消失）",
      await page.evaluate(() => !document.querySelector(".dead-overlay")), "");
    await page.evaluate(() => window.__demoInvoke?.("stop_auto_reconnect", { sid: "s-demo-0002" }));
    await activateTab(page, "staging-1");
    ck.check("「仅重连」30 天压制：横幅回普通重连形态（无 tmux 按钮）",
      (await page.evaluate(() => document.querySelector(".dead-banner")?.textContent ?? "")).includes("画面是断开前的最后状态")
        && await page.evaluate(() => !document.querySelector('[data-testid="tmux-pick-work"]')),
      await page.evaluate(() => document.querySelector(".dead-banner")?.innerText ?? "无横幅"));

    // ── G. 主机表单「连接后执行的命令」：落库回读 + 建连回显 ──
    await page.click('.hostbar button[title="添加主机"]');
    await page.waitForTimeout(500);
    const inputs = await page.$$(".add-host-dlg input");
    // 0=名称 1=地址 2=端口 3=用户名 4=密码 …（启动命令在跳板 select 之后、标签之前）
    await inputs[0].fill("tmux-host");
    await inputs[1].fill("tmux.demo");
    await inputs[2].fill("22");
    await inputs[3].fill("ops");
    await inputs[4].fill("pw");
    await page.fill('[data-testid="startup-cmd-input"]', "tmux new -A -s work");
    await page.evaluate(() => [...document.querySelectorAll(".add-host-dlg button")].find((b) => b.textContent.trim() === "仅保存").click());
    await page.waitForTimeout(900);
    const card = await page.$('.host-card:has(.host-name:text-is("tmux-host"))');
    ck.check("新主机落库（tmux-host 在列表）", !!card, "");
    await card.hover();
    await page.waitForTimeout(300);
    await (await card.$('button[title^="连接"]')).click();
    // 首连必过 TOFU 指纹门（demo 只有 prod-1 预置信任）
    await page.waitForTimeout(1300);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((y) => y.textContent.trim() === "信任并连接");
      if (b) b.click();
    });
    await page.waitForTimeout(1800);
    const sids = await page.evaluate(() => {
      const out = [];
      window.__t_terms && window.__t_terms.forEach((_, k) => out.push(k));
      return out;
    });
    const newSid = sids[sids.length - 1];
    const bufC = await bufText(page, newSid);
    ck.check("建连回显：启动命令于提示符处执行（[演示] tmux new -A -s work）",
      !!bufC && bufC.includes("[演示] tmux new -A -s work"), bufC?.slice(-160) ?? "无缓冲");
    // 编辑回读：表单预填启动命令（demo upsert 持久化）
    const card2 = await page.$('.host-card:has(.host-name:text-is("tmux-host"))');
    await card2.hover();
    await page.waitForTimeout(300);
    await (await card2.$('button[title^="编辑主机"]')).click();
    await page.waitForTimeout(500);
    ck.check("编辑表单回读启动命令",
      (await page.evaluate(() => document.querySelector('[data-testid="startup-cmd-input"]')?.value)) === "tmux new -A -s work",
      await page.evaluate(() => document.querySelector('[data-testid="startup-cmd-input"]')?.value));
    await page.evaluate(() => [...document.querySelectorAll(".add-host-dlg button")].find((b) => b.textContent.trim() === "保存修改").click());
    await page.waitForTimeout(600);

    // ── G. 工具栏 tmux 快接钮（常驻主动入口）：ssh+探测到 tmux 才渲染；点开重探
    // 清单、点选即恢复现场；attach 后钮面显示 tmux:work、菜单标「当前」；Esc 可关──
    await activateTab(page, "tmux-host");
    ck.check("工具栏出现 tmux 快接钮（未 attach 态，label=tmux）",
      await page.evaluate(() => !!document.querySelector('[data-testid="tmux-quick"]')
        && (document.querySelector('[data-testid="tmux-quick"] button')?.textContent ?? "").includes("tmux")
        && !(document.querySelector('[data-testid="tmux-quick"] button')?.textContent ?? "").includes("tmux:")), "");
    await page.click('[data-testid="tmux-quick"] button');
    await page.waitForTimeout(500);
    ck.check("快接菜单列出 work（点开重探清单）",
      await page.evaluate(() => !!document.querySelector('[data-testid="tmux-quick-item-work"]')), "");
    await page.click('[data-testid="tmux-quick-item-work"]');
    ck.check("快接项点击=恢复现场（toast）", await waitToast(page, "已恢复现场（tmux work"), "");
    // tmux_attached 随会话清单轮询下发（3s 一拍）——evaluate 内轮询等钮面换装（坑 55）
    const labelOk = await page.evaluate(async () => {
      const dl = Date.now() + 6000;
      while (Date.now() < dl) {
        if ((document.querySelector('[data-testid="tmux-quick"] button')?.textContent ?? "").includes("tmux:work")) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return (document.querySelector('[data-testid="tmux-quick"] button')?.textContent ?? "").includes("tmux:work");
    });
    ck.check("attach 后钮面显示 tmux:work", labelOk, "");
    await page.click('[data-testid="tmux-quick"] button');
    await page.waitForTimeout(500);
    ck.check("菜单里 work 标「当前」",
      (await page.evaluate(() => document.querySelector('[data-testid="tmux-quick-item-work"]')?.textContent ?? "")).includes("当前"), "");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    ck.check("Esc 关快接菜单", await page.evaluate(() => !document.querySelector('[data-testid="tmux-quick-menu"]')), "");
  },
};
