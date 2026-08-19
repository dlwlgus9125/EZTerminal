# EZTerminal 1.0.39 validation policy and residual risk

## Release identity

- Desktop, Android and native-host product version: `1.0.39`
- Android versionCode: `60`
- Remote protocol: `v8`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.39 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository version and documentation
contracts; production-only and complete dependency audits; desktop and mobile
typecheck, lint, unit, OS, Storybook, visual and accessibility suites; ordinary
zero-retry `pnpm e2e`; Rust format, test, clippy, audit and deny; native guards;
packaged Electron smoke; Android lint, unit, API 29/API 35 instrumentation;
signed APK identity verification; and SBOM, manifest, and checksum verification.

Agent lifecycle coverage must prove:

- terminal session removal purges live and completed activity for that session
  exactly once without affecting activity owned by another live session;
- delayed run catch-up cannot recreate activity for a removed terminal session;
- removed sessions fail open any pending approval gate and close observation
  ports; and
- a real Electron termination removes the pane, broker session, Agent row, and
  Focus target together.

## Selected release profile

The release uses the repository's `functional-hotfix` publication path. The
workflow-dispatch run creates reviewable exact-SHA artifacts. The tag workflow
freezes and rebuilds that same SHA, then records
`validationProfile=functional-hotfix`. Only the tag-only publish job receives
`contents: write`; it revalidates the immutable artifact, manifest, checksums,
version, SHA, APK certificate, and unsigned Windows signing evidence before
creating a draft.

This profile does not run `pnpm e2e:performance`, the opt-in two-hour desktop
lifecycle soak, or the 30-minute mobile soak. No performance or soak claim is
made for 1.0.39.

## Compatibility and residual risk

- Remote protocol v8 requires an exact desktop/mobile match and rejects v7
  peers. Native desktop-host protocol v2 and persisted layout schema version 1
  remain compatible.
- **Keep running** deliberately preserves a live background Agent session. The
  Command Center can reclaim it, but Agent Hub Focus does not yet reopen a pane
  when no binding exists and may clear seen/unread state without navigation.
- Automated Android lanes use API 29/API 35 emulators; physical-device and OEM
  behavior remains residual platform risk.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- This release makes no exact-SHA performance, two-hour desktop-soak, or
  30-minute mobile-soak claim.
