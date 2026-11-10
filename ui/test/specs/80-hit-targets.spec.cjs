// 80 点击目标命中区：短边 <24px 的常用钮必须有 ≥28×28 的可点区域（WCAG 2.5.8）
// 走查（2026-11-10）实测漏网：主机卡「更多」23×19、主机「连接」36×20、状态栏入口
// 18 高、资源采样暂停 20×20、toast 关闭 15×13、文件面包屑 17 高、行内下载 20 高。
// 沿用仓库既有工艺（R27：::after 透明扩展命中盒，不动视觉盒与布局），本轮补齐。
// 断言用 elementFromPoint：在视觉盒外 4–7px 取点，命中必须仍归该钮。
module.exports = {
  title: "点击目标：小钮的透明命中区 ≥28×28（视觉尺寸不变）",
  async run({ page, ck, BASE }) {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.setItem("ui.ui_font_scale", "1"));
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1200);

    // hit(选择器, 水平偏移, 垂直偏移, 限定主机卡名?)：在视觉盒外的点上取 elementFromPoint
    const hit = (sel, dx, dy, inCard = null) => page.evaluate(([s, x, y, name]) => {
      let root = document;
      if (name) {
        root = [...document.querySelectorAll(".host-card")]
          .find((c) => c.querySelector(".host-name")?.textContent.trim() === name) ?? null;
        if (!root) return { sel: s, missing: true };
      }
      const el = root.querySelector(s);
      if (!el) return { sel: s, missing: true };
      const r = el.getBoundingClientRect();
      const px = r.left + r.width / 2 + x;
      const py = r.top + r.height / 2 + y;
      const got = document.elementFromPoint(px, py);
      return {
        sel: s, ok: got === el || el.contains(got),
        box: [r.width, r.height].map((n) => Math.round(n)),
        at: [Math.round(px), Math.round(py)],
        got: got ? (got.className || got.tagName) + "" : null,
      };
    }, [sel, dx, dy, inCard]);

    // 主机卡操作组（hover 后可见）；必须钉在 prod-1 这张卡上——其它卡的操作组虽
    // opacity:0 但仍在布局里，裸选择器会量到未悬停卡上的钮（elementFromPoint 跳过
    // pointer-events:none，自然判失败）。取点一律落在视觉盒**外**（探针 14 实测
    // 各钮向中心外可达 17–18px，这里按 2–3px 外扩留余量）
    const CARD = '.host-card:has(.host-name:text-is("prod-1"))';
    const card = await page.$(CARD);
    if (!card) throw new Error("host card not found: prod-1");
    await card.hover();
    await page.waitForTimeout(300);
    const moreTop = await hit(".host-more-btn", 0, -15, "prod-1");
    const moreBottom = await hit(".host-more-btn", 0, 15, "prod-1");
    ck.check("主机卡「更多」：视觉盒（25 高）外 2.5px 仍命中",
      moreTop.ok && moreBottom.ok && moreTop.box[0] >= 24 && moreTop.box[1] >= 24,
      JSON.stringify({ moreTop, moreBottom }));
    // 「连接」自带 overflow:hidden（相位文本省略号），透明盒会被裁——只能用实盒：
    // 断言视觉盒已达 24 + 盒内四角都归本钮
    const connBox = await hit(".host-connect-btn", 0, 0, "prod-1");
    const connTop = await hit(".host-connect-btn", 0, -11, "prod-1");
    const connRight = await hit(".host-connect-btn", 18, 0, "prod-1");
    ck.check("主机「连接」：实盒 ≥24×24 且盒内边缘均命中",
      connBox.ok && connTop.ok && connRight.ok && connBox.box[0] >= 24 && connBox.box[1] >= 24,
      JSON.stringify({ connBox, connTop, connRight }));

    // 状态栏任务入口（广播/命令块/转发/传输）：18 高，上下各外扩 1px 即出视觉盒
    const sbTop = await hit(".sb-btn", 0, -10);
    const sbBottom = await hit(".sb-btn", 0, 10);
    ck.check("状态栏入口：视觉盒（18 高）外 1px 仍命中",
      sbTop.ok && sbBottom.ok && sbTop.box[1] < 24, JSON.stringify({ sbTop, sbBottom }));

    // 连接 → toast 关闭 + 资源采样暂停
    await (await card.$('button[title^="连接"]')).click();
    await page.waitForTimeout(800);
    const toastHit = await hit(".toast .toast-x", 0, -10);
    ck.check("toast 关闭：视觉盒（13 高）外 3.5px 仍命中且视觉盒不变",
      toastHit.ok && toastHit.box[1] < 24, JSON.stringify(toastHit));
    const pauseHit = await hit(".metrics-bar .mpause", -12, 0);
    ck.check("资源采样暂停：视觉盒（20 宽）外 2px 仍命中",
      pauseHit.ok && pauseHit.box[0] < 24, JSON.stringify(pauseHit));

    // 文件面板：面包屑与行内下载
    await page.waitForTimeout(900);
    await page.click('[data-testid="rb-files"]');
    await page.waitForTimeout(900);
    const crumbTop = await hit(".sftp-crumb", 0, -10);
    const crumbBottom = await hit(".sftp-crumb", 0, 10);
    ck.check("文件面包屑：视觉盒（17 高）外 1.5px 仍命中（容器 overflow 不裁）",
      crumbTop.ok && crumbBottom.ok && crumbTop.box[1] < 24, JSON.stringify({ crumbTop, crumbBottom }));
    await page.evaluate(() => {
      const row = document.querySelector(".sftp-row");
      row?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await page.waitForTimeout(250);
    const dlHit = await hit(".sftp-row .sftp-dl", 0, -12);
    ck.check("文件行内下载钮：视觉盒（20 高）外 2px 且可命中",
      dlHit.ok, JSON.stringify(dlHit));
  },
};
