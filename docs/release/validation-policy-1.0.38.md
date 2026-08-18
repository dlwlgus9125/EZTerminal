# EZTerminal 1.0.38 validation policy and residual risk

## Release identity

- Desktop, Android and native-host product version: `1.0.38`
- Android versionCode: `59`
- Remote protocol: `v8`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.38 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository version and documentation
contracts; production-only and complete dependency audits; desktop and mobile
typecheck, lint, unit, OS, Storybook, visual and accessibility suites; ordinary
zero-retry `pnpm e2e`; Rust format, test, clippy, audit and deny; native guards;
packaged Electron smoke; Android lint, unit, API 29/API 35 instrumentation;
signed APK identity verification; and SBOM, manifest, and checksum verification.

Agent collaboration coverage must prove:

- Project configuration uses revision checks and persists no participants,
  prompts, transcript, validation output, or capability token;
- a dormant or wrong-Project loopback capability cannot read or control an
  Agent, while an authenticated joined session receives only bounded output;
- a real Git candidate leaves the target unchanged before approval, rejects a
  stale revision, promotes the exact validated commit, and removes its worktree
  and internal ref;
- a one-shot grant is exact in participant, workspace, target, and lifetime;
- mobile accepts normal Approve/Deny only, and protocol v8 carries no validation
  output; and
- main-window close hides to tray while explicit Quit warns that sessions stop.

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
made for 1.0.38.

## Compatibility and residual risk

- Remote protocol v8 requires an exact desktop/mobile match and rejects v7
  peers. Native desktop-host protocol v2 and persisted layout schema version 1
  remain compatible.
- Automated Android lanes use API 29/API 35 emulators; physical-device and OEM
  behavior remains residual platform risk.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- This release makes no exact-SHA performance, two-hour desktop-soak, or
  30-minute mobile-soak claim.
