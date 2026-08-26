# EZTerminal 1.0.40

Release identity: remote protocol v8, Android versionCode 61.

## Project Map authoring and review

Project Explorer now opens a native interactive map of the repository. Five
typed views cover architecture, workflow, sequence, data flow, and lifecycle.
The reader provides chapters, search, main-path emphasis, upstream/downstream
exploration, evidence navigation, Fit, pan, zoom, and a minimap without loading
repository HTML, CSS, scripts, or remote content.

An empty collection exposes a guided **Create Project Map** action. The user
chooses the first map type and a configured Codex or Claude launcher, edits the
generated brief, and explicitly opens a fresh Agent session in the owning
workspace. Existing maps expose the same dedicated-session flow for selective
updates. The app records the authoring job only after the new session's exact
activity is observed, then submits the brief into that visible terminal. It
tracks queued, analysis, authoring, Draft, Production, review, completion,
failure, and cooperative-cancellation phases. Only the Agent writes
authoritative files under `.ezterminal/project-map`.

The dedicated tab exposes startup, prompt processing, tool use, approvals, and
errors where they actually happen instead of hiding the request behind an
already-busy Agent. As soon as the tracked job is stored, a persistent status
strip replaces the ambiguous `Sending…` wait. It separates request storage,
dedicated-session startup, and Agent-reported work, and keeps the target, last
update, short job ID, and cooperative Cancel available on the empty, creation,
and reader surfaces. It never fabricates progress the Agent has not reported.

## Verification, approval, and export

Project Map schema v2 stores semantic layout intent and evidence, while the
native engine owns deterministic coordinates, routes, label placement, and the
canonical scene. Draft validation supports authoring iteration. Production
validation requires current authoritative inputs, exact evidence, deterministic
layout, resolved provenance, zero diagnostics, and all ten named checks.

An approved map remains the default while a changed candidate is reviewed with
semantic and evidence diffs. Approval revalidates and records the exact
Production fingerprint locally. Export is enabled only for that fingerprint and
creates standalone SVG, 1600x900 PNG, and a hash-bearing verification receipt in
a new `<map-id>-<short-fingerprint>` directory. Export never writes into the
authoritative Project Map directory and never overwrites an earlier result.

## Terminal clipboard reliability

Terminal copy once again works after a pane is split or detached. Structured
output, the composer, plain PTY output, and xterm output now capture both the
selected text and its owning document before a context menu moves focus.
`Ctrl+C`, `Ctrl+Shift+C`, `Ctrl+Insert`, and right-click **Copy** then use the
same result boundary, so one user action produces one OS clipboard write and
one success or failure notification in the originating window.

Desktop production copy no longer depends on the renderer Clipboard API. A
narrow context-isolated preload capability sends non-empty text to Electron
main, which owns the OS clipboard write. The user-copy path remains distinct
from policy-controlled OSC 52 writes, never includes selected text in logs or
feedback, and preserves child-process interrupt behavior when nothing is
selected. Unit, split-pane, auxiliary-window, failure-path, and freshly
packaged-EXE regressions cover the complete boundary.

## Compatibility and artifacts

Schema v1 Project Map files are intentionally unsupported; an Agent must rewrite
them to schema v2. Existing authored prose keeps its declared locale and is not
automatically translated. Remote protocol v8, Electron-to-Rust native desktop
protocol v2, persisted layout schema version 1, terminal session identity, and
project document identity are unchanged.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.40-vc61.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath Foundation
application remains pending. The Android APK must use the existing long-term
EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. Local development
validation passed lint, typecheck, documentation, 2,431 desktop unit checks,
37 OS boundary checks and policy guards, 465 mobile unit checks plus Android
release lint/unit, 54 Rust unit checks, 122 Storybook interaction checks, 71
visual/accessibility contracts, all 127 ordinary Electron E2E scenarios, and
5 packaged Electron smoke scenarios. The Project Map-specific profile
separately checks its warm approved/cache and Production-validation budgets.

This release does not run or claim the separately authorized release
performance benchmark, the opt-in two-hour desktop lifecycle soak, or the
30-minute mobile soak. The exact tagged SHA must still pass the release
workflow's packaging, signing, SBOM, manifest, checksum, Rust, and mobile gates
before a draft can be created.

See the [1.0.40 validation policy](validation-policy-1.0.40.md).
