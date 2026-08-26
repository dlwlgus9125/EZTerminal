# EZTerminal 1.0.40 validation policy and residual risk

## Release identity

- Desktop, Android and native-host product version: `1.0.40`
- Android versionCode: `61`
- Remote protocol: `v8`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.40 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository version and documentation
contracts; production-only and complete dependency audits; desktop and mobile
typecheck, lint, unit, OS, Storybook, visual and accessibility suites; ordinary
zero-retry `pnpm e2e`; Rust format, test, clippy, audit and deny; native guards;
packaged Electron smoke; Android lint, unit, API 29/API 35 instrumentation;
signed APK identity verification; and SBOM, manifest, and checksum verification.

Project Map coverage must prove:

- schema v1 fails explicitly while schema v2 validates exact keys, semantics,
  evidence, authoritative inputs, native layout, routes, labels, containment,
  accessibility, and provenance;
- approved/cache display stays separate from background Production validation,
  and concurrent first-open work is single-flight;
- a candidate cannot replace the default map or export until a human approves
  its exact clean Production fingerprint;
- authoring jobs persist their bounded phases, visibly distinguish saved,
  handoff, and Agent-reported work, and honor cooperative cancellation;
- canonical scene serialization drives the app, standalone SVG, 1600x900 PNG,
  and verification receipt without writing or overwriting repository map files;
  and
- dark/light and English/Korean application chrome remain accessible at wide
  and narrow desktop sizes while authored map prose retains its source locale.

Terminal clipboard coverage must prove:

- structured output, composer, plain PTY, and xterm selections use the same
  typed renderer result boundary for keyboard and context-menu copy;
- split and detached panes snapshot the invoking document before menu focus
  changes, then report success or failure only in that document;
- desktop production writes cross the context-isolated preload into one
  validated main-process Electron clipboard capability, without a renderer
  Clipboard API fallback or duplicate write;
- an empty selection preserves the existing PTY interrupt and direct-Agent
  control-key policies, while copy failures preserve the prior OS clipboard;
  and
- unit, ordinary Electron E2E, auxiliary-window E2E, and fresh packaged-EXE
  checks exercise the real capability boundary.

## Selected release profile

The release uses the repository's `functional-hotfix` publication path. The
workflow-dispatch run creates reviewable exact-SHA artifacts. The tag workflow
freezes and rebuilds that same SHA, then records
`validationProfile=functional-hotfix`. Only the tag-only publish job receives
`contents: write`; it revalidates the immutable artifact, manifest, checksums,
version, SHA, APK certificate, and unsigned Windows signing evidence before
creating a draft.

This profile does not run `pnpm e2e:performance`, the opt-in two-hour desktop
lifecycle soak, or the 30-minute mobile soak. `pnpm project-map:profile` is a
bounded feature-specific contract and is not a substitute for the separately
authorized release performance benchmark. No exact-SHA release performance or
soak claim is made for 1.0.40.

## Compatibility and residual risk

- Project Map schema v2 intentionally does not read schema v1; repositories with
  old maps require Agent regeneration.
- An authoring request needs a live Agent in the owning workspace. The app can
  persist and report the job but does not author repository files itself.
- Authored map prose is not automatically translated; only application chrome
  follows the current UI locale.
- Remote protocol v8 requires an exact desktop/mobile match and rejects v7
  peers. Native desktop-host protocol v2 and persisted layout schema version 1
  remain compatible.
- Automated Android lanes use API 29/API 35 emulators; physical-device and OEM
  behavior remains residual platform risk.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- This release makes no exact-SHA release-performance, two-hour desktop-soak,
  or 30-minute mobile-soak claim.
