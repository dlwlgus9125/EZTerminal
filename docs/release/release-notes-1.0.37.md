# EZTerminal 1.0.37

Release identity: remote protocol v7, Android versionCode 58.

## Reliable pane and window drag

Tab and empty-tab-bar drags now share one correlated transaction from drag
start through Dockview drop or out-of-window drag end. A three-tab group can
be detached, redocked, and followed by a single-tab detach without creating
duplicate auxiliary windows or losing a live terminal session.

Splitting a panel uses the exact reference panel and its owning native window.
A split invoked from an auxiliary window therefore remains in that window's
nested grid. Tab context menus also provide explicit **Move to new window**
and **Move to main window** actions when pointer drag is inconvenient.

Terminal, Agent Session, Project Editor, and OpenClaw Chat now use one shared
capability registry for detach and lifecycle behavior. Layout preflight prunes
only invalid panels and preserves valid main and popout topology.

## Cross-window surface continuity

OpenClaw Chat keeps one main-process-owned native `WebContentsView` while its
panel moves between the main and auxiliary windows. Renderer surface updates
are atomic, revisioned, sender-validated snapshots; stale snapshots cannot
move the view back to an obsolete host.

Project Editor resolves its owner document after every move and preserves
Monaco cursor, selection, scroll, and diff view state. Per-window active-panel
tracking keeps split shortcuts, focus restoration, and recent-panel actions
with the window that initiated them.

## Compatibility and artifacts

Remote protocol v7, the Electron-to-Rust native desktop protocol v2, persisted
layout schema version 1, session identity, and project document identity are
unchanged. Existing layouts remain compatible.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.37-vc58.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath
Foundation application remains pending. The Android APK must use the existing
long-term EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. Local
development validation passed lint, typecheck, documentation, unit, OS and
policy guards, plus all 121 ordinary packaged Electron E2E scenarios. The
exact tagged SHA is rebuilt by the release workflow and must pass its Rust,
Android, desktop/mobile, Storybook, visual, accessibility, packaging, signing,
SBOM, manifest and checksum gates before a draft can be created.

This release does not run or claim the separately authorized release
performance benchmark, the opt-in two-hour desktop lifecycle soak, or the
30-minute mobile soak.

See the [1.0.37 validation policy](validation-policy-1.0.37.md).
