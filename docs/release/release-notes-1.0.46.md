# EZTerminal 1.0.46

Release identity: remote protocol v12, Android versionCode 67.

## Local Agent sessions instead of Project collaboration setup

This release replaces the per-Project Collaboration switch, Persona editor,
and separate Team run graph with a single Project → Workspace → Session model.
New Agent opens as a normal draft tab; choosing a provider or model does not
start a process, and the provider session is created only when the first prompt
is sent.

Codex runs through `codex app-server`. Claude runs through Claude Agent SDK
streaming input using the user's installed Claude CLI authentication chain.
EZTerminal does not read or persist provider tokens and does not embed a
provider login page. Provider enablement, executable review, and third-party
adapter trust remain explicit desktop settings actions. Android reports the
same runtime state without exposing controls that cannot run on the host.

## Managed Agents are directly usable sessions

An Agent with orchestration tools enabled can create recursive children in the
same or another Workspace and can choose Codex or Claude independently for each
child. A managed child is not a hidden worker transcript: it is a complete Agent
session that the user can open, message, interrupt, archive, or detach directly.
Provider-native subagents remain visible but read-only and provider-owned.

The daemon enforces four concurrent managed turns, 16 nodes per tree, depth
four, 12 child creations per ten minutes, and a two-hour background-turn limit.
Excess concurrency is queued FIFO; structural and time limits fail with typed
states rather than silently widening authority. Session-scoped MCP can manage
only its owning Agent and verified descendants. The local CLI, schedules, and
heartbeats use the same command policy and revisioned state.

## Durable local authority and recovery

Electron main owns the user-level local daemon authority while desktop,
Android, CLI, MCP, and provider runtimes act as scoped clients. Revisioned
SQLite snapshots, a write-ahead command outbox, provider reconciliation,
idempotent legacy import, process ownership, and terminal-only safe mode protect
restarts and partial delivery. Cancellation fences prevent a stopped or
superseded turn from being revived by a late provider response.

Closing or explicitly quitting uses the configured daemon lifetime policy;
optional keep-running and start-at-login behavior is reviewed in desktop
settings. Relay, voice, an external Hub, and multi-user accounts are not part of
this release.

## Compatibility and artifacts

Remote protocol v12 is required for revisioned daemon snapshots, commands,
provider state, Agent trees, schedules, and heartbeat state. Desktop and
Android must use the exact same protocol version; older remote clients fail
closed instead of receiving a partial downgrade. Electron-to-Rust native
desktop protocol v2, persisted layout schema version 1, Project Map schema v2,
and terminal and project identities are unchanged.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.46-vc67.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath Foundation
application remains pending. The Android APK must use the existing long-term
EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. The exact tagged
SHA must pass the release workflow's version and documentation contracts,
desktop and mobile typechecks and repeated zero-retry tests, Android API 29/35
instrumentation, Rust format/test/clippy/audit/deny, Storybook accessibility
and visual checks, ordinary Electron E2E, packaged smoke, signing-state, SBOM,
manifest, and checksum gates before a draft is created.

This release does not run or claim the separately authorized release
performance benchmark, the opt-in two-hour desktop lifecycle soak, or the
30-minute mobile soak.

See the [1.0.46 validation policy](validation-policy-1.0.46.md).
