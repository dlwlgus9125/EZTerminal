# EZTerminal 1.0.28

Release identity: remote protocol v7, Android versionCode 49.

## Project session identity

Project-backed session tabs now use the project's display name as their
primary identity and show an explicit `Agent` or `Terminal` badge for the
active mode. The label follows project renames and user-defined project aliases
while a custom session title remains available as supplemental context.

The same mode and project identity survive layout persistence, session
history, renderer/main-process synchronization, and remote mirroring. Legacy
saved sessions without the new optional metadata continue to restore with the
existing fallback labels.

## Agent or terminal launch

The New chat action in a project now offers both Agent and Terminal. Agent
keeps the existing project-scoped agent workflow. Terminal creates a plain
interactive shell with the project root as its working directory and does not
inject an agent command.

Desktop and remote launches share the same validated launch contract. The main
process remains authoritative for the canonical session-surface target, and
malformed or conflicting target metadata is rejected before a session is
created.

## Compatibility and artifacts

Remote protocol v7 and the Electron-to-Rust native desktop protocol v2 are
unchanged from 1.0.27. The new launch and tab metadata is optional on the wire,
so existing v7 clients retain their prior generic-label fallback behavior.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.28-vc49.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath
Foundation application remains pending. The Android APK must use the existing
long-term EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. It runs the
version, documentation, style, desktop, native, packaged, Android, Storybook,
visual, accessibility, and ordinary E2E gates without running or claiming the
separately authorized desktop performance benchmark or 30-minute mobile soak.

See the [1.0.28 validation policy](validation-policy-1.0.28.md).
