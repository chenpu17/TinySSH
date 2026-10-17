// 右键/弹出菜单群（App.tsx 拆分⑤）：分屏选择、标签右键、主机卡右键、终端区右键、
// 最近连接行右键五个菜单 + 分屏退化提示。从 App.tsx 原样出仓，本文件只收 props
// 呈现，零语义变更（定位夹取、遮罩关闭、动作分派全部保持原样）。
import type { Terminal } from "@xterm/xterm";
import { inTauri } from "../adapter/bridge";
import * as clipboard from "@tauri-apps/plugin-clipboard-manager";
import type { Host, HostMeta, SessionInfo } from "../adapter/wire";
import { stateLabel } from "../app-data";
import type { ConfirmState } from "./confirm-dialogs";
import { IconX } from "../icons";

export interface CtxMenusProps {
  sessions: SessionInfo[];
  sid: string | null;
  hosts: Host[];
  hostMeta: HostMeta[];
  connectingIds: Set<string>;
  splitPanes: { main: string; second: string } | null;
  tabNames: Record<string, string>;
  autoReconn: { sid: string; attempt: number; max: number } | null;
  // —— 分屏选择菜单 ——
  splitMenu: boolean;
  setSplitMenu: (v: boolean) => void;
  enterSplitWith: (sid: string) => Promise<void>;
  // —— 标签右键 ——
  tabMenu: { x: number; y: number; sid: string } | null;
  setTabMenu: (v: { x: number; y: number; sid: string } | null) => void;
  exitSplit: () => void;
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
  setEditingHost: (h: Host | null) => void;
  setPrefillEntry: (v: null) => void;
  setShowImport: (v: boolean) => void;
  setShowAddHost: (v: boolean) => void;
  setRecentHidden: (id: string, hidden: boolean) => void;
  setConfirm: (c: ConfirmState | null) => void;
  // —— 终端区右键 ——
  termMenu: { x: number; y: number; sid: string; hasSel: boolean } | null;
  setTermMenu: (v: { x: number; y: number; sid: string; hasSel: boolean } | null) => void;
  termsRef: { current: Map<string, { term: Terminal }> };
  pasteTextIntoRef: { current: (term: Terminal, sessionSid: string, t: string) => void };
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
  splitMenu, setSplitMenu, enterSplitWith,
  tabMenu, setTabMenu, exitSplit, stopRetry, reconnectSession, setRenaming,
  toggleSessionLog, openSessionLogFolder, openSessionDetail, requestCloseSession,
  hostMenu, setHostMenu, recentMenu, setRecentMenu, createSession, toggleFavorite,
  setEditingHost, setPrefillEntry, setShowImport, setShowAddHost, setRecentHidden, setConfirm,
  termMenu, setTermMenu, termsRef, pasteTextIntoRef, setSearchOpen, searchInputRef, sidRef, attachSession,
  splitDegraded, splitHintOpen, splitHintDismissedRef, setSplitHintOpen,
}: CtxMenusProps) {
  const metaById = new Map(hostMeta.map((m) => [m.host_id, m]));
  return (
    <>
      {splitMenu && (
        <>
          <div className="pop-mask" onClick={() => setSplitMenu(false)} />
          <div className="split-menu" role="menu" aria-label="分屏">
            <div className="ts-label">在右侧显示已有会话<span className="dim">（复用现有连接，不新建）</span></div>
            {[...sessions].filter((s) => s.id !== sid).length === 0 && (
              <div className="dim" style={{ fontSize: 12, padding: "2px 0 4px" }}>暂无其他会话</div>
            )}
            {[...sessions].filter((s) => s.id !== sid).map((s) => {
              const st = stateLabel(s.state);
              return (
                <button key={s.id} className="ghost sm-item" role="menuitem"
                  onClick={() => { setSplitMenu(false); void enterSplitWith(s.id); }}>
                  <span className="sm-name">{s.host_name}</span>
                  <span className={"mono " + st.cls} style={{ fontSize: 10, marginLeft: "auto" }}>{st.text}</span>
                </button>
              );
            })}
            <div className="dim" style={{ fontSize: 11, lineHeight: 1.6, padding: "6px 2px 0" }}>
              新建的会话先落在标签栏——右键标签选「与当前会话分屏」即可。
            </div>
          </div>
        </>
      )}
      {/* 十一轮：标签右键菜单——对象先存在、操作跟上来。fixed 定位跟随指针并夹在
          视口内；遮罩点击/右键都关闭；会话关闭后菜单自动只剩遮罩（点掉即净） */}
      {tabMenu && (() => {
        const s = sessions.find((x) => x.id === tabMenu.sid);
        const mx = Math.min(tabMenu.x, window.innerWidth - 248);
        const my = Math.min(tabMenu.y, window.innerHeight - 236);
        const close = () => setTabMenu(null);
        const inSplit = !!s && (splitPanes?.main === s.id || splitPanes?.second === s.id);
        const menuHost = s ? hosts.find((h) => h.id === s.host_id) : undefined;
        return (
          <>
            <div className="pop-mask" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
            {s && (
              <div className="ctx-menu" role="menu" aria-label={`会话操作：${s.host_name}`} style={{ left: mx, top: my }}>
                {inSplit ? (
                  <button className="ghost sm-item" role="menuitem"
                    onClick={() => { close(); void exitSplit(); }}
                  >退出分屏（两个会话都保留）</button>
                ) : s.id !== sid && !!sid ? (
                  <button className="ghost sm-item" role="menuitem"
                    onClick={() => { close(); void enterSplitWith(s.id); }}
                  >{splitPanes ? "放到右侧分屏（替换右格）" : "与当前会话分屏（放到右侧）"}</button>
                ) : s.id === sid && sessions.some((x) => x.id !== s.id) ? (
                  // 十二轮：活动标签也得分屏（Xshell/Windows Terminal 惯例）——
                  // 第二格是谁交给既有「右侧会话选择」菜单，不在此复制会话列表
                  <button className="ghost sm-item" role="menuitem"
                    onClick={() => { close(); setSplitMenu(true); }}
                  >分屏（选择右侧会话）…</button>
                ) : s.id === sid && menuHost ? (
                  // 十三轮：唯一会话也有分屏——复制本标签到右侧（新会话），Windows
                  // Terminal "Split Tab" 语义；显式参数直达，无预武装挂起态
                  <button className="ghost sm-item" role="menuitem"
                    title="新建一条同主机连接并放入右侧窗格（当前会话留在左侧）"
                    onClick={() => { close(); createSession(menuHost, true); }}
                  >分屏：复制标签页到右侧（新会话）</button>
                ) : null}
                {autoReconn?.sid === s.id ? (
                  <button className="ghost sm-item" role="menuitem"
                    onClick={() => { close(); void stopRetry(s); }}
                  >停止自动重连</button>
                ) : s.state === "Disconnected" ? (
                  <button className="ghost sm-item" role="menuitem"
                    onClick={() => { close(); void reconnectSession(s); }}
                  >重连会话</button>
                ) : null}
                {menuHost && (
                  <button className="ghost sm-item" role="menuitem"
                    title="用同一台主机新建一条会话（现有会话不受影响）"
                    onClick={() => { close(); void createSession(menuHost); }}
                  >复制标签页（同主机新会话）</button>
                )}
                <button className="ghost sm-item" role="menuitem"
                  title="自定义标签显示名（清空恢复主机名）；也可双击标签"
                  onClick={() => { close(); setRenaming({ sid: s.id, value: tabNames[s.id] ?? s.host_name }); }}
                >重命名标签…</button>
                {/* 十八轮：会话日志——pump tap 落盘，开关态随 SessionInfo 下发不漂移 */}
                <button className="ghost sm-item" role="menuitem" data-testid="ctx-session-log"
                  title="把该会话收到的全部输出记录到本地日志文件（data/logs 目录，追加写入）"
                  onClick={() => { close(); void toggleSessionLog(s); }}
                >{s.logging ? "停止记录会话日志" : "记录会话日志"}</button>
                {s.logging && (
                  <button className="ghost sm-item" role="menuitem" data-testid="ctx-session-log-open"
                    onClick={() => { close(); void openSessionLogFolder(s.id); }}
                  >打开日志文件夹</button>
                )}
                <div className="ctx-menu-sep" role="separator" />
                <button className="ghost sm-item" role="menuitem"
                  onClick={() => { close(); void openSessionDetail(s); }}
                >连接详情…</button>
                <button className="ghost sm-item" role="menuitem"
                  onClick={() => { close(); requestCloseSession(s); }}
                >关闭会话…</button>
              </div>
            )}
          </>
        );
      })()}
      {/* 十一轮续：主机卡右键——与 hover 操作组同源同义（连接/收藏/编辑/删除） */}
      {hostMenu && (() => {
        const h = hosts.find((x) => x.id === hostMenu.hostId);
        const mx = Math.min(hostMenu.x, window.innerWidth - 248);
        const my = Math.min(hostMenu.y, window.innerHeight - 200);
        const close = () => setHostMenu(null);
        const fav = metaById.get(hostMenu.hostId)?.favorite === true;
        return (
          <>
            <div className="pop-mask" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
            {h && (
              <div className="ctx-menu" role="menu" aria-label={`主机操作：${h.name}`} style={{ left: mx, top: my }}>
                {!connectingIds.has(h.id) && (
                  <button className="ghost sm-item" role="menuitem"
                    onClick={() => { close(); createSession(h); }}
                  >连接（新建会话）</button>
                )}
                <button className="ghost sm-item" role="menuitem"
                  onClick={() => { close(); void toggleFavorite(h.id, !fav); }}
                >{fav ? "取消收藏" : "收藏（置顶分组）"}</button>
                <div className="ctx-menu-sep" role="separator" />
                <button className="ghost sm-item" role="menuitem"
                  onClick={() => { close(); setEditingHost(h); setShowImport(false); setPrefillEntry(null); setShowAddHost(true); }}
                >编辑主机…</button>
                <button className="ghost sm-item" role="menuitem"
                  onClick={() => { close(); setConfirm({ kind: "deleteHost", id: h.id, name: h.name }); }}
                >删除主机…</button>
              </div>
            )}
          </>
        );
      })()}
      {/* 十一轮续：终端区右键——复制（仅选区在场）/粘贴/全选，作用于命中的窗格；
          粘贴语义收口在 pasteTextInto（⌘V 同源：bracketed paste + 多行确认契约） */}
      {termMenu && (() => {
        const en = termsRef.current.get(termMenu.sid);
        const mx = Math.min(termMenu.x, window.innerWidth - 200);
        const my = Math.min(termMenu.y, window.innerHeight - 236);
        const close = () => setTermMenu(null);
        return (
          <>
            <div className="pop-mask" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
            {en && (
              <div className="ctx-menu" role="menu" aria-label="终端操作" style={{ left: mx, top: my }}>
                {termMenu.hasSel && (
                  <button className="ghost sm-item" role="menuitem"
                    onClick={() => {
                      close();
                      const sel = en.term.getSelection();
                      if (sel) (inTauri ? clipboard.writeText(sel) : navigator.clipboard?.writeText(sel)).catch(() => {});
                    }}
                  >复制</button>
                )}
                <button className="ghost sm-item" role="menuitem"
                  onClick={() => {
                    close();
                    (inTauri
                      ? clipboard.readText().then((t) => pasteTextIntoRef.current(en.term, termMenu.sid, t))
                      : navigator.clipboard?.readText().then((t) => pasteTextIntoRef.current(en.term, termMenu.sid, t))
                    ).catch(() => {});
                  }}
                >粘贴</button>
                <button className="ghost sm-item" role="menuitem"
                  onClick={() => { close(); en.term.selectAll(); }}
                >全选</button>
                <div className="ctx-menu-sep" role="separator" />
                <button className="ghost sm-item" role="menuitem"
                  onClick={() => {
                    close();
                    // 十四轮：查找作用于右键命中的窗格——非活动会话先切过去再开搜索框
                    // （分屏副格命中时同样成立）；切失败也开（断开现场仍可搜冻结缓冲）
                    const open = () => { setSearchOpen(true); setTimeout(() => searchInputRef.current?.focus(), 0); };
                    if (sidRef.current === termMenu.sid) open();
                    else void attachSession(termMenu.sid).then(open).catch(() => open());
                  }}
                >查找…</button>
                <button className="ghost sm-item" role="menuitem"
                  onClick={() => { close(); en.term.clear(); }}
                >清屏</button>
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
              <div className="ctx-menu" role="menu" aria-label={`最近连接操作：${h.name}`} style={{ left: mx, top: my }}>
                <button className="ghost sm-item" role="menuitem"
                  onClick={() => { close(); void createSession(h); }}
                >连接（新建会话）</button>
                <button className="ghost sm-item" role="menuitem"
                  onClick={() => { close(); setEditingHost(h); setShowImport(false); setPrefillEntry(null); setShowAddHost(true); }}
                >编辑主机…</button>
                <button className="ghost sm-item" role="menuitem"
                  onClick={() => { close(); setRecentHidden(h.id, true); }}
                >从最近连接隐藏</button>
                <div className="ctx-menu-sep" role="separator" />
                <button className="ghost sm-item" role="menuitem"
                  onClick={() => { close(); setConfirm({ kind: "deleteHost", id: h.id, name: h.name }); }}
                >删除主机…</button>
              </div>
            )}
          </>
        );
      })()}
      {splitDegraded && splitHintOpen && (
        <div className="split-hint" role="status">
          <span>窗口宽度不足——分屏临时退化为单窗格，另一个会话仍在标签中；加宽窗口自动恢复。</span>
          <button className="ghost" aria-label="关闭提示" onClick={() => { splitHintDismissedRef.current = true; setSplitHintOpen(false); }}><IconX size={12} /></button>
        </div>
      )}
    </>
  );
}
