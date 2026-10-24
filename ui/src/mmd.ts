// mermaid 围栏的懒加载渲染（形状照搬 tiny-worker 的 mmd.ts，token 换 tiny-ssh）：
// 占位（mdview 的 fence 渲染器产出 .md-code.mermaid-wrap[data-mm]，代码块同款
// 头条 + 代码原文 fallback）→ 本模块消费。mermaid+dompurify 走动态 import 独立
// chunk（MB 级，不进主包；无 mermaid 图的会话零成本）。流式中占位保持代码原文
// （尾块每帧重建不值得反复渲染），turn 末稳定后 agent-view 调 renderMermaidIn。
// 安全：securityLevel:"strict" 关 html 标签与事件绑定（模型文本生成图形，文本
// 内容不可信），DOMPurify svg profile 二次过滤后 innerHTML 插入——mdview 的
// html:false 姿态不变：模型原始标记依然只能从这两条受控通道上屏。
type MermaidApi = (typeof import("mermaid"))["default"];
type Purify = (typeof import("dompurify"))["default"];

let seq = 0;

/** 复杂度闸（稳定轮余量项）：超限图不进渲染、诚实保持代码原文。mermaid 的
 *  布局器对超大图（巨量节点/边）可能长时间占主线程甚至 OOM——模型生成超长
 *  「图」往往本就不是有效图表。字节数与行数双上限，超限在控制台说明原因。 */
const MMD_MAX_BYTES = 64 * 1024;
const MMD_MAX_LINES = 2_000;
export function mermaidTooComplex(src: string): boolean {
  const over =
    new TextEncoder().encode(src).length > MMD_MAX_BYTES ||
    src.split("\n").length > MMD_MAX_LINES;
  if (over) console.warn("[mmd] 图源超过复杂度上限（64KB/2000 行），保持代码原文");
  return over;
}

const escHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** 占位容器内部形态（代码块同款头 + 代码原文 fallback）：初渲染与主题重渲染
 *  的 reset 共用，保证两种路径产出的 DOM 一致。 */
function wrapInner(content: string): string {
  const lines = content.split("\n").length;
  return (
    `<div class="code-head"><span class="code-lang">mermaid</span>` +
    `<span class="code-dim">${lines} 行</span>` +
    `<button class="code-copy" type="button" title="复制图表源码">复制</button></div>` +
    `<pre class="mm-fallback"><code>${escHtml(content)}</code></pre>`
  );
}

/** fence 渲染器的 mermaid 分支：占位容器 = 代码块同款头（源码可复制）+
 *  代码原文 fallback（渲染成功被 SVG 替换、失败诚实保持为代码块）。 */
export function mermaidPlaceholder(content: string): string {
  return `<div class="md-code mermaid-wrap" data-mm="${encodeURIComponent(content)}">${wrapInner(content)}</div>`;
}

/** 渲染 root 内全部待处理占位。单图失败保留代码原文（data-done 挡住重试）；
 *  库加载失败全部保持原状、下次调用可重试。 */
