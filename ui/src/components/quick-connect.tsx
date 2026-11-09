import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { invoke } from "../adapter/bridge";
import type { AuthDraft, Host, HostDraft, IdentityMeta } from "../adapter/wire";
import { t } from "../i18n";
import { hostAddressOk, normalizeHostAddress, parsePort } from "../app-data";

// 添加主机表单：密码直存；私钥先建身份再引用（vault 侧统一加密）；Agent 只存引用
// 十七轮「快速连接」：不存主机一次性建连。表单是 AddHostForm 的削剪——
// 无名称（默认 user@host[:port]）/无标签/无私钥导入与生成（那会写凭据库）；
// 认证三选一：密码 / 凭据库已有密钥（只引用不解出新明文）/ SSH Agent。
// 提交 = begin_connection_draft：主机/凭据/TOFU 信任全在内存，应用退出即失。
// 地址框回车提交（找茬四轮 D4）：此前只有密码框能 Enter——地址是 autoFocus 首字段
// 与最高频动线，敲完地址回车表单纹丝不动。IME 组合期 Enter 是确认候选词，不提交
// （§7.3 与 resolveAction 同口径）。preventDefault 防回焦 opener 被默认激活
// click 顶回（add-host enterKey 同款，六轮 D6-1）。
const enterKey = (fn: () => void | Promise<void>) => (e: ReactKeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229)) {
    e.preventDefault();
    void fn();
  }
};

