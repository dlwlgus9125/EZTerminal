# EZTerminal 1.0.25

Release identity: remote protocol v7, Android versionCode 46.

## Unified session-surface lifecycle

Desktop windows and the Android client now use the same host-owned
session-surface contract. A surface that creates a session becomes its owner;
another surface can adopt the same session without gaining implicit
termination authority.

Closing an adopted surface only detaches it. Closing an owner that has active
or risky work offers terminate, keep in background, or cancel. The host
revalidates the observed run state before committing the close and fails
closed if that state changed.

Renderer reloads, crashes, navigation, and mobile reconnects release stale
surface bindings without destroying the underlying session. Reconnected
clients adopt the surviving session. The explicit session-switcher terminate
action remains available independently of surface ownership and uses the same
guarded state comparison.

## Strict adoption and restore behavior

Live and manually requested adoption now fails when the requested session is
missing. Only saved-layout restoration may create a replacement session, and
saved layouts do not persist live session identifiers.

## Protocol compatibility

Remote protocol v7 carries the shared session-surface operations. Hosts and
clients require exactly v7; v1-v6 peers are rejected instead of silently
downgrading across incompatible lifecycle semantics. The Electron-to-Rust
native desktop protocol remains v2.

## Artifacts

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.25-vc46.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath
Foundation application remains pending. The Android APK must use the existing
long-term EZTerminal release certificate.

## Release validation profile

This release uses the `full` validation profile because it changes the remote
protocol and cross-client session lifecycle. The local installer request did
not authorize a performance measurement, so no performance result is claimed.

See the [1.0.25 validation policy](validation-policy-1.0.25.md).

