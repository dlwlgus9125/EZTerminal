# EZTerminal 1.0.29

Release identity: remote protocol v7, Android versionCode 50.

## Mobile Agents touch scrolling

The Android Agents tab now keeps its page scaffold constrained to the visible
mobile viewport. The header and horizontal filter row remain in place while
the Agents body owns vertical scrolling, so a touch drag can move through all
agent and project content from top to bottom.

Existing approval, follow-up, project, filter, and navigation controls retain
their normal tap behavior. The change uses the shared mobile page scaffold and
does not alter the desktop Agent Hub.

## Regression coverage

A deterministic production-backed Storybook surface now renders enough agent
and project content to overflow. Playwright drives real Chromium touch events
at 360x800 and 412x915 portrait viewports and a 915x412 landscape viewport. It
verifies that the inner Agents body reaches the final content, the document
does not scroll, the header and filters remain visible, a drag does not trigger
an action, and a filter still responds to a touch tap afterward.

## Compatibility and artifacts

Remote protocol v7 and the Electron-to-Rust native desktop protocol v2 are
unchanged from 1.0.28. This is a presentation-only compatibility fix and does
not change the mobile transport or persisted data contracts.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.29-vc50.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath
Foundation application remains pending. The Android APK must use the existing
long-term EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. It runs the
version, documentation, style, desktop, native, packaged, Android, Storybook,
visual, accessibility, and ordinary E2E gates without running or claiming the
separately authorized desktop performance benchmark or 30-minute mobile soak.

See the [1.0.29 validation policy](validation-policy-1.0.29.md).
