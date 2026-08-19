# EZTerminal 1.0.39

Release identity: remote protocol v8, Android versionCode 60.

## Agent session lifecycle cleanup

The Agent Hub now removes an activity and its Focus target when the activity's
owning terminal session is actually destroyed. Cleanup covers both live and
completed activities, run and provider-session indexes, pending approval gates,
and observation ports.

Delayed run discovery can no longer recreate an Agent activity after its
terminal session has disappeared. Late provider events for the removed session
are ignored, while activities belonging to other live sessions are preserved.

## Session continuity

Closing a pane with **Terminate** removes the pane, broker session, Agent row,
and Focus action together. Choosing **Keep running** intentionally preserves the
session and Agent row; the background session remains reclaimable from the
Command Center.

The Agent Hub Focus action still requires an existing pane binding. For a live
Agent left in the background with **Keep running**, use the Command Center to
reopen the session. A direct Focus-to-reopen fallback is not included in this
hotfix.

## Compatibility and artifacts

Remote protocol v8, the Electron-to-Rust native desktop protocol v2, persisted
layout schema version 1, and project document identity are unchanged.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.39-vc60.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath Foundation
application remains pending. The Android APK must use the existing long-term
EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. Local development
validation passed lint, typecheck, documentation, unit, OS and policy guards,
and all 122 ordinary Electron E2E scenarios. The exact tagged SHA is rebuilt by
the release workflow and must pass its remaining desktop, mobile, Rust,
packaging, signing, SBOM, manifest, and checksum gates before a draft can be
created.

This release does not run or claim the separately authorized release
performance benchmark, the opt-in two-hour desktop lifecycle soak, or the
30-minute mobile soak.

See the [1.0.39 validation policy](validation-policy-1.0.39.md).
