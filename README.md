# TinySSH

[![ci](https://github.com/chenpu17/TinySSH/actions/workflows/ci.yml/badge.svg)](https://github.com/chenpu17/TinySSH/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/chenpu17/TinySSH)](https://github.com/chenpu17/TinySSH/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**A human–AI collaborative terminal.** An SSH client, a first-class local terminal, and an embedded AI agent in one desktop app — Windows, macOS, Linux. The agent kernel is the sister project [TinyAgent](https://github.com/chenpu17/TinyAgent); TinySSH wires it to real sessions behind approvals, audit, and explicit control hand-off.

**English** · [中文](README.zh-CN.md)

Built for developers who juggle a few to a dozen servers: connections that just work, a terminal that feels right, files when you need them, and an agent you can hand tasks to — without handing over your keys.

## Why

- **One approval chain for everyone.** An agent command walks the same dangerous-pattern gate as a human pasting `rm -rf /`. Transfers are always approved, one by one.
- **Explicit control hand-off.** The agent only drives a session after you delegate; take over with one click anytime.
- **Autonomy is opt-in and visible.** A per-session switch skips per-item approvals but keeps hard blocks on dangerous patterns and transfers, banners its state, and has a kill switch. Memory-only — a restart revokes it.
- **Everything is recorded.** Encrypted execution records (including refusals), kept 30 days, queryable by you *and* the agent, on a two-layer swim-lane timeline.
- **Open source.** Apache-2.0, single portable binary, credentials in an encrypted vault.

| | TinySSH | Classic SSH (XShell, Termius…) | AI terminals (Warp…) |
|---|---|---|---|
| License | Apache-2.0 | usually proprietary | usually proprietary |
| Scope | SSH + local + files + monitoring | SSH-centric | local-first shell |
| Agent operates your servers | yes — approvals + audit + hand-off | no | rarely per-action approved |
| Extensibility | built-in MCP server (24 tools) | plugins | limited |

## Download

Prebuilt binaries on the [Releases page](https://github.com/chenpu17/TinySSH/releases/latest) (unsigned):

| Platform | Artifact |
|---|---|
| Windows 10/11 x64 | `TinySSH_<ver>_windows_x64_portable.exe` — single file, needs only the built-in WebView2 |
| macOS (Apple Silicon & Intel) | `TinySSH_<ver>_macos_<arch>.dmg` or `.app.zip` |
| Linux amd64 | `TinySSH_<ver>_linux_amd64.deb` (auto-deps) or `.tar.gz` (needs libwebkit2gtk-4.1) |

Each release also ships the `tinyssh` CLI and `SHA256SUMS.txt`. Windows is the primary validated platform; macOS Apple Silicon is validated on hardware; Intel macOS and Linux are CI-built and unit-tested.

### First launch (unsigned builds)

No code-signing certificate is behind these builds, so the OS warns on first launch. The app is fine — it needs a one-time approval:

- **macOS** — drag `TinySSH.app` into `/Applications`, then **right-click → Open → Open** (not double-click). Or System Settings → Privacy & Security → **Open Anyway**, or `xattr -cr /Applications/TinySSH.app`. A Keychain prompt may follow (the vault's master key lives there) — choose Allow.
- **Windows** — SmartScreen: **More info → Run anyway**.
- **Linux** — no quarantine; the `.deb` installs and the `.tar.gz` just unpacks.

## Features

- **SSH + local terminal, equal citizens** — a pinned "This machine" entry auto-opens at startup; local sessions get the same tabs, splits, command blocks, search, and file browsing as remote ones.
- **tmux, first-class** — attach remote sessions; open up to 6 side-by-side panels over one connection (one login, one 2FA); a live full-screen session wall; drag to arrange; crash-safe workspace memory with one-click restore.
- **Embedded AI agent** — per-session chat with markdown / Mermaid / KaTeX and inline approval cards; 8 SSH tools (`exec`, `read_screen`, `read_blocks`, `wait_output`, `upload`, `download`, `transfer_status`, `send_keys`); customizable prompts & skills.
- **Fleet orchestration** — dispatch self-contained tasks to per-session agents in parallel; the dispatcher never touches machines itself, and each target keeps its own approvals.
- **Command blocks** — OSC 133 shell integration turns every command into a block with exit code, duration, and output; copy, rerun, locate.
- **Broadcast input** — type once, send to many sessions (iTerm-style); paste and rerun never broadcast.
- **Output triggers** — regex rules fire a notification or an approval-gated key sequence; never silent auto-execution.
- **Monitoring** — a per-session resource bar plus a full-screen multi-server dashboard (CPU/mem/disk/net, Ascend NPU); opt-in sampling, local machine via native APIs.
- **SFTP + transfer queue** — cancel, retry, re-verify unknown outcomes, reveal-in-explorer / open on completion.
- **Themes & readability** — 17 palette families (light/dark) incl. Eye Care and E Ink; UI font scale 80–125%, two density levels, 13 terminal fonts; per-cell 4.5:1 contrast guard.
- **Terminal quality** — Unicode 11 widths (CJK/emoji aligned), sixel & iTerm2 inline images, OSC 52 clipboard policy, clickable file paths, macOS IME fixes.
- **Session restore** — encrypted snapshots on clean exit, replayed on next start through the full TOFU/2FA flow.
- **Built-in MCP server** — 24 tools, subscribable resources, and prompts on `127.0.0.1`; any MCP-capable agent plugs in (self-serve docs at `/integration.md`).
- **Bilingual UI** — English / 中文 (Simplified), switchable instantly without interrupting sessions.
- **Portable, private, self-updating** — single exe on Windows; credentials, keys, records, and snapshots encrypted in the vault; one-click signed auto-update on macOS/Windows (signing is opt-in for maintainers).

## Screenshots

Built-in browser demo mode — fake sessions, clearly labeled, same UI as the real app. Dark **Tokyo Night** (factory default).

| Terminal + host bar | Agent with inline approval |
|---|---|
| ![Terminal](docs/img/readme-terminal.png) | ![Agent](docs/img/readme-agent.png) |
| **tmux panels side by side** | **Multi-server monitoring (incl. NPU)** |
| ![tmux](docs/img/readme-tmux.png) | ![Monitoring](docs/img/readme-monitor.png) |
| **Fleet — one conversation, many hosts** | **Records — swim-lane audit timeline** |
| ![Fleet](docs/img/readme-fleet.png) | ![Records](docs/img/readme-records.png) |

## Build from source

Prerequisites: Rust ≥ 1.86, Node ≥ 22.

```bash
# Frontend demo — runs in a plain browser, no Rust needed
cd ui && npm ci && npm run dev      # http://localhost:5183
npm test                            # UI suite (headless Playwright)
npm run build                       # tsc + vite

# Desktop app (Tauri v2; expects the ui dev server above)
cargo run -p tinyssh-app
cargo test --workspace -j 4         # -j 4 avoids page-file exhaustion on Windows

# Release build (custom-protocol embeds the frontend; static CRT, no VC++ Redist)
cargo build -p tinyssh-app --release --features custom-protocol

# e2e (needs a docker sshd container: scripts/dev-sshd.sh)
TINYSSH_E2E_SSHD=1 cargo test --workspace
```

## Docs & contributing

Design docs are in Chinese: [L0 system design](docs/architecture/l0-system-design.md) · [L1 component design](docs/architecture/l1-component-design.md) · [PRD](docs/prd.md) · [UX-R1 refactor](docs/ux/ssh-client-ux-refactor.md) · [known issues](docs/known-issues.md).

PRs welcome — CI must stay green (fmt, clippy, tests on both runners). Commit messages: a dense one-line Chinese summary. For architecture decisions read L0/L1 first; cross-crate contract changes need an ADR. The embedded agent is [TinyAgent](https://github.com/chenpu17/TinyAgent), consumed as a git dependency pinned by revision.

## License

Apache-2.0. Built on [russh](https://github.com/Eugeny/russh), [portable-pty](https://github.com/wez/portable-pty), [alacritty_terminal](https://github.com/alacritty/alacritty), [xterm.js](https://github.com/xtermjs/xterm.js), [Tauri](https://github.com/tauri-apps/tauri), [rmcp](https://github.com/modelcontextprotocol/rust-sdk), and [TinyAgent](https://github.com/chenpu17/TinyAgent).