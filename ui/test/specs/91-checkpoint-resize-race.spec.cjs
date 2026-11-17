// 91 检查点重放（#33/#19）：登录横幅在「首个输入行」被提示符覆盖。
//
// 根因（真机诊断定案）：契约里检查点 lines 是「历史 + 可视」全网格，cursor.y 却是
// 可视区坐标。重放把历史行也写进缓冲，收尾 CUP 若直接用 cursor.y，光标落到内容
// 上方 history 行；紧随其后的远端 SIGWINCH 提示符重绘（\r + 提示符）恰好盖掉那一行
// （窄屏横幅折行 → 核心有历史 → 必现；宽屏一次装下 → 无历史 → 正常，即「偶发」来源）。
// 修复：checkpoint.ts 里光标行 = history + cursor.y − 写出屏外溢出，裁尾也按同一口径。
//
// 伴生加固：term.write 是异步队列，resize 却同步改模型。检查点 payload 排队后、解析前
// 插进一次 fit 的 resize，整段快照就按新网格解析（重放期 \x1b[?7l 会截断长行）。
// resizeTerm 是 UI 改尺寸的唯一入口，重放在途返回 false（fit 延后重试、PTY 侧 resize
// 一并延后），解析完成回调里开闸。
//
// 断言面：① 带历史行的检查点——光标落提示符行、横幅两行完整、`\r`+提示符重绘不覆盖；
// ② 重放在途改尺寸被拒 → 解析完成后放开，竞态终态与「解析完成后再 resize」一致。

const connectHost = async (page, name) => {
  const card = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  if (!card) throw new Error(`找不到主机卡：${name}`);
  await card.hover();
  await page.waitForTimeout(200);
  const btn = await card.$('button[title^="连接"]');
  if (!btn) throw new Error(`主机卡无连接按钮：${name}`);
  await btn.click();
  await page.waitForTimeout(1500);
};

const scenario = (page) =>
  page.evaluate(async () => {
    const mod = await import("/src/terminal/checkpoint.ts");
    const terms = window.__t_terms;
    if (!terms || terms.size === 0) throw new Error("__t_terms 探针为空（没有终端实例）");
    const sid = [...terms.keys()][0];
    const T = terms.get(sid).constructor;
    const BANNER = "Last login: Fri Nov 13 06:57:09 2026 from 139.159.170.82"; // 55 字 > 44 列
    const mkCk = () => ({
      cols: 120,
      rows: 32,
      cursor: { x: 16, y: 3, visible: true, style: "block" },
      active_buffer: 0,
      modes: { autowrap: true, application_cursor: false, bracketed_paste: false, origin_mode: false },
      buffers: [
        {
          lines: [
            [{ text: "        Welcome to Huawei Cloud Service" }],
            [],
            [{ text: BANNER }],
            [{ text: "95b1658b7eb5:~#" }],
            ...Array.from({ length: 28 }, () => []),
          ],
        },
        { lines: [] },
      ],
    });
    const make = (tag) => {
      const host = document.createElement("div");
      host.dataset.ckRace = tag;
      host.style.cssText = "position:fixed;left:-10000px;top:0;width:1000px;height:700px";
      document.body.appendChild(host);
      const t = new T({ cols: 120, rows: 32, scrollback: 1000 });
      t.open(host);
      return t;
    };
    const settle = (t) => new Promise((r) => t.write("", r));
    const dump = (t) => {
      const b = t.buffer.active;
      const lines = [];
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i).translateToString(true));
      while (lines.length && !lines[lines.length - 1]) lines.pop();
      return { cols: t.cols, rows: t.rows, baseY: b.baseY, cursor: [b.cursorY, b.cursorX], lines };
    };
    const res = {};

    // ① 带历史行的检查点（窄屏形态）：lines = 3 行历史 + 15 行可视，cursor.y = 4 是
    //    可视区第 4 行（提示符）。老代码把 cursor.y 当绝对行 → 光标落到内容上方，
    //    随后 `\r` + 提示符重绘盖掉横幅尾行（设备上实测的毁损态）。
    const hk = {
      cols: 44,
      rows: 15,
      cursor: { x: 16, y: 4, visible: true, style: "block" },
      active_buffer: 0,
      modes: { autowrap: true, application_cursor: false, bracketed_paste: false, origin_mode: false },
      buffers: [
        {
          lines: [
            [{ text: "hist-0" }],
            [{ text: "hist-1" }],
            [{ text: "hist-2" }],
            [{ text: "        Welcome to Huawei Cloud Service" }],
            [],
            [{ text: "Last login: Fri Nov 13 06:57:09 2026 from 13" }],
            [{ text: "9.159.170.82" }],
            [{ text: "95b1658b7eb5:~#" }],
            ...Array.from({ length: 10 }, () => []),
          ],
        },
        { lines: [] },
      ],
    };
    const h = make("h");
    mod.applyCheckpoint(h, hk);
    await settle(h);
    res.hist = dump(h);
    await new Promise((r) => h.write("\r95b1658b7eb5:~#", r));
    res.histAfterRepaint = dump(h);
    h.dispose();

    // ② 竞态：重放排队后立刻按视口 fit（老代码在这里 term.resize 成功 → 整屏毁损）
    const a = make("a");
    mod.applyCheckpoint(a, mkCk());
    res.busyDuringReplay = mod.isReplaying(a);
    res.refusedDuringReplay = mod.resizeTerm(a, 44, 15) === false;
    res.sizeHeldDuringReplay = [a.cols, a.rows]; // 应为检查点网格，未被 fit 抢先改
    await settle(a);
    res.releasedAfterSettle = mod.isReplaying(a) === false;
    res.appliedAfterSettle = mod.resizeTerm(a, 44, 15);
    await settle(a);
    res.race = dump(a);

    // ③ 对照：解析完成之后才 resize
    const b2 = make("b");
    mod.applyCheckpoint(b2, mkCk());
    await settle(b2);
    mod.resizeTerm(b2, 44, 15);
    await settle(b2);
    res.control = dump(b2);
    res.banner = BANNER;
    res.checkpointCols = 120;

    // ④ 提示符重绘（SIGWINCH）压在横幅行上会盖掉它吗——模拟远端 \r+提示符落位
    await new Promise((r) => a.write("\r95b1658b7eb5:~#", r));
    res.raceAfterRepaint = dump(a);

    a.dispose();
    b2.dispose();
    document.querySelectorAll("[data-ck-race]").forEach((el) => el.remove());
    return res;
  });

