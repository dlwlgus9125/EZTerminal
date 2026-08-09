# EZTerminal 1.0.27 validation policy and residual risk

## Release identity

- Desktop, Android, and native-host product version: `1.0.27`
- Android versionCode: `48`
- Remote protocol: `v7`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.27 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository version and documentation
contracts; desktop and mobile typecheck, lint, unit, OS, Storybook, visual, and
accessibility suites; ordinary zero-retry `pnpm e2e`; Rust format, test,
clippy, audit, and deny; native guards; packaged Electron smoke; dependency
audit; Android lint, unit, API 29/API 35 instrumentation; signed APK identity
verification; SBOM, manifest, and checksum verification.

The design-system regression gates must prove:

- `DESIGN.md`, the frontend UX specification, semantic tokens, and Storybook
  evidence retain distinct, linked ownership;
- feature styles cannot introduce raw palettes, terminal-only application
  chrome, unmanaged font stacks, or uncoordinated global z-indexes;
- every registered desktop and mobile navigation surface maps to maintained
  production Storybook evidence;
- all built-in themes expose the required semantic and RGB roles;
- the twelve active mobile states remain bounded, accessible, deterministic,
  and free of horizontal overflow at the supported compact viewport;
- the narrow PC-control toolbar keeps all actions visible and touch-safe.

Existing terminal, remote-control, process-lifecycle, project-workbench,
desktop-handoff, approval-privacy, and offline-pairing regressions remain
mandatory.

## Selected release profile

The operator requested release publication but did not separately request a
desktop performance measurement. Repository policy does not treat a build,
package, update, or release request as permission to run the performance
benchmark.

Do not run `pnpm e2e:performance`, `e2e/release-performance.spec.ts`, set
`EZTERMINAL_RUN_RELEASE_PERFORMANCE=1`, or pass
`-RunPerformanceMeasurement` for this release.

The tag workflow freezes the exact checkout SHA, rebuilds all artifacts, and
records `validationProfile=functional-hotfix`. Only the tag-only publish job
receives `contents: write`; it revalidates the immutable build artifact,
manifest, checksums, version, SHA, APK certificate, and unsigned Windows
signing evidence before creating a draft release.

## Compatibility and residual risk

- Remote protocol v7 is unchanged; v1-v6 clients remain incompatible with the
  v7 session-surface contract.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- Lock/UAC secure-desktop input, software SAS, and Ctrl+Alt+Delete remain
  unsupported.
- Physical Android unknown-app UI, OEM camera behavior, TalkBack, hardware
  keyboards, multi-monitor/HDR, and adverse physical-network paths are not
  fully automated.
- The blind A/B design-evaluation fixtures are repeatable scaffolding, not
  evidence that an external agent study has been executed.
- This release makes no performance or 30-minute mobile-soak claim.
