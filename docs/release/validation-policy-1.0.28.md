# EZTerminal 1.0.28 validation policy and residual risk

## Release identity

- Desktop, Android, and native-host product version: `1.0.28`
- Android versionCode: `49`
- Remote protocol: `v7`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.28 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository version and documentation
contracts; desktop and mobile typecheck, lint, unit, OS, Storybook, visual, and
accessibility suites; ordinary zero-retry `pnpm e2e`; Rust format, test,
clippy, audit, and deny; native guards; packaged Electron smoke; dependency
audit; Android lint, unit, API 29/API 35 instrumentation; signed APK identity
verification; SBOM, manifest, and checksum verification.

The project-session regression gates must prove:

- a project's New chat action offers both Agent and Terminal without changing
  the existing agent launch behavior;
- project terminal sessions start at the selected project root without an
  injected agent command;
- project tabs retain the project display name and expose the correct Agent or
  Terminal badge in visual and accessible labels;
- project renames, aliases, custom session titles, layout persistence, and
  history restoration preserve the canonical session-surface identity;
- direct desktop and remote/mobile launches apply the same strict target
  validation and do not create duplicate or mode-confused surfaces.

Existing terminal, remote-control, process-lifecycle, project-workbench,
desktop-handoff, design-system, approval-privacy, and offline-pairing
regressions remain mandatory.

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
- Older v7 clients ignore the optional project launch-mode metadata and can
  display their existing generic tab labels until upgraded.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- Lock/UAC secure-desktop input, software SAS, and Ctrl+Alt+Delete remain
  unsupported.
- Physical Android unknown-app UI, OEM camera behavior, TalkBack, hardware
  keyboards, multi-monitor/HDR, and adverse physical-network paths are not
  fully automated.
- This release makes no performance or 30-minute mobile-soak claim.
