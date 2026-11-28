// 112 文件管理（GitHub #29 第三阶段 / KI-151）：新建文件夹。此前整条 SFTP 链路没有建目录
// 动作——文件面板只能浏览/上传/下载/改名/删除，开个目录得回终端敲 mkdir。本 spec 钉住
// 入口与安全语义：同名条目（文件、符号链接也算）必须被拒而不是静默进入既有目录、名称里的
// 路径分隔符不得拼进路径、Esc 只收输入行不连带关掉别的浮层、换会话不保留半截输入；新建的
// 文件夹进得了/改得名/删得掉（叠加层与重列同源，不是只在列表里画一行）。

const INPUT = "[data-testid=sftp-mkdir-input]";
const OK = "[data-testid=sftp-mkdir-ok]";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

const connect = async (page) => {
  const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
  await card.hover();
  await page.waitForTimeout(250);
  await (await card.$(".host-connect-btn")).click();
  await page.waitForTimeout(1300);
};
const openFiles = async (page) => {
  await page.click('[data-testid="rb-files"]');
  await page.waitForTimeout(900);
};
const names = (page) => page.$$eval(".sftp-row .sftp-name", (els) => els.map((e) => e.textContent.trim()));
const boxOpen = (page) => page.evaluate(() => !!document.querySelector("[data-testid=sftp-mkdir-box]"));
const menuOpen = (page) => page.evaluate(() => !!document.querySelector("[data-testid=sftp-menu]"));
const panelOpen = (page, title = "远程文件") => page.evaluate((title) =>
  document.querySelector(".task-panel h4")?.textContent === title, title);
const isEmptyDir = (page) => page.evaluate(() =>
  [...document.querySelectorAll(".task-panel .side-quiet")].some((e) => e.textContent.trim() === "空目录。"));
const curCrumb = (page) => page.evaluate(() =>
  document.querySelector("[data-testid=sftp-crumbs] .sftp-crumb.cur")?.textContent.trim() ?? null);
const okDisabled = (page) => page.evaluate((sel) => document.querySelector(sel)?.disabled ?? null, OK);
/** 新建文件夹钮的开合态读数。 */
const btnState = (page) => page.evaluate(() => {
  const b = document.querySelector("[data-testid=sftp-mkdir-btn]");
  return b ? { pressed: b.getAttribute("aria-pressed"), disabled: b.disabled, title: b.title, label: b.getAttribute("aria-label") } : null;
});
const openRow = async (page) => {
  await page.click("[data-testid=sftp-mkdir-btn]");
  await page.waitForSelector("[data-testid=sftp-mkdir-box]", { timeout: 3000 });
  await page.waitForTimeout(200);
};
/** 填名并回车提交，等回包 + 重列。 */
const submit = async (page, text) => {
  await page.fill(INPUT, text);
  await page.press(INPUT, "Enter");
  await page.waitForTimeout(800);
};
const rightClick = async (page, name) => {
  await page.click(`.sftp-row[data-name="${name}"]`, { button: "right" });
  await page.waitForTimeout(400);
};
/** 右键 → 重命名 → 回车（spec 87 已钉重命名自身的语义，这里只当工具用）。 */
const renameViaMenu = async (page, from, to) => {
  await rightClick(page, from);
  await page.click("[data-testid=sftp-menu-rename]");
  await page.waitForSelector("[data-testid=sftp-rename-input]", { timeout: 3000 });
  await page.fill("[data-testid=sftp-rename-input]", to);
  await page.press("[data-testid=sftp-rename-input]", "Enter");
  await page.waitForTimeout(800);
};
/** 右键 → 删除（二次确认，点两下）。 */
const deleteViaMenu = async (page, name) => {
  await rightClick(page, name);
  await page.click("[data-testid=sftp-menu-delete]");
  await page.waitForTimeout(300);
  await page.click("[data-testid=sftp-menu-delete]");
  await page.waitForTimeout(800);
};
// toast 的 DOM 只有 2.6–6s 生命，evaluate 往返可能错过；DEV 探针 __t_toasts 留有限历史
const clearToasts = (page) => page.evaluate(() => { window.__t_toasts = []; });
const toastLog = (page, kind) => page.evaluate((kind) =>
  (window.__t_toasts ?? []).filter((x) => !kind || x.kind === kind).map((x) => x.text), kind);
