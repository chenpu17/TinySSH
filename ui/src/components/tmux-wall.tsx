// tmux 会话大屏（监控墙）：同主机全部 tmux 会话的快照网格——像监控多路
// 摄像头（2×2 / 3×3 / 4×4，单击小窗放大，Esc 退出/关屏）。与面板格子的分工：
// 格子=每格一条活 PTY 通道（attach 客户端、可交互、进愿望清单持久）；大屏=
// 每 300ms 一轮 capture-pane 快照（零客户端零 PTY，远端成本=每周期一条批量
// exec；capture-pane 是服务端内存读，亚秒节拍对远端无感——2s 的旧节拍被用户
// 判为硬伤。慢链路不叠发：在飞守卫让节拍自适应 RTT，拍未回则跳过）。
// 键入（互动操作）：**单击小窗即获键入焦点、就地编辑（不放大）**——输入走
// **tmux send-keys 服务端 API**（零客户端：小格不挂 attach 客户端就不拽会话
// 窗口尺寸，坑 84 教训的正解），可见字符 150ms 批量、特殊键冲字面即发；发送
// 与单格补拍同一命令一趟往返，反馈 ~200ms 不等节拍。放大=格子右上放大钮/双击
// （保留外框，框上还原钮，与面板格子同款语义）。Esc 先发给会话（vim 等全屏
// 程序可用）；点空白处退键入后 Esc 才逐级退出。「进格子」把会话交给既有面板链路（attach/改名跟随/
// 愿望清单全复用），大屏自身是临时视图：不入 vault，关掉即无痕。轮询纪律
// （监控大屏同族）：挂载才轮询、卸载即停、document.hidden 跳拍；会话清单/
// 抓取闭包走 ref，effect 只跑一次（3s 会话清单轮询换引用不打断节拍）。
// 渲染实现：快照是**纯文本+SGR**，用轻量 ANSI→HTML 直出（<pre> 内联 span），
// 刻意不用 xterm——就绪门/写处理器/维度测量/自愈重建这一整类活终端的坑与
// 「每 2s 整帧重写」的只读场景无关（真机排障轮全数踩过，见台账）。
// （历史：xterm 方案曾引入就绪门/Dimensions-getter 抛错/写处理器坏死/自愈
// 重建风暴四连坑，最终被本方案整体替换；教训见台账排障段。）
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type { TmuxSession, TmuxWallCell, TmuxWallFit, TmuxWallFitResult, TmuxWallRestoreItem, TmuxWallTarget } from "../adapter/wire";
import { IconMaximize, IconMinimize, IconX } from "../icons";

/** 格子键：id 在手按 id（改名不掉帧），退化按名。与面板「按 id 认、按名显示」
 * 同一口径。 */
const keyOf = (s: TmuxSession) => (s.id || s.name);

/** ANSI→HTML 结果按 cell 对象缓存（找茬四轮 B3）：tick 对文本未变的格子复用旧
 * cell 对象，此前的 ansiToHtml（逐字符 3 连 regex）却每渲染全格重算——8~16 格
 * 时每次渲染上万字符纯 JS 空转。按对象弱引用缓存，对象活着就只算一次。 */
const htmlCache = new WeakMap<TmuxWallCell, string>();
const cellHtml = (cell: TmuxWallCell | undefined): string => {
  if (!cell || !cell.ok || !cell.text) return "";
  let h = htmlCache.get(cell);
  if (h === undefined) {
    h = ansiToHtml(cell.text);
    htmlCache.set(cell, h);
  }
  return h;
};

/** 当前屏最宽行宽（列数，CJK 记 2）：格子「按宽适配缩放」的度量源，与渲染同
 * 源（剥 \r 与全部 CSI——渲染侧保留 SGR 是给 ansiToHtml 吃的，宽度上都是零）。
 * 只数**当前屏**（cell.rows，末尾 N 行；0=拿不到退全量）：横向铺满按用户眼前
 * 那一屏算——历史里的超宽行不该把整格字号拉小（历史裁切本就允许，当前屏才是
 * 监控语义）。同样按 cell 对象弱引用缓存。 */
const colsCache = new WeakMap<TmuxWallCell, number>();
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;
const cellCols = (cell: TmuxWallCell | undefined): number => {
  if (!cell || !cell.ok || !cell.text) return 0;
  const hit = colsCache.get(cell);
  if (hit !== undefined) return hit;
  const plain = cell.text.replace(/\r/g, "").replace(CSI_OTHER, "");
  const lines = plain.split("\n");
  const vp = cell.rows && cell.rows > 0 ? lines.slice(-cell.rows) : lines;
  let max = 0;
  for (const line of vp) {
    let w = 0;
    for (const ch of line) w += WIDE.test(ch) ? 2 : 1;
    if (w > max) max = w;
  }
  colsCache.set(cell, max);
  return max;
};

// ---- ANSI→HTML（快照子集）：SGR 颜色/样式 + 换行；其余转义或剥除 ----

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** xterm 256 色板（0-15 标准 / 16-231 6×6×6 立方 / 232-255 灰阶）。0-15 走应用
 * 的 --ansi-N 主题变量：与 xterm 终端同一套色板（16 族自动成立），且暗底 VGA
 * 硬编码在浅色面/eink 上白字直接隐形（审查轮 P1）。 */
