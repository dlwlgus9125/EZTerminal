# EZTerminal 1.0.30 validation policy and residual risk

## Release identity

- Desktop, Android, and native-host product version: `1.0.30`
- Android versionCode: `51`
- Remote protocol: `v7`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.30 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository version and documentation
contracts; desktop and mobile typecheck, lint, unit, OS, Storybook, visual, and
accessibility suites; ordinary zero-retry `pnpm e2e`; Rust format, test,
clippy, audit, and deny; native guards; packaged Electron smoke; dependency
audit; Android lint, unit, API 29/API 35 instrumentation; signed APK identity
verification; SBOM, manifest, and checksum verification.

The detached-window regression gates must prove:

- structured output and composer context-menu Copy use the auxiliary document's
  live selection, while composer `Ctrl+K` retains terminal semantics;
- selected plain PTY output copies on `Ctrl+C` without sending an interrupt,
  and an unselected ordinary PTY retains its existing interrupt contract;
- Quick Command Escape and Command Center placement, dismissal, and focus work
  in the invoking auxiliary window;
- terminal safety toasts, paste warnings, file-drop overlays, path insertion,
  and focus restoration stay in the invoking auxiliary window;
- `Ctrl+Tab` previews and commits the recent panel associated with the source
  window without reaching the PTY;
- Project Editor and other main-owned panels remain in the main grid when
  opened from a detached Agent Session; and
- adopted main-realm DOM nodes remain operable after Dockview moves them into
  an auxiliary document.

Existing terminal, remote-control, process-lifecycle, project-workbench,
desktop-handoff, design-system, approval-privacy, offline-pairing, and mobile
Agents scrolling regressions remain mandatory.

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
- The fixed interaction paths are exercised in packaged Electron auxiliary
  windows; unusual third-party embedded documents are outside the supported UI.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- Lock/UAC secure-desktop input, software SAS, and Ctrl+Alt+Delete remain
  unsupported.
- Physical Android unknown-app UI, OEM camera behavior, TalkBack, hardware
  keyboards, multi-monitor/HDR, and adverse physical-network paths are not
  fully automated.
- This release makes no performance or 30-minute mobile-soak claim.