/** 导航行布局读数：方钮是否同一行、面板有无横向溢出。 */
const navLayout = (page) => page.evaluate(() => {
  const nav = document.querySelector(".sftp-nav");
  const btns = [...nav.querySelectorAll("button")];
  const panel = document.querySelector(".task-panel");
  return { count: btns.length, tops: [...new Set(btns.map((b) => b.offsetTop))], overflow: panel.scrollWidth - panel.clientWidth };
});

module.exports = {
  title: "文件管理：新建文件夹（同名不覆盖 / 基名校验 / Esc 只收输入行 / 手机竖屏）",
  async run({ page, browser, ck, BASE }) {
    await connect(page);
    const sid = await page.evaluate(() => document.querySelector(".tab.tab-active")?.dataset.sid ?? null);
    await openFiles(page);
    const base = await names(page);
    ck.eq("前置：连上本机后面板列出简报目录（目录在前、名称序）", base.join(" / "), "archive / access.log / error.log / latest / php-fpm.sock");

    // ── A 入口：导航行里的开合钮 + 一行内联输入 ──
    const s0 = await btnState(page);
    ck.check("导航行有「新建文件夹」按钮", !!s0);
    ck.check("按钮在导航行（与刷新/上传同一排）", await page.evaluate(() =>
      document.querySelector("[data-testid=sftp-mkdir-btn]")?.parentElement?.classList.contains("sftp-nav") ?? false));
    ck.eq("默认未开合（aria-pressed=false）", s0?.pressed, "false");
    ck.check("悬停提示写明安全语义（同名拒绝、不覆盖）", (s0?.title ?? "").includes("同名条目已存在会被拒绝") && (s0?.title ?? "").includes("不覆盖"), s0?.title);
    ck.eq("无障碍名称", s0?.label, "新建文件夹");
    ck.check("未点开时没有输入行", !(await boxOpen(page)));
    let lay = await navLayout(page);
    ck.check(`导航行 ${lay.count} 颗方钮同一行（不换行）`, lay.count === 9 && lay.tops.length === 1, `offsetTop=${lay.tops.join(",")}`);
    ck.eq("面板无横向溢出", lay.overflow, 0);
    await openRow(page);
    ck.check("点开出现输入行", await boxOpen(page));
    ck.eq("开合态同步到按钮", (await btnState(page))?.pressed, "true");
    ck.check("输入行自动聚焦", await page.evaluate(() => document.activeElement?.classList.contains("sftp-mkdir-input") ?? false));
    ck.eq("占位符", await page.getAttribute(INPUT, "placeholder"), "新文件夹名称");
    ck.eq("名称为空时「创建」禁用", await okDisabled(page), true);
    await page.click("[data-testid=sftp-mkdir-btn]");
    await page.waitForTimeout(250);
    ck.check("再点一次收起输入行（同一颗钮开合）", !(await boxOpen(page)));

    // ── B Esc 只收这一行：右键不移动焦点，输入行聚焦时动作菜单可以同时开着——
    // 捕获层若不豁免，Esc 会先走浮层链把菜单关掉，输入行反而留着 ──
    await openRow(page);
    await page.fill(INPUT, "scratch");
    await rightClick(page, "error.log");
    ck.check("前置：文件动作菜单开着", await menuOpen(page));
    await page.focus(INPUT);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    ck.check("Esc 收起新建文件夹输入行", !(await boxOpen(page)));
    ck.check("Esc 后文件面板仍在", await panelOpen(page));
    ck.check("Esc 只收输入行，不连带关掉动作菜单", await menuOpen(page));
    ck.check("Esc 不建目录（未提交的名称不落地）", !(await names(page)).includes("scratch"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    ck.check("再按一次 Esc 才关动作菜单", !(await menuOpen(page)));

    // ── C 名称是基名：路径分隔符 / . / .. 一律拒绝，不借建目录做路径穿越 ──
    await openRow(page);
    for (const bad of ["a/b", "a\\b", ".."]) {
      await clearToasts(page);
      await submit(page, bad);
      const log = await toastLog(page, "err");
      ck.check(`名称「${bad}」被拒并如实报因`, log.some((s) => s.includes("文件夹名称无效")), log.join(" | ") || "(无错误 toast)");
      ck.check("被拒不收起输入行（可就地改名）", await boxOpen(page));
    }
    ck.eq("被拒后名称留在输入框（不吞用户输入）", await page.inputValue(INPUT), "..");
    const c1 = await names(page);
    ck.eq("被拒不建半截目录（列表零改动）", c1.join(" / "), base.join(" / "));
    await clearToasts(page);
    await page.fill(INPUT, "   ");
    ck.eq("纯空白名「创建」禁用", await okDisabled(page), true);
    await page.press(INPUT, "Enter");
    await page.waitForTimeout(500);
    ck.check("纯空白名回车不提交（无提示、行不收）", (await boxOpen(page)) && (await toastLog(page)).length === 0);

    // ── D no-clobber：同名条目已存在必须被拒——目录、文件都算占位 ──
    for (const taken of ["archive", "access.log"]) {
      await clearToasts(page);
      await submit(page, taken);
      const log = await toastLog(page, "err");
      const want = `目标已存在，未创建：/var/log/nginx/${taken}`;
      ck.check(`同名${taken === "archive" ? "目录" : "文件"}占位被拒，报出目标全路径`,
        log.some((s) => s.includes(want)), log.join(" | ") || "(无错误 toast)");
      ck.check("被拒不收起输入行", await boxOpen(page));
      ck.eq("被拒没有成功提示", (await toastLog(page, "ok")).length, 0);
    }
    ck.eq("no-clobber：列表零改动", (await names(page)).join(" / "), base.join(" / "));

    // ── E 成功：首尾空白裁掉，回车提交；重列后立即可进 ──
    await clearToasts(page);
    await submit(page, "  deploy-new  ");
    ck.check("创建成功收起输入行", !(await boxOpen(page)));
    const okLog = await toastLog(page, "ok");
    ck.check("成功提示报出文件夹名（裁掉首尾空白）", okLog.some((s) => s.includes("已创建文件夹 deploy-new")), okLog.join(" | "));
    ck.eq("开合态复位", (await btnState(page))?.pressed, "false");
    const created = await names(page);
    ck.eq("新文件夹出现在列表（目录在前、名称序：紧随 archive）", created.indexOf("deploy-new"), 1);
    ck.eq("原有条目一个不少", created.length, base.length + 1);
    const rowInfo = await page.evaluate(() => {
      const r = document.querySelector('.sftp-row[data-name="deploy-new"]');
      return r ? { dir: r.classList.contains("dir"), type: r.querySelector(".sftp-size")?.textContent.trim() } : null;
    });
    ck.check("新条目按目录呈现（行样式与类型列一致）", !!rowInfo && rowInfo.dir && rowInfo.type === "目录", JSON.stringify(rowInfo));
    ck.check("仍在原目录：新行整行在列表可视区内（长列表见 K2）", await page.evaluate(() => {
      const r = document.querySelector('.sftp-row[data-name="deploy-new"]');
      const list = document.querySelector("[data-testid=sftp-list]");
      if (!r || !list) return false;
      const a = r.getBoundingClientRect(), b = list.getBoundingClientRect();
      return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    }));
    await page.dblclick('.sftp-row.dir[data-name="deploy-new"]');
    await page.waitForTimeout(800);
    ck.eq("双击进入新目录（面包屑末段）", await curCrumb(page), "deploy-new");
    ck.check("新目录是空的", await isEmptyDir(page));
    lay = await navLayout(page);
    ck.check("面包屑加深后导航行仍不换行", lay.tops.length === 1, `offsetTop=${lay.tops.join(",")}`);

    // ── F 新目录是真目录：嵌套新建、随父目录改名迁移、删除后原名可重建 ──
    await openRow(page);
    await page.fill(INPUT, "inner");
    await page.click(OK);
    await page.waitForTimeout(800);
    ck.eq("在新目录里再建一层（「创建」钮路径）", (await names(page)).join(","), "inner");
    ck.check("嵌套创建后输入行收起", !(await boxOpen(page)));
    await page.click('.sftp-crumb:text-is("nginx")');
    await page.waitForTimeout(800);
    ck.check("面包屑回到上级：新文件夹仍在", (await names(page)).includes("deploy-new"));
    await renameViaMenu(page, "deploy-new", "renamed-dir");
    const renamed = await names(page);
    ck.check("新建的文件夹可被重命名", renamed.includes("renamed-dir") && !renamed.includes("deploy-new"), renamed.join(" / "));
    await page.dblclick('.sftp-row.dir[data-name="renamed-dir"]');
    await page.waitForTimeout(800);
    ck.eq("子文件夹随父目录改名一起迁移", (await names(page)).join(","), "inner");
    await deleteViaMenu(page, "inner");
    ck.check("新建的子文件夹删得掉（删后为空目录）", await isEmptyDir(page));
    await page.click('.sftp-crumb:text-is("nginx")');
    await page.waitForTimeout(800);
    await deleteViaMenu(page, "renamed-dir");
    ck.check("空了的新建文件夹删得掉", !(await names(page)).includes("renamed-dir"));
    await openRow(page);
    await submit(page, "renamed-dir");
    ck.check("删掉的名字可以原地重建（旧删除不误伤新目录）", (await names(page)).includes("renamed-dir") && !(await boxOpen(page)));
    await page.dblclick('.sftp-row.dir[data-name="renamed-dir"]');
    await page.waitForTimeout(800);
    ck.eq("重建的目录进得去（路径解析不被旧删除记录拦下）", await curCrumb(page), "renamed-dir");
    ck.check("重建的目录是空的", await isEmptyDir(page));
    await page.click('.sftp-crumb:text-is("nginx")');
    await page.waitForTimeout(800);
    ck.eq("回到简报目录", (await names(page)).join(" / "), [...base.slice(0, 1), "renamed-dir", ...base.slice(1)].join(" / "));
    const audit = await page.evaluate(async () => {
      const r = await window.__demoInvoke("audit_query", { action: "sftp_mkdir", limit: 50 });
      return (r?.events ?? []).map((e) => ({ actor: e.actor_kind, sid: e.session_id, path: e.payload_json?.path, ok: e.payload_json?.ok }));
    });
    ck.eq("每次创建入审计（人类、带会话、创建时的全路径、ok=true；最新在前）", JSON.stringify(audit), JSON.stringify([
      { actor: "human", sid, path: "/var/log/nginx/renamed-dir", ok: true },
      { actor: "human", sid, path: "/var/log/nginx/deploy-new/inner", ok: true },
      { actor: "human", sid, path: "/var/log/nginx/deploy-new", ok: true },
    ]));

    // ── G 目标目录以提交时为准：开着输入行去别处，建在提交那一刻所在的目录 ──
    await openRow(page);
    await page.fill(INPUT, "in-archive");
    await page.dblclick('.sftp-row.dir[data-name="archive"]');
    await page.waitForTimeout(800);
    ck.check("导航不收输入行（键入的名称还在）", (await boxOpen(page)) && (await page.inputValue(INPUT)) === "in-archive");
    await clearToasts(page);
    await page.press(INPUT, "Enter");
    await page.waitForTimeout(800);
    // archive 里原有 access-202609.log.gz：新目录按「目录在前」排在它上面
    ck.eq("提交落在提交时所在的目录（archive 下）", (await names(page)).join(","), "in-archive,access-202609.log.gz");
    ck.eq("提交时所在目录没变", await curCrumb(page), "archive");
    ck.check("提交成功收起输入行", !(await boxOpen(page)));
    await deleteViaMenu(page, "in-archive");
    ck.eq("清理：archive 恢复原样", (await names(page)).join(","), "access-202609.log.gz");
    await page.click('.sftp-crumb:text-is("nginx")');
    await page.waitForTimeout(800);
    ck.eq("回到简报目录（后面的用例都从这里出发）", (await names(page)).join(" / "), [...base.slice(0, 1), "renamed-dir", ...base.slice(1)].join(" / "));

    // ── H 换会话就收起：这一行始终作用于「当前会话的当前目录」，不跨会话保留半截输入 ──
    await openRow(page);
    await page.fill(INPUT, "half-typed");
    await page.click('.tab[data-sid="s-demo-0001"]');
    await page.waitForTimeout(900);
    ck.check("切到别的会话：输入行收起", !(await boxOpen(page)));
    await page.click(`.tab[data-sid="${sid}"]`);
    await page.waitForTimeout(900);
    ck.check("切回来仍是收起状态（半截输入不复活）", !(await boxOpen(page)));
    ck.check("切回来列表完好", (await names(page)).join(" / ") === [...base.slice(0, 1), "renamed-dir", ...base.slice(1)].join(" / "), (await names(page)).join(" / "));

    // ── I 镜像后端里 UI 到不了的分支（直接探针）：与 core-session r29 用例同一失败面 ──
    const mirror = await page.evaluate(async (sid) => {
      const call = async (dir, name) => {
        try { await window.__demoInvoke("sftp_mkdir", { sid, dir, name }); return { ok: true }; }
        catch (e) { return { ok: false, kind: e?.kind ?? String(e), message: e?.message ?? String(e), detail: e?.detail ?? null }; }
      };
      const newestPath = async () => {
        const r = await window.__demoInvoke("audit_query", { action: "sftp_mkdir", limit: 1 });
        return r?.events?.[0]?.payload_json?.path ?? null;
      };
      const kind = async (p) => (await window.__demoInvoke("sftp_stat", { sid, path: p }))?.kind ?? null;
      return {
        priv: await call("/var/private", "x"),
        noParent: await call("/var/log/nope", "x"),
        relative: await call("relative", "x"),
        emptyDir: await call("", "x"),
        // 绝对目录判定的口径（与 core-session r29 用例同一批样本）：相对路径带斜杠也
        // 不算绝对；Windows 形态（规范路径 / 盘符 / UNC）算绝对——演示树里没有这些
        // 目录，应落到「父目录不存在」而不是入口拒绝；只带盘符的 C:foo 照拒
        relSlash: await call("a/b", "x"),
        driveOnly: await call("C:", "x"),
        driveRel: await call("c:rel", "x"),
        winVerbatim: await call("\\\\?\\C:\\Users\\u", "x"),
        winDrive: await call("C:\\Users\\u", "x"),
        winUnc: await call("\\\\server\\share\\dir", "x"),
        symlink: await call("/var/log/nginx", "latest"),
        trailing: await call("/var/log/nginx/", "trailing-slash"),
        trailingPath: await newestPath(),
        trailingKind: await kind("/var/log/nginx/trailing-slash"),
        root: await call("/", "at-root"),
        rootPath: await newestPath(),
        rootKind: await kind("/at-root"),
      };
    }, sid);
    ck.check("权限不足：可区别错误 sftp_permission_denied（带出错路径）",
      mirror.priv.kind === "sftp_permission_denied" && mirror.priv.detail?.path === "/var/private/x", JSON.stringify(mirror.priv));
    ck.eq("父目录不存在：sftp_path_not_found（不递归造路径）", mirror.noParent.kind, "sftp_path_not_found");
    ck.eq("相对目录拒收", mirror.relative.kind, "invalid_input");
    ck.eq("空目录串拒收", mirror.emptyDir.kind, "invalid_input");
    ck.eq("相对路径带斜杠：仍判路径无效（不算绝对目录）", mirror.relSlash.kind, "invalid_input");
    ck.eq("只带盘符 C:：判路径无效", mirror.driveOnly.kind, "invalid_input");
    ck.eq("盘符相对路径 c:rel：判路径无效", mirror.driveRel.kind, "invalid_input");
    for (const [label, v] of [["\\\\?\\ 规范路径", mirror.winVerbatim], ["盘符路径", mirror.winDrive], ["UNC 路径", mirror.winUnc]]) {
      ck.check(`Windows 形态的绝对目录（${label}）：入口放行，演示树里没有 → 父目录不存在`,
        v.kind === "sftp_path_not_found", JSON.stringify(v));
    }
    ck.check("符号链接也算占位（lstat 语义，不跟随）", mirror.symlink.kind === "invalid_input" && (mirror.symlink.message ?? "").includes("目标已存在，未创建：/var/log/nginx/latest"), JSON.stringify(mirror.symlink));
    ck.check("目录带尾斜杠：拼出的全路径不出现双斜杠，建出来的是目录",
      mirror.trailing.ok && mirror.trailingPath === "/var/log/nginx/trailing-slash" && mirror.trailingKind === "dir",
      JSON.stringify([mirror.trailing, mirror.trailingPath, mirror.trailingKind]));
    ck.check("根目录下新建：路径拼成 /名称",
      mirror.root.ok && mirror.rootPath === "/at-root" && mirror.rootKind === "dir",
      JSON.stringify([mirror.root, mirror.rootPath, mirror.rootKind]));

    // ── J 英文界面：新增文案全部有译 ──
    const en = await browser.newPage();
    const enErrors = [];
    en.on("pageerror", (e) => enErrors.push(String(e.message).slice(0, 160)));
    await en.addInitScript(() => { try { localStorage.setItem("ui.v2.locale", "en"); } catch { /* ignore */ } });
    await en.goto(BASE, { waitUntil: "networkidle" });
    await en.waitForSelector(".hostbar", { timeout: 30000 });
    await en.waitForTimeout(800);
    await connect(en);
    await openFiles(en);
    const enBtn = await btnState(en);
    ck.eq("en：按钮无障碍名称", enBtn?.label, "New folder");
    ck.eq("en：按钮悬停提示", enBtn?.title, "New folder (in the current directory; an existing entry of the same name is rejected, never overwritten)");
    await openRow(en);
    ck.eq("en：占位符", await en.getAttribute(INPUT, "placeholder"), "New folder name");
    ck.eq("en：「创建」钮文案", (await en.textContent(OK))?.trim(), "Create");
    await clearToasts(en);
    await submit(en, "en-folder");
    const enOk = await toastLog(en, "ok");
    ck.eq("en：成功提示", enOk.filter((s) => s.startsWith("Created folder")).join("|"), "Created folder en-folder");
    ck.check("en：无页面 JS 错误", enErrors.length === 0, enErrors.join(" | "));
    await en.context().close();

    // ── K 面板最窄（320）：导航行 9 颗方钮不换行、无横向溢出 ──
    const nctx = await browser.newContext({ viewport: { width: 1180, height: 760 }, locale: "zh-CN" });
    await nctx.addInitScript(() => { try { localStorage.setItem("ui.taskpanel_w", "320"); } catch { /* ignore */ } });
    const np = await nctx.newPage();
    const nErrors = [];
    np.on("pageerror", (e) => nErrors.push(String(e.message).slice(0, 160)));
    await np.goto(BASE, { waitUntil: "networkidle" });
    await np.waitForSelector(".hostbar", { timeout: 30000 });
    await np.waitForTimeout(600);
    await connect(np);
    await openFiles(np);
    ck.eq("前置：面板宽度收到下限 320", Math.round((await np.locator(".task-panel").boundingBox()).width), 320);
    lay = await navLayout(np);
    ck.check("320 宽：导航行方钮同一行", lay.tops.length === 1, `offsetTop=${lay.tops.join(",")}`);
    ck.eq("320 宽：面板无横向溢出", lay.overflow, 0);
    await openRow(np);
    await np.fill(INPUT, "一个名字比较长的新文件夹-用来确认输入框自己横向滚动");
    lay = await navLayout(np);
    ck.check("320 宽：长名不撑破面板（输入框内滚动、「创建」钮仍在）", lay.overflow === 0 && (await okDisabled(np)) === false);
    await np.press(INPUT, "Escape");
    await np.waitForTimeout(250);

    // ── K2 长列表：demo 没有大目录，给面板限高模拟「新行落在折叠线以下」——创建后要滚入视野 ──
    const nsid = await np.evaluate(() => document.querySelector(".tab.tab-active")?.dataset.sid ?? null);
    await np.evaluate(async (sid) => {
      for (let i = 1; i <= 9; i++) await window.__demoInvoke("sftp_mkdir", { sid, dir: "/var/log/nginx", name: `a${i}` });
    }, nsid);
    await np.addStyleTag({ content: ".task-panel:not(.tp-full){max-height:300px !important}" });
    await np.click('.sftp-nav button[aria-label="刷新"]');
    await np.waitForTimeout(900);
    /** 某一行相对面板滚动容器（.tp-scroll）是否整行可见。 */
    const inScroller = (name) => np.evaluate((name) => {
      const row = [...document.querySelectorAll(".sftp-row")].find((r) => r.dataset.name === name);
      const sc = document.querySelector(".tp-scroll");
      if (!row || !sc) return null;
      const r = row.getBoundingClientRect(), s = sc.getBoundingClientRect();
      return { visible: r.top >= s.top - 1 && r.bottom <= s.bottom + 1, scrollTop: sc.scrollTop };
    }, name);
    ck.eq("前置：面板限高后列表可滚动（末行在折叠线以下）", (await inScroller("php-fpm.sock"))?.visible, false);
    await openRow(np);
    await submit(np, "b-new");
    const scrolled = await inScroller("b-new");
    ck.check("新行落在折叠线以下时自动滚入视野（只滚到刚好可见）",
      !!scrolled && scrolled.visible && scrolled.scrollTop > 0, JSON.stringify(scrolled));
    ck.check("320 宽：无页面 JS 错误", nErrors.length === 0, nErrors.join(" | "));
    await nctx.close();

    // ── L 手机竖屏（390×844，触屏）：右缘竖栏隐藏，入口在「工具」菜单；开合钮与输入行可用 ──
    const mctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, locale: "zh-CN", isMobile: true, hasTouch: true, userAgent: ANDROID_UA,
    });
    const mp = await mctx.newPage();
    const mErrors = [];
    mp.on("pageerror", (e) => mErrors.push(String(e.message).slice(0, 160)));
    await mp.goto(BASE, { waitUntil: "networkidle" });
    await mp.waitForSelector(".hostbar", { timeout: 30000 });
    await mp.waitForTimeout(600);
    await (await mp.$('.host-card:has(.host-name:text-is("本机"))')).tap();
    await mp.waitForTimeout(1400);
    await mp.tap(".session-toolbar button:has-text('工具')");
    await mp.waitForTimeout(400);
    await mp.tap('[data-testid="tools-files"]');
    await mp.waitForTimeout(1000);
    ck.check("手机竖屏：文件面板完整视图打开", await panelOpen(mp));
    lay = await navLayout(mp);
    ck.check("手机竖屏：导航行方钮同一行", lay.tops.length === 1, `offsetTop=${lay.tops.join(",")}`);
    ck.eq("手机竖屏：面板无横向溢出", lay.overflow, 0);
    await mp.tap('[data-testid="sftp-mkdir-btn"]');
    await mp.waitForSelector("[data-testid=sftp-mkdir-box]", { timeout: 3000 });
    const inView = await mp.evaluate((sel) => {
      const els = [document.querySelector(sel), document.querySelector("[data-testid=sftp-mkdir-ok]")];
      return els.map((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.width > 0; });
    }, INPUT);
    ck.check("手机竖屏：输入框与「创建」钮都在视口内", inView.every(Boolean), JSON.stringify(inView));
    await mp.fill(INPUT, "mobile-dir");
    await mp.tap(OK);
    await mp.waitForTimeout(800);
    ck.eq("手机竖屏：点「创建」建成并重列", (await names(mp)).join(" / "), [...base.slice(0, 1), "mobile-dir", ...base.slice(1)].join(" / "));
    ck.check("手机竖屏：无页面 JS 错误", mErrors.length === 0, mErrors.join(" | "));
    await mctx.close();
  },
};
