# EZTerminal 1.0.23 validation policy and residual risk

## Release identity

- Desktop, Android, and native-host product version: `1.0.23`
- Android versionCode: `44`
- Remote protocol: `v6`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`

Existing tags and their versioned release documents remain immutable. The
1.0.23 candidate supersedes the unpublished 1.0.22 validation candidate.

## Required non-performance gates

The exact candidate SHA must have a clean tree and pass:

- frozen dependency install, version contract, desktop/mobile typecheck and
  lint, three consecutive zero-retry unit/OS runs, and dependency audits;
- Storybook interaction, production build, visual snapshots, axe checks,
  Korean/English, supported widths, 150% scale, high contrast, and reduced
  motion;
- Rust format, unit, clippy, audit, deny, and native-host build;
- ordinary `pnpm e2e`, native guards, packaged Electron smoke, and exact-SHA
  Windows packaging;
- Android lint, unit and instrumentation plus API 29/API 35 cold-boot smoke,
  QR lifecycle, stabilization, parity, theme/effects, handoff validation, and
  the API 35 functional soak;
- production mobile asset restoration, E2E-marker rejection, signed APK
  identity/certificate/build-SHA verification, SBOM, manifest, and checksums.

The approval-privacy and offline-pairing guards remain mandatory.

## Agent Session popout gates

- The installed 1.0.21 binary with a saved Codex Agent Session layout must
  reproduce real `mousedown`, `dragstart`, and out-of-window `dragend` events
  while opening zero auxiliary windows.
- Terminal and Agent Session components are detachable; main-owned native
  components such as OpenClaw chat remain non-detachable.
- Agent Session popout layouts must survive schema validation, persistence,
  restart, and auxiliary-window restore.
- Closing a read-only Agent Session must be safe. Terminal-backed sessions keep
  guarded close semantics, and a read-only-to-terminal transition during close
  fails closed.
- The packaged EXE test must place its native main window within the primary
  work area, observe a physical Windows `dragend` beyond that window edge, and
  open exactly one auxiliary renderer window.

## Selected release profile

The operator requested the functional fix and release but did not separately
request a desktop performance measurement. Repository policy does not treat a
build, package, update, or release request as permission to run the performance
benchmark.

Do not run `pnpm e2e:performance`, `e2e/release-performance.spec.ts`, set
`EZTERMINAL_RUN_RELEASE_PERFORMANCE=1`, or pass
`-RunPerformanceMeasurement` for this release.

The tag workflow freezes the exact checkout SHA, rebuilds all artifacts, and
records `validationProfile=functional-hotfix`. Only the tag-only publish job
receives `contents: write`; it revalidates the immutable build artifact,
manifest, checksums, version, and SHA before creating a draft release.

## Compatibility and residual risk

- A v6 host accepts supported v1-v6 clients and gates capabilities by the
  negotiated version.
- Agent Session popouts do not change either remote protocol.
- OpenClaw chat, files, status, settings, and sidebar surfaces do not detach.
- The automated suite covers real Electron windows and Windows pointer input,
  but not every multi-monitor DPI, hot-unplug, HDR, taskbar, stylus, or
  accessibility-pointer arrangement.
- Lock/UAC secure-desktop input, software SAS, and Ctrl+Alt+Delete are
  unsupported.
- Physical Android unknown-app UI, OEM camera behavior, TalkBack, hardware
  keyboards, elevated service lifecycle, and adverse physical-network paths
  are not fully automated.
- This release makes no performance or long-soak claim.
