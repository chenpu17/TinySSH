// 38 P2 图片协议：@xterm/addon-image（sixel + iTerm2 OSC 1337）恒开。写入 iTerm2
// 内嵌 PNG 后断言存储事实：图已解码入库（storageUsage>0、orig 尺寸=解码 PNG 尺寸、
// tileCount=占格数、渲染源 ImageBitmap 就绪）；声明 width/height 时 tileCount=4x2=8；
// ASCII 文字流不被吞（IMG: 与 END 同行共存）。断言走 storage 内表面而非
// getImageAtBufferCell——其坐标约定未见文档且实测不回图（如实登记，不赌）。
const connect = async (page, name) => {
  const c = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  await c.hover();
  await page.waitForTimeout(250);
  await (await c.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1400);
};

// 经典 1x1 透明 PNG（恰好 70 字节）
const PNG1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

module.exports = {
  title: "图片协议：iTerm2 内嵌图解码入库 + 按声明尺寸占格 + 文字流不吞位",
  async run({ page, ck }) {
    await connect(page, "本机");

    const dumpImages = () => page.evaluate(() => {
      const live = (t) => { const el = t.element; return !!el && el.isConnected && el.getBoundingClientRect().height > 0; };
      const sid = [...window.__t_terms.entries()].find(([, t]) => live(t))?.[0];
      const img = window.__t_img.get(sid);
      if (!img) return { err: "img probe missing" };
      const st = img._storage;
      const specs = [];
      for (const s of st._images.values()) {
        specs.push({
          tileCount: s.tileCount,
          w: s.orig?.width, h: s.orig?.height,
          bitmap: typeof ImageBitmap !== "undefined" && s.orig instanceof ImageBitmap,
        });
      }
      return { usage: st.storageUsage, n: st._images.size, specs };
    });

    const writeAndSettle = (seq) => page.evaluate((s) => {
      const live = (t) => { const el = t.element; return !!el && el.isConnected && el.getBoundingClientRect().height > 0; };
      const term = [...window.__t_terms.values()].find(live);
      term.write(s);
      return new Promise((res) => setTimeout(res, 700)); // 解码+createImageBitmap 异步
    }, seq);

    const before = await dumpImages();
    ck.check("初始无图", before.n === 0, JSON.stringify(before));

    // ── iTerm2 内嵌图（auto 尺寸 → 1x1 像素 → 占 1 格）──
    await writeAndSettle(`\r\n IMG:\x1b]1337;File=inline=1;size=70:${PNG1x1}\x07 END\r\n`);
    const after1 = await dumpImages();
    ck.check("内嵌图解码入库（1 张）", after1.n === 1, JSON.stringify(after1));
    const s1 = after1.specs?.[0];
    ck.check("解码出 1x1 原图且渲染源就绪", s1 && s1.w === 1 && s1.h === 1 && s1.bitmap, JSON.stringify(s1));
    ck.check("auto 尺寸占 1 格（tileCount=1）", s1?.tileCount === 1, JSON.stringify(s1));

    // ── 声明 4x2 单元格 → 占 8 格；orig 被重采样为 4 格宽（4×8px=32，声明生效证据）──
    await writeAndSettle(`\r\n BIG:\x1b]1337;File=inline=1;width=4;height=2;size=70:${PNG1x1}\x07 Z\r\n`);
    const after2 = await dumpImages();
    ck.check("两张图入库", after2.n === 2, JSON.stringify(after2));
    const s2 = after2.specs?.find((x) => x.tileCount === 8);
    ck.check("声明 4x2 占 8 格（tileCount=8）", !!s2, JSON.stringify(after2.specs));
    ck.check("声明宽度生效（重采样 4 格×8px=32px）", s2?.w === 32, JSON.stringify(s2));

    // ── 文字流不吞位：IMG:/END、BIG:/Z 都完整落在各自行 ──
    const lines = await page.evaluate(() => {
      const live = (t) => { const el = t.element; return !!el && el.isConnected && el.getBoundingClientRect().height > 0; };
      const term = [...window.__t_terms.values()].find(live);
      const buf = term.buffer.active;
      const out = [];
      for (let y = Math.max(0, buf.cursorY + buf.baseY - 4); y <= buf.cursorY + buf.baseY; y++) {
        const l = buf.getLine(y);
        if (!l) continue;
        const cs = [];
        for (let x = 0; x < l.length; x++) {
          const c = l.getCell(x);
          if (!c) break;
          cs.push(c.getWidth() === 0 ? "" : (c.getChars() || " "));
        }
        out.push(cs.join("").trimEnd());
      }
      return out;
    });
    const joined = lines.join("\n");
    ck.check("IMG: 与 END 同行共存（图片占格不吞字）", /IMG:\s*END/.test(joined), JSON.stringify(lines));
    ck.check("BIG: 与 Z 同行共存（跨 4 格声明同理）", /BIG:\s*Z/.test(joined), JSON.stringify(lines));

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
