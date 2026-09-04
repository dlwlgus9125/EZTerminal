# EZTerminal 1.0.46

Release identity: remote protocol v11, Android versionCode 67.

## Project Lead collaboration

This release replaces the earlier Team-oriented setup with a simpler
Paseo-style collaboration flow. The user talks to one lead inside the Project,
and that lead coordinates approved Codex or Claude Code workers. Worker
profiles carry explicit permission modes, bounded concurrency and turn limits,
path allow/deny rules, structured reports, and visible run state.

The lead can request managed merge review, but EZTerminal still validates an
immutable candidate and requires the configured approval policy before moving
the target branch. Selecting a worker profile never grants broader filesystem
or merge authority by itself.

## Installed CLIs can be enabled where they are selected

Codex and Claude Code may already be installed while their EZTerminal lifecycle
hooks are not yet active. Previously, Project collaboration showed those
profiles as unavailable without offering a local recovery action; visiting the
separate Agent settings page and pressing an ambiguous `Install` button was the
only way to make them selectable.

Project collaboration now keeps each unavailable built-in profile visible,
explains the missing EZTerminal integration, and offers an explicit
`Enable integration` action beside it. A successful activation refreshes the
orchestration snapshot in place so the corresponding worker profile becomes
selectable. Blockers and write failures remain visible with a route to Agent
settings. The shared Agent settings actions are now named `Enable integration`
and `Disable integration`, making it clear that they manage EZTerminal hooks,
not the provider CLI installation.

Profile selection and the collaboration master switch remain non-mutating:
they do not silently write Codex or Claude configuration. Android shows the
same truthful unavailable state and directs host configuration to desktop.

## Compatibility and artifacts

Remote protocol v11 is required for orchestration snapshots and collaboration
policy writes. Desktop and Android must use the exact same protocol version;
older remote clients fail closed instead of receiving a partial downgrade.
Electron-to-Rust native desktop protocol v2, persisted layout schema version 1,
Project Map schema v2, and terminal and project identities are unchanged.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.46-vc67.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath Foundation
application remains pending. The Android APK must use the existing long-term
EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. The exact tagged
SHA must pass the release workflow's version and documentation contracts,
desktop and mobile typechecks and tests, Rust tests, Storybook accessibility,
ordinary Electron E2E, packaging, signing-state, SBOM, manifest, and checksum
gates before publication.

This release does not run or claim the separately authorized release
performance benchmark, the opt-in two-hour desktop lifecycle soak, or the
30-minute mobile soak.

See the [1.0.46 validation policy](validation-policy-1.0.46.md).
