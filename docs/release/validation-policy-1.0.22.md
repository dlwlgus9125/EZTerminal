# EZTerminal 1.0.22 validation policy and residual risk

## Release identity

- Desktop, Android, and native-host product version: `1.0.22`
- Android versionCode: `43`
- Remote client protocol: `6`
- Electron-to-Rust native desktop-host protocol: `2`
- Validation profile: `functional-hotfix`

The shipped remote protocol is v6. Existing tags and their versioned release
documents are immutable. The version verifier rejects reuse of an existing tag
with changed version, versionCode, protocol, or validation profile.

## Required non-performance gates

The exact candidate SHA must have a clean tree and pass:

- frozen dependency install, version contract, desktop/mobile typecheck and
  lint, three consecutive zero-retry unit/OS runs, and dependency audits;
- Storybook interaction, production build, product-component visual snapshots,
  axe checks, Korean/English, supported widths, 150% scale, high contrast, and
  reduced motion;
- Rust format, unit, clippy, audit, deny, and native-host build;
- ordinary `pnpm e2e`, native guards, packaged Electron smoke, and exact-SHA
  Windows packaging;
- Android lint, unit and instrumentation plus API 29/API 35 cold-boot smoke,
  QR-scanner lifecycle checks, stabilization, parity, theme/effects,
  handoff-surface validation, and the API 35 functional soak;
- production mobile asset restoration, E2E-marker rejection, signed APK
  identity/certificate/build-SHA verification, SBOM, manifest, and checksums.

The approval-privacy and offline-pairing guards are mandatory in ordinary CI
and the final release workflow.

## Agent Session popout regression gates

- The installed 1.0.21 binary with a saved Codex Agent Session layout must
  reproduce a real Windows `mousedown`, `dragstart`, and out-of-window
  `dragend` while opening zero auxiliary windows.
- A single Agent Session panel with no real history or second tab must retain
  that same red result, proving the panel component is the load-bearing input.
- The fixed packaged EXE must turn both the minimal and copied installed
  layouts green with exactly one auxiliary renderer window.
- Terminal and Agent Session components are detachable. Main-owned native
  components such as OpenClaw chat remain non-detachable.
- Agent Session popout layouts must survive schema validation, preflight,
  persistence, restart, and real auxiliary-window restore.
- Closing a read-only Agent Session must be safe. A terminal-backed Agent
  Session must retain guarded close semantics, and any transition from
  read-only to terminal-backed during close must fail closed.

## Selected release profile

The operator requested continued execution of the functional fix but did not
separately request a desktop performance measurement. Repository policy does
not treat a build, package, update, or release request as permission to run the
performance benchmark. Release 1.0.22 therefore uses the
`functional-hotfix` profile and does not claim exact-SHA performance or
30-minute mobile-soak evidence.

Do not run `pnpm e2e:performance`, `e2e/release-performance.spec.ts`, set
`EZTERMINAL_RUN_RELEASE_PERFORMANCE=1`, or pass
`-RunPerformanceMeasurement` for this release.

## Publication evidence

The tag workflow freezes the exact checkout SHA and independently rebuilds and
validates the release. For `functional-hotfix`, it intentionally does not read
protected full-profile local RC variables or evidence bundles. The staged
manifest records `validationProfile=functional-hotfix`, omits raw performance
and long-soak evidence, and must still be publication-eligible with complete
functional evidence before the tag-only publish job accepts it.

All validation and build jobs use `contents: read`, and every checkout disables
credential persistence. Only the tag-only publish job receives
`contents: write`. It downloads the immutable build-job artifact and
revalidates the manifest, checksums, exact SHA, and publication eligibility
before creating a draft release.

## Compatibility

- A v6 host accepts supported v1/v2/v3/v4/v5/v6 clients and exposes
  capabilities according to the negotiated version.
- Agent Session popouts do not change the remote or native-host protocol.
- Users on 1.0.21 can discover and install 1.0.22 through the existing updater.
- Layouts without popout groups and existing terminal popouts remain valid.

## Known limits and residual risk

- OpenClaw chat remains in the main window because it owns a native
  `WebContentsView`. Files, status, settings, and other sidebar surfaces are
  not Dockview tabs and do not detach.
- The automated suite covers real Electron windows and Windows pointer input,
  but it does not exhaust every physical multi-monitor DPI, hot-unplug, HDR,
  taskbar, stylus, or accessibility-pointer arrangement.
- The functional gates do not install the release through a physical Android
  device's unknown-app permission screen. Package identity, signer, digest,
  and installer-intent boundaries are covered below that physical-device seam.
- Lock and UAC secure-desktop capture and input are unsupported.
- Software SAS and Ctrl+Alt+Delete are unsupported.
- Windows 10/Home/Enterprise, domain/MDM policy, elevated service lifecycle,
  physical Android/OEM camera, TalkBack, hardware keyboard, and adverse
  physical-network paths are not fully automated by the emulator workflow.
- This release makes no performance or long-soak claim.
