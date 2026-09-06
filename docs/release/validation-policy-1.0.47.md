# EZTerminal 1.0.47 validation policy and residual risk

## Release identity

- Desktop, Android and native-host product version: `1.0.47`
- Android versionCode: `68`
- Remote protocol: `v12`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`
- Publication target: draft GitHub Release only

Existing tags and their versioned release documents remain immutable. The
1.0.47 candidate must be built from one exact clean Git SHA. Publishing the
draft or promoting it to the public latest release requires separate approval.

## Required non-performance gates

The exact candidate SHA must pass the repository version, documentation, and
Project Map contracts; production dependency audits; desktop and mobile
typecheck, lint, unit and OS suites; Storybook visual and accessibility
coverage; ordinary zero-retry `pnpm e2e`; Rust format, test, clippy, audit and
deny; native guards; packaged Electron smoke; Android validation; signed APK
identity verification; and SBOM, manifest, and checksum verification.

Codex compatibility coverage must additionally prove:

- the stable `0.152.1` baseline and representative newer patch, minor, major,
  and build-metadata versions remain eligible without a per-version allowlist;
- prereleases, versions below `0.152.1`, malformed or unlabeled output, failed
  version commands, and a version command that cannot start all fail closed;
- every new app-server process launch reruns the bounded version preflight and
  re-resolves the canonical reviewed executable path, including after a
  compatible in-place update;
- executable path or identity changes and an incompatible provider, protocol,
  argument, environment, review-digest, or launch-descriptor contract require
  explicit desktop recovery instead of silently widening trust; and
- unknown response IDs, malformed result/error envelopes, invalid JSON-RPC
  versions, invalid initialize identity fields, and lifecycle identity drift
  fail closed even when the reported stable version satisfies the minimum;
  the documented omitted JSON-RPC header and unknown future result fields
  remain forward-compatible, and only bounded current-process IDs retired by a
  local cancellation or timeout may accept one valid late response without
  restarting unrelated sessions.

Android New Session coverage must additionally prove:

- the global Agents action and the contextual 44-pixel `+` action open the same
  Agent-or-Terminal draft, while the contextual action passes the exact daemon
  Workspace ID and coexists with Back;
- archived Workspace history and unavailable/error states never expose the
  contextual creation action;
- a contextual draft keeps its Project and Workspace fixed, while a global
  draft permits selection only from active Projects and Workspaces;
- opening a draft, selecting a provider or model, and editing the initial prompt
  do not create a Session or start a provider process;
- the first non-empty Send creates the Agent and initial prompt with one
  `agent.create` command after a fresh snapshot confirms an enabled, ready
  provider and active Project and Workspace;
- revision conflicts retry no more than three times, keep one logical Session
  ID, and use a new idempotency key only after a definitive rejection;
- delivery uncertainty locks and preserves the exact draft, Session, title,
  and command, checks the refreshed snapshot first, and replays idempotently
  without duplicate prompt or Session creation;
- Android writes and verifies the exact command in Keystore-backed storage
  before the WebSocket send, restores it across a full Workspace remount, and
  never falls back to plaintext or `localStorage`;
- a valid pending command that finishes loading while New Session is already
  mounted hydrates and locks the exact provider, model, permission, Project,
  Workspace, and prompt without dropping the delivery warning or requiring a
  back-navigation workaround;
- Android binds each recovery record and secure key to the authenticated
  bearer's SHA-256 fingerprint, never persists the raw bearer with the command,
  refuses cross-Desktop replay, and can later restore the original Desktop's
  exact pending envelope;
- an unavailable secure-storage capability or a malformed, oversized, or
  unverifiable Android recovery record sends no new Agent command, disables
  only Agent creation, leaves Workspace Terminal creation available, and
  exposes an explicit retry for transient storage failures;
- an irrecoverably invalid current-authority record offers an explicit discard
  only after a duplicate-risk warning and a cancel-first confirmation dialog,
  and raw per-key deletion remains available when its ciphertext cannot decrypt;
- the bounded secure record accepts the full 65,536-character draft input,
  including worst-case JSON escaping, without weakening its allocation cap;
- Desktop waits for main-process memory-only checkpoint acknowledgement before
  sending, rejects non-canonical recovery principals or identities, and guards
  pane, auxiliary-window, quit-on-close, and preset-replacement paths; a pending
  create survives the ordinary renderer-checkpoint TTL for that main-process
  lifetime, remains one-shot/explicitly clearable, and adds discard/duplicate
  risk to the cancel-first explicit-Quit warning; the 65th concurrent pending
  create fails before persistence or transport instead of truncating one of the
  64 bounded escrow records;
- Terminal creation refreshes daemon state, revalidates the exact active
  Workspace and its runnable root, then opens the owned Terminal surface; and
- Android directs provider setup and executable review to Desktop Settings and
  never presents a mobile control that mutates desktop-only trust state.

Remote protocol coverage must continue proving that v12 rejects mismatched
clients instead of silently omitting provider, Workspace, command, Agent, or
recovery state.

## Selected release profile

The release uses the repository's `functional-hotfix` path. The tag workflow
freezes and rebuilds the exact candidate SHA. Only the tag-only publish job
receives `contents: write`; it revalidates immutable artifacts, manifest,
checksums, versions, SHA, APK certificate, and unsigned Windows signing
evidence before creating a draft release.

This profile does not run `pnpm e2e:performance`, the opt-in two-hour desktop
lifecycle soak, or the 30-minute mobile soak. No exact-SHA performance or soak
claim is made for 1.0.47.

## Compatibility and residual risk

- Accepting every stable Codex version at or above `0.152.1` removes routine
  version-only approval but cannot predict a future upstream semantic break.
  Launch preflight and runtime contract validation stop known identity or
  schema drift; a newly incompatible stable release can still require a Codex
  downgrade or an EZTerminal adapter update.
- Provider availability still depends on a compatible local Codex or Claude
  Code installation and the user's provider authentication. Deterministic CI
  does not submit a paid live prompt to either account.
- Provider enablement, authentication guidance, executable review, and adapter
  trust remain desktop-only. Android creation depends on the connected desktop
  authority and a current daemon snapshot.
- Remote protocol v12 requires matching desktop and Android clients. Native
  desktop-host protocol v2 and persisted layout schema version 1 are unchanged.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- Relay, voice, an external Hub, and multi-user accounts remain excluded.
- This candidate makes no release-performance or lifecycle-soak claim.
