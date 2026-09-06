# EZTerminal 1.0.48 validation policy and residual risk

## Release identity

- Desktop, Android and native-host product version: `1.0.48`
- Android versionCode: `69`
- Remote protocol: `v12`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`
- Publication target: draft GitHub Release only

Existing tags and their versioned release documents remain immutable. The
1.0.48 candidate must be built from one exact clean Git SHA. Publishing the
draft or promoting it to the public latest release requires separate approval.

## Required non-performance gates

The exact candidate SHA must pass the repository version, documentation, and
Project Map contracts; production dependency audits; desktop and mobile
typecheck, lint, unit and OS suites; Storybook visual and accessibility
coverage; ordinary zero-retry `pnpm e2e`; Rust format, test, clippy, audit and
deny; native guards; packaged Electron smoke; Android validation; signed APK
identity verification; and SBOM, manifest, and checksum verification.

Claude executable compatibility coverage must additionally prove:

- the `2.1.260` minimum and representative newer patch and minor versions are
  eligible, so a Claude Code installation that has auto-updated can still be
  reviewed and enabled;
- prereleases, versions below `2.1.260`, the next major version, unreadable or
  malformed version output, and a missing executable all keep the provider
  unavailable rather than launching an unverified binary;
- a rejected version is reported with the version found and the minimum
  required, so an unavailable provider is diagnosable from the settings screen
  without reading logs;
- executable resolution never depends on a package that the installer does not
  ship, so a development tree and a packaged installation resolve the same
  user-installed CLI and cannot disagree about availability;
- launch readiness still re-resolves the canonical executable path and requires
  the on-disk version to equal the reviewed launch descriptor's exact version,
  so a compatible in-place Claude Code update invalidates the stored review
  instead of silently launching an unreviewed build; and
- provider consent remains independently fail closed: an incomplete terms,
  commercial-use, or third-party approval state blocks the provider regardless
  of which compatible executable is installed.

The guard added for this release fails the build if a main-process module again
resolves an `@anthropic-ai` package at runtime, or if the executable version
gate returns to exact-equality matching.

Remote protocol coverage must continue proving that v12 rejects mismatched
clients instead of silently omitting provider, Workspace, command, Agent, or
recovery state.

## Selected release profile

The release uses the repository's `functional-hotfix` path. The tag workflow
freezes and rebuilds the exact candidate SHA. Only the tag-only publish job
receives `contents: write`; it revalidates immutable artifacts, manifest,
checksums, versions, SHA, APK certificate, and unsigned Windows signing
evidence before creating a draft release.

This profile does not run `pnpm e2e:performance`, the opt-in two-hour desktop
lifecycle soak, or the 30-minute mobile soak. No exact-SHA performance or soak
claim is made for 1.0.48.

## Compatibility and residual risk

- Accepting every stable Claude Code version at or above `2.1.260` in the same
  major removes routine version-only rejection but cannot predict an upstream
  break inside that range. The pinned Agent SDK is validated against `2.1.260`;
  a newer CLI that changes the `stream-json` argument contract can still require
  a Claude Code downgrade or an EZTerminal adapter update. Launch preflight and
  reviewed-descriptor validation stop known identity drift, not unknown
  behavioral drift.
- Automated coverage proves executable resolution, the version range, and the
  review and launch gates. A live Claude prompt is not submitted by
  deterministic CI, so end-to-end provider execution against a paid account is
  verified manually on the candidate build and is not claimed as a CI gate.
- Provider availability still depends on a compatible local Codex or Claude
  Code installation and the user's provider authentication.
- Provider enablement, authentication guidance, executable review, and adapter
  trust remain desktop-only. Android creation depends on the connected desktop
  authority and a current daemon snapshot.
- Using an existing claude.ai login or its subscription rate limits inside a
  third-party product requires prior Anthropic approval. EZTerminal does not
  start that login flow, does not read or store tokens, and surfaces the
  requirement as a required review notice; the consent record is the operator's
  own attestation.
- Remote protocol v12 requires matching desktop and Android clients. Native
  desktop-host protocol v2 and persisted layout schema version 1 are unchanged.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- Relay, voice, an external Hub, and multi-user accounts remain excluded.
- This candidate makes no release-performance or lifecycle-soak claim.
