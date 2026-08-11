# EZTerminal 1.0.33

Release identity: remote protocol v7, Android versionCode 54.

## Complete Codex Agent scrollback

Codex sessions started or resumed from Agents now run the Codex TUI in inline
mode. Output that exceeds the visible terminal height stays in xterm's normal
scrollback, so earlier and latest conversation content no longer survive with
the intervening output missing.

The change is deliberately limited to EZTerminal-owned Agent launches. Codex
commands entered directly in the terminal composer or selected through Command
Center keep the user's original arguments and TUI buffer behavior. EZTerminal
also continues to honor alternate-screen control sequences for other programs.

The regression test drives the real Agents project New Session flow with a
Codex-compatible executable, overflows the terminal with 80 ordered markers,
and requires every marker to remain in order and the first marker to be visible
after scrolling to the top. New and resumed private command builders are also
locked independently while keeping private thread identifiers out of display
text.

## Compatibility and artifacts

Remote protocol v7 and the Electron-to-Rust native desktop protocol v2 are
unchanged. The release uses the supported Codex `--no-alt-screen` option and
does not change persisted terminal, project, or history schemas.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.33-vc54.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath
Foundation application remains pending. The Android APK must use the existing
long-term EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. It runs version,
documentation, style, desktop, native, packaged, Android, Storybook, visual,
accessibility and ordinary E2E gates. It does not run or claim the separately
authorized performance benchmark or 30-minute mobile soak.

An authenticated long-running Codex conversation remains a manual provider
check because CI does not use external credentials. The automated test covers
the application-owned launch path, command flag, terminal buffer transition,
ordered retention and scroll-to-top behavior without network access.

See the [1.0.33 validation policy](validation-policy-1.0.33.md).