export async function renderMermaidIn(root: ParentNode): Promise<void> {
  const wraps = root.querySelectorAll<HTMLElement>(".mermaid-wrap[data-mm]:not([data-done])");
  if (!wraps.length) return;
  let mermaid: MermaidApi;
  let purify: Purify;
  try {
    [mermaid, purify] = await Promise.all([
      import("mermaid").then((m) => m.default),
      import("dompurify").then((d) => d.default),
    ]);
  } catch {
    return; // 动态库不可得（离线/加载失败）：保持代码原文
  }
  const dark = document.documentElement.dataset.chrome === "dark";
  // 主题变量取自 CSS 自定义属性：节点填充/描边/文字/连线与面板同一配色语言，
  // 全部色板（[data-theme]×[data-chrome] 双条件）即插即用。initialize 每次渲染
  // 前重跑，主题切换重渲染（rerenderMermaids）自然生效。
  // tiny-ssh 的认知色淡底是 color-mix 派生（--accent-soft 等）——mermaid 的颜色
  // 解析器不认 color-mix（实测 initialize 直接抛），先经 DOM 探针把任意 CSS 颜色
  // 解析成计算值（rgb/rgba）再喂给它；解析失败退中性色兜底。
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);
  const cssVar = (name: string, fallback: string): string => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!raw) return fallback;
    try {
      probe.style.color = "";
      probe.style.color = raw;
      const c = getComputedStyle(probe).color;
      return c && !c.includes("color-mix") ? c : fallback;
    } catch {
      return fallback;
    }
  };
  probe.remove();
  // htmlLabels 必须是顶层键（mermaid 12：flowchart:{htmlLabels:false} 嵌套路径
  // 失效、strict 模式默认用 foreignObject 承载 HTML 标签——DOMPurify 对
  // foreignObject 子树是硬剥，实机探针实证「只剩形状没有字」）；顶层 false 让
  // 标签走 <text> 纯 SVG，DOMPurify svg profile 原样保留，strict 清洗事件属性
  // 的双层防御不变
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      htmlLabels: false,
      themeVariables: {
        darkMode: dark,
        background: "transparent",
        // 节点本体 = 代码块外观（--bg 底 + --dim 描边 + --text 文字；描边用 dim
        // 而非 border——后者是低透明 alpha，暗色下节点会糊成一片）
        primaryColor: cssVar("--bg", "#151c26"),
        primaryTextColor: cssVar("--text", "#dbe2ec"),
        primaryBorderColor: cssVar("--dim", "#5e7188"),
        secondaryColor: cssVar("--accent-soft", "#1c2532"),
        secondaryTextColor: cssVar("--text", "#dbe2ec"),
        secondaryBorderColor: cssVar("--dim", "#5e7188"),
        tertiaryColor: cssVar("--panel3", "#1c2532"),
        tertiaryTextColor: cssVar("--text", "#dbe2ec"),
        tertiaryBorderColor: cssVar("--dim", "#5e7188"),
        mainBkg: cssVar("--bg", "#0a0e14"),
        nodeBorder: cssVar("--dim", "#5e7188"),
        lineColor: cssVar("--dim", "#5e7188"),
        textColor: cssVar("--text", "#dbe2ec"),
        titleColor: cssVar("--text", "#dbe2ec"),
        // 连线标签/子图底色垫 chrome 带色：默认 #e8e8e8 在暗色主题是一块亮斑
        edgeLabelBackground: cssVar("--panel2", "#151c26"),
        clusterBkg: cssVar("--panel2", "#151c26"),
        clusterBorder: cssVar("--dim", "#5e7188"),
        noteBkgColor: cssVar("--accent-soft", "#1c2532"),
        noteTextColor: cssVar("--text", "#dbe2ec"),
        noteBorderColor: cssVar("--dim", "#5e7188"),
      },
    });
  } catch {
    return; // 主题变量解析失败：保持代码原文（不产生未捕获拒绝）
  }
  for (const w of Array.from(wraps)) {
    w.setAttribute("data-done", "1"); // 先占位：并发调用不重渲染同一占位
    const src = decodeURIComponent(w.dataset.mm ?? "");
    if (mermaidTooComplex(src)) continue; // 超限：data-done 已置，保持代码原文不重试
    try {
      const { svg } = await mermaid.render(`mmd-${++seq}`, src);
      // 渲染期间容器可能被主题切换 reset（data-done 已摘）：本次成果作废，
      // 由 reset 发起的下一次 renderMermaidIn 接管，避免旧主题 SVG 迟到覆盖
      if (!w.hasAttribute("data-done")) continue;
      // 只把 <pre> 换成 SVG 容器，头条（语言标签/源码复制钮）常驻——渲染成功后
      // 依然能一键拿到图源（复制走 agent-view 的 data-mm 分支）
      const svgHtml = purify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      const pre = w.querySelector("pre.mm-fallback");
      if (pre) pre.outerHTML = `<div class="mm-body">${svgHtml}</div>`;
      w.classList.add("mm-ok");
    } catch {
      // 语法错误/渲染失败：保留代码原文（诚实降级，源码仍可复制）
    }
  }
}

/** 主题切换重渲染：把全部已渲染/已尝试的图还原成待渲染占位（旧主题 SVG 与
 *  失败标记一并清掉），再按当前主题重画——initialize 每次渲染前都跑，新主题
 *  即时生效。reset 与在途渲染的竞态由渲染循环的 data-done 复查挡住。 */
export async function rerenderMermaids(root: ParentNode): Promise<void> {
  const done = root.querySelectorAll<HTMLElement>(".mermaid-wrap[data-mm][data-done]");
  for (const w of Array.from(done)) {
    const src = decodeURIComponent(w.dataset.mm ?? "");
    w.removeAttribute("data-done");
    w.classList.remove("mm-ok");
    w.innerHTML = wrapInner(src);
  }
  await renderMermaidIn(root);
}
