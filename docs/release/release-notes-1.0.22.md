# EZTerminal 1.0.22

Release identity: remote protocol v6, Android versionCode 43.

## Detachable Agent Session windows

EZTerminal 1.0.22 fixes the popout behavior for Codex and Claude Agent
Session tabs. Version 1.0.21 detached terminal tabs, but its runtime and saved
layout policy rejected every `agent-session` panel before a native window
could be requested.

Drag a terminal or Agent Session tab beyond the EZTerminal window and release
it to move that same live panel into a separate frameless window. Agent
history, follow-up state, approvals, and any terminal mounted after resuming a
session remain in the same React and Dockview instance rather than being
recreated.

OpenClaw chat remains attached to the main window because its native
`WebContentsView` is owned and positioned by the main window.

## Restore and safe close

- Detached Agent Session layouts and window bounds persist across restart.
- Closing a read-only Agent Session auxiliary window closes the panel without
  creating or destroying a terminal session.
- If an Agent Session has mounted a terminal, auxiliary-window close uses the
  same guarded session-state checks, keep-running choice, and termination
  behavior as a normal terminal panel.
- A read-only Agent Session that becomes terminal-backed while a close is in
  flight is treated as a state change and fails closed.
- Existing terminal popout, safe display-bound restoration, and native window
  control behavior remain unchanged.

## Regression coverage

The packaged Windows EXE is now launched with an isolated saved Agent Session
layout and driven with real Windows cursor/button input. The release gate
requires an observed tab `dragstart`, an out-of-window `dragend`, and exactly
one auxiliary renderer window. Ordinary Electron E2E also covers Agent
Session drag, safe close, persistence, and restart restore.

## Compatibility and updates

- The remote protocol remains v6. A v6 host continues to accept supported
  v1-v6 clients and gate capabilities by negotiated version.
- The Electron-to-Rust native desktop-host protocol remains v2.
- Users on 1.0.21 can install this release through the Settings updater or
  download it directly from the official GitHub Release.

## Artifacts

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.22-vc43.apk`

The Windows installer is intentionally Authenticode `NotSigned`. The Android
APK must be signed with the existing long-term EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. It includes the
normal functional, integration, packaging, Android, Rust, security, and
supply-chain gates plus installed-layout reproduction and packaged
real-pointer Agent Session popout coverage.

The publication request did not separately authorize a performance
measurement, so this release makes no exact-SHA performance or 30-minute
mobile-soak claim.

See the [1.0.22 validation policy](validation-policy-1.0.22.md).
