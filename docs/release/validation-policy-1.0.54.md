# EZTerminal 1.0.54 validation policy and residual risk

## Release identity

- Desktop, Android and native-host version: `1.0.54`
- Android versionCode: `75`
- Remote protocol: `v12`
- Electron-to-Rust native desktop protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Version 1.0.53 is already public. This release uses a new version and increasing
Android versionCode; previous tags, assets and versioned documents remain intact.

## Publication checks

The existing Release workflow validates the exact clean source SHA before
producing release artifacts. Its gates cover version/documentation contracts,
desktop/mobile type checks and lint, repeated unit tests, dependency audits,
Rust quality checks, Android API 29/35 instrumentation, Storybook interaction,
accessibility and visual tests, desktop E2E and packaged-app smoke.

The first publication attempt stopped at the Rust dependency audit. The locked
TLS dependencies are updated to rustls 0.23.45 / rustls-webpki 0.103.15 for
RUSTSEC-2026-0285. The accompanying JavaScript audit also required js-yaml 4.3.2
(GHSA-2883-xcg3-v3hh) and Vitest 4.1.11 (GHSA-82fw-gwwq-j7x9). The Storybook browser
provider and mock function types follow Vitest's supported API; the complete
functional gates must pass with these dependencies before public promotion.

The refreshed desktop tests reproduced a Windows node-pty startup/exit race:
a resize queued before native readiness could throw later while processing
first output, outside the adapter's synchronous exception guard. The adapter
now retains only the latest pending size, applies it after native readiness,
and drops it when termination begins. Three adapter regressions were observed
failing before the fix; the original interpreter-process suite exercises the
real ConPTY path. This exception is not evidence of the full-window blackout's
root cause.

Android assembly uses production assets and the existing protected long-term
signing key. Staging verifies package identity, certificate, embedded source SHA,
Windows signing policy, SBOM and checksums. The tag workflow creates a draft only
after rechecking its immutable artifacts. Public promotion follows review of that
draft under the user's explicit public-distribution request.

The local September 18 installer is a user evaluation build, not exact-SHA
publication evidence for this version. The new workflow must pass and produce
its own release manifest. This functional-hotfix path does not run the release
performance benchmark or consume old performance/soak reports.

## Regression evidence and limits

Before version preparation, the production source inputs matched the local
render-prevention candidate. Related local unit tests and ordinary desktop E2E
covered focus transitions, graphics retention, parking/resume, effect isolation,
reduced motion, popout windows and stale lifecycle snapshots. Packaged checks
covered app.asar startup, PTY execution and a local SSH round trip.

The rendering changes retain WebGL while a visible window is unfocused, remove
whole-application flicker opacity, apply accepted native document state before
React commits, and avoid redundant Chromium background-throttling calls. Hidden
surfaces still park after the existing grace period. Optional incident diagnostics
remain disabled by default in ordinary release builds.

These are preventive changes to identified code paths. The intermittent full-window
blackout was not conclusively reproduced or attributed to one root cause, so the
tests do not certify that every GPU, driver or long-running session is unaffected.
No protocol or storage migration is introduced. Windows remains unsigned under
the existing policy; Android retains the existing release signing certificate.
