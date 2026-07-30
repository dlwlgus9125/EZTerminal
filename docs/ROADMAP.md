# EZTerminal Roadmap

> Current for the **v1.0.15 release candidate** (2026-07-30).
> This document describes present direction and remaining work. Historical
> implementation detail belongs in `CHANGELOG.md`, `docs/design/`,
> `docs/research/`, and versioned release documents.

## Product direction

EZTerminal is a structured-data shell with a block-based terminal UI, not only
an existing shell wrapper. Built-ins produce typed rows that can be filtered
and sorted, while ordinary programs, interactive CLIs, and full-screen TUIs run
through PTY/xterm sessions.

The supported product is Windows-first:

- Windows 10 22H2 or Windows 11 x64 desktop application
- Android 10 (API 29) or newer companion application
- Remote access over a user-selected trusted VPN interface such as Tailscale
  or WireGuard

## Current capabilities

### Shell and terminal

- Structured built-ins and pipelines, variables, environment, history, and
  virtualized result tables
- Independent tabs, splits, draggable layouts, presets, and restart persistence
- Adaptive plain-text/xterm rendering with ConPTY, bounded output retention,
  cancellation, backpressure, search, links, Unicode, and WebGL fallback
- Safe OpenSSH sessions, host-key trust, local forwards, and bounded late attach

See:

- `docs/design/shell-core-architecture.md`
- `docs/design/pty-backpressure-design.md`
- `docs/design/ssh-remote-design.md`
- `docs/release/cli-parity-manual-checklist.md`

### Workbench and tools

- Adaptive desktop workbench with files, Quick Open, command actions, themes,
  Matrix CRT effects, settings, system telemetry, and optional packet capture
- Safe file previews, Git worktree operations, agent-attention state, and
  OpenClaw lifecycle/chat integration
- Renderer error containment, interpreter recovery, bounded persistent state,
  and packaged native-module guards

See:

- `docs/ux/frontend-design.md`
- `docs/design/layout-persistence-design.md`
- `docs/design/openclaw-management-design.md`

### Mobile and PC Control

- Android remote terminal sessions with reconnect, leases, secure credential
  storage, file transfer, settings, and desktop/mobile feature parity
- VPN-bound WebRTC streaming of the visible unlocked Windows desktop with
  adaptive capture, touch/trackpad input, keyboard/IME, and explicit clipboard
  actions
- Remote host capability advertisement and control fail closed when the bridge,
  VPN adapter, service, or active-session agent is unavailable

See:

- `docs/design/mobile-remote-control-design.md`
- `docs/design/remote-desktop-design.md`
- `docs/release/validation-policy-1.0.15.md`

## Maintenance contracts

- `release/version.json` is the source of truth for desktop, mobile, Android,
  native-host, and remote-protocol versions.
- Desktop and Android release artifacts come from the same clean Git SHA and
  pass the gates in `docs/release/README.md`.
- Ordinary development validation uses `pnpm e2e`. The release performance
  benchmark runs only when the user explicitly requests a performance
  measurement; see `AGENTS.md`.
- Android long-term signing material stays outside Git. Local material under
  `.release-secrets/` must not be removed by workspace cleanup.
- Generated output is ignored and reproducible. Product source, design
  rationale, versioned release notes, and validation policies remain tracked.

## Remaining work

The following are future candidates, not commitments:

1. **Release operations:** provision Windows code signing, decide automatic
   update and store-distribution policy, and expand physical-device release
   coverage.
2. **Platform coverage:** validate and package macOS/Linux paths that currently
   have unit-level seams but no supported release contract.
3. **PC Control expansion:** evaluate multi-monitor/HDR and privileged
   lock-screen, UAC secure-desktop, Software SAS, and Ctrl+Alt+Delete support.
   These require explicit security and service-boundary design.
4. **AI assistance:** add natural-language command help only after an explicit
   data-egress and provider policy is approved.

## Durable document map

- Product and build overview: `README.md`
- Release history: `CHANGELOG.md`
- Current release procedure: `docs/release/README.md`
- Architecture decisions: `docs/design/`
- UX decisions: `docs/ux/`
- Historical investigations and reviews: `docs/research/`
