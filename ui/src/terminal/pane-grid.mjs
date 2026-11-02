// tmux 面板网格几何（纯函数零依赖）：App 布局与 spec 63 真值表共用（node spec 导不进
// TS 源，故独立成 .mjs——locale-resolver 同款）。
// n = 格子总数（索引 0 恒为主视图，其后为面板格）。列数：1→1、2→2、3–4→2、5–6→3；
// 行数 = ceil(n/列数)；末行不满时该行各格均分整行宽（tmux tiled 同观感——不留空洞）。
// 返回每格 { left, top, width, height }，均为容器的 0..1 分数。
export function paneGrid(n) {
  const k = Math.max(1, Math.floor(Number(n) || 1));
  const cols = k <= 2 ? k : k <= 4 ? 2 : 3;
  const rows = Math.ceil(k / cols);
  const out = [];
  for (let i = 0; i < k; i++) {
    const r = Math.floor(i / cols);
    const inRow = r === rows - 1 ? k - cols * (rows - 1) : cols;
    const c = i - r * cols;
    out.push({ left: c / inRow, top: r / rows, width: 1 / inRow, height: 1 / rows });
  }
  return out;
}
