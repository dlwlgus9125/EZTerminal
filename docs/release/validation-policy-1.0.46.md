# EZTerminal 1.0.46 validation policy and residual risk

## Release identity

- Desktop, Android and native-host product version: `1.0.46`
- Android versionCode: `67`
- Remote protocol: `v12`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.46 candidate must be built from one exact clean Git SHA before publication.

## Required non-performance gates

The exact candidate SHA must pass the repository version, documentation, and
Project Map contracts; production dependency audits; desktop and mobile
typecheck, lint, unit and OS suites; Storybook visual/accessibility coverage;
ordinary zero-retry `pnpm e2e`; Rust format, test, clippy, audit and deny;
native guards; packaged Electron smoke; Android validation; signed APK identity
verification; and SBOM, manifest, and checksum verification.

Local Agent and managed-tree coverage must additionally prove:

- New Agent is a draft Session and does not create a provider process before
  the first Send;
- the active Project workflow has no per-Project Collaboration switch, Persona
  editor, or separate Team graph;
- Codex app-server and Claude Agent SDK lifecycle events preserve one durable
  turn owner across retry, cancellation, shutdown, and late responses;
- every managed child is a directly navigable Agent Session with message,
  interrupt, archive, and detach controls, including recursive cross-provider
  creation;
- concurrency, node, depth, creation-rate, background-time, permission, and path
  ceilings are enforced by the daemon and session-scoped MCP rather than only
  by a renderer;
- revisioned SQLite state, the write-ahead outbox, recovery reconciliation,
  process ownership, and terminal-only safe mode fail closed without duplicate
  prompt delivery;
- desktop keeps provider enablement and adapter trust review explicit, while
  Android exposes real session controls without a fake desktop-host mutation;
- schedules, heartbeats, local CLI control, desktop, and Android observe the
  same scoped command policy and monotonic snapshot revisions; and
- remote protocol v12 rejects older clients instead of silently omitting Agent,
  provider, schedule, or heartbeat data.

## Selected release profile

The release uses the repository's `functional-hotfix` publication path. The tag
workflow freezes and rebuilds the exact candidate SHA. Only the tag-only publish
job receives `contents: write`; it revalidates immutable artifacts, manifest,
checksums, versions, SHA, APK certificate, and unsigned Windows signing evidence
before creating a draft release.

This profile does not run `pnpm e2e:performance`, the opt-in two-hour desktop
lifecycle soak, or the 30-minute mobile soak. No exact-SHA performance or soak
claim is made for 1.0.46.

## Compatibility and residual risk

- Remote protocol v12 requires matching desktop and Android clients. Native
  desktop-host protocol v2 and persisted layout schema version 1 are unchanged.
- Provider availability still depends on compatible local Codex or Claude Code
  executables and their upstream protocols. Deterministic CI does not submit a
  paid live prompt to either account.
- EZTerminal does not store provider credentials. Commercial use of a user's
  Claude subscription authentication remains behind an explicit product gate
  pending the applicable Anthropic approval; API-key and supported cloud
  authentication remain user-managed alternatives.
- Android can control Agent Sessions but intentionally cannot mutate desktop
  provider or adapter trust settings.
- Relay, voice, an external Hub, and multi-user accounts are excluded from this
  release.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- This release makes no release-performance or lifecycle-soak claim.