module.exports = {
  title: "检查点光标行换算与重放尺寸门（#33/#19）：带历史行时光标落提示符、横幅不被覆盖",
  async run({ page, ck }) {
    await connectHost(page, "本机");
    const r = await scenario(page);

    ck.check("历史行完整写入缓冲（未被裁尾吃掉）",
      r.hist.lines.slice(0, 3).join("|") === "hist-0|hist-1|hist-2",
      JSON.stringify(r.hist.lines.slice(0, 5)));
    ck.check("横幅两行原样保留",
      r.hist.lines[5]?.startsWith("Last login: Fri Nov 13") && r.hist.lines[6] === "9.159.170.82",
      JSON.stringify(r.hist.lines.slice(3, 8)));
    ck.check("光标按「历史行数 + 可视行」落在提示符行",
      r.hist.cursor[0] === 7 && r.hist.lines[7] === "95b1658b7eb5:~#",
      `cursor=${JSON.stringify(r.hist.cursor)} lines=${JSON.stringify(r.hist.lines)}`);
    ck.check("提示符重绘不覆盖横幅尾行",
      r.histAfterRepaint.lines[5]?.startsWith("Last login: Fri Nov 13") && r.histAfterRepaint.lines[6] === "9.159.170.82",
      JSON.stringify(r.histAfterRepaint.lines.slice(3, 8)));

    ck.check("重放解析在途时 isReplaying 为真", r.busyDuringReplay);
    ck.check("重放解析在途时 resizeTerm 被拒（延后而非插队）", r.refusedDuringReplay);
    ck.check("重放期间网格保持检查点尺寸（被拒的 fit 未插队）",
      r.sizeHeldDuringReplay[0] === r.checkpointCols, `实得 ${r.sizeHeldDuringReplay.join("x")}`);
    ck.check("解析完成后放开改尺寸", r.releasedAfterSettle && r.appliedAfterSettle === true);
    ck.check("竞态终态与对照终态逐行一致", JSON.stringify(r.race) === JSON.stringify(r.control),
      `race=${JSON.stringify(r.race)} control=${JSON.stringify(r.control)}`);
    const bannerJoined = r.race.lines.slice(2, 4).join("");
    ck.check("长横幅按 44 列完整折行（尾段未丢）", bannerJoined === r.banner, `实得 ${JSON.stringify(bannerJoined)}`);
    ck.check("横幅折行点正确（首行满 44 列、次行为尾段）",
      r.race.lines[2]?.length === 44 && r.race.lines[3] === r.banner.slice(44),
      `首行 ${r.race.lines[2]?.length} 列，次行 ${JSON.stringify(r.race.lines[3])}`);
    const cursorRow = r.race.cursor[0];
    ck.check("光标在提示符行（内容尾），不在横幅行", cursorRow === r.race.lines.length - 1
      || r.race.lines[cursorRow]?.startsWith("95b1658b7eb5:~#"), `cursor=${JSON.stringify(r.race.cursor)} lines=${JSON.stringify(r.race.lines)}`);
    // 提示符重绘落位后横幅仍完整（老代码这里横幅首行被 11 字提示符覆盖）
    ck.check("提示符重绘后横幅仍完整",
      r.raceAfterRepaint.lines[2]?.startsWith("Last login: Fri Nov 13") ?? false,
      JSON.stringify(r.raceAfterRepaint.lines.slice(0, 5)));
  },
};
