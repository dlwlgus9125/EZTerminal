# EZTerminal 1.0.26

Release identity: remote protocol v7, Android versionCode 47.

## Reliable process ownership

EZTerminal now starts a native Windows Job Object guardian before it starts
the interpreter or accepts terminal work. Electron main, interpreter utility
processes, PTYs, script hosts, and their arbitrary descendants are placed under
one root ownership boundary, with smaller groups for session-level cleanup.

Normal shutdown first freezes new work and drains sessions, PTYs, and script
hosts. A bounded deadline then terminates anything that did not acknowledge
cleanup. If Electron main exits abruptly, the independent guardian closes the
root Job and Windows removes the entire remaining descendant tree without
depending on executable names or a startup PID scan.

Browser, editor, and Explorer launches use an explicit shell handoff outside
the application Job so user-opened applications continue running after
EZTerminal exits. Cleanup also checks natural process exit before invoking a
tree kill, avoiding a delayed kill against a reused PID.

## Integrated project workbench

The project workspace brings changed files, exact Git diffs, read-only source
review, and project-scoped agent sessions into one responsive surface. Narrow
layouts reuse the same editor and preserve live PTY state instead of creating
parallel review surfaces.

## Resource profiles and responsiveness

Balanced, Low resource, and High responsiveness profiles control optional
feature preload and polling behavior without weakening correctness or safety
timeouts. Optional desktop and mobile destinations load through retryable
chunks, while overlapping polling and unstable pane registrations were
replaced with event-driven or settle-then-schedule work.

`pnpm profile:runtime` remains a developer diagnostic for startup, working set,
and renderer chunks. It is not release evidence and this release makes no
performance benchmark claim.

## Compatibility and artifacts

Remote protocol v7 and the Electron-to-Rust native desktop protocol v2 are
unchanged from 1.0.25. Existing processes left behind by an older build are not
located or terminated by executable-name scanning; the ownership guarantee
applies to process trees started by this release.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.26-vc47.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath
Foundation application remains pending. The Android APK must use the existing
long-term EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. It runs the
version, dependency, desktop, native, packaged, and Android functional gates
without running or claiming the separately authorized desktop performance
benchmark or 30-minute mobile soak.

See the [1.0.26 validation policy](validation-policy-1.0.26.md).
