// 104 页面底缘取色（window.__tinysshEdgeBg → edge-bg.ts 的 pageEdgeBg）：Android 边到边
// 下导航栏下方那条是原生窗口底色，主题是 Material DayNight、跟系统深浅——系统浅色 +
// 应用深色时应用最底下压着一条纯白条。改成跟着页面底色走：MainActivity 经本函数取色
// 涂窗口底色（来龙去脉见 edge-bg.ts 文件头）。这里锁取色端——取到的 #rrggbb 必须等于
// 底边中点真实渲染的像素：半透明遮罩按 alpha 合成、全透明遮罩越过、浅色深色两套外观、
// 主机列表/会话视图（辅助键条贴底、外接键盘形态活动栏贴底）各种面都要对得上。原生涂色
// 那一端在 Android 模拟器上验收（docs/ux/visual-upgrade.md），浏览器里测不到。

/** 底边中点的真实像素：截 1×1 回灌进页面用 canvas 解码（headless DPR=1）。 */
const pixelAtEdge = async (page) => {
  const { x, y } = await page.evaluate(() => ({
    x: Math.floor(document.documentElement.clientWidth / 2),
    y: document.documentElement.clientHeight - 1,
  }));
  const buf = await page.screenshot({ clip: { x, y, width: 1, height: 1 }, animations: "disabled" });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, buf.toString("base64"));
};
const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const near = (a, b, tol) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const edgeOf = (page) => page.evaluate(() => window.__tinysshEdgeBg());

module.exports = {
  title: "页面底缘取色：与底边中点真实像素一致（原生窗口底色的取色端）",
  async run({ page, ck }) {
    await page.setViewportSize({ width: 411, height: 890 });
    await page.evaluate(() => { document.documentElement.dataset.platform = "android"; });
    await page.waitForTimeout(500);
    const kind = await page.evaluate(() => typeof window.__tinysshEdgeBg);
    ck.eq("取色函数挂在 window.__tinysshEdgeBg（demo 里也挂，只读）", kind, "function");
    const shape = await page.evaluate(() => /^[0-9a-f]{6}$/.test(String(window.__tinysshEdgeBg()).slice(1)) && String(window.__tinysshEdgeBg())[0] === "#");
    ck.check("返回 #rrggbb 小写十六进制", shape, await edgeOf(page));

    /** 一个状态下的两项对照：取色 = 截图像素（容差 2，留给边框/阴影的抗锯齿）。 */
    const agree = async (label) => {
      const fn = hexToRgb(await edgeOf(page));
      const px = await pixelAtEdge(page);
      ck.check(`${label}：取色与底边中点像素一致`, near(fn, px, 2), `取色 ${JSON.stringify(fn)} / 像素 ${JSON.stringify(px)}`);
      return fn;
    };
    const setChrome = async (c) => {
      await page.evaluate((c) => { document.documentElement.dataset.chrome = c; }, c);
      await page.waitForTimeout(450); // 等 .theme-switching 之外的样式落定（本 spec 直接改标记，无过渡）
    };

    // ── 主机列表：底缘是移动端活动栏（--panel 系），不是 body 的 --bg ──
    await setChrome("light");
    const listLight = await agree("浅色·主机列表");
    await setChrome("dark");
    const listDark = await agree("深色·主机列表");
    ck.check("外观切换后取色跟着变（不是写死的常量）", !near(listLight, listDark, 8), `${JSON.stringify(listLight)} → ${JSON.stringify(listDark)}`);

    // ── 会话视图：先是有辅助键条贴底（软键盘形态），再隐藏它模拟外接键盘形态
    //    （底缘换成活动栏）——两种面都要对得上 ──
    const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
    await card.hover();
    await page.waitForTimeout(200);
    await (await card.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1300);
    await agree("深色·会话视图（辅助键条贴底）");
    await page.addStyleTag({ content: ".mobile-keys{display:none!important}" });
    await page.waitForTimeout(400);
    const onRail = await page.evaluate(() => {
      const hits = document.elementsFromPoint(
        Math.floor(document.documentElement.clientWidth / 2), document.documentElement.clientHeight - 1,
      );
      return { rail: hits.some((el) => el.classList.contains("actrail")), keys: hits.some((el) => el.classList.contains("mobile-keys")) };
    });
    ck.check("前提成立：隐藏辅助键条后底边中点落在活动栏上", onRail.rail && !onRail.keys, JSON.stringify(onRail));
    await agree("深色·会话视图（活动栏贴底）");
    await setChrome("light");
    const sessLight = await agree("浅色·会话视图（活动栏贴底）");

    // ── 遮罩合成：全透明的越过（取色不变）；半透明的按 alpha 压上去 ──
    await page.evaluate(() => {
      const d = document.createElement("div");
      d.id = "spec-edge-mask";
      d.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0);pointer-events:auto";
      document.body.appendChild(d);
    });
    await page.waitForTimeout(120);
    ck.eq("全透明遮罩越过：取色不变", await edgeOf(page), `#${sessLight.map((v) => v.toString(16).padStart(2, "0")).join("")}`);
    await page.evaluate(() => { document.querySelector("#spec-edge-mask").style.background = "rgba(255, 0, 0, 0.5)"; });
    await page.waitForTimeout(120);
    const blended = await edgeOf(page);
    // sRGB 空间里按 alpha 线性混合：r = 0.5·底 + 0.5·255，g/b = 0.5·底
    const expect = sessLight.map((v, i) => Math.round(v * 0.5 + (i === 0 ? 255 * 0.5 : 0)));
    ck.check("半透明遮罩按 alpha 合成（50% 红压上去）", near(hexToRgb(blended), expect, 1), `取色 ${blended} / 期望 ${JSON.stringify(expect)}`);
    await agree("半透明遮罩下仍与像素一致");
    await page.evaluate(() => document.querySelector("#spec-edge-mask")?.remove());
    await page.waitForTimeout(120);
    ck.eq("遮罩撤掉后取色复原", await edgeOf(page), `#${sessLight.map((v) => v.toString(16).padStart(2, "0")).join("")}`);
  },
};
