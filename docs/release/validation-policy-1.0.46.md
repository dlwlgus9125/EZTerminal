# EZTerminal 1.0.46 validation policy and residual risk

## Release identity

- Desktop, Android and native-host product version: `1.0.46`
- Android versionCode: `67`
- Remote protocol: `v12`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.46 candidate must be built from one exact clean Git SHA before publication.

## Required non-performance gates

The exact candidate SHA must pass the repository version, documentation, and
Project Map contracts; production dependency audits; desktop and mobile
typecheck, lint, unit and OS suites; Storybook visual/accessibility coverage;
ordinary zero-retry `pnpm e2e`; Rust format, test, clippy, audit and deny;
native guards; packaged Electron smoke; Android validation; signed APK identity
verification; and SBOM, manifest, and checksum verification.

Project Lead collaboration coverage must additionally prove:

- a project exposes one lead-facing collaboration policy and only explicitly
  allowed worker profiles;
- unavailable Codex and Claude Code profiles remain visible and identify the
  missing EZTerminal integration instead of claiming that the CLI is absent;
- desktop offers a provider-scoped, explicit integration action and refreshes
  the profile availability after the existing hook installer succeeds;
- profile selection and the collaboration master switch never install hooks or
  mutate provider configuration implicitly;
- integration blockers and write failures remain visible and fail closed;
- Android reports that activation is desktop-only and does not expose a fake
  host-configuration action;
- permission modes, path rules, concurrency, turn budgets, structured worker
  reports, cancellation, and managed merge approval remain enforced at service
  boundaries rather than only in the renderer; and
- remote protocol v12 rejects older clients instead of silently omitting
  orchestration or collaboration-policy data.

## Selected release profile

The release uses the repository's `functional-hotfix` publication path. The tag
workflow freezes and rebuilds the exact candidate SHA. Only the tag-only publish
job receives `contents: write`; it revalidates immutable artifacts, manifest,
checksums, versions, SHA, APK certificate, and unsigned Windows signing evidence
before creating a draft release.

This profile does not run `pnpm e2e:performance`, the opt-in two-hour desktop
lifecycle soak, or the 30-minute mobile soak. No exact-SHA performance or soak
claim is made for 1.0.46.

## Compatibility and residual risk

- Remote protocol v12 requires matching desktop and Android clients. Native
  desktop-host protocol v2 and persisted layout schema version 1 are unchanged.
- Enabling a provider integration writes only EZTerminal-owned lifecycle hooks
  through the existing backup and drift checks. Provider trust prompts or
  external configuration blockers can still require manual review.
- Worker availability still depends on a compatible local Codex or Claude Code
  executable being discoverable by the packaged desktop process.
- Android can inspect collaboration state but intentionally cannot mutate
  desktop provider integrations.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- This release makes no release-performance or lifecycle-soak claim.
