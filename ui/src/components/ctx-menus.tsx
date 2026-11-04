// 右键/弹出菜单群（App.tsx 拆分⑤）：分屏选择、标签右键、主机卡右键、终端区右键、
// 最近连接行右键五个菜单 + 分屏退化提示。从 App.tsx 原样出仓，本文件只收 props
// 呈现，零语义变更（定位夹取、遮罩关闭、动作分派全部保持原样）。
import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { inTauri } from "../adapter/bridge";
import * as clipboard from "@tauri-apps/plugin-clipboard-manager";
import type { Host, HostMeta, LocalShell, SessionInfo } from "../adapter/wire";
import { stateLabel } from "../app-data";
import { t } from "../i18n";
import type { ConfirmState } from "./confirm-dialogs";
import type { SplitDir, SplitPanes } from "../app-data";
import { IconX } from "../icons";

// 按钮美化轮：右键菜单宽度随内容（200–340px，styles.css .ctx-menu），挂载即测量——越出视口
// 就回夹到边内 6px。旧版按固定 236 宽估算夹取，宽度一随内容估算就失准；各菜单原有的
// 估算夹取保留作首帧初值，本函数只在真越界时改写 left/top（React 不重写未变的 style 值）。
export function clampIntoView(el: HTMLElement | null) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const pad = 6;
  if (r.right > window.innerWidth - pad) el.style.left = `${Math.max(pad, window.innerWidth - pad - r.width)}px`;
  if (r.bottom > window.innerHeight - pad) el.style.top = `${Math.max(pad, window.innerHeight - pad - r.height)}px`;
}

export interface CtxMenusProps {
  sessions: SessionInfo[];
  sid: string | null;
  hosts: Host[];
  hostMeta: HostMeta[];
  connectingIds: Set<string>;
  splitPanes: SplitPanes | null;
  tabNames: Record<string, string>;
  autoReconn: { sid: string; attempt: number; max: number } | null;
  // —— 分屏选择菜单 ——
  splitMenu: boolean;
  setSplitMenu: (v: boolean) => void;
  enterSplitWith: (sid: string, dir?: SplitDir) => Promise<void>;
  // 方向选择（分屏⑥轮）：菜单内的左右/上下分段选择，写回后各入口沿用
  splitDir: SplitDir;
  setSplitDir: (d: SplitDir) => void;
  // —— 标签右键 ——
  tabMenu: { x: number; y: number; sid: string } | null;
  setTabMenu: (v: { x: number; y: number; sid: string } | null) => void;
  exitSplit: () => void;
  // 分屏组命名（本轮）：当前组名（自动名或自定义）+ 打开改名框（值=编辑文本）
  splitGroupLabel: string | null;
  setGroupRenaming: (v: string | null) => void;
  stopRetry: (s: SessionInfo) => Promise<void>;
  reconnectSession: (s: SessionInfo) => Promise<void>;
  setRenaming: (v: { sid: string; value: string }) => void;
  toggleSessionLog: (s: SessionInfo) => Promise<void>;
  openSessionLogFolder: (sid: string) => Promise<void>;
  openSessionDetail: (s: SessionInfo | null | undefined) => Promise<void>;
  requestCloseSession: (s: SessionInfo) => void;
  // —— 主机卡右键 / 最近连接行右键 ——
  hostMenu: { x: number; y: number; hostId: string } | null;
  setHostMenu: (v: { x: number; y: number; hostId: string } | null) => void;
  recentMenu: { x: number; y: number; hostId: string } | null;
  setRecentMenu: (v: { x: number; y: number; hostId: string } | null) => void;
  createSession: (h: Host, intoSplit?: boolean) => void;
  toggleFavorite: (id: string, fav: boolean) => Promise<void>;
  // 本地终端一等公民轮：本机右键「用指定 shell 新开」（探测清单 + 回调）
  localShells: LocalShell[];
  onLocalShell: (path: string) => void;
  setEditingHost: (h: Host | null) => void;
  setPrefillEntry: (v: null) => void;
  setShowImport: (v: boolean) => void;
  setShowAddHost: (v: boolean) => void;
  setRecentHidden: (id: string, hidden: boolean) => void;
  setConfirm: (c: ConfirmState | null) => void;
  // —— 终端区右键 ——
  termMenu: { x: number; y: number; sid: string; hasSel: boolean; paneKey?: string } | null;
  setTermMenu: (v: { x: number; y: number; sid: string; hasSel: boolean; paneKey?: string } | null) => void;
  termsRef: { current: Map<string, { term: Terminal }> };
  /** tmux 面板格子实例（右键命中格子时作用对象） */
  paneTermsRef: { current: Map<string, { term: Terminal; sid: string; paneId: number }> };
  closeTmuxPane: (sid: string, paneId: number) => Promise<void>;
  /** 该标签的面板布局被拖过（有自定义布局树）——右键给「重置面板布局」 */
  paneLayoutCustom: (sid: string) => boolean;
  resetPaneLayout: (sid: string) => void;
  pasteTextIntoRef: { current: (term: Terminal, sessionSid: string, t: string, paneKey?: string) => void };
  setSearchOpen: (v: boolean) => void;
  searchInputRef: { current: HTMLInputElement | null };
  sidRef: { current: string | null };
  attachSession: (sid: string) => Promise<void>;
  // —— 分屏退化提示 ——
  splitDegraded: boolean;
  splitHintOpen: boolean;
  splitHintDismissedRef: { current: boolean };
  setSplitHintOpen: (v: boolean) => void;
}

