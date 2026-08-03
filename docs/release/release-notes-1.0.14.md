# EZTerminal 1.0.14

Release identity: remote protocol v5, Android versionCode 35.

## Project-first Agent workspace

This release turns Agent history into a project-first workspace on desktop and
Android.

- Projects can be searched by name or path, pinned, edited, and removed as
  metadata without deleting source folders or provider-owned history.
- Session lists load only when a project is expanded. Opening a session is a
  single-click action and the newest twenty turns appear first, with older
  turns available by scrolling upward.
- The work console renders bounded safe GFM and compact tool activity without
  exposing private launcher commands.
- A failed resume retains both the transcript and the user's draft. If the
  recorded project roots no longer match, the user explicitly chooses the
  current project roots or the recorded roots.

## Project-scoped new chat

Each project can start a new terminal tab by choosing an enabled provider. The
launcher starts the agent CLI at the project path and intentionally submits no
initial prompt.

- Codex receives `--cd <primary>` and one `--add-dir <root>` for every
  additional root.
- Claude starts with the shell working directory set to the primary root and
  receives one variadic `--add-dir <root...>` for additional roots.
- Enabled generic launchers start in the primary root and receive no
  provider-specific root arguments.

The Android client provides the same project and new-chat model through a
read-only host folder picker.

## Integrity and compatibility

- Protocol v4 introduced paged Agent history. Protocol v5 adds project search
  and CRUD, launcher discovery, launch preparation, and correlated start
  results.
- A v5 host accepts supported v1-v5 clients and exposes only the capabilities
  negotiated by that client.
- The trusted host revalidates project revision, normalized roots, terminal
  session working directory, and the private launch command immediately before
  execution. The renderer and remote client receive redacted summaries only.
- Equivalent Windows path aliases resolve to the same saved Agent project
  instead of being rejected as duplicates.
- Release evidence hashing uses the runtime SHA-256 implementation and does
  not depend on PowerShell module auto-loading.
- The Electron-to-Rust native desktop-host protocol remains independently at
  v2.

## Artifacts

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.14-vc35.apk`

The Windows installer is intentionally Authenticode `NotSigned`. The Android
APK must be signed with the existing long-term EZTerminal release certificate
and match the committed SHA-256 certificate fingerprint.

## Release validation profile

The operator selected the repository's `functional-hotfix` validation profile
for 1.0.14 and explicitly directed publication without the desktop performance
benchmark. This release therefore does not claim exact-SHA performance or
30-minute mobile-soak evidence.

The tag workflow still rebuilds the exact release SHA and requires the frozen
dependency install, version contract, desktop and mobile functional suites,
Android API 29/API 35 instrumentation, Rust quality and supply-chain checks,
production-marker rejection, package smoke tests, signed APK verification,
SBOM generation, manifest validation, and checksums before it may create the
draft release.

See the [1.0.14 validation policy](validation-policy-1.0.14.md).
