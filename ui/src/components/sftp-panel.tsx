// SFTP 面板（App.tsx 拆分③）：远端文件浏览卡、传输队列抽屉、文件动作菜单三块，
// 从 App.tsx 原样出仓——浏览状态（路径/历史/选择/排序/筛选）、传输任务与冲突
// 裁决、菜单开合全部留在宿主，本文件只收 props 呈现，零语义变更。
import { invoke } from "../adapter/bridge";
import type { CollisionDecision, DirEntryS, SessionBrief as Brief } from "../adapter/wire";
import { fmtBytes, type TransferCard } from "../app-data";
import {
  IconChevronLeft, IconChevronRight, IconChevronUp, IconDownload, IconFile,
  IconFolder, IconInbox, IconPencil, IconRefresh, IconTerminal, IconUpload,
} from "../icons";

interface FilesPanelProps {
  sid: string | null;
  brief: Brief | null;
  sftpWrapRef: { current: HTMLDivElement | null };
  sftpCrumbsRef: { current: HTMLDivElement | null };
  sftpListRef: { current: HTMLDivElement | null };
  sftpAnchorRef: { current: string | null };
  sftpPath: string;
  sftpPathInput: string;
  sftpEntries: DirEntryS[] | null;
  sftpLoading: boolean;
  sftpErr: string | null;
  sftpSel: Set<string>;
  sftpHist: string[];
  sftpFwd: string[];
  sftpCursor: number;
  sftpEditPath: boolean;
  sftpFilter: string;
  sftpShowHidden: boolean;
  sftpSaveAs: boolean;
  sftpSort: { key: "name" | "size" | "mtime"; dir: 1 | -1 };
  sftpShown: DirEntryS[];
  sftpListW: number;
  byPathOpen: boolean;
  downloadPath: string;
  setSftpSel: (v: Set<string>) => void;
  setSftpEditPath: (v: boolean) => void;
  setSftpPathInput: (v: string) => void;
  setSftpFilter: (v: string) => void;
  setDownloadPath: (v: string) => void;
  setByPathOpen: (v: boolean) => void;
  // 这三个在 JSX 里传 updater 函数，须用全型 setter
  setShowHidden: React.Dispatch<React.SetStateAction<boolean>>;
  setSftpSaveAs: React.Dispatch<React.SetStateAction<boolean>>;
  setSftpSort: React.Dispatch<React.SetStateAction<{ key: "name" | "size" | "mtime"; dir: 1 | -1 }>>;
  sftpGoBack: () => Promise<void>;
  sftpGoFwd: () => Promise<void>;
  navigateTo: (p: string) => Promise<boolean>;
  loadDir: (p: string) => Promise<boolean>;
  pickAndUpload: () => Promise<void>;
  startDownload: () => Promise<void>;
  sftpListKey: (ev: React.KeyboardEvent) => void;
  sftpRowClick: (e: DirEntryS, idx: number, ev: React.MouseEvent) => void;
  sftpActivate: (e: DirEntryS, at?: { x: number; y: number }) => void;
  sftpDownloadSelected: () => Promise<void>;
  downloadRemote: (rp: string, opts?: { saveAs?: boolean }) => Promise<void>;
}

