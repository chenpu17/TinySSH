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

// ---- 可拖拽布局（2026-11-02）：嵌套行/列树 ----
// 节点：叶 { key, w } | 容器 { dir, w, kids }。dir="row" 子节点左右并排（竖分隔条），
// "col" 上下堆叠（横分隔条）；w = 在父容器内的相对权重（几何按权重占比切分）。
// key：主视图 MAIN_KEY，格子用 tmux 会话名（同标签内唯一；tmux 会话名不含冒号，不会撞）。
// 规范形：容器至少两个子节点、子容器与父容器不同向——每次变换后 normalize 收口。
// 所有变换返回新树，不改入参。

export const MAIN_KEY = ":main";

const leaf = (key, w = 1) => ({ key, w });
const total = (kids) => kids.reduce((s, k) => s + k.w, 0) || 1;

/** 默认布局：与 paneGrid(keys.length) 逐格同几何（用户没拖过时沿用自动平铺）。 */
export function defaultLayout(keys) {
  const n = keys.length;
  if (n === 0) return null;
  if (n === 1) return leaf(keys[0]);
  const cols = n <= 2 ? n : n <= 4 ? 2 : 3;
  const rows = [];
  for (let i = 0; i < n; i += cols) rows.push(keys.slice(i, i + cols));
  const rowNode = (ks) => (ks.length === 1 ? leaf(ks[0]) : { dir: "row", w: 1, kids: ks.map((k) => leaf(k)) });
  return rows.length === 1 ? rowNode(rows[0]) : { dir: "col", w: 1, kids: rows.map(rowNode) };
}

/**
 * 布局 → 各格几何 + 分隔条（均为容器 0..1 分数）。分隔条 = 容器内相邻两子节点的边界：
 * path 定位容器、index 为左/上侧子节点下标；row 容器的条竖立在 x、自 y 起长 len（占高），
 * col 容器的条横躺在 y、自 x 起长 len（占宽）；box 为容器自身几何（拖拽换算像素用）。
 */
export function layoutRects(root) {
  const tiles = [];
  const dividers = [];
  const walk = (node, rect, path) => {
    if (!node.kids) {
      tiles.push({ key: node.key, ...rect });
      return;
    }
    const t = total(node.kids);
    let off = 0;
    node.kids.forEach((kid, i) => {
      const f = kid.w / t;
      const r = node.dir === "row"
        ? { left: rect.left + rect.width * off, top: rect.top, width: rect.width * f, height: rect.height }
        : { left: rect.left, top: rect.top + rect.height * off, width: rect.width, height: rect.height * f };
      if (i > 0) {
        dividers.push(node.dir === "row"
          ? { path, index: i - 1, dir: "row", x: r.left, y: rect.top, len: rect.height, box: rect }
          : { path, index: i - 1, dir: "col", x: rect.left, y: r.top, len: rect.width, box: rect });
      }
      walk(kid, r, [...path, i]);
      off += f;
    });
  };
  if (root) walk(root, { left: 0, top: 0, width: 1, height: 1 }, []);
  return { tiles, dividers };
}

/**
 * 规范化：摘空容器、单子容器上提（子节点接过它的权重位）、同向子容器摊平进父容器；
 * 兄弟权重归一到和为 1（几何只看占比，归一不改布局——防同轴开关格循环里权重逐轮
 * 减半、数千轮后下溢成 0）。
 */
function normalize(node) {
  if (!node || !node.kids) return node;
  const kids = [];
  for (const k of node.kids.map(normalize)) {
    if (!k) continue;
    if (k.kids && k.dir === node.dir) {
      // 同向摊平：子容器的各子按其在子容器内的占比分走子容器的权重
      const t = total(k.kids);
      for (const x of k.kids) kids.push({ ...x, w: (k.w * x.w) / t });
    } else {
      kids.push(k);
    }
  }
  if (kids.length === 0) return null;
  if (kids.length === 1) return { ...kids[0], w: node.w };
  const t = total(kids);
  return { ...node, kids: kids.map((k) => ({ ...k, w: k.w / t })) };
}

export function nodeAt(root, path) {
  let n = root;
  for (const i of path) {
    if (!n || !n.kids || !n.kids[i]) return null;
    n = n.kids[i];
  }
  return n ?? null;
}

/** 摘掉一格：它的占比按比例还给同容器的兄弟（不留空洞）；摘空返回 null；不在树里原样返回。 */
export function removeTile(root, key) {
  if (!root) return null;
  if (!layoutRects(root).tiles.some((t) => t.key === key)) return root;
  const strip = (n) => (n.kids ? { ...n, kids: n.kids.map(strip).filter(Boolean) } : n.key === key ? null : n);
  const out = normalize(strip(root));
  return out ? { ...out, w: 1 } : null;
}

/** 树里是否已有某键的叶子（改名前查 stale 叶用——重复键 syncLayout 永不剪，会随开格繁殖）。 */
export function treeHasKey(root, key) {
  if (!root) return false;
  if (root.kids) return root.kids.some((k) => treeHasKey(k, key));
  return root.key === key;
}

/** 两格互换位置（各自的位置与大小留在原处，换的是谁住进去）。 */
export function swapTiles(root, a, b) {
  const map = (n) => (n.kids
    ? { ...n, kids: n.kids.map(map) }
    : n.key === a ? { ...n, key: b } : n.key === b ? { ...n, key: a } : n);
  return map(root);
}

/**
 * 把 key 放到 target 的某一侧：target 对半分，key 占落点那一半。父容器同向则作兄弟插入
 * （平分 target 原占比），否则把 target 包成新的同向容器。
 */
