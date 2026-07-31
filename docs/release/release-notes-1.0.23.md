# EZTerminal 1.0.23

Release identity: remote protocol v6, Android versionCode 44.

## Detachable Agent Session windows

EZTerminal 1.0.23 allows Codex and Claude Agent Session tabs to detach into
auxiliary windows. Drag a terminal or Agent Session tab beyond the EZTerminal
window and release it to move that same live panel into a separate frameless
window.

The panel is reparented rather than recreated, so Agent history, follow-up
state, approvals, and a terminal mounted after resuming the session stay with
the same Dockview and React instance. OpenClaw chat remains in the main window
because its native `WebContentsView` is owned and positioned there.

This release supersedes the unpublished 1.0.22 validation candidate. The
product behavior is the same, while the packaged Windows pointer gate now
establishes a deterministic on-screen drag boundary before release.

## Restore and safe close

- Detached terminal and Agent Session layouts persist across restart.
- Closing a read-only Agent Session window closes only that panel.
- A terminal-backed Agent Session retains guarded session-state checks,
  keep-running choice, and termination behavior.
- A read-only Agent Session that becomes terminal-backed while close is in
  flight is treated as a state change and fails closed.

## Packaged Windows regression

The packaged EXE is launched with an isolated saved Agent Session layout. The
test places its real native window inside the primary Windows work area,
confirms that an observed physical `dragend` lies beyond the window's right
edge, and then requires exactly one auxiliary renderer window. This prevents a
maximized CI window from clamping the pointer back inside the application.

The corrected packaged pointer gate passed ten consecutive local runs. Ordinary
Electron E2E also covers Agent Session drag, safe close, persistence, and
restart restore.

## Compatibility and artifacts

- Remote protocol v6 and the Electron-to-Rust native protocol v2 are unchanged.
- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.23-vc44.apk`

The Windows installer is Authenticode `NotSigned`. The Android APK must use the
existing long-term EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. The publication
request did not separately authorize a performance measurement, so this
release makes no exact-SHA performance or 30-minute mobile-soak claim.

See the [1.0.23 validation policy](validation-policy-1.0.23.md).
