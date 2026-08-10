# EZTerminal 1.0.31 validation policy and residual risk

## Release identity

- Desktop, Android, and native-host product version: `1.0.31`
- Android versionCode: `52`
- Remote protocol: `v7`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.31 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository version and documentation
contracts; desktop and mobile typecheck, lint, unit, OS, Storybook, visual, and
accessibility suites; ordinary zero-retry `pnpm e2e`; Rust format, test,
clippy, audit, and deny; native guards; packaged Electron smoke; dependency
audit; Android lint, unit, API 29/API 35 instrumentation; signed APK identity
verification; SBOM, manifest, and checksum verification.

The PC-control regression gates must prove:

- the edge handle and session sheet expose start, input mode, fit, quality,
  keyboard, clipboard, metrics, resume, and disconnect states without covering
  the controlled desktop;
- fit, zoom, pan, and source-region calculations keep normalized view and input
  coordinates bounded, and direct-touch input waits for the matching applied
  view revision;
- pointer, long-press, drag, multi-touch, keyboard/IME, Bluetooth mouse, and
  wheel paths release every pressed key or button on all stop paths;
- optional view, quality, and client-video-stat messages preserve protocol-v7
  behavior when the peer does not advertise the new capabilities;
- client decode/drop/freeze pressure drives the same bounded quality ladder as
  host pipeline pressure; and
- DXGI/GDI capture geometry, Media Foundation/OpenH264 fallback, Annex-B
  normalization, and actual-backend reporting remain deterministic at their
  automated seams.

Existing terminal, process-lifecycle, project-workbench, desktop-handoff,
design-system, approval-privacy, offline-pairing, detached-window, and mobile
remote-session regressions remain mandatory.

## Selected release profile

The operator requested public release publication but did not separately
request a desktop performance measurement. Repository policy does not treat a
build, package, update, or release request as permission to run the performance
benchmark.

Do not run `pnpm e2e:performance`, `e2e/release-performance.spec.ts`, set
`EZTERMINAL_RUN_RELEASE_PERFORMANCE=1`, or pass
`-RunPerformanceMeasurement` for this release. The functional-hotfix workflow
also does not run or claim the 30-minute mobile soak.

The tag workflow freezes the exact checkout SHA, rebuilds all artifacts, and
records `validationProfile=functional-hotfix`. Only the tag-only publish job
receives `contents: write`; it revalidates the immutable build artifact,
manifest, checksums, version, SHA, APK certificate, and unsigned Windows
signing evidence before creating a draft release. The draft must be inspected
before it is made public.

## Compatibility and residual risk

- Remote protocol v7 and native desktop-host protocol v2 are unchanged; new
  messages and fields are capability-gated and optional.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- Lock/UAC secure-desktop input, software SAS, and Ctrl+Alt+Delete remain
  unsupported.
- Automated tests compile and exercise the hardware-first seams but do not
  prove Media Foundation hardware selection on every GPU/driver combination;
  runtime failures fall back to OpenH264 and are reported in session metrics.
- Physical Android OEM codecs, touch sampling, hardware keyboards and mice,
  multi-monitor/HDR capture, thermal behavior, and adverse physical-network
  paths are not fully automated.
- This release makes no performance or 30-minute mobile-soak claim.
