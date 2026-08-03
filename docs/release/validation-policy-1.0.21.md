# EZTerminal 1.0.21 validation policy and residual risk

## Release identity

- Desktop, Android, and native-host product version: `1.0.21`
- Android versionCode: `42`
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

## Popout regression gates

- A v1.0.20 installed/source identity must show that dragging a terminal tab
  outside cannot open an auxiliary window because that release contains no
  popout behavior.
- A real pointer drag from a Dockview terminal tab beyond the native window
  boundary must create exactly one auxiliary Electron window.
- The pane must move with the same live session, without a duplicate renderer
  or remounted PTY, and the main window must no longer contain that pane.
- Auxiliary native controls, context menus, focus, dialogs, theme/effect
  propagation, and app-wide shortcuts must target the owning document/window.
- Closing an auxiliary window must use guarded close semantics for risky
  sessions and must not bypass the keep-running path.
- Persisted popout layouts must restore in a real auxiliary window with a
  fresh session, and stale bounds must be clamped to an available display.
- Non-terminal panels must remain in the main workbench.

Ordinary Electron E2E runs disable live update checks so mutable GitHub state
cannot make unrelated release validation nondeterministic.

## Selected release profile

The operator requested release publication but did not separately request a
desktop performance measurement. Repository policy does not treat a build,
package, or release request as permission to run the performance benchmark.
Release 1.0.21 therefore uses the `functional-hotfix` profile and does not
claim exact-SHA performance or 30-minute mobile-soak evidence.

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
- The desktop popout feature does not change the remote or native-host
  protocol.
- Users on 1.0.20 can discover and install 1.0.21 through the repaired updater.
- Layouts without popout groups remain valid and restore unchanged.

## Known limits and residual risk

- Only terminal panels detach. Agent Hub, files, status, settings, OpenClaw,
  and other workbench panels remain in the main window.
- The automated suite covers real Electron windows and display-bound
  calculations, but it does not exhaust every physical multi-monitor DPI,
  hot-unplug, HDR, or taskbar arrangement.
- The functional gates do not install the release through a physical Android
  device's unknown-app permission screen. Package identity, signer, digest,
  and installer-intent boundaries are covered below that physical-device seam.
- Lock and UAC secure-desktop capture and input are unsupported.
- Software SAS and Ctrl+Alt+Delete are unsupported.
- Windows 10/Home/Enterprise, domain/MDM policy, elevated service lifecycle,
  physical Android/OEM camera, TalkBack, hardware keyboard, and adverse
  physical-network paths are not fully automated by the emulator workflow.
- The operator accepted the residual risk of publishing without exact-SHA
  desktop performance and 30-minute mobile-soak measurements. This release
  makes no performance or long-soak claim.
