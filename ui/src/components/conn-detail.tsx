// 连接详情对话框（App.tsx 拆分⑤）：R41 §6.6/S09——独立可关闭对话框（§193，不与
// 审批共用长滚动页），展示连接**当时**的身份快照（§6.1：主机配置此后被改/删都不
// 影响），session ID 收在「技术详情」里可复制。从 App.tsx 原样出仓，零语义变更。
import { inTauri } from "../adapter/bridge";
import * as clipboard from "@tauri-apps/plugin-clipboard-manager";
import type { SessionDetail } from "../adapter/wire";
import { stateLabel, stampLocal, TZ_NOTE } from "../app-data";
import { t } from "../i18n";
import { IconX } from "../icons";

interface ConnDetailProps {
  detail: SessionDetail | null;
  detailErr: string | null;
  closeDetail: () => void;
  detailPanelRef: { current: HTMLDivElement | null };
  pushToast: (kind: "ok" | "err" | "info", text: string) => void;
}

export function ConnDetail({ detail, detailErr, closeDetail, detailPanelRef, pushToast }: ConnDetailProps) {
  if (!detail && !detailErr) return null;
  return (
    <>
      <div className="pop-mask" onClick={closeDetail} />
      <div className="term-settings conn-detail" ref={detailPanelRef} role="dialog" aria-modal="true"
        aria-label={t("连接详情")} data-testid="conn-detail">
        <div className="cd-head">
          <b>{t("连接详情")}</b>
          {detail && <span className={"chip " + stateLabel(detail.state).cls}>{stateLabel(detail.state).text}</span>}
          {detail?.control_owner === "Agent" && <span className="badge agent">{t("Agent 控制")}</span>}
          <span style={{ flex: 1 }} />
          <button className="ghost icon-btn" aria-label={t("关闭连接详情")} data-testid="cd-close"
            onClick={closeDetail}><IconX size={14} /></button>
        </div>
        {detailErr ? (
          <div className="empty" data-testid="cd-err">{detailErr}</div>
        ) : detail && (
          <>
            <div className="cd-grid">
              <div className="cd-k">{t("主机")}</div><div className="cd-v" data-testid="cd-host">{detail.host_name}</div>
              <div className="cd-k">{t("用户")}</div><div className="cd-v" data-testid="cd-user">{detail.username}</div>
              <div className="cd-k">{t("地址")}</div><div className="cd-v" data-testid="cd-addr">{detail.address}</div>
              <div className="cd-k">{t("端口")}</div><div className="cd-v" data-testid="cd-port">{detail.port}</div>
              <div className="cd-k">{t("认证类型")}</div><div className="cd-v" data-testid="cd-auth">
                {detail.auth_type === "Key" ? t("密钥") : detail.auth_type === "Agent" ? "SSH Agent"
                  : detail.auth_type === "KeyboardInteractive" ? t("键盘交互") : t("密码")}
              </div>
              <div className="cd-k">{t("指纹")}</div><div className="cd-v cd-fp" data-testid="cd-fp">
                {detail.fingerprint ?? <span className="dim">{t("未记录（首次连接确认前）")}</span>}
              </div>
              <div className="cd-k">{t("编码")}</div><div className="cd-v" data-testid="cd-charset">
                {detail.charset === "gbk" ? "GBK" : "UTF-8"}
              </div>
              <div className="cd-k">{t("创建时间")}</div><div className="cd-v" data-testid="cd-created">
                {stampLocal(detail.created_at)}（{TZ_NOTE}）
              </div>
            </div>
            <div className="cd-sec">
              <h4>{t("技术详情")}</h4>
              <div className="cd-sidrow">
                <span className="cd-k">{t("会话 ID")}</span>
                <code data-testid="cd-sid">{detail.id}</code>
                <button className="ghost" data-testid="cd-copy"
                  onClick={() => {
                    (inTauri ? clipboard.writeText(detail.id) : navigator.clipboard?.writeText(detail.id))
                      .then(() => pushToast("ok", t("会话 ID 已复制")))
                      .catch(() => pushToast("err", t("复制失败——请手动选中复制")));
                  }}>{t("复制")}</button>
              </div>
            </div>
            <div className="dim cd-hint">
              {t("以上为连接时的身份快照——主机配置此后被修改或删除，都不影响这里显示的信息。")}
            </div>
          </>
        )}
      </div>
    </>
  );
}
