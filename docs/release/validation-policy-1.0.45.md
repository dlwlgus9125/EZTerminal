# EZTerminal 1.0.45 validation policy and residual risk

## Release identity

- Desktop, Android and native-host product version: `1.0.45`
- Android versionCode: `66`
- Remote protocol: `v9`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.45 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository version, documentation, and
Project Map contracts; production-only and complete dependency audits; desktop
and mobile typecheck, lint, unit, OS, Storybook, visual and accessibility suites;
ordinary zero-retry `pnpm e2e`; Rust format, test, clippy, audit and deny; native
guards; packaged Electron smoke; Android lint, unit, API 29/API 35
instrumentation; signed APK identity verification; and SBOM, manifest, and
checksum verification.

OpenClaw lifecycle coverage must additionally prove:

- the normal readiness path still requires stable `/startupz` and authenticated
  RPC success rather than CLI exit code or port ownership alone;
- a bounded deep diagnostic that observes authenticated `rpc.ok=true` becomes
  terminal `running` instead of being overwritten by final
  `repair-exhausted`;
- the same diagnostic still blocks a verified unrelated port owner and does not
  weaken missing-CLI, backup, permission, or task-identity critical failures;
- the real Windows PowerShell supervisor regression crosses the final
  late-ready boundary without invoking another repair; and
- a live OpenClaw 2026.8.1 Restart and Stop → Start cycle finish with
  `desiredState=running`, physical `status=running`, `supervisorState=ready`,
  no active operation, and no issue.
- transport-ready OpenClaw with a retired workspace setup file is not accepted
  as functionally ready before migration;
- the workspace source is included in a restricted, SHA-256-verified recovery
  backup before the gateway is stopped or Doctor is invoked;
- Doctor runs only after the gateway releases SQLite, and Start resumes only
  after both the source and any interrupted claim are absent; and
- the exact live OpenClaw 2026.8.1 failure is replayed through the new
  supervisor path and an actual agent turn returns `OK` afterward while the
  EZTerminal host process remains alive.

Mobile OpenClaw chat coverage must additionally prove:

- a running OpenClaw 2026.8.1 gateway with the retired
  `gateway.controlUi.allowInsecureAuth` key absent can still mint a one-time
  proxy ticket;
- the retired setting is neither read nor written by the ticket path;
- stopped and unreachable gateways, missing tokens, proxy failures, and a
  desktop runtime that exits during proxy startup remain fail-closed; and
- the exact installed-build remote request that previously returned
  `insecure-auth-required` returns a ticket without exposing its token in
  diagnostic output.

All v1.0.44 ACL repair, atomic persistence, verified backup, supported migration,
bounded process, forced Stop, and optional Scheduled Task contracts remain
release gates.

## Selected release profile

The release uses the repository's `functional-hotfix` publication path. The tag
workflow freezes and rebuilds the exact candidate SHA. Only the tag-only publish
job receives `contents: write`; it revalidates immutable artifacts, manifest,
checksums, versions, SHA, APK certificate, and unsigned Windows signing evidence
before creating a draft release.

This profile does not run `pnpm e2e:performance`, the opt-in two-hour desktop
lifecycle soak, or the 30-minute mobile soak. No exact-SHA performance or soak
claim is made for 1.0.45.

## Compatibility and residual risk

- Remote protocol v9, native desktop-host protocol v2, and persisted layout
  schema version 1 remain compatible.
- Automatic recovery still depends on a compatible installed OpenClaw CLI,
  current-user Scheduled Task permission, and a gateway port not owned by an
  unrelated process.
- OpenClaw can need more than one bounded attempt while its Windows Scheduled
  Task and authenticated RPC become observable; the UI exposes the active phase
  and attempt instead of reporting early success.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- This release makes no release-performance or lifecycle-soak claim.
