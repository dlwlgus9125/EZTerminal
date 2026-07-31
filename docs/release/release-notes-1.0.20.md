# EZTerminal 1.0.20

Release identity: remote protocol v6, Android versionCode 41.

## Desktop updater hotfix

EZTerminal 1.0.20 fixes the desktop update checker incorrectly reporting that
it could not connect to GitHub even when GitHub was reachable in a browser.

Electron can emit the request-side `close` event after the request body has
finished while the successful response is still pending. EZTerminal 1.0.19
treated that normal ordering as an immediate network failure. The updater now
waits for the response, a real request error, cancellation, or the existing
timeout.

Real network errors remain retryable failures, and all existing response-size,
redirect, timeout, cancellation, manifest, digest, and installer verification
boundaries remain unchanged.

Because the defective 1.0.19 checker cannot discover this fix, users on
1.0.19 must download and install 1.0.20 manually once from the official GitHub
Release. Update discovery works normally again after 1.0.20 is installed.

## Integrity and compatibility

- The remote protocol remains v6. A v6 host continues to accept supported
  v1-v6 clients and gate capabilities by the negotiated version.
- The Electron-to-Rust native desktop-host protocol remains v2.
- Update metadata and downloads remain restricted to the official
  `dlwlgus9125/EZTerminal` repository and approved GitHub asset hosts.
- Installation remains explicit and user controlled.

## Artifacts

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.20-vc41.apk`

The Windows installer is intentionally Authenticode `NotSigned`. The Android
APK must be signed with the existing long-term EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. It includes the
normal functional, integration, packaging, Android, Rust, security, and
supply-chain gates, plus a regression test for Electron's
close-before-response event ordering.

The publication request did not separately authorize a performance
measurement, so this release makes no exact-SHA performance or 30-minute
mobile-soak claim.

See the [1.0.20 validation policy](validation-policy-1.0.20.md).
