# EZTerminal 1.0.25 validation policy and residual risk

## Release identity

- Desktop, Android, and native-host product version: `1.0.25`
- Android versionCode: `46`
- Remote protocol: `v7`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `full`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. A
publishable 1.0.25 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository's version contract, desktop
and mobile typecheck/lint/unit suites, ordinary `pnpm e2e`, native-host
quality gates, packaged Electron smoke tests, Android release verification,
and the approval-privacy, offline-pairing, and desktop-handoff guards.

The session-surface regressions must prove:

- owner and adopted surfaces receive distinct host-issued bindings;
- adopted close detaches without terminating the session;
- risky owner close revalidates active runs and fails closed after a state
  change;
- renderer or transport disconnect releases bindings while preserving the
  session;
- manual missing adoption fails, while saved-layout restore alone may create
  a replacement;
- workspace replacement closes all owner surfaces atomically;
- explicit session termination is ownership-independent but guarded;
- desktop and Android peers require exact remote protocol v7.

The pop-out regression must also drag one tab out of a multi-tab group and
prove that both resulting windows remain keyboard-interactive, each owns one
render overlay, and a live Codex-style xterm in the source window still
receives input.

## Selected release profile

The architecture and protocol change requires
`validation profile full`. The user requested release installation artifacts
but did not separately request a desktop performance measurement.

Do not run `pnpm e2e:performance`,
`e2e/release-performance.spec.ts`, set
`EZTERMINAL_RUN_RELEASE_PERFORMANCE=1`, or pass
`-RunPerformanceMeasurement` for this request.

Any locally assembled artifact remains a local installation build rather than
a publication-eligible final release until the clean exact-SHA evidence,
required device lanes, signing evidence, manifest, checksums, and separately
authorized performance evidence are complete.

## Compatibility and residual risk

- A v7 host rejects v1-v6 clients. Desktop and Android must be updated
  together.
- The automated lifecycle suite covers desktop and mobile authority behavior,
  but cannot prove every physical-device process-death or adverse-network
  timing combination.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- Lock/UAC secure-desktop input, software SAS, and Ctrl+Alt+Delete remain
  unsupported.
- Physical Android OEM install UI, TalkBack, hardware keyboards, and all VPN
  roaming paths are not fully automated.
- This local build makes no performance claim.
