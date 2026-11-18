import type { Terminal } from "@xterm/xterm";

/** 参与重绘的终端条目：主终端与 tmux 格子同形。 */
export type RepaintEntry = { term: Terminal };

/**
 * 全量重绘一组终端：先清**每个终端自己的绘制模型**，再 refresh；不清共享字形图集。
 *
 * GitHub #39 / #47（KI-014）：xterm 6.0.0 + addon-webgl 0.19.0 的图集按
 * font/theme/DPR 跨终端共享。图集被清空或重排后，其他终端的 RenderModel 仍保存旧
 * 纹理坐标，于是中文位置画出拉丁/符号、任何一次重排又可能自愈。公开 `refresh()`
 * 只请求重画指定行，**不会清 RenderModel**，所以旧版 repaintAll 实测修不住：
 * 清一次共享图集后，兄弟终端在重绘前后逐像素完全相同地错着。
 *
 * `_renderService.clear()` 会走各渲染器自己的 `clear()`；WebGL 路径据此执行
 * `_clearModel(true)`，下一次 refresh 从缓冲区重新取字形与纹理坐标。对全部终端
 * 都执行，等价于把上游 #6055 的「共享图集失效要广播给所有拥有者」落在应用侧，
 * 无需依赖 6.1 / addon 0.20 beta，也不碰 stable 上仍有缺陷的 clearTextureAtlas()。
 * xterm 没有公开清绘制模型的 API；这里与项目既有 fit/探针一样走 `_core` 内部口，
 * 缺失时仍退化为公开 refresh。终端已释放等异常静默——重绘兜底不应反过来报错。
 */
export function repaintAll(entries: Iterable<RepaintEntry>): void {
  for (const e of entries) {
    try {
      const core = (e.term as unknown as {
        _core?: { _renderService?: { clear?: () => void } };
      })._core;
      core?._renderService?.clear?.();
      e.term.refresh(0, Math.max(0, e.term.rows - 1));
    } catch {
      /* 终端已释放 */
    }
  }
}
