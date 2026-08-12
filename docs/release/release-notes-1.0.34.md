# EZTerminal 1.0.34

Release identity: remote protocol v7, Android versionCode 55.

## Multi-window lifecycle

The main desktop window and every detached Dockview window now contribute
their native visibility, focus and minimized state to one application-wide
lifecycle snapshot. A visible inactive pane remains passive; a hidden or
minimized window crosses a 30-second grace before its terminal presentation is
parked. Interpreter runs, PTYs and session ownership remain live throughout.

A parked terminal keeps the same xterm object instead of repeatedly disposing
and recreating it. Expensive WebGL rendering, cursor animation and visual
effects are disabled, presentation scrollback is bounded to 1,000 lines, and
writes are coalesced to 4 Hz. Returning to the window restores the configured
renderer, scrollback and normal write cadence without replacing the terminal
surface or losing the running process.

## Mobile backgrounding and renderer recovery

The Android companion now treats native app backgrounding separately from a
brief page visibility change. After 30 seconds in the background it suspends
remote presentation work and connection-health churn; foregrounding resumes
the existing session through the normal reconnect and replay boundaries.

Desktop renderer failures now preserve a bounded, validated checkpoint in the
main process. Electron can reload the renderer and restore the workbench
layout, active pane, drafts and session-surface bindings while the interpreter
keeps an eligible interactive run alive through its recovery grace.

## Compatibility and artifacts

Remote protocol v7, the Electron-to-Rust native desktop protocol v2 and the
persisted layout schema are unchanged. The parked 1,000-line limit applies
only while presentation work is suspended; the user's configured active
scrollback is restored on return.

The Windows packaging toolchain replaces the vulnerable `extract-zip`
dependency with Electron's hardened `@electron-internal/extract-zip` 1.0.5
drop-in implementation. Both production and development dependency audits
must be clean before release artifacts are assembled.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.34-vc55.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath
Foundation application remains pending. The Android APK must use the existing
long-term EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. It runs version,
documentation, style, desktop, native, packaged, Android, Storybook, visual,
accessibility and ordinary E2E gates. It does not run or claim the separately
authorized release performance benchmark, the opt-in two-hour desktop
lifecycle soak, or the 30-minute mobile soak for the final release SHA.

The source includes deterministic lifecycle, parked-terminal, mobile
backgrounding and renderer-recovery regressions. Physical Android devices,
multi-monitor/HDR configurations and abrupt whole-process or OS termination
remain outside the automated release lanes.

See the [1.0.34 validation policy](validation-policy-1.0.34.md).