export function CtxMenus({
  sessions, sid, hosts, hostMeta, connectingIds, splitPanes, tabNames, autoReconn,
  splitMenu, setSplitMenu, enterSplitWith, splitDir, setSplitDir,
  tabMenu, setTabMenu, exitSplit, splitGroupLabel, setGroupRenaming, stopRetry, reconnectSession, setRenaming,
  toggleSessionLog, openSessionLogFolder, openSessionDetail, requestCloseSession,
  hostMenu, setHostMenu, recentMenu, setRecentMenu, createSession, toggleFavorite,
  localShells, onLocalShell,
  setEditingHost, setPrefillEntry, setShowImport, setShowAddHost, setRecentHidden, setConfirm,
  termMenu, setTermMenu, termsRef, paneTermsRef, closeTmuxPane, paneLayoutCustom, resetPaneLayout,
  pasteTextIntoRef, setSearchOpen, searchInputRef, sidRef, attachSession,
  splitDegraded, splitHintOpen, splitHintDismissedRef, setSplitHintOpen,
}: CtxMenusProps) {
  const metaById = new Map(hostMeta.map((m) => [m.host_id, m]));
  // 键盘可达（审查二轮 UX2-4）：菜单此前只能鼠标点——焦点不被捕获、无箭头导航，
  // 纯键盘用户只能 Esc。菜单开即聚焦首项，↑↓ 在菜单项间循环（Enter 原生激活，
  // Esc 仍走全局浮层链）；捕获段监听只拦方向键，其余键不动。
  const menusOpen = !!(splitMenu || tabMenu || hostMenu || recentMenu || termMenu);
  // 输入方式追踪（按钮美化轮）：最后一次输入是键盘（Shift+F10 / 菜单键 / 快捷键打开）→ 菜单
  // 一打开就进键盘态，首项焦点高亮立刻可见；指针按下即回落（鼠标打开不亮首项）
  const lastInputKbdRef = useRef(false);
  useEffect(() => {
    const onKeyAny = (e: KeyboardEvent) => {
      if (e.key !== "Shift" && e.key !== "Control" && e.key !== "Alt" && e.key !== "Meta") lastInputKbdRef.current = true;
    };
    const onPointer = () => { lastInputKbdRef.current = false; };
    window.addEventListener("keydown", onKeyAny, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKeyAny, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, []);
  useEffect(() => {
    if (!menusOpen) return;
    const first = document.querySelector<HTMLElement>(".split-menu button:not(:disabled), .ctx-menu button:not(:disabled)");
    first?.focus({ preventScroll: true });
    const host = first?.closest<HTMLElement>(".split-menu, .ctx-menu");
    if (host && lastInputKbdRef.current) host.dataset.kbd = "1";
    const onKey = (e: KeyboardEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.(".split-menu, .ctx-menu") as HTMLElement | null;
      if (!el) return;
      // 按钮美化轮：键盘一动才显示焦点高亮（styles.css「菜单项统一」块按 data-kbd 门控）——
      // 鼠标打开时首项虽持焦点但不高亮，免得首项常亮与悬停项双亮
      el.dataset.kbd = "1";
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = [...el.querySelectorAll<HTMLElement>("button:not(:disabled)")];
      if (items.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const i = items.indexOf(document.activeElement as HTMLElement);
      // 焦点不在项上（i=-1，如点过分隔线）时 ↑ 落末项、↓ 落首项
      const n = items.length;
      items[e.key === "ArrowDown" ? (i + 1) % n : (i <= 0 ? n - 1 : i - 1)].focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menusOpen, splitMenu, tabMenu, hostMenu, recentMenu, termMenu]);
  return (
    <>
      {splitMenu && (() => {
        const side = splitDir === "tb" ? t("下侧") : t("右侧");
        return (
          <>
            <div className="pop-mask" onClick={() => setSplitMenu(false)} />
            <div className="split-menu" role="menu" aria-label={t("分屏")}>
              {/* 分屏⑥轮：方向可选（Windows Terminal/iTerm2 习惯）——记住上次选择，
                  标签分屏钮/右键项沿用；已分屏时选向即旋转布局 */}
              <div className="split-dir-row" role="radiogroup" aria-label={t("分屏方向")}>
                <button type="button" className={"sm-dir" + (splitDir === "lr" ? " on" : "")} role="radio"
                  aria-checked={splitDir === "lr"} data-testid="split-dir-lr"
                  title={t("左右分屏：当前会话在左，副格在右")}
                  onClick={() => setSplitDir("lr")}
                >{t("左右分屏")}</button>
                <button type="button" className={"sm-dir" + (splitDir === "tb" ? " on" : "")} role="radio"
                  aria-checked={splitDir === "tb"} data-testid="split-dir-tb"
                  title={t("上下分屏：当前会话在上，副格在下")}
                  onClick={() => setSplitDir("tb")}
                >{t("上下分屏")}</button>
              </div>
              <div className="ts-label">{t("在{0}显示已有会话", side)}<span className="dim">{t("（复用现有连接，不新建）")}</span></div>
              {[...sessions].filter((s) => s.id !== sid).length === 0 && (
                <div className="dim" style={{ fontSize: 12, padding: "2px 0 4px" }}>{t("暂无其他会话")}</div>
              )}
              {[...sessions].filter((s) => s.id !== sid).map((s) => {
                const st = stateLabel(s.state);
                return (
                  <button key={s.id} className="sm-item" role="menuitem"
                    onClick={() => { setSplitMenu(false); void enterSplitWith(s.id, splitDir); }}>
                    <span className="sm-name">{s.host_name}</span>
                    <span className={"mono " + st.cls} style={{ fontSize: 10, marginLeft: "auto" }}>{st.text}</span>
                  </button>
                );
              })}
              <div className="dim" style={{ fontSize: 11, lineHeight: 1.6, padding: "6px 2px 0" }}>
                {t("新建的会话先落在标签栏——右键标签选「与当前会话分屏」即可。")}
              </div>
            </div>
          </>
        );
      })()}
      {/* 十一轮：标签右键菜单——对象先存在、操作跟上来。fixed 定位跟随指针并夹在
          视口内；遮罩点击/右键都关闭；会话关闭后菜单自动只剩遮罩（点掉即净） */}
      {tabMenu && (() => {
        const s = sessions.find((x) => x.id === tabMenu.sid);
        const mx = Math.min(tabMenu.x, window.innerWidth - 248);
        const my = Math.min(tabMenu.y, window.innerHeight - 236);
        const close = () => setTabMenu(null);
        const inSplit = !!s && (splitPanes?.main === s.id || splitPanes?.second === s.id);
        const menuHost = s ? hosts.find((h) => h.id === s.host_id) : undefined;
        const side = splitDir === "tb" ? t("下") : t("右");
        return (
          <>
            <div className="pop-mask" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
            {s && (
              <div className="ctx-menu" ref={clampIntoView} role="menu" aria-label={t("会话操作：{0}", s.host_name)} style={{ left: mx, top: my }}>
                {inSplit ? (
                  <>
                    <button className="sm-item" role="menuitem"
                      onClick={() => { close(); void exitSplit(); }}
                    >{t("退出分屏（两个会话都保留）")}</button>
                    {/* 分屏⑥轮：布局旋转（tmux/Windows Terminal 习惯）——两会话不动，只换方向 */}
                    <button className="sm-item" role="menuitem"
                      onClick={() => { close(); void enterSplitWith(s.id, splitDir === "tb" ? "lr" : "tb"); }}
                    >{t("改为{0}分屏", splitDir === "tb" ? t("左右") : t("上下"))}</button>
                    {/* 分屏组命名（本轮）：改名框开在分割条胶囊上；清空提交=回自动名 */}
                    <button className="sm-item" role="menuitem" data-testid="ctx-rename-group"
                      title={t("自定义分屏组名（清空恢复自动命名：成员名相连）")}
                      onClick={() => { close(); setGroupRenaming(splitGroupLabel ?? ""); }}
                    >{t("重命名分组…")}</button>
                  </>
                ) : s.id !== sid && !!sid ? (
                  <button className="sm-item" role="menuitem"
                    onClick={() => { close(); void enterSplitWith(s.id, splitDir); }}
                  >{splitPanes ? t("放到{0}侧分屏（替换{0}格）", side) : t("与当前会话分屏（放到{0}侧）", side)}</button>
                ) : s.id === sid && sessions.some((x) => x.id !== s.id) ? (
                  // 十二轮：活动标签也得分屏（Xshell/Windows Terminal 惯例）——
                  // 第二格是谁交给既有「会话选择」菜单，不在此复制会话列表
                  <button className="sm-item" role="menuitem"
                    onClick={() => { close(); setSplitMenu(true); }}
                  >{t("分屏（选择{0}侧会话）…", side)}</button>
                ) : s.id === sid && menuHost ? (
                  // 十三轮：唯一会话也有分屏——复制本标签到副格（新会话），Windows
                  // Terminal "Split Tab" 语义；显式参数直达，无预武装挂起态
                  <button className="sm-item" role="menuitem"
                    title={t("新建一条同主机连接并放入{0}侧窗格（当前会话留在{1}侧）", side, splitDir === "tb" ? t("上") : t("左"))}
                    onClick={() => { close(); createSession(menuHost, true); }}
                  >{t("分屏：复制标签页到{0}侧（新会话）", side)}</button>
                ) : null}
                {autoReconn?.sid === s.id ? (
                  <button className="sm-item" role="menuitem"
                    onClick={() => { close(); void stopRetry(s); }}
                  >{t("停止自动重连")}</button>
                ) : s.state === "Disconnected" ? (
                  <button className="sm-item" role="menuitem"
                    onClick={() => { close(); void reconnectSession(s); }}
                  >{t("重连会话")}</button>
                ) : null}
                {menuHost && (
                  <button className="sm-item" role="menuitem"
                    title={t("用同一台主机新建一条会话（现有会话不受影响）")}
                    onClick={() => { close(); void createSession(menuHost); }}
                  >{t("复制标签页（同主机新会话）")}</button>
                )}
                <button className="sm-item" role="menuitem"
                  title={t("自定义标签显示名（清空恢复主机名）；也可双击标签")}
                  onClick={() => { close(); setRenaming({ sid: s.id, value: tabNames[s.id] ?? s.host_name }); }}
                >{t("重命名标签…")}</button>
                {/* 十八轮：会话日志——pump tap 落盘，开关态随 SessionInfo 下发不漂移 */}
                <button className="sm-item" role="menuitem" data-testid="ctx-session-log"
                  title={t("把该会话收到的全部输出记录到本地日志文件（data/logs 目录，追加写入）")}
                  onClick={() => { close(); void toggleSessionLog(s); }}
                >{s.logging ? t("停止记录会话日志") : t("记录会话日志")}</button>
                {s.logging && (
                  <button className="sm-item" role="menuitem" data-testid="ctx-session-log-open"
                    onClick={() => { close(); void openSessionLogFolder(s.id); }}
                  >{t("打开日志文件夹")}</button>
                )}
                <div className="ctx-menu-sep" role="separator" />
                <button className="sm-item" role="menuitem"
                  onClick={() => { close(); void openSessionDetail(s); }}
                >{t("连接详情…")}</button>
                <button className="sm-item tm-danger" role="menuitem"
                  onClick={() => { close(); requestCloseSession(s); }}
                >{t("关闭会话…")}</button>
              </div>
            )}
          </>
        );
      })()}
      {/* 十一轮续：主机卡右键——与 hover 操作组同源同义（连接/收藏/编辑/删除）。
          本地终端一等公民轮：「本机」是内置条目——菜单裁剪为连接 + 指定 shell 新开
          （探测清单 >1 才列；默认选择仍在 设置 → 终端） */}
      {hostMenu && (() => {
        const h = hosts.find((x) => x.id === hostMenu.hostId);
        const isLocal = hostMenu.hostId === "local";
        const mx = Math.min(hostMenu.x, window.innerWidth - 248);
        const my = Math.min(hostMenu.y, window.innerHeight - 200);
        const close = () => setHostMenu(null);
        const fav = metaById.get(hostMenu.hostId)?.favorite === true;
        return (
          <>
            <div className="pop-mask" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
            {h && (
              <div className="ctx-menu" ref={clampIntoView} role="menu" aria-label={t("主机操作：{0}", h.name)} style={{ left: mx, top: my }}>
                {!connectingIds.has(h.id) && (
                  <button className="sm-item" role="menuitem"
                    onClick={() => { close(); createSession(h); }}
                  >{t("连接（新建会话）")}</button>
                )}
                {isLocal && localShells.length > 1 && localShells.map((s) => (
                  <button key={s.id} className="sm-item" role="menuitem"
                    title={s.integrable ? t("用 {0} 新开本地终端", s.name) : t("用 {0} 新开（无 shell 集成：命令块/现场延续不可用）", s.name)}
                    onClick={() => { close(); onLocalShell(s.path); }}
                  >{t("用 {0} 新开", s.name)}{s.integrable ? "" : t("（无命令块）")}</button>
                ))}
                {!isLocal && (
                  <button className="sm-item" role="menuitem"
                    onClick={() => { close(); void toggleFavorite(h.id, !fav); }}
                  >{fav ? t("取消收藏") : t("收藏（置顶分组）")}</button>
                )}
                {!isLocal && (
                  <>
                    <div className="ctx-menu-sep" role="separator" />
                    <button className="sm-item" role="menuitem"
                      onClick={() => { close(); setEditingHost(h); setShowImport(false); setPrefillEntry(null); setShowAddHost(true); }}
                    >{t("编辑主机…")}</button>
                    <button className="sm-item tm-danger" role="menuitem"
                      onClick={() => { close(); setConfirm({ kind: "deleteHost", id: h.id, name: h.name }); }}
                    >{t("删除主机…")}</button>
                  </>
                )}
              </div>
            )}
          </>
        );
      })()}
      {/* 十一轮续：终端区右键——复制（仅选区在场）/粘贴/全选，作用于命中的窗格；
          粘贴语义收口在 pasteTextInto（⌘V 同源：bracketed paste + 多行确认契约） */}
      {termMenu && termMenu.paneKey && (() => {
        // tmux 面板格子右键：复制/粘贴/全选作用于本格，「关闭窗格」只断开视图
        const pe = paneTermsRef.current.get(termMenu.paneKey);
        const mx = Math.min(termMenu.x, window.innerWidth - 200);
        const my = Math.min(termMenu.y, window.innerHeight - 200);
        const close = () => setTermMenu(null);
        return (
          <>
            <div className="pop-mask" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
            {pe && (
              <div className="ctx-menu" ref={clampIntoView} role="menu" aria-label={t("窗格操作")} data-testid="tmux-cell-menu" style={{ left: mx, top: my }}>
                {termMenu.hasSel && (
                  <button className="sm-item" role="menuitem"
                    onClick={() => {
                      close();
                      const sel = pe.term.getSelection();
                      if (sel) Promise.resolve(inTauri ? clipboard.writeText(sel) : navigator.clipboard?.writeText(sel)).catch(() => {});
                    }}
                  >{t("复制")}</button>
                )}
                <button className="sm-item" role="menuitem"
                  onClick={() => {
                    close();
                    const key = termMenu.paneKey;
                    Promise.resolve(inTauri ? clipboard.readText() : navigator.clipboard?.readText())
                      .then((txt) => { if (txt) pasteTextIntoRef.current(pe.term, pe.sid, txt, key); })
                      .catch(() => {});
                  }}
                >{t("粘贴")}</button>
                <button className="sm-item" role="menuitem"
                  onClick={() => { close(); pe.term.selectAll(); }}
                >{t("全选")}</button>
                <div className="ctx-menu-sep" role="separator" />
                {paneLayoutCustom(pe.sid) && (
                  <button className="sm-item" role="menuitem" data-testid="pane-layout-reset"
                    title={t("回到自动平铺（拖动调整过的位置与大小作废）")}
                    onClick={() => { close(); resetPaneLayout(pe.sid); }}
                  >{t("重置面板布局")}</button>
                )}
                <button className="sm-item tm-danger" role="menuitem" data-testid="tmux-cell-menu-close"
                  title={t("关闭窗格（只断开此视图，tmux 会话继续运行）")}
                  onClick={() => { close(); void closeTmuxPane(pe.sid, pe.paneId); }}
                >{t("关闭窗格")}</button>
              </div>
            )}
          </>
        );
      })()}
      {termMenu && !termMenu.paneKey && (() => {
        const en = termsRef.current.get(termMenu.sid);
        const mx = Math.min(termMenu.x, window.innerWidth - 200);
        const my = Math.min(termMenu.y, window.innerHeight - 236);
        const close = () => setTermMenu(null);
        return (
          <>
            <div className="pop-mask" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
            {en && (
              <div className="ctx-menu" ref={clampIntoView} role="menu" aria-label={t("终端操作")} style={{ left: mx, top: my }}>
                {termMenu.hasSel && (
                  <button className="sm-item" role="menuitem"
                    onClick={() => {
                      close();
                      const sel = en.term.getSelection();
                      if (sel) Promise.resolve(inTauri ? clipboard.writeText(sel) : navigator.clipboard?.writeText(sel)).catch(() => {});
                    }}
                  >{t("复制")}</button>
                )}
                <button className="sm-item" role="menuitem"
                  onClick={() => {
                    close();
                    Promise.resolve(inTauri
                      ? clipboard.readText().then((txt) => pasteTextIntoRef.current(en.term, termMenu.sid, txt))
                      : navigator.clipboard?.readText().then((txt) => pasteTextIntoRef.current(en.term, termMenu.sid, txt))
                    ).catch(() => {});
                  }}
                >{t("粘贴")}</button>
                <button className="sm-item" role="menuitem"
                  onClick={() => { close(); en.term.selectAll(); }}
                >{t("全选")}</button>
                <div className="ctx-menu-sep" role="separator" />
                <button className="sm-item" role="menuitem"
                  onClick={() => {
                    close();
                    // 十四轮：查找作用于右键命中的窗格——非活动会话先切过去再开搜索框
                    // （分屏副格命中时同样成立）；切失败也开（断开现场仍可搜冻结缓冲）
                    const open = () => { setSearchOpen(true); setTimeout(() => searchInputRef.current?.focus(), 0); };
                    if (sidRef.current === termMenu.sid) open();
                    else void attachSession(termMenu.sid).then(open).catch(() => open());
                  }}
                >{t("查找…")}</button>
                <button className="sm-item" role="menuitem"
                  onClick={() => { close(); en.term.clear(); }}
                >{t("清屏")}</button>
                {sidRef.current === termMenu.sid && paneLayoutCustom(termMenu.sid) && (
                  <button className="sm-item" role="menuitem" data-testid="pane-layout-reset"
                    title={t("回到自动平铺（拖动调整过的位置与大小作废）")}
                    onClick={() => { close(); resetPaneLayout(termMenu.sid); }}
                  >{t("重置面板布局")}</button>
                )}
              </div>
            )}
          </>
        );
      })()}
      {/* 本轮：最近连接行右键——与主机卡菜单同源同义（连接/编辑/删除），
          加「从最近连接隐藏」（纯前端偏好；重连自动恢复，createSession 统一钩子） */}
      {recentMenu && (() => {
        const h = hosts.find((x) => x.id === recentMenu.hostId);
        const mx = Math.min(recentMenu.x, window.innerWidth - 248);
        const my = Math.min(recentMenu.y, window.innerHeight - 200);
        const close = () => setRecentMenu(null);
        return (
          <>
            <div className="pop-mask" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
            {h && (
              <div className="ctx-menu" ref={clampIntoView} role="menu" aria-label={t("最近连接操作：{0}", h.name)} style={{ left: mx, top: my }}>
                <button className="sm-item" role="menuitem"
                  onClick={() => { close(); void createSession(h); }}
                >{t("连接（新建会话）")}</button>
                <button className="sm-item" role="menuitem"
                  onClick={() => { close(); setEditingHost(h); setShowImport(false); setPrefillEntry(null); setShowAddHost(true); }}
                >{t("编辑主机…")}</button>
                <button className="sm-item" role="menuitem"
                  onClick={() => { close(); setRecentHidden(h.id, true); }}
                >{t("从最近连接隐藏")}</button>
                <div className="ctx-menu-sep" role="separator" />
                <button className="sm-item tm-danger" role="menuitem"
                  onClick={() => { close(); setConfirm({ kind: "deleteHost", id: h.id, name: h.name }); }}
                >{t("删除主机…")}</button>
              </div>
            )}
          </>
        );
      })()}
      {splitDegraded && splitHintOpen && (
        <div className="split-hint" role="status">
          <span>{splitPanes?.dir === "tb"
            ? t("窗口高度不足——分屏临时退化为单窗格，另一个会话仍在标签中；拉高窗口自动恢复。")
            : t("窗口宽度不足——分屏临时退化为单窗格，另一个会话仍在标签中；加宽窗口自动恢复。")}</span>
          <button className="ghost" aria-label={t("关闭提示")} onClick={() => { splitHintDismissedRef.current = true; setSplitHintOpen(false); }}><IconX size={12} /></button>
        </div>
      )}
    </>
  );
}
