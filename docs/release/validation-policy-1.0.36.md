# EZTerminal 1.0.36 validation policy and residual risk

## Release identity

- Desktop, Android and native-host product version: `1.0.36`
- Android versionCode: `57`
- Remote protocol: `v7`
- Electron-to-Rust native desktop-host protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and their versioned release documents remain immutable. The
1.0.36 candidate must be built from one exact clean Git SHA.

## Required non-performance gates

The exact candidate SHA must pass the repository version and documentation
contracts; production-only and complete dependency audits; desktop and mobile
typecheck, lint, unit, OS, Storybook, visual and accessibility suites; ordinary
zero-retry `pnpm e2e`; Rust format, test, clippy, audit and deny; native guards;
packaged Electron smoke; Android lint, unit, API 29/API 35 instrumentation;
signed APK identity verification; and SBOM, manifest and checksum verification.

The icon regression checks must prove:

- the canonical PNG has an alpha channel and fully transparent exterior
  corners while its interior RGB pixels remain unchanged from the previous
  canonical artwork;
- the Windows ICO contains the expected 16, 24, 32, 48, 64, 72, 96, 128 and
  256 pixel frames with alpha-capable image data;
- Android legacy, round and adaptive foreground resources are regenerated for
  ldpi through xxxhdpi, while the existing navy adaptive background and
  inset/monochrome XML contract remain intact; and
- the README continues to reference the canonical repository icon rather than
  a separate copy.

Local ordinary E2E is omitted by explicit scope for this asset-only change.
The tag workflow still runs the repository's mandatory ordinary E2E and other
functional gates before it can create a release draft.

## Selected release profile

The release uses the repository's `functional-hotfix` publication path. The
tag workflow freezes the exact checkout SHA, rebuilds every artifact and
records `validationProfile=functional-hotfix`. Only the tag-only publish job
receives `contents: write`; it revalidates the immutable artifact, manifest,
checksums, version, SHA, APK certificate and unsigned Windows signing evidence
before creating a draft.

This profile does not run `pnpm e2e:performance`, the opt-in two-hour desktop
lifecycle soak or the 30-minute mobile soak. No performance or soak claim is
made for 1.0.36.

## Compatibility and residual risk

- Product behavior, remote protocol v7, native desktop-host protocol v2 and
  persisted layout data are unchanged.
- Windows Explorer, the Start menu, taskbar or an Android launcher can retain
  a cached prior icon until the platform refreshes its cache.
- Adaptive-icon masks vary by Android launcher and OEM; the generated safe
  area is verified, but every third-party launcher mask is not automated.
- Automated Android lanes use API 29/API 35 emulators; physical-device and OEM
  launcher rendering remain residual visual risk.
- Windows remains unsigned until SignPath activation and can show an
  unknown-publisher warning.
- This release makes no exact-SHA performance, two-hour desktop-soak or
  30-minute mobile-soak claim.
