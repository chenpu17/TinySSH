//! 命令过桥的公共类型：`ApiState` 别名、结构化 `WireError` 与 `CmdResult`。
//!
//! 从 main.rs 抽出（第二波结构拆分）。错误信封的 kind/detail 单点映射仍在
//! session-api 的 `Error::wire_parts`，这里只做应用壳侧封装。

use crate::AppState;
use tauri::State;

pub(crate) type ApiState<'a> = State<'a, AppState>;

/// wire 错误信封（R10 统一错误映射）：不再把 session-api::Error 拍平成中文字符串，
/// 而是结构化 `{ kind, message, detail }` 过桥。kind 为稳定 snake_case 契约值——
/// 现有 16 变体逐一映射 + 前向预留 r03-contracts §11 ADR-15 的 11 个新 kind
/// （后端未实现前不会出现，FE parser 按开放集合接收）。message 保留 thiserror
/// 人话文案，UI 现有 friendlyError 行为不变。
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct WireError {
    pub(crate) kind: String,
    pub(crate) message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) detail: Option<serde_json::Value>,
}

impl WireError {
    pub(crate) fn simple(kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.to_string(),
            message: message.into(),
            detail: None,
        }
    }
}

impl From<String> for WireError {
    fn from(s: String) -> Self {
        Self::simple("invalid_input", s)
    }
}

impl From<std::io::Error> for WireError {
    fn from(e: std::io::Error) -> Self {
        Self::simple("io", e.to_string())
    }
}

impl From<session_api::Error> for WireError {
    fn from(e: session_api::Error) -> Self {
        // kind/detail 单点映射归核心 Error::wire_parts（C1 三端一致，R19 起）；
        // 这里只补 message
        let (kind, detail) = e.wire_parts();
        Self {
            kind: kind.to_string(),
            message: e.to_string(),
            detail,
        }
    }
}

pub(crate) type CmdResult<T> = std::result::Result<T, WireError>;
