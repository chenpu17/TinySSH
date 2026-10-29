import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { invoke } from "../adapter/bridge";
import type { AuthDraft, Host, IdentityMeta, SshConfigPreview } from "../adapter/wire";
import { friendlyError } from "../app-data";
import { t } from "../i18n";

// IME 组合期守卫（§7.3 与 resolveAction 同口径：isComposing 与 keyCode 229 双查）——
// 中文输入法敲 Enter 是「确认候选词」，不是提交表单。表单全部回车提交经此封装。
const enterKey = (fn: () => void) => (e: ReactKeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229)) fn();
};

// prefill（C7/DF7.4）：导入面板「转手工表单」用预览载荷预填——upsert_host，零新命令。
// 挂在居中对话框里（用户反馈二轮：220px 侧栏塞不下），onCancel 由对话框传「取消」钮。
export function AddHostForm({ onSaved, editHost, prefill, onCancel }: { onSaved: (hostId: string, wasEdit: boolean, connect: boolean) => void; editHost?: Host | null; prefill?: SshConfigPreview | null; onCancel?: () => void }) {
  const editing = !!editHost;
  const [name, setName] = useState(editHost?.name ?? prefill?.name ?? "");
  const [address, setAddress] = useState(editHost?.address ?? prefill?.address ?? "");
  const [port, setPort] = useState(editHost ? String(editHost.port) : String(prefill?.port ?? 22));
  const [username, setUsername] = useState(editHost?.username ?? (prefill && !prefill.user_specified ? "" : prefill?.username ?? ""));
  const [authMode, setAuthMode] = useState<"password" | "key" | "agent">(
    editHost ? "password" : prefill ? (prefill.has_identity ? "key" : "agent") : "password");
  const [charset, setCharset] = useState<"utf-8" | "gbk">(editHost?.charset ?? "utf-8");
  const [tagsInput, setTagsInput] = useState((editHost?.tags ?? (prefill ? ["ssh-config"] : [])).join(","));
  // ProxyJump：跳板机（可选）——引用既有主机条目（复用其凭据/TOFU/编辑/审计，
  // 不做内联凭据）。候选排除自身/「本机」/链路会绕回自身的主机（成环 UX 前置，
  // 后端 upsert 同门兜底）。
  const [jumpId, setJumpId] = useState<string>(editHost?.jump_host_id ?? "");
  const [jumpCandidates, setJumpCandidates] = useState<Host[]>([]);
  // tmux 联动：启动命令（连接成功后自动执行一次，如 tmux new -A -s work——
  // attach-or-create 惯用法）。通用原语而非 tmux 专属开关；本机条目无此概念。
  const [startupCmd, setStartupCmd] = useState<string>(editHost?.startup_command ?? "");
  const [password, setPassword] = useState("");
  const [pem, setPem] = useState("");
  const [passphrase, setPassphrase] = useState("");
  // 私钥先绑定后确认（FR-2 指纹确认）：粘贴/文件/生成 → create_identity 落库 →
  // 出示指纹给用户核对，保存时只引用 identity_id——明文与私钥都不随表单走
  const [identity, setIdentity] = useState<IdentityMeta | null>(null);
  // R21（§265「认证支持已有密钥」）：绑定凭据库里已有的（含取消表单后未绑定的）凭据
  const [pickedIdentity, setPickedIdentity] = useState<string>("");
  const [knownIdentities, setKnownIdentities] = useState<IdentityMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    invoke("list_identities")
      .then((xs) => setKnownIdentities(xs.filter((x) => x.kind !== "Password")))
      .catch(() => { /* 选择器降级为空，仍可生成/导入 */ });
    invoke("list_hosts")
      .then((xs) => setJumpCandidates(xs))
      .catch(() => { /* 跳板选择器降级为空：仍可直连 */ });
  }, []);

  // 跳板候选：排除自身/本机/成环（沿 jump_host_id 向上走，绕回自身即排除；
  // seen 集合同时防他人成环导致死循环）。后端 upsert 会再验一遍。
  const jumpOptions = jumpCandidates.filter((h) => {
    if (h.id === editHost?.id || h.id === "local") return false;
    let cur: string | null = h.jump_host_id ?? null;
    const seen = new Set<string>([h.id]);
    while (cur) {
      if (cur === editHost?.id || seen.has(cur)) return false;
      seen.add(cur);
      cur = jumpCandidates.find((x) => x.id === cur)?.jump_host_id ?? null;
    }
    return true;
  });

  const keyLabel = () => `${username.trim() || "key"}@${address.trim() || name.trim() || "host"}`;

  // 粘贴/文件读入的私钥 → 凭据库身份；只回元数据，不出私钥明文
  const importPem = async () => {
    setErr(null);
    if (!pem.includes("PRIVATE KEY")) { setErr(t("请先粘贴 OpenSSH / PEM 格式的私钥内容，或「从文件导入…」")); return; }
    setBusy(true);
    try {
      const meta = await invoke("create_identity", {
        req: { Import: { label: keyLabel(), pem, passphrase: passphrase || null } },
      });
      setIdentity(meta);
      setPickedIdentity(""); // 新导入的密钥接管当前表单（覆盖已有密钥选择）
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  // FR-2 生成 ed25519：vault 侧生成并加密落库，UI 只拿指纹
  const genKey = async () => {
    setErr(null);
    setBusy(true);
    try {
      const meta = await invoke("create_identity", {
        req: { Generate: { label: keyLabel(), kind: "Ed25519" } },
      });
      setIdentity(meta);
      setPickedIdentity(""); // 新生成的密钥接管当前表单（覆盖已有密钥选择）
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  // connect=false 走「仅保存」：批量录入场景不被逐台自动连接绑架（五人走查·林姐/小王）
  const submit = async (connect = true) => {
    if (busy) return; // 回车提交绕过按钮 disabled——在途时丢弃重复提交
    setErr(null);
    if (!name.trim() || !address.trim() || !username.trim()) {
      setErr(t("名称、地址、用户名都不能为空"));
      return;
    }
    // 地址格式校验（P2-3）：IP 或域名，不带协议/端口/路径——之前的乱码地址能一路存到「连接成功」
    if (!/^[a-zA-Z0-9._-]{1,253}$/.test(address.trim())) {
      setErr(t("地址格式不对——应为 IP 或域名（如 192.168.1.10 或 server.example.com），不带端口与协议"));
      return;
    }
    const p = parseInt(port, 10);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) {
      setErr(t("端口必须是 1–65535 的数字"));
      return;
    }
    setBusy(true);
    try {
      let auth: AuthDraft;
      if (editing) {
        // 编辑默认不回传凭据（UI 不持明文）：Keep 语义保持现有认证与密钥/密码；
        // 密码主机填写了新密码 = 更换凭据（vault 侧新建加密 identity 替换——
        // 主密钥不匹配/换密码场景的唯一入口，用户走查实锤需求）
        auth = password ? { Password: { password } } : "Keep";
      } else if (authMode === "password") {
        if (!password) { setErr(t("请输入密码")); setBusy(false); return; }
        auth = { Password: { password } };
      } else if (authMode === "agent") {
        auth = "Agent";
      } else if (pickedIdentity) {
        // R21：绑定凭据库已有密钥（含取消表单后未绑定的凭据——§267 不默默删除的消费面）
        auth = { Key: { identity_id: pickedIdentity } };
      } else {
        if (!identity) { setErr(t("请先「导入并确认指纹」「生成新密钥」或选择已有密钥")); setBusy(false); return; }
        auth = { Key: { identity_id: identity.id } };
      }
      // 标签（R20）：逗号分隔（中英文逗号皆可）→ 去重去空
      const tags = [...new Set(tagsInput.split(/[,，]/).map((x) => x.trim()).filter(Boolean))];
      const hid = await invoke("upsert_host", {
        host: {
          id: editHost?.id ?? null, name: name.trim(), address: address.trim(),
          port: p, username: username.trim(), auth, tags,
          charset,
          jump_host_id: jumpId || null,
          startup_command: startupCmd.trim() || null,
        },
      });
      if (!editing) { setName(""); setAddress(""); setPort("22"); setPem(""); setPassphrase(""); setIdentity(null); setPickedIdentity(""); setTagsInput(""); setJumpId(""); }
      setPassword(""); // 编辑更换密码后同样清空输入，不明文残留
      onSaved(hid, editing, connect);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const authLabel = editHost?.auth_type === "Key" ? t("密钥") : editHost?.auth_type === "Agent" ? "SSH Agent" : t("密码");

  return (
    <div className="card add-host">
      {prefill && !editing && (
        <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>
          {t("预填自 ~/.ssh/config:")}{prefill.source_line}
          {prefill.unsupported.some((u) => u.level === "Blocking") && t("（含不兼容指令，请核对后保存）")}
          {!prefill.user_specified && t("（config 未指定用户，请补全）")}
        </div>
      )}
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="ah-field" style={{ flex: 1 }}>
          <label>{t("名称")}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
            onKeyDown={enterKey(() => submit())}
            placeholder={t("例：我的服务器")} />
        </div>
        <div className="ah-field" style={{ flex: 2 }}>
          <label>{t("地址（IP 或域名）")}</label>
          <input value={address} onChange={(e) => setAddress(e.target.value)}
            onBlur={() => { if (!name.trim() && address.trim()) setName(address.trim()); }}
            placeholder={t("例：192.168.1.10 或 server.example.com")} style={{ minWidth: 0 }} />
        </div>
        <div className="ah-field" style={{ width: 76 }}>
          <label>{t("端口")}</label>
          <input value={port} onChange={(e) => setPort(e.target.value)}
            onKeyDown={enterKey(() => submit())} />
        </div>
      </div>
      <div className="row" style={{ marginTop: 6, alignItems: "flex-end" }}>
        <div className="ah-field" style={{ flex: 1 }}>
          <label>{t("用户名")}</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t("例：ops 或 root")}
            onKeyDown={enterKey(() => submit())} />
        </div>
        <div className="ah-field" style={{ flex: 1 }}>
          <label>{t("认证方式")}</label>
          <select value={authMode} disabled={editing} onChange={(e) => { setErr(null); setAuthMode(e.target.value as "password" | "key" | "agent"); }}>
            <option value="password">{t("密码登录")}</option>
            <option value="key">{t("私钥登录")}</option>
            <option value="agent">SSH Agent</option>
          </select>
        </div>
      </div>
      {/* 凭据紧跟认证方式（用户反馈三轮：密码原来排在编码/标签之后太靠下）——
          字段顺序 = 填写动线：连接信息 → 认证凭据 → 编码/标签等次要项 */}
      {editing ? (
        <>
          {editHost?.auth_type === "Password" ? (
            <>
              <div className="ah-field" style={{ marginTop: 6 }}>
                <label>{t("更换密码（留空保持不变）")}</label>
                <input type="password" placeholder={t("输入新密码即更换（用当前主密钥重新加密）")} value={password}
                  onChange={(e) => setPassword(e.target.value)} onKeyDown={enterKey(() => submit())} />
              </div>
              <div className="dim" style={{ marginTop: 4 }}>{t("密码留空保持不变。")}</div>
            </>
          ) : (
            <div className="dim" style={{ marginTop: 6 }}>{t("认证凭据保持不变（{0}）。如需更换凭据，删除该主机后重新添加。", authLabel)}</div>
          )}
          {/* T34：信任可查证——编辑主机时出示 TOFU 信任状态与指纹原文 */}
          {editHost?.fingerprint ? (
            <div className="trust-row" style={{ marginTop: 6 }}>
              <span className="ok">✓ {t("主机指纹已信任（首次连接时确认）")}</span>
              <span className="mono fp">{editHost.fingerprint}</span>
            </div>
          ) : (
            <div className="dim" style={{ marginTop: 4 }}>{t("主机指纹尚未建立——首次连接时会出示并要求确认。")}</div>
          )}
        </>
      ) : authMode === "password" ? (
        <div className="ah-field" style={{ marginTop: 6 }}>
          <label>{t("密码")}</label>
          <input type="password" placeholder={t("密码")} value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={enterKey(() => submit())} />
        </div>
      ) : authMode === "agent" ? (
        <div className="dim" style={{ marginTop: 6 }}>{t("连接时由本机 ssh-agent 签名（需已 ssh-add），私钥不出 agent。Windows 需 OpenSSH Authentication Agent 服务在运行。")}</div>
      ) : (
        <>
          {/* R21（§265 已有密钥）：绑定凭据库既有凭据——取消表单后未绑定的凭据在此回收 */}
          {knownIdentities.length > 0 && !identity && (
            <div className="ah-field" style={{ marginTop: 6 }}>
              <label>{t("已有密钥（凭据库）")}</label>
              <select value={pickedIdentity}
                onChange={(e) => { setErr(null); setPickedIdentity(e.target.value); }}>
                <option value="">{t("新密钥（下方生成 / 导入）")}</option>
                {knownIdentities.map((k) => (
                  <option key={k.id} value={k.id}>{k.label} · {k.fingerprint.slice(0, 19)}…</option>
                ))}
              </select>
            </div>
          )}
          {!pickedIdentity && (identity ? (
            <>
              <div className="trust-row" style={{ marginTop: 6 }}>
                <span className="ok">✓ {t("密钥已加密存入凭据库（{0}）", identity.label)}</span>
                <span className="mono fp">{t("指纹")}　{identity.fingerprint}</span>
              </div>
              <div className="dim" style={{ marginTop: 4 }}>{t("保存后以此密钥登录；指纹用于核对凭据库里存的是哪把钥匙。")}</div>
              <button className="ghost" style={{ marginTop: 6 }} disabled={busy} onClick={() => setIdentity(null)}>
                {t("更换密钥（重新粘贴 / 从文件导入 / 生成）")}
              </button>
            </>
          ) : (
            <>
              <div className="row" style={{ marginTop: 6, alignItems: "center" }}>
                <label className="file-btn">
                  {t("从文件导入…")}
                  <input type="file" style={{ display: "none" }} accept=".pem,.key,id_ed25519,id_rsa,id_ecdsa"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      const r = new FileReader();
                      r.onload = () => setPem(String(r.result ?? ""));
                      r.readAsText(f);
                      e.target.value = ""; // 允许同一文件二次选择仍触发 onChange
                    }} />
                </label>
                <button className="ghost" disabled={busy} onClick={genKey}>{t("生成新密钥（ed25519）")}</button>
              </div>
              <textarea placeholder={`${t("-----BEGIN OPENSSH PRIVATE KEY-----")}\n${t("粘贴私钥内容，或点「从文件导入…」")}`} value={pem}
                onChange={(e) => setPem(e.target.value)} rows={4} style={{ marginTop: 6, width: "100%" }} />
              <div className="row" style={{ marginTop: 6, alignItems: "center" }}>
                <input type="password" placeholder={t("私钥口令（无可留空）")} value={passphrase} style={{ flex: 1 }}
                  onChange={(e) => setPassphrase(e.target.value)} onKeyDown={enterKey(importPem)} />
                <button disabled={busy} onClick={importPem}>{busy ? t("处理中…") : t("导入并确认指纹")}</button>
              </div>
            </>
          ))}
        </>
      )}
      {/* T38-PV：220px 侧栏里三个字段挤一行会把下拉压到 55px（选中值只剩「密」「UT」），
          编码独占一行让选项说明全文可读 */}
      <div className="ah-field" style={{ marginTop: 6 }}>
        <label>{t("远端编码（老设备中文乱码时选 GBK）")}</label>
        <select value={charset} onChange={(e) => setCharset(e.target.value as "utf-8" | "gbk")}>
          <option value="utf-8">{t("UTF-8（默认）")}</option>
          <option value="gbk">{t("GBK（中文 Windows / 老旧设备）")}</option>
        </select>
      </div>
      {/* ProxyJump：跳板机（可选）——经跳板转发连接目标；跳板自身的凭据/指纹
          确认沿用其主机条目（连接时会先出示跳板的指纹卡，再出示目标的） */}
      <div className="ah-field" style={{ marginTop: 6 }}>
        <label>{t("跳板机（可选，经其转发连接）")}</label>
        <select value={jumpId} data-testid="jump-select"
          onChange={(e) => { setErr(null); setJumpId(e.target.value); }}>
          <option value="">{t("直连（不经跳板）")}</option>
          {jumpOptions.map((h) => (
            <option key={h.id} value={h.id}>{t("{0}（{1}@{2}）", h.name, h.username, h.address)}</option>
          ))}
        </select>
      </div>
      {/* tmux 联动：启动命令——高级用户的一句话原语（tmux new -A 一条命令同时
          覆盖「有就 attach、没有就新建」）；不做 tmux 专属开关，不替用户做决定 */}
      {editHost?.id !== "local" && (
        <div className="ah-field" style={{ marginTop: 6 }}>
          <label>{t("连接后执行的命令（可选，如 tmux new -A -s work）")}</label>
          <input value={startupCmd} data-testid="startup-cmd-input" spellCheck={false}
            onChange={(e) => setStartupCmd(e.target.value)}
            placeholder="tmux new -A -s work"
            onKeyDown={enterKey(() => submit())} />
        </div>
      )}
      {/* R20：标签（逗号分隔）——主机卡徽章显示，搜索与标签 chip 筛选可命中 */}
      <div className="ah-field" style={{ marginTop: 6 }}>
        <label>{t("标签（可选，逗号分隔，如：生产, 成都）")}</label>
        <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)}
          placeholder={t("例：生产, 数据库")} onKeyDown={enterKey(() => submit())} />
      </div>
      {err && <div className="err" style={{ marginTop: 6 }}>✕ {err}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        {editing ? (
          <button disabled={busy} onClick={() => submit()}>{busy ? t("保存中…") : t("保存修改")}</button>
        ) : (
          <>
            <button disabled={busy} onClick={() => submit()}>{busy ? t("保存中…") : t("保存并连接")}</button>
            <button className="ghost" disabled={busy} onClick={() => submit(false)}
              title={t("只保存配置不连接——批量录入主机时用")}>{t("仅保存")}</button>
          </>
        )}
        {onCancel && <button className="ghost" onClick={onCancel}>{t("取消")}</button>}
        <span className="dim">{t("凭据加密存入本机凭据库，不会明文落盘。")}</span>
      </div>
    </div>
  );
}
