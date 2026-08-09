# EZTerminal 1.0.27

Release identity: remote protocol v7, Android versionCode 48.

## Project-specific visual contract

EZTerminal now has a root visual contract for its green-phosphor terminal and
operations-workbench identity. The contract describes how to make design
decisions without copying exact color values or interaction rules into a
second document. Navigation, responsive behavior, state handling, and
accessibility remain in the frontend UX specification; exact values remain in
the semantic token foundation; production Storybook stories and reviewed
snapshots remain the implementation evidence.

Documentation checks enforce those ownership boundaries and the required agent
reading order. A new style guard rejects raw feature palettes, terminal-only
tokens used as application chrome, unmanaged font stacks, and uncoordinated
global z-index values outside the token foundations.

## Semantic themes and active-surface evidence

Desktop and mobile chrome now use shared semantic theme roles for status RGB
channels, media canvases and overlays, fixed QR contrast, typography, shadows,
and stacking. Built-in and custom themes expose the same runtime interface.

A production-backed surface registry ties desktop and mobile navigation keys to
their Storybook evidence. Twelve deterministic mobile stories cover primary
destinations, sheets, unavailable capabilities, offline recovery, scanner
denial, history errors, and folder selection across the built-in themes. The
narrow PC-control toolbar uses two touch-safe rows so the disconnect action
remains visible, while injected camera and clock seams keep recovery states
repeatable without changing production defaults.

## Design evaluation support

The repository includes reusable blind A/B fixtures for evaluating whether the
visual contract improves agent-produced desktop recovery, mobile recovery, and
dangerous-action designs. These fixtures define the protocol and rubric; this
release does not claim results from an external agent evaluation.

## Compatibility and artifacts

Remote protocol v7 and the Electron-to-Rust native desktop protocol v2 are
unchanged from 1.0.26. Existing paired clients remain compatible.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.27-vc48.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath
Foundation application remains pending. The Android APK must use the existing
long-term EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. It runs the
version, documentation, style, desktop, native, packaged, Android, Storybook,
visual, accessibility, and ordinary E2E gates without running or claiming the
separately authorized desktop performance benchmark or 30-minute mobile soak.

See the [1.0.27 validation policy](validation-policy-1.0.27.md).
