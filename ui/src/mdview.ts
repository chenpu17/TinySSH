// agent 对话的 markdown → HTML 渲染（活动栏轮）。规则与安全姿态照搬 tiny-worker
// 的 mdview.ts（同作者参考实现）：markdown-it `html:false`——模型输出的原始 HTML
// 一律转义，页面上出现的标记只能来自这里的渲染器规则（已知良好形状），没有注入面。
// 链接强制新窗口 + title 兜底 href 防「显示文本与实际目标不符」的 linkify 钓鱼；
// 代码块外包头条（语言标签 + 复制钮），稳定块超 26 行折叠（流式中的块不折叠，
// 避免每帧重建重置展开状态造成跳动）；复制/展开点击走容器事件代理（agent-view），
// 不能直绑按钮——流式重建 DOM 会把监听器一起冲掉。mermaid/math 围栏与 $..$/$$..$$
// 公式出「占位」（mmd.ts/math.ts 的懒加载管线，独立 chunk 不进主包；流式中保持
// 代码原文，turn 末稳定后才渲染），渲染通道双重受控（mermaid strict + DOMPurify），
// html:false 姿态不变。
import MarkdownIt from "markdown-it";
import type { MarkdownIt as MdIt } from "markdown-it";
import hljs from "highlight.js/lib/common";
import { mermaidPlaceholder } from "./mmd";
import { installMath, mathFencePlaceholder } from "./math";

/** 超过该行数的稳定代码块默认收起（tiny-worker 同款阈值） */
export const CODE_CLIP_LINES = 26;

const md: MdIt = new MarkdownIt({ html: false, linkify: true, breaks: true });

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  // 桌面壳无浏览器状态栏，悬停看不到真实去向——title 补上 href 防钓鱼
  if (!tokens[idx].attrGet("title")) tokens[idx].attrSet("title", tokens[idx].attrGet("href") ?? "");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

md.renderer.rules.fence = (tokens, idx, _options, _env, _self) => {
  const rawLang = tokens[idx].info.trim().split(/\s+/g)[0] ?? "";
  const lang = md.utils.escapeHtml(rawLang);
  // mermaid 围栏：占位容器（代码块同款头 + 代码原文 fallback），运行时由
  // mmd.renderMermaidIn 懒加载渲染成 SVG——语法错误/库不可得时保持代码原文
  if (rawLang.toLowerCase() === "mermaid") {
    return mermaidPlaceholder(tokens[idx].content);
  }
  // math 围栏：占位容器（源码原文 fallback），运行时由 math.renderMathIn
  // 懒加载渲染成 KaTeX HTML
  if (rawLang.toLowerCase() === "math") {
    return mathFencePlaceholder(tokens[idx].content);
  }
  const lines = tokens[idx].content.split("\n").length;
  const collapsed = lines > CODE_CLIP_LINES && !_env?.streaming;
  const body = hljs.getLanguage(rawLang)
    ? `<code class="hljs language-${lang}">${hljs.highlight(tokens[idx].content, { language: rawLang, ignoreIllegals: true }).value}</code>`
    : `<code>${md.utils.escapeHtml(tokens[idx].content)}</code>`;
  return (
    `<div class="md-code${collapsed ? " code-collapsed" : ""}">` +
    `<div class="code-head"><span class="code-lang">${lang || "文本"}</span>` +
    `<span class="code-dim">${lines} 行</span>` +
    (collapsed ? `<button class="code-expand" type="button">展开全部</button>` : "") +
    `<button class="code-copy" type="button" title="复制代码">复制</button></div>` +
    `<pre>${body}</pre></div>`
  );
};

/** 渲染 agent 消息 markdown。`streaming` 为真时不折叠代码块（尾块每帧重建）。 */
export function renderAgentMd(src: string, streaming = false): string {
  return md.render(src, { streaming });
}

// 公式规则装配（块/行内 + 占位渲染器）——模块单例只装一次
installMath(md);
