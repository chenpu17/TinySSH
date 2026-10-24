# TinySSH

[![ci](https://github.com/chenpu17/TinySSH/actions/workflows/ci.yml/badge.svg)](https://github.com/chenpu17/TinySSH/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A human–AI collaborative terminal: an SSH client, a first-class local terminal, and an embedded AI agent in one desktop app. The agent kernel is the sister project [TinyAgent](https://github.com/chenpu17/TinyAgent) — TinySSH is its first full host, wiring it to real sessions behind approvals, audit, and explicit control hand-off.

中文文档见 [README.zh-CN.md](README.zh-CN.md)。

## Why

If you operate a few to a dozen servers — developing, deploying, troubleshooting — you want connections that just work, a terminal that feels right, file operations when you need them, and occasionally an agent to hand tasks to. Existing tools give you either a good terminal or a scripted AI loop; TinySSH refuses to choose, and refuses to hand your keys to an unattended loop:

- **One approval chain for everyone.** Agent commands walk the same dangerous-pattern gate as a human pasting `rm -rf /` into the terminal. Transfers are always approved, one by one.
- **Explicit control hand-off.** The agent only drives a session after you delegate; you can take over with one click at any time, and everything either of you did is in the record.
- **Autonomy is opt-in and visible.** A per-session autonomy switch skips per-item approvals but keeps hard blocks on dangerous patterns and transfers, banners its state, and has a kill switch. It lives in memory only — a restart revokes it.
- **Everything is recorded.** Structured execution records (including refusals) are encrypted at rest, kept for 30 days, queryable by you *and* by the agent itself.

## Highlights

- **SSH + local terminal, equal citizens** — the built-in "This machine" entry is pinned, un-deletable, auto-opens a terminal at startup; local sessions get the same tabs, splits, command blocks, search, and file browsing as remote ones. Default shell is selectable (PowerShell / PowerShell 7 / Git Bash / cmd / WSL auto-detected; shells without preexec hooks are honestly marked "no command blocks").
- **Terminal quality** — Unicode 11 width table (CJK/emoji don't misalign), optional ligatures, sixel & iTerm2 inline images, OSC 52 clipboard with an ask/allow/deny policy, OSC 9 notifications, clickable file paths, broadcast input across sessions (iTerm-style), regex output triggers with notification or approval-gated key sequences.
- **Command blocks** — shells with OSC 133/7 integration turn every command into a block with exit code, duration, and captured output (rendered, ANSI-stripped, tail-capped). Blocks can be copied, re-run (same confirmation chain as paste), located in the scrollback, and the agent reads them through the same API.
- **Session restore** — on clean exit every session gets an encrypted snapshot (scrollback tail + viewport + cursor + modes); next start can rebuild and replay the screen. Reconnects go through the full connection flow — TOFU and 2FA gates included, nothing auto-dials.
- **Embedded agent (per session)** — chat with markdown, Mermaid, KaTeX; reasoning blocks collapse; tool calls appear as inline approval cards. Eight tools (`exec`, `read_blocks`, `read_screen`, `wait_output`, `upload`, `download`, `transfer_status`, `send_keys`) executed through the same session actor as everything else.
- **Fleet orchestration** — a third view dispatches self-contained tasks to per-session agents in parallel and collects results; the dispatcher never touches machines itself, and each target keeps its own approvals and dangerous-command gates.
- **Monitoring** — a per-session resource bar plus a full-screen multi-server dashboard (CPU/mem gauges, disk/net history; Ascend NPU per-chip health/power/temp/utilization/HBM). Sampling is opt-in, per-category, and survives closing the dashboard. The local machine is monitored through native APIs (kernel32/iphlpapi on Windows, /proc on unix) on the same parse path as remote hosts.
- **SFTP + transfer queue** — upload/download drawer with cancel, retry, re-verify for unknown outcomes, reveal-in-explorer and open-with-default-app on completion.
- **Built-in MCP server** — enable it and any MCP-capable agent gets 23 tools (sessions, exec, transfers, forwards, records), subscribable live resources, and guided prompts on `127.0.0.1` (default 8722). Token onboarding via `tinyssh agent create`, HTTP or stdio shim.
- **Single portable exe** on Windows — statically linked CRT, SQLite at rest in an encrypted vault (hosts, credentials, API keys, settings).

## Getting started

Prerequisites: Rust ≥ 1.86, Node ≥ 20.

```bash
# Frontend demo mode — runs in a plain browser, no Rust needed
cd ui && npm ci && npm run dev      # http://localhost:5183

# UI test suite (47 specs / 769 checks; needs a Chrome/Edge binary)
TINYSSH_UI_CHROME="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm test

# Desktop app (Tauri v2; dev shell expects the ui dev server above)
cargo run -p tinyssh-app

# Release build — custom-protocol embeds the frontend; .cargo/config.toml pins
# static CRT so the exe runs without VC++ Redist
cargo build -p tinyssh-app --release --features custom-protocol

# e2e (needs a docker sshd container: scripts/dev-sshd.sh)
TINYSSH_E2E_SSHD=1 cargo test --workspace
```

Windows notes: high-parallel `cargo test --workspace` can exhaust the page file — use `-j 4`. The first platform is Windows; the ubuntu CI job covers everything except the Tauri shell crate, which is built and tested in the windows CI job.

## Layout

| Crate | What it is |
|---|---|
| `src-tauri` (`tinyssh-app`) | Tauri shell: window, commands, app lifecycle |
| `crates/core-session` | `SessionManager`: sessions, approvals, records, monitoring, probes |
| `crates/session-api` | The `SessionApi` contract + wire types shared with the frontend |
| `crates/transport-ssh` / `crates/transport-pty` | russh channels; local PTY (portable-pty) |
| `crates/term-core` | Terminal semantics (alacritty_terminal) + tree-sitter helpers |
| `crates/approval` | Dangerous-pattern rules and the approval chain |
| `crates/audit` / `crates/records` | SQLite audit; structured execution records (XChaCha20-P1305, redaction) |
| `crates/vault` | Encrypted store: hosts, credentials, keys, KV |
| `crates/mcp-server` / `crates/shim` | rmcp endpoint (23 tools, resources, prompts); stdio→HTTP shim |
| `crates/agent-host` | Embedded agent: TinyAgent kernel + the 8 session tools |
| `crates/cli` (`tinyssh`) | Headless `serve` + `agent` onboarding |
| `crates/testbed` | e2e harness against a docker sshd |

The frontend lives in `ui/` (React + xterm.js, TypeScript, Playwright specs). A built-in demo domain mirrors the backend so the whole UI is testable in a browser.

## Documentation

Design docs are written in Chinese: [UX-R1 refactor design](docs/ux/ssh-client-ux-refactor.md), [delivery & acceptance matrix](docs/ux/ssh-client-ux-refactor-delivery.md), [PRD](docs/prd.md), [L0 system design](docs/architecture/l0-system-design.md), [L1 component design](docs/architecture/l1-component-design.md), [execution ledger](docs/ux/ux-r1-execution-status.md) (per-round status), [MCP validation & PV kit](docs/validation-plan.md).

## Status

v0.10.0. All suites green on the primary platform: Rust workspace tests, 47 UI specs / 769 checks, plus real-machine verification rounds recorded in the execution ledger. CI runs on every push (ubuntu: fmt/clippy/core tests/ui build; windows: full workspace).

## Sister project

[TinyAgent](https://github.com/chenpu17/TinyAgent) — a minimal single-binary agent kernel (agent loop, tools, providers) that also builds standalone with a CLI/TUI and Python/TypeScript bindings. TinySSH consumes it as a git dependency, pinned by revision.

## Contributing

PRs are welcome; CI must stay green (fmt, clippy, tests on both runners). Commit messages follow the existing style: a dense one-line Chinese summary. For architecture decisions, read L0/L1 first — cross-crate contract changes need an ADR entry there.

## License

Apache-2.0. Built on [russh](https://github.com/Eugeny/russh), [portable-pty](https://github.com/wez/portable-pty), [alacritty_terminal](https://github.com/alacritty/alacritty), [xterm.js](https://github.com/xtermjs/xterm.js), [Tauri](https://github.com/tauri-apps/tauri), [rmcp](https://github.com/modelcontextprotocol/rust-sdk), and [TinyAgent](https://github.com/chenpu17/TinyAgent).
