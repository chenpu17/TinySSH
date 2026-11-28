// 标签活跃度：标签条状态点的两种衍生视觉（样式见 styles.css 的 .tab-ping / .tab-idle）。
//  · 正在输出——后端输出帧到达后的 LIVE_HOLD_MS 内，状态点向外扩散一圈同色光环；连续
//    输出每 BEAT_MS 一圈，零星输出（相邻两行间隔超过 LIVE_HOLD_MS）来一行只出一圈。
//  · 久未输出——已连接、且 IDLE_AFTER_MS 内既没有输出也没有被切到过的**后台**会话：实心点
//    变空心环，非活动标签的文字退一档，提示里报「N 分钟无输出」。活动标签不判闲置。
//
// 真源是输出帧本身：createOutputThrottle / createOutputFeed 的 onOutput 在字节到达时记账
// （后台标签被合批降频时照样记；检查点重放与前端直写的提示语不过节流器，不算）。
// 屏幕上看得到的终端（活动标签及其分屏伙伴）里，本地输入之后 ECHO_MS 以内到达的帧不记：
// 那是刚敲的键的回显，就在眼前，不该让正在打字的标签自己一圈圈闪。按「离上一次本地输入
// 多久」判，不按帧的长短——PowerShell / zsh / fish 每敲一键都会重绘整行输入（带配色往往
// 几十字节），粘贴一条长命令的回显更长，帧长分不出回显与输出；本地的每种输入（键盘、
// 粘贴、广播扇出、控制字符接管）都经 keyed 报到，规则只有一条。后台标签一律记——那里
// 「有动静」本身就是信息（单字符转圈的进度也算）。
// 「看过」也算活动：切到某标签即记一笔，活动标签不判闲置。
//
// 光环用 WAAPI 一拍一拍地放，而不是挂 class 跑 infinite 动画：
//  · 动画有限、自然收尾——输出停下时光环不会在半圈上被掐断；
//  · 每拍只碰状态点里那一个节点，不为节拍整树重渲染（标签结构仍全归 React）。
// 标签上只留一个命令式属性 data-live（减弱动效时的静态高亮 + 测试读数）。

export const LIVE_HOLD_MS = 1300;
export const BEAT_MS = 1600;
const RING_MS = 1500;
/** 看得到的终端里，本地输入之后这么久以内到达的帧按回显处理、不记账。取值要盖住高延迟
 *  链路上一次按键的往返（键 → PTY → 回显回来）；代价是回车后这么久之内就跑完的短命令
 *  在活动标签上不出圈——输出本来就在眼前，持续更久的输出照常出圈。 */
export const ECHO_MS = 600;
export const TICK_MS = 250;
export const IDLE_AFTER_MS = 30 * 60_000;
export const IDLE_CHECK_MS = 15_000;

/** 标签条目（App.tsx 的 TabEntry 的结构子集：只读 key 与成员 id）。 */
export type ActivityTabEntry =
  | { key: string; kind: "session"; session: { id: string } }
  | { key: string; kind: "group"; members: { id: string }[] };

export interface ActivityTickInput {
  now: number;
  entries: readonly ActivityTabEntry[];
  sessions: readonly { id: string; state: string }[];
  /** 活动会话：不判闲置（闲置 = 后台没人看；活动标签的画面就在眼前）。 */
  activeSid: string | null;
  bar: HTMLElement | null;
}

const reduceMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const tabOf = (bar: HTMLElement | null, key: string): HTMLElement | null =>
  bar?.querySelector<HTMLElement>(`.tab[data-key="${key.replace(/["\\]/g, "\\$&")}"]`) ?? null;

