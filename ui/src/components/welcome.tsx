// 欢迎页（App.tsx 拆分⑤）：无活跃会话时的引导区——步骤说明、主行动钮、
// 重连上次会话、最近连接。从 App.tsx 原样出仓，本文件只收 props 呈现，零语义变更。
import type { Host, RecentHost, RestoreEntry, SessionInfo } from "../adapter/wire";
import { IconPlus, IconTerminal, IconUpload } from "../icons";
import { t } from "../i18n";

interface WelcomeProps {
  sid: string | null;
  sessions: SessionInfo[];
  hosts: Host[];
  /** 上次退出/刷新时仍打开的主机 id（去重有序；主机已删的行整体过滤） */
  lastSessionHosts: string[];
  recents: RecentHost[];
  recentsHidden: string[];
  /** P3：上次受控退出的现场快照（加密 vault KV；恢复走宿主 onRestoreScene） */
  restoreEntries: RestoreEntry[];
  onRestoreScene: (entries: RestoreEntry[]) => void;
  focusMode: boolean;
  hostbarOpen: boolean;
  createSession: (h: Host) => void;
  applyFocus: (on: boolean) => void;
  toggleHostbar: (open: boolean) => void;
  setShowAddHost: (v: boolean) => void;
  setShowImport: (v: boolean) => void;
  setShowQuickConnect: (v: boolean) => void;
  setEditingHost: (v: null) => void;
  setPrefillEntry: (v: null) => void;
  setRecentMenu: (m: { x: number; y: number; hostId: string }) => void;
}

