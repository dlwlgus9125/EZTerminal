# EZTerminal 1.0.33 validation policy and residual risk

## Release identity

- Desktop, Android and native-host product version: `1.0.33`
- Android versionCode: `54`
- Remote protocol: `v7`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.33 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository version and documentation
contracts; desktop and mobile typecheck, lint, unit, OS, Storybook, visual and
accessibility suites; ordinary zero-retry `pnpm e2e`; Rust format, test,
clippy, audit and deny; native guards; packaged Electron smoke; dependency
audit; Android lint, unit, API 29/API 35 instrumentation; signed APK identity
verification; SBOM, manifest and checksum verification.

The Codex Agent scrollback regression gates must prove:

- new and resumed EZTerminal-owned Codex commands include
  `--no-alt-screen`, preserve all configured roots and keep private provider
  identifiers out of renderer display text;
- the real Agents project New Session flow retains all 80 ordered output
  markers after terminal-height overflow in xterm's normal buffer;
- scrolling to the top reveals the earliest retained marker;
- direct terminal Codex keyboard, clipboard, recovery and force-stop behavior
  is unchanged; and
- generic alternate-screen and normal-buffer TUI scrollback behavior remains
  covered independently.

Existing protocol-v7, desktop-host v2, terminal, process-lifecycle,
project-workbench, desktop-handoff, design-system, approval-privacy,
offline-pairing, detached-window and mobile remote-session regressions remain
mandatory.

## Selected release profile

The operator requested public release publication but did not separately
request a performance measurement. A build, package, update or release request
does not authorize that benchmark.

Do not run `pnpm e2e:performance`, `e2e/release-performance.spec.ts`, set
`EZTERMINAL_RUN_RELEASE_PERFORMANCE=1`, or pass
`-RunPerformanceMeasurement` for this release. The functional-hotfix workflow
also does not run or claim the 30-minute mobile soak.

The tag workflow freezes the exact checkout SHA, rebuilds every artifact and
records `validationProfile=functional-hotfix`. Only the tag-only publish job
receives `contents: write`; it revalidates the immutable artifact, manifest,
checksums, version, SHA, APK certificate and unsigned Windows signing evidence
before creating a draft. The draft and exact assets must be inspected before
publication as the latest public GitHub release.

## Compatibility and residual risk

- Remote protocol v7 and native desktop-host protocol v2 are unchanged; no
  capability or persisted schema changes are required.
- The fix depends on a Codex CLI version that supports `--no-alt-screen`.
  Automated coverage uses a deterministic compatible executable rather than
  external credentials, so a real authenticated long conversation remains a
  manual provider check.
- Directly entered Codex and other TUI commands retain their own buffer
  semantics; the product does not globally suppress alternate-screen control
  sequences.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- Lock/UAC secure-desktop input, software SAS and Ctrl+Alt+Delete remain
  unsupported.
- This release makes no performance or 30-minute mobile-soak claim.
