import { useEffect, useState } from "react";
import { invoke } from "../adapter/bridge";
import type { SshConfigPreview, SshImportOutcome } from "../adapter/wire";
import { friendlyError } from "../app-data";

// ~/.ssh/config 导入面板（C7/R22）：分级诊断列（阻断/警告）+ 默认只勾可直接导入
// （DF7.5 无 User 不勾）+ 已导入条目显式覆盖 + 不可直接导入条目转手工表单（DF7.4）。
export function SshConfigImportPanel({ onDone, onClose, onManual }: {
  onDone: () => void; onClose: () => void; onManual: (e: SshConfigPreview) => void;
}) {
  const [entries, setEntries] = useState<SshConfigPreview[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [outcomes, setOutcomes] = useState<SshImportOutcome[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    invoke("ssh_config_preview", { path: null })
      .then((es) => {
        setEntries(es);
        // 默认勾选 = 可直接导入且未导入过（阻断项与重复项不进默认集）
        setChecked(new Set(es.filter((e) => e.directly_importable && !e.already_imported).map((e) => e.name)));
      })
      .catch((e) => setErr(friendlyError(e)));
  }, []);

  const importChecked = async () => {
    setErr(null);
    if (checked.size === 0) { setErr("先勾选要导入的条目"); return; }
    setBusy(true);
    try {
      // 显式覆盖（DF7.3）：勾中了已在主机列表的条目 → 整批 overwrite，重复者以既有 id 覆盖
      const overwrite = entries?.some((e) => e.already_imported && checked.has(e.name)) ?? false;
      const outs = await invoke("ssh_config_import", {
        path: null, names: [...checked], overwrite,
      });
      setOutcomes(outs);
      const okCount = outs.filter((o) => o.host_id).length;
      if (okCount > 0) onDone();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const unsupportedNote = (e: SshConfigPreview) => (
    <>
      {e.unsupported.filter((u) => u.level === "Blocking").map((u) => (
        <div key={u.directive} className="err" style={{ fontSize: 11 }}>
          ✕ 阻断：{u.directive}（第 {u.line} 行）——不支持代理/证书，需手工处理
        </div>
      ))}
      {e.unsupported.filter((u) => u.level === "Warning").map((u) => (
        <div key={u.directive} className="dim" style={{ fontSize: 11 }}>
          · 未同步：{u.directive}（第 {u.line} 行，不影响连通）
        </div>
      ))}
      {!e.user_specified && (
        <div className="err" style={{ fontSize: 11 }}>✕ 未指定登录用户——补全后再导入</div>
      )}
    </>
  );

  return (
    <div className="card add-host">
      <div className="row">
        <strong>从 ~/.ssh/config 导入</strong>
        <span style={{ flex: 1 }} />
        <button className="ghost" onClick={onClose}>收起</button>
      </div>
      {err && <div className="err" style={{ marginTop: 6 }}>✕ {err}</div>}
      {entries === null && !err && <div className="dim" style={{ marginTop: 6 }}>读取中…</div>}
      {entries !== null && entries.length === 0 && (
        <div className="dim" style={{ marginTop: 6 }}>~/.ssh/config 里没有可导入的条目（通配符与 Match 块会跳过）。</div>
      )}
      {entries !== null && entries.length > 0 && (
        <div style={{ marginTop: 6 }}>
          {entries.map((e) => {
            const outcome = outcomes?.find((o) => o.name === e.name);
            const imported = outcome?.host_id != null;
            const blocked = !e.directly_importable;
            const skip = outcome?.skipped_reason ?? null;
            return (
              <label key={e.name} className="sshcfg-row">
                <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
                  <input
                    type="checkbox"
                    style={{ width: "auto", marginTop: 2 }}
                    disabled={blocked || imported}
                    checked={checked.has(e.name) || imported}
                    onChange={(ev) => {
                      const next = new Set(checked);
                      if (ev.target.checked) next.add(e.name); else next.delete(e.name);
                      setChecked(next);
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <div>
                      {e.name}
                      {e.already_imported && !imported && <span className="dim"> · 已在主机列表（勾选即覆盖）</span>}
                      {imported && <span className="ok"> ✓ 已导入</span>}
                    </div>
                    <div className="dim mono" style={{ fontSize: 11 }}>
                      ~/.ssh/config:{e.source_line} · {e.user_specified ? `${e.username}@${e.address}:${e.port}` : `@${e.address}:${e.port}`} · {e.has_identity ? "密钥" : "Agent"}
                    </div>
                    {!imported && unsupportedNote(e)}
                    {skip === "Duplicate" && <div className="dim" style={{ fontSize: 11 }}>↷ 跳过：重复（同名或同地址+端口+用户）。收起面板重新打开后勾选可覆盖</div>}
                    {skip === "Blocked" && <div className="err" style={{ fontSize: 11 }}>↷ 跳过：含阻断指令</div>}
                    {outcome && outcome.error && <div className="err" style={{ fontSize: 11 }}>✕ {outcome.error}</div>}
                  </span>
                  {blocked && !imported && (
                    <button className="ghost" style={{ width: "auto", fontSize: 11, flexShrink: 0 }}
                      onClick={(ev) => { ev.preventDefault(); onManual(e); }}>
                      转手工表单
                    </button>
                  )}
                </div>
              </label>
            );
          })}
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button disabled={busy || entries === null} onClick={importChecked}>
          {busy ? "导入中…" : "导入选中"}
        </button>
        <span className="dim">带 IdentityFile 的条目会读私钥入凭据库；没有的走本机 ssh-agent。勾选「已在主机列表」条目=显式覆盖（对该批内命中的重复项一并生效）。</span>
      </div>
    </div>
  );
}
