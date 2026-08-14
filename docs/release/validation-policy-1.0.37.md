# EZTerminal 1.0.37 validation policy and residual risk

## Release identity

- Desktop, Android and native-host product version: `1.0.37`
- Android versionCode: `58`
- Remote protocol: `v7`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.37 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository version and documentation
contracts; production-only and complete dependency audits; desktop and mobile
typecheck, lint, unit, OS, Storybook, visual and accessibility suites;
ordinary zero-retry `pnpm e2e`; Rust format, test, clippy, audit and deny;
native guards; packaged Electron smoke; Android lint, unit, API 29/API 35
instrumentation; signed APK identity verification; and SBOM, manifest and
checksum verification.

Window and pane regression coverage must prove:

- dragging a terminal tab outside creates one auxiliary window and preserves
  the same session surface;
- dragging an empty tab bar detaches the complete group;
- a three-tab group can detach and redock, after which one tab detaches into
  exactly one auxiliary window while two tabs remain in the main window;
- a split requested from an auxiliary panel stays inside that auxiliary
  window and receives keyboard focus;
- Terminal, Agent Session, Project Editor, and OpenClaw Chat layouts validate,
  restore, redock, and close under their declared lifecycle tier;
- the OpenClaw native chat view retains the same `webContents` identity across
  detach and redock, and stale renderer surface revisions are rejected; and
- Project Editor retains owner-document focus and Monaco view state across
  main/auxiliary moves.

## Selected release profile

The release uses the repository's `functional-hotfix` publication path. The
workflow-dispatch run creates reviewable exact-SHA artifacts. The tag workflow
freezes and rebuilds that same SHA, then records
`validationProfile=functional-hotfix`. Only the tag-only publish job receives
`contents: write`; it revalidates the immutable artifact, manifest, checksums,
version, SHA, APK certificate and unsigned Windows signing evidence before
creating a draft.

This profile does not run `pnpm e2e:performance`, the opt-in two-hour desktop
lifecycle soak or the 30-minute mobile soak. No performance or soak claim is
made for 1.0.37.

## Compatibility and residual risk

- Remote protocol v7, native desktop-host protocol v2 and persisted layout
  schema version 1 remain compatible.
- Packaged Electron coverage exercises real HTML5 drag and real auxiliary
  BrowserWindows, but every multi-monitor DPI arrangement and third-party
  Windows shell hook is not automated.
- OpenClaw rehosting is verified against the same native view identity; gateway
  behavior outside the supported integration contract remains external.
- Automated Android lanes use API 29/API 35 emulators; physical-device and OEM
  behavior remains residual platform risk.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- This release makes no exact-SHA performance, two-hour desktop-soak or
  30-minute mobile-soak claim.
