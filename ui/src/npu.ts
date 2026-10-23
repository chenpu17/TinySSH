// Ascend NPU 采样解析（监控面板轮；大屏轮后真机校准）：npu-smi info 默认表格 →
// 每芯片一行指标。纯函数导出（spec 可直接断言）。各 CANN 版本表格列有差异，按
// 「结构」解析而非按列位：设备区每颗 NPU 两行，识别指纹 = **尾格数字形状**——
//   首行尾格 = `功耗 温度 大页U / 大页T`；次行尾格 = `利用率 内存U/T HBMU/T`。
// 已知两形态（都覆盖）：
//   旧（≤24.x，如 910B2C）：3 格——`| 序号 型号 | 健康 | 尾格 |`，
//     次行首格 = 芯片号（部分版本带 Device 成两数字）+ 总线格。
//   新（25.1+，如 Ascend950DT）：4 格——`| 序号 | 型号 | 健康 | 尾格 |`，
//     次行前两格为空、Bus-Id 在第三格（常见 NA）。
// 统一规则：尾格按形状匹配（两正则互斥）；身份格（尾格与健康格之前的格子）
// 拼接取词——首词纯数字=序号、次词=型号；次行身份格必须全空或纯数字、总线格任取。
// 底部进程区（尾格是单数字或 NA）两指纹都不匹配，天然排除。used/total 对按序
// 解释为 [DDR, HBM]（310 系只有 DDR 一对；910B/950 常 0/0 + HBM）。三态出口：
// no-tool（无 npu-smi，大屏隐藏 NPU 区）/ no-table（有工具但零解析——「表头未
// 识别」，真机校准的抓手，不静默吞）/ ok。

export interface NpuChip {
  index: number;
  name: string;            // 如 910B2C / 310P3 / Ascend950DT
  health: string;          // OK / Warning / Alarm / Critical / UNKNOWN（原样透出）
  powerW: number;
  tempC: number;
  aicorePct: number;
  memUsedMB: number;       // DDR 用量（910B/950 常 0）
  memTotalMB: number | null;
  hbmUsedMB: number | null;
  hbmTotalMB: number | null;
}

export interface NpuParsed {
  state: "no-tool" | "no-table" | "ok";
  chips: NpuChip[];
  detail?: string;         // no-table 时携带原文片段，供 tooltip 排查/真机校准
}

// 首行尾格：功耗(可小数) 温度(可为负) 大页对——大页对忽略。
const ROW1_TAIL = /^([\d.]+)\s+(-?\d+)\s+(\d+)\s*\/\s*(\d+)$/;
// 次行尾格：利用率 + 两组 used/total（按序 [DDR, HBM]）。
const ROW2_TAIL = /^(\d+)\s+(\d+)\s*\/\s*(\d+)\s+(\d+)\s*\/\s*(\d+)$/;
// 次行身份格：全空或纯数字（旧版芯片/设备号可以一格多词）。
const ID_CELL = /^(?:\d+(?:\s+\d+)?)?$/;

/** 切 `|` 单元格；非表格行（分隔线/空行/版本横幅）返回 null。 */
const cells = (line: string): string[] | null => {
  if (!line.startsWith("|") || !line.endsWith("|") || line.length < 2) return null;
  return line.slice(1, -1).split("|").map((c) => c.trim());
};

/** 解析 probe_npu_metrics 的原文输出（含 ==NPU== / NO_NPU 标记）。 */
export function parseNpuInfo(text: string): NpuParsed {
  const trimmed = text.trim();
  if (!trimmed.includes("==NPU==")) {
    return { state: "no-tool", chips: [] };
  }
  const body = trimmed.split("==NPU==")[1] ?? "";
  const lines = body.split("\n").map((l) => l.replace(/\s+$/, ""));
  const chips: NpuChip[] = [];
  // 一颗 NPU = 首行(开) + 次行(合)。次行先到（乱序/残缺）或身份格不合形直接丢弃
  // pending，宁缺勿造。
  let pending: Pick<NpuChip, "index" | "name" | "health" | "powerW" | "tempC"> | null = null;
  for (const line of lines) {
    const cs = cells(line);
    if (!cs || cs.length < 3) continue;
    const data = cs[cs.length - 1];
    const head = cs.slice(0, -1);
    const m1 = data.match(ROW1_TAIL);
    if (m1) {
      // 身份格 = 尾格之外再去掉健康格（健康格恒在尾格前一位）
      const idCells = head.slice(0, -1);
      const health = head[head.length - 1] || "UNKNOWN";
      const tokens = idCells.join(" ").split(/\s+/).filter(Boolean);
      const idx = tokens[0] != null && /^\d+$/.test(tokens[0]) ? Number(tokens[0]) : NaN;
      const name = tokens[1];
      pending = Number.isFinite(idx) && name
        ? { index: idx, name, health, powerW: Number(m1[1]), tempC: Number(m1[2]) }
        : null;
      continue;
    }
    const m2 = data.match(ROW2_TAIL);
    if (m2 && pending) {
      const idCells = head.slice(0, -1); // 去掉总线格
      if (!idCells.every((c) => ID_CELL.test(c))) { pending = null; continue; }
      const mem = { u: Number(m2[2]), t: Number(m2[3]) };
      const hbm = { u: Number(m2[4]), t: Number(m2[5]) };
      chips.push({
        ...pending,
        aicorePct: Math.min(100, Math.max(0, Number(m2[1]))),
        memUsedMB: mem.u,
        memTotalMB: mem.t,
        hbmUsedMB: hbm.u,
        hbmTotalMB: hbm.t,
      });
      pending = null;
    }
  }
  if (chips.length === 0) {
    return { state: "no-table", chips: [], detail: body.trim().slice(0, 400) };
  }
  return { state: "ok", chips };
}