export function FilesPanel({
  sid, brief, sftpWrapRef, sftpCrumbsRef, sftpListRef, sftpAnchorRef,
  sftpPath, sftpPathInput, sftpEntries, sftpLoading, sftpErr, sftpSel,
  sftpHist, sftpFwd, sftpCursor, sftpEditPath, sftpFilter, sftpShowHidden,
  sftpSaveAs, sftpSort, sftpShown, sftpListW, byPathOpen, downloadPath,
  setSftpSel, setSftpEditPath, setSftpPathInput, setSftpFilter, setDownloadPath,
  setByPathOpen, setShowHidden, setSftpSaveAs, setSftpSort,
  sftpGoBack, sftpGoFwd, navigateTo, loadDir, pickAndUpload, startDownload,
  sftpListKey, sftpRowClick, sftpActivate, sftpDownloadSelected, downloadRemote,
}: FilesPanelProps) {
  return (
          <div className="section" ref={sftpWrapRef}>
            <h4>远程文件</h4>
            {!sid ? (
              <div className="side-quiet">连接会话后可浏览远端目录；文件拖进窗口即上传到正在浏览的目录。</div>
            ) : (
              <>
                <div className="row sftp-nav">
                  <button className="ghost" title="返回上一位置" aria-label="返回" disabled={!sftpHist.length || sftpLoading}
                    onClick={() => void sftpGoBack()}><IconChevronLeft size={13} /></button>
                  <button className="ghost" title="前进" aria-label="前进" disabled={!sftpFwd.length || sftpLoading}
                    onClick={() => void sftpGoFwd()}><IconChevronRight size={13} /></button>
                  <button className="ghost" title="上一级目录" aria-label="上一级"
                    disabled={!sftpPath || sftpPath === "/"}
                    onClick={() => {
                      const p = sftpPath.replace(/\/+$/, "").split("/");
                      p.pop();
                      void navigateTo(p.length ? p.join("/") || "/" : "/");
                    }}
                  ><IconChevronUp size={13} /></button>
                  <button className="ghost" title="刷新当前目录" aria-label="刷新"
                    disabled={!sftpPath || sftpLoading} onClick={() => void loadDir(sftpPath)}
                  ><IconRefresh size={13} /></button>
                  <button className="ghost" title="定位到终端目录（显式定位；不执行 cd，不自动跟随 shell）" aria-label="定位到终端目录"
                    disabled={!brief?.cwd || sftpPath === brief.cwd}
                    onClick={() => brief?.cwd && void navigateTo(brief.cwd)}
                  ><IconTerminal size={13} /></button>
                  <button className="ghost" title="上传本地文件到当前目录（原生文件选择器，可多选）" aria-label="上传"
                    data-testid="sftp-upload-btn"
                    disabled={!sftpPath || sftpLoading}
                    onClick={() => void pickAndUpload()}
                  ><IconUpload size={13} /></button>
                  <button className={"ghost" + (byPathOpen ? " ts-open" : "")} title="按远端路径下载（保留 §246 入口）" aria-label="按路径下载"
                    data-testid="sftp-by-path-btn" aria-pressed={byPathOpen}
                    onClick={() => setByPathOpen(!byPathOpen)}
                  ><IconDownload size={13} /></button>
                  <span style={{ flex: 1 }} />
                  <button className={"ghost" + (sftpEditPath ? " ts-open" : "")} title={sftpEditPath ? "切换为面包屑" : "编辑路径框"}
                    aria-label="切换路径输入" aria-pressed={sftpEditPath}
                    onClick={() => { if (sftpEditPath) setSftpEditPath(false); else { setSftpPathInput(sftpPath); setSftpEditPath(true); } }}
                  ><IconPencil size={13} /></button>
                </div>
                {sftpEditPath ? (
                  <div className="row sftp-path">
                    <input
                      className="mono" autoFocus data-testid="sftp-path-input"
                      placeholder="远端目录（绝对路径，回车进入）"
                      value={sftpPathInput}
                      onChange={(e) => setSftpPathInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void navigateTo(sftpPathInput).then((ok) => { if (ok) setSftpEditPath(false); });
                        else if (e.key === "Escape") { setSftpEditPath(false); setSftpPathInput(sftpPath); }
                      }}
                    />
                  </div>
                ) : (
                  <div className="sftp-crumbs" data-testid="sftp-crumbs" ref={sftpCrumbsRef} title={sftpPath || undefined}>
                    {sftpPath ? (() => {
                      const parts = sftpPath.replace(/\/+$/, "").split("/").filter(Boolean);
                      const segs: { label: string; path: string }[] = [{ label: "/", path: "/" }];
                      let acc = "";
                      for (const p of parts) { acc += "/" + p; segs.push({ label: p, path: acc }); }
                      return segs.map((s, i) => (
                        <span key={s.path} className="sftp-crumb-seg">
                          {i > 0 && <span className="dim">/</span>}
                          {i < segs.length - 1 ? (
                            <button className="sftp-crumb" title={`进入 ${s.path}`} onClick={() => void navigateTo(s.path)}>{s.label}</button>
                          ) : (
                            <span className="sftp-crumb cur" aria-current="location">{s.label}</span>
                          )}
                        </span>
                      ));
                    })() : <span className="dim">未浏览——点「定位到终端目录」或 ✎ 输入绝对路径</span>}
                  </div>
                )}
                <div className="row sftp-tools">
                  <input className="sftp-filter" placeholder="筛选名称" aria-label="按名称筛选"
                    value={sftpFilter} onChange={(e) => setSftpFilter(e.target.value)} />
                  <button className={"ghost" + (sftpShowHidden ? " ts-open" : "")} aria-pressed={sftpShowHidden}
                    title="显示隐藏项（. 开头）" onClick={() => setShowHidden((v) => !v)}>隐藏项</button>
                  <button className={"ghost" + (sftpSaveAs ? " ts-open" : "")} aria-pressed={sftpSaveAs}
                    data-testid="sftp-saveas-toggle"
                    title="另存为模式：下载时逐个弹出保存对话框选位置（对行内下载、下载所选、路径下载、菜单「下载」生效；右键「另存为…」不受影响）"
                    onClick={() => setSftpSaveAs((v) => !v)}>另存为</button>
                  {([["name", "名称"], ["size", "大小"], ["mtime", "时间"]] as const).map(([k, label]) => (
                    <button key={k} className={"ghost" + (sftpSort.key === k ? " ts-open" : "")} aria-pressed={sftpSort.key === k}
                      title={`按${label}排序${sftpSort.key === k ? (sftpSort.dir === 1 ? "（当前升序，点击改降序）" : "（当前降序，点击改升序）") : ""}`}
                      onClick={() => setSftpSort((s) => (s.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: 1 }))}
                    >{label}{sftpSort.key === k ? (sftpSort.dir === 1 ? "↑" : "↓") : ""}</button>
                  ))}
                </div>
                {byPathOpen && (
                  <div className="row xfer-input">
                    <input
                      placeholder="下载远端文件（绝对路径，回车或点「下载」）"
                      value={downloadPath}
                      onChange={(e) => setDownloadPath(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && void startDownload()}
                    />
                    <button disabled={!sid || !downloadPath.trim()} onClick={() => void startDownload()}>下载</button>
                  </div>
                )}
                {sftpErr && <div className="err" style={{ marginTop: 6 }}>✕ {sftpErr}</div>}
                {sftpLoading && (
                  <div className="sftp-list" aria-busy="true">
                    {[0, 1, 2].map((i) => <div className="skeleton sftp-sk" key={i} style={{ width: `${90 - i * 18}%`, height: 18 }} />)}
                  </div>
                )}
                {!sftpLoading && sftpEntries && sftpEntries.length === 0 && (
                  <div className="side-quiet">空目录。</div>
                )}
                {!sftpLoading && sftpEntries && sftpEntries.length > 0 && sftpShown.length === 0 && (
                  <div className="side-quiet">无匹配项（名称筛选或隐藏项过滤）。</div>
                )}
                {!sftpLoading && sftpShown.length > 0 && (
                  <div
                    className={"sftp-list" + (sftpListW <= 300 ? " cols-name-only" : sftpListW <= 340 ? " cols-no-time" : "")}
                    data-testid="sftp-list" ref={sftpListRef} tabIndex={0}
                    aria-label="文件列表（方向键移动，Enter 进入目录，Space 选中）"
                    onKeyDown={sftpListKey}
                  >
                    {sftpShown.map((e, i) => (
                      <div
                        key={e.name} data-idx={i} data-name={e.name}
                        className={"sftp-row" + (e.is_dir ? " dir" : "") + (sftpSel.has(e.name) ? " sel" : "") + (i === sftpCursor ? " cursor" : "")}
                        onClick={(ev) => sftpRowClick(e, i, ev)}
                        onDoubleClick={(ev) => sftpActivate(e, { x: ev.clientX, y: ev.clientY })}
                        title={e.is_dir ? "双击进入" : e.kind === "symlink" ? "双击按目标处理" : "双击查看可用动作"}
                      >
                        <span className="sftp-ico" title={e.kind === "symlink" ? "符号链接" : undefined}>
                          {e.kind === "symlink" ? "→" : e.is_dir ? <IconFolder size={13} /> : <IconFile size={13} />}
                        </span>
                        <span className="sftp-name mono" title={`${sftpPath.replace(/\/+$/, "")}/${e.name}`}>{e.name}</span>
                        <span className="dim mono sftp-size" title={e.size == null ? "大小未知" : `${e.size} 字节`}>
                          {e.is_dir ? "目录" : e.kind === "symlink" ? "链接" : e.size == null ? "—" : fmtBytes(e.size)}
                        </span>
                        <span className="dim mono sftp-time" title={e.mtime == null ? "修改时间未知" : new Date(e.mtime * 1000).toLocaleString("zh-CN")}>
                          {e.mtime == null ? "—" : new Date(e.mtime * 1000).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}
                        </span>
                        {!e.is_dir && (
                          <button
                            className="ghost sftp-dl"
                            title="下载（存上次下载目录，首次为「下载」文件夹；开「另存为」或菜单「另存为…」可选位置）"
                            onClick={(ev) => { ev.stopPropagation(); void downloadRemote(`${sftpPath.replace(/\/+$/, "")}/${e.name}`); }}
                          ><IconDownload size={12} />下载</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {/* 选择条在列表下方（R31）：上方插入会使列表下移、双击第二击落空 */}
                {sftpSel.size > 0 && (
                  <div className="row sftp-selbar" data-testid="sftp-selbar">
                    <span className="dim">已选 {sftpSel.size} 项</span>
                    <button className="ghost" data-testid="sftp-sel-download" disabled={sftpLoading}
                      onClick={() => void sftpDownloadSelected()}
                    ><IconDownload size={12} /> 下载所选</button>
                    <button className="ghost" title="清除选择" aria-label="清除选择"
                      onClick={() => { setSftpSel(new Set()); sftpAnchorRef.current = null; }}>✕</button>
                  </div>
                )}
                <div className="side-quiet">单击选中（⌘ 多选 / Shift 范围），双击进入目录或查看文件动作；下载存上次下载目录（首次为「下载」文件夹），开「另存为」可在每次下载时选位置；传输进度见底部队列（状态条「传输 N」展开）。</div>
              </>
            )}
          </div>
  );
}

// R35 S08 §194：传输队列=工作区底部抽屉，默认收起；后台事件只更新状态条计数不
// 自动展开；抽屉关闭不影响任务（纯展示层）。展开不销毁终端实例（兄弟节点，无重挂）。
interface TransferQueueDrawerProps {
  transfers: TransferCard[];
  queueOpen: boolean;
  setQueueOpen: (v: boolean) => void;
  sidRef: { current: string | null };
  hostLabel: (sid?: string) => string;
  canRetry: (t: TransferCard) => boolean;
  decideCollision: (t: TransferCard, decision: CollisionDecision) => Promise<void>;
  verifyOutcome: (id: string) => Promise<void>;
  locateTransfer: (t: TransferCard) => Promise<void>;
  retryTransfer: (id: string) => Promise<void>;
}
export function TransferQueueDrawer({
  transfers, queueOpen, setQueueOpen, sidRef, hostLabel, canRetry,
  decideCollision, verifyOutcome, locateTransfer, retryTransfer,
}: TransferQueueDrawerProps) {
  return (
          <div className="queue-drawer" data-testid="queue-drawer" role="region" aria-label="传输队列">
            <div className="queue-head">
              <span className="queue-title">传输</span>
              <span className="queue-count">{transfers.length} 个任务</span>
              <span style={{ flex: 1 }} />
              <button className="ghost" data-testid="queue-collapse" aria-label="收起传输队列" onClick={() => setQueueOpen(false)}>收起 ⌄</button>
            </div>
            <div className="queue-body">
              {transfers.length === 0 && (
                <div className="side-quiet">暂无传输任务。把文件从访达拖进窗口：拖到文件面板直接上传到正在浏览的目录，拖到终端先确认目标。</div>
              )}
              {transfers.map((t) => (
                <div className="card row xfer-row" key={t.id} data-testid={"xfer-" + t.status}>
                  <span className={"xfer-dir " + (t.kind === "Upload" ? "up" : "down")}>
                    {t.kind === "Upload" ? <IconUpload size={12} /> : <IconDownload size={12} />}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <div className="xfer-name mono" title={t.name}>{t.name}</div>
                      <span className="xfer-host mono" title={`会话：${hostLabel(t.sid)}`}>{hostLabel(t.sid)}</span>
                      <span className="mono xfer-sub">
                        {t.status === "queued" && "排队中…"}
                        {t.status === "running" && (t.total != null && t.total > 0
                          ? `传输中… ${fmtBytes(t.bytes ?? 0)} / ${fmtBytes(t.total)}`
                          : `传输中… ${fmtBytes(t.bytes ?? 0)}${t.total == null ? "（总量未知）" : ""}`)}
                        {t.status === "committing" && "提交中…（字节传完不代表提交完成）"}
                        {t.status === "cancelling" && "取消中…"}
                        {t.status === "done" && `完成 · ${fmtBytes(t.bytes ?? 0)}`}
                        {t.status === "failed" && `失败：${t.error ?? "未知错误"}`}
                        {t.status === "cancelled" && "已取消"}
                        {t.status === "skipped" && "已跳过：同名目标未改动"}
                        {t.status === "interrupted" && `已中断：${t.error ?? "应用重启时传输中断"}`}
                        {t.status === "unknown" && `结果未知：${t.error ?? "发布应答丢失"}`}
                      </span>
                    </div>
                    {/* S08：完整 源 → 目标（方向语义：上传 本地→远端，下载 远端→本地） */}
                    <div className="mono xfer-sub" title={t.kind === "Upload" ? `${t.local} → ${t.remote}` : `${t.remote} → ${t.local}`}>
                      {t.kind === "Upload" ? `${t.local} → ${t.remote}` : `${t.remote} → ${t.local}`}
                    </div>
                    {t.status === "awaiting" && t.prompt && (
                      <div className="xfer-conflict">
                        <div className="mono xfer-sub">
                          {t.prompt.reason === "stat_changed_since_preflight" ? "目标在提交前已变化，需重新裁决：" : "目标已存在："}
                          <span className="mono" title={t.prompt.target_path}>{t.prompt.target_path}</span>
                          {t.prompt.size != null && ` · ${fmtBytes(t.prompt.size)}`}
                          {t.prompt.mtime != null && ` · ${new Date(t.prompt.mtime * 1000).toLocaleString()}`}
                        </div>
                        <div className="row" style={{ gap: 6, marginTop: 4 }}>
                          <button className="ghost" data-testid="cf-skip" onClick={() => { void decideCollision(t, "skip"); }}>跳过</button>
                          <button className="ghost" data-testid="cf-overwrite" title="外部进程可能改动目标且无法验证版本——覆盖发布将被阻止，原文件零改动" onClick={() => { void decideCollision(t, "overwrite"); }}>覆盖</button>
                          <button className="ghost" data-testid="cf-keepboth" onClick={() => { void decideCollision(t, "keepboth"); }}>两个都要</button>
                        </div>
                      </div>
                    )}
                    {t.status === "unknown" && (
                      <div className="row" style={{ gap: 6, marginTop: 4 }}>
                        <button className="ghost" data-testid="uo-reverify" onClick={() => { void verifyOutcome(t.id); }}>重新核实</button>
                        <span className="mono xfer-note">temp 与恢复资料保留；不自动重发</span>
                      </div>
                    )}
                  </div>
                  {/* S08 该状态允许的操作：进行中=取消；失败/取消/跳过/中断=重试（新任务
                      重新校验）；unknown 只有重新核实 + 查看目标（§374 界面须提供
                      「重新核实」「查看目标/记录」，通用重试绝不作为默认动作）；
                      完成=定位（下载访达显示本地目标 / 上传文件面板开目标目录） */}
                  <div className="row" style={{ gap: 2, flex: "none" }}>
                    {t.kind === "Download" && t.status === "done" && !t.local.startsWith("pending") && (
                      <button className="ghost" data-testid="xfer-locate" title="在访达中显示本地目标" onClick={() => void locateTransfer(t)}>定位</button>
                    )}
                    {t.kind === "Upload" && t.status === "done" && t.sid && t.sid === sidRef.current && (
                      <button className="ghost" data-testid="xfer-locate" title="在文件面板打开目标目录" onClick={() => void locateTransfer(t)}>定位</button>
                    )}
                    {t.status === "unknown" && (
                      <button className="ghost" data-testid="xfer-view-target" title="查看目标：核对目标当前状态（下载在访达显示本地目标 / 上传打开文件面板目标目录）——仅目标存在不能证明本任务成功，结果仍待核实" onClick={() => void locateTransfer(t)}>查看目标</button>
                    )}
                    {(t.status === "failed" || t.status === "cancelled" || t.status === "skipped" || t.status === "interrupted") && (
                      canRetry(t)
                        ? <button className="ghost" data-testid="xfer-retry" title="重试：创建新任务，重新校验连接、源文件与冲突" onClick={() => { void retryTransfer(t.id); }}>重试</button>
                        : <span className="xfer-note" data-testid="xfer-retry-unavailable" title="重试须在原会话内重跑（重新校验连接/源/冲突）；原会话已不在——请重连该主机后在文件面板重新发起">会话已不在</span>
                    )}
                    {t.status === "running" || t.status === "queued" || t.status === "cancelling" || t.status === "committing" || t.status === "awaiting" ? (
                      <button className="ghost" title="取消传输" onClick={() => { invoke("cancel_transfer", { id: t.id }).catch(() => {}); }}>✕</button>
                    ) : (
                      <span className={t.status === "done" ? "ok" : t.status === "cancelled" || t.status === "skipped" ? "dim" : "err"} style={{ flex: "none", width: 18, textAlign: "center" }}>
                        {t.status === "done" ? "✓" : t.status === "cancelled" || t.status === "skipped" ? "⊘" : "✕"}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
  );
}

// R31 §350 文件动作菜单：双击/Enter 文件弹出可用动作（不直接执行）；点外/Esc 关
interface SftpFileMenuProps {
  sftpMenu: { name: string; x: number; y: number } | null;
  sftpMenuRef: { current: HTMLDivElement | null };
  winW: number;
  sftpPathRef: { current: string };
  setSftpMenu: (v: { name: string; x: number; y: number } | null) => void;
  downloadRemote: (rp: string, opts?: { saveAs?: boolean }) => Promise<void>;
}
export function SftpFileMenu({
  sftpMenu, sftpMenuRef, winW, sftpPathRef, setSftpMenu, downloadRemote,
}: SftpFileMenuProps) {
  // 开合条件留在宿主（{sftpMenu && …}）；此处守卫只为类型收窄进回调
  if (!sftpMenu) return null;
  return (
        <div
          className="sftp-menu" ref={sftpMenuRef} role="menu" data-testid="sftp-menu"
          aria-label={`${sftpMenu.name} 可用动作`}
          style={{ left: Math.max(6, Math.min(sftpMenu.x, winW - 160)), top: Math.min(sftpMenu.y, window.innerHeight - 84) }}
        >
          <div className="sftp-menu-title mono">{sftpMenu.name}</div>
          <button role="menuitem" data-testid="sftp-menu-download"
            onClick={() => { const n = sftpMenu.name; setSftpMenu(null); void downloadRemote(`${sftpPathRef.current.replace(/\/+$/, "")}/${n}`); }}
          ><IconDownload size={12} /> 下载</button>
          <button role="menuitem" data-testid="sftp-menu-saveas"
            onClick={() => { const n = sftpMenu.name; setSftpMenu(null); void downloadRemote(`${sftpPathRef.current.replace(/\/+$/, "")}/${n}`, { saveAs: true }); }}
          ><IconInbox size={12} /> 另存为…</button>
        </div>
  );
}
