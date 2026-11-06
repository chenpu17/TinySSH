// 70 KI-001：触摸板无按键移动报告过滤。纯函数在 dev 模块直接加载，覆盖
// SGR 移动/点击/拖动/滚轮/扩展按键与混合文本，防止后续重构把过滤逻辑改坏。
// 真实触摸板/远端 any-motion 模式仍需真机复测（不在本 spec 范围）。

module.exports = {
  title: "触摸板防护：只丢弃无按键移动报告，保留点击/拖动/滚轮",
  async run({ page, ck }) {
    const r = await page.evaluate(async () => {
      const mod = await import("/src/terminal/mouse-guard.ts");
      const f = mod.stripMotionOnlyMouseReports;
      return {
        motion: f("\x1b[<35;10;20M"),
        motionWithMod: f("\x1b[<63;10;20M"),
        left: f("\x1b[<0;10;20M"),
        drag: f("\x1b[<32;10;20M"),
        wheel: f("\x1b[<64;10;20M"),
        aux: f("\x1b[<163;10;20M"),
        mixed: f("a\x1b[<35;1;1Mb\x1b[<0;2;2M"),
        text: f("ls -la"),
      };
    });
    ck.eq("无按键移动报告被丢弃", r.motion, "");
    ck.eq("带修饰键的无按键移动报告被丢弃", r.motionWithMod, "");
    ck.eq("左键按下保留", r.left, "\x1b[<0;10;20M");
    ck.eq("拖动保留", r.drag, "\x1b[<32;10;20M");
    ck.eq("滚轮保留", r.wheel, "\x1b[<64;10;20M");
    ck.eq("扩展按键（bit7）不误判为无按键", r.aux, "\x1b[<163;10;20M");
    ck.eq("混合文本只删移动报告", r.mixed, "ab\x1b[<0;2;2M");
    ck.eq("普通键盘输入原样返回", r.text, "ls -la");
  },
};
