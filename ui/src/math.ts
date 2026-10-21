// 数学公式的懒加载渲染（形状照搬 tiny-worker 的 math.ts）：与 mermaid 同一条
// 「占位 → 动态 import → 消费」管线。md 装配期产出占位（.math-inline/.math-block
// [data-mml]），turn 末稳定后 agent-view 调 renderMathIn。KaTeX 走动态 import
// 独立 chunk（JS + 字体，不进主包；无公式的会话零成本）。渲染失败/库不可得时
// 保持源码原文 fallback，与 mermaid 的诚实降级一致。
// 误判防线（聊天里 $ 常是货币）：行内 $..$ 的开定界符后/闭定界符前不许有
// 空白、闭定界符后不许紧跟数字（$100 和 $200 不配对）、内容含 CJK/假名不
// 配对（中文聊天里的价格与比较）、内容超 512 字符不配对。显式 $$..$$ 无此
// 限制——写出来就是想要公式。
import type { MarkdownIt, StateBlock, StateInline, Token } from "markdown-it";

type Katex = (typeof import("katex"))["default"];
type Purify = (typeof import("dompurify"))["default"];

const escHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** 占位 HTML：源码原文做 fallback（渲染成功被 KaTeX HTML 替换、失败诚实保留）。
 *  data-mml 走 encodeURIComponent，与 mermaid 的 data-mm 同款防注入编码；
 *  displayMode 由 data-display 承载（段内 $$..$$ 的 display 形态必须是 span
 *  ——p 里不许 div，样式走 .math-display）。 */
function mathPlaceholder(content: string, block: boolean, tag: "div" | "span"): string {
  const cls = block ? "math-block" : "math-inline";
  return `<${tag} class="${cls}${block && tag === "span" ? " math-display" : ""}" data-mml="${encodeURIComponent(content)}"${block ? ' data-display="1"' : ""}><code class="math-fallback">${escHtml(content)}</code></${tag}>`;
}

/** 块级规则：$$ 开头的行起块，到独占一行的 $$ 收口（未闭合不当公式，流式中
 *  自然降级为普通文本，闭合帧整块成型）。单行形态 $$x=1$$ 要求闭合后行内
 *  无残留文字，否则整行交回段落+行内规则。 */
function mathBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const line = state.src.slice(start, max);
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("$$")) return false;
  const rest = trimmed.slice(2);
  let content: string;
  let next: number;
  const closeInFirst = rest.indexOf("$$");
  if (closeInFirst >= 0) {
    if (rest.slice(closeInFirst + 2).trim()) return false; // 行内混正文 → 段落路径
    content = rest.slice(0, closeInFirst);
    next = startLine + 1;
  } else {
    const parts: string[] = rest ? [rest] : [];
    next = startLine + 1;
    let closed = false;
    for (; next < endLine; next++) {
      const s = state.bMarks[next] + state.tShift[next];
      const t = state.src.slice(s, state.eMarks[next]).trim();
      if (t === "$$") {
        closed = true;
        next++;
        break;
      }
      parts.push(state.src.slice(s, state.eMarks[next]));
    }
    if (!closed) return false;
    content = parts.join("\n");
  }
  if (!content.trim()) return false; // $$$$ / 空块：留给字面文本
  if (silent) return true;
  const token = state.push("math_block", "div", 0);
  token.content = content;
  token.markup = "$$";
  state.line = next;
  return true;
}

/** 行内规则：$...$（及段中 $$...$$ display 形态）。定界符配对纪律见模块头注。 */
function mathInlineRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x24 /* $ */) return false;
  const display = src.charCodeAt(pos + 1) === 0x24;
  const open = display ? 2 : 1;
  const close = display ? "$$" : "$";
  const begin = pos + open;
  // 开定界符后不许空白（$ x$ 是金额加词）
  if (/\s/.test(src.charAt(begin))) return false;
  const end = src.indexOf(close, begin);
  if (end < 0) return false;
  const content = src.slice(begin, end);
  // 闭定界符前不许空白（$x $ 同上）；空内容留给字面 $$
  if (!content || /\s$/.test(content)) return false;
  const after = src.charCodeAt(end + close.length);
  // 闭定界符后紧跟数字：$100 和 $200 的前半配对形态，保持字面（display 不设限）
  if (!display && after >= 0x30 && after <= 0x39) return false;
  // 内容含 CJK/假名：中文聊天里的「$A 比 $B 贵」，保持字面（display 不设限）
  if (!display && /[\u4e00-\u9fff\u3040-\u30ff]/.test(content)) return false;
  // 超长杂散配对（整段被两个 $ 跨住的厄运形态）：保持字面
  if (content.length > 512) return false;
  if (!silent) {
    const token = state.push(display ? "math_block_inline" : "math_inline", "span", 0);
    token.content = content;
    token.markup = display ? "$$" : "$";
  }
  state.pos = end + close.length;
  return true;
}

/** md 实例装配：块/行内规则 + 占位渲染器（mdview 的模块单例调用一次） */
export function installMath(md: MarkdownIt): void {
  md.block.ruler.before("fence", "math_block", mathBlockRule);
  md.inline.ruler.before("escape", "math_inline", mathInlineRule);
  md.renderer.rules.math_inline = (tokens: Token[], idx: number) => mathPlaceholder(tokens[idx].content, false, "span");
  md.renderer.rules.math_block = (tokens: Token[], idx: number) => mathPlaceholder(tokens[idx].content, true, "div");
  // 段落中的 $$...$$（display 行内形态）：span 承载 + data-display
  md.renderer.rules.math_block_inline = (tokens: Token[], idx: number) => mathPlaceholder(tokens[idx].content, true, "span");
}

/** ```math 围栏的占位（模型发公式的常见形态）：块级 display 形态 */
export function mathFencePlaceholder(content: string): string {
  return mathPlaceholder(content, true, "div");
}

/** 渲染 root 内全部待处理占位。单条失败保留源码原文（data-done 挡重试）；
 *  库加载失败全部保持原状。KaTeX 默认转义文本、\href 等需 trust 的特性关闭
 *  （不可信输入的默认安全面），DOMPurify html+mathMl profile 二次过滤。 */
export async function renderMathIn(root: ParentNode): Promise<void> {
  const els = root.querySelectorAll<HTMLElement>(
    ".math-inline[data-mml]:not([data-done]), .math-block[data-mml]:not([data-done])",
  );
  if (!els.length) return;
  let katex: Katex;
  let purify: Purify;
  try {
    // katex css 随动态 import 注入（声明见 katex-css.d.ts），不进主包；
    // 无公式的会话连这条 import 都不会发生
    [katex, purify] = await Promise.all([
      import("katex").then((m) => m.default),
      import("dompurify").then((d) => d.default),
      import("katex/dist/katex.min.css"),
    ]);
  } catch {
    return; // 动态库不可得（离线/加载失败）：保持源码原文
  }
  for (const el of Array.from(els)) {
    el.setAttribute("data-done", "1"); // 先占位：并发调用不重渲染同一占位
    const src = decodeURIComponent(el.dataset.mml ?? "");
    try {
      const html = katex.renderToString(src, {
        throwOnError: false,
        displayMode: el.hasAttribute("data-display"),
        strict: false,
      });
      el.innerHTML = purify.sanitize(html, { USE_PROFILES: { html: true, mathMl: true, svg: true } });
      el.classList.add("math-ok");
    } catch {
      // 渲染失败：保留源码原文（throwOnError:false 下极少走到）
    }
  }
}
