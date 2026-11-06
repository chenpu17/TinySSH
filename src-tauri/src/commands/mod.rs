//! Tauri command 实现（启动装配仍在 main.rs）。
//!
//! 按域拆分：主机/会话/tmux/传输/设置/转发/终端/简报/审批/记录/安全/
//! 基准/协作/原生/Agent。共享导入放在这里，子模块以 `use super::*;` 引入。

use crate::wire::{ApiState, CmdResult, WireError};
use crate::{dirs_or_home, human, TerminalInput};
use core_session::SessionManager;
use session_api::*;
use std::sync::Arc;
use tauri::Emitter;

mod agent;
mod approvals;
mod bench;
mod brief;
mod collab;
mod forwards;
mod hosts;
mod native;
mod records;
mod security;
mod sessions;
mod settings;
mod terminal;
mod tmux;
mod transfers;

pub(crate) use agent::*;
pub(crate) use approvals::*;
pub(crate) use bench::*;
pub(crate) use brief::*;
pub(crate) use collab::*;
pub(crate) use forwards::*;
pub(crate) use hosts::*;
pub(crate) use native::*;
pub(crate) use records::*;
pub(crate) use security::*;
pub(crate) use sessions::*;
pub(crate) use settings::*;
pub(crate) use terminal::*;
pub(crate) use tmux::*;
pub(crate) use transfers::*;
