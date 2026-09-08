# EZTerminal 1.0.52 validation policy and residual risk

## Release identity

- Desktop, Android and native-host version: `1.0.52`
- Android versionCode: `73`
- Remote protocol: `v12`
- Electron-to-Rust native desktop protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Version 1.0.51 is already public. This release uses a new version and increasing
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

The earlier `1.0.51` local installer receipt is not publication evidence for this
release. The new workflow must pass and produce its own release manifest. This
`functional-hotfix` path does not consume old performance/soak reports or claim
exact-SHA release performance certification.

## Refactor evidence and limits

Development validation of the refactor covered IPC cleanup, remote request
lifetimes, reconnection, UI continuity and public API preservation. The measured
development product preceded this release identity change. Its desktop benchmark
comparisons were within the existing 5% p95 allowance.

The original short-window Android heap comparison showed a +5.90% endpoint
difference. Investigation preserved that failure and examined ongoing allocation,
retained heap and sampling timing. A fixed additional full-workload pair with
unforced 121-sample observation windows showed -0.14% initial and +2.74% final
median differences; existing leak checks passed. That pair represents one process
run per product. Sampling-phase sensitivity is the engineering interpretation,
not identification of the exact historical extra bytes or a guarantee for every
subwindow, device or workload. These results are development context, not a
replacement for this release's workflow checks.

Provider tests use fixtures. Physical OEM behavior, live paid-provider sessions,
TalkBack and hardware keyboard variants are not fully certified by the workflow.
Windows remains unsigned under the existing policy; Android retains the existing
release signing certificate. No protocol or storage migration is introduced.
