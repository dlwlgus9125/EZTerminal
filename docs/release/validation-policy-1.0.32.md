# EZTerminal 1.0.32 validation policy and residual risk

## Release identity

- Desktop, Android and native-host product version: `1.0.32`
- Android versionCode: `53`
- Remote protocol: `v7`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.32 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository version and documentation
contracts; desktop and mobile typecheck, lint, unit, OS, Storybook, visual and
accessibility suites; ordinary zero-retry `pnpm e2e`; Rust format, test,
clippy, audit and deny; native guards; packaged Electron smoke; dependency
audit; Android lint, unit, API 29/API 35 instrumentation; signed APK identity
verification; SBOM, manifest and checksum verification.

The PC-control hardware-input regression gates must prove:

- entering an active session focuses only the remote video surface, and
  closing the session sheet restores that focus;
- supported hardware key down/up transitions reach the existing key command,
  modifier combinations and F1-F12 remain usable, and Android-reserved or
  host-unsupported codes are not captured;
- held hardware keys and mouse buttons are released on focus/visibility loss,
  reconnect, mode/display change, cancellation, close and unmount;
- Bluetooth mouse hover works without `pointerdown`, Precision pointer remains
  relative, and Direct touch remains absolute and view-revision safe;
- left/right/middle buttons, drag and both wheel axes use reliable bounded
  commands while motion remains on the lossy pointer channel; and
- touch gestures, explicit IME text input, the keyboard accessory and local UI
  controls retain their existing behavior.

Existing protocol-v7, desktop-host v2, terminal, process-lifecycle,
project-workbench, desktop-handoff, design-system, approval-privacy,
offline-pairing, detached-window and mobile remote-session regressions remain
mandatory.

## Selected release profile

The operator requested public release publication but did not separately
request a performance measurement. A build, package, update or release request
does not authorize that benchmark.

Do not run `pnpm e2e:performance`, `e2e/release-performance.spec.ts`, set
`EZTERMINAL_RUN_RELEASE_PERFORMANCE=1`, or pass
`-RunPerformanceMeasurement` for this release. The functional-hotfix workflow
also does not run or claim the 30-minute mobile soak.

The tag workflow freezes the exact checkout SHA, rebuilds every artifact and
records `validationProfile=functional-hotfix`. Only the tag-only publish job
receives `contents: write`; it revalidates the immutable artifact, manifest,
checksums, version, SHA, APK certificate and unsigned Windows signing evidence
before creating a draft. The draft and exact assets must be inspected before
publication as the latest public GitHub release.

## Compatibility and residual risk

- Remote protocol v7 and native desktop-host protocol v2 are unchanged; this
  fix uses existing commands and does not add a capability.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- Lock/UAC secure-desktop input, software SAS and Ctrl+Alt+Delete remain
  unsupported.
- Automated tests exercise browser hardware-event seams and API 29/API 35
  Android builds, but do not prove behavior on every physical Android OEM,
  WebView, Bluetooth keyboard layout or mouse firmware. That physical-device
  matrix remains residual field-validation risk and is not a publication gate
  for this functional hotfix.
- This release makes no performance or 30-minute mobile-soak claim.
