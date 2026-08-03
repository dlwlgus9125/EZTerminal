# EZTerminal 1.0.20 validation policy and residual risk

## Release identity

- Desktop, Android, and native-host product version: `1.0.20`
- Android versionCode: `41`
- Remote client protocol: `6`
- Electron-to-Rust native desktop-host protocol: `2`
- Validation profile: `functional-hotfix`

The shipped remote protocol is v6.

The tagged 1.0.14 through 1.0.19 identities and their documentation are
immutable. The version verifier rejects reuse of an existing tag with changed
version, versionCode, protocol, or validation profile.

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

## Updater regression gates

- The real installed 1.0.19 desktop path must reproduce the reported Korean
  network-error state before the fix.
- The `ElectronUpdateHttpClient` regression must prove that a normal
  request-side `close` followed by a response succeeds.
- A real request `error` must still map to a retryable `NETWORK` failure.
- The packaged fixed application must query the live official GitHub Release
  and show the current-version state without weakening redirect, size,
  timeout, digest, or installer checks.
- Existing update tests must continue to cover metadata validation, coalesced
  checks, verified downloads, unsigned acknowledgement, integrity mismatch
  cleanup, cancellation, and unavailable Downloads paths.

Ordinary Electron E2E runs with live update checks disabled so mutable GitHub
state cannot make unrelated release validation nondeterministic. The
installed/package live-GitHub diagnosis is a separate targeted gate.

## Selected release profile

The operator requested release publication but did not separately request a
desktop performance measurement. Repository policy does not treat a build,
package, or release request as permission to run the performance benchmark.
Release 1.0.20 therefore uses the `functional-hotfix` profile and does not
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
- v3 adds Agent Attention, Git review, pairing presence, and correlated RTT;
  v4 adds paged Agent history; v5 adds project management and project-rooted
  new-chat launchers; v6 adds project/direct-directory launch targets.
- A v6 mobile client with an already stored bearer may retry once at the
  highest lower version advertised by an authenticated incompatibility reply.
- Invalid tokens, malformed replies, naked connection closes, and upward
  versions never trigger downgrade.
- One-time QR pairing requires v3 or later. Older fallback provides only the
  capabilities defined by that protocol version.

## Known limits and residual risk

- Users on 1.0.19 must manually download and install 1.0.20 once because the
  defective 1.0.19 updater cannot discover its own fix.
- The functional gates do not install the release through a physical Android
  device's unknown-app permission screen. Package identity, signer, digest,
  and installer-intent boundaries are covered below that physical-device seam.
- Lock and UAC secure-desktop capture and input are unsupported.
- Software SAS and Ctrl+Alt+Delete are unsupported.
- Windows 10/Home/Enterprise, domain/MDM policy, elevated service lifecycle,
  physical Android/OEM camera, TalkBack, hardware keyboard, HDR, multi-monitor,
  and adverse physical-network paths are not fully automated by the emulator
  release workflow.
- The operator accepted the residual risk of publishing without exact-SHA
  desktop performance and 30-minute mobile-soak measurements. This release
  makes no performance or long-soak claim.
