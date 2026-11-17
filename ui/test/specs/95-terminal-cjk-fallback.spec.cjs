// 95 终端 CJK 缺字回退（GitHub #41）：「昇腾」的昇比邻字小一号（macOS 反馈）。
// 根因两层：① Maple/JetBrains/MiSans 都按 GB2312 裁字形，昇（U+6607）是 GBK 独有字，
// 三者都没有；② mac 应用跑 WKWebView（WebKit），栈首「TinySSH Symbol Fallback」
// （unicode-range 只有圈号，size-adjust:80%）的缩放在 WebKit 里会漏到「全栈未匹配」
// 的汉字上——WebKit 探针旧栈 昇/腾 = 0.77，与截图吻合；Chromium 不复现（按
// unicode-range 跳过该面）。修复给终端加了专用回退族（Mac 苹方/冬青原尺在前，Win
// 雅黑 size-adjust 126%），插在 MiSans 之后、系统字体之前，只接 CJK 区段。
//
// 断言分两层：① 字体栈与 @font-face 规则在位（跨引擎恒真，是本 spec 的主防线——
// Chrome 里没有修复时墨迹比也是 0.96，所以下面的实测只在 WebKit 里能拦回旧病）；
// ② 本机有回退字体时，实测 GBK 独有字与邻字的墨迹高度比。
//
// 断言分两层：① 字体栈与 @font-face 规则在位（跨平台恒真）；② 本机有回退字体时，
// 实测 GBK 独有字与 Maple 常用字的墨迹高度比（Windows 上跑就是真机回归）。
const connectLocal = async (page) => {
  const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
  await card.hover();
  await page.waitForTimeout(200);
  await (await card.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1300);
};

module.exports = {
  title: "终端 CJK 缺字回退：GBK 独有字与邻字同尺",
  async run({ page, ck }) {
    await connectLocal(page);
    const info = await page.evaluate(() => {
      const [, t] = [...window.__t_terms.entries()].find(([, x]) => x.element && x.element.isConnected);
      const fam = t.options.fontFamily;
      const faces = [];
      for (const sheet of document.styleSheets) {
        let rules = [];
        try { rules = [...sheet.cssRules]; } catch { continue; }
        for (const r of rules) {
          if (r.constructor?.name === "CSSFontFaceRule"
            && /TinySSH CJK Fallback/.test(r.style.fontFamily)) {
            faces.push({
              family: r.style.fontFamily.replace(/["']/g, ""),
              sizeAdjust: r.style.getPropertyValue("size-adjust") || null,
              src: r.style.getPropertyValue("src"),
            });
          }
        }
      }
      return { fam, faces };
    });

    ck.check("默认终端字体栈含 CJK 缺字回退族（Win + Mac）",
      info.fam.includes('"TinySSH CJK Fallback Win"') && info.fam.includes('"TinySSH CJK Fallback Mac"'),
      info.fam);
    const mi = info.fam.indexOf('"MiSans VF"');
    const win = info.fam.indexOf('"TinySSH CJK Fallback Win"');
    const yahei = info.fam.indexOf('"Microsoft YaHei"');
    ck.check("回退族排在 MiSans 之后（GB2312 常用字仍走 MiSans）", mi >= 0 && win > mi, `${mi} → ${win}`);
    ck.check("回退族排在系统雅黑之前（先走专用回退）", win >= 0 && yahei > win, `${win} → ${yahei}`);
    ck.check("Win/Mac 两个 @font-face 均已声明", info.faces.length === 2, JSON.stringify(info.faces));
    const winFace = info.faces.find((f) => f.family === "TinySSH CJK Fallback Win");
    ck.check("Windows 回退面用 size-adjust 补字模差（126%）",
      !!winFace && (winFace.sizeAdjust ?? "").replace(/\s/g, "") === "126%",
      JSON.stringify(winFace));
    ck.check("回退面走 local() 系统字体（不新增大体积资源）",
      info.faces.every((f) => f.src.includes("local(")), JSON.stringify(info.faces.map((f) => f.src)));

    // 实测墨迹高度：本机装有 Win/Mac 回退字体（Windows/macOS）时才有意义。
    const measured = await page.evaluate(async () => {
      const [, t] = [...window.__t_terms.entries()].find(([, x]) => x.element && x.element.isConnected);
      const fams = ["TinySSH CJK Fallback Mac", "TinySSH CJK Fallback Win"];
      for (const f of fams) {
        try { await document.fonts.load(`56px "${f}"`, "昇"); } catch { /* 本机没有 */ }
      }
      await document.fonts.ready;
      const usable = fams.filter((f) => document.fonts.check(`14px "${f}"`, "昇"));
      const c = document.createElement("canvas").getContext("2d");
      c.font = `56px ${t.options.fontFamily}`;
      const inkH = (ch) => {
        const m = c.measureText(ch);
        return m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
      };
      return {
        usable,
        sheng: inkH("昇"), kun: inkH("堃"), teng: inkH("腾"), zhe: inkH("者"),
      };
    });
    if (measured.usable.length > 0) {
      // Maple 的「腾/者」是 51px 量级（56px 字号），昇/堃 由回退字体绘制；
      // 修复前 Windows 实测 昇 约 79%——阈值放到 85% 仍能拦回旧病，不被字形差异误伤。
      const r1 = measured.sheng / measured.teng;
      const r2 = measured.kun / measured.zhe;
      ck.check("GBK 独有字「昇」与邻字同尺（≥85%）", r1 >= 0.85,
        `昇 ${measured.sheng.toFixed(1)} / 腾 ${measured.teng.toFixed(1)} = ${r1.toFixed(2)}（回退面：${measured.usable.join("/")}）`);
      ck.check("GBK 独有字「堃」与邻字同尺（≥85%）", r2 >= 0.85,
        `堃 ${measured.kun.toFixed(1)} / 者 ${measured.zhe.toFixed(1)} = ${r2.toFixed(2)}`);
    } else {
      ck.check("本机无雅黑/苹方可测（Linux CI）——栈与规则断言已覆盖", true, measured.usable.join("/") || "无");
    }
  },
};
