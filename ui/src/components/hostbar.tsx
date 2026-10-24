// 主机栏（App.tsx 拆分⑤）：搜索（非受控+150ms 防抖）、标签筛选、收藏分组主机卡、
// 导入面板挂载点、设置钮与宽度抓手。从 App.tsx 原样出仓，本文件只收 props 呈现，
// 零语义变更。过滤/排序/相位文案用 app-data 共享口径（hostMatches/byName/phaseText）。
import type { PointerEvent } from "react";
import { errMsg } from "../adapter/errors";
import type { AppAction } from "../actions";
import type {
  AttemptPhase, ErrorPayload, Host, HostDraft, HostMeta, LocalShell, SessionInfo, SshConfigPreview,
} from "../adapter/wire";
import { byName, hostMatches, phaseText } from "../app-data";
import type { ConfirmState } from "./confirm-dialogs";
import { SshConfigImportPanel } from "./ssh-import";
import {
  IconChevronUp, IconLoader, IconPencil, IconPlus, IconSearch, IconSliders,
  IconStar, IconTrash, IconUpload,
} from "../icons";

export interface HostbarProps {
  hostbarWidth: number;
  hosts: Host[];
  hostMeta: HostMeta[];
  sessions: SessionInfo[];
  hostsLoaded: boolean;
  filteredHosts: Host[];
  favHosts: Host[];
  otherHosts: Host[];
  // 本地终端一等公民轮：本机置顶节（不过滤链）+ 探测 shell 清单与「用 … 新开」回调
  localHost: Host | null;
  localShells: LocalShell[];
  onLocalShell: (path: string) => void;
  allTags: string[];
  activeTag: string | null;
  connectingIds: Set<string>;
  lastFailed: string | null;
  showImport: boolean;
  showAddHost: boolean;
  /** 建连在途 attempt 表（宿主 settleAttempt 维护的本地呈现态；hostAttempt 据此显相位与取消钮） */
  attempts: Record<string, { attemptId: string; hostId: string; phase: AttemptPhase; error: ErrorPayload | null }>;
  // 非受控搜索 + 防抖计时器（归属宿主：卸载清理在彼处）
  hostSearchRef: { current: HTMLInputElement | null };
  hostDebounceRef: { current: number };
  setHostQuery: (v: string) => void;
  gripDrag: { current: boolean };
  gripDown: (e: PointerEvent<HTMLDivElement>) => void;
  gripMove: (e: PointerEvent<HTMLDivElement>) => void;
  gripUp: (e: PointerEvent<HTMLDivElement>) => void;
  dispatchRef: { current: (a: AppAction) => boolean };
  setTagFilter: (t: string | null) => void;
  setShowImport: (v: boolean) => void;
  setShowAddHost: (v: boolean) => void;
  setEditingHost: (h: Host | null) => void;
  setPrefillEntry: (v: SshConfigPreview | null) => void;
  setHostMenu: (m: { x: number; y: number; hostId: string } | null) => void;
  setConfirm: (c: ConfirmState | null) => void;
  attachSession: (sid: string) => Promise<void>;
  createSession: (h: Host, intoSplit?: boolean, draft?: HostDraft) => void;
  toggleFavorite: (id: string, fav: boolean) => Promise<void>;
  cancelConnect: (hostId: string) => Promise<void>;
  pushToast: (kind: "ok" | "err" | "info", text: string) => void;
  refreshLists: () => void;
}

