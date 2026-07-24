# Remote Desktop Control Design

> Decision complete: 2026-07-22. This document specifies the first public
> EZTerminal Android-to-Windows graphical desktop control feature. It is an
> application protocol and does not implement Microsoft RDP.

## Implementation status (2026-07-24)

The 1.0.4 candidate implements the VPN-only signaling/WebRTC path,
exclusive/resumable controller lease, unlocked-session GDI capture, OpenH264
adaptive stream, multi-monitor selection, cursor, input, explicit text
clipboard, Android control page, desktop safety UI, and the NSIS
service/firewall definitions.

The LocalSystem service is now an active authorization boundary rather than a
passive lifecycle placeholder. Its local-only named pipe verifies the transport
PID, executable path, impersonated user SID, and active Windows session before
granting the bounded lease. The service launches and supervises a nonce-bound
agent in that interactive user session, checks its capability handshake and
heartbeat, applies a bounded restart policy, and revokes on identity, liveness,
or session mismatch.

This is not yet the complete privileged media architecture described in
sections 2-8. The session agent currently probes capture/input access and proves
liveness; GDI frame capture, OpenH264 encoding, and actual `SendInput`
injection remain in the normal-user transport. Secure-desktop capture/input for
lock and UAC is therefore unavailable, and the Software SAS capability remains
hard-coded false: Ctrl+Alt+Delete is never advertised.

The supported target wording remains Windows 10 22H2/Windows 11 x64 and Android 10/API 29
or newer. Evidence for this hardening candidate is deliberately narrower: the
current Windows host and API 29/API 35 emulators. Elevated/admin service
lifecycle, physical Android hardware, secure desktop, and the target network
performance scenario have not been physically validated. See
[`docs/release/validation-policy-1.0.4.md`](../release/validation-policy-1.0.4.md).

Sections 1-8 retain the intended end-state design and verification gates. They
must not be read as an as-built claim for 1.0.4; this implementation-status
section and the release validation policy take precedence for current release
claims.

## 1. Product contract

- Windows 10 22H2 and Windows 11 x64 host; Android 10/API 29 or newer client.
- The Electron app must be running and the existing remote bridge must be
  enabled. Sleep, shutdown, logoff, reboot, and Wake-on-LAN are outside v1.
- Existing pairing grants graphical control automatically, but only when the
  authenticated connection arrived through a trusted VPN interface.
- One Android installation controls the desktop at a time. Local display,
  keyboard, and mouse remain active and visible.
- Selected-monitor video, Trackpad and Direct input, zoom/rotation, Korean IME,
  physical keyboard, special keys, and explicit text clipboard are in the
  current 1.0.4 scope. Audio, files, automatic clipboard sync, privacy mode,
  biometrics, lock/UAC secure-desktop control, and Ctrl+Alt+Delete are not.
- Secure-desktop and Software SAS behavior later in this document describe the
  target architecture only. The current runtime reports these capabilities
  unavailable on every Windows edition.

## 2. Process and privilege architecture

One Rust binary, `ezterminal-remote-host.exe`, has three explicit modes:

```text
authenticated WS                 local stdio                 UDP 7422 / WebRTC
Android <----------------> Electron main <--------------> transport (user)
                                  |                              |
                                  | lease/status                 | random, SID-bound pipes
                                  v                              v
                         RemoteService (SYSTEM) ---------- session-agent (SYSTEM,
                         no network listener)               interactive session)
                                                               |
                                                 DXGI / D3D11 / Media Foundation
                                                 SendInput / text clipboard
```

`RemoteService` is an automatic delayed-start `SERVICE_WIN32_OWN_PROCESS` under
LocalSystem. It is passive until a verified installed Electron/transport chain
requests a lease. It owns the global one-controller lease, active-session
selection, agent creation, watchdog, and `SendSAS`; it never parses SDP, RTP, or
remote network packets and never opens a network socket.

The service duplicates its LocalSystem token, assigns the Electron user's
interactive session ID, and creates `--session-agent` on `winsta0\\default`.
The agent uses a dedicated no-window capture/input thread and follows the
current input desktop. `EVENT_SYSTEM_DESKTOPSWITCH`, `WM_DISPLAYCHANGE`, and
DXGI access-lost/session-disconnected results tear down and recreate capture.
Logoff ends the lease; v1 does not provide pre-logon access after the Electron
session exits.

Transport is a normal-user child of the installed Electron executable. The
service verifies pipe client PID, canonical image path beneath protected Program
Files, expected binary hash, and parent image before granting a lease. A random
128-bit pipe name plus 256-bit session capability binds transport and agent.
The pipe DACL contains only SYSTEM, Administrators, and the requesting user SID.
Control frames are 64 KiB maximum, clipboard total is 256 KiB, and one encoded
video sample is 4 MiB maximum. Unknown versions, kinds, lengths, sequence IDs,
or capabilities fail closed.

