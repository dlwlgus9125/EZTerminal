# EZTerminal 1.0.44

Release identity: remote protocol v9, Android versionCode 65.

## OpenClaw starts and restarts reliably

This maintenance release fixes the recoverable failures that could leave an
OpenClaw Start or Restart request stopped.

v1.0.41 could recursively remove inherited access entries from the installed
supervisor script. The current release repairs the existing state-directory ACL
from the packaged source script before replacing or re-registering the
supervisor. New installs protect the directory without stripping access from
its children.

Windows PowerShell 5.1 rejects a null backup path for atomic file replacement.
Supervisor intent and runtime snapshots now use a same-directory temporary
backup, preserving atomic updates across repeated state transitions.

OpenClaw 2026.8.1 can require legacy session and exec-approval migration while
its generic non-interactive doctor path still exits without completing those
migrations. EZTerminal creates the restricted recovery-backup directory before
writing any sensitive child, copies and SHA-256-verifies the recovery material,
then invokes the supported session SQLite importer and imports legacy exec
approvals through the supported stdin command. SHA-256 verification uses the
Windows PowerShell 5.1/.NET cryptography API directly and does not depend on an
optional PowerShell module. Approval staging is bounded to 4 MiB, hash-checked,
removed after verification, and moved back to its original location if import
fails.

The optional `OpenClaw Gateway` Scheduled Task is captured through a bounded
process call when present. A normal “task not found” result no longer becomes a
terminating PowerShell stderr exception or prevents the data backup.

Gateway Start, Stop, and Restart commands receive a 90-second bounded window.
Non-interactive Stop uses the CLI's required force option. Recoverable failures
continue through the existing three-attempt diagnosis and repair loop; only
critical conditions such as a missing or incompatible CLI, failed backup,
denied permission, or unrelated port/task ownership produce a blocked result.

## Compatibility and artifacts

Remote protocol v9, Electron-to-Rust native desktop protocol v2, persisted
layout schema version 1, Project Map schema v2, and terminal and project
identities are unchanged.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.44-vc65.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath Foundation
application remains pending. The Android APK must use the existing long-term
EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. Development
validation passed documentation and Project Map checks, lint, typecheck, 2,468
desktop unit checks, 37 OS boundary checks and policy guards, and all 127
ordinary Electron E2E scenarios. The OpenClaw regression suite executes the
real Windows PowerShell supervisor against isolated ACL and fake-CLI boundaries.

The exact tagged SHA must still pass the release workflow's Rust, Android,
desktop/mobile, packaged smoke, signing, SBOM, manifest, and checksum gates
before publication.

This release does not run or claim the separately authorized release
performance benchmark, the opt-in two-hour desktop lifecycle soak, or the
30-minute mobile soak.

See the [1.0.44 validation policy](validation-policy-1.0.44.md).