/** 放一圈光环：与状态点同色的细环从点本身扩散到约 2.5 倍，边扩边淡。 */
const ring = (tab: HTMLElement | null): void => {
  const el = tab?.querySelector<HTMLElement>(".tab-ping");
  if (!el || reduceMotion() || typeof el.animate !== "function") return;
  for (const a of typeof el.getAnimations === "function" ? el.getAnimations() : []) a.cancel();
  el.animate(
    [
      { transform: "scale(1)", opacity: 0.7 },
      { transform: "scale(1.9)", opacity: 0.42, offset: 0.5 },
      { transform: "scale(2.5)", opacity: 0 },
    ],
    { duration: RING_MS, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" },
  );
};

const sameRecord = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
};

export interface TabActivity {
  /** 本地输入正发往这个会话的 PTY（键盘、粘贴、广播扇出、控制字符接管）：随后的回显
   *  不算输出（见文件头）。只影响此刻看得到的终端。 */
  keyed: (sid: string) => void;
  /** 输出帧到达；visible 表示这个终端此刻在屏幕上（见文件头）。 */
  note: (sid: string, visible: boolean) => void;
  /** 用户看到了这个会话（切到 / 切走标签）：闲置即刻解除。 */
  touch: (sid: string) => void;
  /** 节拍：由 App 的定时器每 TICK_MS 调一次。 */
  tick: (i: ActivityTickInput) => void;
}