Main/transport EOF, a failed 5-second watchdog, explicit Disconnect, bridge
disable, token rotation, or application quit releases injected keys/buttons,
closes pipes, kills the session agent, and releases the lease.

## 3. Capture, encode, and input

The agent enumerates active outputs with stable adapter/output identifiers,
name, bounds, rotation, primary flag, and source dimensions. Only the selected
monitor is streamed. Removal falls back to the primary output and emits a
display-list update.

Desktop Duplication produces BGRA D3D11 textures plus dirty/move rectangles and
cursor metadata. A D3D11 video processor converts the selected output to NV12;
HDR input is tone-mapped to SDR BT.709. Media Foundation chooses a certified
hardware H.264 encoder when present and the inbox encoder otherwise. The stream
uses Baseline profile, no B-frame reordering, low-latency mode, packetization
mode 1, and the encoder-selected level. Annex-B NAL units are RTP packetized by
the Rust WebRTC transport. SPS/PPS and a forced IDR are sent at start, monitor
change, quality change, reconnect, and RTCP PLI.

The stable target ladder is:

| Tier | Size/fps | Mean bitrate |
| --- | --- | --- |
| High | up to 1920x1080 at 30fps | 5.5 Mbps |
| Medium | up to 1280x720 at 30fps | 3 Mbps |
| Low | up to 960x540 at 24fps | 1.5 Mbps |
| Survival | up to 640x360 at 15fps | 0.8 Mbps |

RTCP RTT/loss, encoder queue, and send backlog are sampled every two seconds.
Sustained loss/backlog downgrades immediately; upgrade requires ten stable
seconds. An unchanged desktop can omit duplicate video frames while cursor
position continues on its data channel.

Input messages contain a session ID and monotonic sequence. Pointer absolute
coordinates are normalized against the selected output after rotation;
Trackpad relative deltas use Windows acceleration-independent normalization.
Buttons, wheel, scan-code keys, and Unicode composition are injected with
`SendInput` on the current input desktop. Every stop path synthesizes key/button
up for the agent-maintained pressed set. Cursor shape is reliable control data;
cursor position is unordered data and is rendered above video on Android.

Clipboard commands exist only on the reliable channel and only for the active
controller. Mobile-to-PC reads Android text after the user taps Send and writes
`CF_UNICODETEXT`; PC-to-mobile reads `CF_UNICODETEXT` after the user taps Copy.
The client writes Android clipboard only after a successful bounded response.
Secure-desktop clipboard unavailability is an explicit result, never a retry.

Ctrl+Alt+Del is a rate-limited control request routed to the service. The
service impersonates the target session token and calls `SendSAS`; the agent
never calls it. Runtime capability is false on Home, when install consent was
not given, or when effective policy excludes services.

## 4. Network and session protocol

The existing JSON WebSocket authenticates the pairing token and carries only
lifecycle and trickle-ICE signaling. Protocol v2 adds installation identity;
v1 remains accepted for existing terminal features but cannot request desktop
control. A new client retries v1 when an old server reports version 1.

```ts
type RemoteCapability = ExistingCapability | 'desktop-control-v1';

interface RemoteClientIdentity {
  clientId: string;       // install-scoped UUID, not a hardware identifier
  clientName: string;     // bounded, user-visible Android model/name
  platform: 'android';
  clientVersion: string;
}

type DesktopControlState =
  | 'unavailable' | 'idle' | 'starting' | 'active' | 'reconnecting'
  | 'busy' | 'stopping' | 'error';

type DesktopSignalingMessage =
  | DesktopControlStart
  | DesktopControlStartResult
  | DesktopSignal
  | DesktopControlStop
  | DesktopControlStatus
  | DesktopControlEnded;
```

`desktop-control-start-result` contains the lease/session ID, displays,
capabilities, selected display, and UDP endpoint. SDP is capped at 256 KiB and
one ICE candidate at 8 KiB. All server messages are parsed through the shared
discriminated union; no ad-hoc socket listener may bypass it.

WebRTC uses one receive-only H.264 video transceiver and two negotiated data
channels:

- `ez-control-v1`: reliable and ordered JSON for key/button/wheel, IME,
  display, cursor shape, clipboard chunks, Ctrl+Alt+Del, quality, and state.
- `ez-pointer-v1`: unordered JSON with `maxRetransmits: 0` for pointer movement
  and cursor position only. Press/release never uses this channel.

There are no ICE servers. Transport binds one UDP socket on port 7422 to the
same local address that accepted the authenticated WebSocket. That address must
belong to an allowed adapter GUID: known Tailscale/WireGuard/Wintun adapters are
auto-eligible and other VPN adapters require an explicit desktop selection.
The ICE peer address must equal the WebSocket peer address. The installer adds
a program-and-port scoped firewall rule, but EZTerminal never creates router
forwarding or a public/cloud relay. Underlying VPN relay behavior is outside the
application protocol.

