# EZTerminal 1.0.35

Release identity: remote protocol v7, Android versionCode 56.

## Transparent application icon

The canonical EZTerminal icon now uses transparent alpha outside its rounded
navy tile instead of opaque white corner pixels. The tile silhouette, interior
terminal artwork, colors, lighting and `EZ` mark are unchanged.

The same source now feeds the GitHub README, the Windows executable, installer
and tray ICO, and all Android legacy, round and adaptive launcher densities.
This is an asset-only product change; terminal, project, Agent, remote-control,
protocol and persisted-state behavior are unchanged.

## Compatibility and artifacts

Remote protocol v7, the Electron-to-Rust native desktop protocol v2 and the
persisted layout schema are unchanged.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.35-vc56.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath
Foundation application remains pending. The Android APK must use the existing
long-term EZTerminal release certificate. Windows or Android launchers may
temporarily show a cached prior icon until the operating system refreshes its
icon cache.

## Release validation profile

This release uses the `functional-hotfix` validation profile. The exact tagged
SHA runs version, documentation, style, desktop, native, packaged, Android,
Storybook, visual, accessibility and ordinary E2E release gates. Local ordinary
E2E was intentionally omitted for this asset-only change; the publishing
workflow remains authoritative and does not bypass its required functional
gates.

This release does not run or claim the separately authorized release
performance benchmark, the opt-in two-hour desktop lifecycle soak, or the
30-minute mobile soak.

See the [1.0.35 validation policy](validation-policy-1.0.35.md).
