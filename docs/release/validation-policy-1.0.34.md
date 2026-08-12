# EZTerminal 1.0.34 validation policy and residual risk

## Release identity

- Desktop, Android and native-host product version: `1.0.34`
- Android versionCode: `55`
- Remote protocol: `v7`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.34 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository version and documentation
contracts; desktop and mobile typecheck, lint, unit, OS, Storybook, visual and
accessibility suites; ordinary zero-retry `pnpm e2e`; Rust format, test,
clippy, audit and deny; native guards; packaged Electron smoke; dependency
audit; Android lint, unit, API 29/API 35 instrumentation; signed APK identity
verification; SBOM, manifest and checksum verification.

The lifecycle regression gates must prove:

- main and detached native-window state is aggregated without a single-window
  assumption, and hidden or minimized panes cross the 30-second park grace;
- a parked PTY presentation keeps its xterm identity, uses the DOM renderer,
  limits scrollback to 1,000 lines and coalesces writes to 4 Hz;
- returning active or passive restores the configured renderer, scrollback,
  cursor behavior and normal write cadence without closing the run;
- renderer recovery restores layout, active pane, draft and session bindings,
  and reattaches an eligible live PTY instead of creating a duplicate run;
- Android foreground/background sequencing cancels stale deadlines, suspends
  after 30 seconds and resumes through the existing connection/replay gates;
  and
- ordinary detached-window interaction, process ownership, remote mirroring,
  layout persistence and terminal backpressure regressions remain green.

## Selected release profile

The release uses the repository's `functional-hotfix` publication path. The
tag workflow freezes the exact checkout SHA, rebuilds every artifact and
records `validationProfile=functional-hotfix`. Only the tag-only publish job
receives `contents: write`; it revalidates the immutable artifact, manifest,
checksums, version, SHA, APK certificate and unsigned Windows signing evidence
before creating a draft.

This profile does not run `pnpm e2e:performance`, the opt-in two-hour desktop
lifecycle soak or the 30-minute mobile soak. Pre-release measurements from a
different SHA are diagnostic context only and are not promoted as 1.0.34
release evidence. The draft and exact assets must be inspected before
publication as the latest public GitHub release.

## Compatibility and residual risk

- Remote protocol v7, native desktop-host protocol v2 and persisted layout
  schema are unchanged, so older paired clients retain the existing protocol
  compatibility boundary.
- Parking suspends presentation work, not the interpreter or PTY. Output is
  intentionally bounded to 1,000 presentation lines while parked and the
  configured active scrollback returns when the pane is visible again.
- Renderer recovery is best effort within a bounded interpreter grace. A
  whole-process crash, machine restart or corrupted checkpoint cannot preserve
  an in-memory interactive run.
- Automated Android lanes use API 29/API 35 emulators; physical devices, OEM
  lifecycle policies and long background periods remain residual risk.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- Lock/UAC secure-desktop input, software SAS and Ctrl+Alt+Delete remain
  unsupported.
- This release makes no exact-SHA performance, two-hour desktop-soak or
  30-minute mobile-soak claim.
