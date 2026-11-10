// 10 主机管理与 ssh_config 导入：新增、编辑、收藏、删除确认、导入预览（§6.1 / §5 迁移表）。

const cardByName = (page, name) => page.$(`.host-card:has(.host-name:text-is("${name}"))`);
const hostNames = (page) => page.$$eval(".host-card .host-name", (els) => els.map((e) => e.textContent.trim()));
// 走查 P1：收藏/编辑/删除收进「更多」菜单（与主机卡右键同一份菜单）
const menuAction = async (page, name, item) => {
  await page.evaluate((n) => {
    const cards = [...document.querySelectorAll(".host-card")];
    const nameOf = (c) => c.querySelector(".host-name")?.textContent.trim() ?? "";
    // 先精确，后前缀（prod-2 的卡名带「（演示连接失败）」后缀）
    const card = cards.find((c) => nameOf(c) === n) ?? cards.find((c) => nameOf(c).startsWith(n));
    if (!card) throw new Error("host card not found: " + n);
    card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 90, clientY: 320 }));
  }, name);
  await page.waitForSelector(".ctx-menu", { timeout: 3000 });
  await page.evaluate((txt) => {
    const b = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((x) => x.textContent.includes(txt));
    if (!b) throw new Error("menu item not found: " + txt);
    b.click();
  }, item);
  await page.waitForTimeout(700);
};

