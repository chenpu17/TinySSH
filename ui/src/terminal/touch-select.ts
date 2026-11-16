// 触摸选区（KI-052 移动端）：把触点映射到缓冲区格子、按词扩边、按锚点/焦点算
// 选区长度。xterm 自身只有鼠标划选（`user-select:none` + 鼠标事件），触屏拿不到
// 选区；这里只做「几何 + 缓冲区」纯逻辑，指针状态机与浮条留在 App.tsx。
//
// 行号是**缓冲区行**（`buffer.active.viewportY + 屏内行`）——`term.select()` 的
// row 参数就是缓冲区行，不是视口行；滚动过后两者不相等。
import type { Terminal } from "@xterm/xterm";

export interface CellPos {
  /** cell 列（0 基；宽字符占 2 格） */
  col: number;
  /** 缓冲区行（0 基） */
  row: number;
}

export interface CellSpan extends CellPos {
  /** 从 col 起的选择长度（cell 数，含 col 本身） */
  len: number;
}

/** 渲染单元格尺寸（xterm 5.5/6 无公开 `dimensions`，走 `_core` 私有路径——与
 *  官方 addon-fit、本仓 fitDimsOf 同源）。未就绪（隐藏会话/首帧）返回 null。 */
function cellDimsOf(term: Terminal): { w: number; h: number } | null {
  const core = (term as unknown as {
    _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } };
  })._core;
  const w = core?._renderService?.dimensions?.css?.cell?.width;
  const h = core?._renderService?.dimensions?.css?.cell?.height;
  return w && h ? { w, h } : null;
}

/** 屏幕坐标 → 缓冲区格子。落在屏幕外或尺寸未就绪返回 null。 */
export function cellAtPoint(
  term: Terminal,
  screenEl: HTMLElement,
  clientX: number,
  clientY: number,
): CellPos | null {
  const dims = cellDimsOf(term);
  if (!dims) return null;
  const r = screenEl.getBoundingClientRect();
  if (clientX < r.left || clientY < r.top || clientX >= r.right || clientY >= r.bottom) return null;
  const vrow = Math.max(0, Math.min(term.rows - 1, Math.floor((clientY - r.top) / dims.h)));
  const col = Math.max(0, Math.min(term.cols - 1, Math.floor((clientX - r.left) / dims.w)));
  return { col, row: term.buffer.active.viewportY + vrow };
}

// xterm 默认 wordSeparator = " ()[]{}',\"`"：空白与这些字符都算词边界；双击
// 选词的语义保持一致，长按才有「这个词」的直觉。
const SEPARATORS = new Set(" ()[]{}',\"`".split(""));

function lineWordy(term: Terminal, row: number, col: number): boolean {
  const cell = term.buffer.active.getLine(row)?.getCell(col);
  if (!cell) return false;
  if (cell.getWidth() === 0) return true; // 宽字符右半格：跟随左邻，算词内
  const chars = cell.getChars();
  if (!chars) return false;
  for (const ch of chars) if (!SEPARATORS.has(ch) && ch.trim() !== "") return true;
  return false;
}

function isContinuation(term: Terminal, row: number, col: number): boolean {
  return term.buffer.active.getLine(row)?.getCell(col)?.getWidth() === 0;
}

/**
 * 触点到词的选区：按住字符时扩到该词边界；按在空白/分隔符上退化为「整行首尾
 * 非空白」（空行则选一格）。宽字符右半格归到字符起点。行不存在返回 null。
 */
export function wordAt(term: Terminal, row: number, col: number): CellSpan | null {
  if (!term.buffer.active.getLine(row)) return null;
  const cols = term.cols;
  let c = Math.max(0, Math.min(cols - 1, col));
  if (isContinuation(term, row, c) && c > 0) c -= 1;
  if (!lineWordy(term, row, c)) {
    let s = -1;
    let e = -1;
    for (let x = 0; x < cols; x++) {
      if (isContinuation(term, row, x)) continue;
      if (lineWordy(term, row, x)) {
        if (s < 0) s = x;
        e = x;
      }
    }
    return s < 0 ? { col: c, row, len: 1 } : { col: s, row, len: e - s + 1 };
  }
  let s = c;
  let e = c;
  while (s > 0) {
    const p = s - 1;
    if (isContinuation(term, row, p)) { s = Math.max(0, p - 1); continue; }
    if (!lineWordy(term, row, p)) break;
    s = p;
  }
  while (e < cols - 1) {
    const n = e + 1;
    if (isContinuation(term, row, n)) { e = n; continue; }
    if (!lineWordy(term, row, n)) break;
    e = n;
  }
  return { col: s, row, len: e - s + 1 };
}

/**
 * 锚点 → 焦点的选区（长按后拖动扩选）。xterm 只给「起点 + 长度」的 API，长度按
 * 缓冲区 cell 线性计：跨行时 + 整行宽度，由 xterm 在 getSelection 里还原换行。
 * 两点的先后顺序无关。
 */
export function applyRangeSelection(term: Terminal, a: CellPos, b: CellPos): void {
  let start = a;
  let end = b;
  if (end.row < start.row || (end.row === start.row && end.col < start.col)) {
    start = b;
    end = a;
  }
  const len = (end.row - start.row) * term.cols + (end.col - start.col) + 1;
  term.select(start.col, start.row, Math.max(1, len));
}
