// 37 P2 可点击路径：终端里的文件路径（含 :line:col）识别为链接，点击复制原文。
// 匹配语义走 dev 探针 __t_pathmatch（纯函数直测——URL 让路/句点裁剪/单词边界/
// Windows/相对/裸多段/行列后缀/宽字符对齐）；点击链路用内部 cell 度量算坐标真点一次。
const connect = async (page, name) => {
  const c = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  await c.hover();
  await page.waitForTimeout(250);
  await (await c.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1400);
};

module.exports = {
  title: "可点击路径：匹配语义 + 点击复制 path:line:col",
  async run({ page, ck }) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

    // ── 连接（探针在首个终端创建后才有）──
    await connect(page, "本机");

    const m = (line) => page.evaluate((t) => window.__t_pathmatch(t), line);

    // ── 匹配器语义（dev 探针直测）──
    let h = await m("error: --> src/main.rs:42:8");
    ck.check("裸多段 + :line:col", h.length === 1 && h[0].text === "src/main.rs:42:8" && h[0].path === "src/main.rs" && h[0].line === 42 && h[0].col === 8,
      JSON.stringify(h));
    h = await m("grep -n 见 /var/log/syslog.");
    ck.check("POSIX 绝对 + 尾部句点裁剪", h.length === 1 && h[0].text === "/var/log/syslog", JSON.stringify(h));
    h = await m("去 https://example.com/a/b 看看");
    ck.check("URL 协议前缀让路（不识别为路径）", h.length === 0, JSON.stringify(h));
    h = await m("查 C:\\Users\\chen\\a.rs:3 再说");
    ck.check("Windows 盘符路径 + :line", h.length === 1 && h[0].path === "C:\\Users\\chen\\a.rs" && h[0].line === 3, JSON.stringify(h));
    h = await m("跑 ./x.ts 和 ../y/z.ts 两个");
    ck.check("显式相对路径两条各一", h.length === 2 && h[0].path === "./x.ts" && h[1].path === "../y/z.ts", JSON.stringify(h));
    h = await m("单一文件名 readme.md 不算");
    ck.check("单文件名不识别", h.length === 0, JSON.stringify(h));
    h = await m("错误在src/a.rs:2 位置");
    ck.check("CJK 前缀不吞匹配（边界检查放行非 ASCII 词字符）", h.length === 1 && h[0].start === 3, JSON.stringify(h));
    h = await m("宏展开 \\r\\t 不是路径");
    ck.check("转义序列（裸反斜杠串）不识别", h.length === 0, JSON.stringify(h));

    // ── 端到端：写入含路径行，hover 计算出链接，点击复制 ──
    const lineText = "rustc fail --> src/main.rs:2:8";
    await page.evaluate((t) => {
      const terms = window.__t_terms;
      const term = [...terms.values()].find((x) => x.element?.isConnected);
      term.write("\r\n" + t + "\r\n");
    }, lineText);
    await page.waitForTimeout(500);
    // 点击目标：DOM 渲染器的行/列 span 直取（文本即定位，免内部度量）；
    // WebGL 渲染器无 DOM 行时回退 cell 度量算坐标。
    let pos = await page.evaluate(() => {
      const term = [...window.__t_terms.values()].find((x) => x.element?.isConnected);
      const rows = term.element.querySelectorAll(".xterm-rows > div");
      for (let r = 0; r < rows.length; r++) {
        const span = [...rows[r].querySelectorAll("span")].find((sp) => sp.textContent.includes("src/main.rs"));
        if (span) {
          const rc = span.getBoundingClientRect();
          return { x: rc.left + Math.min(4, rc.width / 2), y: rc.top + rc.height / 2, how: "dom" };
        }
      }
      return null;
    });
    if (!pos) pos = await page.evaluate((t) => {
      const term = [...window.__t_terms.values()].find((x) => x.element?.isConnected);
      const dims = term._core._renderService.dimensions.css.cell;
      const buf = term.buffer.active;
      for (let y = buf.length - 1; y >= 0; y--) {
        const l = buf.getLine(y);
        if (!l) continue;
        const cells = [];
        for (let x = 0; x < l.length; x++) {
          const c = l.getCell(x);
          if (!c) break;
          cells.push(c.getWidth() === 0 ? "" : (c.getChars() || " "));
        }
        const idx = cells.join("").indexOf("src/main.rs");
        if (idx >= 0) {
          // xterm getCoords 的参照元素是 .xterm-screen（含其 padding），不是 .xterm 外壳
          const scr = term.element.querySelector(".xterm-screen");
          const r2 = scr.getBoundingClientRect();
          const st = getComputedStyle(scr);
          const padL = parseInt(st.paddingLeft) || 0, padT = parseInt(st.paddingTop) || 0;
          const row = y - buf.baseY;
          return { x: r2.left + padL + idx * dims.width + dims.width / 2, y: r2.top + padT + row * dims.height + dims.height / 2, how: "cell" };
        }
      }
      return null;
    }, lineText);
    ck.check("缓冲里定位到路径行与列", !!pos, JSON.stringify(pos));
    await page.mouse.move(pos.x - 80, pos.y - 40);
    await page.waitForTimeout(150);
    await page.mouse.move(pos.x, pos.y);
    await page.waitForTimeout(600);
    await page.mouse.move(pos.x - 60, pos.y - 30);
    await page.waitForTimeout(200);
    await page.mouse.move(pos.x, pos.y);
    await page.waitForTimeout(600); // xterm 链接 hover 有防抖
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(500);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    ck.check("点击链接复制 path:line:col 原文", clip === "src/main.rs:2:8", clip);
    const toast = await page.evaluate(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent).join("|"));
    ck.check("复制后 toast 告知", toast.includes("已复制路径 src/main.rs:2:8"), toast);

    // ── 宽字符对齐（provider 视角）：CJK 行里路径列号正确 ──
    const wide = await page.evaluate(() => {
      const terms = window.__t_terms;
      const term = [...terms.values()].find((x) => x.element?.isConnected);
      const buf = term.buffer.active;
      term.write("错误在src/wide.rs:5\n");
      return new Promise((resolve) => setTimeout(() => {
        for (let y = buf.length - 1; y >= 0; y--) {
          const l = buf.getLine(y);
          if (!l) continue;
          const cells = [];
          for (let x = 0; x < l.length; x++) {
            const c = l.getCell(x);
            if (!c) break;
            cells.push(c.getWidth() === 0 ? "" : (c.getChars() || " "));
          }
          const s = cells.join("");
          if (s.includes("src/wide.rs")) {
            // 直接跑匹配器对照：start 应落在 s 的 indexOf 处
            const hit = window.__t_pathmatch(s)[0];
            resolve({ start: hit?.start, expect: s.indexOf("src/wide.rs"), cellLen: s.length });
            return;
          }
        }
        resolve(null);
      }, 400));
    });
    ck.check("CJK 宽字符行内匹配列与缓冲一致", !!wide && wide.start === wide.expect, JSON.stringify(wide));

    // 收尾：不留会话
    for (let i = 0; i < 3; i++) {
      const more = await page.evaluate(() => document.querySelectorAll(".tab").length);
      if (more === 0) break;
      await page.evaluate(() => {
        const tab = document.querySelector(".tab");
        tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 380, clientY: 130 }));
      });
      await page.waitForTimeout(350);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((x) => x.textContent.includes("关闭会话"));
        if (b) b.click();
      });
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
        if (b) b.click();
      });
      await page.waitForTimeout(900);
    }
  },
};
