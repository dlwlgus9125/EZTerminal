# EZTerminal 1.0.21

Release identity: remote protocol v6, Android versionCode 42.

## Detachable terminal windows

EZTerminal 1.0.21 adds the terminal popout behavior that was not included in
the 1.0.20 installer.

Drag a terminal tab beyond the EZTerminal window and release it to move the
same live terminal session into a separate frameless window. The terminal is
reparented rather than recreated, so its command history, current directory,
running PTY, output, and draft input remain with it.

Detached windows include native minimize, maximize/restore, and close controls.
Terminal context menus, tab menus, dialogs, keyboard shortcuts, focus, and
theme/effect changes use the correct window and document.

## Restore and safe close

- Detached layouts and window bounds persist across restart. Restored panes
  receive fresh sessions under the existing layout-safety rules.
- Restored bounds are clamped to a usable display so a stale or disconnected
  monitor cannot strand a terminal window off screen.
- Closing an idle detached terminal closes its session normally.
- Closing a busy or otherwise risky detached terminal uses the same guarded
  keep-running or terminate decision as the main window and fails closed if
  session state changes during confirmation.
- Non-terminal workbench panels remain in the main window.

## Compatibility and updates

- The remote protocol remains v6. A v6 host continues to accept supported
  v1-v6 clients and gate capabilities by negotiated version.
- The Electron-to-Rust native desktop-host protocol remains v2.
- Users on 1.0.20 can install this release through the Settings updater or
  download it directly from the official GitHub Release.
- Update metadata, verified downloads, and explicit user-controlled
  installation retain the 1.0.20 security boundaries.

## Artifacts

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.21-vc42.apk`

The Windows installer is intentionally Authenticode `NotSigned`. The Android
APK must be signed with the existing long-term EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. It includes the
normal functional, integration, packaging, Android, Rust, security, and
supply-chain gates, plus real pointer-drag, auxiliary-window lifecycle,
restart-restore, and window-bounds regressions.

The publication request did not separately authorize a performance
measurement, so this release makes no exact-SHA performance or 30-minute
mobile-soak claim.

See the [1.0.21 validation policy](validation-policy-1.0.21.md).