export function QuickConnectForm({ onConnect, onCancel, onBusyChange, remoteError }: {
  onConnect: (host: Host, draft: HostDraft) => boolean | void | Promise<boolean | void>;
  onCancel: () => void;
  /** 在途状态上报：宿主据此让 ✕/Esc/取消真正中止 attempt（而非只关弹窗） */
  onBusyChange?: (busy: boolean) => void;
  /** 宿主连接失败横幅的明细：模态遮罩会压住横幅，表单内原样复述一次 */
  remoteError?: string | null;
}) {
  const [address, setAddress] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [authMode, setAuthMode] = useState<"password" | "key" | "agent">("password");
  const [password, setPassword] = useState("");
  const [pickedIdentity, setPickedIdentity] = useState("");
  const [charset, setCharset] = useState<"utf-8" | "gbk">("utf-8");
  const [knownIdentities, setKnownIdentities] = useState<IdentityMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const portRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const identityRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    invoke("list_identities")
      .then((xs) => setKnownIdentities(xs.filter((x) => x.kind !== "Password")))
      .catch(() => { /* 选择器降级为空，仍可密码/Agent */ });
  }, []);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const submit = async () => {
    if (busy) return; // 在途丢弃重复提交（add-host 同款防御；审查二轮观察项）
    setErr(null);
    setFailed(false);
    // 报错即聚焦（六轮 BF-6，add-host 同款契约）：校验失败焦点回位到首个非法
    // 字段——键盘用户（地址框 autoFocus+回车主动线）错误后不断链
    if (!address.trim() || !username.trim()) {
      setErr(t("地址和用户名都不能为空"));
      (!address.trim() ? addressRef : usernameRef).current?.focus();
      return;
    }
    if (!hostAddressOk(address)) {
      setErr(t("地址格式不对——应为 IP 或域名（如 192.168.1.10、server.example.com 或 ::1），不带端口与协议"));
      addressRef.current?.focus();
      return;
    }
    const p = parsePort(port);
    if (p === null) { setErr(t("端口必须是 1–65535 的数字")); portRef.current?.focus(); return; }
    let auth: AuthDraft;
    if (authMode === "password") {
      if (!password) { setErr(t("请输入密码")); passwordRef.current?.focus(); return; }
      auth = { Password: { password } };
    } else if (authMode === "agent") {
      auth = "Agent";
    } else {
      if (!pickedIdentity) { setErr(t("请选择凭据库中的已有密钥（或改用密码 / SSH Agent）")); identityRef.current?.focus(); return; }
      auth = { Key: { identity_id: pickedIdentity } };
    }
    const addr = address.trim();
    const user = username.trim();
    const display: Host = {
      id: "quick-pending",
      name: p === 22 ? `${user}@${addr}` : `${user}@${addr}:${p}`,
      address: addr, port: p, username: user,
      auth_type: authMode === "password" ? "Password" : authMode === "agent" ? "Agent" : "Key",
      identity_id: authMode === "key" ? pickedIdentity : null,
      tags: [], fingerprint: null, charset, shell_integration: null, jump_host_id: null,
      // 快速连接是一次性临时目标：不给启动命令字段（持久配置才是它的场景）
      startup_command: null,
    };
    setBusy(true); // 双发闸真生效：Enter 提交与按钮点击同帧连发的守卫（此前 busy 恒 false 纯装饰）
    try {
      // 宿主在连接成功（Ready）后才关闭对话框；失败返回 false，表单保留全部
      // 已填内容与密码，改一处即可重试——此前提交即关窗，失败后输入全丢。
      const ok = await onConnect(display, {
        id: null, name: "", address: addr, port: p, username: user,
        auth, tags: [], charset, shell_integration: null, jump_host_id: null,
      });
      if (ok === false) {
        setBusy(false);
        setFailed(true);
        // 真正原因在宿主 connError 横幅里；模态遮罩会把它压暗，表单内复述
        // （用渲染期的最新 prop，不用 click 闭包里的旧值）
        setErr(null);
      }
    } catch (e) {
      setBusy(false);
      setErr(String((e as { message?: string })?.message ?? e));
    }
  };

  return (
    <div className="card add-host" data-testid="quick-connect-form">
      <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>
        {t("快速连接：临时打开，不保存到主机列表；应用退出后连接信息即丢弃。")}
      </div>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="ah-field" style={{ flex: 2 }}>
          <label htmlFor="qc-address">{t("地址（IP 或域名）")}</label>
          <input id="qc-address" value={address} onChange={(e) => setAddress(e.target.value)} autoFocus ref={addressRef}
            onKeyDown={enterKey(submit)}
            placeholder={t("例：192.168.1.10")} style={{ minWidth: 0 }} />
        </div>
        <div className="ah-field" style={{ width: 76 }}>
          <label htmlFor="qc-port">{t("端口")}</label>
          <input id="qc-port" value={port} onChange={(e) => setPort(e.target.value)} onKeyDown={enterKey(submit)} ref={portRef} />
        </div>
      </div>
      <div className="row" style={{ marginTop: 6, alignItems: "flex-end" }}>
        <div className="ah-field" style={{ flex: 1 }}>
          <label htmlFor="qc-username">{t("用户名")}</label>
          <input id="qc-username" value={username} onChange={(e) => setUsername(e.target.value)}
            onKeyDown={enterKey(submit)} ref={usernameRef}
            placeholder={t("例：ops 或 root")} />
        </div>
        <div className="ah-field" style={{ flex: 1 }}>
          <label htmlFor="qc-auth-mode">{t("认证方式")}</label>
          <select id="qc-auth-mode" value={authMode} onChange={(e) => { setErr(null); setAuthMode(e.target.value as "password" | "key" | "agent"); }}>
            <option value="password">{t("密码登录")}</option>
            <option value="key">{t("已有密钥（凭据库）")}</option>
            <option value="agent">SSH Agent</option>
          </select>
        </div>
      </div>
      {/* 密码/密钥带 label（巡检补）：与 AddHostForm 对齐——此前只有 placeholder，
          表单有整体 label 体系时单独裸输入框读起来突兀，读屏也不可达 */}
      {authMode === "password" && (
        <div className="ah-field" style={{ marginTop: 6 }}>
          <label htmlFor="qc-password">{t("密码")}</label>
          <input id="qc-password" type="password" placeholder={t("密码")} value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={enterKey(submit)} ref={passwordRef} />
        </div>
      )}
      {authMode === "key" && (
        <div className="ah-field" style={{ marginTop: 6 }}>
          <label htmlFor="qc-identity">{t("已有密钥（凭据库）")}</label>
          <select id="qc-identity" value={pickedIdentity} onChange={(e) => setPickedIdentity(e.target.value)} ref={identityRef}>
            <option value="">{t("选择凭据库中的密钥…")}</option>
            {knownIdentities.map((k) => (
              <option key={k.id} value={k.id}>{k.label || k.id}</option>
            ))}
          </select>
        </div>
      )}
      <div className="ah-field" style={{ marginTop: 6 }}>
        <label htmlFor="qc-charset">{t("远端编码（老设备中文乱码时选 GBK）")}</label>
        <select id="qc-charset" value={charset} onChange={(e) => setCharset(e.target.value as "utf-8" | "gbk")}>
          <option value="utf-8">{t("UTF-8（默认）")}</option>
          <option value="gbk">{t("GBK（中文 Windows / 老旧设备）")}</option>
        </select>
      </div>
      {(() => {
        const shown = err ?? (failed ? (remoteError || t("连接失败——请检查地址、凭据与网络后重试（已填内容保留）")) : null);
        return shown ? <div className="err" role="alert" style={{ marginTop: 6 }}>✕ {shown}</div> : null;
      })()}
      <div className="row" style={{ marginTop: 8, gap: 8 }}>
        <button disabled={busy} onClick={() => void submit()} data-testid="quick-connect-go">{busy ? t("连接中…") : t("连接")}</button>
        <button className="ghost" onClick={onCancel} data-testid="quick-connect-cancel">
          {busy ? t("取消连接") : t("取消")}
        </button>
      </div>
    </div>
  );
}
