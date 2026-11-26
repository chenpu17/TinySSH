// 页面底缘取色：Android 边到边下，原生把 systemBars/IME 的底部 inset 转成内容根的
// 底部内边距（MainActivity），导航栏下方露出来的是「窗口底色」。主题是 Material
// DayNight，窗口底色跟的是系统深浅——系统浅色 + 应用深色时，应用最底下压着一条纯白
// 条（手势导航）/灰条（三键）。解法是让窗口底色跟页面走：这里算出页面底缘实际呈现
// 的颜色，原生在 MainActivity.syncEdgeBackground 里经 window.__tinysshEdgeBg 取走。

type Rgba = { r: number; g: number; b: number; a: number };

/** 计算样式里的 sRGB 颜色（rgb()/rgba()）；color()/oklch() 等其它色彩空间返回 null。 */
function parseSrgb(color: string): Rgba | null {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(color);
  if (!m) return null;
  const raw = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]), a: Math.min(1, Math.max(0, raw)) };
}

/** 沿 el 向上找第一个不透明背景（命中链之外的兜底：pointer-events:none 或被裁剪的
 *  祖先进不了 elementsFromPoint 的结果）。 */
function firstOpaqueBg(el: Element | null): Rgba | null {
  for (let e = el; e; e = e.parentElement) {
    const c = parseSrgb(getComputedStyle(e).backgroundColor);
    if (c && c.a >= 0.999) return c;
  }
  return null;
}

/** 页面底缘（视口底边中点）实际呈现的颜色，#rrggbb。
 *  取该点上的全部元素（自顶层起），逐层按 alpha 合成背景色——半透明的遮罩、浮层
 *  照常压暗底下那层，全透明的遮罩直接越过；遇到不透明层即止。 */
export function pageEdgeBg(): string {
  const root = document.documentElement;
  const hits = document.elementsFromPoint(Math.floor(root.clientWidth / 2), root.clientHeight - 1);
  let r = 0, g = 0, b = 0, covered = 0;
  const over = (c: Rgba) => {
    const w = c.a * (1 - covered);
    r += w * c.r;
    g += w * c.g;
    b += w * c.b;
    covered += w;
  };
  for (const el of hits) {
    const c = parseSrgb(getComputedStyle(el).backgroundColor);
    if (!c || c.a === 0) continue;
    over(c);
    if (covered >= 0.999) break;
  }
  if (covered < 0.999) {
    const base = firstOpaqueBg(hits[hits.length - 1] ?? null) ?? parseSrgb(getComputedStyle(document.body).backgroundColor);
    if (base) over(base);
  }
  // body 也透明时按浏览器默认画布（白）补足
  const rest = 1 - covered;
  return "#" + [r + rest * 255, g + rest * 255, b + rest * 255]
    .map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}