const palette256 = (n: number): string => {
  if (n < 16) {
    return `var(--ansi-${n})`;
  }
  if (n < 232) {
    const v = n - 16;
    const step = (i: number) => (i === 0 ? 0 : 55 + i * 40);
    return `rgb(${step(Math.floor(v / 36))},${step(Math.floor((v % 36) / 6))},${step(v % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
};

interface SgrState {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  reverse: boolean;
}

const sgrCss = (s: SgrState): string => {
  let css = "";
  let fg = s.fg, bg = s.bg;
  if (s.reverse) { const t = fg; fg = bg; bg = t; }
  if (fg) css += `color:${fg};`;
  if (bg) css += `background:${bg};`;
  if (s.bold) css += "font-weight:700;";
  if (s.dim) css += "opacity:0.6;";
  if (s.italic) css += "font-style:italic;";
  if (s.underline && s.strike) css += "text-decoration:underline line-through;";
  else if (s.underline) css += "text-decoration:underline;";
  else if (s.strike) css += "text-decoration:line-through;";
  return css;
};

const CSI_OTHER = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** 快照（capture-pane -e 产物）→ HTML。仅处理 SGR；其余 CSI/ESC 序列剥除。 */
export const ansiToHtml = (text: string): string => {
  let out = "";
  const s: SgrState = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, reverse: false };
  let span = "";
  const flush = () => {
    if (!span) return;
    const css = sgrCss(s);
    out += css ? `<span style="${css}">${span}</span>` : span;
    span = "";
  };
  const plain = text.replace(/\r/g, "").replace(CSI_OTHER, (m) => (m.endsWith("m") ? m : ""));
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    if (ch === "\x1b" && plain[i + 1] === "[") {
      const end = plain.indexOf("m", i + 2);
      if (end > 0) {
        flush();
        const codes = plain.slice(i + 2, end).split(";").map((x) => parseInt(x || "0", 10));
        for (let j = 0; j < codes.length; j++) {
          const c = codes[j];
          if (c === 0) { s.fg = null; s.bg = null; s.bold = s.dim = s.italic = s.underline = s.strike = s.reverse = false; }
          else if (c === 1) s.bold = true;
          else if (c === 2) s.dim = true;
          else if (c === 3) s.italic = true;
          else if (c === 4) s.underline = true;
          else if (c === 7) s.reverse = true;
          else if (c === 9) s.strike = true;
          else if (c === 22) { s.bold = false; s.dim = false; }
          else if (c === 23) s.italic = false;
          else if (c === 24) s.underline = false;
          else if (c === 29) s.strike = false;
          else if (c === 39) s.fg = null;
          else if (c === 49) s.bg = null;
          else if (c >= 30 && c <= 37) s.fg = palette256(c - 30);
          else if (c >= 90 && c <= 97) s.fg = palette256(c - 90 + 8);
          else if (c >= 40 && c <= 47) s.bg = palette256(c - 40);
          else if (c >= 100 && c <= 107) s.bg = palette256(c - 100 + 8);
          else if (c === 38 || c === 48) {
            const isFg = c === 38;
            if (codes[j + 1] === 5) {
              const col = palette256(codes[j + 2] ?? 0);
              j += 2;
              if (isFg) s.fg = col; else s.bg = col;
            } else if (codes[j + 1] === 2) {
              const col = `rgb(${codes[j + 2] ?? 0},${codes[j + 3] ?? 0},${codes[j + 4] ?? 0})`;
              j += 4;
              if (isFg) s.fg = col; else s.bg = col;
            }
          }
        }
        i = end;
        continue;
      }
    }
    if (ch === "\n") { flush(); out += "\n"; continue; }
    span += escHtml(ch);
  }
  flush();
  return out;
};

export interface TmuxWallProps {
  hostName: string;
  sessions: TmuxSession[];
  /** 一拍快照：[请求时格键, 格子] 对——键按**请求发出时**的清单算好，响应回
   * 来清单变了也不错位（tick 只认键不按下标）。 */
  fetchCells: () => Promise<Array<[string, TmuxWallCell]>>;
  /** 键入送达（tmux send-keys 服务端 API）+ 立即补拍，返回该格新帧 */
  sendInput: (target: TmuxWallTarget, lit: string, keys: string[]) => Promise<TmuxWallCell>;
  /** 进格子：把该会话交给既有面板链路（attach 活通道），大屏由宿主收起 */
  onPromote: (name: string) => void;
  /** pane 贴格子：把 pane resize 成格子字符预算（守卫/钳位在核心；attach 客户
   *  端在场照样贴——主视图 attach+大屏同看是主场景）。返回每格原样回执（关墙
   *  恢复的留存源）；失败被 contain 缩放兜底吸收。contain 对宽高比失衡的格子
   *  只能 letterbox——宽屏 htop 缩块沉底（用户复验判「布局有问题没全屏」），
   *  让 pane 长成格子形状是唯一真解。 */
  fitPanes: (fits: TmuxWallFit[]) => Promise<TmuxWallFitResult[]>;
  /** 本墙的 SSH 会话 id：恢复寻址用。卸载 cleanup 拿到的是最后提交渲染闭包
   *  里的值（关墙置空发生在组件已不在树上的那次渲染），不受关墙竞态影响；
   *  迟到回执的兜底恢复同款钉死，绝不串到别的主机连接。 */
  sid: string;
  /** 关墙恢复：把贴格子借走的窗口几何与 window-size 选项原样交还（fire-and-
   *  forget，invoke 不依赖组件存活）。 */
  restorePanes: (sid: string, items: TmuxWallRestoreItem[]) => Promise<void>;
  onClose: () => void;
}

/** 键位翻译表（keydown.key → tmux 键名）：方向/编辑/翻页/F 键全覆盖；可见字
 * 符不走此表（进 150ms 字面批量）。 */
const TMUX_KEYS: Record<string, string> = {
  Enter: "Enter", Backspace: "BSpace", Escape: "Escape",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Delete: "Delete", Insert: "Insert",
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
  F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
};

/** keydown → tmux 特殊键名；null = 不属于特殊键（可见字符走字面通道）。⌘ 组合
 * 归应用（复制/粘贴/切换）不发；Ctrl+字母 编 C-x（有选区时 Ctrl+C 是复制语义
 * 不发）；Alt+可打印 编 M-x（readline 词跳转/tmux M-键）。**键名必须过核心
 * tmux_wall_key_ok 白名单**（C-Space/Escape 合法；C-[/C-@ 是终端语义的
 * ESC/NUL，映射过去；其余 Ctrl/Alt+标点白名单收不下——返回 null 不拦截，
 * 此前直拼 C-[ 之类被核心拒掉后静默吞键，审查轮 P2）。 */
const specialKeyOf = (ev: KeyboardEvent): string | null => {
  if (ev.metaKey) return null;
  if (ev.ctrlKey && !ev.altKey) {
    if (ev.key.length !== 1) return null;
    if (ev.key.toLowerCase() === "c" && window.getSelection()?.toString()) return null;
    const lo = ev.key.toLowerCase();
    if (/[a-z0-9]/.test(lo)) return `C-${lo}`;
    if (lo === " " || lo === "@") return "C-Space"; // Ctrl+@ = NUL，同 C-Space
    if (lo === "[") return "Escape"; // C-[ = ESC 的 tmux 键名
    return null;
  }
  if (ev.altKey && !ev.ctrlKey && ev.key.length === 1 && ev.key.trim()) {
    return `M-${ev.key.toLowerCase()}`;
  }
  if (ev.key === "Tab") return ev.shiftKey ? "BTab" : "Tab";
  if (ev.key.length === 1 && !ev.ctrlKey && !ev.altKey) return null;
  return TMUX_KEYS[ev.key] ?? null;
};

export const TmuxWall = memo(function TmuxWall({ hostName, sid, sessions, fetchCells, sendInput, onPromote, fitPanes, restorePanes, onClose }: TmuxWallProps) {
  const [frames, setFrames] = useState<Map<string, TmuxWallCell>>(new Map());
  const [solo, setSolo] = useState<string | null>(null);
  const [colsOverride, setColsOverride] = useState<number | null>(null);
  const [active, setActive] = useState<string | null>(null);
  // 键入送达失败的一次性提示（通道不稳/键名被拒——此前静默吞错，用户按了没反应）
  const [errFlash, setErrFlash] = useState<string | null>(null);
  // 整拍连续失败的画面停更提示（找茬四轮 B5）：单拍失败有「离线」遮罩、键入失败
  // 有 errFlash，唯独整拍级失败（断线/载荷作废）此前零反馈——照片墙停在最后一帧
  // 无任何「已停更」标记，用户对着死画面读日志。
  const [stale, setStale] = useState(false);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const soloRef = useRef(solo);
  soloRef.current = solo;
  const activeRef = useRef(active);
  activeRef.current = active;
  const fetchRef = useRef(fetchCells);
  fetchRef.current = fetchCells;
  const sendRef = useRef(sendInput);
  sendRef.current = sendInput;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const fitRef = useRef(fitPanes);
  fitRef.current = fitPanes;
  const restoreRef = useRef(restorePanes);
  restoreRef.current = restorePanes;
  const sidRef = useRef(sid);
  sidRef.current = sid;
  const wallRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const litRef = useRef(""); // 可见字符批量缓冲（150ms 一枪，Enter 等特殊键捎带冲刷）
  const flushTimerRef = useRef(0);
  const mountedRef = useRef(true);
  const errTimerRef = useRef(0);
  const inFlightRef = useRef(false); // 慢链路不叠拍（找茬四轮 A1 前端半）
  const failStreakRef = useRef(0);
  // pane 贴格子：pending 列表/签名（签名不变不重排防抖——300ms 节拍会不停
  // 重置计时器，永不到期）+ 已发清单（差量去重：resize 过的尺寸不再发，失败
  // 也不重试——beat 的 pane_height 就是反馈环，contain 兜底照常呈现）
  const fitTimerRef = useRef(0);
  const pendingFitsRef = useRef<TmuxWallFit[]>([]);
  const fitSigRef = useRef("");
  const sentFitsRef = useRef<Map<string, string>>(new Map());
  // 关墙恢复的留存源：每格「首次贴格子前」的原窗口尺寸+window-size 选项（后续
  // 再 fit 不覆盖——要还原的是用户走进大屏之前的那个布局）
  const origFitsRef = useRef<Map<string, TmuxWallRestoreItem>>(new Map());
  useEffect(() => {
    // StrictMode dev 双跑：模拟卸载的 cleanup 把标志打假后组件真重挂——setup
    // 必须拨回 true，否则此后所有 mountedRef 守卫在 dev 域恒假（sendNow 补拍
    // 换装被静默丢帧、pane 贴格子永不发射；节拍没挂守卫所以此前无人踩响）
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      window.clearTimeout(flushTimerRef.current);
      window.clearTimeout(errTimerRef.current);
      window.clearTimeout(fitTimerRef.current);
      // 关墙恢复：把贴格子借走的几何与 window-size 选项原样交还（fire-and-
      // forget，invoke 不依赖组件存活；空表=no-op——StrictMode dev 双跑时
      // 原样表还空，天然无害）。sid 用本实例最后渲染闭包里的值（见 props 注释）
      const items = [...origFitsRef.current.values()];
      if (items.length) void Promise.resolve(restoreRef.current(sidRef.current, items)).catch(() => {});
    };
  }, []);

  // 键入管线：单格 send-keys + 立即补拍（同一命令一趟往返），新帧原位换装。
  // 换格/失焦前冲刷挂起字面——挂载期才写 frames（卸载后回包丢弃）。
  // 串行链：每批键入是一条独立 exec，demo 域在进程内天然保序，真机域并发在飞
  // 的 send-keys 到达次序无保证——「ls」与「Enter」倒序=命令看似没跑（用户报的
  // 「有时候输入有问题」），链上逐发即保序；队头失败走 errFlash 不堵死链。
  const sendChainRef = useRef<Promise<void>>(Promise.resolve());
  const sendNow = useCallback((lit: string, keys: string[]) => {
    const key = activeRef.current;
    if (!key) return;
    const s = sessionsRef.current.find((x) => keyOf(x) === key);
    if (!s) return;
    // 目标在入队时刻钉死：链内闭包绝不读 activeRef——队列执行时键入焦点可能已
    // 换格，迟到的字面必须落进它被敲下时的那格
    const target: TmuxWallTarget = { id: s.id || "", name: s.name };
    sendChainRef.current = sendChainRef.current.then(async () => {
      try {
        const cell = await sendRef.current(target, lit, keys);
        if (!mountedRef.current) return;
        setFrames((prev) => {
          const next = new Map(prev);
          next.set(key, cell);
          return next;
        });
        // 主动补拍（「2s 刷新是硬伤」的键入半）：补拍帧只含回显，命令输出（ls
        // 的结果）在其后 ~百 ms 才产出——稍候一拍主动触发 tick 让输出尽快显形，
        // 不等节拍；在飞守卫防叠，慢链路这一发自动跳过等下一节拍
        window.setTimeout(() => {
          if (mountedRef.current) tickRef.current?.();
        }, 150);
      } catch (e) {
        // 通道失败/载荷作废：保留上一帧（照片墙语义），但键入必须给一句反馈——
        // 「按了没反应」比画面旧一拍更让用户困惑（审查轮 P2）。核心把「未送达」
        // 与「结果未知勿重发」分家后（找茬四轮 A2），优先透传后端文案。
        if (!mountedRef.current) return;
        const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
        setErrFlash(m || t("键入送达失败：通道不稳，画面保持上一拍"));
        window.clearTimeout(errTimerRef.current);
        errTimerRef.current = window.setTimeout(() => {
          if (mountedRef.current) setErrFlash(null);
        }, 3500);
      }
    });
  }, []);
  const flushLit = useCallback(() => {
    window.clearTimeout(flushTimerRef.current);
    flushTimerRef.current = 0;
    const lit = litRef.current;
    litRef.current = "";
    if (lit) void sendNow(lit, []);
  }, [sendNow]);
  const queueLit = useCallback((text: string) => {
    litRef.current += text;
    window.clearTimeout(flushTimerRef.current);
    flushTimerRef.current = window.setTimeout(() => flushLit(), 150);
  }, [flushLit]);
  // 特殊键即发（字面捎带同枪， shell 场景等价「打完词按回车」一条命令送达）
  const sendKeyNow = useCallback((key: string) => {
    window.clearTimeout(flushTimerRef.current);
    flushTimerRef.current = 0;
    const lit = litRef.current;
    litRef.current = "";
    void sendNow(lit, [key]);
  }, [sendNow]);
  const activate = useCallback((key: string) => {
    flushLit();
    setActive(key);
  }, [flushLit]);
  const deactivate = useCallback(() => {
    flushLit();
    setActive(null);
  }, [flushLit]);
  // 键入焦点自愈：格内点选文本（mousedown 默认行为）会夺走隐藏输入框焦点——
  // 选区为空即抢回（键入态不静默丢失）；有选区=复制手势，不抢（Ctrl+C 走复制）。
  // 墙外焦点不再抢回（找茬四轮 B1，P1）：此前的无差别 0ms 抢焦点会把用户正在
  // 设置面板/⌘K 等外部输入面里敲的每个字符静默送进远端 tmux 会话——activeElement
  // 已落到墙外的真实输入框时跳过，键入态由下面的 focusin 收掉。
  const refocusSoon = useCallback(() => {
    window.setTimeout(() => {
      if (!mountedRef.current || !activeRef.current) return;
      if (window.getSelection()?.toString()) return;
      const ae = document.activeElement;
      if (
        ae &&
        ae !== document.body &&
        wallRef.current &&
        !wallRef.current.contains(ae)
      ) return;
      inputRef.current?.focus();
    }, 0);
  }, []);

  // 键入态的边界（找茬四轮 B1）：焦点/点按落到墙外即退键入态（挂起字面先冲刷
  // ——退场不丢字）。focusin 捕获键盘 Tab 出墙与点外部可聚焦元素；pointerdown
  // 捕获点外部不可聚焦区域（二者互补，缺一即漏）。设置面板刻意设计成大屏开着
  // 也可用（pop-mask 在 .main 之外），正是此前误发链的入口。
  useEffect(() => {
    if (!active) return;
    const outside = (x: EventTarget | null): boolean => {
      const w = wallRef.current;
      return !!w && x instanceof Node && !w.contains(x);
    };
    const onDocDown = (e: PointerEvent) => {
      if (outside(e.target)) deactivate();
    };
    const onFocusIn = (e: FocusEvent) => {
      if (outside(e.target)) deactivate();
    };
    document.addEventListener("pointerdown", onDocDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("pointerdown", onDocDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, [active, deactivate]);

  // 轮询：挂载即拍 + 300ms 节拍；document.hidden 跳拍；卸载即停。本拍失败保留
  // 上一帧（照片墙容忍单拍失败，不闪空白）；换清单/改名只影响下一拍。
  // fetchCells 返回**请求时 targets 配好键**的 [key, cell] 对——此前按响应时刻
  // 的 sessionsRef 下标配对，await 窗口内清单变化会单拍错位（审查轮 P2/P3）。
  // 在飞守卫（找茬四轮 A1 前端半）：上一拍未回本拍直接跳过——亚秒节拍下这同时
  // 是 RTT 自适应：链路慢时自然降频为「回一拍拍一拍」，绝不叠出并发 exec 通道
  // 挤 MaxSessions、重叠回包乱序旧帧覆新帧。连续 10 拍失败置「画面停更」提示
  // （B5；10×300ms=3s，与旧 3×2s 同为「数秒级无数据才提示」，太短会闪误报）。
  // tick 同时挂进 tickRef：键入送达后的主动补拍入口（见 sendNow）。
  const tickRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    let dead = false;
    const tick = async () => {
      if (document.hidden) return;
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const pairs = await fetchRef.current();
        if (dead) return;
        failStreakRef.current = 0;
        if (stale) setStale(false);
        setFrames((prev) => {
          const next = new Map<string, TmuxWallCell>();
          for (const [key, c] of pairs ?? []) {
            if (!key || !c) continue;
            const old = prev.get(key);
            // 文本未变复用旧对象（跳过无关重渲染）
            next.set(key, old && old.text === c.text && old.ok === c.ok ? old : c);
          }
          // 内容全等复用旧 Map（App 每 3s 重渲染不该连带墙重算——B3）
          if (next.size === prev.size) {
            let same = true;
            for (const [k, v] of next) {
              if (prev.get(k) !== v) { same = false; break; }
            }
            if (same) return prev;
          }
          return next;
        });
      } catch {
        // 通道失败/载荷作废：保留上一帧；连败 10 拍（3s）起提示「已停更」
        if (!dead) {
          failStreakRef.current += 1;
          if (failStreakRef.current >= 10 && !stale) setStale(true);
        }
      } finally {
        inFlightRef.current = false;
      }
    };
    tickRef.current = tick;
    void tick();
    const iv = window.setInterval(() => void tick(), 300);
    return () => { dead = true; window.clearInterval(iv); tickRef.current = null; };
  }, [stale]);

  // Esc：键入焦点在格子 → 不拦（输入框 keydown 会把 Escape 发给会话并就地
  // stopPropagation）；无键入焦点时 capture 先于应用 Esc 链——放大中退放大，
  // 再关屏。外部输入面（作曲行等）持有焦点时放行（找茬四轮 B7）：此前本捕获
  // 先于 target 相位把 Esc 吞掉，「Esc 取消作曲」变成「关屏、作曲行还开着」。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (activeRef.current) return;
      const ae = document.activeElement as HTMLElement | null;
      if (
        ae &&
        ae !== document.body &&
        (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA") &&
        wallRef.current &&
        !wallRef.current.contains(ae)
      ) return;
      e.preventDefault();
      e.stopPropagation();
      if (soloRef.current) setSolo(null);
      else closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const autoCols = sessions.length <= 4 ? 2 : sessions.length <= 9 ? 3 : 4;
  const cols = colsOverride ?? autoCols;
  // solo 键必须仍在清单里——会话被关掉/改名换 id 后不退回网格会让全格 display:none（白屏）
  const soloKey = solo && sessions.some((s) => keyOf(s) === solo) ? solo : null;
  const soloName = soloKey ? sessions.find((s) => keyOf(s) === soloKey)?.name ?? "" : "";

  // 按格适配 v2（用户反馈「分辨率布局还是没有自适应好」）：v1 只按宽缩放且网格
  // 封顶 1——大格子（2×2/solo）scale=1 时 64 行快照超出格子高度，当前屏底部
  // 仍被裁；不放大=右侧留白，观感就是「没自适应」。v2 宽高**双约束**：
  //   scale = min(格宽预算/当前屏自然宽, 格高预算/当前屏行数×行高, cap)
  // 当前屏（rows=协议透传的 #{pane_height}）永远完整可见（硬约束），历史裁切
  // 优先级最低（底部锚定裁顶部）；横向按当前屏最宽行铺满格子，cap 2.5 只防极
  // 端窄快照荒诞放大。邻格字号一致让位于「铺满」——监控墙每格终端宽度本就各
  // 异，独立缩放才是每格都看得清。
  const charWRef = useRef(0);
  const lineHRef = useRef(0);
  // pane 贴格子发射：布局稳定 400ms 后对差量格子发一次 fit。contain 缩放对
  // 宽高比失衡的格子只能 letterbox（宽屏 htop 缩块沉底=用户复验的「没全屏」），
  // 唯一真解是让 pane 长成格子形状——resize-window 后 TUI 收 SIGWINCH 重绘满格，
  // contain 度量自然收敛到 scale≈1。字符预算按 contain 同款预算反推，floor
  // 保证 resize 后的 pane 必然装进格子（scale≈1 不溢出）。
  const fireFit = useCallback(() => {
    const toSend = pendingFitsRef.current.filter(
      (f) => sentFitsRef.current.get(f.id || f.name) !== `${f.cols}x${f.rows}`,
    );
    if (!toSend.length) return;
    void Promise.resolve(fitRef.current(toSend))
      .then((results) => {
        // 成功才记账（「当前已发尺寸」语义）；失败走 catch 回滚签名重试
        for (const f of toSend) sentFitsRef.current.set(f.id || f.name, `${f.cols}x${f.rows}`);
        for (const r of results ?? []) {
          if (!r?.name || r.orig_w <= 0 || r.orig_h <= 0) continue;
          // 首次留存=干预前的原样；后续再 fit 不覆盖（第二回执的 orig 是上一
          // 次贴格后的中间尺寸，拿去恢复=布局永久变形——迟到兜底也从留存取）
          if (!origFitsRef.current.has(r.name)) {
            origFitsRef.current.set(r.name, { id: r.id || "", name: r.name, cols: r.orig_w, rows: r.orig_h, ws: r.orig_ws });
          }
        }
        // 慢链路竞态：回包时墙已卸载 → cleanup 已带着当时的留存跑了恢复，这些
        // 迟到的回执再走一发兜底恢复——尺寸从**留存**取（不是回执 orig：那是
        // 中间态），sid 钉本实例（restoreRef 现取，空表=no-op）
        if (!mountedRef.current) {
          const late = (results ?? [])
            .filter((r) => r?.name && origFitsRef.current.has(r.name))
            .map((r) => origFitsRef.current.get(r.name)!)
            .filter((it) => it.cols > 0 && it.rows > 0);
          if (late.length) void Promise.resolve(restoreRef.current(sidRef.current, late)).catch(() => {});
        }
      })
      .catch(() => {
        // 失败不记账不放弃：回滚签名让下一拍 applyFit 自然重试（通道抖动恢复
        // 后自动贴上；持续失败=链路断，墙整体 stale，400ms 防抖挡着不成风暴）
        fitSigRef.current = "";
      });
  }, []);
  const scheduleFit = useCallback(() => {
    window.clearTimeout(fitTimerRef.current);
    fitTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) fireFit();
    }, 400);
  }, [fireFit]);
  const applyFit = useCallback(() => {
    const wall = wallRef.current;
    if (!wall) return;
    const pres = wall.querySelectorAll<HTMLElement>(".tw-pre");
    if (!pres.length) return;
    if (!charWRef.current) {
      // 实测等宽字宽/行高（--mono 跟主题走，首格 computed style 探针，量一次）
      const probe = document.createElement("span");
      const cs = getComputedStyle(pres[0]);
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;";
      probe.style.fontFamily = cs.fontFamily;
      probe.style.fontSize = cs.fontSize;
      probe.style.fontWeight = cs.fontWeight;
      probe.textContent = "M".repeat(50);
      document.body.appendChild(probe);
      charWRef.current = probe.getBoundingClientRect().width / 50 || 0;
      probe.remove();
      const fs = parseFloat(cs.fontSize) || 0;
      lineHRef.current = parseFloat(cs.lineHeight) || fs * 1.25; // CSS 钉 1.25
    }
    const cw = charWRef.current;
    const lh = lineHRef.current;
    if (!cw || !lh) return;
    const fits: TmuxWallFit[] = [];
    for (const pre of pres) {
      const shot = pre.parentElement;
      if (!shot) continue;
      const colsN = Number(pre.dataset.cols ?? 0);
      const rowsN = Number(pre.dataset.rows ?? 0);
      const budget = shot.clientWidth - 20; // 快照 padding 6px 8px + 边距余量
      const vbudget = shot.clientHeight - 16; // padding 6px×2 + 行余量
      if (!colsN || budget <= 0) { pre.style.transform = ""; continue; }
      const wScale = budget / (colsN * cw + 16);
      const hScale = rowsN > 0 && vbudget > 0 ? vbudget / (rowsN * lh) : Infinity;
      const s = Math.max(0.25, Math.min(2.5, wScale, hScale));
      pre.style.transform = Math.abs(s - 1) < 0.001 ? "" : `scale(${s.toFixed(3)})`;
      // pane 贴格子：只对拿到过快照的格子（cols>0=拍活着；rows=0 是极老 tmux
      // 的 display-message 缺口，resize-window 大概率同样不可用）且格子有像
      // 素预算（solo 隐藏格 clientWidth=0 跳过）时发
      if (rowsN > 0 && budget > 40 && vbudget > 40) {
        const ent = sessionsRef.current.find((x) => x.name === shot.dataset.name);
        if (ent) {
          fits.push({
            id: ent.id || "",
            name: ent.name,
            cols: Math.max(12, Math.min(400, Math.floor((budget - 16) / cw))),
            rows: Math.max(5, Math.min(200, Math.floor((vbudget - 12) / lh))),
          });
        }
      }
    }
    // 签名不变不重排——300ms 节拍每拍都跑 applyFit，无脑重排防抖会让计时器
    // 永远被重置、fit 永不发射
    const sig = fits.map((f) => `${f.name}:${f.cols}x${f.rows}`).join("|");
    if (sig !== fitSigRef.current) {
      fitSigRef.current = sig;
      pendingFitsRef.current = fits;
      scheduleFit();
    }
  }, [scheduleFit]);
  // 布局期写 transform（paint 前）：useEffect 时机在绘制后，会先闪一帧未缩放
  // 内容再缩——每拍快照都闪。frame 换装/规格/放大切换都可能改变度量，全部重算。
  useLayoutEffect(() => { applyFit(); }, [applyFit, frames, sessions, soloKey, cols, stale]);
  // 窗口/格子尺寸变化（拖窗、分屏、头部换行）重算：观察 body 一处即可覆盖全部
  // 格子几何；resize 监听兜底（RO 不可用环境）。
  useEffect(() => {
    const body = wallRef.current?.querySelector(".tw-body") ?? null;
    if (!body) return;
    const ro = new ResizeObserver(() => applyFit());
    ro.observe(body);
    window.addEventListener("resize", applyFit);
    return () => { ro.disconnect(); window.removeEventListener("resize", applyFit); };
  }, [applyFit]);

  return (
    <section
      ref={wallRef}
      className={"tmux-wall" + (soloKey ? " solo" : "")}
      data-testid="tmux-wall"
      role="region"
      aria-label={t("tmux 会话大屏")}
    >
      <header
        className="tw-head"
        onClick={(e) => {
          // 头部空白点击退键入（按钮除外）——放大态没有「空白 body」，这是
          // 键入态的主要退口：退掉后 Esc 才逐级退出（放大→关屏）
          if (!(e.target as HTMLElement).closest?.("button")) deactivate();
        }}
      >
        <span className="tw-title">{t("tmux 会话大屏")}</span>
        <span className="tw-sub">{hostName} · {sessions.length}</span>
        <span className="tw-hint">{t("单击小窗键入 · 点「完成」或空白处退出键入 · 双击放大；深度操作「进格子」")}</span>
        {stale && (
          <span className="tw-err" role="alert" data-testid="tmux-wall-stale">
            {t("画面已停更：通道不稳，正在重试")}
          </span>
        )}
        {errFlash && <span className="tw-err" role="alert">{errFlash}</span>}
        <span className="tw-flex" />
        {!soloKey && (
          <span className="tw-sizes" role="group" aria-label={t("网格规格")}>
            {[2, 3, 4].map((n) => (
              <button
                key={n}
                className={"ghost tw-gsz" + (cols === n ? " ts-open" : "")}
                data-testid={"tmux-wall-size-" + n}
                aria-pressed={cols === n}
                title={t("{0}×{1} 网格", String(n), String(n))}
                onClick={() => setColsOverride(n)}
              >{n}×{n}</button>
            ))}
          </span>
        )}
        {soloKey && (
          <button className="ghost" data-testid="tmux-wall-unsolo" onClick={() => setSolo(null)}>
            {t("退出放大")}
          </button>
        )}
        <button
          className="ghost icon-btn"
          data-testid="tmux-wall-close"
          title={t("关闭会话大屏")}
          aria-label={t("关闭会话大屏")}
          onClick={onClose}
        ><IconX size={14} /></button>
      </header>
      <div
        className="tw-body"
        style={{ gridTemplateColumns: soloKey ? "minmax(0, 1fr)" : `repeat(${cols}, minmax(0, 1fr))` }}
        onClick={(e) => { if (!(e.target as HTMLElement).closest?.(".tw-cell")) deactivate(); }}
      >
        {sessions.length === 0 && (
          <div className="tw-empty">{t("远端暂无 tmux 会话")}</div>
        )}
        {sessions.map((s) => {
          const key = keyOf(s);
          const cell = frames.get(key);
          const isSolo = soloKey === key;
          const isActive = active === key;
          const html = cellHtml(cell);
          return (
            <div
              key={key}
              className={"tw-cell" + (isSolo ? " tw-solo" : "") + (isActive ? " tw-active" : "")}
              data-testid={"tmux-wall-cell-" + s.name}
            >
              <div className="tw-cell-head" onClick={() => { if (!isActive) activate(key); }}>
                <span className="tw-name" title={s.name}>{s.name}</span>
                <span className="tw-flex" />
                {/* 键入态的可见退出件（找茬四轮 D5）：solo 态 body 被格子铺满、
                    无空白可点，「点头部空白退键入」无从谈起——给键入中的格子一枚
                    「完成」钮，纯键盘/放大态也有明确退口 */}
                {isActive && (
                  <button
                    className="ghost tw-done"
                    data-testid={"tmux-wall-done-" + s.name}
                    title={t("退出键入（回到浏览）")}
                    onClick={(e) => { e.stopPropagation(); deactivate(); }}
                  >{t("完成")}</button>
                )}
                {/* 放大/还原（与面板格子同款语义）：放大保留外框——标题栏常显，
                    还原钮就在框上；单击小窗正文=就地键入（不放大），放大只走这颗钮/双击 */}
                <button
                  className="ghost icon-btn tw-max"
                  data-testid={"tmux-wall-max-" + s.name}
                  title={isSolo ? t("还原（回到网格）") : t("放大（保留外框）")}
                  aria-label={isSolo ? t("还原（回到网格）") : t("放大（保留外框）")}
                  onClick={(e) => { e.stopPropagation(); setSolo(isSolo ? null : key); activate(key); }}
                >{isSolo ? <IconMinimize size={12} /> : <IconMaximize size={12} />}</button>
                <button
                  className="ghost tw-promote"
                  data-testid={"tmux-wall-promote-" + s.name}
                  title={t("进格子：并入本标签的面板（attach 活通道，可交互）")}
                  onClick={(e) => { e.stopPropagation(); onPromote(s.name); }}
                >{t("进格子")}</button>
              </div>
              <div
                className="tw-shot"
                data-name={s.name}
                title={isSolo
                  ? t("键入直达会话 · 选中文本可复制；双击或右上还原钮回网格")
                  : t("单击键入 · 双击放大；选中文本可复制")}
                onClick={() => {
                  // 选区非空 = 复制手势：不夺焦点（Ctrl+C 走浏览器复制）；
                  // 单击=就地键入（小窗直接编辑，不放大）——用户拍板的交互模型
                  if (window.getSelection()?.toString()) return;
                  activate(key);
                }}
                onDoubleClick={(e) => {
                  // 双击=放大/还原（正文里双击选词与放大的手势冲突可接受：
                  // 放大钮是主路径，双击是快捷方式）
                  e.preventDefault();
                  setSolo(isSolo ? null : key);
                  activate(key);
                }}
              >
                <pre
                  className="tw-pre"
                  data-cols={cellCols(cell)}
                  data-rows={cell && cell.ok ? cell.rows ?? 0 : 0}
                  dangerouslySetInnerHTML={{ __html: html }}
                />
                {cell && !cell.ok && <div className="tw-off">{t("离线")}</div>}
                {isActive && (
                  <input
                    ref={inputRef}
                    className="tw-input"
                    data-testid={"tmux-wall-input-" + s.name}
                    autoFocus
                    aria-label={t("键入送达 {0}", s.name)}
                    onKeyDown={(e) => {
                      // IME 组合期交给 compositionend；keyCode 229=Safari/
                      // WKWebView（macOS Tauri）compositionend 后补发的 Enter
                      // 提交键（isComposing 已 false）——放行会给远端多发一枚
                      // Enter（主视图捕获层同款解码，见 App 键盘捕获段）
                      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                      const sp = specialKeyOf(e.nativeEvent);
                      if (sp !== null) {
                        e.preventDefault();
                        e.stopPropagation();
                        sendKeyNow(sp);
                        return;
                      }
                      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                        e.preventDefault();
                        queueLit(e.key);
                      }
                    }}
                    onCompositionEnd={(e) => { litRef.current += e.data; flushLit(); }}
                    onPaste={(e) => {
                      e.preventDefault();
                      const txt = e.clipboardData.getData("text");
                      if (txt) { litRef.current += txt; flushLit(); }
                    }}
                    onBlur={() => refocusSoon()}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      {soloName && (
        <div className="tw-solo-tag" aria-hidden="true">{t("放大：{0}", soloName)}</div>
      )}
    </section>
  );
});
