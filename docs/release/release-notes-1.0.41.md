# EZTerminal 1.0.41

Release identity: remote protocol v9, Android versionCode 62.

## Reliable OpenClaw lifecycle

OpenClaw Start, Stop, and Restart now record a monotonic desired-state intent
before returning an immediate receipt. Matching active requests coalesce,
conflicting requests advance the generation so the latest user action wins,
and the desired state remains durable after the EZTerminal window closes.

On Windows, an EZTerminal-owned current-user Scheduled Task starts at login and
reconciles that desired state independently of the Electron process. It recovers
a gateway stopped by another process, stops a gateway started while the desired
state is stopped, and rechecks startup health every 15 seconds plus authenticated
RPC health every five minutes. The legacy exact-name OpenClaw watchdog is
replaced only when its executable and script identity match the known legacy
installation; an unknown collision blocks instead of being overwritten.

A lifecycle command is successful only after `/startupz` and an authenticated
status RPC remain healthy for five seconds. Provider or channel warnings do not
turn a healthy gateway into a failure. Restart gives active work up to 60
seconds to drain before a bounded force path.

Recoverable failures receive up to three attempts. Each repair attempt diagnoses
the failure, creates a SHA-256-verified backup with a restricted ACL, then uses
only supported non-destructive doctor and gateway-registration commands.
Automatic recovery never deletes or resets user data, weakens authentication,
creates tokens, or installs or updates packages. Missing or incompatible CLI,
backup failure, denied permissions, an unrelated port owner, or an unknown task
collision produces a visible blocked issue with remediation and a diagnostic ID
until the next explicit Start request.

Desktop drawer, desktop chat, and Android now consume the same lifecycle receipt
and control snapshot. Recovery phase, attempt, desired state, supervisor state,
and critical guidance are announced as text rather than inferred from a spinner.
Only a duplicate active action is disabled; a conflicting action remains
available and creates the newest generation.

## Personas, Teams, and plan approval

Desktop Settings can create reusable Codex and Claude Personas from Planner,
Implementer, Reviewer, Tester, or Custom presets. Provider-specific permissions
and launch options stay allow-listed, while model, effort, icon, role, and
instructions remain optional advanced settings. A Team orders two to eight
Personas, names exactly one Planner, and can store a reusable desired outcome
with observable completion criteria. An empty catalog can create a safe Planner
and Implementer starter Team in one atomic write.

A Team run separates the Project's read-only long-term purpose from the desired
outcome and completion criteria for this run. Main freezes the exact target
commit, Project validation settings, Team, and Persona snapshots. Only the
Planner starts first in a managed worktree. Its authenticated session submits a
bounded structured plan tied to the current run revision, then waits for human
review.

Approval returns the Planner's own assignment and starts each other approved
member in a separate managed worktree from the same frozen commit. Excluded
members never start. Partial launch failures remain visible with their exact
slot and worktree identity and can be retried without pretending the Team is
fully active. Completion and cancellation end Team tracking without forcefully
closing Agent terminals or deleting worktrees.

Catalog and run stores persist only bounded configuration, frozen plan and slot
identity, and lifecycle state. They do not store transcripts, terminal output,
tool calls, tokens, capabilities, provider credentials, or validation output.
Team controls remain desktop-only and are not advertised to Android.

## Compatibility and artifacts

Remote protocol v9 requires an exact desktop and Android match and rejects v8
peers. Electron-to-Rust native desktop protocol v2, persisted layout schema
version 1, Project Map schema v2, terminal session identity, and project document
identity are unchanged.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.41-vc62.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath Foundation
application remains pending. The Android APK must use the existing long-term
EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. Local development
validation passed documentation and Project Map checks, lint, typecheck, 2,464
desktop unit checks, 37 OS boundary checks and policy guards, 466 mobile unit
checks, 127 Storybook interaction checks, all 127 ordinary Electron E2E
scenarios, mobile production/WebView 74 build verification, Electron packaging,
and NSIS installer assembly. The packaged OpenClaw supervisor matched the source
SHA-256 and its PowerShell source passed the parser.

This release does not run or claim the separately authorized release
performance benchmark, the opt-in two-hour desktop lifecycle soak, or the
30-minute mobile soak. The exact tagged SHA must still pass the release
workflow's Rust, Android, desktop/mobile, packaged smoke, signing, SBOM,
manifest, and checksum gates before its draft can be published.

See the [1.0.41 validation policy](validation-policy-1.0.41.md).
