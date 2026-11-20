// 98 GitHub #52 排查：两个同配置的独立 WebGL 终端共享图集。A 连续写高熵 256 色
// 字符强制页合并，B 的首行缓冲区不变，画面也不得变成其他字形。独立终端排除
// demo 后台输出和 App 的定时重绘把错误提前自愈；场景对齐上游 #6038/#6042。
const HEADER = " HEADER_REF_0123456789";

// 首行前 10 格，每格 4×4 区块求 RGBA 均值，再取最大通道差。PNG 字节不相等可能
// 只是正常 GPU 抗锯齿，不能直接当错字；阈值 14 与上游回归一致。
const rowSignatures = async (page, png) => page.evaluate(async (base64) => {
  const img = new Image();
  img.src = "data:image/png;base64," + base64;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
  const cellW = img.width / 80;
  const cellH = img.height / 24;
  const signatures = [];
  for (let col = 1; col <= 10; col++) {
    const x0 = (col - 1) * cellW;
    const sums = new Array(16 * 4).fill(0);
    const counts = new Array(16).fill(0);
    for (let y = 0; y < Math.ceil(cellH); y++) {
      const gy = Math.min(3, Math.max(0, Math.floor((y / cellH) * 4)));
      for (let x = Math.floor(x0); x < Math.min(img.width, Math.ceil(x0 + cellW)); x++) {
        const gx = Math.min(3, Math.max(0, Math.floor(((x - x0) / cellW) * 4)));
        const sub = gy * 4 + gx;
        const i = (y * img.width + x) * 4;
        for (let c = 0; c < 4; c++) sums[sub * 4 + c] += pixels[i + c];
        counts[sub]++;
      }
    }
    signatures.push(sums.map((v, i) => counts[Math.floor(i / 4)] ? v / counts[Math.floor(i / 4)] : 0));
  }
  return signatures;
}, png.toString("base64"));

const maxSignatureDiff = (a, b) => {
  let diff = 0;
  for (let cell = 0; cell < a.length; cell++) {
    for (let i = 0; i < a[cell].length; i++) diff = Math.max(diff, Math.abs(a[cell][i] - b[cell][i]));
  }
  return diff;
};

const writeAndWait = async (page, key, data) => {
  await page.evaluate(async ({ key, data }) => {
    const term = window.__atlas98?.[key];
    if (!term) throw new Error("missing terminal " + key);
    await new Promise((resolve) => {
      const d = term.onRender(() => { d.dispose(); resolve(); });
      term.write(data);
    });
  }, { key, data });
};

module.exports = {
  title: "共享 WebGL 图集页合并：兄弟终端缓冲不变且画面不串字（#52）",
  async run({ page, ck }) {
    const setup = await page.evaluate(async () => {
      const [{ Terminal }, { WebglAddon }] = await Promise.all([
        import("/node_modules/@xterm/xterm/lib/xterm.mjs"),
        import("/node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs"),
      ]);
      const host = document.createElement("div");
      host.id = "atlas98";
      host.style.cssText = "position:fixed;left:0;top:0;z-index:99999;display:flex;background:#111;padding:8px;gap:8px";
      document.body.appendChild(host);
      const make = (id) => {
        const el = document.createElement("div");
        el.id = `atlas98-${id}`;
        host.appendChild(el);
        const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
        term.open(el);
        const addon = new WebglAddon({ preserveDrawingBuffer: true });
        term.loadAddon(addon);
        return { term, addon };
      };
      const a = make("a");
      const b = make("b");
      window.__atlas98 = { a: a.term, b: b.term, ab: b.addon, host, removed: 0 };
      await new Promise((r) => setTimeout(r, 500));
      const ra = a.term._core?._renderService?._renderer?.value;
      const rb = b.term._core?._renderService?._renderer?.value;
      const atlas = ra?._charAtlas;
      if (!atlas || atlas !== rb?._charAtlas) return { shared: false };
      atlas.constructor.maxAtlasPages = 4;
      atlas.onRemoveTextureAtlasCanvas(() => { window.__atlas98.removed++; });
      return { shared: true };
    });
    ck.check("两个独立终端确实共享 WebGL 图集", setup.shared, JSON.stringify(setup));
    if (!setup.shared) return;

    await writeAndWait(page, "b", HEADER);
    // 统一光栅化基线：预热 ASCII 在屏幕外临时画布生成；清缓存后才挂入终端继承
    // 字体环境。两者在本应用 CSS 下抗锯齿不同，不能把这种差异误判成页合并错字。
    await page.evaluate(async () => {
      const s = window.__atlas98;
      s.ab.clearTextureAtlas();
      s.b.refresh(0, s.b.rows - 1);
      await new Promise((r) => setTimeout(r, 500));
    });
    const before = await page.locator("#atlas98-b .xterm-screen").screenshot();
    const beforeSig = await rowSignatures(page, before);

    for (let round = 0; round < 10; round++) {
      const flood = await page.evaluate((offset) => {
        const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        let out = "";
        for (let i = 0; i < 23 * 78; i++) {
          const ch = letters[(offset + i) % letters.length];
          const fg = (offset + i) % 256;
          const bg = (offset + i * 7) % 256;
          out += `\x1b[38;5;${fg}m\x1b[48;5;${bg}m${ch}`;
          if ((i + 1) % 78 === 0 && i + 1 < 23 * 78) out += "\x1b[0m\r\n";
        }
        return `\x1b[2;1H${out}\x1b[0m`;
      }, round * 23 * 78);
      await writeAndWait(page, "a", flood);
    }
    const afterFlood = await page.locator("#atlas98-b .xterm-screen").screenshot();
    const floodDiff = maxSignatureDiff(beforeSig, await rowSignatures(page, afterFlood));
    ck.check("A 合并图集后、B 尚未重画时首行像素不变", floodDiff <= 14, `最大通道差 ${floodDiff}`);

    await writeAndWait(page, "b", "\x1b[24;1Hx");
    const result = await page.evaluate(() => {
      const s = window.__atlas98;
      const renderer = s.b._core?._renderService?._renderer?.value;
      return {
        removed: s.removed,
        header: s.b.buffer.active.getLine(0)?.translateToString(true) ?? "",
        pages: renderer?._charAtlas?.pages?.length ?? -1,
        rendererMatches: renderer === s.ab._renderer,
        contextLost: renderer?._canvas?.getContext("webgl2")?.isContextLost() ?? null,
      };
    });
    ck.check("探针确实触发共享图集页合并且 WebGL 仍存活",
      result.removed > 0 && result.rendererMatches && result.contextLost === false, JSON.stringify(result));
    ck.check("B 的缓冲区首行原文未变", result.header === HEADER, result.header);
    const after = await page.locator("#atlas98-b .xterm-screen").screenshot();
    const afterDiff = maxSignatureDiff(beforeSig, await rowSignatures(page, after));
    ck.check("B 只改尾行后首行仍保持原字形", afterDiff <= 14, `最大通道差 ${afterDiff}`);

    await page.evaluate(() => {
      const s = window.__atlas98;
      const atlas = s.a._core?._renderService?._renderer?.value?._charAtlas;
      if (atlas) atlas.constructor.maxAtlasPages = undefined;
      s.a.dispose();
      s.b.dispose();
      s.host.remove();
    });
  },
};
