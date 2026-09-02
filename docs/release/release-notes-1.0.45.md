# EZTerminal 1.0.45

Release identity: remote protocol v9, Android versionCode 66.

## OpenClaw late readiness is no longer overwritten as failure

This maintenance release fixes a real Start and Restart race observed against
OpenClaw 2026.8.1. The supervisor's bounded readiness loop could finish just
before the gateway became authenticated-RPC ready. Its immediately following
deep diagnostic then observed `rpc.ok=true`, but the old control flow retained
only port-conflict findings and discarded that healthy result. On the final
attempt it consequently wrote `repair-exhausted` even though the gateway was
already usable.

The deep diagnostic now returns one structured readiness assessment. An
authenticated RPC result is terminal success and records the gateway as
`running`; a verified unrelated listener remains a critical port conflict;
other unhealthy results continue through the existing backed-up, bounded
repair attempts. This does not weaken the HTTP plus authenticated-RPC health
contract or accept a process merely because the CLI start command exited zero.

The regression executes the real Windows PowerShell supervisor with a gateway
that becomes healthy only at the final deep-diagnostic boundary. Live
verification on OpenClaw 2026.8.1 also completed Restart and a full Stop → Start
cycle with final `status=running`, `supervisorState=ready`, and `issue=null`.

## Compatibility and artifacts

Remote protocol v9, Electron-to-Rust native desktop protocol v2, persisted
layout schema version 1, Project Map schema v2, and terminal and project
identities are unchanged.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.45-vc66.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath Foundation
application remains pending. The Android APK must use the existing long-term
EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. The exact tagged
SHA must pass the release workflow's repeated unit, dependency audit, Rust,
Android, Storybook, ordinary Electron E2E, packaged smoke, signing, SBOM,
manifest, and checksum gates before publication.

This release does not run or claim the separately authorized release
performance benchmark, the opt-in two-hour desktop lifecycle soak, or the
30-minute mobile soak.

See the [1.0.45 validation policy](validation-policy-1.0.45.md).
