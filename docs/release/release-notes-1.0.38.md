# EZTerminal 1.0.38

Release identity: remote protocol v8, Android versionCode 59.

## Agent Project collaboration

Codex and Claude sessions can now join a Project with a unique alias, role and
task. The Agent Hub previews an editable Project brief before it is sent, shows
explicit lifecycle and seen state, and exposes a session-local
`ezterminal-agent` CLI for bounded list, read, prompt, wait, and merge-request
operations. Generic Agent launches and ordinary terminals keep their existing
behavior.

Project coordination is revisioned and capability-scoped. Participant state,
prompts, transcript, validation output, and capability tokens are not persisted
as Project configuration or exposed to unrelated sessions.

## Managed merge

Managed merge builds an immutable detached candidate from a clean
EZTerminal-managed source worktree and runs the Project validation commands in
a guardian-owned session. The target changes only after approval of the exact
candidate revision.

Desktop users can approve or deny a normally validated request, record a
reasoned override after failed validation, or grant one narrowly scoped next
merge. Android can approve or deny only a normally validated candidate. Project
identity, participant authority, both Git heads, worktree cleanliness, and
active runs are rechecked immediately before promotion.

## Session continuity

The Windows close button now hides the workbench while terminal and Agent
sessions continue. File and tray **Quit…** share an explicit confirmation that
those sessions will stop.

## Compatibility and artifacts

Remote protocol v8 adds revisioned Agent coordination snapshots, seen-state
updates, and normal managed-merge decisions for Android. It requires a lockstep
desktop/mobile update; v7 peers are rejected instead of silently losing merge
authority. The Electron-to-Rust native desktop protocol v2, persisted layout
schema version 1, session identity, and project document identity remain
unchanged.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.38-vc59.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath Foundation
application remains pending. The Android APK must use the existing long-term
EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. Local development
validation passed lint, typecheck, documentation, unit, OS and policy guards,
Storybook and mobile suites, Rust tests and lints, and all 121 ordinary Electron
E2E scenarios. The exact tagged SHA is rebuilt by the release workflow and must
pass its remaining packaging, signing, SBOM, manifest, and checksum gates before
a draft can be created.

This release does not run or claim the separately authorized release
performance benchmark, the opt-in two-hour desktop lifecycle soak, or the
30-minute mobile soak.

See the [1.0.38 validation policy](validation-policy-1.0.38.md).
