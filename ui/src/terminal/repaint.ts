import type { Terminal } from "@xterm/xterm";

/** WebGL addon 的最小结构——只用到清图集；不直接依赖 addon 类型便于测试替身。 */
type AtlasLike = { clearTextureAtlas(): void } | null | undefined;

/**
 * 强制重画终端可见区。
 *
 * 长时间高吞吐/高熵输出（CJK、框线、emoji 混排）后，xterm 5.5 的 WebGL 字形图集
 * 可能错位：文本被替换成别的字形，选择/滚动只重画局部行，退出全屏才恢复。
 * 6.0 + addon-webgl 0.19 重写了图集（TextureAtlas/CharAtlasCache），理论上已修复
 * 该缺陷；保留本兜底用于旧缓存、上下文丢失或未来回归——清图集会让全部可见字形
 * 重新烘焙，再全屏 refresh 立即上屏；DOM 渲染器没有图集，refresh 即可。任一步失败
 * （终端/渲染器已释放）都静默——重绘是兜底动作，不该反过来报错。
 */
export function repaintTerm(term: Terminal, webgl: AtlasLike): void {
  try {
    webgl?.clearTextureAtlas();
  } catch {
    /* 渲染器已释放 */
  }
  try {
    term.refresh(0, Math.max(0, term.rows - 1));
  } catch {
    /* 终端已释放 */
  }
}
