# EZTerminal 1.0.24

Release identity: remote protocol v6, Android versionCode 45.

## Focus after moving panes between windows

Moving a terminal pane into an already-open auxiliary window now transfers
keyboard focus to that pane's live input surface. Dockview reports the move
before an `always` renderer's destination overlay has completed its first
positioning frame; focusing immediately at that point can silently leave focus
on the document body.

EZTerminal now detects a true cross-window move and retries only until the
moved pane's owner document confirms that its live input accepted focus. Every
attempt revalidates the panel identity, owner window, active-panel state, and
per-panel move generation; work is cancelled after another move, disposal,
window closure, or a bounded timeout. The existing React tree and terminal
session are still reparented rather than recreated.

The regression creates two terminal panes, moves the first into an auxiliary
window, delays Dockview's main-realm overlay-layout frame, moves the second into
that existing window, and requires its visible command input to be focused.
That deterministic delayed-layout scenario passed twenty consecutive local
runs and the complete popout E2E file.

## Shutdown-safe token storage

Graceful shutdown now waits for secure token initialization that entered before
the runtime removed its IPC handlers. On Windows, that operation owns the
PowerShell child applying and verifying the `remote-token.json` DACL. Allowing
Electron to exit first could interrupt the ACL transaction after inherited
rules were removed but before the current-user and SYSTEM grants were restored,
which in turn could strand E2E profile cleanup.

The runtime lifecycle regression holds token persistence open and verifies that
`dispose()` cannot settle until the operation finishes. The original Electron
teardown scenario passed ten consecutive local runs after the fix.

## Release-tooling dependency security

The frozen pnpm graph now selects patched releases of `undici`, `fast-uri`,
`ip-address`, `brace-expansion`, and `postcss`. The existing compatibility
layer that lets older Electron Forge/minimatch consumers call
`brace-expansion` remains applied on top of the secure 5.0.9 release. Both the
production-only audit and the complete dependency audit report no known
vulnerabilities.

## Windows release signing readiness

This release includes the SignPath-ready build, manifest, checksum, and
signature-verification pipeline added after 1.0.23. The SignPath application is
still pending, so the version contract deliberately selects `unsigned` mode.
The workflow requires every Windows component to be `NotSigned`, records that
fact in the publication manifest, and preserves the updater's explicit
unknown-publisher confirmation instead of silently falling back from a failed
signing attempt.

## Compatibility and artifacts

- Remote protocol v6 and the Electron-to-Rust native protocol v2 are unchanged.
- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.24-vc45.apk`

The Windows installer is Authenticode `NotSigned`. The Android APK must use the
existing long-term EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. The publication
request did not separately authorize a performance measurement, so this
release makes no exact-SHA performance or 30-minute mobile-soak claim.

See the [1.0.24 validation policy](validation-policy-1.0.24.md).