export function Hostbar({
  hostbarWidth, hosts, hostMeta, sessions, hostsLoaded,
  filteredHosts, favHosts, otherHosts, allTags, activeTag,
  localHost, localShells, onLocalShell,
  connectingIds, lastFailed, showImport, showAddHost, attempts,
  hostSearchRef, hostDebounceRef, setHostQuery,
  gripDrag, gripDown, gripMove, gripUp, dispatchRef,
  setTagFilter, setShowImport, setShowAddHost, setEditingHost, setPrefillEntry,
  setHostMenu, setConfirm, attachSession, createSession, toggleFavorite,
  cancelConnect, pushToast, refreshLists,
}: HostbarProps) {
  const metaById = new Map(hostMeta.map((m) => [m.host_id, m]));
  const hostAttempt = (hostId: string) => Object.values(attempts).find((a) => a.hostId === hostId) ?? null;
  return (
    <>
      <aside className="hostbar" style={{ width: hostbarWidth }} aria-label="主机栏">
        <div className="hb-top">
          <div className="hb-search">
            <IconSearch size={13} />
            <input placeholder="搜索主机" aria-label="搜索主机（名称 / 地址 / 用户 / 标签）" spellCheck={false}
              ref={hostSearchRef}
              onInput={(e) => {
                // 非受控 + 150ms 防抖（五轮架构）：键入路径不再逐键 setState
                // 触发全树 reconcile；hostQuery 只服务列表过滤，允许滞后
                const v = (e.target as HTMLInputElement).value;
                if (hostDebounceRef.current) window.clearTimeout(hostDebounceRef.current);
                hostDebounceRef.current = window.setTimeout(() => {
                  hostDebounceRef.current = 0;
                  setHostQuery(v);
                }, 150);
              }}
              onKeyDown={(e) => {
                // 回车直达第一个命中主机（巡检补）——此前搜到后还必须挪鼠标点卡片。
                // 与主机卡 activate() 同动线：有活跃会话切最近一个，否则新建；
                // 连接中的主机忽略（§280 仅本主机连接中不扰）。
                // IME 组合期不触发（§7.3 同 resolveAction 口径）：敲 Enter 确认
                // 候选词不是「连接」
                if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
                // 防抖未落地的键入以输入框实时值重算——渲染闭包里的
                // filteredHosts 可能还停留在 150ms 前的查询词
                const qN = (hostSearchRef.current?.value ?? "").trim().toLowerCase();
                if (!qN) return;
                const pool = (activeTag ? hosts.filter((h) => (h.tags ?? []).includes(activeTag)) : hosts)
                  .filter((h) => hostMatches(h, qN))
                  .sort(byName);
                if (pool.length === 0) return;
                const h = pool[0];
                if (connectingIds.has(h.id)) return;
                const mine = sessions.filter((s) => s.host_id === h.id);
                const live = mine.filter((s) => s.state !== "Disconnected");
                const latest = [...live].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
                if (latest) { void attachSession(latest.id).catch((er) => pushToast("err", errMsg(er))); }
                else createSession(h);
              }} />
          </div>
          <button className="ghost icon-btn" title={showImport ? "收起导入" : "导入 ~/.ssh/config"} aria-label={showImport ? "收起导入" : "导入 ~/.ssh/config"}
            onClick={() => { setShowImport(!showImport); setShowAddHost(false); }}>
            {showImport ? <IconChevronUp size={14} /> : <IconUpload size={14} />}
          </button>
          <button className="ghost icon-btn" title={showAddHost ? "收起表单" : "添加主机"} aria-label={showAddHost ? "收起表单" : "添加主机"}
            onClick={() => { setShowAddHost(!showAddHost); setShowImport(false); setEditingHost(null); setPrefillEntry(null); }}>
            {showAddHost ? <IconChevronUp size={14} /> : <IconPlus size={14} />}
          </button>
        </div>
        {allTags.length > 0 && (
          <div className="hb-tags" role="group" aria-label="按标签筛选">
            {allTags.map((t) => (
              <button key={t} className={"hb-tag" + (activeTag === t ? " on" : "")} aria-pressed={activeTag === t}
                title={activeTag === t ? `取消筛选「${t}」` : `只看带「${t}」标签的主机`}
                onClick={() => setTagFilter(activeTag === t ? null : t)}>{t}</button>
            ))}
          </div>
        )}
        <div className="hb-scroll">
          {showImport && (
            <SshConfigImportPanel
              onDone={refreshLists}
              onClose={() => setShowImport(false)}
              onManual={(e) => { setPrefillEntry(e); setEditingHost(null); setShowImport(false); setShowAddHost(true); }}
            />
          )}
          {/* 新建/编辑主机与快速连接已改居中对话框（用户反馈二轮：220px 侧栏塞不下
              表单）——挂载点移到 App 顶层浮层区，见下方 form-mask 两块 */}
          {(() => {
            // R20（§4.2）：卡片渲染收敛为局部函数——收藏分组（收藏/其他主机/全部主机）
            // 复用同一卡片形态；组内名称序已在 filteredHosts 派生时排序
            // 本地终端一等公民轮：isLocal 分支——「本机」是内置条目，徽标显「本地」、
            // 无收藏/编辑/删除（后端 LocalHostImmutable 同门兜底），连接语义不变
            const renderHostCard = (h: Host, isLocal = false) => {
              // 该主机的现有会话（五人走查·林姐：误点已连主机静默开重复会话）。
              // 在线徽章 + 点击切到最近会话；显式另开走右侧「连接」钮
              const mine = sessions.filter((s) => s.host_id === h.id);
              const live = mine.filter((s) => s.state !== "Disconnected");
              const anyOnline = mine.some((s) => s.state === "Connected");
              // 最近会话按时间戳比较：chrono 秒级无小数、纳秒级带小数位，
              // 字符串字典序在「同一秒内混合精度」时会错序（'Z' > '.'）
              const latest = [...live].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
              const fav = metaById.get(h.id)?.favorite === true;
              const activate = () => {
                if (connectingIds.has(h.id)) return; // §280：仅本主机连接中忽略，其他主机不受扰
                if (latest) { void attachSession(latest.id).catch((e) => pushToast("err", errMsg(e))); return; }
                createSession(h);
              };
              return (
                <div className="host-card" key={h.id}
                  tabIndex={0}
                  onContextMenu={(e) => {
                    // 十一轮续：主机卡右键——连接/收藏/编辑/删除，与 hover 操作组同源同义
                    e.preventDefault();
                    e.stopPropagation();
                    setHostMenu({ x: e.clientX, y: e.clientY, hostId: h.id });
                  }}
                  role="button"
                  aria-label={`主机 ${h.name}（${h.username}@${h.address}:${h.port}）${latest ? "——Enter 切换到最近会话" : "——Enter 连接"}`}
                  onKeyDown={(e) => {
                    // rev-r20 H1：冒泡自内层按钮（星标/编辑/删除）的 Enter/Space 不劫持——
                    // 否则 preventDefault 吞掉按钮自身激活再误触 activate()
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
                  }}
                  title={isLocal
                    ? "本机 PTY——内置条目：不可编辑、不可删除\n默认 shell 在 设置 → 终端 选择；右键可用指定 shell 新开"
                    : `${h.username}@${h.address}:${h.port}\n指纹：${h.fingerprint ?? "首次连接时确认"}\n编码：${h.charset === "gbk" ? "GBK（中文 Windows / 老旧设备）" : "UTF-8"}`}>
                  {/* R8：高频动作（连接）拿主区大点击目标；编辑/删除在右侧 hover 操作组 */}
                  <div className="host-card-main" style={{ cursor: connectingIds.has(h.id) ? "default" : "pointer" }}
                    title={latest
                      ? (isLocal
                        ? `已有 ${mine.length} 个本地终端——点击切换到最近会话，右侧「连接」可另开`
                        : `该主机已有会话——点击切换到最近会话，右侧「连接」可另开新会话\n${h.username}@${h.address}:${h.port}\n指纹：${h.fingerprint ?? "首次连接时确认"}\n编码：${h.charset === "gbk" ? "GBK（中文 Windows / 老设备）" : "UTF-8"}`)
                      : undefined}
                    onClick={activate}>
                    {/* T33：名称为主行（截断禁则）、认证方式降为徽章——修复「密/码」被腰斩。
                        T38 审核：GBK 徽章置名前——行尾会落入 hover 操作组覆盖区，置尾恰在
                        准备连接的交互时刻不可见；置左恒可见 */}
                    <div className="host-line">
                      {h.charset === "gbk" && <span className="auth-tag" title="远端编码：GBK">GBK</span>}
                      {mine.length > 0 && (
                        <span className={"auth-tag live-tag" + (anyOnline ? " on" : "")}
                          title={`已有 ${mine.length} 个会话（存活 ${live.length}）——点击主行切换到最近会话`}>● {mine.length}</span>
                      )}
                      <span className="host-name">{h.name}</span>
                      {isLocal
                        ? <span className="auth-tag" title="本机 PTY——内置条目，不可编辑或删除">本地</span>
                        : <span className="auth-tag">{h.auth_type === "Key" ? "密钥" : h.auth_type === "Agent" ? "Agent" : "密码"}</span>}
                    </div>
                    <div className="host-addr mono">{isLocal ? `本地 shell · ${h.username}` : `${h.username}@${h.address}:${h.port}`}</div>
                    {(h.tags ?? []).length > 0 && (
                      <div className="host-tags">
                        {(h.tags ?? []).slice(0, 2).map((t) => <span key={t} className="host-tag">{t}</span>)}
                        {(h.tags ?? []).length > 2 && <span className="host-tag more">+{(h.tags ?? []).length - 2}</span>}
                      </div>
                    )}
                    {lastFailed === h.id && !connectingIds.has(h.id) && (
                      <div className="err host-fail">✕ 上次连接失败——检查地址与凭据后重试</div>
                    )}
                  </div>
                  <div className="host-card-side">
                    {!isLocal && (
                      <div className="host-ops">
                        <button className={"ghost fav-btn" + (fav ? " on" : "")} aria-pressed={fav}
                          title={fav ? "取消收藏（移出「收藏」分组）" : "收藏（置顶「收藏」分组）"}
                          onClick={(e) => { e.stopPropagation(); void toggleFavorite(h.id, !fav); }}><IconStar size={13} /></button>
                        <button className="ghost" title="编辑主机（名称/地址/端口/用户名/编码/标签，凭据保持不变）"
                          onClick={() => { setEditingHost(h); setShowImport(false); setPrefillEntry(null); setShowAddHost(true); }}><IconPencil size={13} /></button>
                        <button className="ghost host-del" title="删除主机"
                          onClick={() => setConfirm({ kind: "deleteHost", id: h.id, name: h.name })}><IconTrash size={13} /></button>
                      </div>
                    )}
                    {/* R23（§302 等待中可取消）：attempt 在途显示核心相位 + 取消入口；
                        取消终态由核心串行裁决后呈示（cancelConnect 不自行改状态） */}
                    <div className="row" style={{ flexWrap: "nowrap", gap: 4 }}>
                      <button className="host-connect-btn" disabled={connectingIds.has(h.id)}
                        title={isLocal ? "连接（新开本地终端）——shell 在 设置 → 终端 选择，右键可指定 shell 新开" : "连接（新建会话）——其他主机的连接不受影响"}
                        onClick={() => createSession(h)}>
                        {(() => {
                          const a = hostAttempt(h.id);
                          return a
                            ? <><IconLoader size={11} className="spin" /> {phaseText(a.phase)}</>
                            : "连接";
                        })()}
                      </button>
                      {hostAttempt(h.id) && (
                        <button className="ghost" style={{ width: "auto", flexShrink: 0 }}
                          title="取消本次连接（终态由核心裁决：已取消/已完成可见）"
                          onClick={(e) => { e.stopPropagation(); void cancelConnect(h.id); }}>取消</button>
                      )}
                    </div>
                  </div>
                </div>
              );
            };
            const skeletons = !hostsLoaded ? (<><div className="skeleton" /><div className="skeleton" /></>) : null;
            const emptyAll = hostsLoaded && hosts.length === 0 && (
              <div className="dim">还没有主机。点上方「＋」填入地址和密码即可连接。</div>
            );
            const noMatch = hostsLoaded && hosts.length > 0 && filteredHosts.length === 0 && (
              <>
                <div className="dim">无匹配主机——可清除搜索/标签筛选，或直接添加：</div>
                <button className="ghost" style={{ marginTop: 6 }}
                  onClick={() => { setShowImport(false); setEditingHost(null); setPrefillEntry(null); setShowAddHost(true); }}>
                  <IconPlus size={12} /> 添加主机
                </button>
              </>
            );
            const firstSection = (title: string, cards: Host[]) => (
              <div className="section">
                <h4>{title}</h4>
                {skeletons}
                {cards.map((c) => renderHostCard(c))}
                {emptyAll}
                {noMatch}
              </div>
            );
            // 本地终端一等公民轮：「本机」置顶节——不过滤链（搜索/标签筛选不影响）、
            // 内置条目（卡片无编辑/删除；右键菜单同轮裁剪）。先于收藏组渲染。
            const localSection = localHost && (
              <div className="section" data-testid="local-host-section">
                <h4>本机</h4>
                {renderHostCard(localHost, true)}
              </div>
            );
            // 契约 §4.2：有收藏 → 「收藏」+「其他主机」两组；无收藏 → 「全部主机」单组。
            // 骨架/空态只随首组渲染一次；rev-r20 L2：全部可见主机均收藏时不渲染空「其他主机」节头
            if (favHosts.length > 0) {
              return (
                <>
                  {localSection}
                  {firstSection("收藏", favHosts)}
                  {otherHosts.length > 0 && (
                    <div className="section">
                      <h4>其他主机</h4>
                      {otherHosts.map((c) => renderHostCard(c))}
                    </div>
                  )}
                </>
              );
            }
            return (
              <>
                {localSection}
                {firstSection("全部主机", otherHosts)}
              </>
            );
          })()}
        </div>
        <div className="hb-bottom">
          <button className="hb-settings" title="设置（外观 / 终端 / 凭据）" aria-label="设置"
            onClick={() => dispatchRef.current({ id: "settings" })}>
            <IconSliders size={14} />设置
          </button>
        </div>
      </aside>
      <div className="hb-grip" role="separator" aria-orientation="vertical"
        aria-label="拖动调整主机栏宽度（200–300 px）" title="拖动调整宽度（200–300 px）"
        onPointerDown={gripDown} onPointerMove={gripMove} onPointerUp={gripUp}
        onPointerCancel={() => { gripDrag.current = false; }} />
    </>
  );
}
