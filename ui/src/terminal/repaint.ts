import type { Terminal } from "@xterm/xterm";

/** 参与重绘的终端条目：主终端与 tmux 格子同形。 */
export type RepaintEntry = { term: Terminal };

/**
 * 全量重绘一组终端（只 refresh，**不调 clearTextureAtlas**）。
 *
 * GitHub #39 / KI-014 复发：xterm 6.0.0 + addon-webgl 0.19.0（当前 stable）的字形图集
 * 按 font/theme/DPR 配置在终端间共享（CharAtlasCache），但 `clearTextureAtlas()` 只
 * 重建调用者自己的模型——兄弟终端要到下一次重排才恢复，表现就是整屏字形互相顶替、
 * 任何一次 resize 后自愈（上游 #6014；修复 #6055 只在 6.1 / addon 0.20 beta，stable
 * 未发布）。上游给 0.19.0 的用户态缓解原文就是**停掉自己发起的 clearTextureAtlas()**：
 * 共享图集从任一终端清一次都会波及所有同配置终端。
 *
 * 所以这里只做全量 refresh：选中文本、滚动、重排都会触发重烘焙/重绘，实测用户侧
 * 「切一次专注模式」就能自愈；配置变化本来就会按 key 取新图集，显式清图集在 0.19.0
 * 上得不偿失。待 addon-webgl 升到 0.20（xterm 6.1）后再评估是否恢复清图集。
 * refresh 失败（终端已释放）静默——重绘是兜底动作，不该反过来报错。
 */
export function repaintAll(entries: Iterable<RepaintEntry>): void {
  for (const e of entries) {
    try {
      e.term.refresh(0, Math.max(0, e.term.rows - 1));
    } catch {
      /* 终端已释放 */
    }
  }
}
