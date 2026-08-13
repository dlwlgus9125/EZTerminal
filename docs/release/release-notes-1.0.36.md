# EZTerminal 1.0.36

Release identity: remote protocol v7, Android versionCode 57.

This release supersedes the unpublished v1.0.35 tag candidate. That candidate
completed reviewable release validation, but its tagged rebuild stopped at the
dependency vulnerability gate after a new advisory became visible; no v1.0.35
GitHub Release was published.

## Transparent application icon

The canonical EZTerminal icon now uses transparent alpha outside its rounded
navy tile instead of opaque white corner pixels. The tile silhouette, interior
terminal artwork, colors, lighting and `EZ` mark are unchanged.

The same source feeds the GitHub README, the Windows executable, installer and
tray ICO, and all Android legacy, round and adaptive launcher densities. This
is an asset-only product change; terminal, project, Agent, remote-control,
protocol and persisted-state behavior are unchanged.

## Dependency gate update

The transitive build dependency `nanoid` is pinned to `3.3.18`, the first
non-vulnerable release for GHSA-2v37-7h3g-55p8. The affected dependency is in
the Vite/PostCSS development toolchain and is not part of the packaged product
runtime. Both production-only and complete dependency audits must be clean for
publication.

## Compatibility and artifacts

Remote protocol v7, the Electron-to-Rust native desktop protocol v2 and the
persisted layout schema are unchanged.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.36-vc57.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath
Foundation application remains pending. The Android APK must use the existing
long-term EZTerminal release certificate. Windows or Android launchers may
temporarily show a cached prior icon until the operating system refreshes its
icon cache.

## Release validation profile

This release uses the `functional-hotfix` validation profile. The exact tagged
SHA runs version, documentation, dependency, style, desktop, native, packaged,
Android, Storybook, visual, accessibility and ordinary E2E release gates.
Local ordinary E2E was intentionally omitted for this asset-only change; the
publishing workflow remains authoritative and does not bypass its required
functional gates.

This release does not run or claim the separately authorized release
performance benchmark, the opt-in two-hour desktop lifecycle soak, or the
30-minute mobile soak.

See the [1.0.36 validation policy](validation-policy-1.0.36.md).
