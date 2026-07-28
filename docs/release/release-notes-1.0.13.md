# EZTerminal 1.0.13

Release identity: remote protocol v3, Android versionCode 34.

## Desktop handoff completion

This release completes the two desktop UI handoff packages against the real
Electron, Dockview, PTY, remote bridge, agent, Git, and OpenClaw integrations.
The package-2 prototype is the visual and interaction reference, while
security, data integrity, terminal semantics, accessibility, and truthful
runtime state take precedence over simulated prototype data.

- The four-zone header uses a contextual `Ctrl/Cmd+K` Command Center shortcut.
  Terminal, composer, and editable controls retain their native `Ctrl+K`
  behavior; `Ctrl/Cmd+Shift+P` remains the global compatibility shortcut.
- Matrix presentation uses a persisted `FX·NEON` level from 0 through 10, with
  reduced-motion and high-contrast overrides.
- Agent Hub, Monitor, Remote, expiring QR pairing, OpenClaw, dialogs, Settings,
  English mode, and Explorer are backed by their real product services.
- The 1+2, 2x1, and single-pane layouts preserve live sessions, drafts, PTYs,
  and restorable Dockview state.

## Mobile QR pairing

- Opening the QR scanner from the disconnected mobile screen no longer drops
  the React root into a black screen when the navigation layer is unavailable.
- The camera preview owns the full viewport, verifies a usable live frame, and
  fails closed when playback, decoding, or the camera track becomes unusable.
- Android Home, activity pause, Android Back, and unmount paths release the
  camera exactly once. Returning to the app does not reacquire it until the
  user explicitly opens the scanner again, and keyboard focus returns to the
  scan trigger when the sheet closes.

## Integrity and compatibility

- Every approval carries an opaque request id. A stale desktop or mobile
  decision cannot settle a newer request for the same agent activity.
- A one-time pairing code is consumed only when authentication can commit.
  Protocol-invalid and concurrent losing attempts do not burn the code.
- Approval Git review includes bounded tracked, staged, unstaged, and textual
  untracked changes. Truncation, binary files, symlinks, oversized files, and
  Git failures are shown explicitly.
- Protocol v3 adds agent decisions, Git review, device presence, and correlated
  RTT probes. A stored bearer may make one authenticated downgrade to the
  highest common v1/v2 protocol for core terminal compatibility. One-time QR
  pairing and v3-only surfaces do not pretend to work with a v2 host.
- The Electron-to-Rust native desktop-host protocol remains independently at
  v2.

## Artifacts

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.13-vc34.apk`

The Windows installer is intentionally Authenticode `NotSigned`. The Android
APK must be signed with the existing long-term EZTerminal release certificate
and match the committed SHA-256 certificate fingerprint.

## Candidate status

The local 1.0.13 candidate runs all non-performance release lanes and records
the desktop performance benchmark as
`pending-final-release-measurement`. It is not publication-eligible. A final
draft release still requires an exact-SHA passing performance report collected
only after an explicit performance-measurement request.

Final approval uses one protected evidence ZIP containing exactly
`local-rc-report.json`, `mobile-soak-report.json`,
`desktop-performance-baseline.json`, and
`desktop-performance-report.json`. The release workflow verifies the bundle
and source hashes, rejects non-finite measurements, and independently
revalidates soak and performance comparisons before signing or publication.
Candidate staging remains the default; release staging additionally requires a
clean tree and the exact frozen SHA.

Validation and build jobs now use read-only repository permissions without
persisted checkout credentials. A separate tag-only publish job is the sole
holder of `contents: write`; it downloads the build artifact and rechecks its
build-bound SHA256SUMS digest, every file hash, and exact-SHA publication
manifest before it can create a draft release.

See the [1.0.13 validation policy](validation-policy-1.0.13.md).
