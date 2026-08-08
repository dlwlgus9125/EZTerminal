# EZTerminal 1.0.26 validation policy and residual risk

## Release identity

- Desktop, Android, and native-host product version: `1.0.26`
- Android versionCode: `47`
- Remote protocol: `v7`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.26 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository version contract; desktop and
mobile typecheck, lint, unit, OS, Storybook, visual, and accessibility suites;
ordinary zero-retry `pnpm e2e`; Rust format, test, clippy, audit, and deny;
native guards; packaged Electron smoke; dependency audit; Android lint, unit,
API 29/API 35 instrumentation; signed APK identity verification; SBOM,
manifest, and checksum verification.

The process-lifecycle regression must prove:

- graceful app quit drains an external process, its child, and grandchild;
- abrupt Electron main exit causes the independent Windows guardian to remove
  the same nested tree;
- session and PTY cleanup waits for physical teardown before acknowledging;
- a process that exited naturally is not targeted later through a reused PID;
- script hosts are assigned to their guardian group before receiving work;
- browser, editor, and Explorer handoffs are launched outside the application
  Job Object.

The project workbench, profile selection, chunk loading, desktop handoff,
approval privacy, and offline-pairing regressions remain mandatory.

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
- The Job Object guarantee applies to process trees started by 1.0.26. The app
  intentionally does not scan for or terminate older unrelated processes by
  executable name or stale PID.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- Lock/UAC secure-desktop input, software SAS, and Ctrl+Alt+Delete remain
  unsupported.
- Physical Android unknown-app UI, OEM camera behavior, TalkBack, hardware
  keyboards, multi-monitor/HDR, and adverse physical-network paths are not
  fully automated.
- This release makes no performance or 30-minute mobile-soak claim.
