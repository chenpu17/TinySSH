// 可点击路径（P2）：终端里的文件路径（含 :line / :line:col 后缀）识别为链接，
// 点击复制原文到剪贴板。远端路径没法在本机打开，复制是最诚实有用的动作（本地
// 会话同语义）；http(s) 仍归 WebLinksAddon。匹配器是纯函数单独出模块——spec
// 直接断言匹配语义，hover/激活链路走 xterm registerLinkProvider 原生机制。

import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

export interface PathHit {
  /** 起点列（cell，0 基） */
  start: number;
  /** 终点列（不含） */
  end: number;
  /** 点击复制的原文（path 或 path:line 或 path:line:col） */
  text: string;
  path: string;
  line: number | null;
  col: number | null;
}

// 识别规则（v1 保守——误识别比漏识别更糟，满屏词都会被划成链接）：
//  A Windows 盘符：C:\a\b\c.rs（正反斜杠都认）
//  B POSIX 绝对：/var/log/syslog（≥1 段，仅正斜杠——裸反斜杠串如 \r\ty 是转义序列不是路径）
//  C 显式相对：./x.ts、..\a\b.rs
//  D 裸多段：src/main.rs（≥2 段，仅正斜杠，单文件名不识别）
//  后缀可选 :line 或 :line:col（grep -n / rustc --> / tsc 格式）——**整组包住四个
//  分支再接后缀**：正则交替 | 优先级最低，直接 A|B|C|D(?::…)？ 后缀只挂在 D 上。
//  匹配后逐条做边界检查：前邻 ASCII 单词字符或另一个斜杠（URL 的 // 与转义串）
//  拒绝；xxx:// 协议前缀拒绝（让路给网页链接）；尾部句点裁掉（句读不是文件名）。
const SEG = String.raw`[\w.@+\-]`;
const PATH_RE = new RegExp(
  String.raw`(?:(?:[A-Za-z]:(?:[\\/][\w.@+\-]+)+)` +
  String.raw`|(?:(?:/[\w.@+\-]+)+)` +
  String.raw`|(?:\.{1,2}[\\/](?:[\w.@+\-]+[\\/])*[\w.@+\-]+)` +
  String.raw`|(?:[\w.@+\-]+(?:/[\w.@+\-]+)+))` +
  String.raw`(?::(\d{1,6})(?::(\d{1,6}))?)?`,
  "g",
);

/** 在一行文本里找路径命中（纯函数，spec 直测）。 */
export function matchPaths(line: string): PathHit[] {
  const hits: PathHit[] = [];
  PATH_RE.lastIndex = 0;
  for (;;) {
    const m = PATH_RE.exec(line);
    if (!m) break;
    let end = m.index + m[0].length;
    while (end > m.index && line[end - 1] === ".") end--;
    const start = m.index;
    if (end - start < 2) { PATH_RE.lastIndex = m.index + 1; continue; }
    if (start > 0) {
      const p = line[start - 1];
      // 前邻是 ASCII 词字符（标识符内部碎片）、另一个斜杠（URL 的 //、转义串 \r）、
      // 或句点（example.com/a/b 的域名内部）；或 xxx:// 协议头
      if (/[A-Za-z0-9_.]/.test(p) || p === "/" || p === "\\") { PATH_RE.lastIndex = m.index + 1; continue; }
      if (p === ":" && start >= 2 && /[A-Za-z]/.test(line[start - 2])) { PATH_RE.lastIndex = m.index + 1; continue; }
    }
    let suffix = 0;
    if (m[1] !== undefined) {
      suffix += 1 + m[1].length;
      if (m[2] !== undefined) suffix += 1 + m[2].length;
    }
    hits.push({
      start,
      end,
      text: line.slice(start, end),
      path: m[0].slice(0, m[0].length - suffix),
      line: m[1] !== undefined ? Number(m[1]) : null,
      col: m[2] !== undefined ? Number(m[2]) : null,
    });
    if (PATH_RE.lastIndex === m.index) PATH_RE.lastIndex++;
  }
  return hits;
}

/**
 * 把一行缓冲的**字符**按 cell 位置对齐后跑匹配器。宽字符（CJK）占 2 cell 但 1 个
 * 字符——逐 cell 取字符、右半 spacer 以空串占位，join 后字符串下标即 cell 列，
 * 匹配区间可直接用作 IBufferRange。空白 cell 的 getChars() 是空串，归一成空格。
 */
export function lineCellText(line: { length: number; getCell(x: number): { getWidth(): number; getChars(): string } | undefined }): string {
  const cells: string[] = [];
  for (let x = 0; x < line.length; x++) {
    const c = line.getCell(x);
    if (!c) break;
    cells.push(c.getWidth() === 0 ? "" : (c.getChars() || " "));
  }
  return cells.join("");
}

/** xterm 链接提供者：命中即建链接，激活时回调原文（点击复制在宿主闭包里）。
 * 官方 WebLinksAddon 同款约定：provideLinks 的 bufferLineNumber 是 **1 基**（它
 * 自己 getLine(e - 1)）；range.x 是「start 1 基含、end 排他」。 */
export function pathLinkProvider(term: Terminal, onActivate: (text: string) => void): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) { callback(undefined); return; }
      const text = lineCellText(line);
      const hits = matchPaths(text);
      if (hits.length === 0) { callback(undefined); return; }
      const links: ILink[] = hits.map((h) => ({
        range: { start: { x: h.start + 1, y: bufferLineNumber }, end: { x: h.end, y: bufferLineNumber } },
        text: h.text,
        activate: () => onActivate(h.text),
      }));
      callback(links);
    },
  };
}
