// 87 文件管理（GitHub #29 第二阶段）：右键菜单、重命名（no-clobber）、删除（二次确认
// 武装 + 目录不递归 + 符号链接删链接本身）。破坏性动作的安全语义全部在这里钉住：
// 一点即删、静默覆盖、递归删子树、把链接误当目录，任一复发本 spec 必红。

const openFiles = async (page) => {
  await page.click('[data-testid="rb-files"]');
  await page.waitForTimeout(900);
};

const names = (page) => page.$$eval(".sftp-row .sftp-name", (els) => els.map((e) => e.textContent.trim()));
const menuOpen = (page) => page.evaluate(() => !!document.querySelector("[data-testid=sftp-menu]"));
const hasBox = (page) => page.evaluate(() => !!document.querySelector("[data-testid=sftp-rename-box]"));
// 多条 toast 可能并存（前一步的还没退场）——取全体文本，断言「含某原因」而非「唯一」
const errText = (page) => page.evaluate(() =>
  [...document.querySelectorAll(".toast.err")].map((e) => e.textContent).join(" | "));
const delBtn = (page) => page.evaluate(() => {
  const b = document.querySelector("[data-testid=sftp-menu-delete]");
  return b ? { text: b.textContent.trim(), armed: b.classList.contains("tm-danger-armed") } : null;
});
const rightClick = async (page, name) => {
  await page.click(`.sftp-row[data-name="${name}"]`, { button: "right" });
  await page.waitForTimeout(400);
};