export function Welcome({
  sid, sessions, hosts, lastSessionHosts, recents, recentsHidden,
  restoreEntries, onRestoreScene,
  focusMode, hostbarOpen, createSession, applyFocus, toggleHostbar,
  setShowAddHost, setShowImport, setShowQuickConnect, setEditingHost,
  setPrefillEntry, setRecentMenu,
}: WelcomeProps) {
  return (
    <div className="welcome">
      <div className="welcome-box">
        <div className="welcome-mark"><IconTerminal size={26} /></div>
        <div className="welcome-title">TinySSH<span className="welcome-sub">{t("人机协同 SSH 工作台")}</span></div>
        <div className="welcome-steps">
          <div><span className="ws-k">{t("连接")}</span>{t("主机栏「＋」填入地址和密码（或粘贴私钥），保存后自动连接")}</div>
          <div><span className="ws-k">{t("操作")}</span>{t("点击终端区直接打字：Ctrl+C 中断、↑↓ 历史、Tab 补全、⌘C/⌘V 复制粘贴")}</div>
          <div><span className="ws-k">{t("多会话")}</span>{t("一屏一签，点标签切换、分屏对照，各自的滚动历史和 vim 界面都会保留")}</div>
          <div><span className="ws-k">{t("传输")}</span>{t("拖文件进窗口上传：拖到文件面板直接传到正在浏览的目录，拖到终端先确认目标")}</div>
          <div><span className="ws-k">{t("专注")}</span>{t("F11 进入全屏专注：界面全让位给终端，标签条常驻顶部（Ctrl+K 面板可切自动隐藏），再按 F11 退出")}</div>
        </div>
        <div className="welcome-actions">
          <button onClick={() => { setShowAddHost(true); setShowImport(false); setShowQuickConnect(false); setEditingHost(null); setPrefillEntry(null); }}><IconPlus size={13} /> {t("添加主机")}</button>
          <button className="ghost" onClick={() => { setShowQuickConnect(true); setShowAddHost(false); setShowImport(false); }}><IconTerminal size={13} /> {t("快速连接")}</button>
          <button className="ghost" data-testid="welcome-import-btn" onClick={() => {
            // 复用取舍：导入 UI 本就完整住在主机栏（hostbar.tsx 挂 SshConfigImportPanel，
            // 预览→分级勾选→导入→行内结果一条龙），欢迎页不重刻极简确认对话框——
            // 把既有面板打开并滚到位即是复用；专注模式下主机栏整列 display:none，
            // 先退专注让主机栏现身再展开导入（巡检实锤，与 Ctrl+K 入口同流程）
            if (focusMode) applyFocus(false);
            if (!hostbarOpen) toggleHostbar(true);
            setShowImport(true); setShowAddHost(false);
          }}><IconUpload size={13} /> {t("从 ~/.ssh/config 导入")}</button>
          {hosts.some((h) => h.id === "local") && (
            <button className="ghost" onClick={() => {
              const lh = hosts.find((h) => h.id === "local");
              if (lh) void createSession(lh);
            }}><IconTerminal size={13} /> {t("打开本地终端")}</button>
          )}
        </div>
        {/* 十五轮：重连上次会话——上次退出/刷新时仍打开的主机（去重有序），
            一键全部重连（点了才连，不自动拨号）。主机已删的行整体过滤 */}
        {sessions.length === 0 && lastSessionHosts.length > 0 && (() => {
          const rowsH = lastSessionHosts.flatMap((hid) => hosts.find((h) => h.id === hid) ?? []);
          if (rowsH.length === 0) return null;
          return (
            <div className="welcome-recents" aria-label={t("上次会话")}>
              <div className="wr-title">{t("上次会话")}</div>
              <button className="wr-row" data-testid="reconnect-last"
                title={t("重连 {0}", rowsH.map((h) => h.name).join("、"))}
                onClick={() => { for (const h of rowsH) void createSession(h); }}>
                <span className="wr-name">{t("⟳ 重连上次会话（{0}）", rowsH.length)}</span>
                <span className="wr-addr">{rowsH.map((h) => h.name).join("、")}</span>
                <span className="wr-go">{t("连接")}</span>
              </button>
            </div>
          );
        })()}
        {/* P3：恢复上次现场——受控退出时的屏幕快照（加密 vault KV）。点了才连，
            每条走既有建连全流程；主机已删的条目由宿主恢复逻辑如实跳过并 toast */}
        {sessions.length === 0 && restoreEntries.length > 0 && (() => {
          const rows = restoreEntries
            .map((e) => ({ e, h: hosts.find((x) => x.id === e.host_id) }))
            .filter((r) => r.h);
          if (rows.length === 0) return null;
          const names = rows.map((r) => r.h!.name).join("、");
          let when = rows[0].e.saved_at;
          try { when = new Date(rows[0].e.saved_at).toLocaleString("zh-CN"); } catch { /* 原样 */ }
          return (
            <div className="welcome-recents" aria-label={t("恢复现场")}>
              <div className="wr-title">{t("上次现场")}</div>
              <button className="wr-row" data-testid="restore-scene"
                title={`${t("快照 {0}", when)}；${restoreEntries.length > rows.length ? t("另有 {0} 个主机已删的条目将跳过。", restoreEntries.length - rows.length) : ""}${t("恢复后终端回到快照画面（滚回保留尾部 300 行）")}`}
                onClick={() => onRestoreScene(restoreEntries)}>
                <span className="wr-name">{t("⏮ 恢复上次现场（{0}）", rows.length)}</span>
                <span className="wr-addr">{names} · {t("快照 {0}", when)}</span>
                <span className="wr-go">{t("恢复")}</span>
              </button>
            </div>
          );
        })()}
        {/* R20（§259）：已有主机但无会话 → 最近连接（后端派生、排除 local、上限 5）。
            仅在欢迎页呈现（§261：避免每次连接使侧栏重排）；点击即建连。
            rev-r20 L5：行全部失效（主机刚删的毫秒窗）时不渲染空标题块 */}
        {sessions.length === 0 && recents.length > 0 && (() => {
          // 本轮：隐藏偏好先滤再截 5（隐藏行不占坑）；右键出操作菜单
          const rows = recents
            .filter((r) => !recentsHidden.includes(r.host_id))
            .slice(0, 5)
            .map((r) => {
            const rh = hosts.find((x) => x.id === r.host_id);
            if (!rh) return null;
            return (
              <button key={r.host_id} className="wr-row"
                title={t("连接 {0}（{1}）；右键更多操作", r.host_name, `${rh.username}@${rh.address}`)}
                onClick={() => void createSession(rh)}
                onContextMenu={(e) => { e.preventDefault(); setRecentMenu({ x: e.clientX, y: e.clientY, hostId: r.host_id }); }}>
                <span className="wr-name">{r.host_name}</span>
                <span className="wr-addr mono">{rh.username}@{rh.address}</span>
                <span className="wr-go">{t("连接")}</span>
              </button>
            );
          }).filter(Boolean);
          if (rows.length === 0) return null;
          return (
            <div className="welcome-recents" aria-label={t("最近连接")}>
              <div className="wr-title">{t("最近连接")}</div>
              {rows}
            </div>
          );
        })()}
        <div className="dim welcome-note">
          {sessions.length > 0
            ? t("已有 {0} 个会话未接入终端——点击上方标签或「标签列表」继续。", sessions.length)
            : t("暂无会话——从主机栏连接主机开始，或导入 ~/.ssh/config。")}
        </div>
      </div>
    </div>
  );
}
