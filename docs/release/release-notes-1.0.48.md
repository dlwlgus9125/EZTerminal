# EZTerminal 1.0.48

Release identity: remote protocol v12, Android versionCode 69.

> Publication status: this is a draft release candidate. Public distribution
> requires a separate approval.

## The Claude Agent provider accepts the Claude Code CLI you installed

An installed 1.0.47 build could not enable the Claude Agent provider. Agent
settings reported the executable as unusable, and because a provider that is
not enabled is not offered, **Claude never appeared in the New Agent draft** —
the provider dropdown showed only the remaining ready provider, or none at all.

The provider gated the installed CLI on one exact version. Claude Code updates
itself, so the version on disk was almost never the single pinned build, and
the check rejected an executable that was perfectly usable. EZTerminal now
accepts a valid stable Claude Code version at or above the `2.1.260` minimum
within the same major version, matching how Codex compatibility already works.

The bundled-binary lookup that ran ahead of that check has been removed. It
resolved a package that the installer does not ship, so it succeeded only in a
development tree and always failed inside the packaged app — which is why the
problem did not appear until an installed build was opened. Development and
packaged builds now resolve the same user-installed CLI.

The range stays fail closed. A prerelease, a version below `2.1.260`, a next
major version, unreadable version output, and a missing executable all keep the
provider unavailable. When a version is rejected, Agent settings now names the
version it found and the minimum it requires instead of reporting only that the
executable is invalid.

Launch-time drift protection is unchanged. Immediately before the Agent SDK
starts, EZTerminal still re-resolves the canonical executable path and requires
the on-disk version to equal the exact version recorded in the reviewed launch
descriptor. Because the review digest covers that version, a Claude Code update
still marks the existing review stale and asks for an explicit re-review before
the provider can launch again. Widening the eligible range does not widen what
runs without review.

## Compatibility and artifacts

Remote protocol v12, the Electron-to-Rust native desktop protocol v2, persisted
layout schema version 1, Project Map schema v2, and existing terminal and
project identities are unchanged. Desktop and Android must use the exact same
protocol version. Provider consent already stored by 1.0.47 is preserved; a
previously blocked Claude provider becomes enablable without repeating the
terms and commercial-use review.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.48-vc69.apk`

The Windows installer candidate is Authenticode `NotSigned` while the SignPath
Foundation application remains pending. The Android APK must use the existing
long-term EZTerminal release certificate.

## Release validation profile

This candidate uses the `functional-hotfix` validation profile. The exact
candidate SHA must pass the release workflow's version and documentation
contracts, focused Claude executable-compatibility coverage, desktop and mobile
typechecks and tests, Rust and Android gates, ordinary zero-retry Electron E2E,
packaged smoke, signing-state, SBOM, manifest, and checksum verification before
a draft GitHub Release is created.

No release-performance measurement, desktop lifecycle soak, or mobile soak is
run or claimed for this candidate.

See the [1.0.48 validation policy](validation-policy-1.0.48.md).