The first authenticated v2 client obtains the lease. Other client IDs receive
`busy` with the bounded controller display name and cannot take over. On
unexpected WS/ICE loss, input stops immediately and the same `clientId` can
resume for 15 seconds; a different ID remains busy. Android backgrounding sends
an explicit stop. A local desktop Disconnect always wins and completes without
waiting for mobile acknowledgement.

## 5. Desktop and Android integration

Electron main owns `RemoteDesktopController`, a serialized state machine similar
to `RemoteRuntimeController`. It validates authenticated connection/network
context, starts transport, relays signaling over bounded stdio JSON, publishes
renderer state through narrow preload IPC, and owns tray/banner lifecycle.

The mobile secure credential schema becomes v2 with `clientId` and
`clientName`. Migration preserves URL/token and generates one UUID atomically;
no Android hardware ID is collected. Capacitor Device supplies a display model
and Capacitor Clipboard owns explicit clipboard operations.

The Android page and desktop surfaces follow section 16 of
`docs/ux/frontend-design.md`. Mobile terminal/controller instances stay mounted
and inert below the opaque page. All connection/business logic is adapter-owned
and Storybook receives deterministic fake adapters rather than forked product
logic.

## 6. Installation and policy

Windows packaging keeps Electron Forge/Vite/ASAR packaging, then passes the
prepackaged x64 directory to electron-builder NSIS. The assisted installer is
per-machine, writes Program Files, and keeps the artifact name
`EZTerminal-Setup.exe`. It replaces Squirrel only on Windows; other Forge makers
remain unchanged.

Before replacement, the installer detects and closes the current-user Squirrel
installation, runs its uninstaller, and preserves Electron `userData`. Update
stops service, replaces binaries, reapplies service/firewall configuration, and
starts service. Uninstall ends control, stops/deletes service, removes the
firewall rule, restores installer-owned policy, and preserves user data.

On Pro/Enterprise/Education, an explicitly labelled and default-selected
installer component permits services to generate Software SAS. Existing policy
is recorded under an administrator-only EZTerminal installer key. Existing
Ease-of-Access permission is preserved when composing the new value. Uninstall
restores the previous value only if the effective local value still equals what
EZTerminal wrote. Home never writes the policy. Domain/MDM policy wins, and the
runtime reports Ctrl+Alt+Del unavailable instead of claiming success.

The release remains unsigned by product decision; SmartScreen and unknown
publisher UAC warnings are documented. The existing environment-gated signing
path remains usable for app and installer when a certificate is later supplied.

## 7. Security and observability

- The pairing token now grants visible desktop, input, secure-desktop input,
  and explicit clipboard access in addition to current command/filesystem
  access. Pairing and Security documentation state this without euphemism.
- The LocalSystem service has no network listener, accepts no file paths or
  commands from the client protocol, and is not supported on Windows Server or
  domain controllers.
- DTLS-SRTP protects video/input inside the already encrypted VPN. Token, SDP,
  ICE address, input, clipboard, frames, key material, and pipe capabilities are
  never logged.
- Local structured logs contain only state transitions, redacted session ID,
  reason codes, encoder tier, fps, RTT, loss, and process exit codes. There is
  no cloud telemetry.
- Protected-content black frames are Windows policy, not an error. Capture,
  encoder, service, UDP, network trust, and edition/policy failures are distinct
  stable reason codes.

## 8. Verification gates

1. Rust unit/property/fuzz tests cover frame parsing, ACL/PID/path checks,
   state/lease logic, coordinates/rotation, pressed-input cleanup, adaptation,
   and every size cap.
2. Windows VM integration covers normal, lock, UAC, monitor add/remove/rotate,
   local+remote input, Korean IME, clipboard, child crashes, and Home/Pro SAS.
3. Protocol tests cover v1/v2 interop, malformed signaling, exclusive lease,
   same-client 15-second resume, other-client busy, local revoke, and redaction.
4. Android API 29 stock WebView 74, API 35, and a physical foldable cover H.264
   negotiation, VPN ICE, both touch modes, keyboard/IME, rotation, Back, and
   TalkBack.
5. Storybook, Vitest, axe, Playwright visual, packaged Electron, installer,
   firewall/service/policy, and final APK lanes are release gates.
6. A synthetic Windows target changes a known pixel in response to injected
   input. Android `requestVideoFrameCallback` measures send-to-decoded-change
   without clock synchronization. At 10 Mbps/80 ms and 1920x1080, activity must
   sustain at least 24fps and p95 feedback must not exceed 250ms.

These six gates define completion of the target secure-desktop architecture;
they are not evidence that every path has passed for 1.0.4. The current release
may advertise only its unlocked-session `desktop-control-v1` behavior and must
retain the explicit limitations in the implementation-status section. A failed
API 29 H.264/WebRTC or release-performance gate remains a blocker for that
limited claim and does not authorize silent support-matrix reduction.
