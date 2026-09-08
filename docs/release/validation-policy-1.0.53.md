# EZTerminal 1.0.53 validation policy and residual risk

## Release identity

- Desktop, Android and native-host version: `1.0.53`
- Android versionCode: `74`
- Remote protocol: `v12`
- Electron-to-Rust native desktop protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Version 1.0.52 is already public. This release uses a new version and increasing
Android versionCode; previous tags, assets and versioned documents remain intact.

## Publication checks

The existing Release workflow validates the exact clean source SHA before
producing release artifacts. Its gates cover version/documentation contracts,
desktop/mobile type checks and lint, repeated unit tests, dependency audits,
Rust quality checks, Android API 29/35 instrumentation, Storybook interaction,
accessibility and visual tests, desktop E2E and packaged-app smoke.

Android assembly uses production assets and the existing protected long-term
signing key. Staging verifies package identity, certificate, embedded source SHA,
Windows signing policy, SBOM and checksums. The tag workflow creates a draft only
after rechecking its immutable artifacts. Public promotion follows review of that
draft under the user's explicit public-distribution request.

The earlier local 1.0.52 installer is not publication evidence for this release.
The new workflow must pass and produce its own release manifest. This
`functional-hotfix` path does not consume old performance/soak reports or claim
exact-SHA release performance certification.

## Regression evidence and limits

Before the fix, the project-menu E2E reproduced a deletion dialog that remained
open after confirming deletion following an app restart. A minimal persisted
legacy-terminal fixture also reproduced `removeAgentProject` returning false
when the current process no longer owned that terminal. Both passed after the
startup recovery fix, and the full ordinary desktop E2E suite passed locally.

The recovery changes only active legacy PTY records from the previous process
to interrupted. Provider-owned sessions keep their existing recovery behavior,
and live sessions still block project deletion. Project files are preserved.
No protocol or storage migration is introduced.

Provider tests use fixtures. Physical OEM behavior, live paid-provider sessions,
TalkBack and hardware keyboard variants are not fully certified by the workflow.
Windows remains unsigned under the existing policy; Android retains the existing
release signing certificate.
