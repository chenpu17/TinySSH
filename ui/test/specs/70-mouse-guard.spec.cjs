// 70 KI-001：触摸板无按键移动报告过滤。纯函数在 dev 模块直接加载，覆盖
// SGR/X10 两种编码的移动/点击/拖动/滚轮/扩展按键与混合文本，防止后续重构
// 把过滤逻辑改坏。只开 1003 不开 1006 时 xterm 用 X10 编码——旧实现只认 SGR，
// 触摸板移动会漏成 ESC[M… 乱码，这一路必须有回归。
// 真实触摸板/远端 any-motion 模式仍需真机复测（不在本 spec 范围）。

const x10 = (cb, cx, cy) => "\x1b[M" + String.fromCharCode(cb + 32, cx + 32, cy + 32);

module.exports = {
  title: "触摸板防护：只丢弃无按键移动报告，保留点击/拖动/滚轮（SGR + X10）",
  async run({ page, ck }) {
    const r = await page.evaluate(async () => {
      const mod = await import("/src/terminal/mouse-guard.ts");
      const f = mod.stripMotionOnlyMouseReports;
      const x10 = (cb, cx, cy) =>
        "\x1b[M" + String.fromCharCode(cb + 32, cx + 32, cy + 32);
      return {
        motion: f("\x1b[<35;10;20M"),
        motionWithMod: f("\x1b[<63;10;20M"),
        left: f("\x1b[<0;10;20M"),
        drag: f("\x1b[<32;10;20M"),
        wheel: f("\x1b[<64;10;20M"),
        aux: f("\x1b[<163;10;20M"),
        mixed: f("a\x1b[<35;1;1Mb\x1b[<0;2;2M"),
        text: f("ls -la"),
        x10Motion: f(x10(35, 10, 20)),
        x10MotionMod: f(x10(39, 10, 20)),
        x10Left: f(x10(0, 10, 20)),
        x10Drag: f(x10(32, 10, 20)),
        x10Wheel: f(x10(64, 10, 20)),
        x10Mixed: f("a" + x10(35, 1, 1) + "b" + x10(0, 2, 2)),
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
    ck.eq("X10 无按键移动报告被丢弃", r.x10Motion, "");
    ck.eq("X10 带修饰键的移动报告被丢弃", r.x10MotionMod, "");
    ck.eq("X10 左键按下保留", r.x10Left, x10(0, 10, 20));
    ck.eq("X10 拖动保留", r.x10Drag, x10(32, 10, 20));
    ck.eq("X10 滚轮保留", r.x10Wheel, x10(64, 10, 20));
    ck.eq("X10 混合文本只删移动报告", r.x10Mixed, "ab" + x10(0, 2, 2));
  },
};
