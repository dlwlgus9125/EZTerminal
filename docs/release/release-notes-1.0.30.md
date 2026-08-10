# EZTerminal 1.0.30

Release identity: remote protocol v7, Android versionCode 51.

## Detached-window interaction parity

Terminal and Agent Session panes moved into an auxiliary window now retain the
same input, clipboard, overlay, and focus behavior as panes in the main window.
Structured output, composer selections, and plain PTY output all resolve their
selection from the pane's owning document. `Ctrl+C` copies a real selection;
without a selection, ordinary PTYs retain their normal interrupt behavior.
Composer `Ctrl+K` also remains a terminal editing command.

Quick Commands, Command Center, menus, popovers, dialogs, terminal safety
toasts, paste warnings, file-drop feedback, and the recent-panel switcher now
open in the window that initiated the action. Dismissal and confirmation restore
focus in that same window. Project Editor and other main-owned surfaces are
recovered to the main grid even when opened from a detached Agent Session.

The implementation handles Dockview's adopted-DOM behavior explicitly: a node
created by the main renderer can be moved into an auxiliary document while
retaining its original JavaScript prototype. Interaction checks therefore use
the live owner document and structural DOM capabilities instead of assuming
the global window realm.

## Regression coverage

Ten packaged Electron scenarios exercise the real detached-window path. They
cover structured-output Copy, composer Copy and `Ctrl+K`, selection-aware PTY
`Ctrl+C`, Quick Command Escape, Command Center placement and focus, terminal
safety toast placement, paste confirmation and focus restoration, file drag
and path insertion, `Ctrl+Tab` preview and commit, and main-owned Project Editor
routing. Unit coverage also exercises adopted nodes, document activity,
selection, menu dismissal, modal isolation, and IPC source validation.

## Compatibility and artifacts

Remote protocol v7 and the Electron-to-Rust native desktop protocol v2 are
unchanged from 1.0.29. Persisted layouts and session identities are unchanged.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.30-vc51.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath
Foundation application remains pending. The Android APK must use the existing
long-term EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. It runs version,
documentation, style, desktop, native, packaged, Android, Storybook, visual,
accessibility, and ordinary E2E gates without running or claiming the separately
authorized desktop performance benchmark or 30-minute mobile soak.

See the [1.0.30 validation policy](validation-policy-1.0.30.md).