module.exports = {
  title: "文件管理：右键菜单 / 重命名不覆盖 / 删除二次确认与目录保护",
  async run({ page, ck }) {
    const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
    await card.hover();
    await page.waitForTimeout(200);
    await (await card.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1300);
    await openFiles(page);

    // ── 右键开菜单（#29 新增 onContextMenu；此前只有双击一条路）──
    await rightClick(page, "error.log");
    ck.check("右键文件行弹出动作菜单", await menuOpen(page));
    ck.check("菜单含复制文件名/复制路径", await page.evaluate(() =>
      !!document.querySelector("[data-testid=sftp-menu-copyname]") && !!document.querySelector("[data-testid=sftp-menu-copypath]")));
    ck.check("菜单含重命名/删除", await page.evaluate(() =>
      !!document.querySelector("[data-testid=sftp-menu-rename]") && !!document.querySelector("[data-testid=sftp-menu-delete]")));
    ck.check("文件菜单保留下载/另存为", await page.evaluate(() =>
      !!document.querySelector("[data-testid=sftp-menu-download]") && !!document.querySelector("[data-testid=sftp-menu-saveas]")));

    // ── 重命名输入里的 Esc 只取消重命名，不连带关掉整个菜单 ──
    // （keymap 对 .sftp-rename-input 整段全拦；漏拦时 Esc 会走浮层链把菜单一起关掉）
    await page.click("[data-testid=sftp-menu-rename]");
    await page.waitForTimeout(300);
    ck.check("点重命名出现改名输入行", await hasBox(page));
    ck.eq("输入框预填当前名", await page.inputValue("[data-testid=sftp-rename-input]"), "error.log");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    ck.check("Esc 收起改名输入行", !(await hasBox(page)));
    ck.check("Esc 后动作菜单仍在（只取消重命名，不关菜单）", await menuOpen(page));

    // ── no-clobber：改成已存在的名字必须被拒，且两个文件都不动 ──
    await page.click("[data-testid=sftp-menu-rename]");
    await page.waitForTimeout(250);
    await page.fill("[data-testid=sftp-rename-input]", "access.log");
    await page.click("[data-testid=sftp-rename-ok]");
    await page.waitForTimeout(600);
    const clobberErr = await errText(page);
    ck.check("重命名到已存在名被拒并如实报因（目标已存在）", clobberErr.includes("目标已存在"), clobberErr || "(无错误 toast)");
    const afterClobber = await names(page);
    ck.check("no-clobber：源文件 error.log 未被改动", afterClobber.includes("error.log"), afterClobber.join(" / "));
    ck.check("no-clobber：目标 access.log 未被覆盖", afterClobber.includes("access.log"), afterClobber.join(" / "));
    ck.check("改名失败不关菜单（用户可就地改正）", await menuOpen(page));

    // ── 正常改名：Enter 提交，列表换名 ──
    await page.fill("[data-testid=sftp-rename-input]", "error-renamed.log");
    await page.press("[data-testid=sftp-rename-input]", "Enter");
    await page.waitForTimeout(800);
    const afterRename = await names(page);
    ck.check("重命名成功：新名出现在列表", afterRename.includes("error-renamed.log"), afterRename.join(" / "));
    ck.check("重命名成功：旧名不再出现", !afterRename.includes("error.log"), afterRename.join(" / "));
    ck.check("重命名成功后菜单关闭", !(await menuOpen(page)));

    // ── 删除二次确认：第一点只武装，绝不落地 ──
    await rightClick(page, "error-renamed.log");
    const d0 = await delBtn(page);
    ck.check("删除钮初始未武装", !!d0 && !d0.armed && d0.text === "删除", JSON.stringify(d0));
    await page.click("[data-testid=sftp-menu-delete]");
    await page.waitForTimeout(300);
    const d1 = await delBtn(page);
    ck.check("第一点进入武装态（文案「确认删除」+ armed 样式）",
      !!d1 && d1.armed && d1.text === "确认删除", JSON.stringify(d1));
    ck.check("第一点不删除：文件仍在列表", (await names(page)).includes("error-renamed.log"));
    await page.click("[data-testid=sftp-menu-delete]");
    await page.waitForTimeout(800);
    const afterDel = await names(page);
    ck.check("第二点才真删除：文件消失", !afterDel.includes("error-renamed.log"), afterDel.join(" / "));
    ck.check("删除后菜单关闭", !(await menuOpen(page)));

    // ── 目录：菜单不给下载/另存为；非空目录删不掉，子树一个不动 ──
    await rightClick(page, "archive");
    ck.check("目录菜单隐藏下载/另存为", await page.evaluate(() =>
      !document.querySelector("[data-testid=sftp-menu-download]") && !document.querySelector("[data-testid=sftp-menu-saveas]")));
    await page.click("[data-testid=sftp-menu-delete]");
    await page.waitForTimeout(250);
    await page.click("[data-testid=sftp-menu-delete]");
    await page.waitForTimeout(700);
    const dirErr = await errText(page);
    ck.check("非空目录删除被拒并如实报因（目录非空）", dirErr.includes("目录非空"), dirErr || "(无错误 toast)");
    ck.check("非空目录未被删除（不递归）", (await names(page)).includes("archive"));
    ck.check("目录删除失败不关菜单", await menuOpen(page));

    // ── 武装态不跨目标传染：换文件后必须是未武装（否则一点即删）──
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await rightClick(page, "access.log");
    const d2 = await delBtn(page);
    ck.check("换目标后武装态复位（不把上一个文件的已武装带过来）",
      !!d2 && !d2.armed && d2.text === "删除", JSON.stringify(d2));

    // ── 符号链接：删链接本身，目标目录毫发无损 ──
    // （后端按 lstat 的 kind 路由，Symlink 走 remove_file；demo 曾拿「是否目录键」
    //  当判据，把 latest 误判成目录而报「目录非空」——此断言钉住该保真分叉）
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await rightClick(page, "latest");
    await page.click("[data-testid=sftp-menu-delete]");
    await page.waitForTimeout(250);
    await page.click("[data-testid=sftp-menu-delete]");
    await page.waitForTimeout(800);
    const afterLink = await names(page);
    ck.check("符号链接本身被删除", !afterLink.includes("latest"), afterLink.join(" / "));
    ck.check("删链接不伤目标目录 archive", afterLink.includes("archive"), afterLink.join(" / "));
  },
};