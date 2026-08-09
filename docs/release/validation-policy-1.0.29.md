# EZTerminal 1.0.29 validation policy and residual risk

## Release identity

- Desktop, Android, and native-host product version: `1.0.29`
- Android versionCode: `50`
- Remote protocol: `v7`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.29 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository version and documentation
contracts; desktop and mobile typecheck, lint, unit, OS, Storybook, visual, and
accessibility suites; ordinary zero-retry `pnpm e2e`; Rust format, test,
clippy, audit, and deny; native guards; packaged Electron smoke; dependency
audit; Android lint, unit, API 29/API 35 instrumentation; signed APK identity
verification; SBOM, manifest, and checksum verification.

The mobile Agents regression gates must prove:

- production-backed agent and project content creates a deterministic vertical
  overflow at 360x800, 412x915, and 915x412;
- real touch-drag input scrolls the Agents body from the top to its final
  content without moving the document or activating a control;
- the Agents header and horizontal filter row remain visible while the body
  scrolls, and a filter still accepts a touch tap after the drag;
- the ordinary non-overflow Agents state, mobile Home scaffold, desktop Agent
  Hub, approval actions, follow-up composer, and project controls retain their
  existing contracts.

Existing terminal, remote-control, process-lifecycle, project-workbench,
desktop-handoff, design-system, approval-privacy, and offline-pairing
regressions remain mandatory.

## Selected release profile

The operator requested public release publication but did not separately
request a desktop performance measurement. Repository policy does not treat a
build, package, update, or release request as permission to run the performance
benchmark.

Do not run `pnpm e2e:performance`, `e2e/release-performance.spec.ts`, set
`EZTERMINAL_RUN_RELEASE_PERFORMANCE=1`, or pass
`-RunPerformanceMeasurement` for this release. The functional-hotfix workflow
also does not run or claim the 30-minute mobile soak.

The tag workflow freezes the exact checkout SHA, rebuilds all artifacts, and
records `validationProfile=functional-hotfix`. Only the tag-only publish job
receives `contents: write`; it revalidates the immutable build artifact,
manifest, checksums, version, SHA, APK certificate, and unsigned Windows
signing evidence before creating a draft release. The draft must be inspected
before it is made public.

## Compatibility and residual risk

- Remote protocol v7 and native desktop-host protocol v2 are unchanged.
- The fix is exercised with Chromium touch input and hosted API 29/API 35
  instrumentation; physical Android/OEM WebView behavior is not fully
  automated.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- Lock/UAC secure-desktop input, software SAS, and Ctrl+Alt+Delete remain
  unsupported.
- Physical Android unknown-app UI, OEM camera behavior, TalkBack, hardware
  keyboards, multi-monitor/HDR, and adverse physical-network paths are not
  fully automated.
- This release makes no performance or 30-minute mobile-soak claim.
