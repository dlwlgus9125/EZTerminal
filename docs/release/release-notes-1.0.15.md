# EZTerminal 1.0.15

Release identity: remote protocol v6, Android versionCode 36.

## Clear Agent identity

Codex and Claude history can now be distinguished at a glance without relying
on colour alone.

- Desktop history rows and opened history surfaces show a visible provider
  label plus an accessible provider-coloured start rail.
- Android project history and history sheets use the same identity treatment.
- Codex uses teal and Claude uses coral, with dedicated dark, light, Matrix,
  and high-contrast values that preserve text and non-text contrast.
- Live Agent state and approval colours remain provider-neutral so identity
  does not compete with operational status.

## Choose the Agent and launch location

Starting a fresh Agent session now uses one shared picker on desktop and
Android.

- The global action requires both an enabled Agent and either a saved/observed
  project or a direct host directory.
- A project card's New chat action opens the same picker with only that project
  preselected, leaving the Agent choice explicit.
- Desktop uses the native directory picker. Android browses the connected host
  through the existing read-only folder browser.
- Codex and Claude receive the effective project roots. Generic launchers use
  the primary root and disclose any additional roots they cannot consume.
- A successful direct-directory launch promotes the canonical directory to an
  unpinned observed project. Cancelling or failing the launch writes no project
  metadata.

Projects now appear before Active and Recent activity so users choose a
location before working with live or historical session state.

## Integrity and compatibility

- Protocol v6 adds target-neutral project/direct-directory launch preparation
  and correlated start results.
- A v6 host accepts supported v1-v6 clients and gates capabilities by the
  negotiated version. The protocol-v5 project launch messages remain available
  for older clients.
- The trusted host revalidates the target, canonical directory, launcher
  availability, roots, revision, terminal session, and private command
  immediately before execution.
- A recoverable launch failure keeps the user's Agent and location selections
  without claiming that a terminal was started.
- The Electron-to-Rust native desktop-host protocol remains independently at
  v2.

## Artifacts

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.15-vc36.apk`

The Windows installer is intentionally Authenticode `NotSigned`. The Android
APK must be signed with the existing long-term EZTerminal release certificate
and match the committed SHA-256 certificate fingerprint.

## Release validation profile

This release uses the repository's `functional-hotfix` validation profile.
The publication request did not separately authorize a desktop performance
measurement, so this release makes no exact-SHA performance or 30-minute
mobile-soak claim.

The tag workflow still rebuilds the exact release SHA and requires the frozen
dependency install, version contract, desktop and mobile functional suites,
Android API 29/API 35 instrumentation, Rust quality and supply-chain checks,
production-marker rejection, package smoke tests, signed APK verification,
SBOM generation, manifest validation, and checksums before it may create the
draft release.

See the [1.0.15 validation policy](validation-policy-1.0.15.md).