export function createTabActivity(opts: {
  onIdle: (next: Record<string, number>) => void;
  /** 会话菜单行的「正在输出」静态辉光（KI-144）：只在活跃集合的边沿（输出起/停）回调，
   *  不逐拍进 React。标签条仍是命令式属性；这里服务的是没有标签条的移动端切换菜单。 */
  onLive?: (sids: string[]) => void;
}): TabActivity {
  const lastOut = new Map<string, number>(); // sid → 最近一次输出的时刻（Date.now 口径）
  const lastKey = new Map<string, number>(); // sid → 最近一次本地输入的时刻（回显窗口的起点）
  const seen = new Map<string, number>();    // sid → 最近一次被看到 / 建连的时刻
  const nextBeat = new Map<string, number>(); // 标签 key → 下一拍最早时刻
  const liveKeys = new Set<string>();
  const beats: Record<string, number> = {};  // 标签 key → 已放的光环圈数（测试读数）
  let idleNow: Record<string, number> = {};  // sid → 闲置分钟数
  let lastIdleCheck = 0;
  let liveSidsNow = new Set<string>();       // 最近 LIVE_HOLD_MS 内有输出的会话（菜单行静态辉光用）
  let lastInput: ActivityTickInput = { now: 0, entries: [], sessions: [], activeSid: null, bar: null };

  const commitIdle = (next: Record<string, number>) => {
    idleNow = next;
    opts.onIdle(next);
  };

  // 闲置表低频重算：一分钟才换一次读数（title 里的分钟数），没必要每拍算
  const recomputeIdle = (i: ActivityTickInput, force = false) => {
    if (!force && i.now - lastIdleCheck < IDLE_CHECK_MS) return;
    lastIdleCheck = i.now;
    const next: Record<string, number> = {};
    const alive = new Set<string>();
    for (const s of i.sessions) {
      alive.add(s.id);
      // 首次见到的会话：把「建连」当作一次活动，否则首屏输出还没到就先判闲置
      if (!seen.has(s.id)) seen.set(s.id, i.now);
      if (s.state !== "Connected" || s.id === i.activeSid) continue;
      const age = i.now - Math.max(lastOut.get(s.id) ?? 0, seen.get(s.id) ?? i.now);
      if (age >= IDLE_AFTER_MS) next[s.id] = Math.floor(age / 60_000);
    }
    for (const id of lastOut.keys()) if (!alive.has(id)) lastOut.delete(id);
    for (const id of lastKey.keys()) if (!alive.has(id)) lastKey.delete(id);
    for (const id of seen.keys()) if (!alive.has(id)) seen.delete(id);
    if (!sameRecord(idleNow, next)) commitIdle(next);
  };

  const wake = (sid: string) => {
    if (!(sid in idleNow)) return;
    const next = { ...idleNow };
    delete next[sid];
    commitIdle(next);
  };

  // dev 门控探针钩子（spec 专用；release 构建里 DEV 为 false，整段被摇掉）。等到第一次
  // tick 才装：StrictMode dev 下 useState 的初始化器会跑两遍、留一个没人用的孤儿实例，
  // 构造即装的话 window.__t_activity 可能指向孤儿（读数恒为空）。
  let devHook: (() => void) | null = import.meta.env.DEV
    ? () => {
      (window as unknown as { __t_activity?: unknown }).__t_activity = {
        stats: () => ({
          lastOut: Object.fromEntries(lastOut),
          lastKey: Object.fromEntries(lastKey),
          seen: Object.fromEntries(seen),
          beats: { ...beats },
          live: [...liveKeys],
          liveSids: [...liveSidsNow],
          idle: { ...idleNow },
        }),
        /** 把某会话的最近活动往回拨 ms 毫秒并立即重算闲置表（验证「久未输出」不必真等）。 */
        age: (sid: string, ms: number) => {
          for (const m of [lastOut, seen]) {
            const t = m.get(sid);
            if (t !== undefined) m.set(sid, t - ms);
          }
          recomputeIdle({ ...lastInput, now: Date.now() }, true);
        },
      };
    }
    : null;

  const api: TabActivity = {
    keyed: (sid) => {
      lastKey.set(sid, Date.now());
    },
    note: (sid, visible) => {
      if (visible && Date.now() - (lastKey.get(sid) ?? 0) < ECHO_MS) return;
      lastOut.set(sid, Date.now());
      wake(sid);
    },
    touch: (sid) => {
      seen.set(sid, Date.now());
      wake(sid);
    },
    tick: (i) => {
      if (devHook) {
        devHook();
        devHook = null;
      }
      lastInput = i;
      const live = new Set<string>();
      for (const e of i.entries) {
        const ids = e.kind === "group" ? e.members : [e.session];
        let until = 0;
        for (const m of ids) until = Math.max(until, (lastOut.get(m.id) ?? 0) + LIVE_HOLD_MS);
        if (until <= i.now) continue;
        live.add(e.key);
        // 孤立的一行只出一圈：下一拍最早要等 BEAT_MS，而 LIVE_HOLD_MS < BEAT_MS
        if (i.now >= (nextBeat.get(e.key) ?? 0)) {
          nextBeat.set(e.key, i.now + BEAT_MS);
          beats[e.key] = (beats[e.key] ?? 0) + 1;
          const tab = tabOf(i.bar, e.key);
          tab?.setAttribute("data-live", "1");
          ring(tab);
        }
      }
      if (live.size !== liveKeys.size || [...live].some((k) => !liveKeys.has(k))) {
        for (const k of liveKeys) if (!live.has(k)) tabOf(i.bar, k)?.removeAttribute("data-live");
        // 刚变活跃但这一拍还没到下一圈的（两次输出间隔落在 LIVE_HOLD_MS 与 BEAT_MS 之间）
        for (const k of live) if (!liveKeys.has(k)) tabOf(i.bar, k)?.setAttribute("data-live", "1");
        liveKeys.clear();
        for (const k of live) liveKeys.add(k);
      }
      for (const k of nextBeat.keys()) if (!i.entries.some((e) => e.key === k)) nextBeat.delete(k);
      // 菜单行的活跃集合按会话算（组标签的 key 集合帮不上逐会话的菜单行）；边沿才回调。
      if (opts.onLive) {
        const sids = new Set<string>();
        for (const s of i.sessions) {
          if ((lastOut.get(s.id) ?? 0) + LIVE_HOLD_MS > i.now) sids.add(s.id);
        }
        if (sids.size !== liveSidsNow.size || [...sids].some((id) => !liveSidsNow.has(id))) {
          liveSidsNow = sids;
          opts.onLive([...sids]);
        }
      }
      recomputeIdle(i);
    },
  };
  return api;
}