module.exports = {
  title: "主机增删改与 ssh_config 导入",
  async run({ page, ck, BASE }) {
    // ── 主机列表首载失败：显式错误态 + 重试（不伪装成「还没有主机」）──
    // ?failhosts 让 list_hosts 首装两次调用失败（StrictMode 双跑），第三次恢复。
    await page.goto(`${BASE}/?failhosts`, { waitUntil: "networkidle" });
    await page.waitForSelector(".hostbar", { timeout: 10000 });
    await page.waitForTimeout(900);
    const loadErr = await page.evaluate(() => {
      const e = document.querySelector('[data-testid="hostbar-load-error"]');
      return {
        has: !!e, role: e?.getAttribute("role"), text: e?.innerText.replace(/\n+/g, " | ") ?? "",
        empty: !!document.querySelector('[data-testid="hostbar-empty"]'),
        cards: document.querySelectorAll(".host-card").length,
      };
    });
    ck.check("首载失败显式错误态（role=alert，文案如实）",
      loadErr.has && loadErr.role === "alert" && loadErr.text.includes("主机列表读取失败"), JSON.stringify(loadErr));
    ck.check("首载失败不伪装成空主机栏", !loadErr.empty && loadErr.cards === 0, JSON.stringify(loadErr));
    await page.evaluate(() => {
      [...document.querySelectorAll('[data-testid="hostbar-load-error"] button')].find((b) => b.textContent.includes("重试"))?.click();
    });
    await page.waitForFunction(() => !!document.querySelector('.host-card .host-name'), undefined, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(300);
    ck.check("重试后主机列表恢复", await page.evaluate(() =>
      !document.querySelector('[data-testid="hostbar-load-error"]') &&
      [...document.querySelectorAll(".host-card .host-name")].some((x) => x.textContent.trim() === "prod-1")), "");
    // 回到干净 demo 域（上面 reload 后 demo 内存态已重置）
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".hostbar", { timeout: 10000 });
    await page.waitForTimeout(700);

    // ── 新增 ──
    await page.click('.hostbar button[title="添加主机"]');
    await page.waitForTimeout(500);

    // 表单错误契约：错误持续到相关字段修改或重新提交；容器 role=alert、
    // 出错字段 aria-describedby 关联（改错字时读屏仍能定位）
    await page.evaluate(() => [...document.querySelectorAll(".add-host-dlg button")].find((b) => b.textContent.trim() === "保存并连接").click());
    await page.waitForTimeout(200);
    const formErr = await page.evaluate(() => {
      const e = document.querySelector("#ah-error");
      const n = document.querySelector("#ah-name");
      return {
        text: e?.innerText ?? "", role: e?.getAttribute("role"),
        desc: n?.getAttribute("aria-describedby"), invalid: n?.getAttribute("aria-invalid"),
      };
    });
    ck.check("空提交错误条 role=alert 且关联名称字段",
      formErr.role === "alert" && formErr.desc === "ah-error" && formErr.invalid === "true" && formErr.text.includes("名称、地址、用户名都不能为空"),
      JSON.stringify(formErr));
    const inputs = await page.$$(".add-host-dlg input");
    await inputs[0].fill("r45-new");
    await page.waitForTimeout(150);
    ck.check("修改出错字段后错误提示消失", await page.evaluate(() => !document.querySelector("#ah-error")), "");
    // 表单已移居中弹窗（.add-host-dlg）：0=名称 1=地址 2=端口 3=用户名 4=密码 5=标签
    await inputs[1].fill("r45.example.com");
    await inputs[2].fill("2200");
    await inputs[3].fill("deploy");
    await inputs[4].fill("s3cret");

    // 密码可见性开关：默认隐藏；切换只改 type，不触发提交；再点恢复隐藏
    const eyeBefore = await page.evaluate(() => {
      const w = document.querySelector(".add-host-dlg .secret-input");
      return { type: w?.querySelector("input")?.type, label: w?.querySelector("button")?.getAttribute("aria-label"), pressed: w?.querySelector("button")?.getAttribute("aria-pressed") };
    });
    ck.check("密码默认隐藏且开关带 aria-label/aria-pressed",
      eyeBefore.type === "password" && !!eyeBefore.label && eyeBefore.pressed === "false", JSON.stringify(eyeBefore));
    await page.click(".add-host-dlg .secret-toggle");
    await page.waitForTimeout(150);
    const eyeShown = await page.evaluate(() => {
      const w = document.querySelector(".add-host-dlg .secret-input");
      return { type: w?.querySelector("input")?.type, pressed: w?.querySelector("button")?.getAttribute("aria-pressed"), dialog: !!document.querySelector(".add-host-dlg") };
    });
    ck.check("切换后明文显示且不触发提交", eyeShown.type === "text" && eyeShown.pressed === "true" && eyeShown.dialog, JSON.stringify(eyeShown));
    await page.click(".add-host-dlg .secret-toggle");
    await page.waitForTimeout(150);
    ck.check("再次点击恢复隐藏", await page.evaluate(() => document.querySelector(".add-host-dlg .secret-input input")?.type === "password"), "");

    await page.evaluate(() => [...document.querySelectorAll(".add-host-dlg button")].find((b) => b.textContent.trim() === "仅保存").click());
    await page.waitForTimeout(900);
    ck.check("「仅保存」后新主机出现在列表", (await hostNames(page)).includes("r45-new"), (await hostNames(page)).join(" / "));

    // ── 主机卡 hover 操作组：显隐/键盘可达/不遮挡主信息 ──
    await page.mouse.move(700, 760);
    await page.waitForTimeout(250);
    const longCard = await cardByName(page, "prod-2（演示连接失败）");
    const sideRest = await longCard.evaluate((el) => getComputedStyle(el.querySelector(".host-card-side")).opacity);
    ck.check("操作组静止隐形", sideRest === "0", `opacity=${sideRest}`);
    await longCard.hover();
    await page.waitForTimeout(300);
    const geom = await longCard.evaluate((el) => {
      const side = el.querySelector(".host-card-side");
      const sr = side.getBoundingClientRect();
      // 可见文字边界 = 元素内容盒右缘（padding-right 是为操作组让出的空白；
      // 文字被 overflow:hidden 收在内容盒内，Range 量到的是未裁剪的布局宽度）
      const contentRight = (sel) => {
        const n = el.querySelector(sel);
        const r = n.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(n).paddingRight) || 0;
        return r.right - pad;
      };
      return {
        opacity: getComputedStyle(side).opacity,
        pad: getComputedStyle(el.querySelector(".host-line")).paddingRight,
        nameRight: contentRight(".host-name"), addrRight: contentRight(".host-addr"),
        sideLeft: sr.left,
      };
    });
    ck.check("hover 操作组显形", geom.opacity === "1", JSON.stringify(geom));
    ck.check("hover 时主机名/地址文字让位操作组（不再被盖住）",
      geom.nameRight <= geom.sideLeft && geom.addrRight <= geom.sideLeft, JSON.stringify(geom));
    // 键盘：离开悬停后聚焦主机卡，Tab 进入操作组且操作组随之显形
    await page.mouse.move(700, 760);
    await page.waitForTimeout(250);
    const longCard2 = await cardByName(page, "prod-2（演示连接失败）");
    await longCard2.focus();
    await page.keyboard.press("Tab");
    await page.waitForTimeout(200);
    const kb = await page.evaluate(() => {
      const a = document.activeElement;
      const side = a?.closest(".host-card")?.querySelector(".host-card-side");
      return { inSide: !!a?.closest(".host-card-side"), label: a?.getAttribute("title") ?? "", opacity: side ? getComputedStyle(side).opacity : "" };
    });
    ck.check("键盘 Tab 可达操作钮且操作组显形",
      kb.inSide && kb.label.startsWith("更多操作") && kb.opacity === "1", JSON.stringify(kb));

    // 「更多」钮打开与右键同一份菜单（收藏/编辑/删除都在里面）
    const moreCard = await cardByName(page, "r45-new");
    await moreCard.hover();
    await page.waitForTimeout(250);
    await (await moreCard.$(".host-more-btn")).click();
    await page.waitForTimeout(300);
    const moreMenu = await page.evaluate(() => {
      const m = document.querySelector(".ctx-menu");
      return m ? m.innerText.replace(/\n+/g, " | ") : "";
    });
    ck.check("「更多」钮弹出收藏/编辑/删除菜单",
      moreMenu.includes("收藏") && moreMenu.includes("编辑主机") && moreMenu.includes("删除主机"), moreMenu || "(无菜单)");
    await page.evaluate(() => document.querySelector(".pop-mask")?.click());
    await page.waitForTimeout(250);


    // ── 收藏 ──
    await menuAction(page, "r45-new", "收藏（置顶分组）");
    ck.check("收藏后出现「收藏」分组", await page.evaluate(() => document.querySelector(".hostbar").innerText.includes("收藏")), "");
    const groupText = await page.evaluate(() => document.querySelector(".hostbar").innerText.replace(/\n+/g, " | ").slice(0, 120));
    ck.check("收藏分组内含 r45-new", groupText.includes("r45-new") || (await hostNames(page))[0] === "r45-new", groupText);

    // ── 编辑 ──
    await menuAction(page, "prod-1", "编辑主机");
    const vals = await page.$$eval(".add-host-dlg input", (els) => els.map((e) => e.value));
    ck.check("编辑表单预填 prod-1", vals.includes("prod-1"), vals.slice(0, 6).join(" / "));
    ck.check("编辑表单预填地址 10.0.0.11", vals.includes("10.0.0.11"), "");
    ck.check("编辑表单预填用户 ops", vals.includes("ops"), "");
    const editInputs = await page.$$(".add-host-dlg input");
    await editInputs[0].fill("prod-1-renamed");
    await page.evaluate(() => [...document.querySelectorAll(".add-host-dlg button")].find((b) => b.textContent.trim() === "保存修改").click());
    await page.waitForTimeout(900);
    ck.check("编辑后主机改名生效", (await hostNames(page)).includes("prod-1-renamed"), (await hostNames(page)).join(" / "));

    // ── 删除确认：取消 ──
    await menuAction(page, "r45-new", "删除主机");
    const dlg = await page.evaluate(() => {
      const d = document.querySelector(".confirm-dialog");
      return d ? d.innerText.replace(/\n+/g, " | ") : null;
    });
    ck.check("删除弹确认对话框", !!dlg && dlg.includes("删除主机"), dlg || "(无)");
    ck.check("确认框说明会话不受影响", !!dlg && dlg.includes("已建立的会话不受影响"), "");
    await page.evaluate(() => [...document.querySelectorAll(".confirm-dialog button")].find((b) => b.textContent.trim() === "取消").click());
    await page.waitForTimeout(500);
    ck.check("取消后主机仍在", (await hostNames(page)).includes("r45-new"));

    // ── 删除确认：确认 ──
    await menuAction(page, "r45-new", "删除主机");
    await page.evaluate(() => [...document.querySelectorAll(".confirm-dialog button")].find((b) => b.textContent.trim() === "删除").click());
    await page.waitForTimeout(800);
    ck.check("确认后主机从列表移除", !(await hostNames(page)).includes("r45-new"), (await hostNames(page)).join(" / "));

    // ── ssh_config 导入预览 ──
    await page.click('.hostbar button[title^="导入"]');
    await page.waitForTimeout(900);
    const imp = await page.evaluate(() => document.querySelector(".hostbar").innerText.replace(/\n+/g, " | "));
    ck.check("导入面板标题「从 ~/.ssh/config 导入」", imp.includes("从 ~/.ssh/config 导入"), "");
    ck.check("预览列出 web-1", imp.includes("web-1"));
    ck.check("预览列出 db-1（含非 22 端口 2222）", imp.includes("db-1") && imp.includes("2222"));
    ck.check("阻断项（proxyjump）标出并给「转手工表单」", imp.includes("阻断") && imp.includes("转手工表单"), "");
    ck.check("缺用户项（nouser）标出并给「转手工表单」", imp.includes("nouser") && imp.includes("未指定登录用户"), "");
    ck.check("已存在主机（prod-1）标为可覆盖", imp.includes("已在主机列表"), "");

    // ── 本地终端一等公民轮：「本机」是内置条目 ──
    // 置顶节不受搜索/标签过滤影响（不过滤链）
    await page.fill(".hb-search input", "zzz-no-match");
    await page.waitForTimeout(500);
    const localStill = await page.evaluate(() => {
      const sec = document.querySelector('[data-testid="local-host-section"]');
      return sec ? sec.innerText.replace(/\n+/g, " ") : null;
    });
    ck.check("搜索无匹配时「本机」节仍置顶在场", !!localStill && localStill.includes("本机"), localStill || "(无节)");
    await page.fill(".hb-search input", "");
    await page.waitForTimeout(500);
    // 卡面：无收藏/编辑/删除钮；徽标「本地」；地址行本地 shell
    const lc = await cardByName(page, "本机");
    ck.check("本机卡在场（置顶节）", !!lc, "");
    await lc.hover();
    await page.waitForTimeout(300);
    const ops = await page.evaluate(() => {
      const card = [...document.querySelectorAll(".host-card")].find((c) => c.querySelector(".host-name")?.textContent.trim() === "本机");
      if (!card) return null;
      return {
        edit: !!card.querySelector('button[title^="编辑主机"]'),
        del: !!card.querySelector('button[title="删除主机"]'),
        fav: !!card.querySelector(".fav-btn"),
        badges: [...card.querySelectorAll(".auth-tag")].map((x) => x.textContent.trim()),
        addr: card.querySelector(".host-addr")?.textContent.trim() ?? "",
      };
    });
    ck.check("本机卡无收藏/编辑/删除钮", !!ops && !ops.edit && !ops.del && !ops.fav, JSON.stringify(ops));
    ck.check("本机卡徽标显「本地」（auth_type 占位不上）", !!ops && ops.badges.includes("本地") && !ops.badges.includes("密钥"), JSON.stringify(ops && ops.badges));
    ck.check("本机卡地址行显本地 shell", !!ops && ops.addr.includes("本地 shell"), ops && ops.addr);
    // 右键菜单：裁剪编辑/删除/收藏，补指定 shell 新开（demo 探测 fixture 5 族）
    await lc.click({ button: "right" });
    await page.waitForTimeout(400);
    const menu = await page.evaluate(() => {
      const m = document.querySelector(".ctx-menu");
      return m ? m.innerText.replace(/\n+/g, " | ") : null;
    });
    ck.check("本机右键无收藏/编辑/删除项", !!menu && !menu.includes("编辑主机") && !menu.includes("删除主机") && !menu.includes("收藏"), menu || "(无)");
    ck.check("本机右键列指定 shell 新开（可注入/无命令块如实标注）",
      !!menu && menu.includes("用 Git Bash 新开") && menu.includes("用 cmd 新开（无命令块）") && menu.includes("连接（新建会话）"), menu || "(无)");
    await page.evaluate(() => document.querySelector(".pop-mask")?.click());
    await page.waitForTimeout(300);
    // 后端同门：demo delete/upsert local 拒绝（LocalHostImmutable 同码同义）
    const delErr = await page.evaluate(async () => {
      try { await window.__demoInvoke?.("delete_host", { id: "local" }); return null; }
      catch (e) { return String(e && e.message || e); }
    });
    ck.check("后端拒绝删除本机", !!delErr && delErr.includes("不可编辑或删除"), delErr || "(未拒)");
    const upErr = await page.evaluate(async () => {
      try { await window.__demoInvoke?.("upsert_host", { host: { id: "local", name: "改名", address: "local", port: 0, username: "x" } }); return null; }
      catch (e) { return String(e && e.message || e); }
    });
    ck.check("后端拒绝编辑本机", !!upErr && upErr.includes("不可编辑或删除"), upErr || "(未拒)");
    ck.check("拒绝后本机仍在列表", (await hostNames(page)).includes("本机"), (await hostNames(page)).join(" / "));
    // 「新开」语义绕过幂等合并：右键「用 Git Bash 新开」连点两次 → 两只标签。
    // （(host_id, actor) 在途合并会把第二次 begin 吞成第一只——不同 shell 的
    // 显式选择会被静默换掉，所以显式入口必须 new_session 绕过）
    const tabs0 = await page.$$eval(".tab", (t) => t.length);
    for (let i = 0; i < 2; i++) {
      await lc.click({ button: "right" });
      await page.waitForTimeout(350);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll(".ctx-menu button")].find((x) => x.textContent.includes("用 Git Bash 新开"));
        if (!b) throw new Error("menuitem not found: 用 Git Bash 新开");
        b.click();
      });
      await page.waitForTimeout(250);
    }
    await page.waitForFunction((n) => document.querySelectorAll(".tab").length >= n, tabs0 + 2, { timeout: 8000 });
    const tabs2 = await page.$$eval(".tab", (t) => t.length);
    ck.check("「新开」两次得两只标签（绕过幂等合并）", tabs2 === tabs0 + 2, `前 ${tabs0} 后 ${tabs2}`);

    // ── 双击本机连接钮只建一条会话（同步在途锁）──
    // 同帧连发两次 click，等价于双击落在 begin_connection 应答前：connectingIds
    // 尚未更新，旧实现会发两次 begin（本机 new_session 又绕过核心幂等）→ 两个终端。
    await page.waitForTimeout(500); // 等上一轮 createSession 的 finally 释放锁
    const tabsBeforeDbl = await page.$$eval(".tab", (t) => t.length);
    await page.evaluate(() => {
      const card = [...document.querySelectorAll(".host-card")]
        .find((c) => c.querySelector(".host-name")?.textContent.trim() === "本机");
      const btn = card?.querySelector(".host-connect-btn");
      if (!btn) throw new Error("local connect button not found");
      btn.click();
      btn.click();
    });
    await page.waitForTimeout(1800);
    const tabsAfterDbl = await page.$$eval(".tab", (t) => t.length);
    ck.check("双击本机连接钮只产生 1 个标签", tabsAfterDbl === tabsBeforeDbl + 1, `前 ${tabsBeforeDbl} 后 ${tabsAfterDbl}`);

    // ── 失败横幅就地「重试连接」：同走本卡 activate，改对地址后重试真能连上 ──
    const clickInCard = (name, sel) => page.evaluate(([n, s]) => {
      const c = [...document.querySelectorAll(".host-card")]
        .find((x) => x.querySelector(".host-name")?.textContent.includes(n));
      c?.querySelector(s)?.click();
    }, [name, sel]);
    await clickInCard("prod-2", ".host-connect-btn");
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      [...document.querySelectorAll(".hk-actions button")].find((b) => b.textContent.includes("信任并连接"))?.click();
    });
    await page.waitForFunction(() => {
      const c = [...document.querySelectorAll(".host-card")]
        .find((x) => x.querySelector(".host-name")?.textContent.includes("prod-2"));
      return !!c?.querySelector(".host-fail");
    }, undefined, { timeout: 10000 });
    const retryBtn = await page.evaluate(() => {
      const c = [...document.querySelectorAll(".host-card")]
        .find((x) => x.querySelector(".host-name")?.textContent.includes("prod-2"));
      const b = c?.querySelector(".host-fail .host-retry-btn");
      return b ? { label: b.getAttribute("aria-label"), disabled: b.disabled, tabIndex: b.tabIndex } : null;
    });
    ck.check("失败横幅有就地「重试连接」（aria-label 指明主机、键盘可达）",
      !!retryBtn && retryBtn.label.includes("prod-2") && !retryBtn.disabled && retryBtn.tabIndex === 0,
      JSON.stringify(retryBtn));
    // 改对地址（10.0.0.12 是 demo 认证失败主机；改成普通地址）后重试 → 成功
    await menuAction(page, "prod-2", "编辑主机");
    await page.waitForTimeout(500);
    await page.fill("#ah-address", "10.0.0.55");
    await page.evaluate(() => [...document.querySelectorAll(".add-host-dlg button")].find((b) => b.textContent.trim() === "保存修改").click());
    await page.waitForTimeout(900);
    const tabsBeforeRetry = await page.$$eval(".tab", (t) => t.length);
    await clickInCard("prod-2", ".host-retry-btn");
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      [...document.querySelectorAll(".hk-actions button")].find((b) => b.textContent.includes("信任并连接"))?.click();
    });
    await page.waitForFunction((n) => document.querySelectorAll(".tab").length > n, tabsBeforeRetry, { timeout: 10000 }).catch(() => {});
    const retried = await page.evaluate(() => {
      const c = [...document.querySelectorAll(".host-card")]
        .find((x) => x.querySelector(".host-name")?.textContent.includes("prod-2"));
      return { addr: c?.querySelector(".host-addr")?.textContent.trim() ?? "", fail: !!c?.querySelector(".host-fail") };
    });
    ck.check("重试连接成功（新会话建立、失败横幅消失）",
      retried.fail === false && (await page.$$eval(".tab", (t) => t.length)) === tabsBeforeRetry + 1,
      JSON.stringify(retried));
  },
};
