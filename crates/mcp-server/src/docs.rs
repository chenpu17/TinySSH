//! 内置接入文档（rev-r46）：`GET /`（人读 HTML）与 `GET /integration.md`（Agent 取用
//! Markdown）。目标：人类把一个 URL 扔给 Agent，Agent 取回即可自助完成接入——端点、
//! 认证、行为约定、错误类别、工具目录全在其中。工具目录从 ToolRouter **实时枚举**，
//! 与服务端永远一致（加工具不用改文档）。页面本身不含任何机密（Token 由人类单独
//! 签发粘贴），因此不做认证；但仅绑定 127.0.0.1。

use rmcp::model::Tool;
use std::fmt::Write as _;

/// 文档用的工具条目（从 ToolRouter 归集）。
pub struct ToolDoc {
    pub name: String,
    pub description: String,
    /// annotations 摘要（如「只读」「破坏性」），无则空
    pub hints: Vec<&'static str>,
    /// inputSchema 的 pretty JSON
    pub schema: String,
}

pub fn collect_tools<'a>(tools: impl Iterator<Item = &'a Tool>) -> Vec<ToolDoc> {
    let mut out: Vec<ToolDoc> = tools
        .map(|t| {
            let hints = {
                let mut v = Vec::new();
                if let Some(a) = &t.annotations {
                    if a.read_only_hint == Some(true) {
                        v.push("只读");
                    }
                    if a.destructive_hint == Some(true) {
                        v.push("破坏性");
                    }
                }
                v
            };
            ToolDoc {
                name: t.name.to_string(),
                description: t
                    .description
                    .as_ref()
                    .map(|c| c.to_string())
                    .unwrap_or_default(),
                hints,
                schema: serde_json::to_string_pretty(t.input_schema.as_ref())
                    .unwrap_or_default(),
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 错误类别表（与 lib.rs error_kind 同源；加类别时同步这里）。
const ERROR_KINDS: &[(&str, &str)] = &[
    ("approval_denied", "人类拒绝了审批"),
    ("approval_timeout", "审批挂起超时（120s 无人决策）"),
    ("dangerous_pattern", "命中危险形态，强制报审或被拒"),
    ("control_taken_by_human", "人类已接管会话——先交还或另建会话"),
    ("voided_by_handback", "接管/交还使旧请求作废，核实现场后重提"),
    ("reconfirming_pending", "会话处于重确认期，普通动作被拒"),
    ("session_not_found", "会话不存在（可能已关闭）"),
    ("session_closed", "会话已关闭"),
    ("auth_failed / connect_failed / host_key_rejected", "连接侧失败"),
    ("exec_timeout", "命令超时（自审批放行起算）"),
    ("shell_integration_unavailable", "shell 集成不可用——改用 fresh 模式"),
    ("cancelled", "请求被取消"),
    ("queue_busy", "执行队列忙，稍后重试"),
    ("invalid_actor / invalid_input", "身份/参数问题——修正调用"),
    ("conflict_detected", "传输目标已存在（缺省 fail）；含目标 stat"),
    ("replace_unsupported", "目标端不支持覆盖式发布"),
    ("forward_listen_failed", "端口转发监听失败（字段级原因在 detail）"),
    ("collab_disabled", "协作已被人类停用，Agent 动作一律被拒"),
];

fn intro_sections(base: &str) -> String {
    format!(
        "## 端点与认证\n\
         - **MCP 端点（streamable HTTP）**：`{base}/mcp`\n\
         - **协议版本**：2025-06-18、2025-03-26\n\
         - **认证**：`Authorization: Bearer <TOKEN>`。Token 由人类签发（每 Agent 一枚，**仅展示一次**）：\n\
         `tinyssh agent create <id> <名称>`；吊销：`tinyssh agent revoke <id>`。\n\
         - 端点只绑定 127.0.0.1（被占自动递增端口，以应用「设置 → Agent 接入」展示的实际地址为准）；\n\
         所有操作逐条进入审计，Agent 可用 `query_audit` 自助核对。\n",
        base = base
    )
}

fn howto_sections(base: &str) -> String {
    format!(
        "## 接入方式 A：streamable HTTP 直连（推荐）\n\
         ```json\n\
         {{\n  \"mcpServers\": {{\n    \"tinyssh\": {{\n      \"type\": \"http\",\n      \"url\": \"{base}/mcp\",\n      \"headers\": {{ \"Authorization\": \"Bearer <TOKEN>\" }}\n    }}\n  }}\n}}\n\
         ```\n\
         Claude Code 示例：`claude mcp add --transport http tinyssh {base}/mcp --header \"Authorization: Bearer <TOKEN>\"`\n\n\
         ## 接入方式 B：stdio shim（客户端只支持 stdio 时）\n\
         命令 `tinyssh-mcp`（应用自带；对 Agent 说 stdio，对应用说 streamable HTTP，\n\
         自动回传会话 id、透传 progress 心跳）：\n\
         ```json\n\
         {{\n  \"mcpServers\": {{\n    \"tinyssh\": {{\n      \"command\": \"tinyssh-mcp\",\n      \"env\": {{ \"TINYSSH_TOKEN\": \"<TOKEN>\", \"TINYSSH_MCP_URL\": \"{base}/mcp\" }}\n    }}\n  }}\n}}\n\
         ```\n",
        base = base
    )
}

fn conduct_sections() -> String {
    "## 使用须知（行为约定）\n\
     1. **控制权**：会话默认由人类掌控。人类点「交给 Agent…」后才能 exec/send_keys\n\
     （否则返回 `control_taken_by_human`）。动手前先 `list_sessions` + `get_session_brief`。\n\
     2. **交接先读简报**：`get_session_brief` 的 `goal` 是人类写下的委托意图；接管后先读它，\n\
     完成或受阻时更新它（经人类）。\n\
     3. **审批**：危险命令与**所有** Agent 文件传输必经人类逐条审批；调用会同步挂起\n\
     （最长 120s，期间发送 progress 心跳）。结果以结构化错误返回\n\
     （`approval_denied` / `approval_timeout` / `dangerous_pattern`）。\n\
     4. **exec**：默认 shell 模式（cwd/env 随现场延续）；需要真实退出码用 `mode: \"fresh\"`。\n\
     stdout/stderr 超过 `output_cap`（缺省 128 KiB，可调）截断并标 `truncated`。\n\
     5. **错误是结构化的**：`{ \"error\", \"kind\", \"detail\" }`——按 `kind` 分支处理，不要解析自然语言。\n\
     6. **传输冲突**：upload/download 缺省 fail（目标已存在 → `conflict_detected` + 目标 stat）；\n\
     显式 `collision: \"skip\"|\"overwrite\"` 可改（overwrite 一样要审批）。任务先返回 transfer_id，\n\
     用 `transfer_list` 对账；失败用 `retry_transfer`，卡住用 `cancel_transfer`。\n\
     7. **端口转发**：forward_start/stop 逐段审批；`forwards_list` 查看监听状态。\n\n\
     ## 错误类别（kind）\n"
        .to_string()
        + &ERROR_KINDS
            .iter()
            .map(|(k, v)| format!("- `{k}`：{v}\n"))
            .collect::<String>()
}

fn security_sections() -> String {
    "## 安全边界\n\
     - Token 即操作权：不要写入代码库/日志/截图；怀疑泄露立即让人类 `revoke`。\n\
     - 你的每个动作（含放行规则命中）都在审计链上；人类可实时看到终端画面。\n\
     - 审批是人类的最后防线：命令要一事一议，不要拼接批量操作来「打包过审」。\n"
        .to_string()
}

fn tools_section(tools: &[ToolDoc], md: bool) -> String {
    let mut s = String::from("## 工具目录（自动生成，与应用运行版本一致）\n");
    for t in tools {
        let _ = writeln!(s, "\n### `{}`{}", t.name, {
            let h = t.hints.join("、");
            if h.is_empty() {
                String::new()
            } else {
                format!("（{h}）")
            }
        });
        let _ = writeln!(s, "{}", t.description);
        if md {
            let _ = writeln!(s, "\n```json\n{}\n```", t.schema);
        }
    }
    s
}

pub fn integration_markdown(base: &str, tools: &[ToolDoc]) -> String {
    let mut s = String::from(
        "# TinySSH Agent 接入指南\n\n\
         > 本页由 TinySSH 应用在本机实时生成（端点、工具目录与应用运行态一致）。\n\
         > 把本 URL 原样扔给任何能取网页的 Agent，按下文即可自助完成 MCP 接入。\n\n",
    );
    s.push_str(&intro_sections(base));
    s.push('\n');
    s.push_str(&howto_sections(base));
    s.push('\n');
    s.push_str(&conduct_sections());
    s.push('\n');
    s.push_str(&tools_section(tools, true));
    s.push('\n');
    s.push_str(&security_sections());
    s
}

// ---- HTML（人读版；零外部依赖，全部内联样式）----

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
    .replace('"', "&quot;")
}

pub fn index_html(base: &str, tools: &[ToolDoc]) -> String {
    let mut body = String::new();
    let _ = writeln!(
        body,
        "<h1>TinySSH <span class=dim>Agent 接入</span></h1>\
         <p class=dim>本页由应用在本机实时生成。把下方「接入文档」链接原样发给 Agent 即可自助对接；Token 见设置页（仅展示一次）。</p>"
    );
    let _ = writeln!(
        body,
        "<div class=card><h2>一键给 Agent</h2>\
         <p>接入文档（Markdown，含端点/认证/行为约定/工具目录）：</p>\
         <pre>{base}/integration.md</pre>\
         <p class=dim>MCP 端点：<code>{base}/mcp</code></p></div>"
    );
    let _ = writeln!(
        body,
        "<div class=card><h2>端点与认证</h2><pre>{}</pre></div>",
        esc(intro_sections(base).trim())
    );
    let _ = writeln!(
        body,
        "<div class=card><h2>接入方式</h2><pre>{}</pre></div>",
        esc(howto_sections(base).trim())
    );
    let _ = writeln!(
        body,
        "<div class=card><h2>使用须知与错误类别</h2><pre>{}</pre></div>",
        esc(conduct_sections().trim())
    );
    let _ = writeln!(body, "<div class=card><h2>工具目录（{} 个，自动生成）</h2>", tools.len());
    for t in tools {
        let h = t.hints.join("、");
        let _ = writeln!(
            body,
            "<details><summary><code>{}</code> {}</summary><p>{}</p>{}</details>",
            esc(&t.name),
            if h.is_empty() {
                String::new()
            } else {
                format!("<span class=tag>{}</span>", esc(&h))
            },
            esc(&t.description),
            if t.schema.is_empty() {
                String::new()
            } else {
                format!("<pre>{}</pre>", esc(&t.schema))
            }
        );
    }
    let _ = writeln!(body, "</div>");
    let _ = writeln!(
        body,
        "<div class=card><h2>安全边界</h2><pre>{}</pre></div>",
        esc(security_sections().trim())
    );

    format!(
        "<!doctype html><html lang=zh-CN><meta charset=utf-8>\
         <meta name=viewport content=\"width=device-width,initial-scale=1\">\
         <title>TinySSH Agent 接入</title><style>\
         body{{font-family:system-ui,'Segoe UI',sans-serif;max-width:880px;margin:24px auto;padding:0 16px;\
         color:#e6e6e6;background:#14161a;line-height:1.65}}\
         h1{{font-size:22px}}h2{{font-size:15px;margin:0 0 8px;color:#9cc4ff}}\
         .dim{{color:#8a8f98;font-weight:400}}\
         .card{{background:#1b1e24;border:1px solid #2a2f37;border-radius:10px;padding:14px 18px;margin:14px 0}}\
         pre{{background:#101216;border:1px solid #2a2f37;border-radius:8px;padding:10px 12px;\
         overflow:auto;font-size:12px;user-select:all;white-space:pre-wrap}}\
         code{{background:#101216;padding:1px 5px;border-radius:4px;font-size:12px}}\
         .tag{{background:#23303f;color:#9cc4ff;border-radius:999px;padding:1px 8px;font-size:11px;margin-left:6px}}\
         details{{border-bottom:1px solid #2a2f37;padding:6px 0}}\
         summary{{cursor:pointer}}\
         </style>{body}</html>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str, desc: &str, schema: &str) -> Tool {
        let obj: rmcp::model::JsonObject = serde_json::from_str(schema).unwrap();
        Tool::new(name.to_string(), desc.to_string(), obj)
    }

    #[test]
    fn markdown_contains_endpoint_and_tools() {
        let tools = collect_tools(std::iter::once(&tool(
            "exec",
            "在共享会话中执行命令",
            r#"{"type":"object","properties":{"command":{"type":"string"}}}"#,
        )));
        let md = integration_markdown("http://127.0.0.1:8722", &tools);
        assert!(md.contains("http://127.0.0.1:8722/mcp"));
        assert!(md.contains("TINYSSH_MCP_URL"));
        assert!(md.contains("`exec`"));
        assert!(md.contains("approval_denied"));
        assert!(md.contains("Bearer <TOKEN>"));
        assert!(md.contains("control_taken_by_human"));
        assert!(md.contains("\"command\""));
    }

    #[test]
    fn html_escapes_and_contains_tools() {
        let tools = collect_tools(std::iter::once(&tool(
            "exec",
            "exec <cmd> & \"quote\"",
            r#"{"type":"object"}"#,
        )));
        let html = index_html("http://127.0.0.1:9000", &tools);
        assert!(html.contains("http://127.0.0.1:9000/integration.md"));
        assert!(html.contains("exec &lt;cmd&gt; &amp; &quot;quote&quot;"));
        assert!(!html.contains("<script"));
    }

    #[test]
    fn collect_tools_sorts_and_annotates() {
        let mut t = tool("b_tool", "b", r#"{"type":"object"}"#);
        t.annotations = Some(rmcp::model::ToolAnnotations::from_raw(
            None, Some(true), None, None, None,
        ));
        let a = tool("a_tool", "a", r#"{"type":"object"}"#);
        let docs = collect_tools([&t, &a].into_iter());
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0].name, "a_tool");
        assert_eq!(docs[1].name, "b_tool");
        assert_eq!(docs[1].hints, vec!["只读"]);
    }
}
