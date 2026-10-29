import { useEffect, useState } from "react";
import { invoke } from "../adapter/bridge";
import type { AuthDraft, Host, HostDraft, IdentityMeta } from "../adapter/wire";
import { t } from "../i18n";

// 添加主机表单：密码直存；私钥先建身份再引用（vault 侧统一加密）；Agent 只存引用
// 十七轮「快速连接」：不存主机一次性建连。表单是 AddHostForm 的削剪——
// 无名称（默认 user@host[:port]）/无标签/无私钥导入与生成（那会写凭据库）；
// 认证三选一：密码 / 凭据库已有密钥（只引用不解出新明文）/ SSH Agent。
// 提交 = begin_connection_draft：主机/凭据/TOFU 信任全在内存，应用退出即失。
export function QuickConnectForm({ onConnect, onCancel }: { onConnect: (host: Host, draft: HostDraft) => void; onCancel: () => void }) {
  const [address, setAddress] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [authMode, setAuthMode] = useState<"password" | "key" | "agent">("password");
  const [password, setPassword] = useState("");
  const [pickedIdentity, setPickedIdentity] = useState("");
  const [charset, setCharset] = useState<"utf-8" | "gbk">("utf-8");
  const [knownIdentities, setKnownIdentities] = useState<IdentityMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    invoke("list_identities")
      .then((xs) => setKnownIdentities(xs.filter((x) => x.kind !== "Password")))
      .catch(() => { /* 选择器降级为空，仍可密码/Agent */ });
  }, []);

  const submit = () => {
    setErr(null);
    if (!address.trim() || !username.trim()) { setErr(t("地址和用户名都不能为空")); return; }
    if (!/^[a-zA-Z0-9._-]{1,253}$/.test(address.trim())) {
      setErr(t("地址格式不对——应为 IP 或域名（如 192.168.1.10），不带端口与协议"));
      return;
    }
    const p = parseInt(port, 10);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) { setErr(t("端口必须是 1–65535 的数字")); return; }
    let auth: AuthDraft;
    if (authMode === "password") {
      if (!password) { setErr(t("请输入密码")); return; }
      auth = { Password: { password } };
    } else if (authMode === "agent") {
      auth = "Agent";
    } else {
      if (!pickedIdentity) { setErr(t("请选择凭据库中的已有密钥（或改用密码 / SSH Agent）")); return; }
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
      tags: [], fingerprint: null, charset, jump_host_id: null,
      // 快速连接是一次性临时目标：不给启动命令字段（持久配置才是它的场景）
      startup_command: null,
    };
    onConnect(display, {
      id: null, name: "", address: addr, port: p, username: user,
      auth, tags: [], charset, shell_integration: null, jump_host_id: null,
    });
  };

  return (
    <div className="card add-host" data-testid="quick-connect-form">
      <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>
        {t("快速连接：临时打开，不保存到主机列表；应用退出后连接信息即丢弃。")}
      </div>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="ah-field" style={{ flex: 2 }}>
          <label>{t("地址（IP 或域名）")}</label>
          <input value={address} onChange={(e) => setAddress(e.target.value)} autoFocus
            placeholder={t("例：192.168.1.10")} style={{ minWidth: 0 }} />
        </div>
        <div className="ah-field" style={{ width: 76 }}>
          <label>{t("端口")}</label>
          <input value={port} onChange={(e) => setPort(e.target.value)} />
        </div>
      </div>
      <div className="row" style={{ marginTop: 6, alignItems: "flex-end" }}>
        <div className="ah-field" style={{ flex: 1 }}>
          <label>{t("用户名")}</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)}
            placeholder={t("例：ops 或 root")} />
        </div>
        <div className="ah-field" style={{ flex: 1 }}>
          <label>{t("认证方式")}</label>
          <select value={authMode} onChange={(e) => { setErr(null); setAuthMode(e.target.value as "password" | "key" | "agent"); }}>
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
          <label>{t("密码")}</label>
          <input type="password" placeholder={t("密码")} value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              // IME 组合期 Enter 是确认候选词，不提交（§7.3 与 resolveAction 同口径）
              if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229)) submit();
            }} />
        </div>
      )}
      {authMode === "key" && (
        <div className="ah-field" style={{ marginTop: 6 }}>
          <label>{t("已有密钥（凭据库）")}</label>
          <select value={pickedIdentity} onChange={(e) => setPickedIdentity(e.target.value)}>
            <option value="">{t("选择凭据库中的密钥…")}</option>
            {knownIdentities.map((k) => (
              <option key={k.id} value={k.id}>{k.label || k.id}</option>
            ))}
          </select>
        </div>
      )}
      <div className="ah-field" style={{ marginTop: 6 }}>
        <label>{t("远端编码（老设备中文乱码时选 GBK）")}</label>
        <select value={charset} onChange={(e) => setCharset(e.target.value as "utf-8" | "gbk")}>
          <option value="utf-8">{t("UTF-8（默认）")}</option>
          <option value="gbk">{t("GBK（中文 Windows / 老旧设备）")}</option>
        </select>
      </div>
      {err && <div className="form-error" style={{ marginTop: 6 }}>{err}</div>}
      <div className="row" style={{ marginTop: 8, gap: 8 }}>
        <button disabled={busy} onClick={submit} data-testid="quick-connect-go">{t("连接")}</button>
        <button className="ghost" onClick={onCancel}>{t("取消")}</button>
      </div>
    </div>
  );
}
