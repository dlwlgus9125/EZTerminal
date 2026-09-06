# EZTerminal 1.0.47

Release identity: remote protocol v12, Android versionCode 68.

> Publication status: this is a draft release candidate. Public distribution
> requires a separate approval.

## Stable Codex releases use a compatibility floor

Codex compatibility is no longer a per-release allowlist. EZTerminal accepts a
valid stable Codex semantic version at or above the observed `0.152.1`
app-server baseline, including newer patch, minor, and major releases. A
compatible in-place Codex update therefore does not require another approval
solely because its version number changed.

The range remains fail closed. Immediately before each app-server process
launch, EZTerminal resolves the reviewed executable path again and runs a
bounded `codex --version` preflight. A prerelease, a version below `0.152.1`,
malformed or unlabeled version output, a failed version command, executable
path or identity drift, an incompatible reviewed launch descriptor, or
app-server contract drift blocks the launch with recovery guidance. The open
stable range does not bypass provider identity, schema, permission, or
lifecycle validation. Incoming app-server responses must also use one exact
request ID and exactly one valid result or error branch. EZTerminal validates
the required initialize identity fields before it accepts the connection,
while continuing to allow the app-server's documented omitted JSON-RPC header
and unknown future result fields. A valid late response for a request that this
client locally cancelled or timed out is recognized once without restarting
the shared app-server; a never-issued or cross-process response ID still
terminates the incompatible connection.

## Android can create a Session where the work is happening

The Android Agents surface now exposes **New session** globally and as a
44-by-44-pixel accessible `+` action beside Back while viewing an active
Workspace. The contextual action carries the exact daemon Workspace identity;
it is absent from archived history and unavailable/error states.

One mobile draft lets the user choose either an Agent or a Terminal and then
selects the active Project and Workspace where it will run. A contextual draft
locks that location to the Workspace from which it was opened. Terminal opens
at the freshly verified Workspace root. Agent provider enablement,
authentication guidance, executable review, and adapter trust remain
desktop-only settings; Android uses the host's current provider readiness and
shows actionable setup guidance when no provider is ready.

## First Send is the Agent creation boundary

Opening or editing an Agent draft does not create a daemon Session or start a
provider process. The first non-empty Send issues one `agent.create` command
that contains the durable Session identity, selected provider, model,
permission preset, Workspace, title, and initial prompt.

Before each command attempt, the client obtains a fresh daemon snapshot and
revalidates that the provider is enabled and ready and that both the Project
and Workspace are still active. Revision conflicts are retried at most three
times. The logical Session identity remains stable across those attempts while
each definitively rejected command receives a fresh idempotency identity.

When command delivery cannot be confirmed, the exact command, Session ID,
title, and draft are retained. A later Send first checks whether that Session
already exists, then safely replays the same idempotent command; only a
definitive revision conflict can create a new command for the same logical
Session. This prevents a connection interruption from silently producing a
duplicate Agent.

On Android, the exact command is written to Keystore-backed secure storage and
read back successfully before any WebSocket send. Each record and secure key
is bound to a domain-separated SHA-256 fingerprint of the authenticated
Desktop bearer; the raw bearer is never stored in the recovery record, and a
pending command from one Desktop cannot be replayed to another. The pending
envelope survives an app-process restart and reopens as a locked draft only
for the matching authority. The bounded record covers the draft UI's complete
65,536-character input range. If secure storage is loading or unavailable,
Agent creation fails closed while Terminal creation remains available, and an
inline Retry rechecks transient failures. A permanently invalid current-host
record can be discarded only through an explicit warning dialog that explains
the remaining duplicate risk; the per-key removal does not decrypt first, so an
unreadable ciphertext cannot permanently block new Agent creation. There is no plaintext or `localStorage`
fallback. If a valid pending record finishes loading while its New Session page
is already open, the same mounted draft hydrates and locks every exact field so
the user can immediately reconcile it without navigating away.
Desktop uses an acknowledged, main-process memory-only renderer checkpoint
before delivery. An unconfirmed create remains recoverable for the lifetime of
that main process instead of expiring with an ordinary renderer checkpoint,
and is still consumed at most once or removed by an explicit clear. The first
prompt stays out of the durable Dockview layout. EZTerminal blocks any pane,
quit-on-close window, auxiliary window, or preset replacement that would lose
the recovery path; an explicit application Quit keeps Cancel as the default
and warns that discarding the envelope can produce a duplicate after restart.
The bounded escrow never truncates live entries: once its 64 pending-create
capacity is reached, another create fails before persistence or transport.

## Compatibility and artifacts

Remote protocol v12 remains required for the revisioned daemon snapshot,
command, provider, and Agent-session contracts used by Android. Desktop and
Android must use the exact same protocol version. Electron-to-Rust native
desktop protocol v2, persisted layout schema version 1, Project Map schema v2,
and existing terminal and project identities are unchanged.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.47-vc68.apk`

The Windows installer candidate is Authenticode `NotSigned` while the SignPath
Foundation application remains pending. The Android APK must use the existing
long-term EZTerminal release certificate.

## Release validation profile

This candidate uses the `functional-hotfix` validation profile. The exact
candidate SHA must pass the release workflow's version and documentation
contracts, focused Codex compatibility and Android Session-creation coverage,
desktop and mobile typechecks and tests, Rust and Android gates, ordinary
zero-retry Electron E2E, packaged smoke, signing-state, SBOM, manifest, and
checksum verification before a draft GitHub Release is created.

No release-performance measurement, desktop lifecycle soak, or mobile soak is
run or claimed for this candidate.

See the [1.0.47 validation policy](validation-policy-1.0.47.md).
