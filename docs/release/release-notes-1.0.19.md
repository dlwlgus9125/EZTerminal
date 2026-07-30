# EZTerminal 1.0.19

Release identity: remote protocol v6, Android versionCode 40.

## Find updates inside EZTerminal

EZTerminal now checks the latest stable GitHub Release at startup and whenever
the user requests another check.

- Desktop shows an update dot on Settings and in Settings > About.
- Android shows the same state in its connected Settings navigation and
  Connection & About page.
- Available downloads show their version, size, progress, and cancellation
  controls.
- Verified files are saved with collision-safe names under
  `Downloads/EZTerminal`.
- Installation remains a separate, explicit user action. EZTerminal never
  silently installs or restarts itself.

The current release state is owned outside the renderer, so closing and
reopening Settings does not restart a download or lose its progress.

## Verify every release boundary

Update metadata is accepted only for a non-draft, non-prerelease
`dlwlgus9125/EZTerminal` release with an exact stable version tag, official
asset names, bounded sizes, HTTPS URLs, and GitHub-published SHA-256 digests.
Redirects are limited to approved GitHub release-asset hosts.

On Windows:

- The publication-eligible `release-manifest.json` must match its own GitHub
  digest and identify the exact setup artifact.
- The installer is streamed to a private partial file, checked for exact size
  and SHA-256, and atomically published only after verification.
- The file is hashed again immediately before it is opened.
- Because the 1.0.x installer remains Authenticode `NotSigned`, opening it
  requires an explicit warning acknowledgement.

On Android:

- Native code downloads the APK into app-private cache rather than routing its
  bytes through the WebView.
- The digest, package id, version name, versionCode, and signing-certificate
  set must match before the APK is copied into public Downloads.
- Only a verified in-session content URI can be handed to Android's package
  installer.
- If unknown-app installation permission is unavailable, Android opens the
  per-app permission screen and the user must return to retry.

Failed, cancelled, mismatched, or interrupted transfers clean their partial
cache and pending Downloads entries.

## Reliable startup

Downloads-folder resolution now happens only when the user starts a download.
An unavailable shell Downloads path therefore reports a storage error at the
update card instead of preventing the first application window from opening.

## Integrity and compatibility

- The remote protocol remains v6. A v6 host continues to accept supported
  v1-v6 clients and gate capabilities by the negotiated version.
- Update discovery and download are local application capabilities and do not
  change the authenticated desktop/mobile bridge protocol.
- The Electron-to-Rust native desktop-host protocol remains independently at
  v2.

## Artifacts

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.19-vc40.apk`

The Windows installer is intentionally Authenticode `NotSigned`. The Android
APK must be signed with the existing long-term EZTerminal release certificate
and match the committed SHA-256 certificate fingerprint.

## Release validation profile

This release uses the repository's `functional-hotfix` validation profile.
The publication request did not separately authorize a desktop performance
measurement, so this release makes no exact-SHA performance or 30-minute
mobile-soak claim.

The tag workflow still rebuilds the exact release SHA and requires the frozen
dependency install, version contract, desktop and mobile functional suites,
Android API 29/API 35 instrumentation, Rust quality and supply-chain checks,
production-marker rejection, package smoke tests, signed APK verification,
SBOM generation, manifest validation, and checksums before it may create the
draft release.

See the [1.0.19 validation policy](validation-policy-1.0.19.md).
