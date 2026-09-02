# EZTerminal 1.0.43 validation policy and residual risk

## Release identity

- Desktop, Android and native-host product version: `1.0.43`
- Android versionCode: `64`
- Remote protocol: `v9`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.43 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository version, documentation, and
Project Map contracts; production-only and complete dependency audits; desktop
and mobile typecheck, lint, unit, OS, Storybook, visual and accessibility suites;
ordinary zero-retry `pnpm e2e`; Rust format, test, clippy, audit and deny; native
guards; packaged Electron smoke; Android lint, unit, API 29/API 35
instrumentation; signed APK identity verification; and SBOM, manifest, and
checksum verification.

OpenClaw lifecycle coverage must prove:

- upgrading from v1.0.41 repairs an installed supervisor with an explicit empty
  DACL before replacing it, while a fresh task install keeps child files
  readable;
- repeated intent and runtime writes remain atomic under Windows PowerShell 5.1;
- Start and Restart allow the compatible CLI up to 90 seconds, Stop uses the
  required non-interactive force path, and readiness still requires stable HTTP
  and authenticated RPC health rather than exit code 0 alone;
- each recovery backup has its restricted inheritable ACL before sensitive
  children are created and every copied file is SHA-256 verified;
- the first repair attempt invokes supported non-interactive session and
  approval migrations only after that backup completes;
- legacy approval migration uses bounded hash-checked staging, supported stdin
  import and read-back verification, and restores the original on failure;
- recoverable failures continue through the three-attempt repair loop, while
  missing or incompatible CLI, failed backup, denied permissions, unrelated port
  ownership, and unknown Scheduled Task identity block with stable diagnostics;
- automatic recovery never deletes or resets user data, weakens authentication,
  creates tokens, or installs or updates packages; and
- packaging contains the exact reviewed supervisor script while uninstall
  removes only the exact EZTerminal-owned task and preserves user data.

The existing remote, Team, terminal, project, privacy, and persistence contracts
remain release gates and must not regress as part of this maintenance release.

## Selected release profile

The release uses the repository's `functional-hotfix` publication path. The
workflow-dispatch run creates reviewable exact-SHA artifacts. The tag workflow
freezes and rebuilds that same SHA, then records
`validationProfile=functional-hotfix`. Only the tag-only publish job receives
`contents: write`; it revalidates the immutable artifact, manifest, checksums,
version, SHA, APK certificate, and unsigned Windows signing evidence before
creating a draft.

This profile does not run `pnpm e2e:performance`, the opt-in two-hour desktop
lifecycle soak, or the 30-minute mobile soak. No exact-SHA release performance
or soak claim is made for 1.0.43.

## Compatibility and residual risk

- Remote protocol v9 is unchanged and still requires an exact desktop/mobile
  match. Native desktop-host protocol v2 and persisted layout schema version 1
  remain compatible.
- Automatic OpenClaw recovery depends on the installed CLI exposing the required
  supported lifecycle commands, current-user Scheduled Task permission, and a
  gateway port not owned by an unrelated process.
- A migration failure restores the legacy approval file and continues bounded
  repair attempts, but an unrecoverable backup or permission failure blocks
  rather than risking user state.
- OpenClaw provider and channel health warnings remain visible but do not block a
  gateway whose authenticated RPC is healthy.
- Automated Android lanes use API 29/API 35 emulators; physical-device and OEM
  behavior remains residual platform risk.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- This release makes no exact-SHA release-performance, two-hour desktop-soak,
  or 30-minute mobile-soak claim.
