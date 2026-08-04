# EZTerminal 1.0.24 validation policy and residual risk

## Release identity

- Desktop, Android, and native-host product version: `1.0.24`
- Android versionCode: `45`
- Remote protocol: `v6`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.24 candidate is a new patch identity built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must have a clean tree and pass:

- frozen dependency install, version contract, desktop/mobile typecheck and
  lint, three consecutive zero-retry unit/OS runs, and zero-known-vulnerability
  production and full dependency audits;
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

The approval-privacy, offline-pairing, and desktop-handoff guards remain
mandatory.

The 1.0.24 lockfile pins patched `undici`, `fast-uri`, `ip-address`,
`brace-expansion`, and `postcss` releases. The brace-expansion compatibility
patch is carried forward to 5.0.9 so legacy minimatch consumers used by the
packaging toolchain retain their callable default export.

## Cross-window focus and shutdown gates

- A terminal pane moved into an existing auxiliary window must remain the
  active Dockview panel and focus its visible command input even when the main
  realm's destination-overlay layout frame runs after auxiliary-window frames.
- The focus callback must reject stale work after disposal, window closure,
  panel replacement, a second move, or an active-panel change.
- Terminal and Agent Session popouts must continue to preserve their live React
  and session identity across DOM reparenting.
- `ManagedDesktopRuntime.dispose()` must not settle while secure token
  initialization that entered before IPC removal is still pending.
- The original Matrix-effects Electron teardown and the complete popout suite
  remain release regressions; no protected empty-DACL profile may be left by a
  successful run.

## Windows signing gate

`release/version.json` selects `windowsSigningMode=unsigned` while the SignPath
Foundation application is pending. Release validation therefore requires the
application, native host, uninstaller, and setup executable to report
Authenticode `NotSigned`; the manifest records the same expectation. A partial
SignPath configuration or signing failure is fatal and cannot fall back to an
unsigned publication.

## Selected release profile

The operator requested release publication but did not separately request a
desktop performance measurement. Repository policy does not treat a build,
package, update, or release request as permission to run the performance
benchmark.

Do not run `pnpm e2e:performance`, `e2e/release-performance.spec.ts`, set
`EZTERMINAL_RUN_RELEASE_PERFORMANCE=1`, or pass
`-RunPerformanceMeasurement` for this release.

The tag workflow freezes the exact checkout SHA, rebuilds all artifacts, and
records `validationProfile=functional-hotfix`. Only the tag-only publish job
receives `contents: write`; it revalidates the immutable build artifact,
manifest, checksums, version, SHA, and unsigned signing evidence before
creating a draft release.

## Compatibility and residual risk

- A v6 host accepts supported v1-v6 clients and gates capabilities by the
  negotiated version.
- Pane focus and runtime shutdown changes do not alter either remote protocol.
- The automated suite covers real Electron windows and Windows pointer input,
  but not every multi-monitor DPI, hot-unplug, HDR, taskbar, stylus, or
  accessibility-pointer arrangement.
- Lock/UAC secure-desktop input, software SAS, and Ctrl+Alt+Delete are
  unsupported.
- Physical Android unknown-app UI, OEM camera behavior, TalkBack, hardware
  keyboards, elevated service lifecycle, and adverse physical-network paths
  are not fully automated.
- This release makes no performance or long-soak claim.