export function insertBeside(root, target, side, key) {
  const dir = side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "top";
  const rec = (n, parentDir) => {
    if (n.kids) return [{ ...n, kids: n.kids.flatMap((k) => rec(k, n.dir)) }];
    if (n.key !== target) return [n];
    if (parentDir === dir) {
      const a = leaf(target, n.w / 2);
      const b = leaf(key, n.w / 2);
      return before ? [b, a] : [a, b];
    }
    return [{ dir, w: n.w, kids: before ? [leaf(key), leaf(target)] : [leaf(target), leaf(key)] }];
  };
  return normalize(rec(root, null)[0]);
}

const ZONES = new Set(["center", "left", "right", "top", "bottom"]);

/** 拖标题栏落下：中央=与目标互换；四边=从原处摘下、放到目标那一侧（非法落点原样返回）。 */
export function moveTile(root, src, dst, zone) {
  if (!root || src === dst || !ZONES.has(zone)) return root;
  const keys = new Set(layoutRects(root).tiles.map((t) => t.key));
  if (!keys.has(src) || !keys.has(dst)) return root;
  if (zone === "center") return swapTiles(root, src, dst);
  const without = removeTile(root, src);
  return without ? insertBeside(without, dst, zone, src) : root;
}

/**
 * 与在场格子对账：摘掉已不在的（空间还给兄弟）；新来的从当前最大的格子里分出一半
 * （按像素长边切，面积并列取靠后者）。aspect = 容器宽/高。
 */
export function syncLayout(root, keys, aspect = 16 / 9) {
  const want = new Set(keys);
  let cur = root;
  for (const t of layoutRects(root).tiles) if (!want.has(t.key)) cur = removeTile(cur, t.key);
  const have = new Set(layoutRects(cur).tiles.map((t) => t.key));
  for (const k of keys) {
    if (have.has(k)) continue;
    if (!cur) {
      cur = leaf(k);
    } else {
      let big = null;
      for (const t of layoutRects(cur).tiles) {
        if (!big || t.width * t.height >= big.width * big.height - 1e-9) big = t;
      }
      cur = insertBeside(cur, big.key, big.width * aspect >= big.height ? "right" : "bottom", k);
    }
    have.add(k);
  }
  return cur;
}

// 两侧占比下限的地板：调用方不传 min 时也不产出零宽格（规范形要求 w > 0）
const MIN_FRAC = 1e-4;

/**
 * 拖分隔条：path 处容器第 index 与 index+1 子节点的边界挪到 frac（容器内 0..1 分数），
 * 两侧各守最小占比 minA/minB（同为容器内分数）。两侧最小值加起来放不下（窗口太小）时
 * 只许「不让任何一侧比现在更小」的移动——已经偏小的一侧只能被放大，分隔条不锁死。
 */
export function resizeAt(root, path, index, frac, minA = 0, minB = 0) {
  const node = nodeAt(root, path);
  if (!node || !node.kids || !Number.isInteger(index) || index < 0 || index + 1 >= node.kids.length) return root;
  if (!Number.isFinite(frac)) return root;
  const t = total(node.kids);
  let pre = 0;
  for (let i = 0; i < index; i++) pre += node.kids[i].w / t;
  const cur = pre + node.kids[index].w / t;
  const post = cur + node.kids[index + 1].w / t;
  let lo = pre + Math.max(MIN_FRAC, Number.isFinite(minA) ? minA : 0);
  let hi = post - Math.max(MIN_FRAC, Number.isFinite(minB) ? minB : 0);
  if (lo > hi) {
    lo = Math.min(lo, cur);
    hi = Math.max(hi, cur);
  }
  const f = Math.min(hi, Math.max(lo, frac));
  if (Math.abs(f - cur) < 1e-12) return root; // 没动（夹到原位）：原样返回，不把自动平铺翻成自定义
  const kids = node.kids.map((k, i) => (i === index ? { ...k, w: (f - pre) * t } : i === index + 1 ? { ...k, w: (post - f) * t } : k));
  return replaceAt(root, path, { ...node, kids });
}

/** 双击分隔条：该容器的子节点均分。 */
export function equalizeAt(root, path) {
  const node = nodeAt(root, path);
  if (!node || !node.kids) return root;
  return replaceAt(root, path, { ...node, kids: node.kids.map((k) => ({ ...k, w: 1 })) });
}

function replaceAt(root, path, next) {
  if (path.length === 0) return next;
  const [i, ...rest] = path;
  return { ...root, kids: root.kids.map((k, j) => (j === i ? replaceAt(k, rest, next) : k)) };
}

/**
 * 节点沿某轴的最小像素：叶取 minW/minH；异向容器取子节点最大值；同向容器按「子节点
 * 保持当前占比整体缩放」求——拖外层分隔条时内层权重不变、各子等比缩放，故是
 * max(子最小值 / 子占比)（求和只是下界：比例不均时最窄的子格会被压破最小值）。
 */
export function minExtent(node, axis, minW, minH) {
  if (!node.kids) return axis === "x" ? minW : minH;
  const along = (node.dir === "row") === (axis === "x");
  const t = total(node.kids);
  let m = 0;
  for (const k of node.kids) {
    const e = minExtent(k, axis, minW, minH);
    m = Math.max(m, along ? e / (k.w / t) : e);
  }
  return m;
}

/** 指针在目标格内的相对位置 → 落点：距最近一边不足 1/4 即该边，否则中央（互换）。 */
export function dropZone(rx, ry) {
  const d = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry };
  let best = "left";
  for (const k of ["right", "top", "bottom"]) if (d[k] < d[best]) best = k;
  return d[best] < 0.25 ? best : "center";
}
