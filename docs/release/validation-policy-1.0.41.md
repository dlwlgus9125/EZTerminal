# EZTerminal 1.0.41 validation policy and residual risk

## Release identity

- Desktop, Android and native-host product version: `1.0.41`
- Android versionCode: `62`
- Remote protocol: `v9`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.41 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository version, documentation, and
Project Map contracts; production-only and complete dependency audits; desktop
and mobile typecheck, lint, unit, OS, Storybook, visual and accessibility suites;
ordinary zero-retry `pnpm e2e`; Rust format, test, clippy, audit and deny; native
guards; packaged Electron smoke; Android lint, unit, API 29/API 35
instrumentation; signed APK identity verification; and SBOM, manifest, and
checksum verification.

OpenClaw lifecycle coverage must prove:

- CLI exit code 0 is insufficient: startup HTTP and authenticated status RPC
  must remain stable before running is reported;
- desired running or stopped state persists independently of the Electron
  lifetime and the per-login supervisor reconciles external state changes;
- matching active actions coalesce, conflicting generations make the latest
  request win, and a completed Restart can start a new generation;
- safe restart is bounded to 60 seconds before force, repair is limited to three
  attempts, and a new explicit Start clears the prior generation's blocked gate;
- every repair has a verified restricted backup and never deletes or resets
  state, weakens authentication, creates tokens, or installs or updates packages;
- missing or incompatible CLI, failed backup, permission denial, unrelated port
  ownership, and unknown Scheduled Task identity block with stable diagnostics;
- desktop drawer, desktop chat, remote bridge, and Android expose the same
  desired state, supervisor phase, attempt, issue, and immediate receipt; and
- packaging contains the exact reviewed supervisor script while uninstall
  removes only the exact EZTerminal-owned task and preserves user data.

Persona and Team coverage must prove:

- catalog writes validate Persona presets, provider-specific permissions and
  options, Team membership and ordering, exactly one Planner, and atomic starter
  Team creation under compare-and-swap revision;
- starting a run freezes Project purpose, run outcome and completion criteria,
  validation settings, target commit, Team, and Persona snapshots;
- only the exact bound Planner session can submit the current bounded plan, and
  no other member launches before the human approves that revision;
- approved assignments use isolated managed worktrees from the same frozen
  commit, exclusions never launch, and partial failures remain visible and
  retryable without automatic reassignment;
- restart, complete, and cancel preserve truthful terminal and worktree identity
  without inventing active sessions or deleting user work; and
- catalog and run persistence excludes transcripts, terminal output, tool calls,
  credentials, tokens, capabilities, and validation output, while Android does
  not advertise desktop-only Team controls.

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
or soak claim is made for 1.0.41.

## Compatibility and residual risk

- Remote protocol v9 requires an exact desktop/mobile match and rejects v8
  peers. Native desktop-host protocol v2 and persisted layout schema version 1
  remain compatible.
- Team launch and plan approval are desktop-only. Open Agent terminals and
  managed worktrees outlive Team tracking until the user closes or removes them.
- OpenClaw recovery depends on a compatible installed OpenClaw CLI, current-user
  Scheduled Task permission, and a port not owned by an unrelated process.
- OpenClaw provider and channel health warnings remain visible but do not block a
  gateway whose authenticated RPC is healthy.
- Automated Android lanes use API 29/API 35 emulators; physical-device and OEM
  behavior remains residual platform risk.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- This release makes no exact-SHA release-performance, two-hour desktop-soak,
  or 30-minute mobile-soak claim.
